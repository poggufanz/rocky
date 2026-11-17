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

fn working_snapshot(agents: Vec<AgentStatus>) -> ServerMsg {
    ServerMsg::Snapshot {
        agents,
        aggregate: Status::Working,
        health: Health::default(),
        settings: Settings::default(),
        repo_pending: Vec::new(),
    }
}

fn upsert(agent: AgentStatus) -> ServerMsg {
    ServerMsg::Status {
        op: rocky_proto::pipe::StatusOp::Upsert,
        agent,
    }
}

#[test]
fn controller_requests_active_timeline_once_and_flushes_trailing_at_cooldown() {
    let (mut ctl, rx) = test_controller();
    let k1 = AgentKey {
        session_id: "S1".to_string(),
        agent_id: String::new(),
    };

    apply_at(
        &mut ctl,
        working_snapshot(vec![test_agent("S1", Status::Working, 900)]),
        1_000,
    );
    assert_eq!(drain_timelines(&rx), vec![k1.clone()]);

    // A cached reply must not trigger another request.
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
    assert!(ctl.model.timeline(&k1).is_some());

    // An upsert inside the 500 ms cooldown is deferred, then flushed once by poll.
    apply_at(
        &mut ctl,
        upsert(test_agent("S1", Status::Working, 1_100)),
        1_100,
    );
    assert!(drain_timelines(&rx).is_empty());

    ctl.poll_timelines(1_499);
    assert!(drain_timelines(&rx).is_empty());

    ctl.poll_timelines(1_500);
    assert_eq!(drain_timelines(&rx), vec![k1.clone()]);

    ctl.poll_timelines(1_600);
    assert!(drain_timelines(&rx).is_empty());

    // Leaving active must not emit a dead request.
    apply_at(
        &mut ctl,
        upsert(test_agent("S1", Status::Done, 2_100)),
        2_100,
    );
    assert!(drain_timelines(&rx).is_empty());
}

#[test]
fn controller_wanted_working_subagent_upserts_share_the_cooldown() {
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
        working_snapshot(vec![
            test_agent("S1", Status::Working, 900),
            test_agent_with_id("S1", "sub-1", Status::Idle, 950),
        ]),
        1_000,
    );
    assert_eq!(drain_timelines(&rx), vec![k_main]);
    ctl.model
        .set_wanted(std::collections::BTreeSet::from([k_child.clone()]));

    // The first Working upsert asks at once; the next one 100 ms later waits.
    apply_at(
        &mut ctl,
        upsert(test_agent_with_id("S1", "sub-1", Status::Working, 2_000)),
        2_000,
    );
    assert_eq!(drain_timelines(&rx), vec![k_child.clone()]);
    apply_at(
        &mut ctl,
        upsert(test_agent_with_id("S1", "sub-1", Status::Working, 2_100)),
        2_100,
    );
    assert!(drain_timelines(&rx).is_empty());

    ctl.poll_timelines(2_499);
    assert!(drain_timelines(&rx).is_empty());
    ctl.poll_timelines(2_500);
    assert_eq!(drain_timelines(&rx), vec![k_child]);
}

#[test]
fn controller_snapshot_asks_a_wanted_working_subagent_once() {
    let (mut ctl, rx) = test_controller();
    let k_main = AgentKey {
        session_id: "S1".to_string(),
        agent_id: String::new(),
    };
    let k_child = AgentKey {
        session_id: "S1".to_string(),
        agent_id: "sub-1".to_string(),
    };
    ctl.model
        .set_wanted(std::collections::BTreeSet::from([k_child.clone()]));
    apply_at(
        &mut ctl,
        working_snapshot(vec![
            test_agent("S1", Status::Working, 900),
            test_agent_with_id("S1", "sub-1", Status::Working, 950),
        ]),
        1_000,
    );
    let mut asked = drain_timelines(&rx);
    asked.sort();
    assert_eq!(asked, vec![k_main, k_child]);
}

#[test]
fn constellation_asks_for_the_timeline_of_a_session_idle_past_the_sky_window() {
    use crate::atlas_model::{AtlasLayout, AtlasState};
    let now = 10_000_000;
    let idle = test_agent("S1", Status::Idle, now - 20 * 60_000);
    let key = idle.key.clone();
    let mut asked = Vec::new();
    for layout in [AtlasLayout::Sky, AtlasLayout::Constellation] {
        let (mut ctl, rx) = test_controller();
        apply_at(&mut ctl, working_snapshot(vec![idle.clone()]), now);
        let state = AtlasState {
            layout,
            ..AtlasState::default()
        };
        ctl.sync_atlas_timelines(&atlas_project(), state.wanted_window(), now);
        asked.push(drain_timelines(&rx));
    }
    assert!(asked[0].is_empty(), "the Sky chart does not draw it");
    assert_eq!(asked[1], vec![key]);
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

    ctl.sync_atlas_timelines(&atlas_project(), Some(SkyWindow::Min10), 100_000);
    assert_eq!(drain_timelines(&rx), vec![key]);

    ctl.sync_atlas_timelines(&atlas_project(), Some(SkyWindow::Min10), 100_500);
    assert!(drain_timelines(&rx).is_empty());
}

#[test]
fn atlas_sync_before_connect_is_requested_by_the_next_snapshot() {
    use crate::atlas_model::SkyWindow;
    let (mut ctl, rx) = test_controller();
    let (late_tx, late_rx) = mpsc::channel();
    let agent = test_agent("S1", Status::Idle, 99_000);
    let key = agent.key.clone();
    let snapshot = ServerMsg::Snapshot {
        agents: vec![agent],
        aggregate: Status::Idle,
        health: Health::default(),
        settings: Settings::default(),
        repo_pending: Vec::new(),
    };
    ctl.outbox = None;
    ctl.model.apply(snapshot.clone());
    ctl.sync_atlas_timelines(&atlas_project(), Some(SkyWindow::Min10), 100_000);
    assert!(drain_timelines(&rx).is_empty());

    ctl.outbox = Some(late_tx);
    apply_at(&mut ctl, snapshot, 100_500);

    assert_eq!(drain_timelines(&late_rx), vec![key]);
}

#[test]
fn sky_plot_fits_the_card_in_a_narrow_window() {
    use crate::ui::atlas::sky_view::{BAND_LABEL_W, plot_width};
    // A 455 px window is narrow: no sidebar column, 12 px page padding, 14 px
    // card padding and a 1 px border on each side.
    let avail = atlas_wiring::sky_avail_width(455.0, true);
    assert_eq!(avail, 455.0 - 24.0 - 30.0);
    assert!(plot_width(avail) + BAND_LABEL_W <= avail);
}

#[test]
fn sky_card_width_respects_the_sidebar_and_the_column_cap() {
    // Wide: the sidebar takes 224 + 24 px; the column caps at 1200.
    assert_eq!(
        atlas_wiring::sky_avail_width(1400.0, false),
        1400.0 - 248.0 - 24.0 - 30.0
    );
    assert_eq!(atlas_wiring::sky_avail_width(2400.0, false), 1200.0 - 30.0);
}

fn turn_start_entry(ms: u64) -> TimelineEntry {
    TimelineEntry {
        ms,
        kind: TimelineKind::TurnStart,
        tool_name: None,
        text: None,
        outcome: None,
        dur_ms: None,
    }
}

/// Two turns of one idle session: steps 110 and 120, then 210 and 220.
fn two_turn_model() -> (Model, AgentKey) {
    use crate::atlas_model::test_support::model_with;
    let agent = test_agent("S1", Status::Idle, 1_000);
    let key = agent.key.clone();
    let entries = vec![
        turn_start_entry(100),
        tool_step(110),
        tool_step(120),
        turn_start_entry(200),
        tool_step(210),
        tool_step(220),
    ];
    (
        model_with(vec![agent], vec![(key.clone(), entries)], true),
        key,
    )
}

#[test]
fn atlas_show_turn_selects_a_step_of_that_turn_for_detail_and_keys() {
    use crate::atlas_model::AtlasState;
    use crate::ui::atlas::AtlasAction;
    let (model, key) = two_turn_model();
    let mut state = AtlasState {
        project: Some(atlas_project()),
        step: Some(step_at(&key, 220)),
        turn: Some((key.clone(), 200)),
        ..AtlasState::default()
    };

    atlas_wiring::apply_atlas_action(&mut state, &model, &AtlasAction::ShowTurn(key.clone(), 100));
    assert_eq!(state.step, Some(step_at(&key, 120)));
    assert_eq!(state.turn, Some((key.clone(), 100)));

    atlas_wiring::apply_atlas_action(&mut state, &model, &AtlasAction::StepBy(false));
    assert_eq!(state.step, Some(step_at(&key, 110)));
}

#[test]
fn atlas_switching_to_constellation_pins_the_selected_steps_turn() {
    use crate::atlas_model::{AtlasLayout, AtlasState};
    use crate::ui::atlas::AtlasAction;
    let (model, key) = two_turn_model();
    let mut state = AtlasState {
        project: Some(atlas_project()),
        step: Some(step_at(&key, 110)),
        ..AtlasState::default()
    };

    atlas_wiring::apply_atlas_action(
        &mut state,
        &model,
        &AtlasAction::SetLayout(AtlasLayout::Constellation),
    );
    assert_eq!(state.turn, Some((key, 100)));
}

#[test]
fn atlas_selecting_a_subagent_star_keeps_the_primary_turn() {
    use crate::atlas_model::test_support::model_with;
    use crate::atlas_model::{AtlasLayout, AtlasState};
    use crate::ui::atlas::AtlasAction;
    let parent = test_agent("S1", Status::Idle, 1_000);
    let child = test_agent_with_id("S1", "sub-1", Status::Idle, 1_000);
    let (pk, ck) = (parent.key.clone(), child.key.clone());
    let model = model_with(
        vec![parent, child],
        vec![
            (pk.clone(), vec![turn_start_entry(100), tool_step(110)]),
            (ck.clone(), vec![tool_step(115)]),
        ],
        true,
    );
    let mut state = AtlasState {
        project: Some(atlas_project()),
        layout: AtlasLayout::Constellation,
        turn: Some((pk.clone(), 100)),
        ..AtlasState::default()
    };

    atlas_wiring::apply_atlas_action(
        &mut state,
        &model,
        &AtlasAction::SelectStep(step_at(&ck, 115)),
    );
    assert_eq!(state.step, Some(step_at(&ck, 115)));
    assert_eq!(state.turn, Some((pk, 100)));
}

#[test]
fn atlas_show_turn_without_steps_shows_no_detail_and_keys_do_nothing() {
    use crate::atlas_model::test_support::model_with;
    use crate::atlas_model::{AtlasLayout, AtlasState};
    use crate::ui::atlas::AtlasAction;
    let agent = test_agent("S1", Status::Idle, 1_000);
    let key = agent.key.clone();
    let entries = vec![turn_start_entry(100), turn_start_entry(200), tool_step(210)];
    let model = model_with(vec![agent], vec![(key.clone(), entries)], true);
    let mut state = AtlasState {
        project: Some(atlas_project()),
        layout: AtlasLayout::Constellation,
        step: Some(step_at(&key, 210)),
        turn: Some((key.clone(), 200)),
        ..AtlasState::default()
    };

    atlas_wiring::apply_atlas_action(&mut state, &model, &AtlasAction::ShowTurn(key.clone(), 100));
    assert_eq!(state.step, None);
    assert!(atlas_wiring::resolve_detail(&state, &model, None).is_none());

    atlas_wiring::apply_atlas_action(&mut state, &model, &AtlasAction::StepBy(true));
    atlas_wiring::apply_atlas_action(&mut state, &model, &AtlasAction::StepBy(false));
    assert_eq!(state.step, None);
}
