use super::projects::*;
use super::{ProjectId, SkyWindow, wanted_keys};
use rocky_proto::pipe::{Action, AgentKey, AgentStatus, RepoInfo, Status};
use std::collections::BTreeMap;

fn agent(
    session: &str,
    sub: &str,
    status: Status,
    root: Option<&str>,
    last_ms: u64,
) -> AgentStatus {
    AgentStatus {
        key: AgentKey {
            session_id: session.into(),
            agent_id: sub.into(),
        },
        agent_type: None,
        status,
        action: None,
        summary: None,
        description: None,
        failures: 0,
        last_event_ms: last_ms,
        quiet_10m: false,
        repo: RepoInfo {
            root: root.map(str::to_string),
            main_root: None,
            name: root
                .and_then(|r| r.rsplit('/').next())
                .unwrap_or_default()
                .to_string(),
            branch: None,
        },
        prompt: None,
        harness: None,
    }
}

fn map<const N: usize>(list: [AgentStatus; N]) -> BTreeMap<AgentKey, AgentStatus> {
    list.into_iter().map(|a| (a.key.clone(), a)).collect()
}

#[test]
fn sessions_group_by_main_root_and_outside_repo_is_one_project() {
    let rows = projects(
        &map([
            agent("s1", "", Status::Working, Some("C:/p/rocky"), 900),
            agent("s2", "", Status::Idle, Some("C:/p/rocky"), 100),
            agent("s3", "", Status::Idle, None, 50),
            agent("s4", "", Status::Idle, None, 40),
            agent("s1", "sub", Status::Working, Some("C:/p/rocky"), 900),
        ]),
        1_000,
    );
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].sessions.len(), 2); // subagent is not a session
    assert_eq!(rows[1].id, ProjectId(String::new()));
    assert_eq!(rows[1].sessions.len(), 2);
    assert_eq!(rows[1].name, None);
}

#[test]
fn needs_you_outranks_working_and_active_projects_come_first() {
    let mut idle = agent("q", "", Status::Idle, Some("C:/p/zed"), 999);
    idle.failures = 9; // idle sessions do not count
    let mut needs = agent("n", "", Status::NeedsYou, Some("C:/p/a"), 400);
    needs.failures = 1;
    let mut works = agent("n2", "", Status::Working, Some("C:/p/a"), 300);
    works.failures = 1;
    let rows = projects(
        &map([
            idle,
            agent("w", "", Status::Working, Some("C:/p/b"), 500),
            needs,
            works,
        ]),
        1_000,
    );
    let names: Vec<_> = rows.iter().map(|r| r.name.clone().unwrap()).collect();
    assert_eq!(names, ["a", "b", "zed"]);
    assert!(matches!(rows[0].state, ProjectState::NeedsYou));
    assert!(matches!(rows[1].state, ProjectState::Working));
    assert_eq!(rows[0].sessions[0].status, Status::NeedsYou);
    assert_eq!(rows[0].failures, 2);
    assert_eq!(rows[2].failures, 0);
}

#[test]
fn default_project_prefers_working_then_needs_you() {
    let a = map([
        agent("n", "", Status::NeedsYou, Some("C:/p/a"), 1),
        agent("w", "", Status::Working, Some("C:/p/b"), 1),
    ]);
    let rows = projects(&a, 10);
    assert_eq!(default_project(&rows), Some(ProjectId("C:/p/b".into())));
    let b = map([
        agent("n", "", Status::NeedsYou, Some("C:/p/a"), 1),
        agent("q", "", Status::Idle, Some("C:/p/c"), 1),
    ]);
    let rows = projects(&b, 10);
    assert_eq!(default_project(&rows), Some(ProjectId("C:/p/a".into())));
    assert_eq!(default_project(&[]), None);
}

#[test]
fn needs_you_bars_skip_the_selected_project_and_cap_at_three() {
    let list: Vec<_> = ["a", "b", "c", "d", "e"]
        .iter()
        .map(|n| agent(n, "", Status::NeedsYou, Some(&format!("C:/p/{n}")), 1_000))
        .collect();
    let agents: BTreeMap<_, _> = list.into_iter().map(|a| (a.key.clone(), a)).collect();
    let sel = ProjectId("C:/p/a".into());
    let (bars, rest) = needs_you_bars(&agents, Some(&sel), 6_000);
    assert_eq!(bars.len(), 3);
    assert_eq!(rest, 1);
    assert!(bars.iter().all(|b| b.project != sel));
    assert_eq!(bars[0].waiting_secs, 5);
}

#[test]
fn needs_you_bar_action_falls_back_to_summary() {
    let mut with_cmd = agent("a", "", Status::NeedsYou, Some("C:/p/a"), 0);
    with_cmd.action = Some(Action {
        tool_name: "Bash".into(),
        target_path: None,
        tool_use_id: None,
        command: Some("cargo test".into()),
    });
    let mut with_sum = agent("b", "", Status::NeedsYou, Some("C:/p/b"), 0);
    with_sum.summary = Some("asks a question".into());
    let (bars, _) = needs_you_bars(&map([with_cmd, with_sum]), None, 0);
    assert_eq!(bars[0].action.as_deref(), Some("cargo test"));
    assert_eq!(bars[1].action.as_deref(), Some("asks a question"));
}

#[test]
fn quiet_project_reports_seconds_since_newest_event() {
    let rows = projects(
        &map([
            agent("a", "", Status::Idle, Some("C:/p/a"), 100),
            agent("b", "", Status::Idle, Some("C:/p/a"), 400),
        ]),
        1_000_400,
    );
    assert!(matches!(
        rows[0].state,
        ProjectState::Quiet { idle_secs: 1000 }
    ));
}

#[test]
fn wanted_keys_follow_window_and_subagent_setting() {
    let now = 10_000_000;
    let min = 60_000;
    let all = map([
        agent("s1", "", Status::Idle, Some("C:/p/rocky"), now - 5 * min),
        agent("s1", "sub", Status::Idle, Some("C:/p/rocky"), now - min),
        agent("s2", "", Status::Idle, Some("C:/p/rocky"), now - 20 * min),
        agent("s3", "", Status::Idle, Some("C:/p/other"), now),
    ]);
    let project = ProjectId("C:/p/rocky".into());
    let k = |s: &str, a: &str| AgentKey {
        session_id: s.into(),
        agent_id: a.into(),
    };
    let ten = wanted_keys(&all, &project, SkyWindow::Min10, now, true);
    assert_eq!(ten, [k("s1", ""), k("s1", "sub")].into_iter().collect());
    let thirty = wanted_keys(&all, &project, SkyWindow::Min30, now, true);
    assert_eq!(
        thirty,
        [k("s1", ""), k("s1", "sub"), k("s2", "")]
            .into_iter()
            .collect()
    );
    let flat = wanted_keys(&all, &project, SkyWindow::Min10, now, false);
    assert_eq!(flat, [k("s1", "")].into_iter().collect());
}
