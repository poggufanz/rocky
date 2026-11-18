use super::sky::*;
use super::test_support::model_with;
use super::{ProjectId, SkyWindow};
use crate::cards_model::CardsModel;
use crate::i18n::UiLang;
use rocky_proto::cards::{CARD_VERSION, Card, CardStatus, Coverage, CoverageState, Importance};
use rocky_proto::pipe::{
    AgentKey, AgentStatus, Outcome, PromptText, RepoInfo, Status, TimelineEntry, TimelineKind,
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
        harness: None,
    }
}

fn entry(
    ms: u64,
    kind: TimelineKind,
    tool: Option<&str>,
    outcome: Option<Outcome>,
) -> TimelineEntry {
    TimelineEntry {
        ms,
        kind,
        tool_name: tool.map(str::to_string),
        text: None,
        outcome,
        dur_ms: None,
    }
}

fn tool(ms: u64, name: &str, outcome: Outcome) -> TimelineEntry {
    entry(ms, TimelineKind::Tool, Some(name), Some(outcome))
}

fn turn_start(ms: u64) -> TimelineEntry {
    entry(ms, TimelineKind::TurnStart, None, None)
}

fn project() -> ProjectId {
    ProjectId(ROOT.into())
}

fn chart(
    agents: Vec<AgentStatus>,
    timelines: Vec<(AgentKey, Vec<TimelineEntry>)>,
    tree: bool,
) -> SkyChart {
    let model = model_with(agents, timelines, tree);
    sky_chart(
        &model,
        &CardsModel::new(),
        &project(),
        SkyWindow::Min10,
        NOW,
        UiLang::En,
    )
}

#[test]
fn steps_older_than_the_window_are_not_drawn() {
    let k = key("s1", "");
    let tl = vec![
        turn_start(NOW - 700_000),
        tool(NOW - 600_001, "Read", Outcome::Ok),
        tool(NOW - 600_000, "Read", Outcome::Ok),
    ];
    let c = chart(
        vec![agent("s1", "", Status::Idle, NOW - 590_000)],
        vec![(k, tl)],
        false,
    );
    let ms: Vec<u64> = c.bands[0].stars.iter().map(|s| s.step.ms).collect();
    assert_eq!(ms, vec![NOW - 600_000]);
}

#[test]
fn rows_and_magnitudes_follow_the_legend() {
    assert_eq!(row_of(Some("Edit")), RowKind::Edit);
    assert_eq!(row_of(Some("Bash")), RowKind::Cmd);
    assert_eq!(row_of(Some("Grep")), RowKind::Read);
    assert_eq!(row_of(Some("mcp__x__y")), RowKind::Read);
    assert_eq!(magnitude(Some(400)), 2.5);
    assert_eq!(magnitude(None), 2.5);
    assert_eq!(magnitude(Some(1_100)), 3.7);
    assert_eq!(magnitude(Some(12_000)), 6.0);
}

#[test]
fn live_turn_marks_failed_and_running_steps() {
    let k = key("s1", "");
    let tl = vec![
        turn_start(NOW - 60_000),
        tool(NOW - 50_000, "Read", Outcome::Ok),
        tool(NOW - 40_000, "Bash", Outcome::Failed),
        tool(NOW - 30_000, "Edit", Outcome::Pending),
    ];
    let c = chart(
        vec![agent("s1", "", Status::Working, NOW - 30_000)],
        vec![(k, tl)],
        false,
    );
    let band = &c.bands[0];
    assert_eq!(band.stars.len(), 3);
    let kinds: Vec<_> = band.stars.iter().map(|s| s.kind).collect();
    assert_eq!(
        kinds,
        [StarKind::Plain, StarKind::Failed, StarKind::Running]
    );
    assert_eq!(band.stars[2].radius, LIVE_RADIUS);
    assert_eq!(band.turns.len(), 1);
    assert!(band.turns[0].live);
    assert_eq!(band.turns[0].stars, vec![0, 1, 2]);
}

#[test]
fn steps_before_the_first_turn_start_form_an_untitled_turn() {
    let k = key("s1", "");
    let tl = vec![
        tool(NOW - 90_000, "Read", Outcome::Ok),
        tool(NOW - 80_000, "Read", Outcome::Ok),
        turn_start(NOW - 70_000),
        tool(NOW - 60_000, "Edit", Outcome::Ok),
    ];
    let c = chart(
        vec![agent("s1", "", Status::Idle, NOW - 60_000)],
        vec![(k, tl)],
        false,
    );
    let turns = &c.bands[0].turns;
    assert_eq!(turns.len(), 2);
    assert_eq!(turns[0].title, None);
    assert_eq!(turns[0].stars.len(), 2);
    assert!(!turns[1].live);
}

#[test]
fn idle_band_without_steps_in_window_gets_a_quiet_note() {
    let k = key("s1", "");
    let last = NOW - 20 * 60_000;
    let tl = vec![turn_start(last - 5_000), tool(last, "Edit", Outcome::Ok)];
    let c = chart(
        vec![agent("s1", "", Status::Idle, last)],
        vec![(k, tl)],
        false,
    );
    let band = &c.bands[0];
    assert!(band.stars.is_empty());
    assert_eq!(band.quiet.as_ref().unwrap().last_ms, last);
    let earlier = band.earlier.as_ref().unwrap();
    assert_eq!(earlier.edits, 1);
}

#[test]
fn subagent_lane_only_when_the_tree_setting_is_on() {
    let build = |tree| {
        chart(
            vec![
                agent("s1", "", Status::Working, NOW - 10_000),
                agent("s1", "c1", Status::Working, NOW - 10_000),
            ],
            vec![
                (
                    key("s1", ""),
                    vec![
                        turn_start(NOW - 60_000),
                        tool(NOW - 20_000, "Read", Outcome::Ok),
                    ],
                ),
                (
                    key("s1", "c1"),
                    vec![
                        entry(NOW - 50_000, TimelineKind::SubagentStart, None, None),
                        tool(NOW - 40_000, "Grep", Outcome::Ok),
                    ],
                ),
            ],
            tree,
        )
    };
    let on = build(true);
    let band = &on.bands[0];
    assert_eq!(band.subs.len(), 1);
    assert_eq!(band.subs[0].key, key("s1", "c1"));
    let spawn_ms = band.subs[0].spawn_ms.expect("subagent started");
    let first_star = band.stars[band.subs[0].stars[0]].step.ms;
    assert!(
        spawn_ms < first_star,
        "spawn {spawn_ms} before star {first_star}"
    );
    let d = 800.0;
    assert!(on.scale.x(spawn_ms, d) < on.scale.x(first_star, d));
    assert_eq!(band.subs[0].stars.len(), 1);
    for &i in &band.subs[0].stars {
        assert_eq!(band.stars[i].row, RowKind::Sub(0));
        assert_eq!(band.stars[i].step.key, key("s1", "c1"));
    }
    assert_eq!(
        band.stars
            .iter()
            .filter(|s| s.row == RowKind::Sub(0))
            .count(),
        1
    );
    assert_eq!(on.bands.len(), 1);
    assert!(build(false).bands[0].subs.is_empty());
    assert_eq!(build(false).bands[0].stars.len(), 1);
}

#[test]
fn bands_order_working_then_needs_you_then_recent() {
    let c = chart(
        vec![
            agent("idle", "", Status::Idle, NOW - 1_000),
            agent("needs", "", Status::NeedsYou, NOW - 5_000),
            agent("work", "", Status::Working, NOW - 9_000),
        ],
        vec![],
        false,
    );
    let order: Vec<_> = c.bands.iter().map(|b| b.key.session_id.as_str()).collect();
    assert_eq!(order, ["work", "needs", "idle"]);
}

#[test]
fn future_entries_clamp_to_the_right_edge() {
    let k = key("s1", "");
    let tl = vec![
        turn_start(NOW - 1_000),
        tool(NOW + 5_000, "Read", Outcome::Ok),
    ];
    let c = chart(
        vec![agent("s1", "", Status::Idle, NOW)],
        vec![(k, tl)],
        false,
    );
    let ms = c.bands[0].stars[0].step.ms;
    assert_eq!(c.scale.x(ms, 800.0), 800.0);
}

#[test]
fn needs_you_agent_shows_a_waiting_star() {
    let k = key("s1", "");
    let tl = vec![
        turn_start(NOW - 30_000),
        entry(NOW - 20_000, TimelineKind::NeedsYou, Some("Bash"), None),
    ];
    let c = chart(
        vec![agent("s1", "", Status::NeedsYou, NOW - 20_000)],
        vec![(k, tl)],
        false,
    );
    assert_eq!(c.bands[0].stars[0].kind, StarKind::Waiting);
}

#[test]
fn ticks_align_to_wall_clock_inside_the_drawn_spans() {
    let k = key("s1", "");
    let mut tl = vec![turn_start(NOW - 310_000)];
    tl.extend((0..=10).map(|i| tool(NOW - 300_000 + i * 30_000, "Read", Outcome::Ok)));
    let c = chart(
        vec![agent("s1", "", Status::Idle, NOW)],
        vec![(k, tl)],
        false,
    );
    let ticks = c.scale.ticks(800.0);
    assert!(ticks.len() >= 4);
    assert!(ticks.iter().all(|t| t.ms % 60_000 == 0));
}

fn card(id: &str, session: &str, started_ms: u64, prompt: &str) -> Card {
    Card {
        v: CARD_VERSION,
        card_id: id.into(),
        rev: 1,
        repo_id: "r".into(),
        root: ROOT.into(),
        main_root: None,
        branch: None,
        session_id: session.into(),
        agent_id: String::new(),
        agent_type: String::new(),
        parent_card_id: None,
        started_ms,
        ended_ms: None,
        status: CardStatus::Done,
        prompt: prompt.into(),
        prompt_truncated: false,
        importance: Importance::Medium,
        blocks: Vec::new(),
        more_count: 0,
        flow: Vec::new(),
        flow_more: 0,
        outside_count: 0,
        reads: Vec::new(),
        reads_more: 0,
        sequence: None,
        coverage: Coverage {
            state: CoverageState::Full,
            reasons: Vec::new(),
        },
    }
}

#[test]
fn turn_titles_come_from_the_live_prompt_and_matching_cards() {
    let k = key("s1", "");
    let mut a = agent("s1", "", Status::Working, NOW - 5_000);
    a.prompt = Some(PromptText {
        text: "Add sky chart\nmore detail".into(),
        truncated: false,
    });
    let tl = vec![
        turn_start(NOW - 100_000),
        tool(NOW - 90_000, "Read", Outcome::Ok),
        turn_start(NOW - 20_000),
        tool(NOW - 10_000, "Read", Outcome::Pending),
    ];
    let model = model_with(vec![a], vec![(k, tl)], false);
    let mut cards = CardsModel::new();
    cards.on_push(card("c1", "s1", NOW - 102_000, "Fix the bug"));
    let c = sky_chart(
        &model,
        &cards,
        &project(),
        SkyWindow::Min10,
        NOW,
        UiLang::En,
    );
    let turns = &c.bands[0].turns;
    assert_eq!(turns[0].title.as_deref(), Some("Fix the bug"));
    assert_eq!(turns[1].title.as_deref(), Some("Add sky chart"));
}

#[test]
fn working_subagent_last_pending_step_is_running() {
    let c = chart(
        vec![
            agent("s1", "", Status::Working, NOW - 10_000),
            agent("s1", "c1", Status::Working, NOW - 10_000),
        ],
        vec![
            (
                key("s1", ""),
                vec![
                    turn_start(NOW - 60_000),
                    tool(NOW - 20_000, "Read", Outcome::Ok),
                ],
            ),
            (
                key("s1", "c1"),
                vec![
                    entry(NOW - 50_000, TimelineKind::SubagentStart, None, None),
                    tool(NOW - 40_000, "Grep", Outcome::Ok),
                    tool(NOW - 30_000, "Bash", Outcome::Pending),
                ],
            ),
        ],
        true,
    );
    let band = &c.bands[0];
    let subs: Vec<&Star> = band
        .stars
        .iter()
        .filter(|s| s.row == RowKind::Sub(0))
        .collect();
    assert_eq!(subs.len(), 2);
    assert_eq!(subs[0].kind, StarKind::Plain);
    assert_eq!(subs[1].kind, StarKind::Running);
    assert_eq!(subs[1].radius, LIVE_RADIUS);
}

#[test]
fn only_failed_and_live_stars_carry_a_label() {
    let k = key("s1", "");
    let mut failed = tool(NOW - 40_000, "Bash", Outcome::Failed);
    failed.text = Some("cargo check".into());
    let mut running = tool(NOW - 30_000, "Edit", Outcome::Pending);
    running.text = Some(format!("{ROOT}/src/a.rs"));
    let tl = vec![
        turn_start(NOW - 60_000),
        tool(NOW - 50_000, "Read", Outcome::Ok),
        failed,
        running,
    ];
    let c = chart(
        vec![agent("s1", "", Status::Working, NOW - 30_000)],
        vec![(k, tl)],
        false,
    );
    let labels: Vec<_> = c.bands[0].stars.iter().map(|s| s.label.clone()).collect();
    assert_eq!(
        labels,
        [
            None,
            Some("cmd cargo check".to_string()),
            Some("edit src/a.rs".to_string())
        ]
    );
}

#[test]
fn running_last_step_makes_a_running_star_and_a_live_turn() {
    let k = key("s1", "");
    let tl = vec![
        turn_start(NOW - 20_000),
        tool(NOW - 15_000, "Read", Outcome::Ok),
        tool(NOW, "Bash", Outcome::Pending),
    ];
    let c = chart(
        vec![agent("s1", "", Status::Working, NOW)],
        vec![(k, tl)],
        false,
    );
    let band = &c.bands[0];
    assert_eq!(band.stars.last().unwrap().kind, StarKind::Running);
    let last = band.stars.last().unwrap().step.ms;
    assert_eq!(c.scale.x(last, 800.0), 800.0);
    assert!(band.turns.last().unwrap().live);
}

#[test]
fn subagent_without_a_spawn_entry_starts_at_its_first_entry() {
    let c = chart(
        vec![
            agent("s1", "", Status::Working, NOW - 10_000),
            agent("s1", "c1", Status::Idle, NOW - 10_000),
        ],
        vec![
            (key("s1", ""), vec![turn_start(NOW - 60_000)]),
            (
                key("s1", "c1"),
                vec![tool(NOW - 40_000, "Grep", Outcome::Ok)],
            ),
        ],
        true,
    );
    let lane = &c.bands[0].subs[0];
    let first = c.bands[0].stars[lane.stars[0]].step.ms;
    assert_eq!(lane.spawn_ms, Some(first));
}
