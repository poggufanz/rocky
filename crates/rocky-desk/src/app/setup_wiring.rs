//! Wires the Settings setup sections to the desk: starts their requests,
//! routes their answers, and runs Remove Rocky through to the final screen.
//! Decisions live in `setup_settings`; drawing lives in `ui/setup_settings.rs`.

use gpui::{Context, Div};
use rocky_proto::pipe::{ClientMsg, CmdName};

use super::{DeskView, now_ms};
use crate::autostart;
use crate::i18n::{Msg, SetupMsg, tr};
use crate::requests::{Outcome as RequestOutcome, RequestKind};
use crate::settings_view::View;
use crate::setup_settings::{CloseAction, Control, SetupSettings, close_action};
use crate::ui::setup_settings::{SettingsAction, setup_sections};

/// How long the final screen waits for the daemon's quit broadcast before the
/// desk exits on its own.
pub(super) const REMOVED_QUIT_GRACE_MS: u64 = 2_000;

impl DeskView {
    /// Settings opened: read the plan and the repo list, each unless one is
    /// already on its way.
    pub(super) fn refresh_setup(&mut self) {
        self.start_request(RequestKind::Plan);
        self.start_request(RequestKind::RepoList);
    }

    fn not_connected_text(&self) -> String {
        tr(self.ctl.ui_lang, &Msg::Setup(SetupMsg::NotConnected))
    }

    /// Start one control's request. When nothing could be sent and nothing is
    /// in flight, the control shows why instead of waiting forever.
    fn start_control(&mut self, control: Control, kind: RequestKind) {
        self.setup.clear_error(&control);
        if self.start_request(kind) || control.busy(&self.requests) {
            return;
        }
        let text = self.not_connected_text();
        self.setup.show_error(control, text);
    }

    pub(super) fn handle_setup_action(&mut self, action: SettingsAction, cx: &mut Context<Self>) {
        match action {
            SettingsAction::Harness { harness, on } => {
                let kind = SetupSettings::harness_request(&harness, on);
                self.start_control(Control::Harness(harness), kind);
            }
            SettingsAction::Shell { on } => {
                let kind = if on {
                    RequestKind::ShellOff
                } else {
                    RequestKind::ShellOn
                };
                self.start_control(Control::Shell, kind);
            }
            SettingsAction::Reinstall => self.start_control(Control::Reinstall, RequestKind::Apply),
            SettingsAction::RepoAllow(root) => {
                self.start_control(Control::Repo(root.clone()), RequestKind::RepoAllow(root));
            }
            SettingsAction::RepoRevoke(root) => {
                self.start_control(Control::Repo(root.clone()), RequestKind::RepoDecline(root));
            }
            SettingsAction::PurgeAsk(root) => self.setup.ask_purge(&root),
            SettingsAction::PurgeCancel => self.setup.cancel_purge(),
            SettingsAction::PurgeConfirm(root) => {
                if self.setup.confirm_purge(&root) {
                    self.start_control(Control::Purge(root.clone()), RequestKind::RepoPurge(root));
                }
            }
            SettingsAction::RemoveAsk => self.setup.ask_remove(),
            SettingsAction::RemoveCancel => self.setup.cancel_remove(),
            SettingsAction::RemoveConfirm => self.remove_rocky(),
        }
        cx.notify();
    }

    /// Autostart goes off first, then Node removes everything else. A request
    /// that cannot be sent fails the flow at once, with autostart left off.
    fn remove_rocky(&mut self) {
        let Some(autostart_error) = self.setup.begin_remove(&mut autostart::disable) else {
            return;
        };
        if let Some(e) = autostart_error {
            self.log.once("autostart", &e);
        }
        if !self.start_request(RequestKind::Remove) {
            let text = self.not_connected_text();
            self.setup.remove_not_sent(text);
        }
    }

    /// Route an outcome to the setup sections and act on what they ask for.
    pub(super) fn route_setup(
        &mut self,
        kind: RequestKind,
        outcome: RequestOutcome,
        expired: &str,
    ) {
        let step = self.setup.route(kind, outcome, expired);
        if step.send_plan {
            self.start_request(RequestKind::Plan);
        }
        if step.send_repo_list {
            self.start_request(RequestKind::RepoList);
        }
        if step.show_removed {
            self.ctl.view = View::Removed;
        }
    }

    /// The final screen's button, and closing the window on it: ask the daemon
    /// to quit, and exit. When the daemon does not answer in time the pump
    /// exits the desk anyway.
    pub(super) fn finish_removed(&mut self, cx: &mut Context<Self>) {
        let id = self.next_id();
        let sent = self.ctl.outbox.as_ref().is_some_and(|outbox| {
            outbox
                .send(ClientMsg::Cmd {
                    name: CmdName::Quit,
                    id,
                })
                .is_ok()
        });
        if sent {
            self.removed_quit_at
                .get_or_insert(now_ms() + REMOVED_QUIT_GRACE_MS);
            cx.notify();
        } else {
            self.quit(cx);
        }
    }

    /// True once the final screen has waited long enough for the daemon.
    pub(super) fn removed_quit_due(&self) -> bool {
        self.removed_quit_at.is_some_and(|at| now_ms() >= at)
    }

    /// Window close: hide it, or quit when the final screen shows. Returns
    /// true when the desk is quitting.
    pub(super) fn on_close_request(&mut self, cx: &mut Context<Self>) -> bool {
        if close_action(self.ctl.view) == CloseAction::Quit {
            self.finish_removed(cx);
            return true;
        }
        false
    }

    /// The setup part of the Settings panel.
    pub(super) fn setup_panel(&mut self, cx: &mut Context<Self>) -> Div {
        setup_sections(
            &self.setup,
            &self.requests,
            self.ctl.model.health(),
            self.ctl.ui_lang,
            Self::handle_setup_action,
            cx,
        )
    }
}
