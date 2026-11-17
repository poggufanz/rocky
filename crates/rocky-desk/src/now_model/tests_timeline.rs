use rocky_proto::pipe::{Outcome, ServerMsg, Status, StatusOp, TimelineKind};

use super::tests::{agent, key, snapshot, step_entry, timeline_msg};
use super::*;
use crate::view::Model;

#[test]
fn model_caches_active_timelines_and_drops_on_completion() {
    let mut model = Model::new();
    let k1 = key("S1", "");
    let k2 = key("S2", "");

    model.apply(snapshot(vec![
        agent("S1", "", Status::Working, 50_000),
        agent("S2", "", Status::Done, 40_000),
    ]));

    // Active unopened key stores timeline; done unopened key drops it.
    model.apply(timeline_msg(
        k1.clone(),
        vec![step_entry(
            45_000,
            TimelineKind::Tool,
            Some("Bash"),
            Some("ls"),
            Some(Outcome::Ok),
            Some(1_000),
        )],
    ));
    model.apply(timeline_msg(
        k2.clone(),
        vec![step_entry(
            35_000,
            TimelineKind::Tool,
            Some("Bash"),
            Some("pwd"),
            Some(Outcome::Ok),
            Some(1_000),
        )],
    ));

    assert!(model.timeline(&k1).is_some());
    assert!(model.timeline(&k2).is_none());

    // Preserved across Snapshot while still active.
    model.apply(snapshot(vec![agent("S1", "", Status::NeedsYou, 60_000)]));
    assert!(model.timeline(&k1).is_some());

    // Transitioning S1 to Done drops its cached timeline.
    model.apply(ServerMsg::Status {
        op: StatusOp::Upsert,
        agent: agent("S1", "", Status::Done, 70_000),
    });
    assert!(model.timeline(&k1).is_none());
}

#[test]
fn timeline_fetch_debounces_500ms_flushes_trailing_and_resets() {
    let k1 = key("S1", "");
    let mut model = Model::new();
    let mut fetch = TimelineFetch::new();

    // First snapshot emits immediately at t = 1_000.
    let snap = snapshot(vec![
        agent("S1", "", Status::Working, 900),
        agent("S2", "", Status::Done, 800),
    ]);
    model.apply(snap.clone());
    assert_eq!(
        fetch.on_msg(&snap, &model.active_primary_keys(), 1_000),
        vec![k1.clone()]
    );

    // Upsert within 500 ms suppresses immediate send and schedules trailing flush.
    let upsert_fast = ServerMsg::Status {
        op: StatusOp::Upsert,
        agent: agent("S1", "", Status::Working, 1_100),
    };
    model.apply(upsert_fast.clone());
    assert!(
        fetch
            .on_msg(&upsert_fast, &model.active_primary_keys(), 1_200)
            .is_empty()
    );

    // Before 500 ms has elapsed, poll emits nothing.
    assert!(fetch.poll(&model.active_primary_keys(), 1_499).is_empty());

    // At 500 ms, poll flushes S1.
    assert_eq!(
        fetch.poll(&model.active_primary_keys(), 1_500),
        vec![k1.clone()]
    );
    // Subsequent poll with no new Upsert emits nothing.
    assert!(fetch.poll(&model.active_primary_keys(), 1_550).is_empty());

    // Leaving the active list cancels pending but preserves an unexpired cooldown timestamp.
    let upsert_pending = ServerMsg::Status {
        op: StatusOp::Upsert,
        agent: agent("S1", "", Status::NeedsYou, 1_550),
    };
    model.apply(upsert_pending.clone());
    assert!(
        fetch
            .on_msg(&upsert_pending, &model.active_primary_keys(), 1_600)
            .is_empty()
    );
    let upsert_done = ServerMsg::Status {
        op: StatusOp::Upsert,
        agent: agent("S1", "", Status::Done, 1_700),
    };
    model.apply(upsert_done.clone());
    assert!(
        fetch
            .on_msg(&upsert_done, &model.active_primary_keys(), 1_700)
            .is_empty()
    );

    // Reactivating inside the remaining cooldown (last send was at 1_500) defers until 2_000.
    let upsert_reactivate_early = ServerMsg::Status {
        op: StatusOp::Upsert,
        agent: agent("S1", "", Status::Working, 1_800),
    };
    model.apply(upsert_reactivate_early.clone());
    assert!(
        fetch
            .on_msg(
                &upsert_reactivate_early,
                &model.active_primary_keys(),
                1_800
            )
            .is_empty()
    );
    assert!(fetch.poll(&model.active_primary_keys(), 1_999).is_empty());
    assert_eq!(
        fetch.poll(&model.active_primary_keys(), 2_000),
        vec![k1.clone()]
    );

    // Transitioning to Done and staying inactive past cooldown lets later reactivation fetch right away.
    let upsert_done_again = ServerMsg::Status {
        op: StatusOp::Upsert,
        agent: agent("S1", "", Status::Done, 2_100),
    };
    model.apply(upsert_done_again.clone());
    assert!(
        fetch
            .on_msg(&upsert_done_again, &model.active_primary_keys(), 2_100)
            .is_empty()
    );
    assert!(fetch.poll(&model.active_primary_keys(), 3_000).is_empty());

    // Re-entering active fetches right away, and reset clears cooldowns immediately.
    let upsert_back = ServerMsg::Status {
        op: StatusOp::Upsert,
        agent: agent("S1", "", Status::Working, 3_100),
    };
    model.apply(upsert_back.clone());
    assert_eq!(
        fetch.on_msg(&upsert_back, &model.active_primary_keys(), 3_100),
        vec![k1.clone()]
    );

    fetch.reset();
    let reconnect = snapshot(vec![agent("S1", "", Status::Working, 3_150)]);
    model.apply(reconnect.clone());
    assert_eq!(
        fetch.on_msg(&reconnect, &model.active_primary_keys(), 3_200),
        vec![k1]
    );
}

#[test]
fn timeline_fetch_debounces_wanted_request_after_automatic_fetch() {
    let k1 = key("S1", "");
    let mut model = Model::new();
    let mut fetch = TimelineFetch::new();

    let snap = snapshot(vec![agent("S1", "", Status::Working, 900)]);
    model.apply(snap.clone());
    assert_eq!(
        fetch.on_msg(&snap, &model.active_primary_keys(), 1_000),
        vec![k1.clone()]
    );

    model.apply(timeline_msg(
        k1.clone(),
        (1..=4)
            .map(|i| {
                step_entry(
                    i * 100,
                    TimelineKind::Tool,
                    Some("Bash"),
                    Some(&format!("step-{i}")),
                    Some(Outcome::Ok),
                    Some(1_000),
                )
            })
            .collect(),
    ));

    // Wanting the key at t = 1_100 must not send another request inside 500 ms, while cached steps remain visible.
    assert!(!fetch.on_wanted(&k1, &model.active_primary_keys(), 1_100));

    assert!(fetch.poll(&model.active_primary_keys(), 1_499).is_empty());
    assert_eq!(
        fetch.poll(&model.active_primary_keys(), 1_500),
        vec![k1.clone()]
    );

    // Wanting outside the cooldown sends immediately and records last_sent for subsequent upserts.
    assert!(fetch.on_wanted(&k1, &model.active_primary_keys(), 2_100));

    let upsert = ServerMsg::Status {
        op: StatusOp::Upsert,
        agent: agent("S1", "", Status::Working, 2_200),
    };
    model.apply(upsert.clone());
    assert!(
        fetch
            .on_msg(&upsert, &model.active_primary_keys(), 2_200)
            .is_empty()
    );
    assert_eq!(fetch.poll(&model.active_primary_keys(), 2_600), vec![k1]);
}

#[test]
fn timeline_fetch_leaves_non_primary_child_requests_unthrottled() {
    let k_main = key("S1", "");
    let k_child = key("S1", "sub-1");
    let mut model = Model::new();
    let mut fetch = TimelineFetch::new();

    let snap = snapshot(vec![
        agent("S1", "", Status::Working, 900),
        agent("S1", "sub-1", Status::Working, 950),
    ]);
    model.apply(snap.clone());
    assert_eq!(
        fetch.on_msg(&snap, &model.active_primary_keys(), 1_000),
        vec![k_main.clone()]
    );

    // Wanting a non-primary child sends immediately and never enters cooldown or pending.
    assert!(fetch.on_wanted(&k_child, &model.active_primary_keys(), 1_000));
    assert!(fetch.on_wanted(&k_child, &model.active_primary_keys(), 1_200));
    assert!(fetch.poll(&model.active_primary_keys(), 1_500).is_empty());

    // Active main rows still respect the 500 ms wanted cooldown and trailing flush.
    assert!(fetch.on_wanted(&k_main, &model.active_primary_keys(), 1_600));
    assert!(!fetch.on_wanted(&k_main, &model.active_primary_keys(), 1_700));
    assert_eq!(
        fetch.poll(&model.active_primary_keys(), 2_100),
        vec![k_main]
    );
}
