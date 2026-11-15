//! Live step timeline list and step markers inside active Now session cards.

use gpui::prelude::*;
use gpui::{AnyElement, Context, Div, FontWeight, SharedString, div, px, relative, rgb};
use rocky_proto::pipe::AgentKey;

use super::{NowAction, OnNowAction};
use crate::i18n::{CardMsg, UiLang, card_text};
use crate::now_model::{LiveStep, SessionCard, StepMark};
use crate::ui::motion;
use crate::ui::tooltip::{
    BORDER_LIGHT, BORDER_SUBTLE, CARD_BG, LINK, STATUS_DONE, STATUS_FAILED, STATUS_NEEDS_YOU,
    STATUS_WORKING, TEXT_BODY, TEXT_DARK, TEXT_MUTED, mono_font,
};

const MAX_COLLAPSED_STEPS: usize = 3;

pub(super) fn primary_steps_section<T: 'static>(
    lang: UiLang,
    card: &SessionCard,
    cx: &mut Context<T>,
    on_action: OnNowAction<T>,
) -> Div {
    let mut section = steps_list(&card.key, &card.steps, card.hidden_steps, px(12.0));

    let show_toggle = (!card.expanded && card.hidden_steps > 0)
        || (card.expanded && card.steps.len() > MAX_COLLAPSED_STEPS);
    if show_toggle {
        let toggle_msg = if card.expanded {
            CardMsg::Collapse
        } else {
            CardMsg::EarlierSteps {
                n: card.hidden_steps,
            }
        };
        let toggle_label = card_text(lang, &toggle_msg);
        let key = card.key.clone();
        section = section.child(
            div().pl(px(26.0)).pb(px(4.0)).child(
                div()
                    .id(SharedString::from(format!(
                        "now-more:{}:{}",
                        key.session_id, key.agent_id
                    )))
                    .text_size(px(12.0))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(rgb(LINK))
                    .cursor_pointer()
                    .hover(|s| s.underline())
                    .on_click(cx.listener(move |this, _, window, cx| {
                        on_action(this, NowAction::ToggleAgent(key.clone()), window, cx);
                    }))
                    .child(toggle_label),
            ),
        );
    }

    section
}

pub(super) fn steps_list(
    key: &AgentKey,
    steps: &[LiveStep],
    offset: usize,
    left_pad: gpui::Pixels,
) -> Div {
    let mut out = div()
        .flex()
        .flex_col()
        .border_t_1()
        .border_color(rgb(BORDER_SUBTLE))
        .pt(px(8.0))
        .pl(left_pad)
        .pr(px(12.0))
        .pb(px(6.0));
    let last_idx = steps.len().saturating_sub(1);
    for (idx, step) in steps.iter().enumerate() {
        let abs_idx = offset + idx;
        let step_id = SharedString::from(format!(
            "now-step:{}:{}:{}",
            key.session_id, key.agent_id, abs_idx
        ));
        let run_id = SharedString::from(format!(
            "now-run:{}:{}:{}",
            key.session_id, key.agent_id, abs_idx
        ));
        let row = step_row(step, idx < last_idx, run_id);
        out = out.child(motion::timeline_enter(row, step_id, idx));
    }
    out
}

fn step_row(step: &LiveStep, has_line_below: bool, run_id: SharedString) -> Div {
    let marker = match step.mark {
        StepMark::Ok => settled_step_marker("\u{2713}", STATUS_DONE),
        StepMark::Failed => settled_step_marker("\u{2717}", STATUS_FAILED),
        StepMark::Waiting => settled_step_marker("!", STATUS_NEEDS_YOU),
        StepMark::Running => {
            let ring = div()
                .w(px(16.0))
                .h(px(16.0))
                .rounded_full()
                .flex_shrink_0()
                .border_2()
                .border_color(rgb(STATUS_WORKING));
            motion::pulse(ring, run_id).into_any_element()
        }
    };

    let mut rail = div()
        .w(px(16.0))
        .flex_shrink_0()
        .flex()
        .flex_col()
        .items_center()
        .child(marker);
    if has_line_below {
        rail = rail.child(
            div()
                .w(px(1.0))
                .flex_1()
                .min_h(px(8.0))
                .mt(px(2.0))
                .bg(rgb(BORDER_LIGHT)),
        );
    }

    let mut title = div()
        .flex_1()
        .min_w_0()
        .truncate()
        .font_family(mono_font())
        .text_size(px(12.0));
    title = match step.mark {
        StepMark::Running | StepMark::Waiting => title
            .font_weight(FontWeight::SEMIBOLD)
            .text_color(rgb(TEXT_DARK)),
        StepMark::Failed => title.text_color(rgb(STATUS_FAILED)),
        StepMark::Ok => title.text_color(rgb(TEXT_BODY)),
    };
    title = title.child(step.title.clone());

    let content = div()
        .flex_1()
        .min_w_0()
        .flex()
        .items_start()
        .gap(px(8.0))
        .pb(px(8.0))
        .child(title)
        .child(
            div()
                .ml_auto()
                .flex_shrink_0()
                .whitespace_nowrap()
                .font_family(mono_font())
                .text_size(px(11.0))
                .text_color(rgb(TEXT_MUTED))
                .pt(px(1.0))
                .child(step.dur.clone()),
        );

    div().flex().gap(px(10.0)).child(rail).child(content)
}

fn settled_step_marker(glyph: &'static str, bg: u32) -> AnyElement {
    div()
        .w(px(16.0))
        .h(px(16.0))
        .rounded_full()
        .flex_shrink_0()
        .flex()
        .items_center()
        .justify_center()
        .bg(rgb(bg))
        .text_size(px(10.0))
        .line_height(relative(1.0))
        .font_weight(FontWeight::BOLD)
        .text_color(rgb(CARD_BG))
        .child(glyph)
        .into_any_element()
}
