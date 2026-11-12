//! Once-only setup notices: one per repo waiting for a capture decision and
//! one per harness Rocky was installed into after the first approval. The
//! desk records what it already announced in `desk/notified.json`, so a
//! restart does not repeat a notice.

use std::collections::BTreeSet;
use std::io;
use std::path::Path;

use rocky_proto::pipe::{ConsentState, PendingRepo, ServerMsg, SetupHealth, TargetState};

use crate::i18n::{Msg, SetupMsg};
use crate::notify::{Notice, NoticeKind};

const FILE_VERSION: u64 = 1;
const NOTICE_TITLE: &str = "Rocky";

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct NotifiedStore {
    repos: BTreeSet<String>,
    harnesses: BTreeSet<String>,
    seeded: bool,
    dirty: bool,
}

fn notice(kind: NoticeKind, key: String, msg: SetupMsg) -> Notice {
    Notice {
        kind,
        session_id: key,
        repo: NOTICE_TITLE.to_string(),
        agent: Msg::Setup(msg),
        summary: None,
    }
}

impl NotifiedStore {
    /// Read the store. The flag is `true` when the file exists but cannot be
    /// used; the store is then empty. A missing file is a normal first run.
    pub fn load(path: &Path) -> (NotifiedStore, bool) {
        let text = match std::fs::read_to_string(path) {
            Ok(t) => t,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return (Self::default(), false),
            Err(_) => return (Self::default(), true),
        };
        match parse(&text) {
            Some(store) => (store, false),
            None => (Self::default(), true),
        }
    }

    /// Write to a temp file beside the target, then rename over it.
    pub fn save(&self, path: &Path) -> io::Result<()> {
        if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
            std::fs::create_dir_all(dir)?;
        }
        let body = serde_json::json!({
            "v": FILE_VERSION,
            "repos": self.repos,
            "harnesses": self.harnesses,
            "seeded": self.seeded,
        });
        let mut tmp = path.as_os_str().to_owned();
        tmp.push(".tmp");
        let tmp = std::path::PathBuf::from(tmp);
        std::fs::write(&tmp, body.to_string())?;
        std::fs::rename(&tmp, path).inspect_err(|_| {
            let _ = std::fs::remove_file(&tmp);
        })
    }

    /// True once after any change; the caller then saves.
    pub fn take_dirty(&mut self) -> bool {
        std::mem::take(&mut self.dirty)
    }

    /// One notice per repo key not seen before; every key is recorded.
    pub fn repo_notices(&mut self, pending: &[PendingRepo]) -> Vec<Notice> {
        let mut out = Vec::new();
        for r in pending {
            if self.repos.insert(r.key.clone()) {
                self.dirty = true;
                out.push(notice(
                    NoticeKind::RepoConsent,
                    format!("repo:{}", r.key),
                    SetupMsg::RepoConsent {
                        name: r.name.clone(),
                    },
                ));
            }
        }
        out
    }

    /// Harness notices once consent is approved. The first approved call
    /// records every harness that already has an `ok` target and stays
    /// silent; later calls announce each newly `ok` harness once.
    pub fn harness_notices(&mut self, setup: &SetupHealth) -> Vec<Notice> {
        if setup.consent_state != ConsentState::Approved {
            return Vec::new();
        }
        let installed: BTreeSet<&str> = setup
            .targets
            .iter()
            .filter(|t| t.state == TargetState::Ok)
            .map(|t| t.harness.as_str())
            .collect();
        let announce = self.seeded;
        if !self.seeded {
            self.seeded = true;
            self.dirty = true;
        }
        let mut out = Vec::new();
        for harness in installed {
            if self.harnesses.insert(harness.to_string()) {
                self.dirty = true;
                if announce {
                    out.push(notice(
                        NoticeKind::HarnessInstalled,
                        format!("harness:{harness}"),
                        SetupMsg::HarnessInstalled {
                            harness: harness.to_string(),
                        },
                    ));
                }
            }
        }
        out
    }

    /// Notices for one pipe message.
    pub fn on_message(&mut self, msg: &ServerMsg) -> Vec<Notice> {
        match msg {
            ServerMsg::Snapshot {
                health,
                repo_pending,
                ..
            } => {
                let mut out = self.harness_notices(&health.setup);
                out.extend(self.repo_notices(repo_pending));
                out
            }
            ServerMsg::Health { health } => self.harness_notices(&health.setup),
            ServerMsg::RepoPending { repos } => self.repo_notices(repos),
            _ => Vec::new(),
        }
    }
}

fn parse(text: &str) -> Option<NotifiedStore> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    if v.get("v")?.as_u64()? != FILE_VERSION {
        return None;
    }
    let set = |key: &str| -> Option<BTreeSet<String>> {
        v.get(key)?
            .as_array()?
            .iter()
            .map(|x| x.as_str().map(str::to_string))
            .collect()
    };
    Some(NotifiedStore {
        repos: set("repos")?,
        harnesses: set("harnesses")?,
        seeded: v.get("seeded")?.as_bool()?,
        dirty: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rocky_proto::pipe::TargetHealth;
    use tempfile::TempDir;

    fn repo(key: &str, name: &str) -> PendingRepo {
        PendingRepo {
            key: key.into(),
            main: key.into(),
            name: name.into(),
        }
    }

    fn target(harness: &str, state: TargetState) -> TargetHealth {
        TargetHealth {
            harness: harness.into(),
            kind: "mcp".into(),
            path: "C:/x".into(),
            state,
            last_repair_ms: None,
            fights_10m: 0,
            error: None,
        }
    }

    fn setup(consent: ConsentState, targets: Vec<TargetHealth>) -> SetupHealth {
        SetupHealth {
            consent_state: consent,
            targets,
            ..SetupHealth::default()
        }
    }

    #[test]
    fn repo_notice_fires_once_per_key() {
        let mut s = NotifiedStore::default();
        let out = s.repo_notices(&[repo("a", "alpha"), repo("a", "alpha")]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].kind, NoticeKind::RepoConsent);
        assert_eq!(out[0].session_id, "repo:a");
        assert_eq!(
            out[0].agent,
            Msg::Setup(SetupMsg::RepoConsent {
                name: "alpha".into()
            })
        );
        assert!(s.repo_notices(&[repo("a", "alpha")]).is_empty());
        assert_eq!(
            s.repo_notices(&[repo("a", "alpha"), repo("b", "beta")])
                .len(),
            1
        );
    }

    #[test]
    fn first_approved_seed_is_silent() {
        let mut s = NotifiedStore::default();
        let h = setup(
            ConsentState::Approved,
            vec![
                target("claude-code", TargetState::Ok),
                target("codex", TargetState::Missing),
            ],
        );
        assert!(s.harness_notices(&h).is_empty());
        assert!(s.seeded);
        assert!(s.harnesses.contains("claude-code"));
        assert!(!s.harnesses.contains("codex"));
    }

    #[test]
    fn harness_installed_later_fires_once() {
        let mut s = NotifiedStore::default();
        s.harness_notices(&setup(
            ConsentState::Approved,
            vec![target("claude-code", TargetState::Ok)],
        ));
        let later = setup(
            ConsentState::Approved,
            vec![
                target("claude-code", TargetState::Ok),
                target("codex", TargetState::Ok),
            ],
        );
        let out = s.harness_notices(&later);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].kind, NoticeKind::HarnessInstalled);
        assert_eq!(out[0].session_id, "harness:codex");
        assert_eq!(
            out[0].agent,
            Msg::Setup(SetupMsg::HarnessInstalled {
                harness: "codex".into()
            })
        );
        assert!(s.harnesses.contains("codex"));
        assert!(s.harness_notices(&later).is_empty());
    }

    #[test]
    fn not_approved_never_notifies() {
        let mut s = NotifiedStore::default();
        for c in [
            ConsentState::None,
            ConsentState::Later,
            ConsentState::Removed,
            ConsentState::Invalid,
        ] {
            assert!(
                s.harness_notices(&setup(c, vec![target("codex", TargetState::Ok)]))
                    .is_empty()
            );
        }
        assert!(!s.seeded, "no seeding before approval");
        assert!(s.harnesses.is_empty());
    }

    #[test]
    fn store_round_trips() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("desk").join("notified.json");
        let mut s = NotifiedStore::default();
        s.repo_notices(&[repo("a", "alpha")]);
        s.harness_notices(&setup(
            ConsentState::Approved,
            vec![target("codex", TargetState::Ok)],
        ));
        s.save(&path).unwrap();
        let (back, bad) = NotifiedStore::load(&path);
        assert!(!bad);
        assert_eq!(back.repos, s.repos);
        assert_eq!(back.harnesses, s.harnesses);
        assert!(back.seeded);
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"v\":1"), "{text}");
        let (missing, bad) = NotifiedStore::load(&dir.path().join("none.json"));
        assert!(!bad);
        assert_eq!(missing, NotifiedStore::default());
    }

    #[test]
    fn corrupt_store_repeats_at_most_once_per_run() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("notified.json");
        std::fs::write(&path, "{not json").unwrap();
        let (mut s, bad) = NotifiedStore::load(&path);
        assert!(bad);
        assert_eq!(s.repo_notices(&[repo("a", "alpha")]).len(), 1);
        // The path is a directory, so the write fails; memory still holds.
        let blocked = dir.path().join("blocked");
        std::fs::create_dir(&blocked).unwrap();
        assert!(s.save(&blocked).is_err());
        assert!(s.repo_notices(&[repo("a", "alpha")]).is_empty());

        let (dir_store, bad) = NotifiedStore::load(&blocked);
        assert!(bad, "a directory is unreadable");
        assert_eq!(dir_store, NotifiedStore::default());
    }

    #[test]
    fn messages_feed_the_store() {
        let mut s = NotifiedStore::default();
        let out = s.on_message(&ServerMsg::RepoPending {
            repos: vec![repo("a", "alpha")],
        });
        assert_eq!(out.len(), 1);
        assert!(s.take_dirty());
        assert!(!s.take_dirty());
        assert!(
            s.on_message(&ServerMsg::RepoPending {
                repos: vec![repo("a", "alpha")]
            })
            .is_empty()
        );
        assert!(!s.take_dirty());
        assert!(s.on_message(&ServerMsg::Show).is_empty());
    }
}
