//! Render tree for the first-use consent screen and the Settings install row.

use gpui::prelude::*;
use gpui::{App, ClickEvent, Div, IntoElement, SharedString, Stateful, Window, div, rgb};

use crate::consent_view::{ConsentModel, PlanRow, Stage, plan_failure_msg};
use crate::i18n::{Msg, SetupMsg, UiLang, tr};
use crate::settings_view::toggle_row;

const ERROR_COLOR: u32 = 0xD92B2B;

fn text(lang: UiLang, m: SetupMsg) -> String {
    tr(lang, &Msg::Setup(m))
}

fn button(
    id: &'static str,
    label: String,
    enabled: bool,
    handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> Stateful<Div> {
    let mut b = div()
        .id(SharedString::from(id))
        .px_3()
        .py_1()
        .rounded_sm()
        .text_sm()
        .bg(rgb(if enabled { 0xD4D4D4 } else { 0xEDEDEC }))
        .child(label);
    if enabled {
        b = b.cursor_pointer().on_click(handler);
    }
    b
}

fn plan_row(lang: UiLang, row: &PlanRow) -> Div {
    let mut head = div()
        .flex()
        .gap_2()
        .text_sm()
        .child(format!("{} \u{b7} {}", row.harness, row.kind));
    if row.installed {
        head = head.child(
            div()
                .text_color(rgb(0x2BA044))
                .child(text(lang, SetupMsg::ConsentInstalled)),
        );
    }
    let mut out = div()
        .flex_col()
        .gap_1()
        .child(head)
        .child(div().text_xs().child(row.path.clone()));
    if let Some(failure) = &row.failure {
        out = out.child(
            div()
                .text_xs()
                .text_color(rgb(ERROR_COLOR))
                .child(tr(lang, failure)),
        );
    }
    out
}

/// The whole consent screen. It scrolls when the plan outgrows the window.
pub fn consent_screen(
    model: &ConsentModel,
    lang: UiLang,
    toggle_autostart: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    agree: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    later: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    done: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> impl IntoElement {
    let mut root = div()
        .id(SharedString::from("consent"))
        .flex()
        .flex_col()
        .gap_2()
        .p_3()
        .size_full()
        .overflow_y_scroll()
        .bg(rgb(0xF5F5F4))
        .text_color(rgb(0x1C1C1C))
        .child(
            div()
                .text_base()
                .child(text(lang, SetupMsg::ConsentHeading)),
        );
    if let Some(why) = model.plan_failure {
        root = root.child(
            div()
                .text_sm()
                .text_color(rgb(ERROR_COLOR))
                .child(text(lang, plan_failure_msg(why))),
        );
    }
    match &model.stage {
        Stage::Loading => {
            root = root.child(div().text_sm().child(text(lang, SetupMsg::ConsentLoading)));
        }
        Stage::Applying => {
            root = root.child(div().text_sm().child(text(lang, SetupMsg::ConsentApplying)));
        }
        Stage::Failed(error) => {
            root = root.child(div().text_sm().text_color(rgb(ERROR_COLOR)).child(text(
                lang,
                SetupMsg::ConsentFailed {
                    error: error.clone(),
                },
            )));
        }
        Stage::Ready | Stage::Result => {}
    }
    for row in &model.rows {
        root = root.child(plan_row(lang, row));
    }
    let result = model.stage == Stage::Result;
    if result {
        return root.child(div().flex().gap_2().child(button(
            "consent-done",
            text(lang, SetupMsg::ConsentDone),
            true,
            done,
        )));
    }
    root.child(div().text_xs().child(text(lang, SetupMsg::ConsentJsonNote)))
        .child(
            div()
                .text_xs()
                .child(text(lang, SetupMsg::ConsentBackupNote)),
        )
        .child(toggle_row(
            SharedString::from("consent-autostart"),
            text(lang, SetupMsg::ConsentAutostart),
            model.autostart,
            model.can_agree(),
            toggle_autostart,
        ))
        .child(
            div()
                .flex()
                .gap_2()
                .child(button(
                    "consent-agree",
                    text(lang, SetupMsg::ConsentAgree),
                    model.can_agree(),
                    agree,
                ))
                .child(button(
                    "consent-later",
                    text(lang, SetupMsg::ConsentLater),
                    model.can_later(),
                    later,
                )),
        )
}

/// The Settings row that opens the consent screen.
pub fn install_row(
    lang: UiLang,
    handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> impl IntoElement {
    button(
        "settings-install",
        text(lang, SetupMsg::ConsentInstall),
        true,
        handler,
    )
}
