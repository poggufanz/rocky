//! Tray icon/tooltip updates and desk process exit.

use gpui::{App, Context};

use super::DeskView;
use crate::i18n::tr;
use crate::icons::tray_icon;

impl DeskView {
    pub(super) fn refresh_tray(&mut self, cx: &mut App) {
        let Some(tray) = self.tray.as_ref() else {
            return;
        };
        let agg = self.ctl.model.aggregate();
        if agg != self.ctl.last_aggregate {
            self.ctl.last_aggregate = agg;
            if let Err(e) = tray.set_icon(tray_icon(agg), cx) {
                self.log.once("set_icon", &e);
            }
        }
        let tip = self.ctl.model.tooltip();
        if tip != self.ctl.last_tooltip {
            self.ctl.last_tooltip = tip.clone();
            if let Err(e) = tray.set_tooltip(Some(tr(self.ctl.ui_lang, &tip)), cx) {
                self.log.once("set_tooltip", &e);
            }
        }
    }

    /// Close the tray icon and end the process. The daemon keeps running.
    /// Taking the tray first means nothing refreshes it after the close. Safe
    /// inside the view lease: closing a tray unregisters it and never runs
    /// the menu builder that reads this view.
    pub(super) fn quit(&mut self, cx: &mut Context<Self>) {
        if let Some(tray) = self.tray.take()
            && let Err(e) = tray.close(cx)
        {
            self.log.once("tray_close", &e);
        }
        cx.quit();
    }
}
