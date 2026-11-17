use super::constellation::*;
use super::detail::*;
use super::sky::{RowKind, StarKind};
use super::test_support::model_with;
use super::{ProjectId, StepRef};
use crate::cards_model::CardsModel;
use crate::clock::local_hhmmss;
use crate::i18n::UiLang;
use crate::view::Model;
use rocky_proto::pipe::{
    AgentKey, AgentStatus, Outcome, RepoInfo, Status, TimelineEntry, TimelineKind,
};

const NOW: u64 = 10_000_000;
const ROOT: &str = "C:/p/rocky";

fn key(session: &str, sub: &str) -> AgentKey {
    AgentKey {
        session_id: session.into(),
        agent_id: sub.into(),
    }
}

fn agent(session: &str, sub: &str, status: Status, last_ms: u64) -> AgentStatus {
    AgentStatus {
        key: key(session, sub),
        agent_type: None,
        status,
        action: None,
        summary: None,
        description: None,
        failures: 0,
        last_event_ms: last_ms,
        quiet_10m: false,
        repo: RepoInfo {
            root: Some(ROOT.into()),
            main_root: None,
            name: "rocky".into(),
            branch: Some("main".into()),
        },
        prompt: None,
        harness: Some("claude-code".into()),
    }
}

fn entry(ms: u64, kind: TimelineKind, tool: Option<&str>, text: Option<&str>) -> TimelineEntry {
    TimelineEntry {
        ms,
        kind,
        tool_name: tool.map(str::to_string),
        text: text.map(str::to_string),
        outcome: None,
        dur_ms: None,
    }
}

fn tool(ms: u64, name: &str, text: &str, outcome: Outcome) -> TimelineEntry {
    TimelineEntry {
        outcome: Some(outcome),
        ..entry(ms, TimelineKind::Tool, Some(name), Some(text))
    }
}

fn turn_start(ms: u64) -> TimelineEntry {
    entry(ms, TimelineKind::TurnStart, None, None)
}

fn project() -> ProjectId {
    ProjectId(ROOT.into())
}

fn view(model: &Model, pick: Option<&(AgentKey, u64)>) -> Option<ConstellationView> {
    constellation(
        model,
        &CardsModel::new(),
        &project(),
        pick,
        NOW,
        None,
        UiLang::En,
    )
}

fn live_model() -> Model {
    let tl = vec![
        turn_start(NOW - 60_000),
        tool(NOW - 50_000, "Read", "C:/p/rocky/src/a.rs", Outcome::Ok),
        tool(NOW - 40_000, "Bash", "cargo test", Outcome::Failed),
        tool(NOW - 30_000, "Edit", "C:/p/rocky/src/b.rs", Outcome::Ok),
        tool(NOW - 20_000, "Bash", "cargo build", Outcome::Pending),
    ];
    model_with(
        vec![agent("s1", "", Status::Working, NOW - 20_000)],
        vec![(key("s1", ""), tl)],
        true,
    )
}

#[test]
fn constellation_numbers_steps_and_alternates_labels() {
    let v = view(&live_model(), None).expect("live turn");
    let ns: Vec<usize> = v.stars.iter().map(|s| s.n).collect();
    let above: Vec<bool> = v.stars.iter().map(|s| s.above).collect();
    assert_eq!(ns, vec![1, 2, 3, 4]);
    assert_eq!(above, vec![true, false, true, false]);
    assert_eq!(v.stars[1].label, "cargo test");
    assert_eq!(v.stars[1].row, RowKind::Cmd);
    assert_ne!(v.stars[0].label, "C:/p/rocky/src/a.rs");
    assert!(v.stars[0].label.ends_with("a.rs"));
    assert_eq!(v.stars[1].kind, StarKind::Failed);
    assert_eq!(v.stars[3].kind, StarKind::Running);
    assert_eq!(v.failed, 1);
    assert_eq!(v.start_ms, NOW - 60_000);
    assert_eq!(v.harness.as_deref(), Some("claude-code"));
    assert_eq!(v.branch.as_deref(), Some("main"));
}

#[test]
fn constellation_falls_back_when_the_pick_vanished() {
    let model = live_model();
    let gone = (key("s1", ""), 999);
    let v = view(&model, Some(&gone)).expect("fallback");
    assert_eq!(v.start_ms, NOW - 60_000);
    let other = (key("nope", ""), NOW - 60_000);
    assert_eq!(
        view(&model, Some(&other)).map(|v| v.key),
        Some(key("s1", ""))
    );
}

#[test]
fn constellation_is_none_without_any_timeline() {
    let model = model_with(vec![agent("s1", "", Status::Idle, NOW)], Vec::new(), true);
    assert!(view(&model, None).is_none());
}

#[test]
fn prev_and_next_turn_follow_the_timeline() {
    let tl = vec![
        turn_start(1_000),
        tool(1_100, "Read", "a.rs", Outcome::Ok),
        turn_start(2_000),
        tool(2_100, "Read", "b.rs", Outcome::Ok),
    ];
    let model = model_with(
        vec![agent("s1", "", Status::Idle, 2_100)],
        vec![(key("s1", ""), tl)],
        true,
    );
    let first = (key("s1", ""), 1_000);
    let v = view(&model, Some(&first)).expect("first turn");
    assert_eq!(v.prev_turn, None);
    assert_eq!(v.next_turn, Some(2_000));
    let second = (key("s1", ""), 2_000);
    let v = view(&model, Some(&second)).expect("second turn");
    assert_eq!(v.prev_turn, Some(1_000));
    assert_eq!(v.next_turn, None);
}

fn sub_model(tree: bool) -> Model {
    let parent = vec![
        turn_start(100),
        tool(110, "Read", "a.rs", Outcome::Ok),
        tool(120, "Read", "b.rs", Outcome::Ok),
        tool(130, "Read", "c.rs", Outcome::Ok),
        tool(150, "Read", "d.rs", Outcome::Ok),
    ];
    let child = vec![
        entry(140, TimelineKind::SubagentStart, None, None),
        tool(145, "Grep", "x", Outcome::Ok),
        tool(146, "Grep", "y", Outcome::Ok),
    ];
    model_with(
        vec![
            agent("s1", "", Status::Idle, 150),
            agent("s1", "c1", Status::Idle, 146),
        ],
        vec![(key("s1", ""), parent), (key("s1", "c1"), child)],
        tree,
    )
}

#[test]
fn subagent_hangs_after_the_step_count_at_spawn() {
    let v = view(&sub_model(true), None).expect("turn");
    assert_eq!(v.stars.len(), 4);
    assert_eq!(v.subs.len(), 1);
    assert_eq!(v.subs[0].after_n, 3);
    assert_eq!(v.subs[0].stars.len(), 2);
    assert_eq!(v.subs[0].stars[0].step.key, key("s1", "c1"));
    assert_eq!(v.subs[0].stars[1].n, 2);
}

#[test]
fn subagent_lanes_need_the_subagent_tree() {
    let v = view(&sub_model(false), None).expect("turn");
    assert!(v.subs.is_empty());
}

#[test]
fn child_without_a_spawn_entry_uses_its_first_step_time() {
    let parent = vec![
        turn_start(100),
        tool(110, "Read", "a.rs", Outcome::Ok),
        tool(120, "Read", "b.rs", Outcome::Ok),
        tool(150, "Read", "c.rs", Outcome::Ok),
    ];
    let child = vec![tool(130, "Grep", "x", Outcome::Ok)];
    let model = model_with(
        vec![
            agent("s1", "", Status::Idle, 150),
            agent("s1", "c1", Status::Idle, 130),
        ],
        vec![(key("s1", ""), parent), (key("s1", "c1"), child)],
        true,
    );
    let v = view(&model, None).expect("turn");
    assert_eq!(v.subs[0].after_n, 2);
}

#[test]
fn default_step_prefers_running_then_failed_then_last() {
    let running = live_model();
    assert_eq!(
        default_step(&running, &project()),
        Some(StepRef {
            key: key("s1", ""),
            ms: NOW - 20_000
        })
    );

    let failed = model_with(
        vec![agent("s1", "", Status::Idle, 400)],
        vec![(
            key("s1", ""),
            vec![
                turn_start(100),
                tool(200, "Bash", "a", Outcome::Failed),
                tool(300, "Bash", "b", Outcome::Failed),
                tool(400, "Read", "c", Outcome::Ok),
            ],
        )],
        true,
    );
    assert_eq!(default_step(&failed, &project()).map(|s| s.ms), Some(300));

    let plain = model_with(
        vec![agent("s1", "", Status::Idle, 400)],
        vec![(
            key("s1", ""),
            vec![
                turn_start(100),
                tool(200, "Read", "a", Outcome::Ok),
                tool(400, "Read", "c", Outcome::Ok),
            ],
        )],
        true,
    );
    assert_eq!(default_step(&plain, &project()).map(|s| s.ms), Some(400));
}

#[test]
fn step_detail_is_none_once_the_step_is_gone_and_neighbor_stays_in_turn() {
    let model = live_model();
    let k = key("s1", "");
    let missing = StepRef {
        key: k.clone(),
        ms: 12_345,
    };
    assert_eq!(step_detail(&model, &missing, None), None);
    assert_eq!(neighbor(&model, &missing, true), None);

    let first = StepRef {
        key: k.clone(),
        ms: NOW - 50_000,
    };
    let second = StepRef {
        key: k.clone(),
        ms: NOW - 40_000,
    };
    let last = StepRef {
        key: k,
        ms: NOW - 20_000,
    };
    assert_eq!(neighbor(&model, &first, false), None);
    assert_eq!(neighbor(&model, &first, true), Some(second));
    assert_eq!(neighbor(&model, &last, true), None);
}

#[test]
fn step_detail_reports_position_and_outcome() {
    let model = live_model();
    let k = key("s1", "");
    let failed = step_detail(
        &model,
        &StepRef {
            key: k.clone(),
            ms: NOW - 40_000,
        },
        None,
    )
    .expect("detail");
    assert_eq!((failed.n, failed.of), (2, 4));
    assert_eq!(failed.text, "cargo test");
    assert_eq!(failed.outcome, StepOutcome::Failed { dur_ms: None });
    assert_eq!(failed.turn_start_ms, NOW - 60_000);
    assert_eq!(failed.session_id, "s1");
    let live = step_detail(
        &model,
        &StepRef {
            key: k,
            ms: NOW - 20_000,
        },
        None,
    )
    .expect("detail");
    assert_eq!(
        live.outcome,
        StepOutcome::Running {
            since_ms: NOW - 20_000
        }
    );
}

#[test]
fn local_hhmmss_appends_seconds() {
    assert!(local_hhmmss(61_000).ends_with(":01"));
}

#[test]
fn working_subagent_last_pending_step_is_running_in_star_and_detail() {
    let parent = vec![
        turn_start(100),
        tool(110, "Read", "a.rs", Outcome::Ok),
        tool(130, "Read", "b.rs", Outcome::Ok),
    ];
    let child = vec![
        entry(120, TimelineKind::SubagentStart, None, None),
        tool(125, "Grep", "x", Outcome::Ok),
        tool(126, "Bash", "cargo test", Outcome::Pending),
    ];
    let model = model_with(
        vec![
            agent("s1", "", Status::Working, 130),
            agent("s1", "c1", Status::Working, 126),
        ],
        vec![(key("s1", ""), parent), (key("s1", "c1"), child)],
        true,
    );
    let v = view(&model, None).expect("turn");
    let last = &v.subs[0].stars[1];
    assert_eq!(last.kind, StarKind::Running);
    assert_eq!(last.radius, crate::atlas_model::sky::LIVE_RADIUS);
    assert_eq!(v.subs[0].stars[0].kind, StarKind::Plain);
    let d = step_detail(&model, &last.step, None).expect("detail");
    assert_eq!(d.outcome, StepOutcome::Running { since_ms: 126 });
}

#[test]
fn a_picked_turn_of_a_subagent_falls_back_to_the_default_turn() {
    let parent = vec![turn_start(100), tool(110, "Read", "a.rs", Outcome::Ok)];
    let child = vec![tool(115, "Grep", "x", Outcome::Ok)];
    let model = model_with(
        vec![
            agent("s1", "", Status::Idle, 150),
            agent("s1", "c1", Status::Idle, 146),
        ],
        vec![(key("s1", ""), parent), (key("s1", "c1"), child)],
        true,
    );
    let pick = (key("s1", "c1"), 115);
    let v = view(&model, Some(&pick)).expect("turn");
    assert_eq!(v.key, key("s1", ""));
}
