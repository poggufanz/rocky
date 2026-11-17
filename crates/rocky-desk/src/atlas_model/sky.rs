//! Sky chart geometry: every agent step of one project as a star placed by time.

use super::{ProjectId, SkyWindow, StepRef, project_id};
use crate::cards_model::{CardsModel, first_non_empty_line, prompt_display, sanitize_single_line};
use crate::i18n::UiLang;
use crate::now_model::tool_label;
use crate::view::{Model, action_target, short8};
use rocky_proto::pipe::{AgentKey, AgentStatus, Outcome, Status, TimelineEntry, TimelineKind};

/// Share of the window, counted back from now, that gets the wide right part of the plot.
pub const RECENT_SHARE_OF_WINDOW: f32 = 0.3;
/// Share of the plot width given to that recent part.
pub const RECENT_SHARE_OF_WIDTH: f32 = 0.7;
/// Radius of the one star that is still in flight.
pub const LIVE_RADIUS: f32 = 4.5;

const SHORT_MS: u64 = 1_000;
const LONG_MS: u64 = 10_000;
const TITLE_MATCH_MS: u64 = 5_000;
/// The old part of the plot spans `[0, OLD_SHARE_OF_WIDTH)`.
const OLD_SHARE_OF_WIDTH: f64 = 1.0 - RECENT_SHARE_OF_WIDTH as f64;

/// Position of `t_ms` as a fraction of plot width; `None` before the window start.
pub fn x_frac(t_ms: u64, now_ms: u64, window: SkyWindow) -> Option<f32> {
    let span = window.secs() * 1000;
    let start = now_ms.saturating_sub(span);
    if t_ms < start {
        return None;
    }
    if t_ms >= now_ms {
        return Some(1.0);
    }
    let split = now_ms - (f64::from(RECENT_SHARE_OF_WINDOW) * span as f64) as u64;
    let x = if t_ms < split {
        OLD_SHARE_OF_WIDTH * (t_ms - start) as f64 / (split - start).max(1) as f64
    } else {
        OLD_SHARE_OF_WIDTH
            + f64::from(RECENT_SHARE_OF_WIDTH) * (t_ms - split) as f64
                / (now_ms - split).max(1) as f64
    };
    Some(x as f32)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RowKind {
    Edit,
    Read,
    Cmd,
    Sub(usize),
}

pub fn row_of(tool_name: Option<&str>) -> RowKind {
    match tool_name.map(tool_label).as_deref() {
        Some("edit") => RowKind::Edit,
        Some("cmd") => RowKind::Cmd,
        _ => RowKind::Read,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StarKind {
    Plain,
    Failed,
    Running,
    Waiting,
}

pub fn magnitude(dur_ms: Option<u64>) -> f32 {
    match dur_ms {
        Some(d) if d > LONG_MS => 6.0,
        Some(d) if d >= SHORT_MS => 3.7,
        _ => 2.5,
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Star {
    pub step: StepRef,
    pub x: f32,
    pub row: RowKind,
    pub radius: f32,
    pub kind: StarKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Turn {
    /// Indexes into `SkyBand.stars`, in step order.
    pub stars: Vec<usize>,
    pub live: bool,
    pub start_ms: u64,
    pub title: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SubLane {
    pub key: AgentKey,
    pub label: String,
    pub spawn_x: Option<f32>,
    /// Indexes into the parent `SkyBand.stars`, in step order.
    pub stars: Vec<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuietNote {
    pub last_ms: u64,
    pub action: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EarlierNote {
    pub start_ms: u64,
    pub edits: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SkyBand {
    pub key: AgentKey,
    pub harness: Option<String>,
    pub branch: Option<String>,
    pub status: Status,
    pub subs: Vec<SubLane>,
    pub stars: Vec<Star>,
    pub turns: Vec<Turn>,
    pub quiet: Option<QuietNote>,
    pub earlier: Option<EarlierNote>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Tick {
    pub x: f32,
    pub ms: u64,
    pub labeled: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SkyChart {
    pub window: SkyWindow,
    pub ticks: Vec<Tick>,
    pub bands: Vec<SkyBand>,
}

/// One turn of a whole timeline, before any window filtering.
pub(crate) struct TurnSlice<'a> {
    pub start_ms: u64,
    pub titled: bool,
    pub steps: Vec<&'a TimelineEntry>,
}

/// Splits a timeline into turns. Steps before the first `TurnStart` form one
/// untitled turn; a titled turn with no steps is still returned.
pub(crate) fn split_turns(entries: &[TimelineEntry]) -> Vec<TurnSlice<'_>> {
    let mut turns: Vec<TurnSlice<'_>> = Vec::new();
    for entry in entries {
        match entry.kind {
            TimelineKind::TurnStart => turns.push(TurnSlice {
                start_ms: entry.ms,
                titled: true,
                steps: Vec::new(),
            }),
            TimelineKind::Tool | TimelineKind::NeedsYou => {
                if turns.is_empty() {
                    turns.push(TurnSlice {
                        start_ms: entry.ms,
                        titled: false,
                        steps: Vec::new(),
                    });
                }
                if let Some(turn) = turns.last_mut() {
                    turn.steps.push(entry);
                }
            }
            _ => {}
        }
    }
    turns
}

fn is_pending(entry: &TimelineEntry) -> bool {
    matches!(entry.outcome, None | Some(Outcome::Pending))
}

/// Kind of one star; `is_last_of_live_turn` marks the step still in flight.
pub(crate) fn star_kind(
    entry: &TimelineEntry,
    is_last_of_live_turn: bool,
    agent: Status,
) -> StarKind {
    if entry.outcome == Some(Outcome::Failed) {
        return StarKind::Failed;
    }
    if !is_last_of_live_turn || !is_pending(entry) {
        return StarKind::Plain;
    }
    match (agent, entry.kind) {
        (Status::Working, _) => StarKind::Running,
        (Status::NeedsYou, TimelineKind::NeedsYou) => StarKind::Waiting,
        _ => StarKind::Plain,
    }
}

pub(crate) fn is_live_status(status: Status) -> bool {
    matches!(status, Status::Working | Status::NeedsYou)
}

fn tick_step_secs(window: SkyWindow) -> u64 {
    match window {
        SkyWindow::Min10 => 60,
        SkyWindow::Min30 => 300,
        SkyWindow::Hours2 => 900,
    }
}

fn ticks(now_ms: u64, window: SkyWindow) -> Vec<Tick> {
    let step = tick_step_secs(window) * 1000;
    let start = now_ms.saturating_sub(window.secs() * 1000);
    let split = now_ms - (f64::from(RECENT_SHARE_OF_WINDOW) * (window.secs() * 1000) as f64) as u64;
    let mut out = Vec::new();
    let mut old_index = 0usize;
    let mut ms = start.div_ceil(step) * step;
    while ms <= now_ms {
        let in_old = ms < split;
        let labeled = !in_old || old_index.is_multiple_of(2);
        if in_old {
            old_index += 1;
        }
        if let Some(x) = x_frac(ms, now_ms, window) {
            out.push(Tick { x, ms, labeled });
        }
        ms += step;
    }
    out
}

fn one_line(text: &str, lang: UiLang) -> Option<String> {
    let (display, _) = prompt_display(text, lang);
    let clean = sanitize_single_line(first_non_empty_line(&display))
        .trim()
        .to_string();
    (!clean.is_empty()).then_some(clean)
}

fn card_title(cards: &CardsModel, session_id: &str, start_ms: u64, lang: UiLang) -> Option<String> {
    cards
        .items()
        .iter()
        .find(|c| {
            c.session_id == session_id
                && c.agent_id.is_empty()
                && c.started_ms.abs_diff(start_ms) <= TITLE_MATCH_MS
        })
        .and_then(|c| one_line(&c.prompt, lang))
}

/// Title of one turn: the live turn uses the agent's current prompt, a titled
/// past turn looks up its prompt card, an untitled turn has none.
pub(crate) fn turn_title(
    agent: &AgentStatus,
    cards: &CardsModel,
    is_live: bool,
    titled: bool,
    start_ms: u64,
    lang: UiLang,
) -> Option<String> {
    if is_live {
        agent.prompt.as_ref().and_then(|p| one_line(&p.text, lang))
    } else if titled {
        card_title(cards, &agent.key.session_id, start_ms, lang)
    } else {
        None
    }
}

/// Kinds of the steps of one turn, in step order. `live_status` is the agent's
/// status when this is the turn it is still working in.
pub(crate) fn turn_kinds(steps: &[&TimelineEntry], live_status: Option<Status>) -> Vec<StarKind> {
    let live_idx = live_status.and_then(|_| steps.iter().rposition(|e| is_pending(e)));
    let status = live_status.unwrap_or(Status::Idle);
    steps
        .iter()
        .enumerate()
        .map(|(i, e)| star_kind(e, live_idx == Some(i), status))
        .collect()
}

fn band_rank(status: Status) -> u8 {
    match status {
        Status::Working => 0,
        Status::NeedsYou => 1,
        _ => 2,
    }
}

/// Stars of one agent's steps that fall in the window. `live` is the turn the
/// agent is still working in; its one pending step is the live star.
fn turn_stars(
    steps: &[&TimelineEntry],
    key: &AgentKey,
    row_override: Option<RowKind>,
    live_status: Option<Status>,
    now_ms: u64,
    window: SkyWindow,
) -> Vec<Star> {
    let in_window: Vec<(&TimelineEntry, f32)> = steps
        .iter()
        .filter_map(|e| x_frac(e.ms, now_ms, window).map(|x| (*e, x)))
        .collect();
    let live_idx = live_status.and_then(|_| in_window.iter().rposition(|(e, _)| is_pending(e)));
    in_window
        .iter()
        .enumerate()
        .map(|(i, (entry, x))| {
            let status = live_status.unwrap_or(Status::Idle);
            let kind = star_kind(entry, live_idx == Some(i), status);
            let live_star = matches!(kind, StarKind::Running | StarKind::Waiting);
            Star {
                step: StepRef {
                    key: key.clone(),
                    ms: entry.ms,
                },
                x: *x,
                row: row_override.unwrap_or_else(|| row_of(entry.tool_name.as_deref())),
                radius: if live_star {
                    LIVE_RADIUS
                } else {
                    magnitude(entry.dur_ms)
                },
                kind,
            }
        })
        .collect()
}

struct BandInput<'a> {
    agent: &'a AgentStatus,
    cards: &'a CardsModel,
    now_ms: u64,
    window: SkyWindow,
    lang: UiLang,
}

fn primary_turns(
    input: &BandInput<'_>,
    slices: &[TurnSlice<'_>],
    stars: &mut Vec<Star>,
) -> Vec<Turn> {
    let agent = input.agent;
    let start = input.now_ms.saturating_sub(input.window.secs() * 1000);
    let kept: Vec<&TurnSlice<'_>> = slices
        .iter()
        .filter(|s| s.steps.iter().any(|e| e.ms >= start) || (s.titled && s.start_ms >= start))
        .collect();
    let live_status = is_live_status(agent.status).then_some(agent.status);
    let mut turns = Vec::new();
    for (i, slice) in kept.iter().enumerate() {
        let is_live = live_status.is_some() && i + 1 == kept.len();
        let built = turn_stars(
            &slice.steps,
            &agent.key,
            None,
            is_live.then_some(agent.status),
            input.now_ms,
            input.window,
        );
        let first = stars.len();
        stars.extend(built);
        let title = turn_title(
            agent,
            input.cards,
            is_live,
            slice.titled,
            slice.start_ms,
            input.lang,
        );
        turns.push(Turn {
            stars: (first..stars.len()).collect(),
            live: is_live,
            start_ms: slice.start_ms,
            title,
        });
    }
    turns
}

fn earlier_note(slices: &[TurnSlice<'_>], start: u64) -> Option<EarlierNote> {
    slices
        .iter()
        .rev()
        .find(|s| s.steps.last().map_or(s.start_ms, |e| e.ms) < start)
        .map(|s| EarlierNote {
            start_ms: s.start_ms,
            edits: s
                .steps
                .iter()
                .filter(|e| row_of(e.tool_name.as_deref()) == RowKind::Edit)
                .count(),
        })
}

fn sub_lanes(
    model: &Model,
    parent: &AgentStatus,
    parent_entries: &[TimelineEntry],
    input: &BandInput<'_>,
    stars: &mut Vec<Star>,
) -> Vec<SubLane> {
    if !model.subagent_tree_enabled() {
        return Vec::new();
    }
    let spawns: Vec<f32> = parent_entries
        .iter()
        .filter(|e| e.kind == TimelineKind::SubagentStart)
        .filter_map(|e| x_frac(e.ms, input.now_ms, input.window))
        .collect();
    let mut lanes = Vec::new();
    for child in model
        .agents()
        .values()
        .filter(|a| a.key.session_id == parent.key.session_id && !a.key.agent_id.is_empty())
    {
        let entries = model.timeline(&child.key).unwrap_or(&[]);
        let steps: Vec<&TimelineEntry> = split_turns(entries)
            .into_iter()
            .flat_map(|t| t.steps)
            .collect();
        let lane_idx = lanes.len();
        let built = turn_stars(
            &steps,
            &child.key,
            Some(RowKind::Sub(lane_idx)),
            None,
            input.now_ms,
            input.window,
        );
        if built.is_empty() {
            continue;
        }
        let first = stars.len();
        stars.extend(built);
        lanes.push(SubLane {
            key: child.key.clone(),
            label: child
                .agent_type
                .clone()
                .unwrap_or_else(|| short8(&child.key.agent_id)),
            spawn_x: spawns.get(lane_idx).copied(),
            stars: (first..stars.len()).collect(),
        });
    }
    lanes
}

fn quiet_note(agent: &AgentStatus) -> QuietNote {
    let action = agent
        .action
        .as_ref()
        .and_then(|a| action_target(a, agent.repo.root.as_deref()))
        .or_else(|| agent.summary.clone());
    QuietNote {
        last_ms: agent.last_event_ms,
        action,
    }
}

fn build_band(model: &Model, input: &BandInput<'_>) -> SkyBand {
    let agent = input.agent;
    let entries = model.timeline(&agent.key).unwrap_or(&[]);
    let slices = split_turns(entries);
    let mut stars = Vec::new();
    let turns = primary_turns(input, &slices, &mut stars);
    let subs = sub_lanes(model, agent, entries, input, &mut stars);
    let start = input.now_ms.saturating_sub(input.window.secs() * 1000);
    SkyBand {
        key: agent.key.clone(),
        harness: agent.harness.clone(),
        branch: agent.repo.branch.clone(),
        status: agent.status,
        subs,
        quiet: stars.is_empty().then(|| quiet_note(agent)),
        earlier: earlier_note(&slices, start),
        stars,
        turns,
    }
}

/// Primary agents of the project in band order: working, then needs you, then
/// the rest, newest first.
pub(crate) fn band_agents<'a>(model: &'a Model, project: &ProjectId) -> Vec<&'a AgentStatus> {
    let mut agents: Vec<&AgentStatus> = model
        .agents()
        .values()
        .filter(|a| a.key.agent_id.is_empty() && project_id(&a.repo) == *project)
        .collect();
    agents.sort_by_key(|a| {
        (
            band_rank(a.status),
            std::cmp::Reverse(a.last_event_ms),
            a.key.clone(),
        )
    });
    agents
}

/// Projects the project's agents and timelines into chart geometry.
pub fn sky_chart(
    model: &Model,
    cards: &CardsModel,
    project: &ProjectId,
    window: SkyWindow,
    now_ms: u64,
    lang: UiLang,
) -> SkyChart {
    let bands = band_agents(model, project)
        .into_iter()
        .map(|agent| {
            build_band(
                model,
                &BandInput {
                    agent,
                    cards,
                    now_ms,
                    window,
                    lang,
                },
            )
        })
        .collect();
    SkyChart {
        window,
        ticks: ticks(now_ms, window),
        bands,
    }
}
