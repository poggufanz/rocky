//! Sky chart geometry in pixels and the canvas drawing of its lines.
//!
//! Everything here works in plot pixels from the plot's top left, on the
//! drawable width `d` the time scale maps onto.

use gpui::{Bounds, Hsla, PathBuilder, Pixels, Point, Window, point, px, rgb};

use crate::atlas_model::sky::{RowKind, SkyBand, SkyChart, Turn};
use crate::atlas_model::time_scale::BREAK_W;
use crate::ui::tooltip::{BORDER_SUBTLE, STATUS_WORKING, TEXT_DARK, TEXT_DIM, TEXT_MUTED};

pub const ROW_H: f32 = 35.0;
/// Title strip above a band with stars: turn titles and the earlier note.
pub(super) const TITLE_H: f32 = 18.0;
/// Foot below the last row, room for a failed caption.
pub(super) const FOOT_H: f32 = 22.0;
/// Padding of a quiet band, which is one row tall.
const QUIET_PAD: f32 = 12.0;
/// Rows every band with steps has before its subagent lanes.
const PRIMARY_ROWS: usize = 3;
const DASH_ON: f32 = 3.0;
const DASH_OFF: f32 = 3.0;
const MERIDIAN_W: f32 = 1.2;
const BREAK_H: f32 = 10.0;
const BREAK_SLASH_W: f32 = 4.0;

fn row_index(row: RowKind) -> usize {
    match row {
        RowKind::Edit => 0,
        RowKind::Read => 1,
        RowKind::Cmd => 2,
        RowKind::Sub(i) => PRIMARY_ROWS + i,
    }
}

/// Height of one band: its rows, or one row for a band with only a quiet note.
pub(super) fn band_height(band: &SkyBand) -> f32 {
    if band.quiet.is_some() {
        return ROW_H + QUIET_PAD;
    }
    TITLE_H + (PRIMARY_ROWS + band.subs.len()) as f32 * ROW_H + FOOT_H
}

pub(super) fn plot_height(chart: &SkyChart) -> f32 {
    chart.bands.iter().map(band_height).sum()
}

/// Top edge of each band, in plot pixels.
pub(super) fn band_tops(chart: &SkyChart) -> Vec<f32> {
    let mut top = 0.0;
    chart
        .bands
        .iter()
        .map(|band| {
            let at = top;
            top += band_height(band);
            at
        })
        .collect()
}

/// Top of a turn title inside its band's title strip.
pub(super) fn title_y(band_top: f32) -> f32 {
    band_top + 1.0
}

/// Vertical center of `row` in a band whose top edge is `band_top`.
pub(super) fn row_y(band_top: f32, row: RowKind) -> f32 {
    band_top + TITLE_H + (row_index(row) as f32 + 0.5) * ROW_H
}

/// One end of a line, in plot pixels.
#[derive(Clone, Copy)]
pub(super) struct Pt {
    x: f32,
    y: f32,
}

fn pt(x: f32, y: f32) -> Pt {
    Pt { x, y }
}

/// One straight line to paint.
#[derive(Clone, Copy)]
pub(super) struct Seg {
    a: Pt,
    b: Pt,
    width: f32,
    color: u32,
    alpha: f32,
    dashed: bool,
}

fn seg(a: Pt, b: Pt, width: f32, color: u32) -> Seg {
    Seg {
        a,
        b,
        width,
        color,
        alpha: 1.0,
        dashed: false,
    }
}

pub(super) fn faint(mut s: Seg, alpha: f32) -> Seg {
    s.alpha = alpha;
    s
}

pub(super) fn dashed(mut s: Seg) -> Seg {
    s.dashed = true;
    s
}

/// A line between two points given in plot pixels from the plot's top left.
pub(super) fn line(from: (f32, f32), to: (f32, f32), width: f32, color: u32) -> Seg {
    seg(pt(from.0, from.1), pt(to.0, to.1), width, color)
}

/// Tick lines, row guides, and band separators, drawn under everything else.
fn grid_segs(chart: &SkyChart, tops: &[f32], (d, height): (f32, f32)) -> Vec<Seg> {
    let mut out: Vec<Seg> = chart
        .scale
        .ticks(d)
        .iter()
        .map(|t| faint(seg(pt(t.x, 0.0), pt(t.x, height), 1.0, BORDER_SUBTLE), 0.5))
        .collect();
    for (band, top) in chart.bands.iter().zip(tops) {
        if band.quiet.is_none() {
            for i in 0..PRIMARY_ROWS + band.subs.len() {
                let y = top + TITLE_H + (i as f32 + 0.5) * ROW_H;
                out.push(dashed(seg(pt(0.0, y), pt(d, y), 1.0, BORDER_SUBTLE)));
            }
        }
        let bottom = top + band_height(band);
        out.push(seg(pt(0.0, bottom), pt(d, bottom), 1.0, BORDER_SUBTLE));
    }
    out
}

/// Width and color of a turn's line: blue and heavier while the turn is live.
fn turn_line(live: bool) -> (f32, u32) {
    if live {
        (1.5, STATUS_WORKING)
    } else {
        (1.0, TEXT_DIM)
    }
}

/// Whether the turn a subagent spawned in is live: the last turn that began
/// at or before `spawn_ms`, else the band's first turn.
fn spawn_turn_live(band: &SkyBand, spawn_ms: u64) -> bool {
    let started = |t: &&Turn| t.stars.first().map(|&i| band.stars[i].step.ms);
    band.turns
        .iter()
        .rfind(|t| started(t).is_some_and(|ms| ms <= spawn_ms))
        .or_else(|| band.turns.first())
        .is_some_and(|t| t.live)
}

/// Constellation lines of each turn and the spawn links of subagents.
fn link_segs(chart: &SkyChart, tops: &[f32], d: f32) -> Vec<Seg> {
    let mut out = Vec::new();
    let x_of = |ms: u64| chart.scale.x(ms, d);
    for (band, &top) in chart.bands.iter().zip(tops) {
        let at = |i: usize| {
            let star = &band.stars[i];
            pt(x_of(star.step.ms), row_y(top, star.row))
        };
        for turn in &band.turns {
            let (width, color) = turn_line(turn.live);
            out.extend(
                turn.stars
                    .windows(2)
                    .map(|w| seg(at(w[0]), at(w[1]), width, color)),
            );
        }
        for (lane_idx, lane) in band.subs.iter().enumerate() {
            let (Some(spawn_ms), Some(&first)) = (lane.spawn_ms, lane.stars.first()) else {
                continue;
            };
            let from = pt(x_of(spawn_ms), row_y(top, RowKind::Cmd));
            let to = pt(
                x_of(band.stars[first].step.ms),
                row_y(top, RowKind::Sub(lane_idx)),
            );
            let (_, color) = turn_line(spawn_turn_live(band, spawn_ms));
            out.push(dashed(seg(from, to, 1.0, color)));
        }
    }
    out
}

/// The `//` mark centered in each break, at the top of the plot.
fn break_segs(chart: &SkyChart, d: f32) -> Vec<Seg> {
    chart
        .scale
        .breaks(d)
        .into_iter()
        .flat_map(|b| {
            let center = b.x + BREAK_W / 2.0;
            [-BREAK_SLASH_W, 0.0].map(|dx| {
                let from = pt(center + dx, BREAK_H + 2.0);
                let to = pt(center + dx + BREAK_SLASH_W, 2.0);
                seg(from, to, 1.2, TEXT_MUTED)
            })
        })
        .collect()
}

/// Every line of the chart, in paint order.
pub(super) fn sky_segments(chart: &SkyChart, d: f32) -> Vec<Seg> {
    let tops = band_tops(chart);
    let height = plot_height(chart);
    let mut out = grid_segs(chart, &tops, (d, height));
    out.push(seg(pt(d, 0.0), pt(d, height), MERIDIAN_W, TEXT_DARK));
    out.extend(link_segs(chart, &tops, d));
    out.extend(break_segs(chart, d));
    out
}

fn stroke(bounds: Bounds<Pixels>, s: &Seg, window: &mut Window) {
    let at =
        |p: Pt| -> Point<Pixels> { point(bounds.origin.x + px(p.x), bounds.origin.y + px(p.y)) };
    let mut path = PathBuilder::stroke(px(s.width));
    if s.dashed {
        path = path.dash_array(&[px(DASH_ON), px(DASH_OFF)]);
    }
    path.move_to(at(s.a));
    path.line_to(at(s.b));
    if let Ok(path) = path.build() {
        window.paint_path(path, Hsla::from(rgb(s.color)).opacity(s.alpha));
    }
}

/// Strokes every line, in order.
pub(super) fn paint_segs(bounds: Bounds<Pixels>, segs: &[Seg], window: &mut Window) {
    for s in segs {
        stroke(bounds, s, window);
    }
}

#[cfg(test)]
mod tests {
    use rocky_proto::pipe::{AgentKey, Status};

    use super::{Seg, link_segs};
    use crate::atlas_model::SkyWindow;
    use crate::atlas_model::StepRef;
    use crate::atlas_model::sky::{RowKind, SkyBand, SkyChart, Star, StarKind, SubLane, Turn};
    use crate::atlas_model::time_scale::TimeScale;
    use crate::ui::tooltip::{STATUS_WORKING, TEXT_DIM};

    fn key(agent: &str) -> AgentKey {
        AgentKey {
            session_id: "s".into(),
            agent_id: agent.into(),
        }
    }

    const NOW: u64 = 1_000_000;

    fn star(agent: &str, ms: u64, row: RowKind, kind: StarKind) -> Star {
        Star {
            step: StepRef {
                key: key(agent),
                ms,
            },
            row,
            radius: 2.5,
            kind,
            label: None,
        }
    }

    /// A parent turn with `parent_live`, and a finished subagent spawned inside it.
    fn chart(parent_live: bool) -> SkyChart {
        let parent_kind = if parent_live {
            StarKind::Running
        } else {
            StarKind::Plain
        };
        SkyChart {
            window: SkyWindow::Min10,
            now_ms: NOW,
            scale: TimeScale::build(&[NOW - 20_000, NOW - 10_000], SkyWindow::Min10, NOW),
            bands: vec![SkyBand {
                key: key(""),
                harness: None,
                branch: None,
                status: Status::Idle,
                subs: vec![SubLane {
                    key: key("c"),
                    label: "c".into(),
                    spawn_ms: Some(NOW - 18_000),
                    stars: vec![2],
                }],
                stars: vec![
                    star("", NOW - 20_000, RowKind::Cmd, StarKind::Plain),
                    star("", NOW - 10_000, RowKind::Cmd, parent_kind),
                    star("c", NOW - 15_000, RowKind::Sub(0), StarKind::Plain),
                ],
                turns: vec![Turn {
                    stars: vec![0, 1],
                    live: parent_live,
                    start_ms: 1,
                    title: None,
                }],
                quiet: None,
                earlier: None,
            }],
        }
    }

    fn spawn_link(chart: &SkyChart) -> Seg {
        let tops = super::band_tops(chart);
        *link_segs(chart, &tops, 400.0)
            .iter()
            .find(|s| s.dashed)
            .expect("spawn link")
    }

    #[test]
    fn spawn_link_follows_the_parent_turns_line_color() {
        assert_eq!(spawn_link(&chart(true)).color, STATUS_WORKING);
        assert_eq!(spawn_link(&chart(false)).color, TEXT_DIM);
    }
}
