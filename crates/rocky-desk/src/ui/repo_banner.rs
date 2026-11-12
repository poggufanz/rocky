//! The in-window question for a repo waiting for an answer. Placement comes
//! from `repo_banner`; busy and error state from the Settings request model.

use gpui::prelude::*;
use gpui::{Context, Div, div, rgb};
use rocky_proto::pipe::PendingRepo;

use crate::i18n::{Msg, SetupMsg, UiLang, tr};
use crate::requests::Requests;
use crate::setup_settings::{Control, SetupSettings};
use crate::ui::setup_settings::{OnAction, SettingsAction, action_button, error_line};

const BANNER_BG: u32 = 0xF1ECDD;

/// Question with Allow and No. Both buttons are disabled, and say "working",
/// while a request for this repo is in flight; a failed one shows its error
/// and leaves the buttons ready for another try.
pub fn repo_banner<T: 'static>(
    lang: UiLang,
    requests: &Requests,
    model: &SetupSettings,
    repo: &PendingRepo,
    cx: &mut Context<T>,
    on_action: OnAction<T>,
) -> Div {
    let control = Control::Repo(repo.main.clone());
    let busy = control.busy(requests);
    let (allow, no) = if busy {
        (SetupMsg::SwitchWorking, SetupMsg::SwitchWorking)
    } else {
        (SetupMsg::RepoAllow, SetupMsg::RepoBannerNo)
    };
    let text = |m: SetupMsg| tr(lang, &Msg::Setup(m));
    let mut out = div()
        .flex_col()
        .gap_1()
        .p_2()
        .rounded_sm()
        .bg(rgb(BANNER_BG))
        .child(div().text_sm().child(text(SetupMsg::RepoBannerAsk {
            name: repo.name.clone(),
        })))
        .child(
            div()
                .flex()
                .gap_2()
                .child(action_button(
                    format!("banner-allow:{}", repo.main),
                    text(allow),
                    !busy,
                    SettingsAction::RepoAllow(repo.main.clone()),
                    cx,
                    on_action,
                ))
                .child(action_button(
                    format!("banner-no:{}", repo.main),
                    text(no),
                    !busy,
                    SettingsAction::RepoRevoke(repo.main.clone()),
                    cx,
                    on_action,
                )),
        );
    if let Some(error) = model.error(&control) {
        out = out.child(error_line(lang, error));
    }
    out
}
