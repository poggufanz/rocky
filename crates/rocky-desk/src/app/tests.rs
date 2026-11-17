use rocky_proto::pipe::{AgentStatus, Health, Outcome, RepoInfo, TimelineEntry, TimelineKind};
use rocky_proto::settings::Settings;

use super::*;

fn test_controller() -> (Controller, Receiver<ClientMsg>) {
    let (out_tx, out_rx) = mpsc::channel();
    let (worker_tx, worker_rx) = mpsc::channel();
    let ctl = Controller {
        model: Model::new(),
        timeline_fetch: TimelineFetch::new(),
        notifier: Notifier::default(),
        inbox: None,
        outbox: Some(out_tx),
        worker_rx,
        worker_tx,
        state: ConnState::new(3, 300_000),
        cmd_id: 0,
        rocky_home: PathBuf::from("."),
        last_aggregate: Status::Idle,
        last_tooltip: Msg::NoAgents,
        ui_lang: UiLang::En,
        detected: UiLang::En,
        view: View::Agents,
        tray_start: false,
        autostart_on: None,
        autostart_failed: false,
    };
    (ctl, out_rx)
}

fn test_agent_with_id(
    session_id: &str,
    agent_id: &str,
    status: Status,
    last_event_ms: u64,
) -> AgentStatus {
    AgentStatus {
        key: AgentKey {
            session_id: session_id.to_string(),
            agent_id: agent_id.to_string(),
        },
        agent_type: (!agent_id.is_empty()).then(|| "Explore".to_string()),
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

fn test_agent(session_id: &str, status: Status, last_event_ms: u64) -> AgentStatus {
    test_agent_with_id(session_id, "", status, last_event_ms)
}

fn apply_at(ctl: &mut Controller, msg: ServerMsg, now_ms: u64) {
    let copy = msg.clone();
    let legacy = ctl.model.apply(msg);
    for key in ctl.collect_timeline_requests(&copy, legacy, now_ms) {
        ctl.request_timeline(key);
    }
}

fn drain_timelines(rx: &Receiver<ClientMsg>) -> Vec<AgentKey> {
    let mut keys = Vec::new();
    while let Ok(msg) = rx.try_recv() {
        if let ClientMsg::Timeline { key, .. } = msg {
            keys.push(key);
        }
    }
    keys
}

#[test]
fn controller_debounces_expansion_after_snapshot_fetch() {
    let (mut ctl, rx) = test_controller();
    let k1 = AgentKey {
        session_id: "S1".to_string(),
        agent_id: String::new(),
    };

    apply_at(
        &mut ctl,
        ServerMsg::Snapshot {
            agents: vec![test_agent("S1", Status::Working, 900)],
            aggregate: Status::Working,
            health: Health::default(),
            settings: Settings::default(),
            repo_pending: Vec::new(),
        },
        1_000,
    );
    assert_eq!(drain_timelines(&rx), vec![k1.clone()]);

    // Simulate daemon reply caching the timeline before expansion.
    apply_at(
        &mut ctl,
        ServerMsg::Timeline {
            id: 1,
            key: k1.clone(),
            entries: vec![TimelineEntry {
                ms: 950,
                kind: TimelineKind::Tool,
                tool_name: Some("Bash".to_string()),
                text: Some("cargo test".to_string()),
                outcome: Some(Outcome::Ok),
                dur_ms: Some(1_000),
            }],
        },
        1_050,
    );
    assert!(drain_timelines(&rx).is_empty());

    // Expanding within 500 ms must use the cached timeline and emit no extra request.
    ctl.toggle_open(&k1, 1_100);
    assert!(ctl.model.is_open(&k1));
    assert_eq!(
        ctl.model.timeline_rows(&k1, &crate::clock::utc_hhmm).len(),
        1
    );
    assert!(
        drain_timelines(&rx).is_empty(),
        "expansion inside 500 ms cooldown must not send a second timeline request"
    );

    ctl.poll_timelines(1_499);
    assert!(drain_timelines(&rx).is_empty());

    ctl.poll_timelines(1_500);
    assert_eq!(drain_timelines(&rx), vec![k1.clone()]);

    // Leaving active while open must not emit a dead request via legacy open requests.
    apply_at(
        &mut ctl,
        ServerMsg::Status {
            op: rocky_proto::pipe::StatusOp::Upsert,
            agent: test_agent("S1", Status::Done, 2_100),
        },
        2_100,
    );
    assert!(drain_timelines(&rx).is_empty());
}

#[test]
fn controller_rapid_child_collapse_and_reopen_refills_timeline() {
    let (mut ctl, rx) = test_controller();
    let k_main = AgentKey {
        session_id: "S1".to_string(),
        agent_id: String::new(),
    };
    let k_child = AgentKey {
        session_id: "S1".to_string(),
        agent_id: "sub-1".to_string(),
    };

    apply_at(
        &mut ctl,
        ServerMsg::Snapshot {
            agents: vec![
                test_agent("S1", Status::Working, 900),
                test_agent_with_id("S1", "sub-1", Status::Working, 950),
            ],
            aggregate: Status::Working,
            health: Health::default(),
            settings: Settings::default(),
            repo_pending: Vec::new(),
        },
        1_000,
    );
    assert_eq!(drain_timelines(&rx), vec![k_main]);

    ctl.toggle_open(&k_child, 1_000);
    assert!(ctl.model.is_open(&k_child));
    assert_eq!(drain_timelines(&rx), vec![k_child.clone()]);

    apply_at(
        &mut ctl,
        ServerMsg::Timeline {
            id: 1,
            key: k_child.clone(),
            entries: vec![TimelineEntry {
                ms: 960,
                kind: TimelineKind::Tool,
                tool_name: Some("Read".to_string()),
                text: Some("src/lib.rs".to_string()),
                outcome: Some(Outcome::Ok),
                dur_ms: Some(100),
            }],
        },
        1_050,
    );
    assert_eq!(
        ctl.model
            .timeline_rows(&k_child, &crate::clock::utc_hhmm)
            .len(),
        1
    );

    // Collapse clears cached child entries; reopening inside 500 ms must fetch again directly.
    ctl.toggle_open(&k_child, 1_100);
    assert!(!ctl.model.is_open(&k_child));
    assert!(
        ctl.model
            .timeline_rows(&k_child, &crate::clock::utc_hhmm)
            .is_empty()
    );
    assert!(drain_timelines(&rx).is_empty());

    ctl.toggle_open(&k_child, 1_200);
    assert!(ctl.model.is_open(&k_child));
    assert_eq!(
        drain_timelines(&rx),
        vec![k_child.clone()],
        "reopening a child row inside 500 ms must re-request its timeline directly"
    );

    apply_at(
        &mut ctl,
        ServerMsg::Timeline {
            id: 2,
            key: k_child.clone(),
            entries: vec![
                TimelineEntry {
                    ms: 960,
                    kind: TimelineKind::Tool,
                    tool_name: Some("Read".to_string()),
                    text: Some("src/lib.rs".to_string()),
                    outcome: Some(Outcome::Ok),
                    dur_ms: Some(100),
                },
                TimelineEntry {
                    ms: 1_180,
                    kind: TimelineKind::Tool,
                    tool_name: Some("Grep".to_string()),
                    text: Some("TimelineFetch".to_string()),
                    outcome: Some(Outcome::Pending),
                    dur_ms: None,
                },
            ],
        },
        1_250,
    );
    assert_eq!(
        ctl.model
            .timeline_rows(&k_child, &crate::clock::utc_hhmm)
            .len(),
        2
    );

    ctl.poll_timelines(1_500);
    assert!(drain_timelines(&rx).is_empty());
}

#[test]
fn controller_open_child_status_upsert_inside_cooldown_still_sends() {
    let (mut ctl, rx) = test_controller();
    let k_main = AgentKey {
        session_id: "S1".to_string(),
        agent_id: String::new(),
    };
    let k_child = AgentKey {
        session_id: "S1".to_string(),
        agent_id: "sub-1".to_string(),
    };

    apply_at(
        &mut ctl,
        ServerMsg::Snapshot {
            agents: vec![
                test_agent("S1", Status::Working, 900),
                test_agent_with_id("S1", "sub-1", Status::Working, 950),
            ],
            aggregate: Status::Working,
            health: Health::default(),
            settings: Settings::default(),
            repo_pending: Vec::new(),
        },
        1_000,
    );
    assert_eq!(drain_timelines(&rx), vec![k_main]);

    ctl.toggle_open(&k_child, 1_000);
    assert_eq!(drain_timelines(&rx), vec![k_child.clone()]);

    apply_at(
        &mut ctl,
        ServerMsg::Status {
            op: rocky_proto::pipe::StatusOp::Upsert,
            agent: test_agent_with_id("S1", "sub-1", Status::Working, 1_200),
        },
        1_200,
    );
    assert_eq!(
        drain_timelines(&rx),
        vec![k_child.clone()],
        "open child status upsert inside 500 ms must send directly"
    );

    apply_at(
        &mut ctl,
        ServerMsg::Status {
            op: rocky_proto::pipe::StatusOp::Upsert,
            agent: test_agent_with_id("S1", "sub-1", Status::NeedsYou, 1_350),
        },
        1_350,
    );
    assert_eq!(drain_timelines(&rx), vec![k_child.clone()]);

    apply_at(
        &mut ctl,
        ServerMsg::Status {
            op: rocky_proto::pipe::StatusOp::Upsert,
            agent: test_agent_with_id("S1", "sub-1", Status::Done, 1_400),
        },
        1_400,
    );
    assert!(drain_timelines(&rx).is_empty());

    // A child initially promoted in a main-less session becomes unthrottled once main arrives.
    let k_s2_main = AgentKey {
        session_id: "S2".to_string(),
        agent_id: String::new(),
    };
    let k_s2_child = AgentKey {
        session_id: "S2".to_string(),
        agent_id: "sub-a".to_string(),
    };
    apply_at(
        &mut ctl,
        ServerMsg::Status {
            op: rocky_proto::pipe::StatusOp::Upsert,
            agent: test_agent_with_id("S2", "sub-a", Status::Working, 1_000),
        },
        1_000,
    );
    assert_eq!(drain_timelines(&rx), vec![k_s2_child.clone()]);

    apply_at(
        &mut ctl,
        ServerMsg::Status {
            op: rocky_proto::pipe::StatusOp::Upsert,
            agent: test_agent("S2", Status::Working, 1_100),
        },
        1_100,
    );
    assert_eq!(drain_timelines(&rx), vec![k_s2_main]);

    ctl.toggle_open(&k_s2_child, 1_150);
    assert_eq!(drain_timelines(&rx), vec![k_s2_child.clone()]);

    apply_at(
        &mut ctl,
        ServerMsg::Status {
            op: rocky_proto::pipe::StatusOp::Upsert,
            agent: test_agent_with_id("S2", "sub-a", Status::Working, 1_200),
        },
        1_200,
    );
    assert_eq!(drain_timelines(&rx), vec![k_s2_child]);
}

fn atlas_project() -> crate::atlas_model::ProjectId {
    crate::atlas_model::ProjectId("/repos/rocky".to_string())
}

fn tool_step(ms: u64) -> TimelineEntry {
    TimelineEntry {
        ms,
        kind: TimelineKind::Tool,
        tool_name: Some("Edit".to_string()),
        text: Some("src/a.rs".to_string()),
        outcome: Some(Outcome::Ok),
        dur_ms: Some(10),
    }
}

fn step_at(key: &AgentKey, ms: u64) -> crate::atlas_model::StepRef {
    crate::atlas_model::StepRef {
        key: key.clone(),
        ms,
    }
}

#[test]
fn atlas_select_project_resets_step_and_turn() {
    use crate::atlas_model::{AtlasState, ProjectId};
    use crate::ui::atlas::AtlasAction;
    let (ctl, _rx) = test_controller();
    let key = AgentKey {
        session_id: "S1".to_string(),
        agent_id: String::new(),
    };
    let mut state = AtlasState {
        project: Some(atlas_project()),
        step: Some(step_at(&key, 100)),
        turn: Some((key.clone(), 50)),
        ..AtlasState::default()
    };
    let other = ProjectId("/repos/other".to_string());

    atlas_wiring::apply_atlas_action(
        &mut state,
        &ctl.model,
        &AtlasAction::SelectProject(other.clone()),
    );

    assert_eq!(state.project, Some(other));
    assert_eq!(state.step, None);
    assert_eq!(state.turn, None);
}

#[test]
fn atlas_step_by_moves_inside_the_turn() {
    use crate::atlas_model::AtlasState;
    use crate::atlas_model::test_support::model_with;
    use crate::ui::atlas::AtlasAction;
    let agent = test_agent("S1", Status::Idle, 1_000);
    let key = agent.key.clone();
    let model = model_with(
        vec![agent],
        vec![(
            key.clone(),
            vec![tool_step(100), tool_step(200), tool_step(300)],
        )],
        true,
    );
    let mut state = AtlasState {
        step: Some(step_at(&key, 200)),
        ..AtlasState::default()
    };

    atlas_wiring::apply_atlas_action(&mut state, &model, &AtlasAction::StepBy(true));
    assert_eq!(state.step, Some(step_at(&key, 300)));

    atlas_wiring::apply_atlas_action(&mut state, &model, &AtlasAction::StepBy(true));
    assert_eq!(state.step, Some(step_at(&key, 300)));
}

#[test]
fn atlas_sync_requests_idle_session_timelines_once() {
    use crate::atlas_model::SkyWindow;
    let (mut ctl, rx) = test_controller();
    let agent = test_agent("S1", Status::Idle, 99_000);
    let key = agent.key.clone();
    apply_at(
        &mut ctl,
        ServerMsg::Snapshot {
            agents: vec![agent],
            aggregate: Status::Idle,
            health: Health::default(),
            settings: Settings::default(),
            repo_pending: Vec::new(),
        },
        100_000,
    );
    drain_timelines(&rx);

    ctl.sync_atlas_timelines(&atlas_project(), SkyWindow::Min10, 100_000);
    assert_eq!(drain_timelines(&rx), vec![key]);

    ctl.sync_atlas_timelines(&atlas_project(), SkyWindow::Min10, 100_500);
    assert!(drain_timelines(&rx).is_empty());
}
