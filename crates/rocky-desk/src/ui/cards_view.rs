//! Render tree for the "Selesai"/"Done" change cards section and search input.

use gpui::prelude::*;
use gpui::{
    Context, Div, FocusHandle, FontWeight, KeyDownEvent, SharedString, Stateful, Window, div, rgb,
};

use crate::cards_model::{BashRow, CardRow, CardsModel, EditRow};
use crate::i18n::{CardMsg, UiLang, card_text};
use crate::search_input::SearchInput;
use crate::ui::tooltip::{
    BORDER_LIGHT, BORDER_SUBTLE, CARD_BG, SURFACE_SUBTLE, TEXT_DARK, TEXT_DIM, TEXT_MUTED,
    chip_badge, mono_font, seq_badge, tooltip_view,
};

const MATCH_BG: u32 = 0xEEF4FC;
const HIGH_MARK_COLOR: u32 = 0xD92B2B;
const FOCUS_BORDER: u32 = 0x2B7DD9;
const BTN_ACTIVE_BG: u32 = 0xD4D4D4;
const BTN_DISABLED_BG: u32 = 0xEDEDEC;

/// User interactions emitted by the cards list, detail, and diff views.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CardAction {
    FocusSearch,
    OpenDetail(String),
    LoadMore,
    BackFromDetail,
    OpenDiff(u32),
    BackFromDiff,
    DiffPage(u32),
}

/// Callback invoked by card UI elements when triggered.
pub type OnCardAction<T> = fn(&mut T, CardAction, &mut Window, &mut Context<T>);

/// Callback invoked when key presses reach the focused search box.
pub type OnSearchKey<T> = fn(&mut T, &KeyDownEvent, &mut Context<T>);

/// Renders the "Selesai"/"Done" change cards section below live agents.
#[allow(clippy::too_many_arguments)]
pub fn cards_section<T: 'static>(
    lang: UiLang,
    cards: &CardsModel,
    search: &SearchInput,
    search_focus: &FocusHandle,
    window: &Window,
    cx: &mut Context<T>,
    on_action: OnCardAction<T>,
    on_search_key: OnSearchKey<T>,
) -> Div {
    let mut section = div()
        .flex()
        .flex_col()
        .gap_2()
        .pt_2()
        .border_t_1()
        .border_color(rgb(BORDER_SUBTLE));

    section = section.child(
        div()
            .text_xs()
            .font_weight(FontWeight::SEMIBOLD)
            .text_color(rgb(TEXT_MUTED))
            .child(card_text(lang, &CardMsg::SectionDone)),
    );

    section = section.child(search_box(
        lang,
        search,
        search_focus,
        window,
        cx,
        on_action,
        on_search_key,
    ));

    let rows = cards.rows(lang);
    if rows.is_empty() {
        let copy = cards.empty_msg();
        section = section.child(
            div()
                .text_xs()
                .text_color(rgb(TEXT_DIM))
                .py_1()
                .child(card_text(lang, &copy)),
        );
    } else {
        for row in rows {
            section = section.child(card_item(row, cx, on_action));
        }
    }

    if cards.has_more() {
        let enabled = !cards.loading();
        let label = card_text(
            lang,
            if enabled {
                &CardMsg::LoadMore
            } else {
                &CardMsg::Loading
            },
        );
        let mut btn = div()
            .id(SharedString::from("cards-load-more"))
            .px_2()
            .py_1()
            .rounded_sm()
            .text_xs()
            .bg(rgb(if enabled {
                BTN_ACTIVE_BG
            } else {
                BTN_DISABLED_BG
            }))
            .child(label);
        if enabled {
            btn = btn
                .cursor_pointer()
                .on_click(cx.listener(move |this, _, window, cx| {
                    on_action(this, CardAction::LoadMore, window, cx);
                }));
        }
        section = section.child(div().flex().child(btn));
    }

    section
}

fn search_box<T: 'static>(
    lang: UiLang,
    search: &SearchInput,
    search_focus: &FocusHandle,
    window: &Window,
    cx: &mut Context<T>,
    on_action: OnCardAction<T>,
    on_search_key: OnSearchKey<T>,
) -> Stateful<Div> {
    let focused = search_focus.is_focused(window);
    let (display, color) = if search.text.is_empty() {
        (card_text(lang, &CardMsg::SearchPlaceholder), TEXT_DIM)
    } else {
        (search.text.clone(), TEXT_DARK)
    };
    div()
        .id(SharedString::from("cards-search"))
        .track_focus(search_focus)
        .px_2()
        .py_1()
        .rounded_sm()
        .bg(rgb(CARD_BG))
        .border_1()
        .border_color(rgb(if focused { FOCUS_BORDER } else { BORDER_LIGHT }))
        .text_xs()
        .cursor_text()
        .on_click(cx.listener(move |this, _, window, cx| {
            on_action(this, CardAction::FocusSearch, window, cx);
        }))
        .on_key_down(cx.listener(move |this, ev, _, cx| {
            on_search_key(this, ev, cx);
        }))
        .child(
            div()
                .min_w_0()
                .truncate()
                .text_color(rgb(color))
                .child(display),
        )
}

fn card_item<T: 'static>(row: CardRow, cx: &mut Context<T>, on_action: OnCardAction<T>) -> Div {
    let card_id = row.card_id.clone();
    let mut card = div()
        .id(SharedString::from(format!("card:{}", row.card_id)))
        .flex()
        .flex_col()
        .gap_1()
        .p_2()
        .rounded_sm()
        .bg(rgb(CARD_BG))
        .border_1()
        .border_color(rgb(BORDER_SUBTLE))
        .cursor_pointer()
        .hover(|s| s.border_color(rgb(BORDER_LIGHT)))
        .on_click(cx.listener(move |this, _, window, cx| {
            on_action(this, CardAction::OpenDetail(card_id.clone()), window, cx);
        }));

    card = card.child(
        div()
            .flex()
            .justify_between()
            .items_center()
            .gap_2()
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_sm()
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(rgb(TEXT_DARK))
                    .child(row.title),
            )
            .child(
                div()
                    .text_xs()
                    .text_color(rgb(TEXT_DIM))
                    .whitespace_nowrap()
                    .flex_shrink_0()
                    .child(row.time),
            ),
    );

    for (idx, edit) in row.edits.iter().enumerate() {
        card = card.child(edit_row_view(&row.card_id, idx, edit));
    }

    if let Some(more) = row.more {
        card = card.child(
            div()
                .text_xs()
                .text_color(rgb(TEXT_DIM))
                .truncate()
                .child(more),
        );
    }

    card = card.child(
        div()
            .text_xs()
            .text_color(rgb(TEXT_MUTED))
            .truncate()
            .child(row.meta),
    );

    if row.indent {
        div()
            .pl_3()
            .border_l_2()
            .border_color(rgb(BORDER_LIGHT))
            .child(card)
    } else {
        div().child(card)
    }
}

fn edit_row_view(card_id: &str, idx: usize, edit: &EditRow) -> Stateful<Div> {
    let mut row = div()
        .id(SharedString::from(format!(
            "card-edit:{}:{}:{idx}",
            card_id, edit.seq
        )))
        .flex()
        .justify_between()
        .items_center()
        .gap_2()
        .w_full();

    if edit.matched {
        row = row.bg(rgb(MATCH_BG)).rounded_sm().px_1();
    }

    row = row.child(seq_badge(edit.seq));

    let left = match &edit.bash {
        Some(bash) => bash_left(bash),
        None => file_left(edit),
    };
    row = row.child(left);

    if !edit.chip.is_empty() {
        row = row.child(chip_badge(edit.chip.clone(), edit.high));
    }

    if !edit.tooltip.is_empty() {
        let lines = edit.tooltip.clone();
        row = row.tooltip(move |window, cx| tooltip_view(lines.clone(), window, cx));
    }

    row
}

fn file_left(edit: &EditRow) -> Div {
    let mut left = div().flex().flex_1().min_w_0().items_center().gap_1();
    if edit.high {
        left = left.child(
            div()
                .text_xs()
                .font_weight(FontWeight::BOLD)
                .text_color(rgb(HIGH_MARK_COLOR))
                .flex_shrink_0()
                .child("\u{25b2}"),
        );
    }
    left = left.child(
        div()
            .min_w_0()
            .truncate()
            .text_xs()
            .font_family(mono_font())
            .text_color(rgb(TEXT_DARK))
            .child(edit.file.clone()),
    );
    if let Some(sym) = &edit.symbol {
        left = left.child(
            div()
                .min_w_0()
                .truncate()
                .text_xs()
                .font_family(mono_font())
                .text_color(rgb(TEXT_MUTED))
                .child(sym.clone()),
        );
    }
    left
}

fn bash_left(bash: &BashRow) -> Div {
    let mut left = div()
        .flex()
        .flex_1()
        .min_w_0()
        .items_center()
        .gap_1()
        .overflow_hidden();
    left = left.child(
        div()
            .text_xs()
            .text_color(rgb(TEXT_MUTED))
            .whitespace_nowrap()
            .flex_shrink_0()
            .child(bash.before.clone()),
    );
    left = left.child(
        div()
            .min_w_0()
            .truncate()
            .text_xs()
            .font_family(mono_font())
            .bg(rgb(SURFACE_SUBTLE))
            .px_1()
            .rounded_sm()
            .text_color(rgb(TEXT_DARK))
            .child(bash.cmd.clone()),
    );
    if !bash.after.is_empty() {
        left = left.child(
            div()
                .text_xs()
                .text_color(rgb(TEXT_MUTED))
                .whitespace_nowrap()
                .child(bash.after.clone()),
        );
    }
    if let Some(uncertain) = &bash.uncertain {
        left = left.child(
            div()
                .text_xs()
                .text_color(rgb(TEXT_DIM))
                .whitespace_nowrap()
                .child(uncertain.clone()),
        );
    }
    left
}
