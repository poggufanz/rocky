//! Render tree for the paged unified diff view of a change block.

use gpui::prelude::*;
use gpui::{Context, Div, SharedString, Stateful, div, rgb};
use rocky_proto::pipe::{DiffLine, DiffLineKind};

use crate::card_detail_model::{DetailModel, DetailState, DiffModel, DiffState};
use crate::i18n::{CardMsg, UiLang, card_text};
use crate::ui::cards_view::{CardAction, OnCardAction};
use crate::ui::tooltip::{
    BORDER_SUBTLE, CARD_BG, DIFF_ADD_BG, DIFF_ADD_FG, DIFF_DEL_BG, DIFF_DEL_FG, TEXT_DARK,
    TEXT_DIM, TEXT_MUTED, back_button, mono_font,
};

const BTN_ACTIVE_BG: u32 = 0xD4D4D4;
const BTN_DISABLED_BG: u32 = 0xEDEDEC;

/// Renders the paged unified diff view and navigation header.
pub fn block_diff_view<T: 'static>(
    lang: UiLang,
    detail: Option<&DetailModel>,
    diff: Option<&DiffModel>,
    cx: &mut Context<T>,
    on_action: OnCardAction<T>,
) -> Div {
    let mut out = div().flex().flex_col().gap_2();

    let back_label = block_back_label(detail, diff);
    let mut header = div().flex().justify_between().items_center().gap_2().child(
        div().min_w_0().flex_1().child(back_button(
            "diff-back",
            back_label,
            move |this, window, cx| on_action(this, CardAction::BackFromDiff, window, cx),
            cx,
        )),
    );

    if let Some(DiffState::Page { page, pages, .. }) = diff.map(DiffModel::state) {
        header = header.child(pager(*page, *pages, lang, cx, on_action));
    }
    out = out.child(header);

    match diff.map(DiffModel::state) {
        None | Some(DiffState::Loading) => {
            out = out.child(
                div()
                    .text_sm()
                    .text_color(rgb(TEXT_DIM))
                    .child(card_text(lang, &CardMsg::Loading)),
            );
        }
        Some(DiffState::Missing) => {
            out = out.child(
                div()
                    .text_sm()
                    .text_color(rgb(TEXT_MUTED))
                    .child(card_text(lang, &CardMsg::DiffNotStored)),
            );
        }
        Some(DiffState::NotFound) => {
            out = out.child(
                div()
                    .text_sm()
                    .text_color(rgb(TEXT_MUTED))
                    .child(card_text(lang, &CardMsg::CardNotFound)),
            );
        }
        Some(DiffState::Page { lines, .. }) => {
            let mut body = div()
                .flex()
                .flex_col()
                .p_2()
                .rounded_sm()
                .bg(rgb(CARD_BG))
                .border_1()
                .border_color(rgb(BORDER_SUBTLE))
                .font_family(mono_font())
                .text_xs();
            for line in lines {
                body = body.child(diff_line_view(line));
            }
            out = out.child(body);
        }
    }

    out
}

fn block_back_label(detail: Option<&DetailModel>, diff: Option<&DiffModel>) -> String {
    let seq = diff.map(DiffModel::seq);
    if let (Some(detail), Some(seq)) = (detail, seq)
        && let DetailState::Ready(view) = detail.state()
        && let Some(head) = view
            .groups
            .iter()
            .flat_map(|g| g.blocks.iter())
            .find(|b| b.seq == seq)
            .map(|b| b.head.as_str())
    {
        return format!("\u{2039} {head}");
    }
    "\u{2039}".to_string()
}

fn pager<T: 'static>(
    page: u32,
    pages: u32,
    lang: UiLang,
    cx: &mut Context<T>,
    on_action: OnCardAction<T>,
) -> Div {
    let can_prev = page > 0;
    let can_next = page.saturating_add(1) < pages;
    let label = card_text(
        lang,
        &CardMsg::DiffPage {
            page: page.saturating_add(1),
            total: pages.max(1),
        },
    );

    let prev = page_arrow(
        "diff-prev",
        "\u{2039}",
        can_prev,
        page.saturating_sub(1),
        cx,
        on_action,
    );
    let next = page_arrow(
        "diff-next",
        "\u{203a}",
        can_next,
        page.saturating_add(1),
        cx,
        on_action,
    );

    div()
        .flex()
        .items_center()
        .gap_1()
        .flex_shrink_0()
        .child(prev)
        .child(
            div()
                .text_xs()
                .font_family(mono_font())
                .text_color(rgb(TEXT_MUTED))
                .whitespace_nowrap()
                .child(label),
        )
        .child(next)
}

fn page_arrow<T: 'static>(
    id: &'static str,
    symbol: &'static str,
    enabled: bool,
    target_page: u32,
    cx: &mut Context<T>,
    on_action: OnCardAction<T>,
) -> Stateful<Div> {
    let mut btn = div()
        .id(SharedString::from(id))
        .px_2()
        .py_0p5()
        .rounded_sm()
        .text_xs()
        .text_color(rgb(if enabled { TEXT_DARK } else { TEXT_DIM }))
        .bg(rgb(if enabled {
            BTN_ACTIVE_BG
        } else {
            BTN_DISABLED_BG
        }))
        .child(symbol);
    if enabled {
        btn = btn
            .cursor_pointer()
            .on_click(cx.listener(move |this, _, window, cx| {
                on_action(this, CardAction::DiffPage(target_page), window, cx);
            }));
    }
    btn
}

fn diff_line_view(line: &DiffLine) -> Div {
    match line.kind {
        DiffLineKind::Added => div()
            .w_full()
            .px_1()
            .bg(rgb(DIFF_ADD_BG))
            .text_color(rgb(DIFF_ADD_FG))
            .child(line.text.clone()),
        DiffLineKind::Removed => div()
            .w_full()
            .px_1()
            .bg(rgb(DIFF_DEL_BG))
            .text_color(rgb(DIFF_DEL_FG))
            .child(line.text.clone()),
        DiffLineKind::Context => div()
            .w_full()
            .px_1()
            .text_color(rgb(TEXT_MUTED))
            .child(line.text.clone()),
    }
}
