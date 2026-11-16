//! Render tree for the "Selesai"/"Done" change cards section and search input.

use gpui::prelude::*;
use gpui::{
    Context, Div, FocusHandle, FontWeight, HighlightStyle, KeyDownEvent, SharedString, Stateful,
    StyledText, Window, div, px, rgb,
};

use crate::cards_model::{BashRow, CardRow, CardsModel, EditRow};
use crate::i18n::{CardMsg, UiLang, card_text};
use crate::search_input::SearchInput;
use crate::ui::motion;
use crate::ui::tooltip::{
    BORDER_LIGHT, BORDER_SUBTLE, CARD_BG, CHIP_HIGH_FG, LINK, MATCH_BG, ROW_HOVER_BG,
    SURFACE_SUBTLE, TEXT_DARK, TEXT_DIM, TEXT_MUTED, card_container, card_header, chip_badge,
    mono_font, path_symbol_text, seq_badge, tooltip_view,
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
        .pt_2()
        .border_t_1()
        .border_color(rgb(BORDER_SUBTLE));

    section = section.child(
        div()
            .mt(px(4.0))
            .mb(px(6.0))
            .mx(px(2.0))
            .text_size(px(11.0))
            .font_weight(FontWeight::SEMIBOLD)
            .text_color(rgb(TEXT_DIM))
            .child(card_text(lang, &CardMsg::SectionDone).to_uppercase()),
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
        let mut list = div().flex().flex_col().gap(px(8.0));
        for (idx, row) in rows.into_iter().enumerate() {
            list = list.child(card_item(row, idx, cx, on_action));
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
        section = section.child(div().flex().mt(px(8.0)).child(row_btn));
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
        .py(px(6.0))
        .px(px(10.0))
        .mb(px(8.0))
        .rounded(px(8.0))
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

fn card_item<T: 'static>(
    row: CardRow,
    index: usize,
    cx: &mut Context<T>,
    on_action: OnCardAction<T>,
) -> impl IntoElement {
    let anim_id = SharedString::from(format!("card-enter:{}", row.card_id));
    let card_id = row.card_id.clone();
    let mut card = card_container()
        .id(SharedString::from(format!("card:{}", row.card_id)))
        // A tab stop, so Tab reaches the card and Enter opens its modal.
        .tab_index(0)
        .cursor_pointer()
        .hover(|s| s.border_color(rgb(BORDER_LIGHT)).shadow_sm())
        .focus(|s| s.border_color(rgb(LINK)))
        .on_click(cx.listener(move |this, _, window, cx| {
            on_action(this, CardAction::OpenDetail(card_id.clone()), window, cx);
        }));

    card = card.child(
        card_header()
            .child(
                div()
                    .flex()
                    .justify_between()
                    .items_start()
                    .gap(px(10.0))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_size(px(14.0))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(rgb(TEXT_DARK))
                            .child(row.title),
                    )
                    .child(
                        div()
                            .pt(px(2.0))
                            .text_size(px(12.0))
                            .text_color(rgb(TEXT_DIM))
                            .whitespace_nowrap()
                            .flex_shrink_0()
                            .child(row.time),
                    ),
            )
            .child(card_meta_view(row.meta, row.meta_high)),
    );

    for (idx, edit) in row.edits.iter().enumerate() {
        card = card.child(edit_row_view(&row.card_id, idx, edit));
    }

    if let Some(more) = row.more {
        card = card.child(
            div()
                .border_t_1()
                .border_color(rgb(BORDER_SUBTLE))
                .pt(px(6.0))
                .px(px(12.0))
                .pb(px(8.0))
                .text_size(px(12.0))
                .font_weight(FontWeight::MEDIUM)
                .text_color(rgb(LINK))
                .truncate()
                .child(more),
        );
    }

    let wrapper = if row.indent {
        div()
            .pl(px(12.0))
            .border_l_2()
            .border_color(rgb(BORDER_SUBTLE))
            .child(card)
    } else {
        div().child(card)
    };
    motion::enter(wrapper, anim_id, index)
}

fn card_meta_view(meta: String, meta_high: Option<String>) -> Div {
    let container = div()
        .min_w_0()
        .truncate()
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

fn edit_row_view(card_id: &str, idx: usize, edit: &EditRow) -> Stateful<Div> {
    let mut row = div()
        .id(SharedString::from(format!(
            "card-edit:{}:{}:{idx}",
            card_id, edit.seq
        )))
        .flex()
        .items_center()
        .gap(px(6.0))
        .w_full()
        .py(px(5.0))
        .px(px(12.0))
        .border_t_1()
        .border_color(rgb(BORDER_SUBTLE));

    if edit.matched {
        row = row.bg(rgb(MATCH_BG));
    } else {
        row = row.hover(|s| s.bg(rgb(ROW_HOVER_BG)));
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
    path_symbol_text(&edit.file, edit.symbol.as_deref())
        .flex_1()
        .truncate()
}

fn bash_left(bash: &BashRow) -> Div {
    let mut left = div()
        .flex()
        .flex_1()
        .min_w_0()
        .items_center()
        .gap_1()
        .overflow_hidden()
        .text_size(px(12.5));
    left = left.child(
        div()
            .text_color(rgb(TEXT_MUTED))
            .whitespace_nowrap()
            .flex_shrink_0()
            .child(bash.before.clone()),
    );
    left = left.child(
        div()
            .min_w_0()
            .truncate()
            .font_family(mono_font())
            .bg(rgb(SURFACE_SUBTLE))
            .px(px(4.0))
            .rounded(px(4.0))
            .text_color(rgb(TEXT_DARK))
            .child(bash.cmd.clone()),
    );
    if !bash.after.is_empty() {
        left = left.child(
            div()
                .text_color(rgb(TEXT_MUTED))
                .whitespace_nowrap()
                .child(bash.after.clone()),
        );
    }
    if let Some(uncertain) = &bash.uncertain {
        left = left.child(
            div()
                .text_color(rgb(TEXT_DIM))
                .whitespace_nowrap()
                .child(uncertain.clone()),
        );
    }
    left
}
