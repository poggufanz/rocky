//! Desktop notification setup, dispatch, and toast click handling.

use std::fmt::Display;
use std::path::Path;

use rocky_proto::pipe::ServerMsg;

use super::{DeskView, now_ms};
use crate::desklog::LogOnce;
use crate::i18n::resolve_lang;
use crate::notified::NotifiedStore;
use crate::notify::{Notice, NotifyCtx, notice_text, show_once_toast};
use crate::requests::RequestKind;

impl DeskView {
    /// Prepare the notification identity once, after the first settings with a
    /// notice toggle on. A failed icon or registration write is logged and not
    /// retried, so a broken identity cannot make every broadcast write.
    pub(super) fn register_notices(&mut self) {
        if self.notices_ready {
            return;
        }
        let Some(settings) = self.ctl.model.settings() else {
            return;
        };
        if !(settings.notify_needs_you || settings.notify_failed || settings.notify_done) {
            return;
        }
        self.prepare_notices();
    }

    fn prepare_notices(&mut self) {
        if self.notices_ready {
            return;
        }
        self.notices_ready = true;
        if let Err(e) = self.notices.prepare() {
            // Windows registers an app identity for its toasts; elsewhere the
            // failure belongs to the notification backend.
            let kind = if cfg!(windows) { "aumid" } else { "toast" };
            self.log.once(kind, &e);
        }
    }

    /// Log the notification backend's asynchronous failures.
    pub(super) fn drain_notice_errors(&mut self) {
        for e in self.notices.drain_errors() {
            self.log.once("toast", &e);
        }
    }

    /// Turn one message's notices into desktop notifications.
    pub(super) fn notify(&mut self, msg: &ServerMsg, window_active: bool) {
        let Some(settings) = self.ctl.model.settings() else {
            return;
        };
        let ctx = NotifyCtx {
            now_ms: now_ms(),
            window_active,
            settings,
        };
        let notices = self
            .ctl
            .notifier
            .on_message(msg, self.ctl.model.agents(), &ctx);
        let lang = self.ctl.ui_lang;
        for n in &notices {
            let (title, body) = notice_text(lang, n);
            let click_tx = self.click_tx.clone();
            let shown = self.notices.show(
                &n.session_id,
                &title,
                &body,
                Box::new(move || {
                    let _ = click_tx.send(());
                }),
            );
            if let Err(e) = shown {
                self.log.once("toast", &e);
            }
        }
    }

    /// Once-only repo, harness, and change-cards notices. Repo and harness
    /// notices are always recorded and toast only while the window is not
    /// active; the change-cards notice also shows when open, and a failed
    /// toast leaves it un-recorded so the next eligible message retries. A
    /// click just opens the window.
    pub(super) fn notify_once(&mut self, msg: &ServerMsg, window_active: bool) {
        // While an approval is in flight its own installs must not toast: the
        // first health after the answer seeds them instead.
        let harness_enabled = !self.requests.pending(&RequestKind::Approve);
        let to_show = prepare_once_notices(
            &mut self.notified,
            &self.notified_path,
            msg,
            harness_enabled,
            window_active,
            &mut self.log,
        );
        if to_show.is_empty() {
            return;
        }
        self.prepare_notices();
        let lang = self.ctl.model.settings().map_or(self.ctl.ui_lang, |s| {
            resolve_lang(s.lang, self.ctl.detected)
        });
        let notices = &mut self.notices;
        let click_tx = &self.click_tx;
        deliver_once_notices(
            &mut self.notified,
            &self.notified_path,
            &to_show,
            &mut self.log,
            |n| {
                let (title, body) = notice_text(lang, n);
                let click_tx = click_tx.clone();
                notices.show(
                    &n.session_id,
                    &title,
                    &body,
                    Box::new(move || {
                        let _ = click_tx.send(());
                    }),
                )
            },
        );
    }

    /// Toast clicks arrive from a WinRT thread; drain them and let the pump
    /// reveal the window outside the view lease.
    pub(super) fn on_clicks(&mut self) {
        let mut clicked = false;
        while self.clicks.try_recv().is_ok() {
            clicked = true;
        }
        if clicked {
            self.show_requested = true;
        }
    }
}

fn save_notified(notified: &mut NotifiedStore, path: &Path, log: &mut LogOnce) {
    if notified.take_dirty()
        && let Err(e) = notified.save(path)
    {
        log.once("notified", &e);
    }
}

fn prepare_once_notices(
    notified: &mut NotifiedStore,
    notified_path: &Path,
    msg: &ServerMsg,
    harness_enabled: bool,
    window_active: bool,
    log: &mut LogOnce,
) -> Vec<Notice> {
    let notices = notified.on_message_with(msg, harness_enabled);
    save_notified(notified, notified_path, log);
    notices
        .into_iter()
        .filter(|n| show_once_toast(n.kind, window_active))
        .collect()
}

fn deliver_once_notices<F, E>(
    notified: &mut NotifiedStore,
    notified_path: &Path,
    to_show: &[Notice],
    log: &mut LogOnce,
    mut show: F,
) where
    F: FnMut(&Notice) -> Result<(), E>,
    E: Display,
{
    for n in to_show {
        let shown = show(n);
        if let Err(e) = &shown {
            log.once("toast", e);
        }
        notified.on_toast_result(n.kind, shown.is_ok());
    }
    save_notified(notified, notified_path, log);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notify::NoticeKind;
    use rocky_proto::pipe::{
        ConsentState, Health, PendingRepo, SetupHealth, Status, TargetHealth, TargetState,
    };
    use rocky_proto::settings::Settings;
    use tempfile::TempDir;

    fn run_once<F>(
        notified: &mut NotifiedStore,
        path: &Path,
        msg: &ServerMsg,
        window_active: bool,
        log: &mut LogOnce,
        show: F,
    ) -> Vec<NoticeKind>
    where
        F: FnMut(&Notice) -> std::io::Result<()>,
    {
        let to_show = prepare_once_notices(notified, path, msg, true, window_active, log);
        let kinds: Vec<NoticeKind> = to_show.iter().map(|n| n.kind).collect();
        if !to_show.is_empty() {
            deliver_once_notices(notified, path, &to_show, log, show);
        }
        kinds
    }

    fn snap(cards: bool, repo_pending: Vec<PendingRepo>, setup: SetupHealth) -> ServerMsg {
        ServerMsg::Snapshot {
            agents: Vec::new(),
            aggregate: Status::Idle,
            health: Health {
                setup,
                ..Default::default()
            },
            settings: Settings {
                cards,
                ..Default::default()
            },
            repo_pending,
        }
    }

    fn settings_msg(cards: bool) -> ServerMsg {
        ServerMsg::Settings {
            settings: Settings {
                cards,
                ..Default::default()
            },
        }
    }

    fn toast_err() -> std::io::Error {
        std::io::Error::other("toast failed")
    }

    #[test]
    fn cards_notice_retries_after_toast_failure_and_suppresses_after_success() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("desk").join("notified.json");
        let mut log = LogOnce::new(dir.path().join("desk.log"));
        let mut store = NotifiedStore::default();

        // First attempt fails on Snapshot: notice must stay eligible in memory and on disk.
        let shown = run_once(
            &mut store,
            &path,
            &snap(true, Vec::new(), SetupHealth::default()),
            true,
            &mut log,
            |_| Err(toast_err()),
        );
        assert_eq!(shown, vec![NoticeKind::CardsNotice]);

        let (mut reloaded, bad) = NotifiedStore::load(&path);
        assert!(!bad);
        let retried = run_once(
            &mut reloaded,
            &path,
            &settings_msg(true),
            false,
            &mut log,
            |_| Err(toast_err()),
        );
        assert_eq!(retried, vec![NoticeKind::CardsNotice]);

        // Next Snapshot succeeds: subsequent Snapshot/Settings and reload stay suppressed.
        let (mut reloaded, bad) = NotifiedStore::load(&path);
        assert!(!bad);
        let ok = run_once(
            &mut reloaded,
            &path,
            &snap(true, Vec::new(), SetupHealth::default()),
            true,
            &mut log,
            |_| Ok(()),
        );
        assert_eq!(ok, vec![NoticeKind::CardsNotice]);
        assert!(
            run_once(
                &mut reloaded,
                &path,
                &settings_msg(true),
                false,
                &mut log,
                |_| Ok(()),
            )
            .is_empty()
        );
        let (final_store, bad) = NotifiedStore::load(&path);
        assert!(!bad);
        let mut final_store = final_store;
        assert!(
            run_once(
                &mut final_store,
                &path,
                &snap(true, Vec::new(), SetupHealth::default()),
                true,
                &mut log,
                |_| Ok(()),
            )
            .is_empty()
        );
    }

    #[test]
    fn repo_and_harness_notices_stay_suppressed_when_toast_fails() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("desk").join("notified.json");
        let mut log = LogOnce::new(dir.path().join("desk.log"));
        let mut store = NotifiedStore::default();

        let target = |harness: &str| TargetHealth {
            harness: harness.into(),
            kind: "mcp".into(),
            path: "C:/x".into(),
            state: TargetState::Ok,
            last_repair_ms: None,
            fights_10m: 0,
            error: None,
        };
        let seed_setup = SetupHealth {
            consent_state: ConsentState::Approved,
            targets: vec![target("claude-code")],
            ..SetupHealth::default()
        };
        // Seed harnesses silently while cards is off.
        assert!(
            run_once(
                &mut store,
                &path,
                &snap(false, Vec::new(), seed_setup),
                false,
                &mut log,
                |_| Ok(()),
            )
            .is_empty()
        );

        let full_setup = SetupHealth {
            consent_state: ConsentState::Approved,
            targets: vec![target("claude-code"), target("codex")],
            ..SetupHealth::default()
        };
        let pending = vec![PendingRepo {
            key: "repo-a".into(),
            main: "repo-a".into(),
            name: "alpha".into(),
        }];
        let first = run_once(
            &mut store,
            &path,
            &snap(true, pending.clone(), full_setup.clone()),
            false,
            &mut log,
            |_| Err(toast_err()),
        );
        assert_eq!(
            first,
            vec![
                NoticeKind::HarnessInstalled,
                NoticeKind::RepoConsent,
                NoticeKind::CardsNotice,
            ]
        );

        // Reload and send the same snapshot: only CardsNotice retries.
        let (mut reloaded, bad) = NotifiedStore::load(&path);
        assert!(!bad);
        let second = run_once(
            &mut reloaded,
            &path,
            &snap(true, pending, full_setup),
            false,
            &mut log,
            |_| Ok(()),
        );
        assert_eq!(second, vec![NoticeKind::CardsNotice]);
    }
}
