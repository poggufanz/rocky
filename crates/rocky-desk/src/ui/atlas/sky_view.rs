//! Sky chart card: every agent step of one project as a star placed by time,
//! one band per session, with constellation lines joining a turn's steps.

use gpui::prelude::*;
use gpui::{Context, Div, FontWeight, SharedString, Stateful, canvas, div, px, rgb};

use super::sky_labels::{
    Axis, CAPTION_MAX_W, EARLIER_NOTE_W, Placed, Side, TICK_LABEL_W, visible_captions,
    visible_ticks, visible_titles,
};
use super::sky_paint::{
    Seg, band_height, band_tops, paint_segs, plot_height, row_y, sky_segments, title_y,
};
use super::star::{hit_box, hit_side, legend_swatches, star_caption};
use super::{AtlasAction, OnAtlasAction};
use crate::atlas_model::sky::{LIVE_RADIUS, RowKind, SkyBand, SkyChart, Star, StarKind, Turn};
use crate::atlas_model::time_scale::{BREAK_W, hidden_text};
use crate::atlas_model::{SkyWindow, StepRef};
use crate::clock::local_hhmm;
use crate::i18n::{AtlasMsg, UiLang, atlas_text};
use crate::ui::harness::{HarnessKind, session_badge};
use crate::ui::tooltip::{
    BORDER_LIGHT, BORDER_SUBTLE, CARD_BG, ROW_HOVER_BG, STATUS_FAILED, STATUS_NEEDS_YOU,
    STATUS_WORKING, SURFACE_SUBTLE, TEXT_BODY, TEXT_DARK, TEXT_MUTED, mono_font,
};

pub const BAND_LABEL_W: f32 = 64.0;
/// Floor for very narrow windows; the plot otherwise fills the card.
pub const PLOT_MIN_W: f32 = 280.0;
/// Padding of the card on each side.
pub const CARD_PAD: f32 = 14.0;
/// Border of the card on each side.
pub const CARD_BORDER: f32 = 1.0;

/// Width of the plot for a card whose inner width is `avail_w`.
pub fn plot_width(avail_w: f32) -> f32 {
    (avail_w - BAND_LABEL_W).max(PLOT_MIN_W)
}

const TICK_STRIP_H: f32 = 20.0;
const LIVE_GUTTER: f32 = LIVE_RADIUS * 2.0 + 4.0;
const BADGE_ICON: f32 = 18.0;
const BRANCH_MAX_W: f32 = 38.0;
const WINDOWS: [(SkyWindow, &str); 3] = [
    (SkyWindow::Min10, "10"),
    (SkyWindow::Min30, "30"),
    (SkyWindow::Hours2, "120"),
];

/// The Sky chart card for `chart`; `avail_w` is the card's inner width. `repo` names the project in the subtitle.
#[allow(clippy::too_many_arguments)]
pub fn sky_card<T: 'static>(
    lang: UiLang,
    chart: &SkyChart,
    repo: &str,
    selected: Option<&StepRef>,
    avail_w: f32,
    cx: &mut Context<T>,
    on: OnAtlasAction<T>,
) -> Div {
    card_shell()
        .child(header(lang, chart.window, repo, cx, on))
        .child(plot_scroller().child(plot_row(lang, chart, selected, plot_width(avail_w), cx, on)))
        .child(legend(lang))
}

/// The padded, bordered card both atlas views sit in.
pub(super) fn card_shell() -> Div {
    div()
        .flex()
        .flex_col()
        .gap(px(10.0))
        .p(px(CARD_PAD))
        .rounded(px(10.0))
        .bg(rgb(CARD_BG))
        .border_1()
        .border_color(rgb(BORDER_SUBTLE))
}

fn header<T: 'static>(
    lang: UiLang,
    window: SkyWindow,
    repo: &str,
    cx: &mut Context<T>,
    on: OnAtlasAction<T>,
) -> Div {
    let titles = div()
        .flex()
        .flex_col()
        .flex_grow()
        .min_w(px(0.0))
        .child(
            div()
                .truncate()
                .text_size(px(15.0))
                .font_weight(FontWeight::BOLD)
                .text_color(rgb(TEXT_DARK))
                .child(atlas_text(lang, &AtlasMsg::SkyChart)),
        )
        .child(
            div()
                .truncate()
                .text_size(px(12.0))
                .text_color(rgb(TEXT_MUTED))
                .child(atlas_text(
                    lang,
                    &AtlasMsg::SkySub {
                        repo: repo.to_string(),
                    },
                )),
        );
    let switch = div()
        .flex()
        .flex_shrink_0()
        .gap(px(2.0))
        .p(px(2.0))
        .rounded(px(8.0))
        .bg(rgb(SURFACE_SUBTLE))
        .children(WINDOWS.map(|(target, key)| window_segment(lang, window, target, key, cx, on)));
    div()
        .flex()
        .items_center()
        .gap(px(12.0))
        .child(titles)
        .child(switch)
}

fn window_segment<T: 'static>(
    lang: UiLang,
    current: SkyWindow,
    target: SkyWindow,
    key: &'static str,
    cx: &mut Context<T>,
    on: OnAtlasAction<T>,
) -> Stateful<Div> {
    let seg = div()
        .id(SharedString::from(format!("atlas-window-{key}")))
        .py(px(3.0))
        .px(px(9.0))
        .rounded(px(6.0))
        .border_1()
        .whitespace_nowrap()
        .cursor_pointer()
        .text_size(px(12.0))
        .on_click(cx.listener(move |this, _, window, cx| {
            on(this, AtlasAction::SetWindow(target), window, cx);
        }));
    let seg = if current == target {
        seg.bg(rgb(CARD_BG))
            .border_color(rgb(BORDER_LIGHT))
            .text_color(rgb(TEXT_DARK))
            .font_weight(FontWeight::SEMIBOLD)
    } else {
        seg.border_color(gpui::transparent_black())
            .text_color(rgb(TEXT_MUTED))
            .hover(|s| s.text_color(rgb(TEXT_DARK)))
    };
    seg.child(atlas_text(lang, &AtlasMsg::Window(target)))
}

/// The horizontal scroll container the plot lives in.
fn plot_scroller() -> Stateful<Div> {
    div().id("atlas-sky-scroll").w_full().overflow_x_scroll()
}

/// The plot surface: relative, never narrower than [`PLOT_MIN_W`].
fn plot_surface(height: f32) -> Div {
    div()
        .relative()
        .w_full()
        .min_w(px(PLOT_MIN_W))
        .h(px(height))
}

fn plot_row<T: 'static>(
    lang: UiLang,
    chart: &SkyChart,
    selected: Option<&StepRef>,
    plot_w: f32,
    cx: &mut Context<T>,
    on: OnAtlasAction<T>,
) -> Div {
    let height = plot_height(chart);
    let labels = div()
        .flex_none()
        .w(px(BAND_LABEL_W))
        .flex()
        .flex_col()
        .child(div().h(px(TICK_STRIP_H)))
        .child(label_column(lang, chart, height));
    let plot = div()
        .flex()
        .flex_col()
        .flex_none()
        .w(px(plot_w))
        .child(tick_strip(lang, chart, drawable_width(plot_w)))
        .child(plot_body(lang, chart, selected, (height, plot_w), cx, on));
    div()
        .flex()
        .min_w(px(BAND_LABEL_W + plot_w))
        .child(labels)
        .child(plot)
}

pub(super) fn mono_text(size: f32, color: u32) -> Div {
    div()
        .whitespace_nowrap()
        .font_family(mono_font())
        .text_size(px(size))
        .text_color(rgb(color))
}

fn tick_strip(lang: UiLang, chart: &SkyChart, d: f32) -> Div {
    let breaks = chart.scale.breaks(d);
    let ticks = chart.scale.ticks(d);
    let ticks = visible_ticks(&ticks, &breaks, d).into_iter().map(|t| {
        mono_text(10.5, TEXT_MUTED)
            .absolute()
            .top(px(3.0))
            .left(px(t.x - TICK_LABEL_W / 2.0))
            .w(px(TICK_LABEL_W))
            .flex()
            .justify_center()
            .child(local_hhmm(t.ms))
    });
    let gaps = breaks.iter().map(|b| {
        mono_text(10.5, TEXT_MUTED)
            .absolute()
            .top(px(3.0))
            .left(px(b.x))
            .w(px(BREAK_W))
            .flex()
            .justify_center()
            .italic()
            .child(hidden_text(b.hidden_ms))
    });
    let now = mono_text(10.5, TEXT_DARK)
        .absolute()
        .top(px(3.0))
        .right_0()
        .font_weight(FontWeight::BOLD);
    div().relative().h(px(TICK_STRIP_H)).child(
        drawable_layer()
            .children(ticks)
            .children(gaps)
            .child(now.child(atlas_text(lang, &AtlasMsg::Now))),
    )
}

fn label_column(lang: UiLang, chart: &SkyChart, height: f32) -> Div {
    let tops = band_tops(chart);
    let bands = chart
        .bands
        .iter()
        .zip(tops)
        .map(|(band, top)| band_label(lang, band, top));
    div().relative().h(px(height)).children(bands)
}

fn row_name(lang: UiLang, band: &SkyBand, row: RowKind) -> String {
    match row {
        RowKind::Edit => atlas_text(lang, &AtlasMsg::RowEdit),
        RowKind::Read => atlas_text(lang, &AtlasMsg::RowRead),
        RowKind::Cmd => atlas_text(lang, &AtlasMsg::RowCmd),
        RowKind::Sub(i) => band
            .subs
            .get(i)
            .map(|s| s.label.clone())
            .unwrap_or_default(),
    }
}

/// One band's left cell: harness icon with status dot, branch, row names.
fn band_label(lang: UiLang, band: &SkyBand, top: f32) -> Div {
    let kind = HarnessKind::from_id(band.harness.as_deref());
    let mut cell = div()
        .absolute()
        .top(px(top))
        .left_0()
        .w(px(BAND_LABEL_W - 2.0))
        .h(px(band_height(band)))
        .child(div().absolute().top(px(6.0)).left_0().child(session_badge(
            &kind,
            band.status,
            px(BADGE_ICON),
        )));
    if let Some(branch) = &band.branch {
        cell = cell.child(
            mono_text(10.5, TEXT_DARK)
                .absolute()
                .top(px(30.0))
                .left_0()
                .max_w(px(BRANCH_MAX_W))
                .truncate()
                .font_weight(FontWeight::BOLD)
                .child(branch.clone()),
        );
    }
    if band.quiet.is_some() {
        return cell;
    }
    let rows = [RowKind::Edit, RowKind::Read, RowKind::Cmd]
        .into_iter()
        .chain((0..band.subs.len()).map(RowKind::Sub));
    cell.children(rows.map(|row| {
        mono_text(11.0, TEXT_MUTED)
            .absolute()
            .top(px(row_y(0.0, row) - 7.0))
            .right_0()
            .max_w(px(BAND_LABEL_W - 2.0))
            .truncate()
            .child(row_name(lang, band, row))
    }))
}

fn plot_body<T: 'static>(
    lang: UiLang,
    chart: &SkyChart,
    selected: Option<&StepRef>,
    (height, plot_w): (f32, f32),
    cx: &mut Context<T>,
    on: OnAtlasAction<T>,
) -> Div {
    let d = drawable_width(plot_w);
    let segs: Vec<Seg> = sky_segments(chart, d);
    let lines = canvas(
        move |_, _, _| (),
        move |bounds, (), window, _| paint_segs(bounds, &segs, window),
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full();
    let mut layer = drawable_layer().child(lines);
    for (band_idx, (band, top)) in chart.bands.iter().zip(band_tops(chart)).enumerate() {
        layer = layer.children(band_notes(lang, band, top, chart.window));
        let axis = Axis {
            scale: &chart.scale,
            d,
        };
        layer = layer.children(band_captions(lang, band, top, axis));
        for (i, star) in band.stars.iter().enumerate() {
            let at = (axis.x(star), row_y(top, star.row));
            let on_it = selected == Some(&star.step);
            layer = layer.child(star_button(band_idx, i, star, at, on_it, cx, on));
        }
    }
    plot_surface(height).child(layer)
}

/// The part of the plot the time scale maps onto, with a gutter right of now.
fn drawable_layer() -> Div {
    div()
        .absolute()
        .top_0()
        .bottom_0()
        .left_0()
        .right(px(plot_gutter()))
}

/// Right gutter of the drawable layer, in px, so a star at now is not cut at the edge.
fn plot_gutter() -> f32 {
    LIVE_GUTTER
}

/// Width of the plot the x fractions map onto.
fn drawable_width(plot_w: f32) -> f32 {
    plot_w - plot_gutter()
}

/// One-line text hung from plot px `x` of the drawable width `d`: its left edge at `x`, or its
/// right edge when `side` is right. Text past `max_w` ends in an ellipsis.
fn hung(text: Div, (x, d): (f32, f32), top: f32, (side, max_w): (Side, f32)) -> Div {
    let frame = div().absolute().top(px(top)).max_w(px(max_w)).flex();
    let frame = match side {
        Side::Right => frame.right(px(d - x)).justify_end(),
        Side::Left => frame.left(px(x)),
    };
    frame.child(text.min_w_0().truncate())
}

/// Quiet and earlier notes of one band.
fn band_notes(lang: UiLang, band: &SkyBand, top: f32, window: SkyWindow) -> Vec<Div> {
    let note = |text: String, y: f32| {
        div()
            .absolute()
            .left(px(8.0))
            .top(px(top + y))
            .italic()
            .text_size(px(11.5))
            .text_color(rgb(TEXT_MUTED))
            .child(text)
    };
    let mut out = Vec::new();
    if let Some(q) = &band.quiet {
        let msg = AtlasMsg::Quiet {
            window: atlas_text(lang, &AtlasMsg::Window(window)),
            last: local_hhmm(q.last_ms),
            action: q.action.clone(),
        };
        out.push(note(atlas_text(lang, &msg), 6.0).right(px(8.0)).truncate());
    }
    if let Some(e) = &band.earlier {
        let msg = AtlasMsg::Earlier {
            at: local_hhmm(e.start_ms),
            edits: e.edits,
        };
        let y = if band.quiet.is_some() {
            band_height(band) - 17.0
        } else {
            title_y(0.0)
        };
        out.push(
            note(atlas_text(lang, &msg), y)
                .max_w(px(EARLIER_NOTE_W - 8.0))
                .truncate(),
        );
    }
    out
}

fn turn_title(turn: &Turn, band: &SkyBand, top: f32, ax: Axis<'_>, placed: &Placed) -> Option<Div> {
    let title = turn.title.clone()?;
    let first = &band.stars[*turn.stars.first()?];
    let el = div()
        .whitespace_nowrap()
        .italic()
        .text_size(px(12.5))
        .text_color(rgb(TEXT_BODY))
        .child(title);
    Some(hung(
        el,
        (ax.x(first), ax.d),
        title_y(top),
        (placed.side, placed.max_w),
    ))
}

fn star_caption_for(
    star: &Star,
    (lang, top, ax): (UiLang, f32, Axis<'_>),
    placed: &Placed,
) -> Option<Div> {
    let label = star.label.clone()?;
    let y = row_y(top, star.row);
    let (text, color, above) = match star.kind {
        StarKind::Failed => (
            format!("{label} {}", atlas_text(lang, &AtlasMsg::LegendFailed)),
            STATUS_FAILED,
            false,
        ),
        StarKind::Running => (label, STATUS_WORKING, true),
        StarKind::Waiting => (label, STATUS_NEEDS_YOU, true),
        StarKind::Plain => return None,
    };
    let y = if above {
        y - star.radius - 18.0
    } else {
        y + star.radius + 5.0
    };
    let side_w = (placed.side, placed.max_w.min(CAPTION_MAX_W));
    Some(hung(
        star_caption(text, color),
        (ax.x(star), ax.d),
        y,
        side_w,
    ))
}

/// Turn titles and failed or live star captions of one band that fit.
fn band_captions(lang: UiLang, band: &SkyBand, top: f32, ax: Axis<'_>) -> Vec<Div> {
    let caps = visible_captions(band, ax);
    let titles = visible_titles(band, ax, &caps)
        .into_iter()
        .filter_map(|p| turn_title(&band.turns[p.idx], band, top, ax, &p));
    let captions = caps
        .iter()
        .filter_map(|p| star_caption_for(&band.stars[p.idx], (lang, top, ax), p));
    titles.chain(captions).collect()
}

/// The clickable box of a star, centered on the star's position `(x, y)`.
fn star_hit_box(star: &Star, (x, y): (f32, f32), selected: bool) -> Div {
    let side = hit_side(star.radius);
    hit_box(star.kind, star.radius, selected)
        .absolute()
        .left(px(x - side / 2.0))
        .top(px(y - side / 2.0))
}

fn star_button<T: 'static>(
    band_idx: usize,
    star_idx: usize,
    star: &Star,
    at: (f32, f32),
    selected: bool,
    cx: &mut Context<T>,
    on: OnAtlasAction<T>,
) -> Stateful<Div> {
    let step = star.step.clone();
    star_hit_box(star, at, selected)
        .id(SharedString::from(format!(
            "atlas-star-{band_idx}-{star_idx}"
        )))
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
        .child(note(AtlasMsg::LegendLines))
        .child(note(AtlasMsg::LegendGaps))
        .child(note(AtlasMsg::ClickStar))
}

#[cfg(test)]
mod tests {
    use gpui::{Overflow, Styled, px};
    use rocky_proto::pipe::{AgentKey, Status};

    use super::{
        PLOT_MIN_W, drawable_width, plot_gutter, plot_scroller, plot_surface, plot_width,
        star_hit_box,
    };
    use crate::atlas_model::SkyWindow;
    use crate::atlas_model::StepRef;
    use crate::atlas_model::sky::{
        LIVE_RADIUS, QuietNote, RowKind, SkyBand, SkyChart, Star, StarKind, SubLane,
    };
    use crate::atlas_model::time_scale::TimeScale;
    use crate::ui::atlas::sky_paint::{ROW_H, TITLE_H, band_height, plot_height, row_y, title_y};

    fn key() -> AgentKey {
        AgentKey {
            session_id: "s".into(),
            agent_id: String::new(),
        }
    }

    fn band(quiet: bool, subs: usize) -> SkyBand {
        SkyBand {
            key: key(),
            harness: None,
            branch: None,
            status: Status::Idle,
            subs: (0..subs)
                .map(|_| SubLane {
                    key: key(),
                    label: "x".into(),
                    spawn_ms: None,
                    stars: vec![],
                })
                .collect(),
            stars: vec![],
            turns: vec![],
            quiet: quiet.then_some(QuietNote {
                last_ms: 0,
                action: None,
            }),
            earlier: None,
        }
    }

    fn star(radius: f32) -> Star {
        Star {
            step: StepRef { key: key(), ms: 1 },
            row: RowKind::Edit,
            radius,
            kind: StarKind::Plain,
            label: None,
        }
    }

    #[test]
    fn plot_keeps_min_width_and_scrolls_horizontally() {
        let mut scroller = plot_scroller();
        assert_eq!(scroller.style().overflow.x, Some(Overflow::Scroll));
        let mut surface = plot_surface(100.0);
        assert_eq!(surface.style().min_size.width, Some(px(PLOT_MIN_W).into()));
    }

    #[test]
    fn quiet_band_is_one_row_tall() {
        assert_eq!(band_height(&band(true, 0)), 47.0);
        assert_eq!(band_height(&band(false, 0)), 145.0);
        assert_eq!(band_height(&band(false, 1)), 180.0);
        let chart = SkyChart {
            window: SkyWindow::Min10,
            now_ms: 0,
            scale: TimeScale::build(&[], SkyWindow::Min10, 0),
            bands: vec![band(true, 0), band(false, 0)],
        };
        assert_eq!(plot_height(&chart), 47.0 + 145.0);
    }

    #[test]
    fn the_view_gutter_is_the_one_the_helper_subtracts() {
        assert_eq!(drawable_width(600.0), 600.0 - plot_gutter());
        assert!(plot_gutter() >= LIVE_RADIUS * 2.0 + 4.0);
    }

    #[test]
    fn plot_fits_a_narrow_card_and_keeps_a_floor() {
        assert_eq!(plot_width(401.0), 337.0);
        assert_eq!(plot_width(100.0), PLOT_MIN_W);
    }

    #[test]
    fn now_maps_inside_the_drawable_width() {
        let drawable = drawable_width(PLOT_MIN_W);
        let right_edge = drawable + crate::ui::atlas::star::star_box(LIVE_RADIUS) / 2.0;
        assert!(right_edge <= PLOT_MIN_W, "{right_edge}");
    }

    #[test]
    fn rows_stack_from_the_band_top() {
        assert_eq!(row_y(100.0, RowKind::Edit), 100.0 + TITLE_H + ROW_H / 2.0);
        assert_eq!(row_y(100.0, RowKind::Sub(1)), 100.0 + TITLE_H + 4.5 * ROW_H);
        assert!(row_y(100.0, RowKind::Edit) - ROW_H / 2.0 >= 100.0 + TITLE_H);
    }

    #[test]
    fn turn_title_sits_inside_the_title_strip() {
        let y = title_y(100.0);
        assert!((100.0..100.0 + TITLE_H).contains(&y));
    }

    #[test]
    fn small_stars_still_get_a_clickable_box() {
        let mut hit = star_hit_box(&star(2.5), (30.0, 40.0), false);
        let size = hit.style().size.clone();
        assert_eq!(size.width, size.height);
        assert!(size.width.is_some());
        assert!(hit.style().corner_radii.top_left.is_some());
    }
}
