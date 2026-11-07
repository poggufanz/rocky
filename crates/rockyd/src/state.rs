//! Per-agent status machine: hook events in, agent statuses out.

use std::collections::BTreeMap;

use rocky_proto::hook::HookEvent;
use rocky_proto::pipe::{Action, AgentKey, AgentStatus, RepoInfo, Status};

pub const DONE_TO_IDLE_MS: u64 = 30 * 60_000;
pub const QUIET_MS: u64 = 10 * 60_000;
pub const ENDED_REMOVE_MS: u64 = 60 * 60_000;
pub const CHILD_REMOVE_MS: u64 = 30 * 60_000;

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
    last_recv_ms: u64,
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
            if status_changed {
                changed.push(key.clone());
            }
        }
        changed
    }

    pub fn tool_text(&self) -> bool {
        self.tool_text
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
        if matches!(
            ev.hook_event_name.as_str(),
            "SessionStart" | "UserPromptSubmit"
        ) {
            if let Some(cwd) = ev.cwd.as_deref() {
                self.repos.insert(ev.session_id.clone(), repo_of(cwd));
            }
        } else if !self.repos.contains_key(&ev.session_id) {
            let repo = match ev.cwd.as_deref() {
                Some(cwd) => repo_of(cwd),
                None => RepoInfo {
                    root: None,
                    name: String::new(),
                    branch: None,
                },
            };
            self.repos.insert(ev.session_id.clone(), repo);
        }
        let repo = self.repos.get(&ev.session_id).cloned().unwrap_or(RepoInfo {
            root: None,
            name: String::new(),
            branch: None,
        });
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
            }
            "UserPromptSubmit" => {
                agent.status.status = Status::Working;
                agent.status.summary = None;
            }
            "PreToolUse" => {
                agent.status.status = Status::Working;
                agent.status.summary = None;
                if let Some(tool) = ev.tool_name.clone() {
                    agent.in_flight.push(InFlight {
                        action: Action {
                            tool_name: tool,
                            target_path: ev.target_path.clone(),
                            tool_use_id: ev.tool_use_id.clone(),
                            command: ev.command.clone(),
                        },
                        description: ev.description.clone(),
                        paired: false,
                    });
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
            }
            "PermissionRequest" => {
                agent.status.status = Status::NeedsYou;
                agent.status.summary = ev.tool_name.clone().or(ev.notification_type.clone());
            }
            "Notification" => {
                if matches!(
                    ev.notification_type.as_deref(),
                    Some("permission_prompt" | "agent_needs_input" | "elicitation_dialog")
                ) {
                    agent.status.status = Status::NeedsYou;
                    agent.status.summary = ev.tool_name.clone().or(ev.notification_type.clone());
                }
            }
            "SubagentStart" => {
                agent.status.status = Status::Working;
                agent.status.summary = None;
                if ev.agent_type.is_some() {
                    agent.status.agent_type = ev.agent_type.clone();
                }
            }
            "SubagentStop" => {
                agent.status.status = Status::Done;
                agent.status.summary = None;
                agent.status.action = None;
                agent.in_flight.clear();
            }
            "Stop" => {
                agent.status.status = Status::Done;
                agent.status.summary = None;
                agent.status.action = None;
                agent.in_flight.clear();
            }
            "StopFailure" => {
                agent.status.status = Status::Failed;
                agent.status.action = None;
                agent.in_flight.clear();
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

    pub fn agents(&self) -> Vec<AgentStatus> {
        self.agents.values().map(|a| a.status.clone()).collect()
    }

    pub fn get(&self, key: &AgentKey) -> Option<AgentStatus> {
        self.agents.get(key).map(|a| a.status.clone())
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

fn current_action(agent: &Agent) -> Option<Action> {
    agent.in_flight.last().map(|f| f.action.clone())
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
mod tests {
    use super::*;
    use rocky_proto::pipe::Status::*;

    fn ev(name: &str, sid: &str, aid: Option<&str>) -> HookEvent {
        HookEvent {
            hook_event_name: name.into(),
            session_id: sid.into(),
            cwd: Some("C:/r".into()),
            agent_id: aid.map(str::to_string),
            agent_type: None,
            tool_name: None,
            tool_use_id: None,
            transcript_path: None,
            agent_transcript_path: None,
            notification_type: None,
            target_path: None,
            command: None,
            description: None,
            truncated: false,
        }
    }

    fn repo(_: &str) -> RepoInfo {
        RepoInfo {
            root: Some("C:/r".into()),
            name: "r".into(),
            branch: Some("main".into()),
        }
    }

    fn key(s: &str, a: &str) -> AgentKey {
        AgentKey {
            session_id: s.into(),
            agent_id: a.into(),
        }
    }

    fn main_key(s: &str) -> AgentKey {
        key(s, "")
    }

    fn tool_ev(
        name: &str,
        sid: &str,
        aid: Option<&str>,
        tool: &str,
        id: &str,
        target: Option<&str>,
    ) -> HookEvent {
        let mut e = ev(name, sid, aid);
        e.tool_name = Some(tool.into());
        e.tool_use_id = Some(id.into());
        e.target_path = target.map(str::to_string);
        e
    }

    #[test]
    fn session_start_is_idle() {
        let mut st = StatusState::new();
        let out = st.apply(&ev("SessionStart", "S1", None), 1, &mut repo);
        assert!(matches!(out, ApplyOutcome::Changed(_)));
        assert_eq!(st.get(&main_key("S1")).unwrap().status, Idle);
    }

    #[test]
    fn prompt_then_pre_tool_is_working_with_action() {
        let mut st = StatusState::new();
        st.apply(&ev("SessionStart", "S1", None), 1, &mut repo);
        st.apply(&ev("UserPromptSubmit", "S1", None), 2, &mut repo);
        assert_eq!(st.get(&main_key("S1")).unwrap().status, Working);
        st.apply(
            &tool_ev("PreToolUse", "S1", None, "Edit", "t1", Some("C:/r/a.ts")),
            3,
            &mut repo,
        );
        let a = st.get(&main_key("S1")).unwrap();
        assert_eq!(a.status, Working);
        let action = a.action.unwrap();
        assert_eq!(action.tool_name, "Edit");
        assert_eq!(action.target_path.as_deref(), Some("C:/r/a.ts"));
    }

    #[test]
    fn post_tool_failure_counts() {
        let mut st = StatusState::new();
        st.apply(
            &tool_ev("PreToolUse", "S1", None, "Edit", "t1", Some("C:/r/a.ts")),
            1,
            &mut repo,
        );
        st.apply(
            &tool_ev("PostToolUseFailure", "S1", None, "Edit", "t1", None),
            2,
            &mut repo,
        );
        let a = st.get(&main_key("S1")).unwrap();
        assert_eq!(a.failures, 1);
        assert_eq!(a.action, None);
    }

    #[test]
    fn permission_request_needs_you_then_cleared_by_pre_tool() {
        let mut st = StatusState::new();
        let mut perm = ev("PermissionRequest", "S1", None);
        perm.tool_name = Some("Bash".into());
        st.apply(&perm, 1, &mut repo);
        let a = st.get(&main_key("S1")).unwrap();
        assert_eq!(a.status, NeedsYou);
        assert_eq!(a.summary.as_deref(), Some("Bash"));
        st.apply(
            &tool_ev("PreToolUse", "S1", None, "Bash", "t1", None),
            2,
            &mut repo,
        );
        assert_eq!(st.get(&main_key("S1")).unwrap().status, Working);
    }

    #[test]
    fn notification_types_map_to_needs_you() {
        let mut st = StatusState::new();
        for (i, ty) in [
            "permission_prompt",
            "agent_needs_input",
            "elicitation_dialog",
        ]
        .iter()
        .enumerate()
        {
            let sid = format!("S{i}");
            let mut n = ev("Notification", &sid, None);
            n.notification_type = Some((*ty).into());
            st.apply(&n, 1, &mut repo);
            let a = st.get(&main_key(&sid)).unwrap();
            assert_eq!(a.status, NeedsYou, "{ty}");
            assert_eq!(a.summary.as_deref(), Some(*ty), "{ty}");
        }
        st.apply(&ev("SessionStart", "Sx", None), 1, &mut repo);
        let mut idle = ev("Notification", "Sx", None);
        idle.notification_type = Some("idle_prompt".into());
        st.apply(&idle, 2, &mut repo);
        assert_eq!(st.get(&main_key("Sx")).unwrap().status, Idle);
    }

    #[test]
    fn subagent_lifecycle_and_tool_routing() {
        let mut st = StatusState::new();
        st.apply(&ev("SessionStart", "S1", None), 1, &mut repo);
        let mut start = ev("SubagentStart", "S1", Some("A1"));
        start.agent_type = Some("Explore".into());
        st.apply(&start, 2, &mut repo);
        let child = st.get(&key("S1", "A1")).unwrap();
        assert_eq!(child.status, Working);
        assert_eq!(child.agent_type.as_deref(), Some("Explore"));
        st.apply(
            &tool_ev("PreToolUse", "S1", Some("A1"), "Read", "t1", Some("f")),
            3,
            &mut repo,
        );
        assert_eq!(st.get(&main_key("S1")).unwrap().action, None);
        assert_eq!(
            st.get(&key("S1", "A1")).unwrap().action.unwrap().tool_name,
            "Read"
        );
        st.apply(&ev("SubagentStop", "S1", Some("A1")), 4, &mut repo);
        let child = st.get(&key("S1", "A1")).unwrap();
        assert_eq!(child.status, Done);
        assert_eq!(child.action, None);
    }

    #[test]
    fn stop_done_and_stop_failure_failed() {
        let mut st = StatusState::new();
        st.apply(&ev("UserPromptSubmit", "S1", None), 1, &mut repo);
        st.apply(&ev("Stop", "S1", None), 2, &mut repo);
        assert_eq!(st.get(&main_key("S1")).unwrap().status, Done);
        st.apply(&ev("UserPromptSubmit", "S2", None), 3, &mut repo);
        st.apply(&ev("StopFailure", "S2", None), 4, &mut repo);
        assert_eq!(st.get(&main_key("S2")).unwrap().status, Failed);
    }

    #[test]
    fn session_end_marks_all_ended_then_removed_after_hour() {
        let mut st = StatusState::new();
        st.apply(&ev("SessionStart", "S1", None), 1, &mut repo);
        st.apply(&ev("SubagentStart", "S1", Some("A1")), 2, &mut repo);
        st.apply(&ev("SessionEnd", "S1", None), 100, &mut repo);
        assert_eq!(st.get(&main_key("S1")).unwrap().status, Ended);
        assert_eq!(st.get(&key("S1", "A1")).unwrap().status, Ended);
        let ch = st.tick(100 + ENDED_REMOVE_MS);
        assert!(ch.removed.contains(&main_key("S1")));
        assert!(ch.removed.contains(&key("S1", "A1")));
        assert_eq!(st.get(&main_key("S1")), None);
        assert_eq!(st.get(&key("S1", "A1")), None);
    }

    #[test]
    fn done_goes_idle_after_30m_and_working_flags_quiet_after_10m() {
        let mut st = StatusState::new();
        st.apply(&ev("UserPromptSubmit", "S1", None), 100, &mut repo);
        st.apply(&ev("Stop", "S1", None), 200, &mut repo);
        st.apply(&ev("UserPromptSubmit", "S2", None), 300, &mut repo);
        let ch = st.tick(200 + DONE_TO_IDLE_MS);
        assert_eq!(st.get(&main_key("S1")).unwrap().status, Idle);
        assert!(ch.upserted.contains(&main_key("S1")));
        let w = st.get(&main_key("S2")).unwrap();
        assert_eq!(w.status, Working);
        assert!(w.quiet_10m);
        assert!(ch.upserted.contains(&main_key("S2")));
    }

    #[test]
    fn parallel_tools_keep_latest_in_flight() {
        let mut st = StatusState::new();
        st.apply(
            &tool_ev("PreToolUse", "S1", None, "Read", "t1", Some("a")),
            1,
            &mut repo,
        );
        st.apply(
            &tool_ev("PreToolUse", "S1", None, "Edit", "t2", Some("b")),
            2,
            &mut repo,
        );
        st.apply(
            &tool_ev("PostToolUse", "S1", None, "Read", "t1", None),
            3,
            &mut repo,
        );
        let action = st.get(&main_key("S1")).unwrap().action.unwrap();
        assert_eq!(action.tool_name, "Edit");
        assert_eq!(action.tool_use_id.as_deref(), Some("t2"));
        st.apply(
            &tool_ev("PostToolUse", "S1", None, "Edit", "t2", None),
            4,
            &mut repo,
        );
        assert_eq!(st.get(&main_key("S1")).unwrap().action, None);
    }

    #[test]
    fn late_event_is_dropped() {
        let mut st = StatusState::new();
        st.apply(&ev("SessionStart", "S1", None), 100, &mut repo);
        let out = st.apply(&ev("UserPromptSubmit", "S1", None), 99, &mut repo);
        assert_eq!(out, ApplyOutcome::Late);
        assert_eq!(st.get(&main_key("S1")).unwrap().status, Idle);
        let out = st.apply(&ev("UserPromptSubmit", "S1", None), 100, &mut repo);
        assert!(matches!(out, ApplyOutcome::Changed(_)));
        assert_eq!(st.get(&main_key("S1")).unwrap().status, Working);
    }

    #[test]
    fn unknown_session_creates_agent_lazily() {
        let mut st = StatusState::new();
        st.apply(
            &tool_ev("PreToolUse", "S1", None, "Read", "t1", None),
            1,
            &mut repo,
        );
        let a = st.get(&main_key("S1")).unwrap();
        assert_eq!(a.status, Working);
        assert_eq!(a.repo, repo("C:/r"));
    }

    #[test]
    fn aggregate_priority() {
        let mut st = StatusState::new();
        let mut perm = ev("PermissionRequest", "S1", None);
        perm.tool_name = Some("Bash".into());
        st.apply(&perm, 1, &mut repo);
        st.apply(&ev("UserPromptSubmit", "S2", None), 2, &mut repo);
        st.apply(&ev("StopFailure", "S2", None), 3, &mut repo);
        st.apply(&ev("UserPromptSubmit", "S3", None), 4, &mut repo);
        st.apply(&ev("UserPromptSubmit", "S4", None), 5, &mut repo);
        st.apply(&ev("Stop", "S4", None), 6, &mut repo);
        st.apply(&ev("SessionStart", "S5", None), 7, &mut repo);
        st.apply(&ev("SessionStart", "S6", None), 8, &mut repo);
        st.apply(&ev("SessionEnd", "S6", None), 9, &mut repo);
        assert_eq!(st.aggregate(), NeedsYou);
        st.apply(&ev("SessionEnd", "S1", None), 10, &mut repo);
        assert_eq!(st.aggregate(), Failed);
        st.apply(&ev("SessionEnd", "S2", None), 11, &mut repo);
        assert_eq!(st.aggregate(), Working);
        st.apply(&ev("SessionEnd", "S3", None), 12, &mut repo);
        assert_eq!(st.aggregate(), Done);
        st.apply(&ev("SessionEnd", "S4", None), 13, &mut repo);
        assert_eq!(st.aggregate(), Idle);
        st.apply(&ev("SessionEnd", "S5", None), 14, &mut repo);
        assert_eq!(st.aggregate(), Idle);
    }

    fn with_description(mut e: HookEvent, description: &str) -> HookEvent {
        e.description = Some(description.into());
        e
    }

    #[test]
    fn single_in_flight_agent_tool_names_the_child() {
        let mut st = StatusState::new();
        st.apply(&ev("UserPromptSubmit", "S1", None), 1, &mut repo);
        let pre = tool_ev("PreToolUse", "S1", None, "Agent", "t1", None);
        st.apply(&with_description(pre, "scan repo"), 2, &mut repo);
        let mut start = ev("SubagentStart", "S1", Some("A1"));
        start.agent_type = Some("general-purpose".into());
        st.apply(&start, 3, &mut repo);
        assert_eq!(
            st.get(&key("S1", "A1")).unwrap().description.as_deref(),
            Some("scan repo")
        );
        // The second child finds the only Agent call already paired.
        st.apply(&ev("SubagentStart", "S1", Some("A2")), 4, &mut repo);
        assert_eq!(st.get(&key("S1", "A2")).unwrap().description, None);
    }

    #[test]
    fn zero_or_two_candidates_leave_description_empty() {
        let mut st = StatusState::new();
        st.apply(&ev("SubagentStart", "S1", Some("A1")), 1, &mut repo);
        assert_eq!(st.get(&key("S1", "A1")).unwrap().description, None);

        let mut st = StatusState::new();
        st.apply(&ev("UserPromptSubmit", "S1", None), 1, &mut repo);
        for (i, tool) in ["Agent", "Task"].into_iter().enumerate() {
            let id = format!("t{i}");
            let pre = tool_ev("PreToolUse", "S1", None, tool, &id, None);
            st.apply(&with_description(pre, tool), 2, &mut repo);
        }
        st.apply(&ev("SubagentStart", "S1", Some("A2")), 3, &mut repo);
        assert_eq!(st.get(&key("S1", "A2")).unwrap().description, None);
    }

    #[test]
    fn main_done_leaves_working_child_working() {
        let mut st = StatusState::new();
        st.apply(&ev("UserPromptSubmit", "S1", None), 1, &mut repo);
        st.apply(&ev("SubagentStart", "S1", Some("A1")), 2, &mut repo);
        st.apply(&ev("Stop", "S1", None), 3, &mut repo);
        assert_eq!(st.get(&main_key("S1")).unwrap().status, Done);
        assert_eq!(st.get(&key("S1", "A1")).unwrap().status, Working);
    }

    #[test]
    fn async_post_tool_use_after_stop_keeps_done_from_both_directions() {
        let mut st = StatusState::new();
        st.apply(
            &tool_ev("PreToolUse", "S1", None, "Bash", "t1", None),
            1,
            &mut repo,
        );
        st.apply(&ev("Stop", "S1", None), 2, &mut repo);
        st.apply(
            &tool_ev("PostToolUse", "S1", None, "Bash", "t1", None),
            3,
            &mut repo,
        );
        let a = st.get(&main_key("S1")).unwrap();
        assert_eq!(a.status, Done);
        assert_eq!(a.last_event_ms, 3);

        let mut st = StatusState::new();
        st.apply(
            &tool_ev("PreToolUse", "S1", None, "Bash", "t1", None),
            1,
            &mut repo,
        );
        st.apply(
            &tool_ev("PostToolUse", "S1", None, "Bash", "t1", None),
            2,
            &mut repo,
        );
        st.apply(&ev("Stop", "S1", None), 3, &mut repo);
        assert_eq!(st.get(&main_key("S1")).unwrap().status, Done);
    }

    #[test]
    fn new_prompt_removes_finished_children_only() {
        let mut st = StatusState::new();
        st.apply(&ev("UserPromptSubmit", "S1", None), 1, &mut repo);
        st.apply(&ev("SubagentStart", "S1", Some("A1")), 2, &mut repo);
        st.apply(&ev("SubagentStop", "S1", Some("A1")), 3, &mut repo);
        st.apply(&ev("SubagentStart", "S1", Some("A2")), 4, &mut repo);
        let out = st.apply(&ev("UserPromptSubmit", "S1", None), 5, &mut repo);
        let ApplyOutcome::Changed(changes) = out else {
            panic!("prompt must be applied, got {out:?}");
        };
        assert_eq!(changes.removed, vec![key("S1", "A1")]);
        assert_eq!(st.get(&key("S1", "A1")), None);
        assert!(st.get(&key("S1", "A2")).is_some());
    }

    #[test]
    fn finished_child_removed_after_30m_not_idled() {
        let mut st = StatusState::new();
        st.apply(&ev("UserPromptSubmit", "S1", None), 1, &mut repo);
        st.apply(&ev("SubagentStart", "S1", Some("A1")), 2, &mut repo);
        st.apply(&ev("SubagentStop", "S1", Some("A1")), 3, &mut repo);
        st.apply(&ev("Stop", "S1", None), 4, &mut repo);
        let ch = st.tick(4 + CHILD_REMOVE_MS);
        assert!(ch.removed.contains(&key("S1", "A1")));
        assert_eq!(st.get(&key("S1", "A1")), None);
        assert!(!ch.removed.contains(&main_key("S1")));
        assert!(ch.upserted.contains(&main_key("S1")));
        assert_eq!(st.get(&main_key("S1")).unwrap().status, Idle);

        st.apply(&ev("SubagentStart", "S1", Some("A2")), 5, &mut repo);
        st.apply(&ev("StopFailure", "S1", Some("A2")), 6, &mut repo);
        let ch = st.tick(6 + CHILD_REMOVE_MS);
        assert!(ch.removed.contains(&key("S1", "A2")));
        assert_eq!(st.get(&key("S1", "A2")), None);
    }

    #[test]
    fn tool_text_off_strips_and_clears() {
        let mut st = StatusState::new();
        let mut pre = tool_ev("PreToolUse", "S1", None, "Bash", "t1", None);
        pre.command = Some("npm test".into());
        st.apply(&pre, 1, &mut repo);
        assert_eq!(
            st.get(&main_key("S1"))
                .unwrap()
                .action
                .unwrap()
                .command
                .as_deref(),
            Some("npm test")
        );
        assert_eq!(st.set_tool_text(false), vec![main_key("S1")]);
        assert_eq!(
            st.get(&main_key("S1")).unwrap().action.unwrap().command,
            None
        );
        assert!(!st.tool_text());

        let mut e = ev("PreToolUse", "S1", None);
        e.command = Some("npm test".into());
        e.description = Some("run the tests".into());
        let off = st.prepare(e.clone());
        assert_eq!(off.command, None);
        assert_eq!(off.description, None);
        st.set_tool_text(true);
        assert!(st.tool_text());
        assert_eq!(st.prepare(e.clone()), e);
    }

    #[test]
    fn tool_text_off_clears_child_description_and_in_flight_text() {
        let mut st = StatusState::new();
        let mut pre = tool_ev("PreToolUse", "S1", None, "Agent", "t1", None);
        pre.command = Some("delegate".into());
        st.apply(&with_description(pre, "scan repo"), 1, &mut repo);
        st.apply(&ev("SubagentStart", "S1", Some("A1")), 2, &mut repo);
        // A second delegation is in flight when the text is turned off.
        let mut pre = tool_ev("PreToolUse", "S1", None, "Agent", "t2", None);
        pre.command = Some("delegate again".into());
        st.apply(&with_description(pre, "scan tests"), 3, &mut repo);
        assert_eq!(
            st.set_tool_text(false),
            vec![main_key("S1"), key("S1", "A1")]
        );
        assert_eq!(st.get(&key("S1", "A1")).unwrap().description, None);

        st.set_tool_text(true);
        st.apply(&ev("SubagentStart", "S1", Some("A2")), 4, &mut repo);
        assert_eq!(
            st.get(&key("S1", "A2")).unwrap().description,
            None,
            "the in-flight description was cleared"
        );
    }
}
