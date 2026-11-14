//! Autostart banner and settings panel for the desk window.

use gpui::prelude::*;
use gpui::{Context, Div, SharedString, div, rgb};
use rocky_proto::settings::Lang;

use super::DeskView;
use crate::consent_view::{autostart_banner_hidden, show_install_row};
use crate::i18n::{Msg, tr};
use crate::settings_view::{self, SettingId, show_autostart_banner};
use crate::ui::consent::install_row;

impl DeskView {
    /// The one-time sign-in question, shown while it is unanswered.
    pub(super) fn banner(&mut self, cx: &mut Context<Self>) -> Option<Div> {
        // The consent screen carries the sign-in question itself.
        if autostart_banner_hidden(self.ctl.view, self.consent.answered())
            || !show_autostart_banner(self.ctl.tray_start, self.ctl.model.settings())
        {
            return None;
        }
        let lang = self.ctl.ui_lang;
        let mut banner = div()
            .flex()
            .flex_col()
            .gap_2()
            .p_2()
            .rounded_sm()
            .bg(rgb(0xE4E9F7));
        banner = banner.child(div().text_sm().child(tr(lang, &Msg::AutostartQuestion)));
        let mut buttons = div().flex().gap_2();
        for (label, yes) in [(Msg::Yes, true), (Msg::No, false)] {
            let id = if yes { "autostart-yes" } else { "autostart-no" };
            buttons = buttons.child(
                div()
                    .id(SharedString::from(id))
                    .px_2()
                    .rounded_sm()
                    .bg(rgb(0xFFFFFF))
                    .text_sm()
                    .cursor_pointer()
                    .child(tr(lang, &label))
                    .on_click(cx.listener(move |this, _, _, cx| this.answer_autostart(yes, cx))),
            );
        }
        banner = banner.child(buttons);
        if self.ctl.autostart_failed {
            banner = banner.child(
                div()
                    .text_xs()
                    .text_color(rgb(0xD92B2B))
                    .child(tr(lang, &Msg::AutostartFailed)),
            );
        }
        Some(banner)
    }

    /// Toggles reflect the last broadcast settings; sign-in state is read
    /// locally. Nothing here changes until the daemon confirms a `set`.
    pub(super) fn settings_panel(&mut self, cx: &mut Context<Self>) -> Div {
        let lang = self.ctl.ui_lang;
        let editable = self.ctl.model.editable();
        let settings = self.ctl.model.settings().cloned();
        let mut panel = div().flex().flex_col().gap_2();
        if !editable {
            panel = panel.child(div().text_sm().child(tr(lang, &Msg::SettingsReadOnly)));
        }
        let Some(settings) = settings else {
            return panel;
        };
        for setting in SettingId::ALL {
            panel = panel.child(settings_view::toggle_row(
                SharedString::from(format!("setting:{}", setting.wire_name())),
                tr(lang, &setting.label()),
                setting.get(&settings),
                editable,
                cx.listener(move |this, _, _, _| this.toggle_setting(setting)),
            ));
        }
        if !settings.tool_text && settings.history {
            panel = panel.child(div().text_xs().child(tr(lang, &Msg::ToolTextHistoryNote)));
        }
        let mut langs = div().flex().gap_2();
        for (value, label) in [
            (Lang::Auto, Msg::LangAuto),
            (Lang::En, Msg::LangEn),
            (Lang::Id, Msg::LangId),
        ] {
            langs = langs.child(settings_view::choice(
                SharedString::from(format!("lang:{value:?}")),
                tr(lang, &label),
                settings.lang == value,
                editable,
                cx.listener(move |this, _, _, _| this.choose_lang(value)),
            ));
        }
        panel = panel.child(langs);
        panel = panel.child(settings_view::toggle_row(
            SharedString::from("setting:autostart"),
            tr(lang, &Msg::Autostart),
            self.ctl.autostart_on.unwrap_or(false),
            editable,
            cx.listener(|this, _, _, cx| this.toggle_autostart(cx)),
        ));
        if self.ctl.autostart_failed {
            panel = panel.child(
                div()
                    .text_xs()
                    .text_color(rgb(0xD92B2B))
                    .child(tr(lang, &Msg::AutostartFailed)),
            );
        }
        if show_install_row(self.consent.consent()) {
            panel = panel.child(install_row(
                lang,
                cx.listener(|this, _, _, cx| this.open_consent(cx)),
            ));
        }
        if let Some(err) = self.ctl.model.set_error() {
            panel = panel.child(div().text_sm().text_color(rgb(0xD92B2B)).child(tr(
                lang,
                &Msg::SetFailed {
                    reason: err.to_string(),
                },
            )));
        }
        panel
    }
}
