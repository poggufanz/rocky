//! Time axis of the Timeline: a broken axis that drops long idle gaps.
//!
//! Active spans share the drawable width in proportion to their duration;
//! every idle gap longer than the window's `gap_min` becomes a fixed-width
//! break that records how much time it hides. Time before the first span is
//! not drawn.

use super::SkyWindow;

/// Width of one break, in px.
pub const BREAK_W: f32 = 36.0;
/// Narrowest a span gets, so a single step is never crushed.
pub const MIN_SPAN_W: f32 = 24.0;

/// A stretch of time the axis draws.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Span {
    start: u64,
    end: u64,
}

/// A hidden idle gap between two spans.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Break {
    /// Left edge, px from the left of the drawable width.
    pub x: f32,
    pub hidden_ms: u64,
}

/// A time label position inside a span.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Tick {
    /// Px from the left of the drawable width.
    pub x: f32,
    pub ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TimeScale {
    spans: Vec<Span>,
    window: SkyWindow,
}

impl TimeScale {
    /// Builds the axis from the start times of the steps drawn in the window,
    /// ending at `now_ms`.
    pub fn build(times: &[u64], window: SkyWindow, now_ms: u64) -> TimeScale {
        let span_ms = window.secs() * 1000;
        let window_start = now_ms.saturating_sub(span_ms);
        let gap_min = (span_ms / 10).max(MIN_GAP_MS);
        let pad = span_ms / 60;
        let mut all: Vec<u64> = times
            .iter()
            .copied()
            .filter(|t| (window_start..=now_ms).contains(t))
            .collect();
        all.push(now_ms);
        all.sort_unstable();
        let mut groups: Vec<(u64, u64)> = Vec::new();
        for t in all {
            match groups.last_mut() {
                Some((_, end)) if t - *end <= gap_min => *end = t,
                _ => groups.push((t, t)),
            }
        }
        let spans = groups
            .into_iter()
            .map(|(start, end)| Span {
                start: start.saturating_sub(pad).max(window_start),
                end: (end + pad).min(now_ms),
            })
            .collect();
        TimeScale { spans, window }
    }

    /// Px of each span: proportional to its duration, never under the floor.
    fn widths(&self, d: f32) -> Vec<f32> {
        let n = self.spans.len();
        let avail = (d - BREAK_W * (n - 1) as f32).max(0.0);
        if avail <= MIN_SPAN_W * n as f32 {
            return vec![avail / n as f32; n];
        }
        let dur = |s: &Span| (s.end - s.start).max(1) as f32;
        let mut pinned = vec![false; n];
        loop {
            let pinned_w = MIN_SPAN_W * pinned.iter().filter(|p| **p).count() as f32;
            let free_dur: f32 = (0..n)
                .filter(|&i| !pinned[i])
                .map(|i| dur(&self.spans[i]))
                .sum();
            let share = |i: usize| (avail - pinned_w) * dur(&self.spans[i]) / free_dur;
            match (0..n).find(|&i| !pinned[i] && share(i) < MIN_SPAN_W) {
                Some(i) => pinned[i] = true,
                None => {
                    return (0..n)
                        .map(|i| if pinned[i] { MIN_SPAN_W } else { share(i) })
                        .collect();
                }
            }
        }
    }

    /// Left edge of each span, px.
    fn offsets(widths: &[f32]) -> Vec<f32> {
        let mut at = 0.0;
        widths
            .iter()
            .map(|w| {
                let start = at;
                at += w + BREAK_W;
                start
            })
            .collect()
    }

    /// Px of `ms` inside a drawable width `d`: 0 before the first span, `d` at
    /// or after now, and monotonic across spans and breaks.
    pub fn x(&self, ms: u64, d: f32) -> f32 {
        let widths = self.widths(d);
        let offsets = Self::offsets(&widths);
        let frac = |from: u64, to: u64| (ms - from) as f32 / (to - from).max(1) as f32;
        for (i, span) in self.spans.iter().enumerate() {
            if ms < span.start {
                return if i == 0 {
                    0.0
                } else {
                    let prev = &self.spans[i - 1];
                    offsets[i - 1] + widths[i - 1] + BREAK_W * frac(prev.end, span.start)
                };
            }
            if ms <= span.end {
                return offsets[i] + widths[i] * frac(span.start, span.end);
            }
        }
        d
    }

    /// The breaks between spans, left to right.
    pub fn breaks(&self, d: f32) -> Vec<Break> {
        let widths = self.widths(d);
        let offsets = Self::offsets(&widths);
        self.spans
            .windows(2)
            .enumerate()
            .map(|(i, pair)| Break {
                x: offsets[i] + widths[i],
                hidden_ms: pair[1].start - pair[0].end,
            })
            .collect()
    }

    /// Time ticks inside spans at the window's natural step; a span too short
    /// for one gets its start time.
    pub fn ticks(&self, d: f32) -> Vec<Tick> {
        let step = tick_step_ms(self.window);
        let mut out = Vec::new();
        for span in &self.spans {
            let mut ms = span.start.div_ceil(step) * step;
            if ms > span.end {
                ms = span.start;
            }
            while ms <= span.end {
                out.push(Tick {
                    x: self.x(ms, d),
                    ms,
                });
                ms += step;
            }
        }
        out
    }
}

/// Floor of the idle gap that becomes a break.
const MIN_GAP_MS: u64 = 60_000;

fn tick_step_ms(window: SkyWindow) -> u64 {
    match window {
        SkyWindow::Min10 => 60_000,
        SkyWindow::Min30 => 300_000,
        SkyWindow::Hours2 => 900_000,
    }
}

/// Hidden time as short copy: `45s`, `10m`, `2h 5m`.
pub fn hidden_text(ms: u64) -> String {
    let secs = ms / 1000;
    if secs < 60 {
        return format!("{secs}s");
    }
    let mins = secs / 60;
    match (mins / 60, mins % 60) {
        (0, m) => format!("{m}m"),
        (h, 0) => format!("{h}h"),
        (h, m) => format!("{h}h {m}m"),
    }
}

#[cfg(test)]
mod tests;
