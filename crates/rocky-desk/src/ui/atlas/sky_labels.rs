//! Which Sky chart text fits: turn titles, star captions, and time labels.
//!
//! Positions are px on the drawable layer, whose width `d` the caller passes
//! with the chart's [`TimeScale`].
//! Text widths are estimates from the character count. A label is capped at
//! the width reserved for it, so text wider than its estimate truncates with
//! an ellipsis instead of running into its neighbour, and text narrower than
//! the estimate only leaves a gap.

use crate::atlas_model::sky::{RowKind, SkyBand, Star, StarKind};
use crate::atlas_model::time_scale::{BREAK_W, Break, Tick, TimeScale};

pub(super) const TITLE_MAX_W: f32 = 360.0;
pub(super) const CAPTION_MAX_W: f32 = 220.0;
/// Estimated width of the "earlier" note at the band's left edge.
pub(super) const EARLIER_NOTE_W: f32 = 170.0;
/// Clear space between two labels on one line.
const LABEL_GAP: f32 = 10.0;
/// A title narrower than this is not worth drawing on its side.
const TITLE_MIN_W: f32 = 80.0;
const TITLE_CHAR_W: f32 = 7.0;
const CAPTION_CHAR_W: f32 = 6.6;
/// Characters the "failed" word adds to a failed caption.
const FAILED_SUFFIX_CHARS: usize = 7;
/// Past this share of the plot a caption grows leftward so it stays inside.
const RIGHT_ANCHOR_FROM: f32 = 0.6;
/// Width of one time label ("14:05").
pub(super) const TICK_LABEL_W: f32 = 32.0;
const TICK_LABEL_GAP: f32 = 6.0;
/// Width of the "now" label at the right end, with its gap.
pub(super) const NOW_LABEL_W: f32 = 30.0;

/// Which side of the star a label hangs from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Side {
    Left,
    Right,
}

/// Captions of stars in the right 40% of the plot end at the star.
pub(super) fn label_side(x: f32) -> Side {
    if x > RIGHT_ANCHOR_FROM {
        Side::Right
    } else {
        Side::Left
    }
}

/// The time axis at one drawable width.
#[derive(Clone, Copy)]
pub(super) struct Axis<'a> {
    pub scale: &'a TimeScale,
    pub d: f32,
}

impl Axis<'_> {
    /// Px of a star on the layer.
    pub fn x(&self, star: &Star) -> f32 {
        self.scale.x(star.step.ms, self.d)
    }

    fn side(&self, star: &Star) -> Side {
        label_side(self.x(star) / self.d)
    }
}

/// One drawn label: the turn index (titles) or star index (captions), the
/// side it hangs from, and the widest it may grow before it truncates.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct Placed {
    pub idx: usize,
    pub side: Side,
    pub max_w: f32,
}

type Span = (f32, f32);

fn caption_chars(label: &str, kind: StarKind) -> usize {
    let suffix = if kind == StarKind::Failed {
        FAILED_SUFFIX_CHARS
    } else {
        0
    };
    label.chars().count() + suffix
}

fn caption_span(s: f32, chars: usize, side: Side) -> Span {
    let w = (chars as f32 * CAPTION_CHAR_W).min(CAPTION_MAX_W);
    match side {
        Side::Left => (s, s + w),
        Side::Right => (s - w, s),
    }
}

fn overlaps(a: Span, b: Span) -> bool {
    overlaps_by(a, b, LABEL_GAP)
}

/// Failed and live captions that fit. Captions of one row and side of the
/// line that would overlap give way to the newest one.
pub(super) fn visible_captions(band: &SkyBand, ax: Axis<'_>) -> Vec<Placed> {
    let mut order: Vec<usize> = (0..band.stars.len())
        .filter(|&i| band.stars[i].label.is_some() && band.stars[i].kind != StarKind::Plain)
        .collect();
    order.sort_by_key(|&i| std::cmp::Reverse(band.stars[i].step.ms));
    let mut kept: Vec<(usize, RowKind, bool, Span)> = Vec::new();
    for i in order {
        let star = &band.stars[i];
        let above = star.kind != StarKind::Failed;
        let side = ax.side(star);
        let chars = caption_chars(star.label.as_deref().unwrap_or(""), star.kind);
        let span = caption_span(ax.x(star), chars, side);
        let clash = kept
            .iter()
            .any(|(_, row, up, s)| *row == star.row && *up == above && overlaps(*s, span));
        if !clash {
            kept.push((i, star.row, above, span));
        }
    }
    let mut placed: Vec<Placed> = kept
        .iter()
        .map(|(i, ..)| Placed {
            idx: *i,
            side: ax.side(&band.stars[*i]),
            max_w: CAPTION_MAX_W,
        })
        .collect();
    placed.sort_by_key(|p| p.idx);
    placed
}

/// Spans in the title strip no title may cross: the earlier note, the breaks
/// with their `//` mark, and live captions that rise into the strip from the
/// Edit row.
fn blocked_spans(band: &SkyBand, ax: Axis<'_>, captions: &[Placed]) -> Vec<Span> {
    let mut out: Vec<Span> = ax
        .scale
        .breaks(ax.d)
        .iter()
        .map(|b| (b.x, b.x + BREAK_W))
        .collect();
    if band.earlier.is_some() {
        out.push((0.0, EARLIER_NOTE_W));
    }
    for p in captions {
        let star = &band.stars[p.idx];
        if star.row == RowKind::Edit && star.kind != StarKind::Failed {
            let chars = caption_chars(star.label.as_deref().unwrap_or(""), star.kind);
            out.push(caption_span(ax.x(star), chars, p.side));
        }
    }
    out
}

/// Turn titles that fit, left to right. A title hangs right of its star while
/// at least [`TITLE_MIN_W`] is free there, else left of it, else is dropped.
pub(super) fn visible_titles(band: &SkyBand, ax: Axis<'_>, captions: &[Placed]) -> Vec<Placed> {
    let d = ax.d;
    let blocked = blocked_spans(band, ax, captions);
    let mut cands: Vec<(usize, f32, usize)> = band
        .turns
        .iter()
        .enumerate()
        .filter_map(|(i, t)| {
            let chars = t.title.as_ref()?.chars().count();
            Some((i, ax.x(&band.stars[*t.stars.first()?]), chars))
        })
        .collect();
    cands.sort_by(|a, b| a.1.total_cmp(&b.1));
    let mut free_from = 0.0_f32;
    let mut out = Vec::new();
    for (n, &(idx, s, chars)) in cands.iter().enumerate() {
        if blocked.iter().any(|&(lo, hi)| lo < s && s < hi) {
            continue;
        }
        let wall = blocked
            .iter()
            .map(|&(lo, _)| lo)
            .filter(|&lo| lo > s)
            .chain(cands.get(n + 1).map(|c| c.1))
            .fold(d, f32::min);
        let left = TITLE_MAX_W.min(wall - s - LABEL_GAP).min(d - s);
        if s >= free_from && left >= TITLE_MIN_W {
            let used = (chars as f32 * TITLE_CHAR_W).min(left);
            free_from = s + used + LABEL_GAP;
            out.push(Placed {
                idx,
                side: Side::Left,
                max_w: used,
            });
            continue;
        }
        let floor = blocked
            .iter()
            .map(|&(_, hi)| hi)
            .filter(|&hi| hi <= s)
            .fold(free_from, f32::max);
        let right = TITLE_MAX_W.min(s - floor - LABEL_GAP);
        if right >= TITLE_MIN_W {
            free_from = s;
            out.push(Placed {
                idx,
                side: Side::Right,
                max_w: right,
            });
        }
    }
    out
}

/// Time labels that fit, newest first: each clears the "now" label, the label
/// to its right, and every break's duration label.
pub(super) fn visible_ticks<'a>(ticks: &'a [Tick], breaks: &[Break], d: f32) -> Vec<&'a Tick> {
    let mut limit = d - NOW_LABEL_W;
    let mut out = Vec::new();
    for t in ticks.iter().rev() {
        let c = t.x;
        let (lo, hi) = (c - TICK_LABEL_W / 2.0, c + TICK_LABEL_W / 2.0);
        let on_break = breaks
            .iter()
            .any(|b| overlaps_by((lo, hi), (b.x, b.x + BREAK_W), TICK_LABEL_GAP));
        if hi <= limit && !on_break {
            out.push(t);
            limit = lo - TICK_LABEL_GAP;
        }
    }
    out
}

fn overlaps_by(a: Span, b: Span, gap: f32) -> bool {
    a.0 < b.1 + gap && b.0 < a.1 + gap
}

#[cfg(test)]
mod tests {
    use rocky_proto::pipe::{AgentKey, Status};

    use super::*;
    use crate::atlas_model::SkyWindow;
    use crate::atlas_model::StepRef;
    use crate::atlas_model::sky::{EarlierNote, Turn};

    const NOW: u64 = 100_000_000;

    fn key() -> AgentKey {
        AgentKey {
            session_id: "s".into(),
            agent_id: String::new(),
        }
    }

    /// One 10 s span ending now: `ms_at(f)` sits at fraction `f` of the width.
    fn flat() -> TimeScale {
        TimeScale::build(&[], SkyWindow::Min10, NOW)
    }

    fn ms_at(f: f32) -> u64 {
        NOW - ((1.0 - f) * 10_000.0) as u64
    }

    /// Two spans with one break: the first holds `[NOW-550s, NOW-530s]`, the
    /// second `[NOW-10s, NOW]`.
    fn broken() -> TimeScale {
        TimeScale::build(&[NOW - 540_000], SkyWindow::Min10, NOW)
    }

    fn early_ms(f: f32) -> u64 {
        NOW - 550_000 + (f * 20_000.0) as u64
    }

    fn empty_band() -> SkyBand {
        SkyBand {
            key: key(),
            harness: None,
            branch: None,
            status: Status::Idle,
            subs: vec![],
            stars: vec![],
            turns: vec![],
            quiet: None,
            earlier: None,
        }
    }

    fn push_star(b: &mut SkyBand, ms: u64, kind: StarKind, label: Option<&str>) -> usize {
        b.stars.push(Star {
            step: StepRef { key: key(), ms },
            row: RowKind::Cmd,
            radius: 2.5,
            kind,
            label: label.map(str::to_string),
        });
        b.stars.len() - 1
    }

    fn push_turn(b: &mut SkyBand, ms: u64, title: &str) {
        let star = push_star(b, ms, StarKind::Plain, None);
        b.turns.push(Turn {
            stars: vec![star],
            live: false,
            start_ms: ms,
            title: Some(title.into()),
        });
    }

    const LONG: &str = "A long turn title that needs most of the strip to read";

    fn title_span(b: &SkyBand, ax: Axis<'_>, p: &Placed) -> Span {
        let s = ax.x(&b.stars[*b.turns[p.idx].stars.first().unwrap()]);
        match p.side {
            Side::Left => (s, s + p.max_w),
            Side::Right => (s - p.max_w, s),
        }
    }

    #[test]
    fn captions_in_the_right_forty_percent_end_at_the_star() {
        assert_eq!(label_side(0.59), Side::Left);
        assert_eq!(label_side(0.61), Side::Right);
        assert_eq!(label_side(1.0), Side::Right);
    }

    #[test]
    fn long_titles_130_px_apart_do_not_overlap() {
        let scale = flat();
        let ax = Axis {
            scale: &scale,
            d: 2000.0,
        };
        let mut b = empty_band();
        for f in [0.05, 0.115, 0.5] {
            push_turn(&mut b, ms_at(f), LONG);
        }
        let placed = visible_titles(&b, ax, &[]);
        assert_eq!(placed.len(), 3);
        let spans: Vec<Span> = placed.iter().map(|p| title_span(&b, ax, p)).collect();
        for w in spans.windows(2) {
            assert!(w[0].1 <= w[1].0, "{w:?} overlap");
        }
    }

    #[test]
    fn a_left_title_is_capped_at_the_width_the_cursor_reserved() {
        let scale = flat();
        let ax = Axis {
            scale: &scale,
            d: 400.0,
        };
        let mut b = empty_band();
        for f in [0.35, 0.875] {
            push_turn(&mut b, ms_at(f), "ABCDEFGHIJ");
        }
        let placed = visible_titles(&b, ax, &[]);
        assert_eq!(placed.len(), 2);
        assert_eq!(placed[0].side, Side::Left);
        assert_eq!(placed[0].max_w, 70.0);
        assert_eq!(placed[1].side, Side::Right);
        let reserved_end = ax.x(&b.stars[0]) + 70.0 + LABEL_GAP;
        let lo = title_span(&b, ax, &placed[1]).0;
        assert!(
            lo >= reserved_end + LABEL_GAP - 0.5,
            "{lo} overlaps the left title"
        );
    }

    #[test]
    fn a_right_anchored_title_stops_at_the_break_and_the_earlier_note() {
        let scale = broken();
        let ax = Axis {
            scale: &scale,
            d: 400.0,
        };
        let mut b = empty_band();
        push_turn(&mut b, ms_at(0.9), LONG);
        let p = visible_titles(&b, ax, &[]);
        assert_eq!(p[0].side, Side::Right);
        let brk = scale.breaks(400.0)[0];
        let lo = title_span(&b, ax, &p[0]).0;
        assert!(lo >= brk.x + BREAK_W, "{lo} crosses the break");

        let flat_scale = flat();
        let ax = Axis {
            scale: &flat_scale,
            d: 400.0,
        };
        let mut with_note = empty_band();
        push_turn(&mut with_note, ms_at(0.875), LONG);
        with_note.earlier = Some(EarlierNote {
            start_ms: 0,
            edits: 3,
        });
        let p = visible_titles(&with_note, ax, &[]);
        let lo = title_span(&with_note, ax, &p[0]).0;
        assert!(lo >= EARLIER_NOTE_W, "{lo} crosses the earlier note");
    }

    #[test]
    fn a_title_before_a_break_never_runs_across_it() {
        let scale = broken();
        let ax = Axis {
            scale: &scale,
            d: 1000.0,
        };
        let mut b = empty_band();
        push_turn(&mut b, early_ms(0.9), LONG);
        let p = visible_titles(&b, ax, &[]);
        assert_eq!(p.len(), 1);
        let brk = scale.breaks(1000.0)[0];
        assert!(title_span(&b, ax, &p[0]).1 <= brk.x);
    }

    #[test]
    fn a_live_caption_in_the_title_strip_blocks_titles() {
        let scale = flat();
        let ax = Axis {
            scale: &scale,
            d: 1000.0,
        };
        let mut b = empty_band();
        push_turn(&mut b, ms_at(0.8), LONG);
        let live = push_star(
            &mut b,
            ms_at(0.85),
            StarKind::Running,
            Some("Edit src/a.rs"),
        );
        b.stars[live].row = RowKind::Edit;
        let caps = visible_captions(&b, ax);
        assert_eq!(caps.len(), 1);
        assert!(visible_titles(&b, ax, &caps).is_empty());
        assert_eq!(visible_titles(&b, ax, &[]).len(), 1);
    }

    #[test]
    fn three_failed_captions_40_px_apart_become_the_newest_one() {
        let scale = flat();
        let ax = Axis {
            scale: &scale,
            d: 1000.0,
        };
        let mut b = empty_band();
        for f in [0.20, 0.24, 0.28] {
            push_star(&mut b, ms_at(f), StarKind::Failed, Some("Bash cargo test"));
        }
        let caps = visible_captions(&b, ax);
        assert_eq!(caps.iter().map(|c| c.idx).collect::<Vec<_>>(), vec![2]);
    }

    #[test]
    fn far_apart_failed_captions_all_stay() {
        let scale = flat();
        let ax = Axis {
            scale: &scale,
            d: 1000.0,
        };
        let mut b = empty_band();
        for f in [0.05, 0.40] {
            push_star(&mut b, ms_at(f), StarKind::Failed, Some("Bash cargo test"));
        }
        assert_eq!(visible_captions(&b, ax).len(), 2);
    }

    #[test]
    fn time_labels_never_crowd_each_other_the_now_label_or_a_break() {
        for window in [SkyWindow::Min10, SkyWindow::Min30, SkyWindow::Hours2] {
            let ms = window.secs() * 1000;
            let times = [NOW - ms * 9 / 10, NOW - ms * 9 / 10 + 40_000, NOW - 30_000];
            let scale = TimeScale::build(&times, window, NOW);
            for d in [324.0, 554.0, 1100.0] {
                let ticks = scale.ticks(d);
                let breaks = scale.breaks(d);
                let kept = visible_ticks(&ticks, &breaks, d);
                assert!(!kept.is_empty(), "{window:?} at {d} keeps a label");
                assert!(kept[0].x + TICK_LABEL_W / 2.0 <= d - NOW_LABEL_W);
                for w in kept.windows(2) {
                    assert!(w[0].x - w[1].x >= TICK_LABEL_W + TICK_LABEL_GAP);
                }
                for t in &kept {
                    for b in &breaks {
                        let (lo, hi) = (t.x - TICK_LABEL_W / 2.0, t.x + TICK_LABEL_W / 2.0);
                        assert!(hi <= b.x || lo >= b.x + BREAK_W, "tick {} over break", t.x);
                    }
                }
            }
        }
    }
}
