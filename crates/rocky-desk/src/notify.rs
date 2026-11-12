//! Pure notification rules: which desk notices a pipe message fires.

use std::collections::{BTreeMap, BTreeSet};

use rocky_proto::pipe::{AgentKey, AgentStatus, ServerMsg, Status, StatusOp};
use rocky_proto::settings::Settings;

use crate::i18n::{Msg, UiLang, tr};
use crate::view;

/// Events older than this are not worth a notice.
pub const STALE_MS: u64 = 60_000;

/// Title and body of one toast. The title is the repo name, which is not
/// translated; the body comes from the copy catalog, and a missing repo name
/// falls back to the catalog placeholder.
pub fn notice_text(lang: UiLang, n: &Notice) -> (String, String) {
    let agent = tr(lang, &n.agent);
    let msg = match n.kind {
        NoticeKind::NeedsYou => Msg::NoticeNeedsYou {
            agent,
            summary: n.summary.clone(),
        },
        NoticeKind::Failed => Msg::NoticeFailed { agent },
        NoticeKind::Done => Msg::NoticeDone,
        // These carry their finished copy in `agent`.
        NoticeKind::RepoConsent | NoticeKind::HarnessInstalled => n.agent.clone(),
    };
    let title = if n.repo.is_empty() {
        tr(lang, &Msg::UnknownRepo)
    } else {
        n.repo.clone()
    };
    (title, tr(lang, &msg))
}

/// Toast tag for a session. Windows caps tags at 64 characters, and one tag
/// per session makes a newer toast replace the older.
pub fn toast_tag(session_id: &str) -> String {
    session_id.chars().take(64).collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoticeKind {
    NeedsYou,
    Failed,
    Done,
    /// A repo is waiting for a capture decision; not tied to a session.
    RepoConsent,
    /// Rocky was installed into a harness after the first approval; not tied
    /// to a session.
    HarnessInstalled,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notice {
    pub kind: NoticeKind,
    /// The session, or for the setup kinds the toast key (`repo:<key>`,
    /// `harness:<id>`).
    pub session_id: String,
    pub repo: String,
    pub agent: Msg,
    pub summary: Option<String>,
}

pub struct NotifyCtx<'a> {
    pub now_ms: u64,
    pub window_active: bool,
    pub settings: &'a Settings,
}

impl NotifyCtx<'_> {
    fn allows(&self, kind: NoticeKind) -> bool {
        if self.window_active {
            return false;
        }
        match kind {
            // Gated only by the active window, never by a toggle.
            NoticeKind::RepoConsent | NoticeKind::HarnessInstalled => true,
            NoticeKind::NeedsYou => self.settings.notify_needs_you,
            NoticeKind::Failed => self.settings.notify_failed,
            NoticeKind::Done => self.settings.notify_done,
        }
    }
}

#[derive(Debug, Default)]
pub struct Notifier {
    /// Last status seen per key, from the snapshot or the latest upsert.
    prev: BTreeMap<AgentKey, Status>,
    /// Sessions whose `done` notice already fired this turn.
    done_sent: BTreeSet<String>,
}

impl Notifier {
    /// Handle one pipe message after `Model::apply`; `agents` is the updated
    /// map. Notices are only ever produced by status deltas.
    pub fn on_message(
        &mut self,
        msg: &ServerMsg,
        agents: &BTreeMap<AgentKey, AgentStatus>,
        ctx: &NotifyCtx<'_>,
    ) -> Vec<Notice> {
        match msg {
            ServerMsg::Snapshot { agents: snap, .. } => {
                // A snapshot main in Working means a new turn began while the
                // desk was away, so a done notice from the previous turn no
                // longer applies.
                for a in snap {
                    if a.key.agent_id.is_empty() && a.status == Status::Working {
                        self.done_sent.remove(&a.key.session_id);
                    }
                }
                self.prev = snap.iter().map(|a| (a.key.clone(), a.status)).collect();
                Vec::new()
            }
            ServerMsg::Status {
                op: StatusOp::Remove,
                agent,
            } => {
                self.prev.remove(&agent.key);
                Vec::new()
            }
            ServerMsg::Status {
                op: StatusOp::Upsert,
                agent,
            } => self.upsert(agent, agents, ctx),
            _ => Vec::new(),
        }
    }

    fn upsert(
        &mut self,
        agent: &AgentStatus,
        agents: &BTreeMap<AgentKey, AgentStatus>,
        ctx: &NotifyCtx<'_>,
    ) -> Vec<Notice> {
        let prev = self.prev.insert(agent.key.clone(), agent.status);
        let is_main = agent.key.agent_id.is_empty();
        let session = &agent.key.session_id;

        if is_main && agent.status == Status::Working && prev != Some(Status::Working) {
            self.done_sent.remove(session);
        }

        if prev == Some(agent.status) || ctx.now_ms.saturating_sub(agent.last_event_ms) > STALE_MS {
            return Vec::new();
        }

        let notice = |kind| Notice {
            kind,
            session_id: session.clone(),
            repo: agent.repo.name.clone(),
            agent: view::agent_label(agent),
            summary: agent.summary.clone(),
        };
        let mut out = Vec::new();
        match agent.status {
            Status::NeedsYou if ctx.allows(NoticeKind::NeedsYou) => {
                out.push(notice(NoticeKind::NeedsYou));
            }
            Status::Failed if ctx.allows(NoticeKind::Failed) => {
                out.push(notice(NoticeKind::Failed));
            }
            _ => {}
        }

        let main_done = agents.values().any(|a| {
            a.key.session_id == *session && a.key.agent_id.is_empty() && a.status == Status::Done
        });
        let finished = if is_main {
            agent.status == Status::Done
        } else {
            prev == Some(Status::Working)
                && matches!(agent.status, Status::Done | Status::Idle | Status::Ended)
                && main_done
        };
        let working_child = agents.values().any(|a| {
            a.key.session_id == *session
                && !a.key.agent_id.is_empty()
                && a.status == Status::Working
        });
        if finished
            && !working_child
            && ctx.allows(NoticeKind::Done)
            && !self.done_sent.contains(session)
        {
            self.done_sent.insert(session.clone());
            out.push(notice(NoticeKind::Done));
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::i18n::UiLang;
    use rocky_proto::pipe::{Health, RepoInfo, StatusOp};
    use rocky_proto::settings::Settings;

    const NOW: u64 = 1_000_000;

    #[test]
    fn notice_text_names_repo_agent_and_tool() {
        let n = Notice {
            kind: NoticeKind::NeedsYou,
            session_id: "s".into(),
            repo: "rocky".into(),
            agent: Msg::AgentName {
                label: "Explore aaaaaaaa".into(),
            },
            summary: Some("Bash".into()),
        };
        assert_eq!(
            notice_text(UiLang::En, &n),
            ("rocky".into(), "Explore aaaaaaaa needs you: Bash".into())
        );
        assert_eq!(toast_tag(&"x".repeat(80)).chars().count(), 64);
    }

    #[test]
    fn notice_text_covers_missing_summary_failed_and_done() {
        let base = Notice {
            kind: NoticeKind::NeedsYou,
            session_id: "s".into(),
            repo: "rocky".into(),
            agent: Msg::MainAgent,
            summary: None,
        };
        assert_eq!(
            notice_text(UiLang::En, &base),
            ("rocky".into(), "main needs you".into())
        );
        let failed = Notice {
            kind: NoticeKind::Failed,
            ..base.clone()
        };
        assert_eq!(
            notice_text(UiLang::Id, &failed),
            ("rocky".into(), "utama gagal".into())
        );
        let no_repo = Notice {
            repo: String::new(),
            ..base.clone()
        };
        assert_eq!(
            notice_text(UiLang::En, &no_repo).0,
            "unknown repo",
            "an empty repo name must not yield a blank title"
        );
        assert_eq!(notice_text(UiLang::Id, &no_repo).0, "repo tidak dikenal");
        let done = Notice {
            kind: NoticeKind::Done,
            ..base
        };
        assert_eq!(notice_text(UiLang::En, &done).1, "Finished");
        assert_eq!(notice_text(UiLang::Id, &done).1, "Selesai");
    }

    fn agent(session: &str, agent_id: &str, status: Status) -> AgentStatus {
        AgentStatus {
            key: AgentKey {
                session_id: session.into(),
                agent_id: agent_id.into(),
            },
            agent_type: (!agent_id.is_empty()).then(|| "Explore".to_string()),
            status,
            action: None,
            summary: None,
            description: None,
            failures: 0,
            last_event_ms: NOW - 1_000,
            quiet_10m: false,
            repo: RepoInfo {
                root: Some("C:/r".into()),
                name: "r".into(),
                branch: Some("main".into()),
            },
        }
    }

    fn snap(list: &[&AgentStatus]) -> ServerMsg {
        ServerMsg::Snapshot {
            agents: list.iter().map(|a| (*a).clone()).collect(),
            aggregate: Status::Idle,
            health: Health::default(),
            settings: Settings::default(),
            repo_pending: Vec::new(),
        }
    }

    fn up(a: &AgentStatus) -> ServerMsg {
        ServerMsg::Status {
            op: StatusOp::Upsert,
            agent: a.clone(),
        }
    }

    fn rm(a: &AgentStatus) -> ServerMsg {
        ServerMsg::Status {
            op: StatusOp::Remove,
            agent: a.clone(),
        }
    }

    fn table(list: &[&AgentStatus]) -> BTreeMap<AgentKey, AgentStatus> {
        list.iter().map(|a| (a.key.clone(), (*a).clone())).collect()
    }

    fn ctx<'a>(settings: &'a Settings) -> NotifyCtx<'a> {
        NotifyCtx {
            now_ms: NOW,
            window_active: false,
            settings,
        }
    }

    #[test]
    fn snapshot_never_notifies_and_seeds() {
        let mut n = Notifier::default();
        let s = Settings::default();
        let a = agent("S1", "", Status::NeedsYou);
        assert!(
            n.on_message(&snap(&[&a]), &table(&[&a]), &ctx(&s))
                .is_empty()
        );
        // The snapshot already holds NeedsYou, so an upsert with the same
        // status is not a transition.
        assert!(n.on_message(&up(&a), &table(&[&a]), &ctx(&s)).is_empty());
    }

    #[test]
    fn needs_you_on_transition_only() {
        let mut n = Notifier::default();
        let s = Settings::default();
        let mut a = agent("S1", "kid1", Status::Working);
        a.summary = Some("Bash".into());
        n.on_message(&snap(&[&a]), &table(&[&a]), &ctx(&s));
        a.status = Status::NeedsYou;
        let out = n.on_message(&up(&a), &table(&[&a]), &ctx(&s));
        assert_eq!(
            out,
            vec![Notice {
                kind: NoticeKind::NeedsYou,
                session_id: "S1".into(),
                repo: "r".into(),
                agent: Msg::AgentName {
                    label: "Explore kid1".into(),
                },
                summary: Some("Bash".into()),
            }]
        );
        assert!(n.on_message(&up(&a), &table(&[&a]), &ctx(&s)).is_empty());
    }

    #[test]
    fn failed_on_transition() {
        let mut n = Notifier::default();
        let s = Settings::default();
        let mut a = agent("S1", "", Status::Working);
        n.on_message(&snap(&[&a]), &table(&[&a]), &ctx(&s));
        a.status = Status::Failed;
        let out = n.on_message(&up(&a), &table(&[&a]), &ctx(&s));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].kind, NoticeKind::Failed);
        assert_eq!(out[0].agent, Msg::MainAgent);
        assert!(n.on_message(&up(&a), &table(&[&a]), &ctx(&s)).is_empty());
    }

    #[test]
    fn done_waits_for_children() {
        let mut n = Notifier::default();
        let s = Settings::default();
        let mut main = agent("S1", "", Status::Working);
        let mut child = agent("S1", "c1", Status::Working);
        n.on_message(&snap(&[&main, &child]), &table(&[&main, &child]), &ctx(&s));

        main.status = Status::Done;
        assert!(
            n.on_message(&up(&main), &table(&[&main, &child]), &ctx(&s))
                .is_empty()
        );

        child.status = Status::Done;
        let out = n.on_message(&up(&child), &table(&[&main, &child]), &ctx(&s));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].kind, NoticeKind::Done);
        assert_eq!(out[0].session_id, "S1");

        // The turn already notified once.
        assert!(
            n.on_message(&up(&child), &table(&[&main, &child]), &ctx(&s))
                .is_empty()
        );
    }

    #[test]
    fn child_needs_you_while_main_done_is_not_a_finish() {
        let mut n = Notifier::default();
        let s = Settings::default();
        let main = agent("S1", "", Status::Done);
        let mut child = agent("S1", "c1", Status::Working);
        n.on_message(&snap(&[&main, &child]), &table(&[&main, &child]), &ctx(&s));

        child.status = Status::NeedsYou;
        let out = n.on_message(&up(&child), &table(&[&main, &child]), &ctx(&s));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].kind, NoticeKind::NeedsYou);
    }

    #[test]
    fn child_failed_while_main_done_is_not_a_finish() {
        let mut n = Notifier::default();
        let s = Settings::default();
        let main = agent("S1", "", Status::Done);
        let mut child = agent("S1", "c1", Status::Working);
        n.on_message(&snap(&[&main, &child]), &table(&[&main, &child]), &ctx(&s));

        child.status = Status::Failed;
        let out = n.on_message(&up(&child), &table(&[&main, &child]), &ctx(&s));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].kind, NoticeKind::Failed);
    }

    #[test]
    fn child_done_while_main_working_is_silent() {
        let mut n = Notifier::default();
        let s = Settings::default();
        let mut main = agent("S1", "", Status::Working);
        let mut child = agent("S1", "c1", Status::Working);
        n.on_message(&snap(&[&main, &child]), &table(&[&main, &child]), &ctx(&s));

        child.status = Status::Done;
        assert!(
            n.on_message(&up(&child), &table(&[&main, &child]), &ctx(&s))
                .is_empty()
        );

        main.status = Status::Done;
        let out = n.on_message(&up(&main), &table(&[&main, &child]), &ctx(&s));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].kind, NoticeKind::Done);
    }

    #[test]
    fn done_once_per_turn_and_resets_on_new_turn() {
        let mut n = Notifier::default();
        let s = Settings::default();
        let mut main = agent("S1", "", Status::Working);
        n.on_message(&snap(&[&main]), &table(&[&main]), &ctx(&s));

        main.status = Status::Done;
        assert_eq!(
            n.on_message(&up(&main), &table(&[&main]), &ctx(&s)).len(),
            1
        );
        assert!(
            n.on_message(&up(&main), &table(&[&main]), &ctx(&s))
                .is_empty()
        );

        main.status = Status::Working;
        assert!(
            n.on_message(&up(&main), &table(&[&main]), &ctx(&s))
                .is_empty()
        );
        main.status = Status::Done;
        assert_eq!(
            n.on_message(&up(&main), &table(&[&main]), &ctx(&s)).len(),
            1
        );
    }

    #[test]
    fn done_sent_blocks_a_second_finish_in_the_same_turn() {
        let mut n = Notifier::default();
        let s = Settings::default();
        let mut main = agent("S1", "", Status::Working);
        n.on_message(&snap(&[&main]), &table(&[&main]), &ctx(&s));

        main.status = Status::Done;
        assert_eq!(
            n.on_message(&up(&main), &table(&[&main]), &ctx(&s)).len(),
            1
        );

        // Idle is a transition but starts no turn, so only the done-sent set
        // can silence the next Done.
        main.status = Status::Idle;
        assert!(
            n.on_message(&up(&main), &table(&[&main]), &ctx(&s))
                .is_empty()
        );
        main.status = Status::Done;
        assert!(
            n.on_message(&up(&main), &table(&[&main]), &ctx(&s))
                .is_empty()
        );
    }

    #[test]
    fn reconnect_snapshot_working_resets_done_notice() {
        let mut n = Notifier::default();
        let s = Settings::default();
        let mut main = agent("S1", "", Status::Working);
        n.on_message(&snap(&[&main]), &table(&[&main]), &ctx(&s));

        main.status = Status::Done;
        assert_eq!(
            n.on_message(&up(&main), &table(&[&main]), &ctx(&s)).len(),
            1
        );

        // A new turn started while the desk was disconnected.
        main.status = Status::Working;
        assert!(
            n.on_message(&snap(&[&main]), &table(&[&main]), &ctx(&s))
                .is_empty()
        );

        main.status = Status::Done;
        main.last_event_ms = NOW - 1_000;
        let out = n.on_message(&up(&main), &table(&[&main]), &ctx(&s));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].kind, NoticeKind::Done);
    }

    #[test]
    fn stale_events_skip() {
        let mut n = Notifier::default();
        let s = Settings::default();
        let mut a = agent("S1", "", Status::Idle);
        let mut b = agent("S2", "", Status::Idle);
        n.on_message(&snap(&[&a, &b]), &table(&[&a, &b]), &ctx(&s));

        a.status = Status::NeedsYou;
        a.last_event_ms = NOW - 60_001;
        assert!(
            n.on_message(&up(&a), &table(&[&a, &b]), &ctx(&s))
                .is_empty()
        );

        b.status = Status::NeedsYou;
        b.last_event_ms = NOW - 60_000;
        assert_eq!(n.on_message(&up(&b), &table(&[&a, &b]), &ctx(&s)).len(), 1);
    }

    #[test]
    fn quiet_while_window_active() {
        let mut n = Notifier::default();
        let s = Settings::default();
        let mut a = agent("S1", "", Status::Idle);
        let mut b = agent("S2", "", Status::Idle);
        n.on_message(&snap(&[&a, &b]), &table(&[&a, &b]), &ctx(&s));

        a.status = Status::NeedsYou;
        let quiet = NotifyCtx {
            now_ms: NOW,
            window_active: true,
            settings: &s,
        };
        assert!(n.on_message(&up(&a), &table(&[&a, &b]), &quiet).is_empty());

        b.status = Status::NeedsYou;
        assert_eq!(n.on_message(&up(&b), &table(&[&a, &b]), &ctx(&s)).len(), 1);
    }

    #[test]
    fn toggles_silence_each_kind() {
        let mut n = Notifier::default();
        let all = Settings::default();
        let mut a = agent("S1", "", Status::Idle);
        let mut b = agent("S2", "", Status::Working);
        let mut c = agent("S3", "", Status::Working);
        n.on_message(&snap(&[&a, &b, &c]), &table(&[&a, &b, &c]), &ctx(&all));

        let off_needs = Settings {
            notify_needs_you: false,
            ..Settings::default()
        };
        a.status = Status::NeedsYou;
        assert!(
            n.on_message(&up(&a), &table(&[&a, &b, &c]), &ctx(&off_needs))
                .is_empty()
        );

        let off_failed = Settings {
            notify_failed: false,
            ..Settings::default()
        };
        b.status = Status::Failed;
        assert!(
            n.on_message(&up(&b), &table(&[&a, &b, &c]), &ctx(&off_failed))
                .is_empty()
        );

        let off_done = Settings {
            notify_done: false,
            ..Settings::default()
        };
        c.status = Status::Done;
        assert!(
            n.on_message(&up(&c), &table(&[&a, &b, &c]), &ctx(&off_done))
                .is_empty()
        );
    }

    #[test]
    fn remove_forgets_previous_status() {
        let mut n = Notifier::default();
        let s = Settings::default();
        let a = agent("S1", "", Status::NeedsYou);
        n.on_message(&snap(&[&a]), &table(&[&a]), &ctx(&s));

        assert!(n.on_message(&rm(&a), &table(&[]), &ctx(&s)).is_empty());
        // Without the remove this same status would not be a transition.
        let out = n.on_message(&up(&a), &table(&[&a]), &ctx(&s));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].kind, NoticeKind::NeedsYou);
    }

    #[test]
    fn reconnect_snapshot_then_old_upserts_stay_silent() {
        let mut n = Notifier::default();
        let s = Settings::default();
        let mut a = agent("S1", "", Status::Working);
        assert!(
            n.on_message(&snap(&[&a]), &table(&[&a]), &ctx(&s))
                .is_empty()
        );

        // NeedsYou was reached while disconnected and arrives in the snapshot.
        a.status = Status::NeedsYou;
        assert!(
            n.on_message(&snap(&[&a]), &table(&[&a]), &ctx(&s))
                .is_empty()
        );

        // An event produced before the reconnect is delivered late.
        let mut old = a.clone();
        old.status = Status::Failed;
        old.last_event_ms = NOW - 60_001;
        assert!(
            n.on_message(&up(&old), &table(&[&old]), &ctx(&s))
                .is_empty()
        );

        // A fresh event after the reconnect still notifies.
        let mut b = agent("S2", "", Status::Idle);
        n.on_message(&snap(&[&old, &b]), &table(&[&old, &b]), &ctx(&s));
        b.status = Status::NeedsYou;
        assert_eq!(
            n.on_message(&up(&b), &table(&[&old, &b]), &ctx(&s)).len(),
            1
        );
    }
}
