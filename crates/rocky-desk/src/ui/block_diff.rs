//! Render tree for the paged unified diff view of a change block.

use gpui::prelude::*;
use gpui::{Context, Div, FontWeight, SharedString, Stateful, div, px, rgb};
use rocky_proto::pipe::{DiffLine, DiffLineKind};

use crate::card_detail_model::{BlockView, DetailModel, DetailState, DiffModel, DiffState};
use crate::i18n::{CardMsg, UiLang, card_text};
use crate::ui::cards_view::{CardAction, OnCardAction};
use crate::ui::motion;
use crate::ui::tooltip::{
    BORDER_SUBTLE, DiffLineTone, LINK, ROW_HOVER_BG, TEXT_DIM, TEXT_MUTED, back_button,
    card_container, card_header, code_block_container, diff_code_line, path_symbol_text,
};

/// Renders the paged unified diff view inside a change card shell.
pub fn block_diff_view<T: 'static>(
    lang: UiLang,
    detail: Option<&DetailModel>,
    diff: Option<&DiffModel>,
    cx: &mut Context<T>,
    on_action: OnCardAction<T>,
) -> impl IntoElement {
    let (card_id, seq, page) = diff
        .map(|d| (d.card_id(), d.seq(), d.page()))
        .unwrap_or(("none", 0, 0));
    let mut out = div().flex().flex_col().gap_2();

    out = out.child(back_button(
        "diff-back",
        card_text(lang, &CardMsg::BackDone),
        move |this, window, cx| on_action(this, CardAction::BackFromDiff, window, cx),
        cx,
    ));

    match diff.map(DiffModel::state) {
        None | Some(DiffState::Loading) => {
            let loading = div()
                .text_sm()
                .text_color(rgb(TEXT_DIM))
                .child(card_text(lang, &CardMsg::Loading));
            out = out.child(motion::pulse(
                loading,
                SharedString::from(format!("diff-loading:{card_id}:{seq}:{page}")),
            ));
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
        Some(DiffState::Page { lines, page, pages }) => {
            out = out.child(diff_card(
                detail, diff, lines, *page, *pages, lang, cx, on_action,
            ));
        }
    }

    motion::slide_from_right(
        out,
        SharedString::from(format!("diff:{card_id}:{seq}:{page}")),
    )
}

#[allow(clippy::too_many_arguments)]
fn diff_card<T: 'static>(
    detail: Option<&DetailModel>,
    diff: Option<&DiffModel>,
    lines: &[DiffLine],
    page: u32,
    pages: u32,
    lang: UiLang,
    cx: &mut Context<T>,
    on_action: OnCardAction<T>,
) -> Div {
    let mut card = card_container();

    let block = find_block(detail, diff);
    if let Some(block) = block {
        card = card.child(
            card_header()
                .child(path_symbol_text(&block.path, block.symbol.as_deref()).max_w_full()),
        );
    }

    let mut code = code_block_container();
    if block.is_some() {
        code = code.border_t_1().border_color(rgb(BORDER_SUBTLE));
    }
    for line in lines {
        code = code.child(diff_line_view(line));
    }
    card = card.child(code);

    card.child(
        div()
            .flex()
            .justify_end()
            .items_center()
            .border_t_1()
            .border_color(rgb(BORDER_SUBTLE))
            .py(px(8.0))
            .px(px(12.0))
            .child(pager(page, pages, lang, cx, on_action)),
    )
}

fn find_block<'a>(
    detail: Option<&'a DetailModel>,
    diff: Option<&DiffModel>,
) -> Option<&'a BlockView> {
    let seq = diff.map(DiffModel::seq)?;
    let DetailState::Ready(view) = detail?.state() else {
        return None;
    };
    view.groups
        .iter()
        .flat_map(|g| g.blocks.iter())
        .find(|b| b.seq == seq)
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
                .text_size(px(12.0))
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
        .px(px(6.0))
        .py(px(2.0))
        .rounded(px(4.0))
        .text_size(px(12.0))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(rgb(if enabled { LINK } else { TEXT_DIM }))
        .child(symbol);
    if enabled {
        btn = btn
            .cursor_pointer()
            .hover(|s| s.bg(rgb(ROW_HOVER_BG)))
            .on_click(cx.listener(move |this, _, window, cx| {
                on_action(this, CardAction::DiffPage(target_page), window, cx);
            }));
    }
    btn
}

fn diff_line_view(line: &DiffLine) -> Div {
    let tone = match line.kind {
        DiffLineKind::Added => DiffLineTone::Added,
        DiffLineKind::Removed => DiffLineTone::Removed,
        DiffLineKind::Context => DiffLineTone::Context,
    };
    diff_code_line(tone, line.text.clone())
}
