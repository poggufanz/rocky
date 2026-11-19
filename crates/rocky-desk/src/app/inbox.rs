//! Foreground inbox pump handling daemon messages and timeouts.

use std::sync::mpsc;

use gpui::Context;
use rocky_proto::pipe::ServerMsg;

use super::{DeskView, now_ms};
use crate::cards_nav;
use crate::i18n::resolve_lang;
use crate::settings_view::View;

impl DeskView {
    pub(super) fn on_inbox(&mut self, cx: &mut Context<Self>, window_active: bool) {
        self.drain_notice_errors();
        let mut changed = self.ctl.on_worker();
        let mut requests = Vec::new();
        let mut snapshot_seen = false;
        let mut outcomes = Vec::new();
        let mut open_consent = false;
        let mut health_seen = false;
        let mut pending_lang = None;
        let mut quit = false;
        if let Some(inbox) = self.ctl.inbox.take() {
            let mut alive = true;
            loop {
                match inbox.try_recv() {
                    Ok(Some(msg)) => {
                        let show = matches!(msg, ServerMsg::Show);
                        if matches!(msg, ServerMsg::Quit) {
                            // The daemon is closing on request: mark the stop
                            // before the closing connection is handled, so the
                            // disconnect that follows never respawns it.
                            self.ctl.state.on_quit();
                            quit = true;
                        }
                        let settings_msg =
                            matches!(msg, ServerMsg::Snapshot { .. } | ServerMsg::Settings { .. });
                        if let ServerMsg::Snapshot { settings, .. }
                        | ServerMsg::Settings { settings } = &msg
                        {
                            pending_lang = Some(settings.lang);
                        }
                        if let ServerMsg::Ack { id, ok, .. } = &msg
                            && self.ctl.state.on_ack(*id, *ok)
                        {
                            // Ack state changed (stop acked or id cleared).
                        }
                        let for_notify = msg.clone();
                        self.setup.on_server_msg(&for_notify);
                        if matches!(&for_notify, ServerMsg::Snapshot { .. }) {
                            snapshot_seen = true;
                        }
                        let card_lang = pending_lang
                            .map(|setting| resolve_lang(setting, self.ctl.detected))
                            .unwrap_or(self.ctl.ui_lang);
                        cards_nav::route_card_msg(
                            &for_notify,
                            &mut self.ctl.view,
                            &mut self.cards,
                            &mut self.card_detail,
                            &mut self.block_diff,
                            card_lang,
                        );
                        let legacy_requests = self.ctl.model.apply(msg);
                        for key in self.ctl.collect_timeline_requests(
                            &for_notify,
                            legacy_requests,
                            now_ms(),
                        ) {
                            if !requests.contains(&key) {
                                requests.push(key);
                            }
                        }
                        if settings_msg {
                            self.register_notices();
                        }
                        self.notify(&for_notify, window_active);
                        self.notify_once(&for_notify, window_active);
                        outcomes.extend(self.requests.on_message(&for_notify));
                        if let ServerMsg::Snapshot { health, .. } | ServerMsg::Health { health } =
                            &for_notify
                        {
                            health_seen = true;
                            let consent = health.setup.consent_state;
                            open_consent |= self.consent.on_health(consent, self.ctl.tray_start);
                        }
                        if show {
                            self.show_requested = true;
                        }
                        changed = true;
                    }
                    Ok(None) | Err(mpsc::TryRecvError::Disconnected) => {
                        // Transition exactly once: the taken inbox stays
                        // dropped so the next tick has nothing to re-handle.
                        alive = false;
                        break;
                    }
                    Err(mpsc::TryRecvError::Empty) => break,
                }
            }
            if alive {
                self.ctl.inbox = Some(inbox);
            } else {
                self.ctl.outbox = None;
                self.ctl.timeline_fetch.reset();
                let action = self.ctl.state.on_disconnect(now_ms());
                self.ctl.act(action);
                changed = true;
            }
        }
        if quit || self.removed_quit_due() {
            // Nothing left to render or relay: close the tray and end the
            // process. The daemon is already exiting on the same command.
            self.quit(cx);
            return;
        }
        outcomes.extend(self.requests.expire(now_ms()));
        if !outcomes.is_empty() {
            changed = true;
        }
        for (kind, outcome) in outcomes {
            self.on_outcome(kind, outcome);
        }
        if open_consent {
            self.open_consent(cx);
        } else if health_seen
            && self.ctl.view == View::Consent
            && self.consent.retry_plan_on_health()
        {
            // Back from an unreachable daemon: ask for the plan again.
            self.request_plan();
            changed = true;
        }
        if let Some(lang) = pending_lang {
            self.sync_lang(lang, cx);
        }
        for key in requests {
            self.ctl.request_timeline(key);
        }
        if snapshot_seen {
            for msg in self.cards_refresh_msgs() {
                self.send_card_msg(msg);
            }
        }
        if self.sync_translate_target() {
            changed = true;
        }
        if changed {
            cx.notify();
        }
    }

    /// Dispatches any active agent timeline fetches whose debounce window has elapsed.
    pub(super) fn poll_timelines(&mut self) {
        self.ctl.poll_timelines(now_ms());
    }
}
