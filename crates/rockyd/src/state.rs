//! Per-agent status machine: hook events in, agent statuses out.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use rocky_proto::hook::HookEvent;
use rocky_proto::pipe::{
    Action, AgentKey, AgentStatus, Gap, GapReason, Outcome, RepoInfo, Status, TimelineEntry,
    TimelineKind,
};

pub const DONE_TO_IDLE_MS: u64 = 30 * 60_000;
pub const QUIET_MS: u64 = 10 * 60_000;
pub const ENDED_REMOVE_MS: u64 = 60 * 60_000;
pub const CHILD_REMOVE_MS: u64 = 30 * 60_000;
pub const TIMELINE_CAP: usize = 50;

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Changes {
    pub upserted: Vec<AgentKey>,
    pub removed: Vec<AgentKey>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ApplyOutcome {
    Changed(Changes),
    Late,
}

#[derive(Debug)]
struct Agent {
    status: AgentStatus,
    in_flight: Vec<InFlight>,
    timeline: VecDeque<TimelineRecord>,
    last_recv_ms: u64,
}

/// A timeline entry plus the private facts `timeline()` never exposes.
#[derive(Debug)]
struct TimelineRecord {
    entry: TimelineEntry,
    tool_use_id: Option<String>,
    text_source: TextSource,
}

/// Where an entry's text came from; only tool input text follows the setting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TextSource {
    None,
    Path,
    ToolInput,
    Reason,
}

/// A tool call the agent has not finished yet. `Action` is the wire type; the
/// description and the pairing flag never leave this machine.
#[derive(Debug)]
struct InFlight {
    action: Action,
    description: Option<String>,
    paired: bool,
}

#[derive(Debug)]
pub struct StatusState {
    agents: BTreeMap<AgentKey, Agent>,
    repos: BTreeMap<String, RepoInfo>,
    tool_text: bool,
}

impl Default for StatusState {
    fn default() -> Self {
        Self {
            agents: BTreeMap::new(),
            repos: BTreeMap::new(),
            tool_text: true,
        }
    }
}

impl StatusState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Drops tool text from an event while the setting is off.
    pub fn prepare(&self, mut ev: HookEvent) -> HookEvent {
        if !self.tool_text {
            ev.command = None;
            ev.description = None;
        }
        ev
    }

    /// Turns tool text on or off, clearing remembered text when off.
    /// Returns the agents whose status changed.
    pub fn set_tool_text(&mut self, on: bool) -> Vec<AgentKey> {
        self.tool_text = on;
        if on {
            return Vec::new();
        }
        let mut changed = Vec::new();
        for (key, agent) in self.agents.iter_mut() {
            let mut status_changed = false;
            if let Some(action) = agent.status.action.as_mut()
                && action.command.take().is_some()
            {
                status_changed = true;
            }
            if !key.agent_id.is_empty() && agent.status.description.take().is_some() {
                status_changed = true;
            }
            for in_flight in &mut agent.in_flight {
                in_flight.description = None;
                in_flight.action.command = None;
            }
            for record in &mut agent.timeline {
                if record.text_source == TextSource::ToolInput {
                    record.entry.text = None;
                }
            }
            if status_changed {
                changed.push(key.clone());
            }
        }
        changed
    }

    pub fn tool_text(&self) -> bool {
        self.tool_text
    }

    pub fn session_repo(&self, session_id: &str) -> Option<&RepoInfo> {
        self.repos.get(session_id)
    }

    /// Sets a session's repo from an event's cwd. `SessionStart` with a cwd
    /// always sets it. Any other event sets it only while the session has no
    /// repo or only the placeholder, so a later prompt elsewhere does not move it.
    fn set_session_repo(&mut self, ev: &HookEvent, repo_of: &mut dyn FnMut(&str) -> RepoInfo) {
        let cwd = ev.cwd.as_deref();
        let is_start = ev.hook_event_name == "SessionStart" && cwd.is_some();
        let needs_repo = match self.repos.get(&ev.session_id) {
            None => true,
            Some(repo) => cwd.is_some() && *repo == placeholder(),
        };
        if !is_start && !needs_repo {
            return;
        }
        let repo = match cwd {
            Some(cwd) => repo_of(cwd),
            None => placeholder(),
        };
        self.repos.insert(ev.session_id.clone(), repo);
    }

    pub fn apply(
        &mut self,
        ev: &HookEvent,
        recv_ms: u64,
        repo_of: &mut dyn FnMut(&str) -> RepoInfo,
    ) -> ApplyOutcome {
        let aid = ev.agent_id.clone().unwrap_or_default();
        let key = AgentKey {
            session_id: ev.session_id.clone(),
            agent_id: aid,
        };
        let is_session_end = ev.hook_event_name == "SessionEnd";
        if !is_session_end
            && let Some(agent) = self.agents.get(&key)
            && recv_ms < agent.last_recv_ms
        {
            return ApplyOutcome::Late;
        }
        // Claude Code 2.1.319 fires a bare SubagentStop (agent_type "", no
        // SubagentStart) for internal helper agents after most turns. A row for
        // an agent never seen before would be a phantom "done" child per turn.
        if ev.hook_event_name == "SubagentStop"
            && !key.agent_id.is_empty()
            && !self.agents.contains_key(&key)
        {
            return ApplyOutcome::Changed(Changes::default());
        }
        self.set_session_repo(ev, repo_of);
        let repo = self
            .repos
            .get(&ev.session_id)
            .cloned()
            .unwrap_or_else(placeholder);
        if is_session_end {
            let keys: Vec<AgentKey> = self
                .agents
                .keys()
                .filter(|k| k.session_id == ev.session_id)
                .cloned()
                .collect();
            let mut upserted = Vec::new();
            for k in keys {
                if let Some(agent) = self.agents.get_mut(&k) {
                    if recv_ms < agent.last_recv_ms {
                        continue;
                    }
                    agent.status.status = Status::Ended;
                    agent.status.action = None;
                    agent.in_flight.clear();
                    agent.status.quiet_10m = false;
                    agent.status.last_event_ms = recv_ms;
                    agent.last_recv_ms = recv_ms;
                    agent.push_entry(TimelineRecord::new(recv_ms, TimelineKind::SessionEnd));
                    upserted.push(k);
                }
            }
            return ApplyOutcome::Changed(Changes {
                upserted,
                removed: Vec::new(),
            });
        }
        let child_description = if ev.hook_event_name == "SubagentStart" && !key.agent_id.is_empty()
        {
            self.take_child_description(&ev.session_id)
        } else {
            None
        };
        let agent = self.agents.entry(key.clone()).or_insert_with(|| Agent {
            status: AgentStatus {
                key: key.clone(),
                agent_type: None,
                status: Status::Idle,
                action: None,
                summary: None,
                description: None,
                failures: 0,
                last_event_ms: recv_ms,
                quiet_10m: false,
                repo: repo.clone(),
            },
            in_flight: Vec::new(),
            timeline: VecDeque::new(),
            last_recv_ms: recv_ms,
        });
        agent.status.repo = repo;
        agent.status.last_event_ms = recv_ms;
        agent.status.quiet_10m = false;
        agent.last_recv_ms = recv_ms;
        if let Some(description) = child_description {
            agent.status.description = Some(description);
        }
        match ev.hook_event_name.as_str() {
            "SessionStart" => {
                agent.status.status = Status::Idle;
                agent.push_entry(TimelineRecord::new(recv_ms, TimelineKind::SessionStart));
            }
            "UserPromptSubmit" => {
                agent.status.status = Status::Working;
                agent.status.summary = None;
                agent.push_entry(TimelineRecord::new(recv_ms, TimelineKind::TurnStart));
            }
            "PreToolUse" => {
                agent.status.status = Status::Working;
                agent.status.summary = None;
                if let Some(tool) = ev.tool_name.clone() {
                    agent.in_flight.push(InFlight {
                        action: Action {
                            tool_name: tool.clone(),
                            target_path: ev.target_path.clone(),
                            tool_use_id: ev.tool_use_id.clone(),
                            command: ev.command.clone(),
                        },
                        description: ev.description.clone(),
                        paired: false,
                    });
                    let (text, text_source) =
                        tool_entry_text(ev, agent.status.repo.root.as_deref());
                    let mut record = TimelineRecord::new(recv_ms, TimelineKind::Tool);
                    record.entry.tool_name = Some(tool);
                    record.entry.text = text;
                    record.entry.outcome = Some(Outcome::Pending);
                    record.tool_use_id = ev.tool_use_id.clone();
                    record.text_source = text_source;
                    agent.push_entry(record);
                }
                agent.status.action = current_action(agent);
            }
            "PostToolUse" | "PostToolUseFailure" => {
                if ev.hook_event_name == "PostToolUseFailure" {
                    agent.status.failures += 1;
                }
                remove_in_flight(&mut agent.in_flight, ev.tool_use_id.as_deref());
                agent.status.action = current_action(agent);
                if agent.status.status == Status::NeedsYou {
                    agent.status.status = Status::Working;
                    agent.status.summary = None;
                }
                let outcome = if ev.hook_event_name == "PostToolUse" {
                    Outcome::Ok
                } else {
                    Outcome::Failed
                };
                resolve_pending(agent, ev.tool_use_id.as_deref(), outcome);
            }
            "PermissionRequest" => {
                agent.status.status = Status::NeedsYou;
                agent.status.summary = ev.tool_name.clone().or(ev.notification_type.clone());
                let mut record = TimelineRecord::new(recv_ms, TimelineKind::NeedsYou);
                record.entry.tool_name = ev.tool_name.clone();
                agent.push_entry(record);
            }
            "Notification" => {
                if matches!(
                    ev.notification_type.as_deref(),
                    Some("permission_prompt" | "agent_needs_input" | "elicitation_dialog")
                ) {
                    agent.status.status = Status::NeedsYou;
                    agent.status.summary = ev.tool_name.clone().or(ev.notification_type.clone());
                    let mut record = TimelineRecord::new(recv_ms, TimelineKind::NeedsYou);
                    record.entry.tool_name = ev.tool_name.clone();
                    agent.push_entry(record);
                }
            }
            "SubagentStart" => {
                agent.status.status = Status::Working;
                agent.status.summary = None;
                if ev.agent_type.is_some() {
                    agent.status.agent_type = ev.agent_type.clone();
                }
                let mut record = TimelineRecord::new(recv_ms, TimelineKind::SubagentStart);
                record.entry.text = agent.status.description.clone();
                if record.entry.text.is_some() {
                    record.text_source = TextSource::ToolInput;
                }
                agent.push_entry(record);
            }
            "SubagentStop" => {
                agent.status.status = Status::Done;
                agent.status.summary = None;
                agent.status.action = None;
                agent.in_flight.clear();
                agent.push_entry(TimelineRecord::new(recv_ms, TimelineKind::SubagentStop));
            }
            "Stop" => {
                agent.status.status = Status::Done;
                agent.status.summary = None;
                agent.status.action = None;
                agent.in_flight.clear();
                agent.push_entry(TimelineRecord::new(recv_ms, TimelineKind::TurnDone));
            }
            "StopFailure" => {
                agent.status.status = Status::Failed;
                agent.status.action = None;
                agent.in_flight.clear();
                agent.push_entry(TimelineRecord::new(recv_ms, TimelineKind::TurnFailed));
            }
            _ => {}
        }
        let removed = if ev.hook_event_name == "UserPromptSubmit" && key.agent_id.is_empty() {
            self.remove_finished_children(&ev.session_id)
        } else {
            Vec::new()
        };
        ApplyOutcome::Changed(Changes {
            upserted: vec![key],
            removed,
        })
    }

    pub fn tick(&mut self, now_ms: u64) -> Changes {
        let mut upserted = Vec::new();
        let mut removed = Vec::new();
        for (key, agent) in self.agents.iter_mut() {
            if !key.agent_id.is_empty()
                && matches!(agent.status.status, Status::Done | Status::Failed)
                && now_ms.saturating_sub(agent.status.last_event_ms) >= CHILD_REMOVE_MS
            {
                removed.push(key.clone());
                continue;
            }
            match agent.status.status {
                Status::Done => {
                    if now_ms.saturating_sub(agent.status.last_event_ms) >= DONE_TO_IDLE_MS {
                        agent.status.status = Status::Idle;
                        upserted.push(key.clone());
                    }
                }
                Status::Working => {
                    if !agent.status.quiet_10m
                        && now_ms.saturating_sub(agent.status.last_event_ms) >= QUIET_MS
                    {
                        agent.status.quiet_10m = true;
                        upserted.push(key.clone());
                    }
                }
                Status::Ended => {
                    if now_ms.saturating_sub(agent.status.last_event_ms) >= ENDED_REMOVE_MS {
                        removed.push(key.clone());
                    }
                }
                Status::Idle | Status::NeedsYou | Status::Failed => {}
            }
        }
        for key in &removed {
            self.agents.remove(key);
        }
        Changes { upserted, removed }
    }

    /// Pairs a fresh child with the main agent's one unpaired Agent/Task call
    /// and returns that call's description. Zero or several candidates yield
    /// `None`.
    fn take_child_description(&mut self, session_id: &str) -> Option<String> {
        let main = AgentKey {
            session_id: session_id.to_string(),
            agent_id: String::new(),
        };
        let agent = self.agents.get_mut(&main)?;
        let mut candidates = agent
            .in_flight
            .iter_mut()
            .filter(|f| !f.paired && matches!(f.action.tool_name.as_str(), "Agent" | "Task"));
        let only = candidates.next()?;
        if candidates.next().is_some() {
            return None;
        }
        only.paired = true;
        only.description.clone()
    }

    /// Drops every finished child of the session; a new prompt starts a new
    /// tree.
    fn remove_finished_children(&mut self, session_id: &str) -> Vec<AgentKey> {
        let finished: Vec<AgentKey> = self
            .agents
            .iter()
            .filter(|(k, a)| {
                k.session_id == session_id
                    && !k.agent_id.is_empty()
                    && matches!(a.status.status, Status::Done | Status::Failed)
            })
            .map(|(k, _)| k.clone())
            .collect();
        for key in &finished {
            self.agents.remove(key);
        }
        finished
    }

    /// Distinct repo roots of the sessions seen so far, sorted.
    pub fn session_roots(&self) -> Vec<String> {
        let roots: BTreeSet<&str> = self
            .repos
            .values()
            .filter_map(|repo| repo.root.as_deref())
            .collect();
        roots.into_iter().map(str::to_owned).collect()
    }

    pub fn agents(&self) -> Vec<AgentStatus> {
        self.agents.values().map(|a| a.status.clone()).collect()
    }

    pub fn get(&self, key: &AgentKey) -> Option<AgentStatus> {
        self.agents.get(key).map(|a| a.status.clone())
    }

    /// Oldest-first timeline entries for one agent; empty for an unknown key.
    pub fn timeline(&self, key: &AgentKey) -> Vec<TimelineEntry> {
        self.agents
            .get(key)
            .map(|agent| agent.timeline.iter().map(|r| r.entry.clone()).collect())
            .unwrap_or_default()
    }

    /// Puts a coverage gap on every agent that has not ended.
    pub fn record_gap(&mut self, gap: &Gap) {
        let text = gap_reason_name(gap.reason);
        for agent in self.agents.values_mut() {
            if agent.status.status == Status::Ended {
                continue;
            }
            let mut record = TimelineRecord::new(gap.to_ms, TimelineKind::Gap);
            record.entry.text = Some(text.clone());
            record.text_source = TextSource::Reason;
            agent.push_entry(record);
        }
    }

    pub fn aggregate(&self) -> Status {
        let mut best = Status::Idle;
        for agent in self.agents.values() {
            let rank = |s: Status| match s {
                Status::NeedsYou => 5,
                Status::Failed => 4,
                Status::Working => 3,
                Status::Done => 2,
                Status::Idle => 1,
                Status::Ended => 0,
            };
            if rank(agent.status.status) > rank(best) {
                best = agent.status.status;
            }
        }
        best
    }
}

impl TimelineRecord {
    fn new(ms: u64, kind: TimelineKind) -> Self {
        Self {
            entry: TimelineEntry {
                ms,
                kind,
                tool_name: None,
                text: None,
                outcome: None,
            },
            tool_use_id: None,
            text_source: TextSource::None,
        }
    }
}

impl Agent {
    fn push_entry(&mut self, record: TimelineRecord) {
        self.timeline.push_back(record);
        while self.timeline.len() > TIMELINE_CAP {
            self.timeline.pop_front();
        }
    }
}

fn current_action(agent: &Agent) -> Option<Action> {
    agent.in_flight.last().map(|f| f.action.clone())
}

/// Resolves the newest pending tool entry, by id when the event has one.
fn resolve_pending(agent: &mut Agent, tool_use_id: Option<&str>, outcome: Outcome) {
    let pending = agent.timeline.iter_mut().rev().find(|record| {
        record.entry.kind == TimelineKind::Tool
            && record.entry.outcome == Some(Outcome::Pending)
            && match tool_use_id {
                Some(id) => record.tool_use_id.as_deref() == Some(id),
                None => true,
            }
    });
    if let Some(record) = pending {
        record.entry.outcome = Some(outcome);
    }
}

/// Chooses a tool entry's text and records its provenance for the setting.
fn tool_entry_text(ev: &HookEvent, root: Option<&str>) -> (Option<String>, TextSource) {
    if let Some(target) = ev.target_path.as_deref() {
        let text = root
            .and_then(|root| relative_to(target, root))
            .unwrap_or_else(|| target.to_owned());
        return (Some(text), TextSource::Path);
    }
    match ev.command.as_deref() {
        Some(command) => (Some(command.to_owned()), TextSource::ToolInput),
        None => (None, TextSource::None),
    }
}

/// Strips a case-insensitive `root` prefix from `target`, normalizing
/// separators and leaving no leading separator.
fn relative_to(target: &str, root: &str) -> Option<String> {
    let target = target.replace('\\', "/");
    let mut root = root.replace('\\', "/");
    while root.ends_with('/') {
        root.pop();
    }
    let bytes = target.as_bytes();
    if root.is_empty()
        || bytes.len() <= root.len()
        || !bytes[..root.len()].eq_ignore_ascii_case(root.as_bytes())
    {
        return None;
    }
    let rest = target[root.len()..].trim_start_matches('/');
    if rest.is_empty() {
        None
    } else {
        Some(rest.to_owned())
    }
}

/// The repo a session has before any cwd is known.
fn placeholder() -> RepoInfo {
    RepoInfo {
        root: None,
        main_root: None,
        name: String::new(),
        branch: None,
    }
}

/// The wire name of a gap reason, for the entry text.
fn gap_reason_name(reason: GapReason) -> String {
    serde_json::to_value(reason)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_default()
}

fn remove_in_flight(in_flight: &mut Vec<InFlight>, tool_use_id: Option<&str>) {
    match tool_use_id {
        Some(id) => {
            if let Some(pos) = in_flight
                .iter()
                .rposition(|f| f.action.tool_use_id.as_deref() == Some(id))
            {
                in_flight.remove(pos);
            }
        }
        None => {
            in_flight.pop();
        }
    }
}

#[cfg(test)]
mod tests;
