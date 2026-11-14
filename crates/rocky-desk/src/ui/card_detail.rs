//! Render tree for change card detail, quote groups, snippets, and execution timeline.

use gpui::prelude::*;
use gpui::{Context, Div, FontWeight, SharedString, div, px, rgb};
use rocky_proto::cards::FlowKind;

use crate::card_detail_model::{
    BlockView, CodeLine, DetailModel, DetailState, DetailView, QuoteGroup, Step,
};
use crate::i18n::{CardMsg, UiLang, card_text};
use crate::ui::cards_view::{CardAction, OnCardAction};
use crate::ui::tooltip::{
    BORDER_LIGHT, BORDER_SUBTLE, CARD_BG, DIFF_ADD_BG, DIFF_ADD_FG, DIFF_DEL_BG, DIFF_DEL_FG,
    TEXT_DARK, TEXT_DIM, TEXT_MUTED, back_button, chip_badge, mono_font,
};

const CODE_BG: u32 = 0xF8F8F7;
const LINK_COLOR: u32 = 0x2B7DD9;
const OK_COLOR: u32 = 0x2BA044;
const ERR_COLOR: u32 = 0xD92B2B;

/// Renders the full detail screen for an opened change card.
pub fn card_detail_view<T: 'static>(
    lang: UiLang,
    detail: Option<&DetailModel>,
    cx: &mut Context<T>,
    on_action: OnCardAction<T>,
) -> Div {
    let mut out = div().flex().flex_col().gap_3();

    out = out.child(back_button(
        "detail-back",
        card_text(lang, &CardMsg::BackDone),
        move |this, window, cx| on_action(this, CardAction::BackFromDetail, window, cx),
        cx,
    ));

    match detail.map(DetailModel::state) {
        None | Some(DetailState::Loading) => {
            out = out.child(
                div()
                    .text_sm()
                    .text_color(rgb(TEXT_DIM))
                    .child(card_text(lang, &CardMsg::Loading)),
            );
        }
        Some(DetailState::NotFound) => {
            out = out.child(
                div()
                    .text_sm()
                    .text_color(rgb(TEXT_MUTED))
                    .child(card_text(lang, &CardMsg::CardNotFound)),
            );
        }
        Some(DetailState::Ready(view)) => {
            out = out.child(ready_body(lang, view, cx, on_action));
        }
    }

    out
}

fn ready_body<T: 'static>(
    lang: UiLang,
    view: &DetailView,
    cx: &mut Context<T>,
    on_action: OnCardAction<T>,
) -> Div {
    let mut body = div().flex().flex_col().gap_3();

    body = body.child(
        div()
            .flex()
            .flex_col()
            .gap_1()
            .child(
                div()
                    .text_xs()
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(rgb(TEXT_MUTED))
                    .child(card_text(lang, &CardMsg::YouAsked)),
            )
            .child(
                div()
                    .text_sm()
                    .text_color(rgb(TEXT_DARK))
                    .child(view.prompt.clone()),
            )
            .child(
                div()
                    .text_xs()
                    .text_color(rgb(TEXT_MUTED))
                    .child(view.meta.clone()),
            ),
    );

    for group in &view.groups {
        body = body.child(quote_group_view(lang, group, cx, on_action));
    }

    if !view.timeline.is_empty() || view.timeline_more.is_some() {
        body = body.child(timeline_section(
            lang,
            &view.timeline,
            view.timeline_more.as_deref(),
        ));
    }

    let mut foot = div()
        .flex()
        .flex_col()
        .gap_1()
        .pt_1()
        .border_t_1()
        .border_color(rgb(BORDER_SUBTLE))
        .text_xs()
        .text_color(rgb(TEXT_MUTED))
        .child(view.coverage.clone());
    if let Some(outside) = &view.outside {
        foot = foot.child(outside.clone());
    }
    body = body.child(foot);

    body
}

fn quote_group_view<T: 'static>(
    lang: UiLang,
    group: &QuoteGroup,
    cx: &mut Context<T>,
    on_action: OnCardAction<T>,
) -> Div {
    let mut out = div().flex().flex_col().gap_2();
    let (quote_line, is_dim) = group.quote_line(lang);
    let quote = if is_dim {
        div()
            .text_xs()
            .italic()
            .text_color(rgb(TEXT_DIM))
            .child(quote_line)
    } else {
        div()
            .border_l_2()
            .border_color(rgb(BORDER_LIGHT))
            .pl_2()
            .text_sm()
            .text_color(rgb(TEXT_DARK))
            .child(quote_line)
    };
    out = out.child(quote);

    for block in &group.blocks {
        out = out.child(block_view(lang, block, cx, on_action));
    }
    out
}

fn block_view<T: 'static>(
    lang: UiLang,
    block: &BlockView,
    cx: &mut Context<T>,
    on_action: OnCardAction<T>,
) -> Div {
    let mut card = div()
        .flex()
        .flex_col()
        .gap_1()
        .p_2()
        .rounded_sm()
        .bg(rgb(CARD_BG))
        .border_1()
        .border_color(rgb(BORDER_SUBTLE));

    let mut header = div().flex().flex_wrap().items_center().gap_1().child(
        div()
            .text_xs()
            .font_family(mono_font())
            .font_weight(FontWeight::SEMIBOLD)
            .text_color(rgb(TEXT_DARK))
            .child(block.head.clone()),
    );
    for (chip, high) in &block.chips {
        header = header.child(chip_badge(chip.clone(), *high));
    }
    card = card.child(header);

    if !block.code.is_empty() {
        let mut snippet = div()
            .flex()
            .flex_col()
            .p_1()
            .rounded_sm()
            .bg(rgb(CODE_BG))
            .border_1()
            .border_color(rgb(BORDER_SUBTLE))
            .font_family(mono_font())
            .text_xs();
        for line in &block.code {
            snippet = snippet.child(snippet_line_view(line));
        }
        card = card.child(snippet);
    }

    if block.diffable {
        let seq = block.seq;
        card = card.child(
            div().flex().child(
                div()
                    .id(SharedString::from(format!("diff-link:{seq}")))
                    .text_xs()
                    .text_color(rgb(LINK_COLOR))
                    .cursor_pointer()
                    .child(card_text(lang, &CardMsg::ViewFullDiff))
                    .on_click(cx.listener(move |this, _, window, cx| {
                        on_action(this, CardAction::OpenDiff(seq), window, cx);
                    })),
            ),
        );
    }

    card
}

fn snippet_line_view(line: &CodeLine) -> Div {
    match line {
        CodeLine::Added(text) => div()
            .w_full()
            .px_1()
            .bg(rgb(DIFF_ADD_BG))
            .text_color(rgb(DIFF_ADD_FG))
            .child(text.clone()),
        CodeLine::Removed(text) => div()
            .w_full()
            .px_1()
            .bg(rgb(DIFF_DEL_BG))
            .text_color(rgb(DIFF_DEL_FG))
            .child(text.clone()),
        CodeLine::Context(text) => div()
            .w_full()
            .px_1()
            .text_color(rgb(TEXT_MUTED))
            .child(text.clone()),
        CodeLine::Fold(text) => div()
            .w_full()
            .px_1()
            .italic()
            .text_color(rgb(TEXT_DIM))
            .child(text.clone()),
    }
}

fn timeline_section(lang: UiLang, steps: &[Step], more: Option<&str>) -> Div {
    let mut wrap = div().flex().flex_col().gap_1();
    wrap = wrap.child(
        div()
            .text_xs()
            .font_weight(FontWeight::SEMIBOLD)
            .text_color(rgb(TEXT_MUTED))
            .child(card_text(lang, &CardMsg::TimelineHeading)),
    );

    let mut box_div = div()
        .flex()
        .flex_col()
        .p_2()
        .rounded_sm()
        .bg(rgb(CARD_BG))
        .border_1()
        .border_color(rgb(BORDER_SUBTLE));

    let last_idx = steps.len().saturating_sub(1);
    for (idx, step) in steps.iter().enumerate() {
        let has_line = idx < last_idx || more.is_some();
        box_div = box_div.child(timeline_step_row(step, has_line));
    }

    if let Some(more_text) = more {
        box_div = box_div.child(
            div()
                .flex()
                .items_center()
                .gap_2()
                .child(
                    div()
                        .w(px(14.0))
                        .flex()
                        .justify_center()
                        .text_xs()
                        .text_color(rgb(TEXT_DIM))
                        .child("\u{2022}"),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(rgb(TEXT_DIM))
                        .child(more_text.to_string()),
                ),
        );
    }

    wrap.child(box_div)
}

fn timeline_step_row(step: &Step, has_line_below: bool) -> Div {
    let (mark, mark_color) = if step.ok {
        ("\u{2713}", OK_COLOR)
    } else {
        ("\u{2717}", ERR_COLOR)
    };

    let mut rail = div().w(px(14.0)).flex().flex_col().items_center().child(
        div()
            .text_xs()
            .font_weight(FontWeight::BOLD)
            .text_color(rgb(mark_color))
            .child(mark),
    );
    if has_line_below {
        rail = rail.child(div().w(px(1.0)).flex_1().bg(rgb(BORDER_LIGHT)));
    }

    let mut title = div()
        .flex_1()
        .min_w_0()
        .truncate()
        .text_xs()
        .text_color(rgb(TEXT_DARK))
        .child(step.title.clone());
    if step.kind == FlowKind::Cmd {
        title = title.font_family(mono_font());
    }

    let mut content = div().flex().flex_col().flex_1().min_w_0().pb_2().child(
        div()
            .flex()
            .justify_between()
            .items_center()
            .gap_2()
            .child(title)
            .child(
                div()
                    .text_xs()
                    .font_family(mono_font())
                    .text_color(rgb(TEXT_DIM))
                    .whitespace_nowrap()
                    .flex_shrink_0()
                    .child(step.dur.clone()),
            ),
    );

    for (sub_label, fact) in &step.subs {
        let mut sub = div()
            .flex()
            .justify_between()
            .items_center()
            .gap_2()
            .pl_2()
            .child(
                div()
                    .flex()
                    .flex_1()
                    .min_w_0()
                    .items_center()
                    .gap_1()
                    .child(div().text_xs().text_color(rgb(TEXT_DIM)).child("\u{2022}"))
                    .child(
                        div()
                            .min_w_0()
                            .truncate()
                            .text_xs()
                            .text_color(rgb(TEXT_MUTED))
                            .child(sub_label.clone()),
                    ),
            );
        if !fact.is_empty() {
            sub = sub.child(
                div()
                    .text_xs()
                    .font_family(mono_font())
                    .text_color(rgb(TEXT_DIM))
                    .whitespace_nowrap()
                    .flex_shrink_0()
                    .child(fact.clone()),
            );
        }
        content = content.child(sub);
    }

    div().flex().gap_2().child(rail).child(content)
}
