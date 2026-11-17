//! Building blocks of the Settings page: a section title, a white group card
//! with divided rows, a switch, a status chip, and three button weights.

use gpui::prelude::*;
use gpui::{
    AnyElement, App, ClickEvent, Div, FontWeight, SharedString, Stateful, Window, div, px, rgb,
};

use crate::setup_settings::Tone;
use crate::ui::tooltip::{
    BORDER_LIGHT, BORDER_SUBTLE, CARD_BG, CHIP_BG, CHIP_FG, CHIP_NEEDS_YOU_BG, CHIP_NEEDS_YOU_FG,
    DIFF_ADD_BG, DIFF_ADD_FG, DIFF_DEL_BG, DIFF_DEL_FG, LINK, ROW_HOVER_BG, TEXT_DARK, TEXT_MUTED,
    TEXT_SUBTLE, mono_font,
};

/// Red for destructive actions and failure text: 6.4:1 on white.
pub(crate) const DANGER: u32 = DIFF_DEL_FG;
/// Border of the card that holds a destructive action.
const DANGER_BORDER: u32 = 0xFECACA;
/// Divider between rows inside a group card.
const ROW_DIVIDER: u32 = 0xF0EFEE;
/// Track of a switch that is off.
const SWITCH_OFF: u32 = BORDER_LIGHT;
/// Narrowest a row's text gets before its controls wrap below it.
const TEXT_MIN_W: f32 = 260.0;

/// A section title with an optional one-line note after it.
pub fn section(title: String, note: Option<String>) -> Div {
    let mut head = div()
        .flex()
        .flex_wrap()
        .items_baseline()
        .gap_x(px(8.0))
        .mt(px(14.0))
        .px(px(2.0))
        .child(
            div()
                .text_size(px(13.0))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(rgb(TEXT_DARK))
                .child(title),
        );
    if let Some(note) = note {
        head = head.child(
            div()
                .text_size(px(12.0))
                .text_color(rgb(TEXT_MUTED))
                .child(note),
        );
    }
    head
}

/// A white card whose rows are split by thin dividers.
pub fn group(rows: Vec<AnyElement>) -> Div {
    group_with_border(rows, BORDER_SUBTLE)
}

/// The card that holds Remove: same shape, red border.
pub fn danger_group(rows: Vec<AnyElement>) -> Div {
    group_with_border(rows, DANGER_BORDER)
}

fn group_with_border(rows: Vec<AnyElement>, border: u32) -> Div {
    let mut card = div()
        .flex()
        .flex_col()
        .rounded(px(8.0))
        .overflow_hidden()
        .bg(rgb(CARD_BG))
        .border_1()
        .border_color(rgb(border));
    for (i, row) in rows.into_iter().enumerate() {
        let mut cell = div();
        if i > 0 {
            cell = cell.border_t_1().border_color(rgb(ROW_DIVIDER));
        }
        card = card.child(cell.child(row));
    }
    card
}

/// One row: label and optional note on the left, `trailing` on the right.
pub fn row(label: impl IntoElement, note: Option<String>, trailing: Option<AnyElement>) -> Div {
    // The text keeps at least TEXT_MIN_W; below that the trailing controls
    // wrap under it instead of squeezing a path down to a few letters.
    let mut text = div()
        .flex()
        .flex_col()
        .flex_1()
        .min_w(px(TEXT_MIN_W))
        .gap(px(2.0))
        .child(
            div()
                .w_full()
                .text_size(px(13.0))
                .text_color(rgb(TEXT_DARK))
                .child(label),
        );
    if let Some(note) = note {
        text = text.child(note_line(note));
    }
    let mut out = div()
        .flex()
        .flex_wrap()
        .items_center()
        .gap(px(12.0))
        .px(px(14.0))
        .py(px(10.0))
        .child(text);
    if let Some(trailing) = trailing {
        out = out.child(
            div()
                .flex()
                .flex_none()
                .items_center()
                .gap(px(6.0))
                .child(trailing),
        );
    }
    out
}

/// Secondary text under a row label.
pub fn note_line(text: String) -> Div {
    div()
        .text_size(px(12.0))
        .text_color(rgb(TEXT_MUTED))
        .child(text)
}

/// A path or other machine text under a row label, cut to one line. The
/// text sits in a flex row: gpui measures a truncated child to its full
/// width there and then shrinks it, where a column would measure it at zero.
pub fn mono_line(text: String) -> Div {
    div().flex().w_full().min_w_0().child(
        div()
            .min_w_0()
            .truncate()
            .font_family(mono_font())
            .text_size(px(11.5))
            .text_color(rgb(TEXT_MUTED))
            .child(text),
    )
}

/// Failure text under a row label.
pub fn error_text(text: String) -> Div {
    div()
        .text_size(px(12.0))
        .text_color(rgb(DANGER))
        .child(text)
}

/// A switch drawn from `on`; the row around it takes the click.
pub fn switch(on: bool, enabled: bool) -> Div {
    let knob = div().size(px(14.0)).rounded_full().bg(rgb(CARD_BG));
    let mut track = div()
        .flex()
        .flex_none()
        .items_center()
        .w(px(30.0))
        .h(px(18.0))
        .px(px(2.0))
        .rounded_full()
        .bg(rgb(if on { TEXT_DARK } else { SWITCH_OFF }))
        .child(knob);
    if on {
        track = track.justify_end();
    }
    if !enabled {
        track = track.opacity(0.5);
    }
    track
}

/// A whole row that flips a switch when clicked.
pub fn toggle_row(
    id: SharedString,
    label: String,
    note: Option<String>,
    on: bool,
    enabled: bool,
    handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> Stateful<Div> {
    let mut out = row(label, note, Some(switch(on, enabled).into_any_element())).id(id);
    if enabled {
        out = out
            .cursor_pointer()
            .hover(|s| s.bg(rgb(ROW_HOVER_BG)))
            .on_click(handler);
    }
    out
}

/// A small status label whose color says how much it needs attention.
pub fn chip(text: String, tone: Tone) -> Div {
    let (bg, fg) = match tone {
        Tone::Ok => (DIFF_ADD_BG, DIFF_ADD_FG),
        Tone::Warn => (CHIP_NEEDS_YOU_BG, CHIP_NEEDS_YOU_FG),
        Tone::Bad => (DIFF_DEL_BG, DIFF_DEL_FG),
        Tone::Neutral => (CHIP_BG, CHIP_FG),
    };
    div()
        .flex_none()
        .px(px(7.0))
        .rounded_full()
        .bg(rgb(bg))
        .text_color(rgb(fg))
        .text_size(px(11.5))
        .whitespace_nowrap()
        .child(text)
}

/// How loud a button is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Weight {
    /// Outlined: the normal action of a row.
    Normal,
    /// Text only, for a secondary action next to a normal one.
    Quiet,
    /// Text only in red, for an action that deletes.
    QuietDanger,
    /// Outlined in red, for Remove.
    Danger,
}

pub fn button(
    id: SharedString,
    label: String,
    weight: Weight,
    enabled: bool,
    handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> Stateful<Div> {
    let (fg, border) = match weight {
        Weight::Normal => (TEXT_DARK, Some(BORDER_SUBTLE)),
        Weight::Quiet => (TEXT_SUBTLE, None),
        Weight::QuietDanger => (DANGER, None),
        Weight::Danger => (DANGER, Some(DANGER_BORDER)),
    };
    let mut b = div()
        .id(id)
        .flex_none()
        .px(px(10.0))
        .py(px(3.0))
        .rounded(px(6.0))
        .border_1()
        .border_color(rgb(border.unwrap_or(CARD_BG)))
        .text_size(px(12.5))
        .whitespace_nowrap()
        .text_color(rgb(fg))
        .focus(|s| s.border_color(rgb(LINK)))
        .child(label);
    if border.is_some() {
        b = b.bg(rgb(CARD_BG));
    }
    if enabled {
        b = b
            .cursor_pointer()
            .hover(|s| s.bg(rgb(ROW_HOVER_BG)))
            .on_click(handler);
    } else {
        b = b.opacity(0.5);
    }
    b
}

/// One option of a segmented control; the control is a row of these.
pub fn segment(
    id: SharedString,
    label: String,
    selected: bool,
    enabled: bool,
    handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> Stateful<Div> {
    let mut s = div()
        .id(id)
        .px(px(10.0))
        .py(px(2.0))
        .rounded(px(5.0))
        .border_1()
        .text_size(px(12.5))
        .whitespace_nowrap()
        .child(label);
    s = if selected {
        s.bg(rgb(CARD_BG))
            .border_color(rgb(BORDER_SUBTLE))
            .text_color(rgb(TEXT_DARK))
    } else {
        s.border_color(rgb(CHIP_BG)).text_color(rgb(TEXT_SUBTLE))
    };
    if enabled && !selected {
        s = s.cursor_pointer().on_click(handler);
    }
    s
}

/// The tray of a segmented control.
pub fn segments(children: Vec<AnyElement>) -> Div {
    div()
        .flex()
        .flex_none()
        .p(px(2.0))
        .rounded(px(7.0))
        .bg(rgb(CHIP_BG))
        .children(children)
}
