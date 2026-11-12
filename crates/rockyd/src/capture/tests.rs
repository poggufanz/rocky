use super::*;
use rocky_proto::pipe::{CaptureHealth, CaptureState};
use std::collections::BTreeSet;

fn set(items: &[&str]) -> BTreeSet<String> {
    items.iter().map(|item| (*item).to_owned()).collect()
}

fn capture(consented: &[&str], extra: &[&str]) -> Capture {
    let mut cap = Capture::new(CaptureConsts::default());
    cap.set_inputs(set(consented), set(extra), true);
    cap
}

/// A capture whose child was spawned and started at time 0.
fn running(consented: &[&str], extra: &[&str]) -> Capture {
    let mut cap = capture(consented, extra);
    assert_eq!(cap.next_action(0), Some(Action::Spawn));
    cap.child_started();
    cap
}

fn roots(list: &[(&str, bool)]) -> CaptureLine {
    CaptureLine::Roots(
        list.iter()
            .map(|(root, owner)| RootOwner {
                root: (*root).to_owned(),
                owner: *owner,
            })
            .collect(),
    )
}

fn result(root: &str, coverage: Coverage, reason: Option<&str>, at_ms: u64) -> CaptureLine {
    CaptureLine::Result(Report {
        root: root.to_owned(),
        coverage,
        gaps: 0,
        reason: reason.map(str::to_owned),
        at_ms,
    })
}

fn row<'a>(health: &'a [CaptureHealth], root: &str) -> &'a CaptureHealth {
    health
        .iter()
        .find(|row| row.root == root)
        .unwrap_or_else(|| panic!("no health row for {root}"))
}

fn health_roots(cap: &Capture) -> Vec<String> {
    cap.health().into_iter().map(|row| row.root).collect()
}

fn failed_with(health: &[CaptureHealth], text: &str) -> bool {
    !health.is_empty()
        && health
            .iter()
            .all(|row| row.state == CaptureState::Failed && row.error.as_deref() == Some(text))
}

#[test]
fn spawns_when_a_repo_is_consented_and_cli_is_found() {
    let mut cap = capture(&["C:/r"], &[]);

    assert_eq!(cap.next_action(0), Some(Action::Spawn));
    cap.child_started();

    assert_eq!(cap.next_action(1), None);
    let health = cap.health();
    assert_eq!(health.len(), 1);
    assert_eq!(health[0].root, "C:/r");
    assert_eq!(health[0].state, CaptureState::Starting);
    assert_eq!(health[0].error, None);
    assert_eq!(health[0].last_reconcile_ms, None);
}

#[test]
fn no_spawn_without_consent() {
    let mut cap = capture(&[], &[]);

    assert_eq!(cap.next_action(0), None);
    assert_eq!(cap.next_action(10_000), None);
    assert!(cap.health().is_empty());
    assert!(cap.watch_roots().is_empty());
}

#[test]
fn missing_cli_fails_every_row() {
    let mut cap = Capture::new(CaptureConsts::default());
    cap.set_inputs(set(&["C:/a", "C:/b"]), set(&["C:/c"]), false);

    assert_eq!(cap.next_action(0), None);
    let health = cap.health();
    assert_eq!(health_roots(&cap), ["C:/a", "C:/b", "C:/c"]);
    assert!(failed_with(&health, CLI_MISSING));

    cap.set_inputs(set(&["C:/a", "C:/b"]), set(&["C:/c"]), true);
    assert_eq!(cap.next_action(1), Some(Action::Spawn));
    cap.child_started();
    assert!(
        cap.health()
            .iter()
            .all(|row| row.state == CaptureState::Starting)
    );
}

#[test]
fn stops_when_consent_is_gone() {
    let mut cap = running(&["C:/r"], &[]);
    cap.line(roots(&[("C:/r", true)]));
    assert_eq!(cap.watch_roots(), set(&["C:/r"]));

    cap.set_inputs(set(&[]), set(&[]), true);

    assert_eq!(cap.next_action(5), Some(Action::Stop));
    assert_eq!(cap.next_action(6), Some(Action::Stop));
    assert!(cap.health().is_empty());
    assert!(cap.watch_roots().is_empty());

    cap.child_exited();
    assert_eq!(cap.next_action(7), None);
}

#[test]
fn extra_roots_are_sent_once_per_child_start() {
    let mut cap = capture(&[], &["C:/x"]);

    assert_eq!(cap.next_action(0), Some(Action::Spawn));
    cap.child_started();
    assert_eq!(cap.next_action(0), Some(Action::Send("C:/x".into())));
    assert_eq!(cap.next_action(0), None);
    assert_eq!(cap.next_action(10_000), None);

    cap.child_exited();
    assert_eq!(cap.next_action(10_001), Some(Action::Spawn));
    cap.child_started();
    assert_eq!(cap.next_action(10_001), Some(Action::Send("C:/x".into())));
    assert_eq!(cap.next_action(10_001), None);
}

#[test]
fn events_debounce_then_respect_the_send_gap() {
    let mut cap = running(&["C:/r"], &[]);
    cap.line(roots(&[("C:/r", true)]));

    cap.fs_event("C:/r", 0);
    cap.fs_event("C:/r", 100);
    // The second poke does not push the send past 0 + 300.
    assert_eq!(cap.next_action(299), None);
    assert_eq!(cap.next_action(300), Some(Action::Send("C:/r".into())));
    assert_eq!(cap.next_action(300), None);

    // 500 + 300 is inside the 2_000 gap that follows the send at 300.
    cap.fs_event("C:/r", 500);
    assert_eq!(cap.next_action(2_299), None);
    assert_eq!(cap.next_action(2_300), Some(Action::Send("C:/r".into())));
    assert_eq!(cap.next_action(2_300), None);

    // Long after the gap, only the debounce applies.
    cap.fs_event("C:/r", 9_000);
    assert_eq!(cap.next_action(9_299), None);
    assert_eq!(cap.next_action(9_300), Some(Action::Send("C:/r".into())));
}

#[test]
fn storm_sends_once_per_gap() {
    let mut cap = running(&["C:/r"], &[]);
    cap.line(roots(&[("C:/r", true)]));

    let mut sends = Vec::new();
    for now in 0..=10_000 {
        cap.fs_event("C:/r", now);
        while let Some(action) = cap.next_action(now) {
            assert_eq!(action, Action::Send("C:/r".into()));
            sends.push(now);
        }
    }

    assert!(sends.len() <= 6, "{sends:?}");
    assert_eq!(sends, [300, 2_300, 4_300, 6_300, 8_300]);
}

#[test]
fn events_for_unowned_roots_are_ignored() {
    let mut cap = running(&["C:/a", "C:/b"], &[]);

    // No Roots line yet, so nothing is owned.
    assert!(cap.watch_roots().is_empty());
    cap.fs_event("C:/a", 0);

    cap.line(roots(&[("C:/a", true), ("C:/b", false)]));
    assert_eq!(cap.watch_roots(), set(&["C:/a"]));
    cap.fs_event("C:/b", 0);
    cap.fs_event("C:/unknown", 0);

    assert_eq!(cap.next_action(10_000), None);
}

#[test]
fn sends_only_while_the_child_runs() {
    let mut cap = running(&["C:/r"], &[]);
    cap.line(roots(&[("C:/r", true)]));
    cap.fs_event("C:/r", 0);
    cap.child_exited();

    // Not running: the only thing to do is start again.
    assert_eq!(cap.next_action(10_000), Some(Action::Spawn));
    cap.child_started();

    // The new child reconciles everything itself, so the old poke is gone.
    cap.line(roots(&[("C:/r", true)]));
    assert_eq!(cap.next_action(10_001), None);
}

#[test]
fn respawn_stops_after_three_in_five_minutes() {
    let mut cap = capture(&["C:/a"], &[]);
    for now in 0..3 {
        assert_eq!(cap.next_action(now), Some(Action::Spawn));
        cap.child_started();
        cap.child_exited();
    }

    assert_eq!(cap.next_action(3), None);
    assert!(failed_with(&cap.health(), RESTARTS));

    assert_eq!(cap.next_action(300_000), None);
    assert_eq!(cap.next_action(300_001), Some(Action::Spawn));
    cap.child_started();
    let health = cap.health();
    assert_eq!(health[0].state, CaptureState::Starting);
    assert_eq!(health[0].error, None);
}

#[test]
fn idle_and_missing_cli_consume_no_respawn_attempts() {
    let mut cap = capture(&[], &[]);
    for now in 0..10 {
        assert_eq!(cap.next_action(now), None);
    }
    cap.set_inputs(set(&["C:/a"]), set(&[]), false);
    for now in 10..20 {
        assert_eq!(cap.next_action(now), None);
    }
    cap.set_inputs(set(&["C:/a"]), set(&[]), true);

    for now in 20..23 {
        assert_eq!(cap.next_action(now), Some(Action::Spawn));
        cap.child_started();
        cap.child_exited();
    }
    assert_eq!(cap.next_action(23), None);
}

#[test]
fn a_failed_spawn_fails_every_row_until_a_start_succeeds() {
    let mut cap = capture(&["C:/a", "C:/b"], &[]);

    assert_eq!(cap.next_action(0), Some(Action::Spawn));
    cap.spawn_failed();
    assert!(failed_with(&cap.health(), SPAWN_FAILED));

    assert_eq!(cap.next_action(1), Some(Action::Spawn));
    cap.child_started();
    assert!(
        cap.health()
            .iter()
            .all(|row| row.state == CaptureState::Starting && row.error.is_none())
    );
}

#[test]
fn failed_spawns_count_toward_the_respawn_limit() {
    let mut cap = capture(&["C:/a"], &[]);
    for now in 0..3 {
        assert_eq!(cap.next_action(now), Some(Action::Spawn));
        cap.spawn_failed();
    }

    assert_eq!(cap.next_action(3), None);
    // The restart limit outranks the last spawn failure.
    assert!(failed_with(&cap.health(), RESTARTS));
}

#[test]
fn missing_cli_outranks_a_restart_limit() {
    let mut cap = capture(&["C:/a"], &[]);
    for now in 0..3 {
        assert_eq!(cap.next_action(now), Some(Action::Spawn));
        cap.child_started();
        cap.child_exited();
    }
    assert_eq!(cap.next_action(3), None);

    cap.set_inputs(set(&["C:/a"]), set(&[]), false);

    assert!(failed_with(&cap.health(), CLI_MISSING));
}

#[test]
fn roots_line_replaces_rows() {
    let mut cap = running(&["C:/a", "C:/b"], &[]);
    assert_eq!(health_roots(&cap), ["C:/a", "C:/b"]);

    cap.line(roots(&[("C:/a", true), ("C:/b", true)]));
    cap.line(result("C:/a", Coverage::Complete, None, 5));
    assert_eq!(row(&cap.health(), "C:/a").state, CaptureState::Ok);

    // C:/b was revoked; C:/a stays listed but belongs to another process now.
    cap.line(roots(&[("C:/a", false)]));
    let health = cap.health();
    assert_eq!(health_roots(&cap), ["C:/a"]);
    assert_eq!(health[0].state, CaptureState::Elsewhere);
    assert_eq!(health[0].error, None);
    assert!(cap.watch_roots().is_empty());
}

#[test]
fn a_result_is_kept_while_its_root_stays_listed() {
    let mut cap = running(&["C:/a"], &[]);
    cap.line(roots(&[("C:/a", true)]));
    cap.line(result("C:/a", Coverage::Complete, None, 5));

    cap.line(roots(&[("C:/a", true), ("C:/b", true)]));
    let health = cap.health();
    assert_eq!(row(&health, "C:/a").state, CaptureState::Ok);
    assert_eq!(row(&health, "C:/a").last_reconcile_ms, Some(5));
    assert_eq!(row(&health, "C:/b").state, CaptureState::Starting);

    cap.line(roots(&[("C:/b", true)]));
    cap.line(roots(&[("C:/a", true), ("C:/b", true)]));
    let health = cap.health();
    assert_eq!(row(&health, "C:/a").state, CaptureState::Starting);
    assert_eq!(row(&health, "C:/a").last_reconcile_ms, None);
}

#[test]
fn a_new_child_starts_with_a_clean_slate() {
    let mut cap = running(&["C:/a"], &[]);
    cap.line(roots(&[("C:/a", true)]));
    cap.line(result("C:/a", Coverage::Complete, None, 5));
    cap.child_exited();

    assert_eq!(cap.next_action(1), Some(Action::Spawn));
    cap.child_started();

    assert!(cap.watch_roots().is_empty());
    let health = cap.health();
    assert_eq!(health[0].state, CaptureState::Starting);
    assert_eq!(health[0].last_reconcile_ms, None);
}

#[test]
fn results_for_unlisted_roots_are_ignored() {
    let mut cap = running(&["C:/a"], &[]);
    cap.line(roots(&[("C:/a", true)]));

    cap.line(result("C:/zzz", Coverage::Partial, None, 9));

    assert_eq!(health_roots(&cap), ["C:/a"]);
    assert_eq!(cap.health()[0].state, CaptureState::Starting);
}

#[test]
fn result_maps_coverage_and_reason() {
    let mut cap = running(&["C:/a", "C:/b", "C:/c"], &[]);
    cap.line(roots(&[("C:/a", true), ("C:/b", true), ("C:/c", true)]));

    cap.line(result("C:/a", Coverage::Complete, None, 10));
    cap.line(result("C:/b", Coverage::Partial, None, 20));
    cap.line(result(
        "C:/c",
        Coverage::Unknown,
        Some("C:/Users/x/repo: ENOENT"),
        30,
    ));
    let health = cap.health();
    assert_eq!(row(&health, "C:/a").state, CaptureState::Ok);
    assert_eq!(row(&health, "C:/a").last_reconcile_ms, Some(10));
    assert_eq!(row(&health, "C:/a").error, None);
    assert_eq!(row(&health, "C:/b").state, CaptureState::Partial);
    assert_eq!(row(&health, "C:/b").last_reconcile_ms, Some(20));
    assert_eq!(row(&health, "C:/c").state, CaptureState::Failed);
    assert_eq!(row(&health, "C:/c").last_reconcile_ms, Some(30));
    // A path-like reason never reaches the row.
    assert_eq!(
        row(&health, "C:/c").error.as_deref(),
        Some("Capture failed.")
    );

    // The newest Result wins.
    cap.line(result("C:/c", Coverage::Complete, None, 40));
    assert_eq!(row(&cap.health(), "C:/c").state, CaptureState::Ok);
}

#[test]
fn reason_text_names_known_reasons_only() {
    assert_eq!(
        reason_text(Some("repo-consent-required")),
        "Capture is not allowed for this repo."
    );
    assert_eq!(
        reason_text(Some("git-unreadable")),
        "Git could not list the files."
    );
    assert_eq!(
        reason_text(Some("root-unusable")),
        "The repo folder cannot be read."
    );
    assert_eq!(reason_text(Some("C:/secret/repo")), "Capture failed.");
    assert_eq!(reason_text(Some("")), "Capture failed.");
    assert_eq!(reason_text(None), "Capture failed.");
}

#[test]
fn watch_failure_marks_polling() {
    let mut cap = running(&["C:/a", "C:/b"], &[]);
    cap.line(roots(&[("C:/a", true), ("C:/b", false)]));

    cap.watch_failed("C:/a");
    cap.watch_failed("C:/b");
    cap.watch_failed("C:/unknown");
    let health = cap.health();
    assert_eq!(health.len(), 2);
    assert_eq!(row(&health, "C:/a").state, CaptureState::Polling);
    assert_eq!(row(&health, "C:/a").error.as_deref(), Some(POLLING));
    // A root that another process owns is never marked polling.
    assert_eq!(row(&health, "C:/b").state, CaptureState::Elsewhere);

    // Polling outranks a good result, but not a failed one.
    cap.line(result("C:/a", Coverage::Complete, None, 7));
    assert_eq!(row(&cap.health(), "C:/a").state, CaptureState::Polling);
    cap.line(result("C:/a", Coverage::Unknown, Some("root-unusable"), 8));
    assert_eq!(row(&cap.health(), "C:/a").state, CaptureState::Failed);

    // The next Roots line clears the watch failure and keeps the last Result.
    cap.line(result("C:/a", Coverage::Complete, None, 9));
    assert_eq!(row(&cap.health(), "C:/a").state, CaptureState::Polling);
    cap.line(roots(&[("C:/a", true)]));
    let health = cap.health();
    assert_eq!(row(&health, "C:/a").state, CaptureState::Ok);
    assert_eq!(row(&health, "C:/a").error, None);
}

#[test]
fn parse_line_accepts_the_two_wire_shapes() {
    assert_eq!(
        parse_line(r#"{"v":1,"kind":"roots","roots":[{"root":"C:/r","owner":true}]}"#),
        Some(CaptureLine::Roots(vec![RootOwner {
            root: "C:/r".into(),
            owner: true,
        }]))
    );
    assert_eq!(
        parse_line(r#"{"v":1,"kind":"roots","roots":[]}"#),
        Some(CaptureLine::Roots(Vec::new()))
    );
    assert_eq!(
        parse_line(
            r#"{"v":1,"kind":"result","root":"C:/r","coverage":"complete","gaps":0,"reason":null,"at_ms":1731300000000}"#
        ),
        Some(CaptureLine::Result(Report {
            root: "C:/r".into(),
            coverage: Coverage::Complete,
            gaps: 0,
            reason: None,
            at_ms: 1_731_300_000_000,
        }))
    );
    assert_eq!(
        parse_line(
            r#"{"v":1,"kind":"result","root":"C:/r","coverage":"unknown","gaps":2,"reason":"git-unreadable","at_ms":5}"#
        ),
        Some(CaptureLine::Result(Report {
            root: "C:/r".into(),
            coverage: Coverage::Unknown,
            gaps: 2,
            reason: Some("git-unreadable".into()),
            at_ms: 5,
        }))
    );
}

#[test]
fn parse_line_rejects_garbage_and_wrong_version() {
    let garbage = [
        "",
        "   ",
        "garbage",
        "[]",
        "null",
        "42",
        "{}",
        r#"{"v":1}"#,
        r#"{"kind":"roots","roots":[]}"#,
        r#"{"v":2,"kind":"roots","roots":[]}"#,
        r#"{"v":0,"kind":"roots","roots":[]}"#,
        r#"{"v":"1","kind":"roots","roots":[]}"#,
        r#"{"v":1,"kind":"ping"}"#,
        r#"{"v":1,"kind":7}"#,
        r#"{"v":1,"kind":"roots"}"#,
        r#"{"v":1,"kind":"roots","roots":"C:/r"}"#,
        r#"{"v":1,"kind":"roots","roots":[{"root":"C:/r"}]}"#,
        r#"{"v":1,"kind":"roots","roots":[{"owner":true}]}"#,
        r#"{"v":1,"kind":"roots","roots":[{"root":"C:/r","owner":"yes"}]}"#,
        r#"{"v":1,"kind":"roots","roots":[]} trailing"#,
        r#"{"v":1,"kind":"result","root":"C:/r","coverage":"full","gaps":0,"reason":null,"at_ms":5}"#,
        r#"{"v":1,"kind":"result","root":"C:/r","coverage":"Complete","gaps":0,"reason":null,"at_ms":5}"#,
        r#"{"v":1,"kind":"result","root":"C:/r","coverage":"complete","gaps":-1,"reason":null,"at_ms":5}"#,
        r#"{"v":1,"kind":"result","root":"C:/r","coverage":"complete","gaps":0,"reason":5,"at_ms":5}"#,
        r#"{"v":1,"kind":"result","root":"C:/r","coverage":"complete","gaps":0,"reason":null,"at_ms":"5"}"#,
        r#"{"v":1,"kind":"result","root":7,"coverage":"complete","gaps":0,"reason":null,"at_ms":5}"#,
    ];
    for line in garbage {
        assert_eq!(parse_line(line), None, "{line}");
    }
}

#[test]
fn parse_line_rejects_a_result_with_any_field_missing() {
    let full = serde_json::json!({
        "v": 1,
        "kind": "result",
        "root": "C:/r",
        "coverage": "complete",
        "gaps": 0,
        "reason": null,
        "at_ms": 5,
    });
    assert!(parse_line(&full.to_string()).is_some());

    for key in ["v", "kind", "root", "coverage", "gaps", "reason", "at_ms"] {
        let mut broken = full.clone();
        broken.as_object_mut().unwrap().remove(key);
        assert_eq!(parse_line(&broken.to_string()), None, "missing {key}");
    }
}
