//! Desktop notification setup, dispatch, and toast click handling.

use rocky_proto::pipe::ServerMsg;

use super::{DeskView, now_ms};
use crate::i18n::resolve_lang;
use crate::notify::{NotifyCtx, notice_text, show_once_toast};
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

    /// Once-only repo, harness, and change-cards notices. They are always
    /// recorded; repo and harness toasts show only while the window is not
    /// active, while the change-cards notice also shows when open. A click
    /// just opens the window.
    pub(super) fn notify_once(&mut self, msg: &ServerMsg, window_active: bool) {
        // While an approval is in flight its own installs must not toast: the
        // first health after the answer seeds them instead.
        let harness_enabled = !self.requests.pending(&RequestKind::Approve);
        let notices = self.notified.on_message_with(msg, harness_enabled);
        if self.notified.take_dirty()
            && let Err(e) = self.notified.save(&self.notified_path)
        {
            self.log.once("notified", &e);
        }
        let to_show: Vec<_> = notices
            .into_iter()
            .filter(|n| show_once_toast(n.kind, window_active))
            .collect();
        if to_show.is_empty() {
            return;
        }
        self.prepare_notices();
        let lang = self.ctl.model.settings().map_or(self.ctl.ui_lang, |s| {
            resolve_lang(s.lang, self.ctl.detected)
        });
        for n in &to_show {
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
