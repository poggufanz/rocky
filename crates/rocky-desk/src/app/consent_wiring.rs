//! Request dispatch and first-use consent screen wiring for the desk.

use gpui::Context;

use super::{DeskView, now_ms};
use crate::autostart;
use crate::i18n::{Msg, SetupMsg, tr};
use crate::requests::{Outcome as RequestOutcome, RequestKind, client_msg};
use crate::settings_view::{View, set_autostart_asked};

impl DeskView {
    /// Start a request and send it. Nothing is sent while disconnected or
    /// while an equal request is already in flight.
    pub(super) fn start_request(&mut self, kind: RequestKind) -> bool {
        if self.ctl.outbox.is_none() {
            return false;
        }
        let id = self.next_id();
        if !self.requests.start(kind.clone(), id, now_ms()) {
            return false;
        }
        let sent = self
            .ctl
            .outbox
            .as_ref()
            .is_some_and(|outbox| outbox.send(client_msg(&kind, id)).is_ok());
        if !sent {
            // Nothing reached the daemon, so no reply will come: do not wait for the timeout.
            self.requests.cancel(id);
        }
        sent
    }

    /// Route one request outcome to the screen that owns its kind.
    pub(super) fn on_outcome(&mut self, kind: RequestKind, outcome: RequestOutcome) {
        let expired = tr(self.ctl.ui_lang, &Msg::Setup(SetupMsg::RequestTimedOut));
        if matches!(
            kind,
            RequestKind::TranslateInstall(_) | RequestKind::TranslateRemove
        ) {
            self.translate.on_result(&outcome, &expired);
            return;
        }
        self.route_setup(kind.clone(), outcome.clone(), &expired);
        let step = self.consent.route(kind, outcome, &expired);
        if step.send_plan {
            self.request_plan();
        }
        if step.close && self.ctl.view == View::Consent {
            self.ctl.view = View::Agents;
        }
        if let Some(error) = step.log {
            self.log.once("consent-later", &error);
        }
    }

    /// Ask for the plan. When it cannot be sent the screen must not keep
    /// waiting for an answer that will never come.
    pub(super) fn request_plan(&mut self) {
        if !self.start_request(RequestKind::Plan) {
            let pending = self.requests.pending(&RequestKind::Plan);
            self.consent.plan_not_sent(pending);
        }
    }

    /// Show the consent screen with a fresh plan.
    pub(super) fn open_consent(&mut self, cx: &mut Context<Self>) {
        self.consent.open();
        self.ctl.view = View::Consent;
        self.request_plan();
        cx.notify();
    }

    /// Agree: register sign-in start when checked, mark the question asked,
    /// then ask Node to approve. A failed sign-in write never blocks it.
    pub(super) fn agree_consent(&mut self, cx: &mut Context<Self>) {
        if !self.consent.can_agree() {
            return;
        }
        if self.ctl.outbox.is_none() {
            self.consent.approve_not_sent();
            cx.notify();
            return;
        }
        let error = self
            .consent
            .begin_agree(&mut || std::env::current_exe().and_then(|exe| autostart::enable(&exe)));
        if let Some(e) = error {
            self.log.once("autostart", &e);
        }
        let id = self.next_id();
        self.send_set(id, set_autostart_asked(id));
        if !self.start_request(RequestKind::Approve) {
            self.consent.approve_not_sent();
        }
        cx.notify();
    }

    /// Later: write nothing but the consent record, and close at once.
    pub(super) fn later_consent(&mut self, cx: &mut Context<Self>) {
        if !self.consent.can_later() {
            return;
        }
        self.consent.later();
        let id = self.next_id();
        self.send_set(id, set_autostart_asked(id));
        self.start_request(RequestKind::Later);
        self.ctl.view = View::Agents;
        cx.notify();
    }
}
