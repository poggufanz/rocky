//! Render tree for change card detail, including execution timeline and earlier attempts.

use gpui::prelude::*;
use gpui::{Context, Div, FontWeight, SharedString, div, px, relative, rgb};

use crate::card_detail_model::{
    BlockView, CodeLine, DetailModel, DetailState, DetailView, QuoteDisplay, QuoteGroup,
    RelatedRow, Step,
};
use crate::i18n::{CardMsg, UiLang, card_text};
use crate::ui::cards_view::{CardAction, OnCardAction};
use crate::ui::motion;
use crate::ui::tooltip::{
    BORDER_LIGHT, BORDER_SUBTLE, CARD_BG, DIFF_DEL_FG, DiffLineTone, LINK, OK, TEXT_DARK, TEXT_DIM,
    TEXT_MUTED, card_container, card_header, chip_badge, code_block_container, diff_code_line,
    mono_font, path_symbol_text, seq_badge,
};

/// Renders the full detail screen for an opened change card.
pub fn card_detail_view<T: 'static>(
    lang: UiLang,
    detail: Option<&DetailModel>,
    cx: &mut Context<T>,
    on_action: OnCardAction<T>,
) -> impl IntoElement {
    // Shown inside the card modal, which owns closing; no back control here.
    let card_id = detail.map(DetailModel::card_id).unwrap_or("none");
    let mut out = div().flex().flex_col().gap_2();

    match detail.map(|d| (d, d.state())) {
        None | Some((_, DetailState::Loading)) => {
            let loading = div()
                .text_sm()
                .text_color(rgb(TEXT_DIM))
                .child(card_text(lang, &CardMsg::Loading));
            out = out.child(motion::pulse(
                loading,
                SharedString::from(format!("detail-loading:{card_id}")),
            ));
        }
        Some((_, DetailState::NotFound)) => {
            out = out.child(
                div()
                    .text_sm()
                    .text_color(rgb(TEXT_MUTED))
                    .child(card_text(lang, &CardMsg::CardNotFound)),
            );
        }
        Some((detail, DetailState::Ready(view))) => {
            out = out.child(ready_card(lang, detail, view, cx, on_action));
        }
    }

    out
}

fn ready_card<T: 'static>(
    lang: UiLang,
    detail: &DetailModel,
    view: &DetailView,
    cx: &mut Context<T>,
    on_action: OnCardAction<T>,
) -> Div {
    let card_id = detail.card_id();
    let prompt_line = div().text_size(px(14.0));
    let prompt_line = if view.prompt_is_notice {
        prompt_line
            .font_weight(FontWeight::NORMAL)
            .italic()
            .text_color(rgb(TEXT_DIM))
    } else {
        prompt_line
            .font_weight(FontWeight::SEMIBOLD)
            .text_color(rgb(TEXT_DARK))
    }
    .child(view.prompt.clone());

    let mut card = card_container().child(
        card_header()
            .child(small_label(card_text(lang, &CardMsg::YouAsked)))
            .child(prompt_line)
            .child(
                div()
                    .text_size(px(12.0))
                    .text_color(rgb(TEXT_MUTED))
                    .child(view.meta.clone()),
            ),
    );

    for (idx, group) in view.groups.iter().enumerate() {
        let display = detail.quote_display(group, lang);
        card = card.child(quote_group_view(lang, idx, display, group, cx, on_action));
    }

    if view.sequence_line.is_some() || !view.timeline.is_empty() || view.timeline_more.is_some() {
        card = card.child(timeline_section(
            lang,
            card_id,
            view.sequence_line.as_deref(),
            &view.timeline,
            view.timeline_more.as_deref(),
        ));
    }

    let related = detail.related_rows(lang);
    if !related.is_empty() {
        card = card.child(related_section(lang, card_id, &related));
    }

    let mut foot = div()
        .flex()
        .justify_between()
        .items_start()
        .gap_2()
        .border_t_1()
        .border_color(rgb(BORDER_SUBTLE))
        .py(px(8.0))
        .px(px(12.0))
        .text_size(px(12.0))
        .text_color(rgb(TEXT_MUTED))
        .child(div().flex_1().min_w_0().child(view.coverage.clone()));
    if let Some(outside) = &view.outside {
        foot = foot.child(div().flex_shrink_0().text_right().child(outside.clone()));
    }
    card.child(foot)
}

fn small_label(text: String) -> Div {
    div()
        .text_size(px(10.5))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(rgb(TEXT_DIM))
        .child(text.to_uppercase())
}

fn quote_group_view<T: 'static>(
    lang: UiLang,
    idx: usize,
    display: QuoteDisplay,
    group: &QuoteGroup,
    cx: &mut Context<T>,
    on_action: OnCardAction<T>,
) -> Div {
    let mut out = div()
        .flex()
        .flex_col()
        .gap(px(6.0))
        .border_t_1()
        .border_color(rgb(BORDER_SUBTLE))
        .pt(px(9.0))
        .px(px(12.0))
        .pb(px(10.0));

    let mut quote = div()
        .flex()
        .flex_col()
        .ml(px(24.0))
        .border_l_2()
        .border_color(rgb(TEXT_DIM))
        .pl(px(8.0));
    let show_label = !display.is_dim || display.translated_from.is_some() || display.translating;
    if show_label {
        quote = quote
            .gap(px(1.0))
            .child(quote_label_row(lang, idx, &display, cx, on_action));
    }
    let text_div = div()
        .text_size(px(12.5))
        .line_height(relative(1.45))
        .child(display.text);
    let text_div = if display.is_dim {
        text_div.italic().text_color(rgb(TEXT_DIM))
    } else {
        text_div.text_color(rgb(TEXT_DARK))
    };
    quote = quote.child(text_div);
    out = out.child(quote);

    if !group.blocks.is_empty() {
        let mut blocks = div().flex().flex_col().gap(px(10.0));
        for block in &group.blocks {
            blocks = blocks.child(block_view(lang, block, cx, on_action));
        }
        out = out.child(blocks);
    }
    out
}

fn quote_label_row<T: 'static>(
    lang: UiLang,
    idx: usize,
    display: &QuoteDisplay,
    cx: &mut Context<T>,
    on_action: OnCardAction<T>,
) -> Div {
    let label = small_label(card_text(lang, &CardMsg::AgentSaid));
    if let Some(from) = display.translated_from {
        let mut row = div()
            .flex()
            .flex_wrap()
            .items_baseline()
            .gap(px(5.0))
            .child(label)
            .child(
                div()
                    .text_size(px(11.0))
                    .text_color(rgb(TEXT_MUTED))
                    .child(format!(
                        "\u{00b7} {}",
                        card_text(lang, &CardMsg::TranslatedFrom { from })
                    )),
            );
        if let Some(key) = display.key.clone() {
            let link_msg = if display.showing_original {
                &CardMsg::ShowTranslation
            } else {
                &CardMsg::ShowOriginal
            };
            row = row.child(
                div()
                    .id(SharedString::from(format!("quote-toggle:{idx}")))
                    .text_size(px(11.0))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(rgb(LINK))
                    .cursor_pointer()
                    .hover(|s| s.underline())
                    .child(card_text(lang, link_msg))
                    .on_click(cx.listener(move |this, _, window, cx| {
                        on_action(this, CardAction::ToggleOriginal(key.clone()), window, cx);
                    })),
            );
        }
        row
    } else if display.translating {
        div()
            .flex()
            .flex_wrap()
            .items_baseline()
            .gap(px(5.0))
            .child(label)
            .child(
                div()
                    .text_size(px(11.0))
                    .text_color(rgb(TEXT_DIM))
                    .child(format!(
                        "\u{00b7} {}",
                        card_text(lang, &CardMsg::Translating)
                    )),
            )
    } else {
        label
    }
}

fn block_view<T: 'static>(
    lang: UiLang,
    block: &BlockView,
    cx: &mut Context<T>,
    on_action: OnCardAction<T>,
) -> Div {
    let mut out = div().flex().flex_col().gap(px(6.0));

    let mut head_right = div()
        .flex()
        .flex_1()
        .min_w_0()
        .flex_wrap()
        .items_center()
        .gap(px(6.0))
        .child(path_symbol_text(&block.path, block.symbol.as_deref()).max_w_full());
    for (chip, high) in &block.chips {
        head_right = head_right.child(chip_badge(chip.clone(), *high));
    }

    out = out.child(
        div()
            .flex()
            .items_start()
            .gap(px(6.0))
            .child(seq_badge(block.seq).pt(px(2.0)))
            .child(head_right),
    );

    if !block.code.is_empty() {
        let mut snippet = code_block_container().ml(px(24.0)).rounded(px(6.0));
        for line in &block.code {
            snippet = snippet.child(snippet_line_view(line));
        }
        out = out.child(snippet);
    }

    if block.diffable {
        let seq = block.seq;
        out = out.child(
            div().flex().justify_end().child(
                div()
                    .id(SharedString::from(format!("diff-link:{seq}")))
                    .text_size(px(12.0))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(rgb(LINK))
                    .cursor_pointer()
                    .hover(|s| s.underline())
                    .child(card_text(lang, &CardMsg::ViewFullDiff))
                    .on_click(cx.listener(move |this, _, window, cx| {
                        on_action(this, CardAction::OpenDiff(seq), window, cx);
                    })),
            ),
        );
    }

    out
}

fn snippet_line_view(line: &CodeLine) -> Div {
    let (tone, text) = match line {
        CodeLine::Added(text) => (DiffLineTone::Added, text.clone()),
        CodeLine::Removed(text) => (DiffLineTone::Removed, text.clone()),
        CodeLine::Context(text) => (DiffLineTone::Context, text.clone()),
        CodeLine::Fold(text) => (DiffLineTone::Fold, text.clone()),
    };
    // Clip, never `.truncate()`: gpui 0.2.2 caches a nowrap text's first
    // measurement, so a line first measured narrow stays "…" at full width.
    diff_code_line(tone, text)
        .min_w_0()
        .overflow_hidden()
        .whitespace_nowrap()
}

fn timeline_section(
    lang: UiLang,
    card_id: &str,
    sequence_line: Option<&str>,
    steps: &[Step],
    more: Option<&str>,
) -> Div {
    let mut section = div()
        .flex()
        .flex_col()
        .border_t_1()
        .border_color(rgb(BORDER_SUBTLE))
        .pt(px(8.0))
        .px(px(12.0))
        .pb(px(10.0));

    section = section.child(
        div()
            .mb(px(6.0))
            .text_size(px(11.0))
            .font_weight(FontWeight::SEMIBOLD)
            .text_color(rgb(TEXT_DIM))
            .child(card_text(lang, &CardMsg::TimelineHeading).to_uppercase()),
    );

    if let Some(line) = sequence_line {
        section = section.child(
            div()
                .mb(px(6.0))
                .min_w_0()
                .text_size(px(12.0))
                .font_family(mono_font())
                .text_color(rgb(TEXT_DARK))
                .child(line.to_string()),
        );
    }

    let last_idx = steps.len().saturating_sub(1);
    for (idx, step) in steps.iter().enumerate() {
        let has_line = idx < last_idx || more.is_some();
        section = section.child(motion::timeline_enter(
            timeline_step_row(step, has_line),
            SharedString::from(format!("timeline-step:{card_id}:{idx}")),
            idx,
        ));
    }

    if let Some(more_text) = more {
        let more_row = div()
            .flex()
            .items_center()
            .gap_2()
            .child(
                div()
                    .w(px(16.0))
                    .flex_shrink_0()
                    .flex()
                    .justify_center()
                    .items_center()
                    .child(div().w(px(4.0)).h(px(4.0)).rounded_full().bg(rgb(TEXT_DIM))),
            )
            .child(
                div()
                    .text_size(px(12.0))
                    .text_color(rgb(TEXT_DIM))
                    .child(more_text.to_string()),
            );
        section = section.child(motion::timeline_enter(
            more_row,
            SharedString::from(format!("timeline-more:{card_id}")),
            steps.len(),
        ));
    }

    section
}

fn related_section(lang: UiLang, card_id: &str, rows: &[RelatedRow]) -> Div {
    let mut section = div()
        .flex()
        .flex_col()
        .gap_1()
        .border_t_1()
        .border_color(rgb(BORDER_SUBTLE))
        .pt(px(8.0))
        .px(px(12.0))
        .pb(px(10.0))
        .child(
            div()
                .mb(px(4.0))
                .text_size(px(11.0))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(rgb(TEXT_DIM))
                .child(card_text(lang, &CardMsg::RelatedHeading).to_uppercase()),
        );
    for (idx, row) in rows.iter().enumerate() {
        let mut line = div()
            .flex()
            .gap_2()
            .min_w_0()
            .text_size(px(12.0))
            .font_family(mono_font())
            .child(
                div()
                    .flex_shrink_0()
                    .text_color(rgb(TEXT_MUTED))
                    .child(row.date.clone()),
            )
            .child(
                div()
                    .flex_shrink_0()
                    .text_color(rgb(TEXT_DARK))
                    .child(row.outcome.clone()),
            );
        if let Some(files) = &row.files {
            line = line.child(
                div()
                    .min_w_0()
                    .truncate()
                    .text_color(rgb(TEXT_DIM))
                    .child(files.clone()),
            );
        }
        section = section.child(motion::timeline_enter(
            line,
            SharedString::from(format!("related-row:{card_id}:{idx}")),
            idx,
        ));
    }
    section.child(
        div()
            .mt(px(4.0))
            .text_size(px(11.0))
            .text_color(rgb(TEXT_DIM))
            .child(card_text(lang, &CardMsg::RelatedFooter)),
    )
}

fn timeline_step_row(step: &Step, has_line_below: bool) -> Div {
    let (mark, marker_bg) = if step.ok {
        ("\u{2713}", OK)
    } else {
        ("\u{2717}", DIFF_DEL_FG)
    };

    let marker = div()
        .mt(px(2.0))
        .w(px(14.0))
        .h(px(14.0))
        .rounded_full()
        .flex()
        .items_center()
        .justify_center()
        .flex_shrink_0()
        .bg(rgb(marker_bg))
        .text_size(px(9.0))
        .line_height(relative(1.0))
        .font_weight(FontWeight::BOLD)
        .text_color(rgb(CARD_BG))
        .child(mark);

    let mut rail = div()
        .w(px(16.0))
        .flex_shrink_0()
        .flex()
        .flex_col()
        .items_center()
        .child(marker);
    if has_line_below {
        rail = rail.child(div().w(px(1.0)).flex_1().bg(rgb(BORDER_LIGHT)));
    }

    let title = div()
        .flex_1()
        .min_w_0()
        .truncate()
        .text_size(px(12.0))
        .font_family(mono_font())
        .text_color(rgb(TEXT_DARK))
        .child(step.title.clone());

    let mut content = div().flex().flex_col().flex_1().min_w_0().gap(px(2.0));
    if has_line_below {
        content = content.pb(px(8.0));
    }

    let mut meta = div()
        .flex()
        .items_center()
        .gap_2()
        .flex_shrink_0()
        .text_size(px(11.0))
        .font_family(mono_font())
        .whitespace_nowrap();
    if let Some(exit) = &step.exit {
        meta = meta.child(div().text_color(rgb(DIFF_DEL_FG)).child(exit.clone()));
    }
    meta = meta.child(div().text_color(rgb(TEXT_DIM)).child(step.dur.clone()));

    content = content.child(
        div()
            .flex()
            .justify_between()
            .items_center()
            .gap_2()
            .child(title)
            .child(meta),
    );

    if let Some(error) = &step.error {
        content = content.child(
            div()
                .min_w_0()
                .truncate()
                .pl(px(8.0))
                .text_size(px(11.0))
                .font_family(mono_font())
                .text_color(rgb(TEXT_DIM))
                .child(error.clone()),
        );
    }

    for (sub_label, fact) in &step.subs {
        let mut sub = div()
            .flex()
            .justify_between()
            .items_center()
            .gap_2()
            .min_w_0()
            .pl(px(8.0))
            .child(
                div()
                    .flex()
                    .flex_1()
                    .min_w_0()
                    .items_center()
                    .gap(px(6.0))
                    .child(
                        div()
                            .w(px(4.0))
                            .h(px(4.0))
                            .rounded_full()
                            .bg(rgb(BORDER_LIGHT))
                            .flex_shrink_0(),
                    )
                    .child(
                        div()
                            .min_w_0()
                            .truncate()
                            .text_size(px(12.0))
                            .text_color(rgb(TEXT_MUTED))
                            .child(sub_label.clone()),
                    ),
            );
        if !fact.is_empty() {
            sub = sub.child(
                div()
                    .min_w_0()
                    .truncate()
                    .text_right()
                    .text_size(px(11.0))
                    .font_family(mono_font())
                    .text_color(rgb(TEXT_DIM))
                    .child(fact.clone()),
            );
        }
        content = content.child(sub);
    }

    div().flex().gap_2().child(rail).child(content)
}
