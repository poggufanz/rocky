//! Constellation geometry: one turn's steps, evenly spaced in order.

use super::sky::{
    LIVE_RADIUS, RowKind, StarKind, band_agents, is_live_status, magnitude, row_of, split_turns,
    turn_kinds, turn_title,
};
use super::{ProjectId, StepRef, project_id};
use crate::cards_model::CardsModel;
use crate::i18n::UiLang;
use crate::now_model::short_path;
use crate::view::{Model, short8};
use rocky_proto::pipe::{AgentKey, AgentStatus, Status, TimelineEntry, TimelineKind};

/// Horizontal distance between neighbouring stars.
pub const STEP_SPACING: f32 = 56.0;

#[derive(Debug, Clone, PartialEq)]
pub struct CStar {
    /// 1-based position in the turn.
    pub n: usize,
    pub step: StepRef,
    pub row: RowKind,
    pub radius: f32,
    pub kind: StarKind,
    pub label: String,
    /// Odd steps put their label above the line, even steps below.
    pub above: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CSub {
    pub key: AgentKey,
    pub label: String,
    /// Number of parent steps before the spawn.
    pub after_n: usize,
    pub stars: Vec<CStar>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ConstellationView {
    pub key: AgentKey,
    pub harness: Option<String>,
    pub branch: Option<String>,
    pub session_id: String,
    pub status: Status,
    pub last_event_ms: u64,
    pub title: Option<String>,
    pub start_ms: u64,
    pub stars: Vec<CStar>,
    pub subs: Vec<CSub>,
    pub failed: usize,
    pub prev_turn: Option<u64>,
    pub next_turn: Option<u64>,
}

/// Text shown next to a step: the command for a command step, else the
/// target shortened against the repo root and home.
pub(crate) fn step_label(entry: &TimelineEntry, root: Option<&str>, home: Option<&str>) -> String {
    let name = entry.tool_name.as_deref().unwrap_or("");
    let text = entry.text.as_deref().unwrap_or("");
    if text.is_empty() {
        return name.to_string();
    }
    if row_of(entry.tool_name.as_deref()) == RowKind::Cmd {
        text.to_string()
    } else {
        short_path(text, root, home)
    }
}

/// The turn to show when nothing valid is picked: the live turn of the first
/// working or waiting band, else the newest turn of the newest band.
pub(crate) fn default_turn(model: &Model, project: &ProjectId) -> Option<(AgentKey, u64)> {
    let newest_turn = |agent: &AgentStatus| {
        let entries = model.timeline(&agent.key)?;
        let start = split_turns(entries).last()?.start_ms;
        Some((agent.key.clone(), start))
    };
    let agents = band_agents(model, project);
    agents
        .iter()
        .filter(|a| is_live_status(a.status))
        .find_map(|a| newest_turn(a))
        .or_else(|| agents.iter().find_map(|a| newest_turn(a)))
}

fn turn_exists(model: &Model, project: &ProjectId, pick: &(AgentKey, u64)) -> bool {
    let in_project = model
        .agents()
        .get(&pick.0)
        .is_some_and(|a| project_id(&a.repo) == *project);
    in_project
        && model
            .timeline(&pick.0)
            .is_some_and(|e| split_turns(e).iter().any(|s| s.start_ms == pick.1))
}

fn build_star(
    n: usize,
    entry: &TimelineEntry,
    key: &AgentKey,
    kind: StarKind,
    row: RowKind,
    labels: (Option<&str>, Option<&str>),
) -> CStar {
    let live = matches!(kind, StarKind::Running | StarKind::Waiting);
    CStar {
        n,
        step: StepRef {
            key: key.clone(),
            ms: entry.ms,
        },
        row,
        radius: if live {
            LIVE_RADIUS
        } else {
            magnitude(entry.dur_ms)
        },
        kind,
        label: step_label(entry, labels.0, labels.1),
        above: n % 2 == 1,
    }
}

fn is_step(entry: &TimelineEntry) -> bool {
    matches!(entry.kind, TimelineKind::Tool | TimelineKind::NeedsYou)
}

fn in_turn(ms: u64, start: u64, end: Option<u64>) -> bool {
    ms >= start && end.is_none_or(|e| ms < e)
}

fn sub_lanes(
    model: &Model,
    parent: &AgentStatus,
    turn: (u64, Option<u64>),
    parent_steps: &[&TimelineEntry],
    home: Option<&str>,
) -> Vec<CSub> {
    if !model.subagent_tree_enabled() {
        return Vec::new();
    }
    let (start, end) = turn;
    let root = parent.repo.root.as_deref();
    let mut steps_before = 0usize;
    let mut spawn_after: Vec<usize> = Vec::new();
    for e in model.timeline(&parent.key).unwrap_or(&[]) {
        if !in_turn(e.ms, start, end) {
            continue;
        }
        if is_step(e) {
            steps_before += 1;
        } else if e.kind == TimelineKind::SubagentStart {
            spawn_after.push(steps_before);
        }
    }
    let mut lanes: Vec<CSub> = Vec::new();
    let children = model.agents().values().filter(|a| {
        a.key.session_id == parent.key.session_id
            && !a.key.agent_id.is_empty()
            && model
                .timeline(&a.key)
                .is_some_and(|t| t.iter().any(|e| is_step(e) && e.ms >= start))
    });
    for (i, child) in children.enumerate() {
        let entries = model.timeline(&child.key).unwrap_or(&[]);
        let steps: Vec<&TimelineEntry> = entries
            .iter()
            .filter(|e| is_step(e) && in_turn(e.ms, start, end))
            .collect();
        let Some(first) = steps.first() else { continue };
        let after_n = spawn_after
            .get(i)
            .copied()
            .unwrap_or_else(|| parent_steps.iter().filter(|e| e.ms < first.ms).count());
        let kinds = turn_kinds(&steps, None);
        let row = RowKind::Sub(lanes.len());
        lanes.push(CSub {
            key: child.key.clone(),
            label: child
                .agent_type
                .clone()
                .unwrap_or_else(|| short8(&child.key.agent_id)),
            after_n,
            stars: steps
                .iter()
                .zip(&kinds)
                .enumerate()
                .map(|(j, (e, k))| build_star(j + 1, e, &child.key, *k, row, (root, home)))
                .collect(),
        });
    }
    lanes
}

/// One turn drawn as a constellation: the picked turn when it still exists,
/// else the default turn. `None` when no agent of the project has a turn.
pub fn constellation(
    model: &Model,
    cards: &CardsModel,
    project: &ProjectId,
    pick: Option<&(AgentKey, u64)>,
    _now_ms: u64,
    home: Option<&str>,
    lang: UiLang,
) -> Option<ConstellationView> {
    let target = pick
        .filter(|p| turn_exists(model, project, p))
        .cloned()
        .or_else(|| default_turn(model, project))?;
    let agent = model.agents().get(&target.0)?;
    let slices = split_turns(model.timeline(&agent.key)?);
    let idx = slices.iter().position(|s| s.start_ms == target.1)?;
    let slice = &slices[idx];
    let next_start = slices.get(idx + 1).map(|s| s.start_ms);
    let is_live = is_live_status(agent.status) && idx + 1 == slices.len();
    let kinds = turn_kinds(&slice.steps, is_live.then_some(agent.status));
    let root = agent.repo.root.as_deref();
    let stars: Vec<CStar> = slice
        .steps
        .iter()
        .zip(&kinds)
        .enumerate()
        .map(|(i, (e, k))| {
            build_star(
                i + 1,
                e,
                &agent.key,
                *k,
                row_of(e.tool_name.as_deref()),
                (root, home),
            )
        })
        .collect();
    Some(ConstellationView {
        key: agent.key.clone(),
        harness: agent.harness.clone(),
        branch: agent.repo.branch.clone(),
        session_id: agent.key.session_id.clone(),
        status: agent.status,
        last_event_ms: agent.last_event_ms,
        title: turn_title(agent, cards, is_live, slice.titled, slice.start_ms, lang),
        start_ms: slice.start_ms,
        failed: stars.iter().filter(|s| s.kind == StarKind::Failed).count(),
        subs: sub_lanes(
            model,
            agent,
            (slice.start_ms, next_start),
            &slice.steps,
            home,
        ),
        stars,
        prev_turn: idx.checked_sub(1).map(|i| slices[i].start_ms),
        next_turn: next_start,
    })
}
