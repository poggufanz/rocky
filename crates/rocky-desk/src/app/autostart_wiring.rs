//! Sign-in autostart state and actions for the desk.

use gpui::Context;

use super::DeskView;
use crate::autostart;
use crate::settings_view::set_autostart_asked;

impl DeskView {
    /// Read the sign-in registration from the Run key and Task Manager's flag.
    pub(super) fn read_autostart(&mut self) {
        match std::env::current_exe().and_then(|exe| autostart::state(&exe)) {
            Ok(on) => {
                self.ctl.autostart_on = Some(on);
                self.ctl.autostart_failed = false;
            }
            Err(e) => {
                self.ctl.autostart_failed = true;
                self.log.once("autostart", &e);
            }
        }
    }

    pub(super) fn toggle_autostart(&mut self, cx: &mut Context<Self>) {
        if !self.ctl.model.editable() {
            return;
        }
        let Some(on) = self.ctl.autostart_on else {
            return;
        };
        let result = if on {
            autostart::disable()
        } else {
            std::env::current_exe().and_then(|exe| autostart::enable(&exe))
        };
        match result {
            Ok(()) => self.read_autostart(),
            Err(e) => {
                self.ctl.autostart_failed = true;
                self.log.once("autostart", &e);
            }
        }
        cx.notify();
    }

    /// Answer the sign-in question. Both answers mark it asked; only Yes
    /// writes the Run value.
    pub(super) fn answer_autostart(&mut self, yes: bool, cx: &mut Context<Self>) {
        if yes {
            match std::env::current_exe().and_then(|exe| autostart::enable(&exe)) {
                Ok(()) => {
                    self.ctl.autostart_on = Some(true);
                    self.ctl.autostart_failed = false;
                }
                Err(e) => {
                    self.ctl.autostart_failed = true;
                    self.log.once("autostart", &e);
                }
            }
        }
        let id = self.next_id();
        self.send_set(id, set_autostart_asked(id));
        cx.notify();
    }
}
