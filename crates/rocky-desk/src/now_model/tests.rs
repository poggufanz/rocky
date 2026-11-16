use rocky_proto::cards::{Card, CardStatus, Coverage, CoverageState, Importance};
use rocky_proto::pipe::{
    Action, AgentKey, AgentStatus, Health, Outcome, PromptText, RepoInfo, ServerMsg, Status,
    TimelineEntry, TimelineKind,
};
use rocky_proto::settings::Settings;

use super::*;

pub(super) fn key(session: &str, agent: &str) -> AgentKey {
    AgentKey {
        session_id: session.to_string(),
        agent_id: agent.to_string(),
    }
}

pub(super) fn agent(
    session: &str,
    agent_id: &str,
    status: Status,
    last_event_ms: u64,
) -> AgentStatus {
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

pub(super) fn snapshot(agents: Vec<AgentStatus>) -> ServerMsg {
    ServerMsg::Snapshot {
        agents,
        aggregate: Status::Idle,
        health: Health::default(),
        settings: Settings::default(),
        repo_pending: Vec::new(),
    }
}

pub(super) fn timeline_msg(key: AgentKey, entries: Vec<TimelineEntry>) -> ServerMsg {
    ServerMsg::Timeline {
        id: 1,
        key,
        entries,
    }
}

pub(super) fn step_entry(
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
        reads: Vec::new(),
        reads_more: 0,
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
    let view = now_view(&model, &cards, 100_000, UiLang::En, None);
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
    let view = now_view(&model, &CardsModel::new(), 100_000, UiLang::En, None);

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
    let view = now_view(&model, &CardsModel::new(), 100_000, UiLang::En, None);

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

    let view_id = now_view(&model, &CardsModel::new(), 100_000, UiLang::Id, None);
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

    let mut cross_session = agent("S5", "", Status::Working, 55_000);
    cross_session.prompt = Some(PromptText {
        text: "  \n<cross-session-message from=\"other\" sender=\"lead\">\nrun tests\n</cross-session-message>".to_string(),
        truncated: false,
    });

    let no_prompt = agent("S6", "", Status::Working, 50_000);

    model.apply(snapshot(vec![
        plain_multi,
        blank,
        task_notice,
        slash,
        cross_session,
        no_prompt,
    ]));

    let view_en = now_view(&model, &CardsModel::new(), 100_000, UiLang::En, None);
    assert_eq!(view_en.active[0].prompt.as_deref(), Some("Fix auth check"));
    assert_eq!(view_en.active[1].prompt, None);
    assert_eq!(
        view_en.active[2].prompt.as_deref(),
        Some("Background task notice")
    );
    assert_eq!(view_en.active[3].prompt.as_deref(), Some("/plan fix auth"));
    assert_eq!(
        view_en.active[4].prompt.as_deref(),
        Some("Message from another session")
    );
    assert_eq!(view_en.active[5].prompt, None);

    let view_id = now_view(&model, &CardsModel::new(), 100_000, UiLang::Id, None);
    assert_eq!(
        view_id.active[2].prompt.as_deref(),
        Some("Notifikasi task latar")
    );
    assert_eq!(
        view_id.active[4].prompt.as_deref(),
        Some("Pesan dari sesi lain")
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

    let mut mcp_long = agent("S6", "", Status::Working, 40_000);
    mcp_long.action = Some(Action {
        tool_name: "mcp__filesystem__read_multiple_files".to_string(),
        target_path: None,
        tool_use_id: None,
        command: None,
    });

    let mut grep = agent("S7", "", Status::Working, 30_000);
    grep.action = Some(Action {
        tool_name: "Grep".to_string(),
        target_path: None,
        tool_use_id: None,
        command: None,
    });

    model.apply(snapshot(vec![
        bash,
        edit_win,
        read_empty,
        summary_fallback,
        long_cmd,
        mcp_long,
        grep,
    ]));
    let view = now_view(&model, &CardsModel::new(), 100_000, UiLang::En, None);

    // S4 is NeedsYou so it sorts first.
    assert_eq!(view.active[0].key.session_id, "S4");
    assert_eq!(view.active[0].tool, "waiting");
    assert_eq!(view.active[0].action, None);

    assert_eq!(view.active[1].tool, "cmd");
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

    assert_eq!(view.active[5].tool, "mcp__fil\u{2026}");
    assert_eq!(view.active[6].tool, "find");
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

    let tree_on = now_view(&model, &CardsModel::new(), 100_000, UiLang::En, None);
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

    let tree_off = now_view(&model, &CardsModel::new(), 100_000, UiLang::En, None);
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

    let view = now_view(&model, &cards, 100_000, UiLang::En, None);
    assert_eq!(view.finished.len(), 2);
    assert_eq!(view.finished[0].key, key("S1", ""));
    assert_eq!(view.finished[0].card_id.as_deref(), Some("c-new"));
    assert_eq!(view.finished[1].key, key("S2", ""));
    assert_eq!(view.finished[1].card_id, None);
}

#[test]
fn tool_label_maps_known_tools_and_truncates_unknown_by_chars() {
    for (input, expected) in [
        ("Bash", "cmd"),
        ("  PowerShell ", "cmd"),
        ("NuShell", "cmd"),
        ("mcp__shell__exec", "cmd"),
        ("Edit", "edit"),
        ("Write", "edit"),
        ("MultiEdit", "edit"),
        ("NotebookEdit", "edit"),
        ("Read", "read"),
        ("Grep", "find"),
        ("Glob", "find"),
        ("WebFetch", "web"),
        ("WebSearch", "web"),
        ("Task", "agent"),
        ("Agent", "agent"),
        ("EightChr", "eightchr"),
        ("NineChars", "ninechar\u{2026}"),
        ("mcp__filesystem__read_multiple_files", "mcp__fil\u{2026}"),
        (
            "\u{00e4}\u{00e4}\u{00e4}\u{00e4}\u{00e4}\u{00e4}\u{00e4}\u{00e4}\u{00e4}",
            "\u{00e4}\u{00e4}\u{00e4}\u{00e4}\u{00e4}\u{00e4}\u{00e4}\u{00e4}\u{2026}",
        ),
    ] {
        let got = tool_label(input);
        assert_eq!(got, expected, "tool_label({input:?})");
        assert!(got.chars().count() <= 9);
    }
}

#[test]
fn short_path_handles_root_home_windows_and_boundaries() {
    // Inside root with Windows backslashes and mixed case on Windows.
    assert_eq!(
        short_path(
            r"C:\Repos\Rocky\src\cart.ts",
            Some(r"C:\Repos\Rocky"),
            Some(r"C:\Users\alice")
        ),
        "src/cart.ts"
    );
    assert_eq!(
        short_path(
            r"\\?\C:\Repos\Rocky\src\cart.ts",
            Some(r"C:\Repos\Rocky"),
            None
        ),
        "src/cart.ts"
    );
    if cfg!(windows) {
        assert_eq!(
            short_path(r"c:\repos\rocky\src\cart.ts", Some(r"C:\Repos\Rocky"), None),
            "src/cart.ts"
        );
    } else {
        assert_eq!(
            short_path(r"c:\repos\rocky\src\cart.ts", Some(r"C:\Repos\Rocky"), None),
            r"c:\repos\rocky\src\cart.ts"
        );
    }

    // Sibling dir with the same prefix stays untouched.
    assert_eq!(
        short_path("C:/repo-other/x", Some("C:/repo"), None),
        "C:/repo-other/x"
    );
    assert_eq!(
        short_path(
            "/home/alice-other/x",
            Some("/repos/rocky"),
            Some("/home/alice")
        ),
        "/home/alice-other/x"
    );

    // Under home (when outside root, and when root is None).
    assert_eq!(
        short_path(
            "/home/alice/.claude/CLAUDE.md",
            Some("/repos/rocky"),
            Some("/home/alice")
        ),
        "~/.claude/CLAUDE.md"
    );
    assert_eq!(
        short_path(
            r"C:\Users\alice\.cargo\config.toml",
            None,
            Some(r"C:\Users\alice")
        ),
        "~/.cargo/config.toml"
    );

    // Outside both root and home stays unchanged.
    assert_eq!(
        short_path(
            r"D:\data\notes.txt",
            Some(r"C:\Repos\Rocky"),
            Some(r"C:\Users\alice")
        ),
        r"D:\data\notes.txt"
    );

    // None root, outside home stays unchanged.
    assert_eq!(
        short_path("/var/log/rocky.log", None, Some("/home/alice")),
        "/var/log/rocky.log"
    );

    // Root given with a trailing slash.
    assert_eq!(
        short_path(
            r"C:\Repos\Rocky\src\cart.ts",
            Some(r"C:\Repos\Rocky\"),
            None
        ),
        "src/cart.ts"
    );

    // Root itself or path equal to home stays unchanged, even when bases overlap.
    assert_eq!(
        short_path("C:/Repos/Rocky", Some("C:/Repos/Rocky/"), None),
        "C:/Repos/Rocky"
    );
    assert_eq!(
        short_path("/home/alice/", None, Some("/home/alice")),
        "/home/alice/"
    );
    assert_eq!(
        short_path(
            "C:/Users/alice/repo",
            Some("C:/Users/alice/repo"),
            Some("C:/Users/alice")
        ),
        "C:/Users/alice/repo"
    );
    assert_eq!(
        short_path(
            "/home/alice/repo/",
            Some("/home/alice/repo"),
            Some("/home/alice")
        ),
        "/home/alice/repo/"
    );
    assert_eq!(
        short_path("/home/alice", Some("/home"), Some("/home/alice")),
        "/home/alice"
    );
    assert_eq!(
        short_path("C:/Users/alice/", Some("C:/Users"), Some("C:/Users/alice")),
        "C:/Users/alice/"
    );
    if cfg!(windows) {
        assert_eq!(
            short_path(
                r"\\?\c:\users\alice\repo\",
                Some(r"C:\Users\alice\repo"),
                Some(r"C:\Users\alice")
            ),
            r"\\?\c:\users\alice\repo\"
        );
        assert_eq!(
            short_path(
                r"\\?\c:\users\alice\",
                Some(r"C:\Users"),
                Some(r"C:\Users\alice")
            ),
            r"\\?\c:\users\alice\"
        );
        assert_eq!(
            short_path("/home/Alice", Some("/home"), Some("/home/alice")),
            "/home/Alice"
        );
    } else {
        assert_eq!(
            short_path("/home/Alice", Some("/home"), Some("/home/alice")),
            "Alice"
        );
    }
    assert_eq!(
        short_path(
            "C:/Users/alice/repo/src/main.rs",
            Some("C:/Users/alice/repo"),
            Some("C:/Users/alice")
        ),
        "src/main.rs"
    );
    assert_eq!(
        short_path(
            "C:/Users/alice/.claude/CLAUDE.md",
            Some("C:/Users/alice/repo"),
            Some("C:/Users/alice")
        ),
        "~/.claude/CLAUDE.md"
    );
}
