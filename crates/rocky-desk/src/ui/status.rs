//! Status dot, pill, chip, and color helpers shared by the atlas and settings.

use gpui::prelude::*;
use gpui::{Div, FontWeight, div, px, rgb};
use rocky_proto::pipe::Status;

use crate::i18n::{Msg, UiLang, tr};
use crate::ui::tooltip::{
    CHIP_BG, CHIP_FG, CHIP_HIGH_BG, CHIP_HIGH_FG, CHIP_NEEDS_YOU_BG, CHIP_NEEDS_YOU_FG,
    CHIP_WORKING_BG, CHIP_WORKING_FG, STATUS_DONE, STATUS_FAILED, STATUS_IDLE, STATUS_NEEDS_YOU,
    STATUS_WORKING, TEXT_MUTED, TIMER_NEEDS_YOU, TIMER_WORKING,
};

pub(crate) fn dot_el(color: u32) -> Div {
    div()
        .w(px(8.0))
        .h(px(8.0))
        .rounded_full()
        .flex_shrink_0()
        .bg(rgb(color))
}

pub(crate) fn status_pill(lang: UiLang, status: Status) -> Div {
    let (bg, fg) = match status {
        Status::NeedsYou => (CHIP_NEEDS_YOU_BG, CHIP_NEEDS_YOU_FG),
        Status::Working => (CHIP_WORKING_BG, CHIP_WORKING_FG),
        Status::Done | Status::Failed | Status::Idle | Status::Ended => (CHIP_BG, CHIP_FG),
    };
    div()
        .py(px(2.0))
        .px(px(7.0))
        .rounded(px(99.0))
        .whitespace_nowrap()
        .flex_shrink_0()
        .bg(rgb(bg))
        .text_color(rgb(fg))
        .text_size(px(10.5))
        .font_weight(FontWeight::SEMIBOLD)
        .child(tr(lang, &Msg::Status(status)))
}

pub(crate) fn failures_chip(text: String) -> Div {
    div()
        .text_size(px(10.5))
        .font_weight(FontWeight::SEMIBOLD)
        .py(px(2.0))
        .px(px(6.0))
        .rounded(px(4.0))
        .whitespace_nowrap()
        .flex_shrink_0()
        .bg(rgb(CHIP_HIGH_BG))
        .text_color(rgb(CHIP_HIGH_FG))
        .child(text)
}

pub(crate) fn status_dot_color(status: Status) -> u32 {
    match status {
        Status::NeedsYou => STATUS_NEEDS_YOU,
        Status::Working => STATUS_WORKING,
        Status::Done => STATUS_DONE,
        Status::Failed => STATUS_FAILED,
        Status::Idle | Status::Ended => STATUS_IDLE,
    }
}

pub(crate) fn timer_color(status: Status) -> u32 {
    match status {
        Status::NeedsYou => TIMER_NEEDS_YOU,
        Status::Working => TIMER_WORKING,
        Status::Done | Status::Failed | Status::Idle | Status::Ended => TEXT_MUTED,
    }
}
