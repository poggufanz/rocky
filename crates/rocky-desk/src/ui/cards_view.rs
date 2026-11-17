//! Render tree for the "Selesai"/"Done" change cards section and search input.
//!
//! The list is a log, not a stack of cards: one surface, one row per turn.
//! Each row reads left to right as when, what was asked, and which files
//! changed, so the eye can run down the time column and stop on a file name.

use gpui::prelude::*;
use gpui::{
    Context, Div, FocusHandle, FontWeight, HighlightStyle, KeyDownEvent, SharedString, Stateful,
    StyledText, Window, div, px, rgb,
};

use crate::atlas_model::ProjectId;
use crate::cards_model::{CardRow, CardsModel, FileChip};
use crate::i18n::{CardMsg, UiLang, card_text};
use crate::search_input::SearchInput;
use crate::ui::motion;
use crate::ui::tooltip::{
    BORDER_LIGHT, BORDER_SUBTLE, CARD_BG, CHIP_BG, CHIP_HIGH_FG, DIFF_DEL_FG, LINK, MATCH_BG,
    ROW_HOVER_BG, TEXT_BODY, TEXT_DARK, TEXT_DIM, TEXT_MUTED, TEXT_SUBTLE, mono_font, tooltip_view,
};

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

/// Width of the time column; holds `HH:MM` in the monospace font.
const TIME_W: f32 = 40.0;

/// Section title shared by Now and Done: sentence case, quiet, no tracking.
pub(crate) fn section_title(text: String) -> Div {
    div()
        .text_size(px(13.0))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(rgb(TEXT_SUBTLE))
        .child(text)
}

/// Renders the "Selesai"/"Done" change cards section below live agents.
#[allow(clippy::too_many_arguments)]
pub fn cards_section<T: 'static>(
    lang: UiLang,
    cards: &CardsModel,
    project: Option<&ProjectId>,
    search: &SearchInput,
    search_focus: &FocusHandle,
    window: &Window,
    cx: &mut Context<T>,
    on_action: OnCardAction<T>,
    on_search_key: OnSearchKey<T>,
) -> Div {
    let mut section = div().flex().flex_col().gap(px(8.0)).pt(px(10.0));

    section = section.child(
        div()
            .flex()
            .flex_wrap()
            .items_center()
            .justify_between()
            .gap(px(8.0))
            .px(px(2.0))
            .child(section_title(card_text(lang, &CardMsg::SectionDone)))
            .child(search_box(
                lang,
                search,
                search_focus,
                window,
                cx,
                on_action,
                on_search_key,
            )),
    );

    let rows = match project {
        Some(project) => cards.rows_for(lang, project),
        None => cards.rows(lang),
    };
    if rows.is_empty() {
        let copy = cards.empty_msg_for(project);
        section = section.child(
            div()
                .px(px(14.0))
                .py(px(14.0))
                .rounded(px(8.0))
                .bg(rgb(CARD_BG))
                .border_1()
                .border_color(rgb(BORDER_SUBTLE))
                .text_size(px(12.5))
                .text_color(rgb(TEXT_MUTED))
                .child(card_text(lang, &copy)),
        );
    } else {
        let mut list = div()
            .flex()
            .flex_col()
            .bg(rgb(CARD_BG))
            .border_1()
            .border_color(rgb(BORDER_SUBTLE))
            .rounded(px(8.0))
            .overflow_hidden();
        for (idx, row) in rows.into_iter().enumerate() {
            if idx > 0 {
                list = list.child(div().h(px(1.0)).bg(rgb(BORDER_SUBTLE)));
            }
            list = list.child(log_row(lang, row, idx, cx, on_action));
        }
        section = section.child(list);
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
        let btn = div()
            .id(SharedString::from("cards-load-more"))
            .text_size(px(12.0))
            .font_weight(FontWeight::MEDIUM)
            .text_color(rgb(if enabled { LINK } else { TEXT_DIM }))
            .child(label);
        let row_btn = if enabled {
            btn.cursor_pointer()
                .hover(|s| s.underline())
                .on_click(cx.listener(move |this, _, window, cx| {
                    on_action(this, CardAction::LoadMore, window, cx);
                }))
                .into_any_element()
        } else {
            motion::pulse(btn, SharedString::from("cards-load-more-pulse")).into_any_element()
        };
        section = section.child(div().flex().px(px(2.0)).child(row_btn));
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
        .w(px(240.0))
        .py(px(5.0))
        .px(px(10.0))
        .rounded(px(6.0))
        .bg(rgb(CARD_BG))
        .border_1()
        .border_color(rgb(if focused { LINK } else { BORDER_SUBTLE }))
        .text_size(px(12.5))
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

/// One turn: time, what was asked, then meta and the files it changed.
fn log_row<T: 'static>(
    lang: UiLang,
    row: CardRow,
    index: usize,
    cx: &mut Context<T>,
    on_action: OnCardAction<T>,
) -> impl IntoElement {
    let anim_id = SharedString::from(format!("card-enter:{}", row.card_id));
    let card_id = row.card_id.clone();

    let mut detail = div()
        .flex()
        .flex_wrap()
        .items_center()
        .gap(px(6.0))
        .child(meta_view(row.meta, row.meta_high));
    for (i, chip) in row.files.iter().enumerate() {
        detail = detail.child(file_chip(&row.card_id, i, chip));
    }
    if row.files_more > 0 {
        detail = detail.child(div().text_size(px(12.0)).text_color(rgb(TEXT_MUTED)).child(
            card_text(lang, &CardMsg::FlowMoreFiles { n: row.files_more }),
        ));
    }

    let mut body = div()
        .flex()
        .flex_col()
        .flex_1()
        .min_w_0()
        .gap(px(5.0))
        .child(
            // The truncating title sits in a row with flex_1: placed straight
            // in the column, gpui measures it at min-content and leaves only
            // the ellipsis.
            div().flex().w_full().min_w_0().child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_size(px(13.5))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(rgb(TEXT_DARK))
                    .child(row.title),
            ),
        )
        .child(detail);
    // A subagent's turn hangs off its parent's row with a thin rail.
    if row.indent {
        body = body
            .pl(px(12.0))
            .border_l_1()
            .border_color(rgb(BORDER_LIGHT));
    }

    let el = div()
        .id(SharedString::from(format!("card:{}", row.card_id)))
        // A tab stop, so Tab reaches the turn and Enter opens its modal.
        .tab_index(0)
        .flex()
        .gap(px(12.0))
        .px(px(14.0))
        .py(px(10.0))
        .border_1()
        .border_color(gpui::transparent_black())
        .cursor_pointer()
        .hover(|s| s.bg(rgb(ROW_HOVER_BG)))
        .focus(|s| s.border_color(rgb(LINK)))
        .on_click(cx.listener(move |this, _, window, cx| {
            on_action(this, CardAction::OpenDetail(card_id.clone()), window, cx);
        }))
        .child(
            div()
                .flex_none()
                .w(px(TIME_W))
                .pt(px(2.0))
                .font_family(mono_font())
                .text_size(px(12.0))
                .text_color(rgb(TEXT_MUTED))
                .child(row.time),
        )
        .child(body);
    motion::enter(el, anim_id, index)
}

fn meta_view(meta: String, meta_high: Option<String>) -> Div {
    let container = div()
        .flex_none()
        .text_size(px(12.0))
        .text_color(rgb(TEXT_MUTED));
    match meta_high {
        Some(high) => {
            let sep = " \u{00b7} ";
            let full = format!("{meta}{sep}{high}");
            let start = meta.len() + sep.len();
            let end = full.len();
            let style = HighlightStyle {
                color: Some(rgb(CHIP_HIGH_FG).into()),
                font_weight: Some(FontWeight::SEMIBOLD),
                ..Default::default()
            };
            container.child(StyledText::new(full).with_highlights([(start..end, style)]))
        }
        None => container.child(meta),
    }
}

/// A changed file: its name, `×n` when edited more than once, red with ▲
/// when an edit is important, and blue-tinted when it matches the search.
fn file_chip(card_id: &str, idx: usize, chip: &FileChip) -> Stateful<Div> {
    let mut el = div()
        .id(SharedString::from(format!("card-file:{card_id}:{idx}")))
        .flex()
        .items_center()
        .gap(px(4.0))
        .px(px(6.0))
        .py(px(1.0))
        .rounded(px(4.0))
        .bg(rgb(if chip.matched { MATCH_BG } else { CHIP_BG }))
        .font_family(mono_font())
        .text_size(px(12.0))
        // The darker diff red: plain CHIP_HIGH_FG is 4.2:1 on the chip, this is 5.7:1.
        .text_color(rgb(if chip.high { DIFF_DEL_FG } else { TEXT_BODY }));
    if chip.high {
        el = el.child("\u{25b2}");
    }
    el = el.child(chip.name.clone());
    if chip.edits > 1 {
        el = el.child(
            div()
                .text_color(rgb(TEXT_MUTED))
                .child(format!("\u{00d7}{}", chip.edits)),
        );
    }
    if !chip.tooltip.is_empty() {
        let lines = chip.tooltip.clone();
        el = el.tooltip(move |window, cx| tooltip_view(lines.clone(), window, cx));
    }
    el
}
