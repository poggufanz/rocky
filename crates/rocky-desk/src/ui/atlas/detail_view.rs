//! Detail of the selected step, and the status bar under the page.

use gpui::prelude::*;
use gpui::{Context, Div, FontWeight, SharedString, Stateful, div, px, rgb};

use super::sky_view::card_shell;
use super::{AtlasAction, OnAtlasAction};
use crate::atlas_model::detail::{StepDetail, StepOutcome};
use crate::card_detail_model::format_step_dur;
use crate::clock::{local_hhmm, local_hhmmss};
use crate::i18n::{AtlasMsg, Msg, UiLang, atlas_text, tr};
use crate::ui::harness::{HarnessKind, harness_icon};
use crate::ui::status::status_pill;
use crate::ui::tooltip::{
    BORDER_LIGHT, CARD_BG, CHIP_BG, CHIP_FG, CHIP_HIGH_BG, CHIP_HIGH_FG, CHIP_WORKING_BG,
    CHIP_WORKING_FG, SURFACE_SUBTLE, TEXT_DARK, TEXT_MUTED, TEXT_SUBTLE, TIMER_NEEDS_YOU,
    TIMER_WORKING, mono_font,
};
use crate::view::{age_secs, short8};
use rocky_proto::pipe::Status;

const HARNESS_ICON: f32 = 14.0;
const SUB_SECOND_DECIMAL_MS: u64 = 10_000;

/// A duration with one decimal below ten seconds ("0.4s"), else "12s" or "1m 5s".
fn dur_text(ms: u64) -> String {
    if ms < SUB_SECOND_DECIMAL_MS {
        format!("{:.1}s", ms as f64 / 1000.0)
    } else {
        format_step_dur(ms)
    }
}

fn chip(text: String, bg: u32, fg: u32) -> Div {
    div()
        .flex_shrink_0()
        .whitespace_nowrap()
        .py(px(2.0))
        .px(px(8.0))
        .rounded(px(99.0))
        .text_size(px(11.5))
        .font_weight(FontWeight::SEMIBOLD)
        .bg(rgb(bg))
        .text_color(rgb(fg))
        .child(text)
}

fn outcome_chip(lang: UiLang, outcome: &StepOutcome, now_ms: u64) -> Div {
    match outcome {
        StepOutcome::Failed { dur_ms } => {
            let dur = dur_ms.map(dur_text).unwrap_or_default();
            chip(
                atlas_text(lang, &AtlasMsg::FailedAfter { dur }),
                CHIP_HIGH_BG,
                CHIP_HIGH_FG,
            )
        }
        StepOutcome::Running { since_ms } | StepOutcome::Waiting { since_ms } => {
            let dur = dur_text(now_ms.saturating_sub(*since_ms));
            chip(
                atlas_text(lang, &AtlasMsg::RunningFor { dur }),
                CHIP_WORKING_BG,
                CHIP_WORKING_FG,
            )
        }
        StepOutcome::Done { dur_ms } => {
            let dur = dur_ms.map(dur_text).unwrap_or_default();
            chip(atlas_text(lang, &AtlasMsg::Took { dur }), CHIP_BG, CHIP_FG)
        }
    }
}

fn field_label(text: String) -> Div {
    div()
        .text_size(px(10.5))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(rgb(TEXT_SUBTLE))
        .child(text)
}

fn small_button(id: &'static str, label: String) -> Stateful<Div> {
    div()
        .id(SharedString::from(id))
        .flex_shrink_0()
        .whitespace_nowrap()
        .py(px(3.0))
        .px(px(9.0))
        .rounded(px(6.0))
        .border_1()
        .border_color(rgb(BORDER_LIGHT))
        .bg(rgb(CARD_BG))
        .cursor_pointer()
        .text_size(px(12.0))
        .text_color(rgb(TEXT_DARK))
        .hover(|s| s.bg(rgb(SURFACE_SUBTLE)))
        .child(label)
}

fn step_column<T: 'static>(
    lang: UiLang,
    d: &StepDetail,
    now_ms: u64,
    cx: &mut Context<T>,
    on: OnAtlasAction<T>,
) -> Div {
    let button = |id: &'static str, label: String, action: AtlasAction, cx: &mut Context<T>| {
        small_button(id, label).on_click(cx.listener(move |this, _, window, cx| {
            on(this, action.clone(), window, cx);
        }))
    };
    let controls = div()
        .flex()
        .items_center()
        .gap(px(6.0))
        .child(button(
            "atlas-step-prev",
            "\u{2039}".into(),
            AtlasAction::StepBy(false),
            cx,
        ))
        .child(button(
            "atlas-step-next",
            "\u{203a}".into(),
            AtlasAction::StepBy(true),
            cx,
        ))
        .child(button(
            "atlas-step-copy",
            atlas_text(lang, &AtlasMsg::Copy),
            AtlasAction::CopyStep,
            cx,
        ));
    div()
        .flex()
        .flex_col()
        .gap(px(6.0))
        .flex_1()
        .min_w(px(0.0))
        .child(field_label(atlas_text(
            lang,
            &AtlasMsg::SelectedStep { n: d.n, of: d.of },
        )))
        .child(
            div()
                .truncate()
                .whitespace_nowrap()
                .font_family(mono_font())
                .text_size(px(13.0))
                .font_weight(FontWeight::BOLD)
                .text_color(rgb(TEXT_DARK))
                .child(d.text.clone()),
        )
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(8.0))
                .child(outcome_chip(lang, &d.outcome, now_ms))
                .child(controls),
        )
}

fn session_row(d: &StepDetail) -> Div {
    let kind = HarnessKind::from_id(d.harness.as_deref());
    let tail = match &d.branch {
        Some(branch) => format!("@ {branch} {}", short8(&d.session_id)),
        None => format!("@ {}", short8(&d.session_id)),
    };
    div()
        .flex()
        .items_center()
        .gap(px(6.0))
        .min_w(px(0.0))
        .child(harness_icon(&kind, px(HARNESS_ICON)))
        .child(
            div()
                .flex_shrink_0()
                .whitespace_nowrap()
                .text_size(px(12.5))
                .text_color(rgb(TEXT_DARK))
                .child(kind.display_name()),
        )
        .child(
            div()
                .truncate()
                .whitespace_nowrap()
                .font_family(mono_font())
                .text_size(px(11.5))
                .text_color(rgb(TEXT_MUTED))
                .child(tail),
        )
}

fn mono_value(text: String) -> Div {
    div()
        .whitespace_nowrap()
        .font_family(mono_font())
        .text_size(px(12.5))
        .text_color(rgb(TEXT_DARK))
        .child(text)
}

fn when_column(lang: UiLang, d: &StepDetail) -> Div {
    div()
        .flex()
        .flex_col()
        .gap(px(4.0))
        .flex_1()
        .min_w(px(0.0))
        .child(field_label(atlas_text(lang, &AtlasMsg::RanAt)))
        .child(mono_value(local_hhmmss(d.step.ms)))
        .child(field_label(atlas_text(lang, &AtlasMsg::Session)))
        .child(session_row(d))
}

fn turn_column(lang: UiLang, d: &StepDetail, now_ms: u64) -> Div {
    let timer_color = if d.status == Status::NeedsYou {
        TIMER_NEEDS_YOU
    } else {
        TIMER_WORKING
    };
    let mut row = div()
        .flex()
        .items_center()
        .gap(px(8.0))
        .child(mono_value(local_hhmm(d.turn_start_ms)))
        .child(status_pill(lang, d.status));
    if matches!(d.status, Status::Working | Status::NeedsYou) {
        let secs = age_secs(now_ms, d.turn_start_ms);
        row = row.child(
            div()
                .whitespace_nowrap()
                .font_family(mono_font())
                .text_size(px(11.5))
                .text_color(rgb(timer_color))
                .child(tr(lang, &Msg::Age { secs })),
        );
    }
    div()
        .flex()
        .flex_col()
        .gap(px(4.0))
        .flex_1()
        .min_w(px(0.0))
        .child(field_label(atlas_text(lang, &AtlasMsg::Turn)))
        .child(row)
}

/// The selected step: what it was, how it ended, and where it ran. Three
/// columns, or one when `narrow`. `None` shows a hint to click a star.
pub fn detail_card<T: 'static>(
    lang: UiLang,
    detail: Option<&StepDetail>,
    now_ms: u64,
    narrow: bool,
    cx: &mut Context<T>,
    on: OnAtlasAction<T>,
) -> Div {
    let Some(d) = detail else {
        return card_shell().child(
            div()
                .text_size(px(12.5))
                .text_color(rgb(TEXT_MUTED))
                .child(atlas_text(lang, &AtlasMsg::ClickStar)),
        );
    };
    let mut columns = div().flex().gap(px(16.0));
    columns = if narrow {
        columns.flex_col()
    } else {
        columns.items_start()
    };
    card_shell().child(
        columns
            .child(step_column(lang, d, now_ms, cx, on))
            .child(when_column(lang, d))
            .child(turn_column(lang, d, now_ms)),
    )
}

fn hint(keys: &'static str, label: String) -> Div {
    div()
        .flex()
        .items_center()
        .gap(px(5.0))
        .whitespace_nowrap()
        .child(
            div()
                .font_family(mono_font())
                .text_size(px(11.0))
                .text_color(rgb(TEXT_DARK))
                .child(keys),
        )
        .child(label)
}

/// The bottom bar: newest event time of the project and the key hints.
pub fn status_bar(lang: UiLang, last_event_ms: Option<u64>) -> Div {
    let mut bar = div()
        .flex()
        .items_center()
        .gap(px(16.0))
        .px(px(12.0))
        .py(px(6.0))
        .text_size(px(11.5))
        .text_color(rgb(TEXT_MUTED));
    if let Some(ms) = last_event_ms {
        bar = bar.child(div().flex_grow().truncate().child(atlas_text(
            lang,
            &AtlasMsg::LastEvent {
                at: local_hhmmss(ms),
            },
        )));
    } else {
        bar = bar.child(div().flex_grow());
    }
    bar.child(hint("j k", atlas_text(lang, &AtlasMsg::KeyStep)))
        .child(hint("1 2", atlas_text(lang, &AtlasMsg::KeyLayout)))
        .child(hint("/", atlas_text(lang, &AtlasMsg::KeyFind)))
}

#[cfg(test)]
mod tests {
    use super::dur_text;

    #[test]
    fn dur_text_keeps_a_decimal_under_ten_seconds() {
        assert_eq!(dur_text(400), "0.4s");
        assert_eq!(dur_text(9_000), "9.0s");
        assert_eq!(dur_text(12_000), "12s");
        assert_eq!(dur_text(65_000), "1m 5s");
    }
}
