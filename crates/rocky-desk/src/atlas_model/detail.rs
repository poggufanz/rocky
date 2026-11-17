//! Detail of one selected step, plus default selection and stepping.

use super::constellation::{default_turn, step_label};
use super::sky::{StarKind, TurnSlice, is_live_status, split_turns, turn_kinds};
use super::{ProjectId, StepRef};
use crate::view::Model;
use rocky_proto::pipe::{AgentKey, AgentStatus, Status};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StepOutcome {
    Failed { dur_ms: Option<u64> },
    Running { since_ms: u64 },
    Waiting { since_ms: u64 },
    Done { dur_ms: Option<u64> },
}

#[derive(Debug, Clone, PartialEq)]
pub struct StepDetail {
    pub step: StepRef,
    pub n: usize,
    pub of: usize,
    pub text: String,
    pub outcome: StepOutcome,
    pub harness: Option<String>,
    pub branch: Option<String>,
    pub session_id: String,
    pub turn_start_ms: u64,
    pub status: Status,
    pub last_event_ms: u64,
}

/// The turn of `agent` that contains the step at `ms`, with the step's index
/// in it and whether it is the agent's live turn.
fn locate<'a>(
    model: &'a Model,
    agent: &AgentStatus,
    ms: u64,
) -> Option<(TurnSlice<'a>, usize, bool)> {
    let slices = split_turns(model.timeline(&agent.key)?);
    let total = slices.len();
    slices.into_iter().enumerate().find_map(|(i, s)| {
        let idx = s.steps.iter().position(|e| e.ms == ms)?;
        let live = is_live_status(agent.status) && i + 1 == total;
        Some((s, idx, live))
    })
}

fn live_status(agent: &AgentStatus, live: bool) -> Option<Status> {
    live.then_some(agent.status)
}

/// The step to select when a turn is shown: the running or waiting step, else
/// the newest failed step, else the last step of the turn that began at
/// `start_ms`.
pub fn turn_step(model: &Model, key: &AgentKey, start_ms: u64) -> Option<StepRef> {
    let agent = model.agents().get(key)?;
    let slices = split_turns(model.timeline(key)?);
    let idx = slices.iter().position(|s| s.start_ms == start_ms)?;
    let slice = &slices[idx];
    let live = is_live_status(agent.status) && idx + 1 == slices.len();
    let kinds = turn_kinds(&slice.steps, live_status(agent, live));
    let pick = kinds
        .iter()
        .rposition(|k| matches!(k, StarKind::Running | StarKind::Waiting))
        .or_else(|| kinds.iter().rposition(|k| *k == StarKind::Failed))
        .or_else(|| slice.steps.len().checked_sub(1))?;
    Some(StepRef {
        key: key.clone(),
        ms: slice.steps[pick].ms,
    })
}

/// The step to select first: [`turn_step`] of the default turn.
pub fn default_step(model: &Model, project: &ProjectId) -> Option<StepRef> {
    let (key, start) = default_turn(model, project)?;
    turn_step(model, &key, start)
}

/// Detail of `step`; `None` when it is no longer in its agent's timeline.
pub fn step_detail(model: &Model, step: &StepRef, home: Option<&str>) -> Option<StepDetail> {
    let agent = model.agents().get(&step.key)?;
    let (slice, idx, live) = locate(model, agent, step.ms)?;
    let entry = slice.steps[idx];
    let kinds = turn_kinds(&slice.steps, live_status(agent, live));
    let outcome = match kinds[idx] {
        StarKind::Failed => StepOutcome::Failed {
            dur_ms: entry.dur_ms,
        },
        StarKind::Running => StepOutcome::Running { since_ms: entry.ms },
        StarKind::Waiting => StepOutcome::Waiting { since_ms: entry.ms },
        StarKind::Plain => StepOutcome::Done {
            dur_ms: entry.dur_ms,
        },
    };
    Some(StepDetail {
        step: step.clone(),
        n: idx + 1,
        of: slice.steps.len(),
        text: step_label(entry, agent.repo.root.as_deref(), home),
        outcome,
        harness: agent.harness.clone(),
        branch: agent.repo.branch.clone(),
        session_id: agent.key.session_id.clone(),
        turn_start_ms: slice.start_ms,
        status: agent.status,
        last_event_ms: agent.last_event_ms,
    })
}

/// The previous or next step inside the same turn; `None` at either end or
/// when `step` no longer exists.
pub fn neighbor(model: &Model, step: &StepRef, forward: bool) -> Option<StepRef> {
    let agent = model.agents().get(&step.key)?;
    let (slice, idx, _) = locate(model, agent, step.ms)?;
    let next = if forward {
        idx.checked_add(1)?
    } else {
        idx.checked_sub(1)?
    };
    slice.steps.get(next).map(|e| StepRef {
        key: step.key.clone(),
        ms: e.ms,
    })
}
