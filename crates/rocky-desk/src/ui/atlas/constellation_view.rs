//! Constellation card: one turn of one agent session. Its steps sit evenly
//! spaced in order on a row per step kind, joined by a line, with one extra
//! row below for each subagent the turn spawned.

use gpui::prelude::*;
use gpui::{Context, Div, FontWeight, SharedString, Stateful, canvas, div, px, rgb};
use rocky_proto::pipe::{AgentKey, Status};

use super::sky_paint::{Seg, dashed, faint, line, paint_segs};
use super::sky_view::{BAND_LABEL_W, PLOT_MIN_W, card_shell, mono_text};
use super::star::{hit_box, hit_side, legend_swatches};
use super::{AtlasAction, OnAtlasAction};
use crate::atlas_model::StepRef;
use crate::atlas_model::constellation::{CStar, CSub, ConstellationView, STEP_SPACING};
use crate::atlas_model::sky::{RowKind, StarKind};
use crate::clock::{local_hhmm, local_hhmmss};
use crate::i18n::{AtlasMsg, CardMsg, Msg, UiLang, atlas_text, card_text, tr};
use crate::ui::harness::{HarnessKind, harness_icon};
use crate::ui::status::{failures_chip, status_pill, timer_color};
use crate::ui::tooltip::{
    BORDER_LIGHT, BORDER_SUBTLE, ROW_HOVER_BG, STATUS_FAILED, STATUS_WORKING, TEXT_BODY, TEXT_DARK,
    TEXT_DIM, TEXT_MUTED,
};
use crate::view::{age_secs, short8};

/// Distance between the edit, read, and cmd rows.
const PRIMARY_ROW_GAP: f32 = 90.0;
/// Distance between a subagent row and the row above it.
const SUB_ROW_GAP: f32 = 60.0;
/// Strip above the first row: room for labels above its stars.
const TOP_STRIP_H: f32 = 28.0;
/// Foot below the last row so labels below its stars are not clipped.
const FOOT_H: f32 = 36.0;
/// Height of the time tick strip above the plot.
const TICK_STRIP_H: f32 = 20.0;
const PRIMARY_ROWS: usize = 3;
/// Space right of the last star.
const RIGHT_PAD: f32 = 80.0;
const FIRST_STEP_GAP: f32 = 16.0;
/// Ticks closer than this to a placed one are dropped.
const TICK_MIN_GAP: f32 = 70.0;
const TICK_W: f32 = 56.0;
const LABEL_MAX_W: f32 = STEP_SPACING * 2.0 - 8.0;
const LABEL_GAP: f32 = 3.0;
const HEADER_ICON: f32 = 18.0;
const LIVE_LINE_W: f32 = 1.5;
const LINE_W: f32 = 1.0;

/// X of step `n` (1-based), in plot pixels.
fn step_x(n: usize) -> f32 {
    BAND_LABEL_W + FIRST_STEP_GAP + (n as f32 - 1.0) * STEP_SPACING
}

/// X of the `j`-th (1-based) star of a subagent spawned after `after_n` steps.
/// A subagent that starts before the first step lines up with the parent's
/// own columns, so no star sits left of the first step.
fn sub_star_x(after_n: usize, j: usize) -> f32 {
    if after_n == 0 {
        return step_x(j);
    }
    step_x(after_n) + STEP_SPACING * (j as f32 - 0.5)
}

/// Row slot: edit, read, cmd, then one per subagent.
fn row_index(row: RowKind) -> usize {
    match row {
        RowKind::Edit => 0,
        RowKind::Read => 1,
        RowKind::Cmd => 2,
        RowKind::Sub(i) => PRIMARY_ROWS + i,
    }
}

/// Vertical center of row slot `index`, in plot pixels.
fn row_y_at(index: usize) -> f32 {
    let primary = index.min(PRIMARY_ROWS - 1) as f32 * PRIMARY_ROW_GAP;
    let subs = index.saturating_sub(PRIMARY_ROWS - 1) as f32 * SUB_ROW_GAP;
    TOP_STRIP_H + primary + subs
}

fn plot_height(subs: usize) -> f32 {
    row_y_at(PRIMARY_ROWS - 1 + subs) + FOOT_H
}

fn main_point(star: &CStar) -> (f32, f32) {
    (step_x(star.n), row_y_at(row_index(star.row)))
}

fn sub_points(sub: &CSub, sub_idx: usize) -> Vec<(f32, f32)> {
    let y = row_y_at(PRIMARY_ROWS + sub_idx);
    (1..=sub.stars.len())
        .map(|j| (sub_star_x(sub.after_n, j), y))
        .collect()
}

fn plot_width(view: &ConstellationView) -> f32 {
    let main = view.stars.iter().map(|s| step_x(s.n));
    let subs = view
        .subs
        .iter()
        .flat_map(|s| (1..=s.stars.len()).map(|j| sub_star_x(s.after_n, j)));
    let right = main.chain(subs).fold(0.0_f32, f32::max);
    (right + RIGHT_PAD).max(PLOT_MIN_W)
}

/// Steps that get a time tick: x and time, first, failed, and last, minus
/// any that would crowd one already placed.
fn tick_steps(view: &ConstellationView) -> Vec<(f32, u64)> {
    let first = view.stars.first();
    let failed = view.stars.iter().filter(|s| s.kind == StarKind::Failed);
    let candidates = first.into_iter().chain(failed).chain(view.stars.last());
    let mut placed: Vec<(f32, u64)> = Vec::new();
    for star in candidates {
        let x = step_x(star.n);
        if placed.iter().all(|(at, _)| (x - at).abs() >= TICK_MIN_GAP) {
            placed.push((x, star.step.ms));
        }
    }
    placed
}

/// The turn is still running: the session works or waits and its last step
/// is a live one.
fn is_live(view: &ConstellationView) -> bool {
    let active = matches!(view.status, Status::Working | Status::NeedsYou);
    let live_tail = view
        .stars
        .last()
        .is_some_and(|s| matches!(s.kind, StarKind::Running | StarKind::Waiting));
    active && live_tail
}

fn polyline_color(view: &ConstellationView) -> u32 {
    if is_live(view) {
        STATUS_WORKING
    } else {
        TEXT_DIM
    }
}

/// Where a subagent's spawn link leaves the parent line: halfway between
/// step `after_n` and the next, clamped to the first and last step.
fn spawn_point(view: &ConstellationView, after_n: usize) -> (f32, f32) {
    let (Some(first), Some(last)) = (view.stars.first(), view.stars.last()) else {
        return (step_x(1), row_y_at(0));
    };
    if after_n == 0 {
        return main_point(first);
    }
    match (view.stars.get(after_n - 1), view.stars.get(after_n)) {
        (Some(a), Some(b)) => {
            let (pa, pb) = (main_point(a), main_point(b));
            ((pa.0 + pb.0) / 2.0, (pa.1 + pb.1) / 2.0)
        }
        _ => main_point(last),
    }
}

/// Top of a star's label: above the star or below it.
fn label_top(y: f32, radius: f32, above: bool) -> f32 {
    if above {
        y - radius - 18.0
    } else {
        y + radius + 5.0
    }
}

/// Step guides, row guides, the turn's line, subagent lines, and spawn links.
fn constellation_segments(view: &ConstellationView, width: f32, height: f32) -> Vec<Seg> {
    let mut out: Vec<Seg> = view
        .stars
        .iter()
        .map(|s| {
            let x = step_x(s.n);
            faint(line((x, 0.0), (x, height), LINE_W, BORDER_SUBTLE), 0.6)
        })
        .collect();
    out.extend((0..PRIMARY_ROWS + view.subs.len()).map(|i| {
        let y = row_y_at(i);
        dashed(line((0.0, y), (width, y), LINE_W, BORDER_SUBTLE))
    }));
    let (main_w, main_color) = if is_live(view) {
        (LIVE_LINE_W, polyline_color(view))
    } else {
        (LINE_W, polyline_color(view))
    };
    let main: Vec<(f32, f32)> = view.stars.iter().map(main_point).collect();
    out.extend(
        main.windows(2)
            .map(|w| line(w[0], w[1], main_w, main_color)),
    );
    for (i, sub) in view.subs.iter().enumerate() {
        let points = sub_points(sub, i);
        out.extend(
            points
                .windows(2)
                .map(|w| line(w[0], w[1], LINE_W, TEXT_DIM)),
        );
        // No parent segment to drop from when the sub starts before step 1.
        if let (Some(&first), true) = (points.first(), sub.after_n > 0) {
            let from = spawn_point(view, sub.after_n);
            out.push(dashed(line(from, first, LINE_W, STATUS_WORKING)));
        }
    }
    out
}

fn empty_text(lang: UiLang) -> String {
    tr(lang, &Msg::NoAgents)
}

fn empty_line(lang: UiLang) -> Div {
    div()
        .text_size(px(12.5))
        .text_color(rgb(TEXT_MUTED))
        .child(empty_text(lang))
}

/// The Constellation card for `view`, or a one-line empty card when no agent
/// has been recorded.
pub fn constellation_card<T: 'static>(
    lang: UiLang,
    view: Option<&ConstellationView>,
    selected: Option<&StepRef>,
    now_ms: u64,
    cx: &mut Context<T>,
    on: OnAtlasAction<T>,
) -> Div {
    let Some(view) = view else {
        return card_shell().child(empty_line(lang));
    };
    card_shell()
        .child(header_title(lang, view))
        .child(header_meta(lang, view, now_ms, cx, on))
        .child(plot_scroller().child(plot_column(lang, view, selected, cx, on)))
        .child(legend(lang))
}

fn header_title(lang: UiLang, view: &ConstellationView) -> Div {
    let title = div()
        .flex_1()
        .min_w(px(0.0))
        .truncate()
        .italic()
        .text_size(px(14.0))
        .text_color(rgb(TEXT_BODY))
        .children(view.title.clone());
    div()
        .flex()
        .items_baseline()
        .gap(px(10.0))
        .child(
            div()
                .flex_none()
                .whitespace_nowrap()
                .text_size(px(15.0))
                .font_weight(FontWeight::BOLD)
                .text_color(rgb(TEXT_DARK))
                .child(atlas_text(lang, &AtlasMsg::Constellation)),
        )
        .child(title)
}

fn session_text(view: &ConstellationView) -> String {
    let id = short8(&view.session_id);
    match &view.branch {
        Some(branch) => format!("@ {branch} {id}"),
        None => id,
    }
}

fn header_meta<T: 'static>(
    lang: UiLang,
    view: &ConstellationView,
    now_ms: u64,
    cx: &mut Context<T>,
    on: OnAtlasAction<T>,
) -> Div {
    let kind = HarnessKind::from_id(view.harness.as_deref());
    let age = tr(
        lang,
        &Msg::Age {
            secs: age_secs(now_ms, view.last_event_ms),
        },
    );
    let steps = AtlasMsg::TurnSteps {
        at: local_hhmm(view.start_ms),
        n: view.stars.len(),
    };
    let mut row = div()
        .flex()
        .flex_wrap()
        .items_center()
        .gap(px(8.0))
        .child(harness_icon(&kind, px(HEADER_ICON)))
        .child(
            div()
                .whitespace_nowrap()
                .text_size(px(12.5))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(rgb(TEXT_DARK))
                .child(kind.display_name()),
        )
        .child(mono_text(11.0, TEXT_MUTED).child(session_text(view)))
        .child(status_pill(lang, view.status))
        .child(mono_text(11.5, timer_color(view.status)).child(age))
        .child(
            div()
                .whitespace_nowrap()
                .text_size(px(12.0))
                .text_color(rgb(TEXT_MUTED))
                .child(atlas_text(lang, &steps)),
        );
    if view.failed > 0 {
        let n = u32::try_from(view.failed).unwrap_or(u32::MAX);
        let chip = card_text(lang, &CardMsg::FailuresChip { n });
        row = row.child(failures_chip(chip));
    }
    row.child(turn_buttons(lang, view, cx, on))
}

/// Shared look of the previous and next turn buttons.
fn button_chrome<E: Styled>(el: E) -> E {
    el.flex_shrink_0()
        .py(px(3.0))
        .px(px(9.0))
        .rounded(px(6.0))
        .border_1()
        .border_color(rgb(BORDER_LIGHT))
        .whitespace_nowrap()
        .text_size(px(12.0))
}

fn next_button_disabled(lang: UiLang) -> Div {
    button_chrome(div())
        .text_color(rgb(TEXT_MUTED))
        .cursor_default()
        .child(atlas_text(lang, &AtlasMsg::NextTurn))
}

fn turn_button<T: 'static>(
    id: &'static str,
    text: String,
    target: (AgentKey, u64),
    cx: &mut Context<T>,
    on: OnAtlasAction<T>,
) -> Stateful<Div> {
    button_chrome(div().id(id))
        .text_color(rgb(TEXT_DARK))
        .cursor_pointer()
        .hover(|s| s.bg(rgb(ROW_HOVER_BG)))
        .on_click(cx.listener(move |this, _, window, cx| {
            let (key, start) = target.clone();
            on(this, AtlasAction::ShowTurn(key, start), window, cx);
        }))
        .child(text)
}

fn turn_buttons<T: 'static>(
    lang: UiLang,
    view: &ConstellationView,
    cx: &mut Context<T>,
    on: OnAtlasAction<T>,
) -> Div {
    let mut row = div().flex().flex_shrink_0().gap(px(6.0)).ml_auto();
    if let Some(prev) = view.prev_turn {
        let text = atlas_text(
            lang,
            &AtlasMsg::PrevTurn {
                at: local_hhmm(prev),
            },
        );
        row = row.child(turn_button(
            "atlas-turn-prev",
            text,
            (view.key.clone(), prev),
            cx,
            on,
        ));
    }
    match view.next_turn {
        Some(next) => row.child(turn_button(
            "atlas-turn-next",
            atlas_text(lang, &AtlasMsg::NextTurn),
            (view.key.clone(), next),
            cx,
            on,
        )),
        None => row.child(next_button_disabled(lang)),
    }
}

fn plot_scroller() -> Stateful<Div> {
    div()
        .id("atlas-constellation-scroll")
        .w_full()
        .overflow_x_scroll()
}

fn plot_column<T: 'static>(
    lang: UiLang,
    view: &ConstellationView,
    selected: Option<&StepRef>,
    cx: &mut Context<T>,
    on: OnAtlasAction<T>,
) -> Div {
    div()
        .flex()
        .flex_col()
        .flex_none()
        .w(px(plot_width(view)))
        .child(tick_strip(view))
        .child(plot_body(lang, view, selected, cx, on))
}

fn tick_strip(view: &ConstellationView) -> Div {
    let ticks = tick_steps(view).into_iter().map(|(x, ms)| {
        mono_text(10.5, TEXT_MUTED)
            .absolute()
            .top(px(3.0))
            .left(px(x - TICK_W / 2.0))
            .w(px(TICK_W))
            .flex()
            .justify_center()
            .child(local_hhmmss(ms))
    });
    div()
        .relative()
        .flex_none()
        .h(px(TICK_STRIP_H))
        .children(ticks)
}

fn row_names(lang: UiLang, view: &ConstellationView) -> Vec<Div> {
    let fixed = [
        (RowKind::Edit, AtlasMsg::RowEdit),
        (RowKind::Read, AtlasMsg::RowRead),
        (RowKind::Cmd, AtlasMsg::RowCmd),
    ]
    .map(|(row, msg)| (row_index(row), atlas_text(lang, &msg)));
    let subs = view
        .subs
        .iter()
        .enumerate()
        .map(|(i, s)| (PRIMARY_ROWS + i, s.label.clone()));
    fixed
        .into_iter()
        .chain(subs)
        .map(|(index, name)| {
            mono_text(11.0, TEXT_MUTED)
                .absolute()
                .top(px(row_y_at(index) - 7.0))
                .left_0()
                .w(px(BAND_LABEL_W - 8.0))
                .flex()
                .justify_end()
                .truncate()
                .child(name)
        })
        .collect()
}

fn plot_body<T: 'static>(
    lang: UiLang,
    view: &ConstellationView,
    selected: Option<&StepRef>,
    cx: &mut Context<T>,
    on: OnAtlasAction<T>,
) -> Div {
    let width = plot_width(view);
    let height = plot_height(view.subs.len());
    let segs = constellation_segments(view, width, height);
    let lines = canvas(
        move |_, _, _| (),
        move |bounds, (), window, _| paint_segs(bounds, &segs, window),
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full();
    let mut plot = div()
        .relative()
        .flex_none()
        .w(px(width))
        .h(px(height))
        .child(lines)
        .children(row_names(lang, view));
    for star in &view.stars {
        let id = SharedString::from(format!("atlas-cstar-{}", star.n));
        plot = add_star(plot, id, star, main_point(star), selected, cx, on);
    }
    for (i, sub) in view.subs.iter().enumerate() {
        for (j, (star, at)) in sub.stars.iter().zip(sub_points(sub, i)).enumerate() {
            let id = SharedString::from(format!("atlas-csub-{i}-{j}"));
            plot = add_star(plot, id, star, at, selected, cx, on);
        }
    }
    plot
}

/// Adds one star's label and clickable mark to the plot.
fn add_star<T: 'static>(
    plot: Div,
    id: SharedString,
    star: &CStar,
    at: (f32, f32),
    selected: Option<&StepRef>,
    cx: &mut Context<T>,
    on: OnAtlasAction<T>,
) -> Div {
    let on_it = selected == Some(&star.step);
    plot.child(star_label(star, at))
        .child(star_button(id, star, at, on_it, cx, on))
}

/// Number beside the star, target beyond it; one line, truncated.
fn star_label(star: &CStar, (x, y): (f32, f32)) -> Div {
    let failed = star.kind == StarKind::Failed;
    let (number_color, target_color) = if failed {
        (STATUS_FAILED, STATUS_FAILED)
    } else {
        (TEXT_DARK, TEXT_MUTED)
    };
    div()
        .absolute()
        .left(px(x + star.radius + LABEL_GAP))
        .top(px(label_top(y, star.radius, star.above)))
        .max_w(px(LABEL_MAX_W))
        .flex()
        .gap(px(4.0))
        .child(
            mono_text(11.5, number_color)
                .flex_none()
                .font_weight(FontWeight::BOLD)
                .child(star.n.to_string()),
        )
        .child(
            mono_text(10.5, target_color)
                .min_w(px(0.0))
                .truncate()
                .child(star.label.clone()),
        )
}

fn star_button<T: 'static>(
    id: SharedString,
    star: &CStar,
    (x, y): (f32, f32),
    selected: bool,
    cx: &mut Context<T>,
    on: OnAtlasAction<T>,
) -> Stateful<Div> {
    let step = star.step.clone();
    let side = hit_side(star.radius);
    hit_box(star.kind, star.radius, selected)
        .absolute()
        .left(px(x - side / 2.0))
        .top(px(y - side / 2.0))
        .id(id)
        .cursor_pointer()
        .hover(|s| s.bg(rgb(ROW_HOVER_BG)))
        .on_click(cx.listener(move |this, _, window, cx| {
            on(this, AtlasAction::SelectStep(step.clone()), window, cx);
        }))
}

fn legend(lang: UiLang) -> Div {
    let note = |msg: AtlasMsg| {
        div()
            .text_size(px(11.5))
            .text_color(rgb(TEXT_MUTED))
            .child(atlas_text(lang, &msg))
    };
    div()
        .flex()
        .flex_col()
        .gap(px(4.0))
        .child(legend_swatches(lang))
        .child(note(AtlasMsg::LegendRows))
        .child(note(AtlasMsg::ClickStar))
}

#[cfg(test)]
mod tests {
    use gpui::{CursorStyle, Hsla, Styled, rgb};
    use rocky_proto::pipe::{AgentKey, Status};

    use super::{
        PLOT_MIN_W, constellation_segments, empty_line, empty_text, is_live, label_top,
        next_button_disabled, plot_height, plot_width, polyline_color, row_y_at, spawn_point,
        step_x, sub_star_x, tick_steps,
    };
    use crate::atlas_model::StepRef;
    use crate::atlas_model::constellation::{CStar, CSub, ConstellationView};
    use crate::atlas_model::sky::{RowKind, StarKind};
    use crate::i18n::UiLang;
    use crate::ui::tooltip::{STATUS_WORKING, TEXT_DIM, TEXT_MUTED};

    fn key() -> AgentKey {
        AgentKey {
            session_id: "s".into(),
            agent_id: String::new(),
        }
    }

    fn cstar(n: usize, kind: StarKind) -> CStar {
        CStar {
            n,
            step: StepRef {
                key: key(),
                ms: 1_000 * n as u64,
            },
            row: RowKind::Edit,
            radius: 3.7,
            kind,
            label: format!("f{n}"),
            above: n % 2 == 1,
        }
    }

    fn view(kinds: &[StarKind], status: Status) -> ConstellationView {
        ConstellationView {
            key: key(),
            harness: None,
            branch: None,
            session_id: "abcdefghij".into(),
            status,
            last_event_ms: 0,
            title: None,
            start_ms: 0,
            stars: kinds
                .iter()
                .enumerate()
                .map(|(i, k)| cstar(i + 1, *k))
                .collect(),
            subs: vec![],
            failed: 0,
            prev_turn: None,
            next_turn: None,
        }
    }

    fn text_color(style: &gpui::StyleRefinement) -> Option<Hsla> {
        style.text.as_ref().and_then(|t| t.color)
    }

    #[test]
    fn step_x_uses_fixed_spacing() {
        assert_eq!(step_x(1), 80.0);
        assert_eq!(step_x(2), 136.0);
    }

    #[test]
    fn sub_star_sits_half_a_step_after_its_parent_step() {
        assert_eq!(sub_star_x(2, 1), step_x(2) + 28.0);
        assert_eq!(sub_star_x(2, 2), step_x(2) + 84.0);
    }

    #[test]
    fn sub_that_starts_before_the_first_step_aligns_with_the_first_columns() {
        assert_eq!(sub_star_x(0, 1), step_x(1));
        assert_eq!(sub_star_x(0, 2), step_x(2));
        assert_eq!(sub_star_x(3, 1), step_x(3) + 28.0);
    }

    #[test]
    fn no_spawn_link_when_the_sub_starts_before_the_first_step() {
        let with_sub = |after_n| {
            let mut v = view(&[StarKind::Plain; 4], Status::Idle);
            v.subs.push(CSub {
                key: key(),
                label: "sub".into(),
                after_n,
                stars: vec![cstar(1, StarKind::Plain)],
            });
            constellation_segments(&v, 640.0, 300.0).len()
        };
        assert_eq!(with_sub(3), with_sub(0) + 1);
    }

    #[test]
    fn rows_are_spaced_by_kind() {
        assert_eq!(row_y_at(1) - row_y_at(0), 90.0);
        assert_eq!(row_y_at(2) - row_y_at(1), 90.0);
        assert_eq!(row_y_at(3) - row_y_at(2), 60.0);
        assert_eq!(row_y_at(4) - row_y_at(3), 60.0);
        assert_eq!(plot_height(0), row_y_at(2) + 36.0);
        assert_eq!(plot_height(2), row_y_at(4) + 36.0);
    }

    #[test]
    fn plot_is_at_least_min_wide_and_grows_with_steps() {
        let one = view(&[StarKind::Plain], Status::Idle);
        assert_eq!(plot_width(&one), PLOT_MIN_W);
        let many = view(&[StarKind::Plain; 20], Status::Idle);
        assert_eq!(plot_width(&many), step_x(20) + 80.0);
    }

    #[test]
    fn plot_grows_for_a_subagent_star_past_the_last_step() {
        let mut v = view(&[StarKind::Plain; 2], Status::Idle);
        v.subs.push(CSub {
            key: key(),
            label: "sub".into(),
            after_n: 20,
            stars: vec![cstar(1, StarKind::Plain)],
        });
        assert_eq!(plot_width(&v), sub_star_x(20, 1) + 80.0);
    }

    #[test]
    fn spawn_link_leaves_the_parent_line_between_two_steps() {
        let v = view(&[StarKind::Plain; 3], Status::Idle);
        assert_eq!(spawn_point(&v, 0), (step_x(1), row_y_at(0)));
        assert_eq!(spawn_point(&v, 1), (step_x(1) + 28.0, row_y_at(0)));
        assert_eq!(spawn_point(&v, 9), (step_x(3), row_y_at(0)));
    }

    #[test]
    fn ticks_mark_first_failed_last_and_skip_crowded_ones() {
        let kinds = [
            StarKind::Plain,
            StarKind::Plain,
            StarKind::Failed,
            StarKind::Plain,
            StarKind::Plain,
        ];
        let ticks = tick_steps(&view(&kinds, Status::Idle));
        let times: Vec<u64> = ticks.iter().map(|t| t.1).collect();
        assert_eq!(times, vec![1_000, 3_000, 5_000]);
        let close = tick_steps(&view(&[StarKind::Plain, StarKind::Plain], Status::Idle));
        assert_eq!(close.len(), 1);
    }

    #[test]
    fn live_turn_line_is_blue_else_dim() {
        let live = view(&[StarKind::Plain, StarKind::Running], Status::Working);
        assert!(is_live(&live));
        assert_eq!(polyline_color(&live), STATUS_WORKING);
        let done = view(&[StarKind::Plain, StarKind::Plain], Status::Working);
        assert_eq!(polyline_color(&done), TEXT_DIM);
        let idle = view(&[StarKind::Running], Status::Idle);
        assert_eq!(polyline_color(&idle), TEXT_DIM);
    }

    #[test]
    fn labels_sit_above_or_below_the_star() {
        assert!(label_top(100.0, 4.0, true) < 100.0 - 4.0);
        assert!(label_top(100.0, 4.0, false) > 100.0 + 4.0);
    }

    #[test]
    fn next_turn_disabled_without_a_next_turn() {
        let mut button = next_button_disabled(UiLang::En);
        let style = button.style();
        assert_eq!(text_color(style), Some(Hsla::from(rgb(TEXT_MUTED))));
        assert_eq!(style.mouse_cursor, Some(CursorStyle::Arrow));
    }

    #[test]
    fn empty_view_shows_no_agents_line() {
        assert_eq!(empty_text(UiLang::En), "No agents recorded yet.");
        let mut line = empty_line(UiLang::En);
        assert_eq!(text_color(line.style()), Some(Hsla::from(rgb(TEXT_MUTED))));
    }
}
