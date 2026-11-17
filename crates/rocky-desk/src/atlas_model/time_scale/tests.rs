use super::*;

const MIN: u64 = 60_000;
const NOW: u64 = 100 * 60 * MIN;
const D: f32 = 1000.0;

fn at(minutes_ago: f64) -> u64 {
    NOW - (minutes_ago * MIN as f64) as u64
}

fn near(a: u64, minutes: f64) -> bool {
    (a as f64 - minutes * MIN as f64).abs() <= MIN as f64
}

#[test]
fn one_burst_then_an_idle_gap_gives_one_trailing_break() {
    let times: Vec<u64> = (0..=6).map(|m| at(18.0 - f64::from(m))).collect();
    let scale = TimeScale::build(&times, SkyWindow::Min30, NOW);
    let breaks = scale.breaks(D);
    assert_eq!(breaks.len(), 1);
    assert!(near(breaks[0].hidden_ms, 12.0), "{}", breaks[0].hidden_ms);
    let burst_w = breaks[0].x;
    assert!(burst_w >= 0.8 * D, "burst {burst_w} of {D}");
    assert_eq!(scale.x(NOW, D), D);
}

#[test]
fn two_bursts_20_minutes_apart_share_width_by_duration() {
    let first: Vec<u64> = (0..=4).map(|m| at(72.0 - f64::from(m))).collect();
    let second: Vec<u64> = (0..=8).map(|m| at(48.0 - f64::from(m))).collect();
    let times: Vec<u64> = first.iter().chain(&second).copied().collect();
    let scale = TimeScale::build(&times, SkyWindow::Hours2, NOW);
    let breaks = scale.breaks(D);
    // Between the bursts, and between the second burst and now.
    assert_eq!(breaks.len(), 2);
    assert!(near(breaks[0].hidden_ms, 16.0), "{}", breaks[0].hidden_ms);
    let w1 = breaks[0].x;
    let w2 = breaks[1].x - (breaks[0].x + BREAK_W);
    // 4 + 4 min of padding against 8 + 4 min.
    let ratio = w2 / w1;
    assert!((ratio - 12.0 / 8.0).abs() < 0.2, "ratio {ratio}");
}

#[test]
fn a_single_step_keeps_a_span_a_break_and_now() {
    let scale = TimeScale::build(&[at(5.0)], SkyWindow::Min10, NOW);
    let breaks = scale.breaks(D);
    assert_eq!(breaks.len(), 1);
    let span_w = breaks[0].x;
    assert!(span_w >= MIN_SPAN_W, "{span_w}");
    assert_eq!(scale.x(NOW, D), D);
}

#[test]
fn no_steps_is_one_short_span_ending_at_now() {
    let scale = TimeScale::build(&[], SkyWindow::Min10, NOW);
    assert!(scale.breaks(D).is_empty());
    assert_eq!(scale.x(NOW, D), D);
    assert_eq!(scale.x(NOW - 10_000, D), 0.0);
}

#[test]
fn x_is_monotonic_across_spans_and_breaks() {
    let times = [at(100.0), at(99.0), at(40.0), at(39.0), at(2.0)];
    for d in [200.0, 324.0, D] {
        let scale = TimeScale::build(&times, SkyWindow::Hours2, NOW);
        let mut last = -1.0_f32;
        for step in 0..=240u64 {
            let ms = NOW - 120 * MIN + step * MIN / 2;
            let x = scale.x(ms, d);
            assert!(x >= last, "{x} < {last} at {step}");
            assert!((0.0..=d).contains(&x));
            last = x;
        }
    }
}

#[test]
fn every_tick_lies_inside_a_span() {
    let times = [at(100.0), at(99.0), at(40.0), at(39.0), at(2.0)];
    let scale = TimeScale::build(&times, SkyWindow::Hours2, NOW);
    let breaks = scale.breaks(D);
    let ticks = scale.ticks(D);
    assert!(!ticks.is_empty());
    for t in &ticks {
        for b in &breaks {
            assert!(
                t.x <= b.x || t.x >= b.x + BREAK_W,
                "tick at {} inside break at {}",
                t.x,
                b.x
            );
        }
    }
}

#[test]
fn a_span_too_short_for_a_tick_gets_its_start_as_the_tick() {
    let scale = TimeScale::build(&[at(5.0) + 1_000], SkyWindow::Min10, NOW);
    assert!(scale.ticks(D).iter().any(|t| t.ms >= at(5.0) - 15_000));
}

#[test]
fn spans_never_get_less_than_the_floor() {
    let times = [at(110.0), at(5.0)];
    let scale = TimeScale::build(&times, SkyWindow::Hours2, NOW);
    let widths: Vec<f32> = {
        let b = scale.breaks(300.0);
        let mut edges = vec![0.0];
        for br in &b {
            edges.push(br.x);
            edges.push(br.x + BREAK_W);
        }
        edges.push(300.0);
        edges.chunks(2).map(|c| c[1] - c[0]).collect()
    };
    assert!(widths.iter().all(|w| *w >= MIN_SPAN_W - 0.01), "{widths:?}");
}

#[test]
fn hidden_time_reads_as_short_copy() {
    assert_eq!(hidden_text(45_000), "45s");
    assert_eq!(hidden_text(10 * MIN), "10m");
    assert_eq!(hidden_text(125 * MIN), "2h 5m");
    assert_eq!(hidden_text(120 * MIN), "2h");
}
