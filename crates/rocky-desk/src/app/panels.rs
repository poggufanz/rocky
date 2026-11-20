//! Autostart banner and settings panel for the desk window.

use gpui::prelude::*;
use gpui::{AnyElement, Context, Div, SharedString, div, px, rgb};
use rocky_proto::settings::Lang;
use rocky_proto::translate::TranslatePair;

use super::DeskView;
use crate::consent_view::{autostart_banner_hidden, show_install_row};
use crate::i18n::{Msg, SetupMsg, UiLang, tr};
use crate::requests::RequestKind;
use crate::settings_view::{SettingId, show_autostart_banner};
use crate::translate_model::{
    StatusLine, TranslateAction, TranslateError, quote_lang, status_line,
};
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
            self.translate_settings_row(lang, editable, settings.translate_quotes, cx),
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

    fn translate_settings_row(
        &mut self,
        lang: UiLang,
        editable: bool,
        enabled: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let status = self.ctl.model.translate_status();
        let sl = status_line(enabled, status, lang);
        let can_remove = !status.ready.is_empty() || status.failed.is_some();
        let toggle = kit::toggle_row(
            SharedString::from("setting:translate_quotes"),
            setup_text(lang, SetupMsg::TranslateQuotesToggle),
            Some(setup_text(lang, status_msg(sl))),
            enabled,
            editable,
            cx.listener(|this, _, _, cx| {
                this.translate_act(TranslateAction::Toggle);
                cx.notify();
            }),
        );

        let pair = TranslatePair::to(quote_lang(lang));
        let install_busy = self.requests.pending(&RequestKind::TranslateInstall(pair));
        let remove_busy = self.requests.pending(&RequestKind::TranslateRemove);
        let asked = self.translate.asking();

        let mut buttons: Vec<AnyElement> = Vec::new();
        let install = match sl {
            _ if asked.is_some() => None,
            StatusLine::NeedsDownload => Some((
                "translate:download",
                SetupMsg::TranslateDownload,
                TranslateAction::Download,
            )),
            StatusLine::Failed(_) => Some((
                "translate:retry",
                SetupMsg::TranslateRetry,
                TranslateAction::Retry,
            )),
            _ => None,
        };
        if let Some((id, label, action)) = install {
            buttons.push(translate_button(
                lang,
                id,
                busy_label(install_busy, label),
                kit::Weight::Normal,
                editable && !install_busy,
                action,
                cx,
            ));
        }
        if can_remove {
            buttons.push(translate_button(
                lang,
                "translate:remove",
                busy_label(remove_busy, SetupMsg::TranslateRemove),
                kit::Weight::QuietDanger,
                editable && !remove_busy,
                TranslateAction::Remove,
                cx,
            ));
        }

        let mut extras: Vec<AnyElement> = Vec::new();
        if !buttons.is_empty() {
            extras.push(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap(px(6.0))
                    .children(buttons)
                    .into_any_element(),
            );
        }
        if let Some(asked) = asked {
            let confirm_busy = self.requests.pending(&RequestKind::TranslateInstall(asked));
            extras.push(translate_ask(lang, editable, confirm_busy, cx));
        }
        if let Some(err) = self.translate.error() {
            extras.push(kit::error_text(setup_text(lang, error_msg(err))).into_any_element());
        }

        let mut block = div().flex().flex_col().child(toggle);
        if !extras.is_empty() {
            block = block.child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.0))
                    .px(px(14.0))
                    .pb(px(10.0))
                    .children(extras),
            );
        }
        block.into_any_element()
    }
}

fn setup_text(lang: UiLang, msg: SetupMsg) -> String {
    tr(lang, &Msg::Setup(msg))
}

/// `Working…` while the request is in flight, `idle` otherwise.
fn busy_label(busy: bool, idle: SetupMsg) -> SetupMsg {
    if busy { SetupMsg::SwitchWorking } else { idle }
}

fn status_msg(sl: StatusLine) -> SetupMsg {
    match sl {
        StatusLine::Off => SetupMsg::TranslateOff,
        StatusLine::NeedsDownload => SetupMsg::TranslateNeedsDownload,
        StatusLine::Downloading(percent) => SetupMsg::TranslateDownloading { percent },
        StatusLine::Ready => SetupMsg::TranslateReady,
        StatusLine::Failed(failure) => SetupMsg::TranslateFailed { failure },
    }
}

fn error_msg(err: &TranslateError) -> SetupMsg {
    match err {
        TranslateError::Busy => SetupMsg::TranslateBusy,
        TranslateError::Disabled => SetupMsg::TranslateDisabledError,
        TranslateError::Engine => SetupMsg::TranslateEngineError,
        TranslateError::RemoveFailed => SetupMsg::TranslateRemoveError,
        TranslateError::Unknown => SetupMsg::TranslateUnknownError,
        TranslateError::Other(reason) => SetupMsg::TranslateRequestFailed {
            reason: reason.clone(),
        },
    }
}

fn translate_button(
    lang: UiLang,
    id: &'static str,
    label: SetupMsg,
    weight: kit::Weight,
    enabled: bool,
    action: TranslateAction,
    cx: &mut Context<DeskView>,
) -> AnyElement {
    kit::button(
        SharedString::from(id),
        setup_text(lang, label),
        weight,
        enabled,
        cx.listener(move |this, _, _, cx| {
            this.translate_act(action);
            cx.notify();
        }),
    )
    .into_any_element()
}

/// The inline download question with Download and Cancel.
fn translate_ask(
    lang: UiLang,
    editable: bool,
    confirm_busy: bool,
    cx: &mut Context<DeskView>,
) -> AnyElement {
    div()
        .flex()
        .flex_wrap()
        .items_center()
        .gap(px(8.0))
        .child(kit::note_line(setup_text(
            lang,
            SetupMsg::TranslateConsentAsk,
        )))
        .child(translate_button(
            lang,
            "translate:confirm",
            busy_label(confirm_busy, SetupMsg::TranslateDownload),
            kit::Weight::Normal,
            editable && !confirm_busy,
            TranslateAction::Confirm,
            cx,
        ))
        .child(translate_button(
            lang,
            "translate:cancel",
            SetupMsg::TranslateCancel,
            kit::Weight::Quiet,
            editable,
            TranslateAction::Cancel,
            cx,
        ))
        .into_any_element()
}
