use rocky_proto::cards::{Card, CardStatus, Coverage, CoverageState, Importance};
use rocky_proto::pipe::{
    Action, AgentKey, AgentStatus, Health, Outcome, PromptText, RepoInfo, ServerMsg, Status,
    StatusOp, TimelineEntry, TimelineKind,
};
use rocky_proto::settings::Settings;

use super::*;

fn key(session: &str, agent: &str) -> AgentKey {
    AgentKey {
        session_id: session.to_string(),
        agent_id: agent.to_string(),
    }
}

fn agent(session: &str, agent_id: &str, status: Status, last_event_ms: u64) -> AgentStatus {
    AgentStatus {
        key: key(session, agent_id),
        agent_type: None,
        status,
        action: None,
        summary: None,
        description: None,
        failures: 0,
        last_event_ms,
        quiet_10m: false,
        repo: RepoInfo {
            root: Some("/repos/rocky".to_string()),
            main_root: None,
            name: "rocky".to_string(),
            branch: Some("main".to_string()),
        },
        prompt: None,
    }
}

fn snapshot(agents: Vec<AgentStatus>) -> ServerMsg {
    ServerMsg::Snapshot {
        agents,
        aggregate: Status::Idle,
        health: Health::default(),
        settings: Settings::default(),
        repo_pending: Vec::new(),
    }
}

fn timeline_msg(key: AgentKey, entries: Vec<TimelineEntry>) -> ServerMsg {
    ServerMsg::Timeline {
        id: 1,
        key,
        entries,
    }
}

fn step_entry(
    ms: u64,
    kind: TimelineKind,
    tool_name: Option<&str>,
    text: Option<&str>,
    outcome: Option<Outcome>,
    dur_ms: Option<u64>,
) -> TimelineEntry {
    TimelineEntry {
        ms,
        kind,
        tool_name: tool_name.map(str::to_string),
        text: text.map(str::to_string),
        outcome,
        dur_ms,
    }
}

fn dummy_card(
    card_id: &str,
    session_id: &str,
    agent_id: &str,
    started_ms: u64,
    ended_ms: Option<u64>,
) -> Card {
    Card {
        v: 1,
        card_id: card_id.to_string(),
        rev: 1,
        repo_id: "r1".to_string(),
        root: "/repos/rocky".to_string(),
        main_root: None,
        branch: Some("main".to_string()),
        session_id: session_id.to_string(),
        agent_id: agent_id.to_string(),
        agent_type: if agent_id.is_empty() {
            "main".to_string()
        } else {
            "Explore".to_string()
        },
        parent_card_id: None,
        started_ms,
        ended_ms,
        status: CardStatus::Done,
        prompt: "fix bugs".to_string(),
        prompt_truncated: false,
        importance: Importance::Low,
        blocks: Vec::new(),
        more_count: 0,
        flow: Vec::new(),
        flow_more: 0,
        outside_count: 0,
        coverage: Coverage {
            state: CoverageState::Full,
            reasons: Vec::new(),
        },
    }
}

fn cards_with(items: Vec<Card>) -> CardsModel {
    let mut cards = CardsModel::new();
    let _ = cards.request_first_page(1);
    cards.on_cards(1, items, None);
    cards
}

#[test]
fn empty_model_builds_empty_now_view() {
    let model = Model::new();
    let cards = CardsModel::new();
    let view = now_view(&model, &cards, 100_000, UiLang::En);
    assert_eq!(view.active_count, 0);
    assert_eq!(view.needs_count, 0);
    assert!(view.active.is_empty());
    assert!(view.finished.is_empty());
    assert!(view.idle.is_empty());
}

#[test]
fn active_cards_sort_needs_you_first_then_newest_activity() {
    let mut model = Model::new();
    let mut work_new = agent("S1-work-new", "", Status::Working, 95_000);
    work_new.failures = 1;
    let work_old = agent("S2-work-old", "", Status::Working, 80_000);
    let mut need_old = agent("S3-need-old", "", Status::NeedsYou, 70_000);
    need_old.failures = 2;
    let need_new = agent("S4-need-new", "", Status::NeedsYou, 90_000);

    model.apply(snapshot(vec![work_old, need_old, work_new, need_new]));
    let view = now_view(&model, &CardsModel::new(), 100_000, UiLang::En);

    assert_eq!(view.active_count, 4);
    assert_eq!(view.needs_count, 2);
    let order: Vec<&str> = view
        .active
        .iter()
        .map(|c| c.key.session_id.as_str())
        .collect();
    assert_eq!(
        order,
        vec!["S4-need-new", "S3-need-old", "S1-work-new", "S2-work-old"]
    );
    assert_eq!(view.active[1].failures, 2);
    assert_eq!(view.active[2].failures, 1);
    assert_eq!(view.active[0].timer, "10s");
}

#[test]
fn finished_and_idle_sessions_partition_and_sort_newest_first() {
    let mut model = Model::new();
    let mut done_old = agent("done-session-old", "", Status::Done, 40_000);
    done_old.failures = 3;
    let failed_new = agent("failed-session-new", "", Status::Failed, 80_000);

    let mut idle_old = agent("idle123456", "", Status::Idle, 50_000);
    idle_old.repo.name = "   ".to_string();
    idle_old.repo.branch = Some("   ".to_string());

    let ended_new = agent("ended98765", "", Status::Ended, 90_000);

    model.apply(snapshot(vec![done_old, ended_new, idle_old, failed_new]));
    let view = now_view(&model, &CardsModel::new(), 100_000, UiLang::En);

    assert_eq!(view.active_count, 0);
    assert_eq!(view.needs_count, 0);

    assert_eq!(view.finished.len(), 2);
    assert_eq!(view.finished[0].key, key("failed-session-new", ""));
    assert_eq!(view.finished[0].status, Status::Failed);
    assert_eq!(view.finished[0].age, "20s");
    assert_eq!(view.finished[1].key, key("done-session-old", ""));
    assert_eq!(view.finished[1].status, Status::Done);
    assert_eq!(view.finished[1].failures, 3);
    assert_eq!(view.finished[1].age, "1m");

    assert_eq!(view.idle.len(), 2);
    assert_eq!(view.idle[0].session_short, "ended987");
    assert_eq!(view.idle[0].repo, "rocky");
    assert_eq!(view.idle[0].branch.as_deref(), Some("main"));
    assert_eq!(view.idle[0].age, "10s");

    assert_eq!(view.idle[1].session_short, "idle1234");
    assert_eq!(view.idle[1].repo, "unknown repo");
    assert_eq!(view.idle[1].branch, None);
    assert_eq!(view.idle[1].age, "50s");

    let view_id = now_view(&model, &CardsModel::new(), 100_000, UiLang::Id);
    assert_eq!(view_id.idle[1].repo, "repo tidak dikenal");
}

#[test]
fn card_prompt_uses_first_non_empty_line_and_harness_envelopes() {
    let mut model = Model::new();

    let mut plain_multi = agent("S1", "", Status::Working, 90_000);
    plain_multi.prompt = Some(PromptText {
        text: "\n   \n  Fix auth\tcheck \nsecond line  ".to_string(),
        truncated: false,
    });

    let mut blank = agent("S2", "", Status::Working, 80_000);
    blank.prompt = Some(PromptText {
        text: "  \r\n\t ".to_string(),
        truncated: false,
    });

    let mut task_notice = agent("S3", "", Status::Working, 70_000);
    task_notice.prompt = Some(PromptText {
        text: "<task-notification><status>completed</status></task-notification>".to_string(),
        truncated: false,
    });

    let mut slash = agent("S4", "", Status::Working, 60_000);
    slash.prompt = Some(PromptText {
        text: "<command-name>plan</command-name>\n<command-args>fix auth</command-args>"
            .to_string(),
        truncated: false,
    });

    let no_prompt = agent("S5", "", Status::Working, 50_000);

    model.apply(snapshot(vec![
        plain_multi,
        blank,
        task_notice,
        slash,
        no_prompt,
    ]));

    let view_en = now_view(&model, &CardsModel::new(), 100_000, UiLang::En);
    assert_eq!(view_en.active[0].prompt.as_deref(), Some("Fix auth check"));
    assert_eq!(view_en.active[1].prompt, None);
    assert_eq!(
        view_en.active[2].prompt.as_deref(),
        Some("Background task notice")
    );
    assert_eq!(view_en.active[3].prompt.as_deref(), Some("/plan fix auth"));
    assert_eq!(view_en.active[4].prompt, None);

    let view_id = now_view(&model, &CardsModel::new(), 100_000, UiLang::Id);
    assert_eq!(
        view_id.active[2].prompt.as_deref(),
        Some("Notifikasi task latar")
    );
}

#[test]
fn card_tool_and_action_avoid_repeating_tool_name_and_relativize_paths() {
    let mut model = Model::new();

    let mut bash = agent("S1", "", Status::Working, 90_000);
    bash.action = Some(Action {
        tool_name: "Bash".to_string(),
        target_path: None,
        tool_use_id: None,
        command: Some("cargo test -p rocky-desk".to_string()),
    });

    let mut edit_win = agent("S2", "", Status::Working, 80_000);
    edit_win.repo.root = Some(r"C:\Repos\Rocky\".to_string());
    edit_win.action = Some(Action {
        tool_name: "Edit".to_string(),
        target_path: Some(r"c:\repos\rocky\crates\rocky-desk\src\now_model.rs".to_string()),
        tool_use_id: None,
        command: None,
    });

    let mut read_empty = agent("S3", "", Status::Working, 70_000);
    read_empty.action = Some(Action {
        tool_name: "Read".to_string(),
        target_path: None,
        tool_use_id: None,
        command: None,
    });

    let mut summary_fallback = agent("S4", "", Status::NeedsYou, 60_000);
    summary_fallback.summary = Some("Waiting".to_string());

    let mut long_cmd = agent("S5", "", Status::Working, 50_000);
    long_cmd.action = Some(Action {
        tool_name: "Bash".to_string(),
        target_path: None,
        tool_use_id: None,
        command: Some("a".repeat(90)),
    });

    model.apply(snapshot(vec![
        bash,
        edit_win,
        read_empty,
        summary_fallback,
        long_cmd,
    ]));
    let view = now_view(&model, &CardsModel::new(), 100_000, UiLang::En);

    // S4 is NeedsYou so it sorts first.
    assert_eq!(view.active[0].key.session_id, "S4");
    assert_eq!(view.active[0].tool, "waiting");
    assert_eq!(view.active[0].action, None);

    assert_eq!(view.active[1].tool, "bash");
    assert_eq!(
        view.active[1].action.as_deref(),
        Some("cargo test -p rocky-desk")
    );

    assert_eq!(view.active[2].tool, "edit");
    assert_eq!(
        view.active[2].action.as_deref(),
        Some("crates/rocky-desk/src/now_model.rs")
    );

    assert_eq!(view.active[3].tool, "read");
    assert_eq!(view.active[3].action, None);

    let trunc = view.active[4].action.as_deref().unwrap();
    assert_eq!(trunc.chars().count(), 80);
    assert!(trunc.ends_with('\u{2026}'));
}

#[test]
fn turn_steps_slice_after_last_turn_start_and_compute_marks() {
    let mut model = Model::new();
    let k_work = key("S1", "");
    let k_need = key("S2", "");
    let k_noturn = key("S3", "");

    model.apply(snapshot(vec![
        agent("S1", "", Status::Working, 90_000),
        agent("S2", "", Status::NeedsYou, 95_000),
        agent("S3", "", Status::NeedsYou, 85_000),
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

    let view = now_view(&model, &CardsModel::new(), 100_000, UiLang::En);
    // Order: S2 (NeedsYou, 95s), S3 (NeedsYou, 85s), S1 (Working, 90s)
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
    // Non-latest Pending entry settles as Ok with "" dur; latest Pending Tool while Working is Running with now - ms.
    assert_eq!(
        view.active[2].steps,
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
fn subagents_respect_tree_setting_and_session_without_main_row() {
    let mut model = Model::new();
    let main = agent("S1", "", Status::Working, 90_000);
    let mut sub_b = agent("S1", "agent-b-1234", Status::Done, 85_000);
    sub_b.agent_type = None;
    sub_b.description = Some("  inspect\nlogs ".to_string());

    let mut sub_a = agent("S1", "agent-a-5678", Status::Working, 88_000);
    sub_a.agent_type = Some("Explore".to_string());
    sub_a.action = Some(Action {
        tool_name: "Grep".to_string(),
        target_path: Some("/repos/rocky/src/lib.rs".to_string()),
        tool_use_id: None,
        command: None,
    });

    // Session S2 has no main row (agent_id == ""), only two subagents.
    let mut orphan_a = agent("S2", "sub-1", Status::Working, 70_000);
    orphan_a.agent_type = Some("Plan".to_string());
    let mut orphan_b = agent("S2", "sub-2", Status::NeedsYou, 75_000);
    orphan_b.agent_type = Some("Review".to_string());

    model.apply(snapshot(vec![main, sub_b, sub_a, orphan_b, orphan_a]));

    let tree_on = now_view(&model, &CardsModel::new(), 100_000, UiLang::En);
    assert_eq!(tree_on.active.len(), 2);

    let s1 = &tree_on.active[0];
    assert_eq!(s1.key, key("S1", ""));
    assert_eq!(s1.hidden_children, None);
    assert_eq!(s1.subs.len(), 2);
    assert_eq!(s1.subs[0].key, key("S1", "agent-a-5678"));
    assert_eq!(s1.subs[0].agent_type, "Explore");
    assert_eq!(s1.subs[0].timer, "12s");
    assert_eq!(s1.subs[0].action.as_deref(), Some("Grep src/lib.rs"));
    assert_eq!(s1.subs[1].key, key("S1", "agent-b-1234"));
    assert_eq!(s1.subs[1].agent_type, "agent-b-");
    assert_eq!(s1.subs[1].description.as_deref(), Some("inspect logs"));
    assert_eq!(s1.subs[1].action, None);

    // S2 has sub-1 promoted to primary and only sub-2 in subs (no self-duplication).
    let s2 = &tree_on.active[1];
    assert_eq!(s2.key, key("S2", "sub-1"));
    assert_eq!(s2.subs.len(), 1);
    assert_eq!(s2.subs[0].key, key("S2", "sub-2"));

    // Turn subagent_tree off: S1 hides both children and counts only Status::Working (1).
    let off = Settings {
        subagent_tree: false,
        ..Settings::default()
    };
    model.apply(ServerMsg::Settings { settings: off });

    let tree_off = now_view(&model, &CardsModel::new(), 100_000, UiLang::En);
    assert!(tree_off.active[0].subs.is_empty());
    assert_eq!(
        tree_off.active[0].hidden_children,
        Some(Msg::SubagentsHidden { n: 2, working: 1 })
    );
    assert!(tree_off.active[1].subs.is_empty());
    assert_eq!(
        tree_off.active[1].hidden_children,
        Some(Msg::SubagentsHidden { n: 1, working: 0 })
    );
}

#[test]
fn finished_row_picks_latest_matching_main_card_id() {
    let mut model = Model::new();
    model.apply(snapshot(vec![
        agent("S1", "", Status::Done, 90_000),
        agent("S2", "", Status::Failed, 80_000),
    ]));

    let cards = cards_with(vec![
        dummy_card("c-old", "S1", "", 10_000, Some(20_000)),
        dummy_card("c-sub", "S1", "sub-1", 30_000, Some(99_000)),
        dummy_card("c-new", "S1", "", 25_000, Some(50_000)),
        dummy_card("c-open", "S1", "", 40_000, None),
    ]);

    let view = now_view(&model, &cards, 100_000, UiLang::En);
    assert_eq!(view.finished.len(), 2);
    assert_eq!(view.finished[0].key, key("S1", ""));
    assert_eq!(view.finished[0].card_id.as_deref(), Some("c-new"));
    assert_eq!(view.finished[1].key, key("S2", ""));
    assert_eq!(view.finished[1].card_id, None);
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
    assert!(fetch.poll(&model.active_primary_keys(), 2_500).is_empty());

    // Leaving the active list cancels pending and clears cooldown.
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
