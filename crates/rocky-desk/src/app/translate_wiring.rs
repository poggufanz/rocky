//! Quote translation wiring: settings actions to pipe commands, and target
//! changes to card refetches. Kept on [`Controller`] so tests reach it
//! without a window.

use rocky_proto::pipe::ClientMsg;
use rocky_proto::translate::QuoteLang;

use super::{Controller, now_ms};
use crate::card_detail_model::DetailModel;
use crate::cards_model::CardsModel;
use crate::requests::{RequestKind, Requests, client_msg};
use crate::settings_view::set_translate_quotes;
use crate::translate_model::{Outgoing, TranslateAction, TranslateFlow};

impl Controller {
    pub(super) fn next_id(&mut self) -> u64 {
        self.cmd_id += 1;
        self.cmd_id
    }

    /// Send a `set` and remember its id so a failed ack can be attributed.
    pub(super) fn send_set(&mut self, id: u64, msg: ClientMsg) {
        let Some(outbox) = self.outbox.as_ref() else {
            return;
        };
        if outbox.send(msg).is_ok() {
            self.model.set_sent(id);
        }
    }

    fn send_msg(&self, msg: ClientMsg) {
        if let Some(outbox) = self.outbox.as_ref() {
            let _ = outbox.send(msg);
        }
    }

    /// Start a request and send it. Nothing is sent while disconnected or
    /// while an equal request is already in flight.
    pub(super) fn start_request(&mut self, requests: &mut Requests, kind: RequestKind) -> bool {
        if self.outbox.is_none() {
            return false;
        }
        let id = self.next_id();
        if !requests.start(kind.clone(), id, now_ms()) {
            return false;
        }
        let sent = self
            .outbox
            .as_ref()
            .is_some_and(|outbox| outbox.send(client_msg(&kind, id)).is_ok());
        if !sent {
            // Nothing reached the daemon, so no reply will come: do not wait for the timeout.
            requests.cancel(id);
        }
        sent
    }

    /// Apply a quote translation settings action and emit any outgoing commands.
    /// `not_connected` is the error shown when a request cannot be sent.
    pub(super) fn translate_act(
        &mut self,
        flow: &mut TranslateFlow,
        requests: &mut Requests,
        action: TranslateAction,
        not_connected: &str,
    ) {
        if !self.model.editable() {
            return;
        }
        let Some(enabled) = self.model.settings().map(|s| s.translate_quotes) else {
            return;
        };
        let status = self.model.translate_status().clone();
        for cmd in flow.act(action, enabled, &status, self.ui_lang) {
            let kind = match cmd {
                Outgoing::SetEnabled(on) => {
                    let id = self.next_id();
                    self.send_set(id, set_translate_quotes(id, on));
                    continue;
                }
                Outgoing::Install(pair) => RequestKind::TranslateInstall(pair),
                Outgoing::Remove => RequestKind::TranslateRemove,
            };
            if !self.start_request(requests, kind.clone()) && !requests.pending(&kind) {
                flow.on_not_sent(not_connected);
            }
        }
    }

    /// Current quote translation target language, or `None` when disabled or not ready.
    pub(super) fn translate_target(&self) -> Option<QuoteLang> {
        crate::translate_model::translate_target(
            self.model.settings(),
            self.model.translate_status(),
            self.ui_lang,
        )
    }

    /// Re-requests the card list and the open card when the target changed.
    pub(super) fn sync_translate_target(
        &mut self,
        last: &mut Option<QuoteLang>,
        cards: &mut CardsModel,
        detail: Option<&mut DetailModel>,
    ) -> bool {
        let target = self.translate_target();
        if target == *last {
            return false;
        }
        *last = target;
        let cards_id = self.next_id();
        if let Some(msg) = cards.set_target(target, cards_id) {
            self.send_msg(msg);
        }
        if let Some(detail) = detail {
            let id = self.next_id();
            if let Some(msg) = detail.retarget(id, target) {
                self.send_msg(msg);
            }
        }
        true
    }
}
