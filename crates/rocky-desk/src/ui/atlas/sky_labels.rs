//! Which Sky chart text fits: turn titles, star captions, and time labels.
//!
//! Positions are px on the drawable layer, whose width `d` the caller passes.
//! Text widths are estimates from the character count, so a label that is
//! shorter than its estimate may leave a gap but never overlaps.

use crate::atlas_model::sky::{RECENT_SHARE_OF_WIDTH, RowKind, SkyBand, StarKind, Tick};

pub(super) const TITLE_MAX_W: f32 = 360.0;
pub(super) const CAPTION_MAX_W: f32 = 220.0;
/// Estimated width of the "earlier" note at the band's left edge.
pub(super) const EARLIER_NOTE_W: f32 = 170.0;
/// A title keeps this far from the `//` scale mark on either side.
const BREAK_CLEAR: f32 = 8.0;
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
    a.0 < b.1 + LABEL_GAP && b.0 < a.1 + LABEL_GAP
}

/// Failed and live captions that fit. Captions of one row and side of the
/// line that would overlap give way to the newest one.
pub(super) fn visible_captions(band: &SkyBand, d: f32) -> Vec<Placed> {
    let mut order: Vec<usize> = (0..band.stars.len())
        .filter(|&i| band.stars[i].label.is_some() && band.stars[i].kind != StarKind::Plain)
        .collect();
    order.sort_by_key(|&i| std::cmp::Reverse(band.stars[i].step.ms));
    let mut kept: Vec<(usize, RowKind, bool, Span)> = Vec::new();
    for i in order {
        let star = &band.stars[i];
        let above = star.kind != StarKind::Failed;
        let side = label_side(star.x);
        let chars = caption_chars(star.label.as_deref().unwrap_or(""), star.kind);
        let span = caption_span(star.x * d, chars, side);
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
            side: label_side(band.stars[*i].x),
            max_w: CAPTION_MAX_W,
        })
        .collect();
    placed.sort_by_key(|p| p.idx);
    placed
}

/// Spans in the title strip no title may cross: the earlier note, the `//`
/// scale mark, and live captions that rise into the strip from the Edit row.
fn blocked_spans(band: &SkyBand, d: f32, captions: &[Placed]) -> Vec<Span> {
    let split = (1.0 - RECENT_SHARE_OF_WIDTH) * d;
    let mut out = vec![(split - BREAK_CLEAR, split + BREAK_CLEAR)];
    if band.earlier.is_some() {
        out.push((0.0, EARLIER_NOTE_W));
    }
    for p in captions {
        let star = &band.stars[p.idx];
        if star.row == RowKind::Edit && star.kind != StarKind::Failed {
            let chars = caption_chars(star.label.as_deref().unwrap_or(""), star.kind);
            out.push(caption_span(star.x * d, chars, p.side));
        }
    }
    out
}

/// Turn titles that fit, left to right. A title hangs right of its star while
/// at least [`TITLE_MIN_W`] is free there, else left of it, else is dropped.
pub(super) fn visible_titles(band: &SkyBand, d: f32, captions: &[Placed]) -> Vec<Placed> {
    let blocked = blocked_spans(band, d, captions);
    let mut cands: Vec<(usize, f32, usize)> = band
        .turns
        .iter()
        .enumerate()
        .filter_map(|(i, t)| {
            let chars = t.title.as_ref()?.chars().count();
            Some((i, band.stars[*t.stars.first()?].x * d, chars))
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
                max_w: left,
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

/// Time labels that fit, newest first: each clears the "now" label or the
/// label to its right by a gap.
pub(super) fn visible_ticks(ticks: &[Tick], d: f32) -> Vec<&Tick> {
    let mut limit = d - NOW_LABEL_W;
    let mut out = Vec::new();
    for t in ticks.iter().rev() {
        let c = t.x * d;
        if c + TICK_LABEL_W / 2.0 <= limit {
            out.push(t);
            limit = c - TICK_LABEL_W / 2.0 - TICK_LABEL_GAP;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use rocky_proto::pipe::{AgentKey, Status};

    use super::*;
    use crate::atlas_model::sky::{EarlierNote, Star, Turn};
    use crate::atlas_model::{SkyWindow, StepRef};

    fn key() -> AgentKey {
        AgentKey {
            session_id: "s".into(),
            agent_id: String::new(),
        }
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

    fn push_star(b: &mut SkyBand, x: f32, ms: u64, kind: StarKind, label: Option<&str>) -> usize {
        b.stars.push(Star {
            step: StepRef { key: key(), ms },
            x,
            row: RowKind::Cmd,
            radius: 2.5,
            kind,
            label: label.map(str::to_string),
        });
        b.stars.len() - 1
    }

    /// A band with one titled turn per x fraction.
    fn titled(xs: &[f32], earlier: bool) -> SkyBand {
        let mut b = empty_band();
        for (n, &x) in xs.iter().enumerate() {
            let star = push_star(&mut b, x, n as u64, StarKind::Plain, None);
            b.turns.push(Turn {
                stars: vec![star],
                live: false,
                start_ms: n as u64,
                title: Some("A long turn title that needs most of the strip to read".into()),
            });
        }
        if earlier {
            b.earlier = Some(EarlierNote {
                start_ms: 0,
                edits: 3,
            });
        }
        b
    }

    fn title_span(b: &SkyBand, d: f32, p: &Placed) -> Span {
        let s = b.stars[*b.turns[p.idx].stars.first().unwrap()].x * d;
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
        let d = 2000.0;
        let b = titled(&[0.05, 0.115, 0.5], false);
        let placed = visible_titles(&b, d, &[]);
        assert_eq!(placed.len(), 3);
        let spans: Vec<Span> = placed.iter().map(|p| title_span(&b, d, p)).collect();
        for w in spans.windows(2) {
            assert!(w[0].1 <= w[1].0, "{w:?} overlap");
        }
    }

    #[test]
    fn a_right_anchored_title_stops_at_the_earlier_note_and_the_scale_mark() {
        // d = 400: the mark spans 112..128 and the star is 50 px from the edge.
        let b = titled(&[0.875], false);
        let p = visible_titles(&b, 400.0, &[]);
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].side, Side::Right);
        let lo = title_span(&b, 400.0, &p[0]).0;
        assert!(lo >= 128.0, "{lo} crosses the mark");

        let with_note = titled(&[0.875], true);
        let p = visible_titles(&with_note, 400.0, &[]);
        let lo = title_span(&with_note, 400.0, &p[0]).0;
        assert!(lo >= EARLIER_NOTE_W, "{lo} crosses the earlier note");
    }

    #[test]
    fn a_title_over_the_scale_mark_is_skipped() {
        let d = 627.0;
        let b = titled(&[0.3], false);
        assert!(visible_titles(&b, d, &[]).is_empty());
    }

    #[test]
    fn a_live_caption_in_the_title_strip_blocks_titles() {
        let d = 1000.0;
        let mut b = titled(&[0.8], false);
        let live = push_star(&mut b, 0.85, 99, StarKind::Running, Some("Edit src/a.rs"));
        b.stars[live].row = RowKind::Edit;
        let caps = visible_captions(&b, d);
        assert_eq!(caps.len(), 1);
        assert!(visible_titles(&b, d, &caps).is_empty());
        assert_eq!(visible_titles(&b, d, &[]).len(), 1);
    }

    #[test]
    fn three_failed_captions_40_px_apart_become_the_newest_one() {
        let d = 1000.0;
        let mut b = empty_band();
        for (n, x) in [0.20, 0.24, 0.28].into_iter().enumerate() {
            push_star(
                &mut b,
                x,
                n as u64,
                StarKind::Failed,
                Some("Bash cargo test"),
            );
        }
        let caps = visible_captions(&b, d);
        assert_eq!(caps.iter().map(|c| c.idx).collect::<Vec<_>>(), vec![2]);
    }

    #[test]
    fn far_apart_failed_captions_all_stay() {
        let mut b = empty_band();
        for (n, x) in [0.05, 0.40].into_iter().enumerate() {
            push_star(
                &mut b,
                x,
                n as u64,
                StarKind::Failed,
                Some("Bash cargo test"),
            );
        }
        assert_eq!(visible_captions(&b, 1000.0).len(), 2);
    }

    fn ticks_for(window: SkyWindow) -> Vec<Tick> {
        use crate::atlas_model::ProjectId;
        use crate::cards_model::CardsModel;
        use crate::i18n::UiLang;
        use crate::view::Model;
        crate::atlas_model::sky::sky_chart(
            &Model::new(),
            &CardsModel::new(),
            &ProjectId(String::new()),
            window,
            10_000_000,
            UiLang::En,
        )
        .ticks
    }

    #[test]
    fn time_labels_never_crowd_each_other_or_the_now_label() {
        for window in [SkyWindow::Min10, SkyWindow::Min30, SkyWindow::Hours2] {
            let ticks = ticks_for(window);
            for d in [324.0, 554.0, 1100.0] {
                let kept = visible_ticks(&ticks, d);
                assert!(!kept.is_empty(), "{window:?} at {d} keeps a label");
                let centers: Vec<f32> = kept.iter().map(|t| t.x * d).collect();
                assert!(centers[0] + TICK_LABEL_W / 2.0 <= d - NOW_LABEL_W);
                for w in centers.windows(2) {
                    assert!(w[0] - w[1] >= TICK_LABEL_W + TICK_LABEL_GAP, "{w:?}");
                }
            }
        }
    }
}
