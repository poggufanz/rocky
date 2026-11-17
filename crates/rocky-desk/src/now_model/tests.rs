use rocky_proto::pipe::{
    AgentKey, AgentStatus, Health, Outcome, RepoInfo, ServerMsg, Status, TimelineEntry,
    TimelineKind,
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
        harness: None,
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
