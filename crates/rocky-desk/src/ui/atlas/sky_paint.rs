//! Sky chart geometry in pixels and the canvas drawing of its lines.
//!
//! Everything here works in plot coordinates: x as a fraction of the plot
//! width (plus a pixel offset), y in pixels from the top of the plot.

use gpui::{Bounds, Hsla, PathBuilder, Pixels, Point, Window, fill, point, px, rgb, size};

use crate::atlas_model::sky::{RowKind, SkyBand, SkyChart};
use crate::ui::tooltip::{
    BORDER_SUBTLE, ROW_HOVER_BG, STATUS_WORKING, TEXT_DARK, TEXT_DIM, TEXT_MUTED,
};

pub const ROW_H: f32 = 35.0;
/// Padding a band adds around its rows: 6 px above and 6 px below.
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

/// Vertical center of `row` in a band whose top edge is `band_top`.
/// Top of a turn title inside its band's title strip.
pub(super) fn title_y(band_top: f32) -> f32 {
    band_top + 1.0
}

pub(super) fn row_y(band_top: f32, row: RowKind) -> f32 {
    band_top + TITLE_H + (row_index(row) as f32 + 0.5) * ROW_H
}

/// One end of a line: x as a plot fraction plus a pixel offset.
#[derive(Clone, Copy)]
pub(super) struct Pt {
    x: f32,
    dx: f32,
    y: f32,
}

fn pt(x: f32, y: f32) -> Pt {
    Pt { x, dx: 0.0, y }
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
    let at = |(x, y): (f32, f32)| Pt { x: 0.0, dx: x, y };
    seg(at(from), at(to), width, color)
}

/// Tick lines, row guides, and band separators, drawn under everything else.
fn grid_segs(chart: &SkyChart, tops: &[f32], height: f32) -> Vec<Seg> {
    let mut out: Vec<Seg> = chart
        .ticks
        .iter()
        .map(|t| faint(seg(pt(t.x, 0.0), pt(t.x, height), 1.0, BORDER_SUBTLE), 0.5))
        .collect();
    for (band, top) in chart.bands.iter().zip(tops) {
        if band.quiet.is_none() {
            for i in 0..PRIMARY_ROWS + band.subs.len() {
                let y = top + TITLE_H + (i as f32 + 0.5) * ROW_H;
                out.push(dashed(seg(pt(0.0, y), pt(1.0, y), 1.0, BORDER_SUBTLE)));
            }
        }
        let bottom = top + band_height(band);
        out.push(seg(pt(0.0, bottom), pt(1.0, bottom), 1.0, BORDER_SUBTLE));
    }
    out
}

/// Constellation lines of each turn and the spawn links of subagents.
fn link_segs(chart: &SkyChart, tops: &[f32]) -> Vec<Seg> {
    let mut out = Vec::new();
    for (band, &top) in chart.bands.iter().zip(tops) {
        let at = |i: usize| {
            let star = &band.stars[i];
            pt(star.x, row_y(top, star.row))
        };
        for turn in &band.turns {
            let (width, color) = if turn.live {
                (1.5, STATUS_WORKING)
            } else {
                (1.0, TEXT_DIM)
            };
            out.extend(
                turn.stars
                    .windows(2)
                    .map(|w| seg(at(w[0]), at(w[1]), width, color)),
            );
        }
        for (lane_idx, lane) in band.subs.iter().enumerate() {
            let (Some(spawn_x), Some(&first)) = (lane.spawn_x, lane.stars.first()) else {
                continue;
            };
            let from = pt(spawn_x, row_y(top, RowKind::Cmd));
            let to = pt(band.stars[first].x, row_y(top, RowKind::Sub(lane_idx)));
            out.push(dashed(seg(from, to, 1.0, STATUS_WORKING)));
        }
    }
    out
}

/// The `//` mark where the scale changes, at the top of the plot.
fn break_segs() -> Vec<Seg> {
    let split = 1.0 - crate::atlas_model::sky::RECENT_SHARE_OF_WIDTH;
    [-BREAK_SLASH_W, 0.0]
        .into_iter()
        .map(|dx| {
            let from = Pt {
                x: split,
                dx,
                y: BREAK_H + 2.0,
            };
            let to = Pt {
                x: split,
                dx: dx + BREAK_SLASH_W,
                y: 2.0,
            };
            seg(from, to, 1.2, TEXT_MUTED)
        })
        .collect()
}

/// Every line of the chart, in paint order.
pub(super) fn sky_segments(chart: &SkyChart) -> Vec<Seg> {
    let tops = band_tops(chart);
    let height = plot_height(chart);
    let mut out = grid_segs(chart, &tops, height);
    out.push(seg(pt(1.0, 0.0), pt(1.0, height), MERIDIAN_W, TEXT_DARK));
    out.extend(link_segs(chart, &tops));
    out.extend(break_segs());
    out
}

fn stroke(bounds: Bounds<Pixels>, s: &Seg, window: &mut Window) {
    let w = f32::from(bounds.size.width);
    let at = |p: Pt| -> Point<Pixels> {
        point(
            bounds.origin.x + px(p.x * w + p.dx),
            bounds.origin.y + px(p.y),
        )
    };
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

/// Paints the shaded old part, then every line.
pub(super) fn paint_sky(bounds: Bounds<Pixels>, segs: &[Seg], window: &mut Window) {
    let old_w = bounds.size.width * (1.0 - crate::atlas_model::sky::RECENT_SHARE_OF_WIDTH);
    let shade = Bounds::new(bounds.origin, size(old_w, bounds.size.height));
    window.paint_quad(fill(shade, Hsla::from(rgb(ROW_HOVER_BG))));
    paint_segs(bounds, segs, window);
}

/// Strokes every line, in order.
pub(super) fn paint_segs(bounds: Bounds<Pixels>, segs: &[Seg], window: &mut Window) {
    for s in segs {
        stroke(bounds, s, window);
    }
}
