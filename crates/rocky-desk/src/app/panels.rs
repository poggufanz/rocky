//! Autostart banner and settings panel for the desk window.

use gpui::prelude::*;
use gpui::{AnyElement, Context, Div, SharedString, div, rgb};
use rocky_proto::settings::Lang;

use super::DeskView;
use crate::consent_view::{autostart_banner_hidden, show_install_row};
use crate::i18n::{Msg, SetupMsg, tr};
use crate::settings_view::{SettingId, show_autostart_banner};
use crate::ui::consent::install_row;
use crate::ui::settings_kit as kit;

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
        let setup = |m: SetupMsg| tr(lang, &Msg::Setup(m));
        let editable = self.ctl.model.editable();
        let settings = self.ctl.model.settings().cloned();
        let mut panel = div().flex().flex_col().gap_2();
        if !editable {
            panel = panel.child(kit::note_line(tr(lang, &Msg::SettingsReadOnly)));
        }
        let Some(settings) = settings else {
            return panel;
        };

        let mut langs: Vec<AnyElement> = Vec::new();
        for (value, label) in [
            (Lang::Auto, Msg::LangAuto),
            (Lang::En, Msg::LangEn),
            (Lang::Id, Msg::LangId),
        ] {
            langs.push(
                kit::segment(
                    SharedString::from(format!("lang:{value:?}")),
                    tr(lang, &label),
                    settings.lang == value,
                    editable,
                    cx.listener(move |this, _, _, _| this.choose_lang(value)),
                )
                .into_any_element(),
            );
        }
        let mut general: Vec<AnyElement> = vec![
            kit::row(
                setup(SetupMsg::SettingsLanguage),
                Some(setup(SetupMsg::SettingsLanguageNote)),
                Some(kit::segments(langs).into_any_element()),
            )
            .into_any_element(),
            kit::toggle_row(
                SharedString::from("setting:autostart"),
                tr(lang, &Msg::Autostart),
                Some(setup(SetupMsg::SettingsAutostartNote)),
                self.ctl.autostart_on.unwrap_or(false),
                editable,
                cx.listener(|this, _, _, cx| this.toggle_autostart(cx)),
            )
            .into_any_element(),
        ];
        if self.ctl.autostart_failed {
            general.push(
                div()
                    .px_3()
                    .pb_2()
                    .child(kit::error_text(tr(lang, &Msg::AutostartFailed)))
                    .into_any_element(),
            );
        }
        if show_install_row(self.consent.consent()) {
            general.push(
                kit::row(
                    setup(SetupMsg::SettingsAgentTools),
                    None,
                    Some(
                        install_row(lang, cx.listener(|this, _, _, cx| this.open_consent(cx)))
                            .into_any_element(),
                    ),
                )
                .into_any_element(),
            );
        }
        panel = panel
            .child(kit::section(setup(SetupMsg::SettingsGeneral), None))
            .child(kit::group(general));

        let switch = |this_setting: SettingId, note: Option<String>, cx: &mut Context<Self>| {
            kit::toggle_row(
                SharedString::from(format!("setting:{}", this_setting.wire_name())),
                tr(lang, &this_setting.label()),
                note,
                this_setting.get(&settings),
                editable,
                cx.listener(move |this, _, _, _| this.toggle_setting(this_setting)),
            )
            .into_any_element()
        };
        let tool_text_note = if !settings.tool_text && settings.history {
            tr(lang, &Msg::ToolTextHistoryNote)
        } else {
            setup(SetupMsg::SettingsToolTextNote)
        };
        let records = vec![
            switch(
                SettingId::History,
                Some(setup(SetupMsg::SettingsHistoryNote)),
                cx,
            ),
            switch(SettingId::ToolText, Some(tool_text_note), cx),
            switch(
                SettingId::Cards,
                Some(setup(SetupMsg::SettingsCardsNote)),
                cx,
            ),
            switch(
                SettingId::SubagentTree,
                Some(setup(SetupMsg::SettingsSubagentNote)),
                cx,
            ),
        ];
        panel = panel
            .child(kit::section(setup(SetupMsg::SettingsRecords), None))
            .child(kit::group(records));

        let mut notify: Vec<AnyElement> = Vec::new();
        for (setting, label) in [
            (SettingId::NotifyNeedsYou, SetupMsg::SettingsNotifyNeedsYou),
            (SettingId::NotifyFailed, SetupMsg::SettingsNotifyFailed),
            (SettingId::NotifyDone, SetupMsg::SettingsNotifyDone),
        ] {
            notify.push(
                kit::toggle_row(
                    SharedString::from(format!("setting:{}", setting.wire_name())),
                    setup(label),
                    None,
                    setting.get(&settings),
                    editable,
                    cx.listener(move |this, _, _, _| this.toggle_setting(setting)),
                )
                .into_any_element(),
            );
        }
        panel = panel
            .child(kit::section(setup(SetupMsg::SettingsNotifications), None))
            .child(kit::group(notify));

        if let Some(err) = self.ctl.model.set_error() {
            panel = panel.child(kit::error_text(tr(
                lang,
                &Msg::SetFailed {
                    reason: err.to_string(),
                },
            )));
        }
        panel
    }
}
