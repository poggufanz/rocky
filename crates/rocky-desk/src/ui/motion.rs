//! Subtle GPUI enter, slide, stagger, and loading pulse motion helpers for card views.

use std::time::Duration;

use gpui::{
    Animation, AnimationElement, AnimationExt, ElementId, IntoElement, Styled, ease_out_quint,
    pulsating_between, px,
};

const MAX_STAGGER_INDEX: usize = 8;
const ENTER_RUN_MS: u32 = 220;
const ENTER_STEP_MS: u32 = 30;
const ENTER_OFFSET_PX: f32 = 6.0;
const SLIDE_RIGHT_RUN_MS: u64 = 200;
const SLIDE_RIGHT_OFFSET_PX: f32 = 12.0;
const TIMELINE_DELAY_MS: u32 = 200;
const TIMELINE_RUN_MS: u32 = 180;
const TIMELINE_STEP_MS: u32 = 40;
const PULSE_MS: u64 = 1_200;
const PULSE_MIN_OPACITY: f32 = 0.45;
const PULSE_MAX_OPACITY: f32 = 1.0;

/// Maps a staggered animation's progress (`0.0..=1.0`) to one item's progress (`0.0..=1.0`).
///
/// The combined animation spans `run_ms + min(index, 8) * step_ms`.
pub(crate) fn stagger(delta: f32, index: usize, step_ms: u32, run_ms: u32) -> f32 {
    if delta.is_nan() {
        return 0.0;
    }
    if run_ms == 0 {
        return if delta >= 1.0 { 1.0 } else { 0.0 };
    }
    let delay_ms = (index.min(MAX_STAGGER_INDEX) as u32).saturating_mul(step_ms) as f32;
    let run = run_ms as f32;
    let total = run + delay_ms;
    ((delta * total - delay_ms) / run).clamp(0.0, 1.0)
}

/// Fades in from 0 to 1 and slides up from 6 px over 220 ms with a 30 ms per-item stagger.
pub(crate) fn enter<E: Styled + IntoElement + 'static>(
    el: E,
    id: impl Into<ElementId>,
    index: usize,
) -> AnimationElement<E> {
    enter_staggered(el, id, index, ENTER_STEP_MS, ENTER_RUN_MS, 0)
}

/// Fades in and slides up 6 px per timeline step (40 ms stagger, 180 ms run) after the 200 ms detail entrance.
pub(crate) fn timeline_enter<E: Styled + IntoElement + 'static>(
    el: E,
    id: impl Into<ElementId>,
    index: usize,
) -> AnimationElement<E> {
    enter_staggered(
        el,
        id,
        index,
        TIMELINE_STEP_MS,
        TIMELINE_RUN_MS,
        TIMELINE_DELAY_MS,
    )
}

fn enter_staggered<E: Styled + IntoElement + 'static>(
    el: E,
    id: impl Into<ElementId>,
    index: usize,
    step_ms: u32,
    run_ms: u32,
    delay_ms: u32,
) -> AnimationElement<E> {
    let active_ms =
        run_ms.saturating_add((index.min(MAX_STAGGER_INDEX) as u32).saturating_mul(step_ms));
    let total_ms = delay_ms.saturating_add(active_ms);
    let ease = ease_out_quint();
    el.with_animation(
        id,
        Animation::new(Duration::from_millis(u64::from(total_ms))).with_easing(move |delta| {
            let shifted = if delay_ms == 0 || active_ms == 0 {
                delta
            } else {
                let delay_frac = delay_ms as f32 / total_ms as f32;
                ((delta - delay_frac) / (1.0 - delay_frac)).clamp(0.0, 1.0)
            };
            ease(stagger(shifted, index, step_ms, run_ms))
        }),
        |el, delta| {
            el.opacity(delta)
                .relative()
                .top(px(ENTER_OFFSET_PX * (1.0 - delta)))
        },
    )
}

/// Fades in from 0 to 1 and slides in from 12 px on the right over 200 ms.
pub(crate) fn slide_from_right<E: Styled + IntoElement + 'static>(
    el: E,
    id: impl Into<ElementId>,
) -> AnimationElement<E> {
    el.with_animation(
        id,
        Animation::new(Duration::from_millis(SLIDE_RIGHT_RUN_MS)).with_easing(ease_out_quint()),
        |el, delta| {
            el.opacity(delta)
                .relative()
                .left(px(SLIDE_RIGHT_OFFSET_PX * (1.0 - delta)))
        },
    )
}

/// Pulses element opacity between 0.45 and 1.0 on a repeating 1.2 s cycle.
pub(crate) fn pulse<E: Styled + IntoElement + 'static>(
    el: E,
    id: impl Into<ElementId>,
) -> AnimationElement<E> {
    el.with_animation(
        id,
        Animation::new(Duration::from_millis(PULSE_MS))
            .repeat()
            .with_easing(pulsating_between(PULSE_MIN_OPACITY, PULSE_MAX_OPACITY)),
        |el, delta| el.opacity(delta),
    )
}

#[cfg(test)]
mod tests {
    use super::stagger;

    #[test]
    fn stagger_starts_at_zero_and_ends_at_one_for_first_item() {
        assert_eq!(stagger(0.0, 0, 30, 220), 0.0);
        assert_eq!(stagger(1.0, 0, 30, 220), 1.0);
        assert!((stagger(0.5, 0, 30, 220) - 0.5).abs() < 1e-6);
    }

    #[test]
    fn stagger_holds_later_item_at_zero_until_delay_passes() {
        // index 3 -> delay 90 ms, run 220 ms, total 310 ms.
        assert_eq!(stagger(0.0, 3, 30, 220), 0.0);
        assert_eq!(stagger(45.0 / 310.0, 3, 30, 220), 0.0);
        assert_eq!(stagger(90.0 / 310.0, 3, 30, 220), 0.0);

        let mid = stagger(200.0 / 310.0, 3, 30, 220);
        assert!((mid - 0.5).abs() < 1e-5, "expected 0.5, got {mid}");
        assert_eq!(stagger(1.0, 3, 30, 220), 1.0);
    }

    #[test]
    fn stagger_caps_delay_at_index_eight() {
        let mid = stagger(0.75, 8, 30, 220);
        assert!(
            mid > 0.0 && mid < 1.0,
            "expected partial progress, got {mid}"
        );
        for delta in [0.0, 0.25, 0.5, 0.75, 1.0] {
            let at_8 = stagger(delta, 8, 30, 220);
            assert_eq!(stagger(delta, 9, 30, 220), at_8);
            assert_eq!(stagger(delta, 40, 30, 220), at_8);
        }
    }

    #[test]
    fn stagger_clamps_output_to_unit_interval() {
        assert_eq!(stagger(-0.5, 0, 30, 220), 0.0);
        assert_eq!(stagger(-1.0, 4, 30, 220), 0.0);
        assert_eq!(stagger(1.5, 0, 30, 220), 1.0);
        assert_eq!(stagger(2.0, 5, 40, 180), 1.0);
    }
}
