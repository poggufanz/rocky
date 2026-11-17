use super::{ProjectId, project_id};
use rocky_proto::pipe::{AgentKey, AgentStatus, Status};
use std::cmp::Reverse;
use std::collections::BTreeMap;

const MAX_BARS: usize = 3;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionChip {
    pub key: AgentKey,
    pub harness: Option<String>,
    pub status: Status,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectState {
    NeedsYou,
    Working,
    Quiet { idle_secs: u64 },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectRow {
    pub id: ProjectId,
    /// `None` outside a repo; the UI renders its own label.
    pub name: Option<String>,
    pub state: ProjectState,
    pub sessions: Vec<SessionChip>,
    pub failures: u32,
    pub last_event_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NeedsYouBar {
    pub project: ProjectId,
    pub name: Option<String>,
    pub harness: Option<String>,
    pub waiting_secs: u64,
    pub action: Option<String>,
}

fn is_primary(a: &AgentStatus) -> bool {
    a.key.agent_id.is_empty()
}

fn status_rank(s: Status) -> u8 {
    match s {
        Status::NeedsYou => 0,
        Status::Working => 1,
        _ => 2,
    }
}

fn is_active(state: ProjectState) -> bool {
    !matches!(state, ProjectState::Quiet { .. })
}

fn name_of(id: &ProjectId, agent: &AgentStatus) -> Option<String> {
    if id.0.is_empty() {
        None
    } else {
        Some(agent.repo.name.clone())
    }
}

fn build_row(id: ProjectId, mut members: Vec<&AgentStatus>, now_ms: u64) -> ProjectRow {
    members.sort_by_key(|a| (status_rank(a.status), Reverse(a.last_event_ms)));
    let last_event_ms = members.iter().map(|a| a.last_event_ms).max().unwrap_or(0);
    let state = if members.iter().any(|a| a.status == Status::NeedsYou) {
        ProjectState::NeedsYou
    } else if members.iter().any(|a| a.status == Status::Working) {
        ProjectState::Working
    } else {
        ProjectState::Quiet {
            idle_secs: crate::view::age_secs(now_ms, last_event_ms),
        }
    };
    let failures = members
        .iter()
        .filter(|a| !matches!(a.status, Status::Idle | Status::Ended))
        .map(|a| a.failures)
        .sum();
    ProjectRow {
        name: name_of(&id, members[0]),
        sessions: members
            .iter()
            .map(|a| SessionChip {
                key: a.key.clone(),
                harness: a.harness.clone(),
                status: a.status,
            })
            .collect(),
        id,
        state,
        failures,
        last_event_ms,
    }
}

pub fn projects(agents: &BTreeMap<AgentKey, AgentStatus>, now_ms: u64) -> Vec<ProjectRow> {
    let mut groups: BTreeMap<ProjectId, Vec<&AgentStatus>> = BTreeMap::new();
    for a in agents.values().filter(|a| is_primary(a)) {
        groups.entry(project_id(&a.repo)).or_default().push(a);
    }
    let mut rows: Vec<ProjectRow> = groups
        .into_iter()
        .map(|(id, members)| build_row(id, members, now_ms))
        .collect();
    rows.sort_by(|a, b| {
        let (aa, ba) = (is_active(a.state), is_active(b.state));
        ba.cmp(&aa).then_with(|| {
            if aa {
                a.name.cmp(&b.name).then_with(|| a.id.cmp(&b.id))
            } else {
                b.last_event_ms.cmp(&a.last_event_ms)
            }
        })
    });
    rows
}

pub fn default_project(rows: &[ProjectRow]) -> Option<ProjectId> {
    let pick = |state: ProjectState| rows.iter().find(|r| r.state == state);
    pick(ProjectState::Working)
        .or_else(|| pick(ProjectState::NeedsYou))
        .or_else(|| rows.first())
        .map(|r| r.id.clone())
}

pub fn needs_you_bars(
    agents: &BTreeMap<AgentKey, AgentStatus>,
    selected: Option<&ProjectId>,
    now_ms: u64,
) -> (Vec<NeedsYouBar>, usize) {
    let mut bars: Vec<NeedsYouBar> = projects(agents, now_ms)
        .into_iter()
        .filter(|r| r.state == ProjectState::NeedsYou && selected != Some(&r.id))
        .filter_map(|row| {
            let waiting = agents
                .values()
                .filter(|a| {
                    is_primary(a) && a.status == Status::NeedsYou && project_id(&a.repo) == row.id
                })
                .min_by_key(|a| a.last_event_ms)?;
            let action = match waiting.action.as_ref() {
                Some(act) => crate::view::action_target(act, waiting.repo.root.as_deref()),
                None => waiting.summary.clone(),
            };
            Some(NeedsYouBar {
                project: row.id,
                name: row.name,
                harness: waiting.harness.clone(),
                waiting_secs: crate::view::age_secs(now_ms, waiting.last_event_ms),
                action,
            })
        })
        .collect();
    let rest = bars.len().saturating_sub(MAX_BARS);
    bars.truncate(MAX_BARS);
    (bars, rest)
}
