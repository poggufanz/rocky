use rocky_proto::pipe::{Outcome, ServerMsg, Status, StatusOp, TimelineEntry, TimelineKind};

use super::tests::{agent, key, snapshot, step_entry, timeline_msg};
use super::*;

#[test]
fn turn_steps_slice_after_last_turn_start_and_compute_marks() {
    let mut model = Model::new();
    let k_work = key("S1", "");
    let k_need = key("S2", "");
    let k_noturn = key("S3", "");
    let k_trailing_work = key("S4", "");
    let k_trailing_need = key("S5", "");

    model.apply(snapshot(vec![
        agent("S1", "", Status::Working, 90_000),
        agent("S2", "", Status::NeedsYou, 95_000),
        agent("S3", "", Status::NeedsYou, 85_000),
        agent("S4", "", Status::Working, 82_000),
        agent("S5", "", Status::NeedsYou, 75_000),
    ]));

    model.apply(timeline_msg(
        k_work.clone(),
        vec![
            step_entry(1_000, TimelineKind::TurnStart, None, None, None, None),
            step_entry(
                2_000,
                TimelineKind::Tool,
                Some("Bash"),
                Some("old turn"),
                Some(Outcome::Ok),
                Some(1_000),
            ),
            step_entry(10_000, TimelineKind::TurnStart, None, None, None, None),
            step_entry(
                11_000,
                TimelineKind::SubagentStart,
                None,
                Some("ignored"),
                None,
                None,
            ),
            step_entry(
                12_000,
                TimelineKind::Tool,
                Some("Edit"),
                Some("src/a.rs"),
                Some(Outcome::Ok),
                Some(2_000),
            ),
            step_entry(
                15_000,
                TimelineKind::Tool,
                Some("Bash"),
                Some("cargo check"),
                Some(Outcome::Pending),
                None,
            ),
            step_entry(
                20_000,
                TimelineKind::Tool,
                Some("Bash"),
                Some("cargo test"),
                Some(Outcome::Pending),
                None,
            ),
        ],
    ));

    model.apply(timeline_msg(
        k_need.clone(),
        vec![
            step_entry(
                50_000,
                TimelineKind::Tool,
                Some("Bash"),
                Some("git diff"),
                Some(Outcome::Failed),
                Some(65_000),
            ),
            step_entry(
                92_000,
                TimelineKind::NeedsYou,
                Some("Bash"),
                Some("rm -rf tmp"),
                Some(Outcome::Pending),
                None,
            ),
        ],
    ));

    // When agent is NeedsYou but latest timeline step is a Tool (not NeedsYou), mark is Ok.
    model.apply(timeline_msg(
        k_noturn.clone(),
        vec![step_entry(
            80_000,
            TimelineKind::Tool,
            Some("Bash"),
            Some("ls"),
            Some(Outcome::Pending),
            None,
        )],
    ));

    // Pending Tool followed by a trailing non-step entry is no longer latest, so it settles as Ok.
    model.apply(timeline_msg(
        k_trailing_work,
        vec![
            step_entry(
                70_000,
                TimelineKind::Tool,
                Some("Bash"),
                Some("cargo build"),
                Some(Outcome::Pending),
                None,
            ),
            step_entry(
                81_000,
                TimelineKind::SubagentStart,
                None,
                Some("review"),
                None,
                None,
            ),
        ],
    ));

    // Pending NeedsYou followed by a trailing non-step entry is no longer latest, so it settles as Ok.
    model.apply(timeline_msg(
        k_trailing_need,
        vec![
            step_entry(
                72_000,
                TimelineKind::NeedsYou,
                Some("Bash"),
                Some("git push"),
                Some(Outcome::Pending),
                None,
            ),
            step_entry(
                74_000,
                TimelineKind::SubagentStart,
                None,
                Some("follow-up"),
                None,
                None,
            ),
        ],
    ));

    let view = now_view(&model, &CardsModel::new(), 100_000, UiLang::En);
    // Order: S2 (NeedsYou, 95s), S3 (NeedsYou, 85s), S5 (NeedsYou, 75s), S1 (Working, 90s), S4 (Working, 82s)
    assert_eq!(
        view.active[0].steps,
        vec![
            LiveStep {
                mark: StepMark::Failed,
                title: "git diff".to_string(),
                dur: "1m 5s".to_string(),
            },
            LiveStep {
                mark: StepMark::Waiting,
                title: "rm -rf tmp \u{00b7} waiting for approval".to_string(),
                dur: "8s".to_string(),
            },
        ]
    );
    assert_eq!(
        view.active[1].steps,
        vec![LiveStep {
            mark: StepMark::Ok,
            title: "ls".to_string(),
            dur: "".to_string(),
        }]
    );
    assert_eq!(
        view.active[2].steps,
        vec![LiveStep {
            mark: StepMark::Ok,
            title: "git push \u{00b7} waiting for approval".to_string(),
            dur: "".to_string(),
        }]
    );
    // Non-latest Pending entry settles as Ok with "" dur; latest Pending Tool while Working is Running with now - ms.
    assert_eq!(
        view.active[3].steps,
        vec![
            LiveStep {
                mark: StepMark::Ok,
                title: "edit src/a.rs".to_string(),
                dur: "2s".to_string(),
            },
            LiveStep {
                mark: StepMark::Ok,
                title: "cargo check".to_string(),
                dur: "".to_string(),
            },
            LiveStep {
                mark: StepMark::Running,
                title: "cargo test".to_string(),
                dur: "1m 20s".to_string(),
            },
        ]
    );
    assert_eq!(
        view.active[4].steps,
        vec![LiveStep {
            mark: StepMark::Ok,
            title: "cargo build".to_string(),
            dur: "".to_string(),
        }]
    );
}

#[test]
fn step_titles_and_durations_format_for_tools_and_approval() {
    let mut model = Model::new();
    let k = key("S1", "");
    model.apply(snapshot(vec![agent("S1", "", Status::NeedsYou, 90_000)]));
    model.toggle_open(&k);
    model.apply(timeline_msg(
        k,
        vec![
            step_entry(
                10_000,
                TimelineKind::Tool,
                Some("Write"),
                Some("a.rs\nnext"),
                Some(Outcome::Ok),
                Some(0),
            ),
            step_entry(
                11_000,
                TimelineKind::Tool,
                Some("MultiEdit"),
                None,
                Some(Outcome::Ok),
                Some(60_000),
            ),
            step_entry(
                12_000,
                TimelineKind::Tool,
                Some("NotebookEdit"),
                Some("nb.ipynb"),
                Some(Outcome::Ok),
                None,
            ),
            step_entry(
                13_000,
                TimelineKind::Tool,
                Some("Bash"),
                None,
                Some(Outcome::Ok),
                Some(5_000),
            ),
            step_entry(
                14_000,
                TimelineKind::Tool,
                Some("Grep"),
                Some("SessionCard"),
                Some(Outcome::Ok),
                Some(1_000),
            ),
            step_entry(
                15_000,
                TimelineKind::Tool,
                Some("Read"),
                None,
                Some(Outcome::Ok),
                Some(1_000),
            ),
            step_entry(
                16_000,
                TimelineKind::NeedsYou,
                Some("Edit"),
                None,
                None,
                None,
            ),
            step_entry(92_000, TimelineKind::NeedsYou, None, None, None, None),
        ],
    ));

    let view_en = now_view(&model, &CardsModel::new(), 100_000, UiLang::En);
    let titles: Vec<&str> = view_en.active[0]
        .steps
        .iter()
        .map(|s| s.title.as_str())
        .collect();
    assert_eq!(
        titles,
        vec![
            "edit a.rs next",
            "edit",
            "edit nb.ipynb",
            "bash",
            "grep SessionCard",
            "read",
            "Edit \u{00b7} waiting for approval",
            "waiting for approval",
        ]
    );
    assert_eq!(view_en.active[0].steps[0].dur, "0s");
    assert_eq!(view_en.active[0].steps[1].dur, "1m");
    assert_eq!(view_en.active[0].steps[2].dur, "");
    assert_eq!(view_en.active[0].steps[7].dur, "8s");
    assert_eq!(view_en.active[0].steps[7].mark, StepMark::Waiting);

    let view_id = now_view(&model, &CardsModel::new(), 100_000, UiLang::Id);
    assert_eq!(
        view_id.active[0].steps[6].title,
        "Edit \u{00b7} menunggu izin"
    );
    assert_eq!(view_id.active[0].steps[7].title, "menunggu izin");
}

#[test]
fn step_list_folds_to_last_three_unless_expanded() {
    let mut model = Model::new();
    let k = key("S1", "");
    model.apply(snapshot(vec![agent("S1", "", Status::Working, 90_000)]));

    let entries: Vec<TimelineEntry> = (1..=5)
        .map(|i| {
            step_entry(
                i * 1_000,
                TimelineKind::Tool,
                Some("Bash"),
                Some(&format!("cmd-{i}")),
                Some(Outcome::Ok),
                Some(1_000),
            )
        })
        .collect();

    // Even before toggle_open, active main key timeline is cached.
    model.apply(timeline_msg(k.clone(), entries));

    let collapsed = now_view(&model, &CardsModel::new(), 100_000, UiLang::En);
    assert!(!collapsed.active[0].expanded);
    assert_eq!(collapsed.active[0].hidden_steps, 2);
    let collapsed_titles: Vec<&str> = collapsed.active[0]
        .steps
        .iter()
        .map(|s| s.title.as_str())
        .collect();
    assert_eq!(collapsed_titles, vec!["cmd-3", "cmd-4", "cmd-5"]);

    model.toggle_open(&k);
    let expanded = now_view(&model, &CardsModel::new(), 100_000, UiLang::En);
    assert!(expanded.active[0].expanded);
    assert_eq!(expanded.active[0].hidden_steps, 0);
    assert_eq!(expanded.active[0].steps.len(), 5);
}

#[test]
fn model_caches_active_timelines_without_open_and_drops_on_completion() {
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
    // Legacy timeline_rows remains empty while row is collapsed.
    assert!(model.timeline_rows(&k1, &crate::clock::utc_hhmm).is_empty());

    // Preserved across Snapshot while still active.
    model.apply(snapshot(vec![agent("S1", "", Status::NeedsYou, 60_000)]));
    assert!(model.timeline(&k1).is_some());

    // Expanding and collapsing keeps cache while S1 stays active.
    model.toggle_open(&k1);
    assert!(model.timeline(&k1).is_some());
    model.toggle_open(&k1);
    assert!(model.timeline(&k1).is_some());

    // Expanding S1 then transitioning it to Done drops its cached timeline.
    model.toggle_open(&k1);
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
fn timeline_fetch_debounces_expansion_after_automatic_fetch() {
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

    // Expanding at t = 1_100 must not send another request inside 500 ms, while cached steps remain visible.
    let opened = model.toggle_open(&k1).expect("row should open");
    assert!(!fetch.on_open(&opened, &model.active_primary_keys(), 1_100));
    let view = now_view(&model, &CardsModel::new(), 1_100, UiLang::En);
    assert!(view.active[0].expanded);
    assert_eq!(view.active[0].hidden_steps, 0);
    assert_eq!(view.active[0].steps.len(), 4);

    assert!(fetch.poll(&model.active_primary_keys(), 1_499).is_empty());
    assert_eq!(
        fetch.poll(&model.active_primary_keys(), 1_500),
        vec![k1.clone()]
    );

    // Expanding outside the cooldown sends immediately and records last_sent for subsequent upserts.
    model.toggle_open(&k1);
    let reopened = model.toggle_open(&k1).expect("row should reopen");
    assert!(fetch.on_open(&reopened, &model.active_primary_keys(), 2_100));

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
fn timeline_fetch_leaves_non_primary_child_expansions_unthrottled() {
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

    // Expanding a non-primary child sends immediately and never enters cooldown or pending.
    assert!(fetch.on_open(&k_child, &model.active_primary_keys(), 1_000));
    assert!(fetch.on_open(&k_child, &model.active_primary_keys(), 1_200));
    assert!(fetch.poll(&model.active_primary_keys(), 1_500).is_empty());

    // Active main rows still respect the 500 ms expansion cooldown and trailing flush.
    assert!(fetch.on_open(&k_main, &model.active_primary_keys(), 1_600));
    assert!(!fetch.on_open(&k_main, &model.active_primary_keys(), 1_700));
    assert_eq!(
        fetch.poll(&model.active_primary_keys(), 2_100),
        vec![k_main]
    );
}

#[test]
fn subrow_expands_and_formats_all_current_turn_steps_when_open() {
    let mut model = Model::new();
    let k_child = key("S1", "sub-1");
    model.apply(snapshot(vec![
        agent("S1", "", Status::Working, 90_000),
        agent("S1", "sub-1", Status::Working, 95_000),
    ]));

    let entries: Vec<TimelineEntry> = (1..=4)
        .map(|i| {
            step_entry(
                i * 1_000,
                TimelineKind::Tool,
                Some("Read"),
                Some(&format!("file-{i}.rs")),
                if i == 4 {
                    Some(Outcome::Pending)
                } else {
                    Some(Outcome::Ok)
                },
                (i < 4).then_some(1_000),
            )
        })
        .collect();

    let collapsed = now_view(&model, &CardsModel::new(), 10_000, UiLang::En);
    assert!(!collapsed.active[0].subs[0].expanded);
    assert!(collapsed.active[0].subs[0].steps.is_empty());

    model.toggle_open(&k_child);
    model.apply(timeline_msg(k_child, entries));

    let expanded = now_view(&model, &CardsModel::new(), 10_000, UiLang::En);
    let sub = &expanded.active[0].subs[0];
    assert!(sub.expanded);
    assert_eq!(sub.steps.len(), 4);
    assert_eq!(sub.steps[0].mark, StepMark::Ok);
    assert_eq!(sub.steps[0].title, "read file-1.rs");
    assert_eq!(sub.steps[0].dur, "1s");
    assert_eq!(sub.steps[3].mark, StepMark::Running);
    assert_eq!(sub.steps[3].title, "read file-4.rs");
    assert_eq!(sub.steps[3].dur, "6s");
}
