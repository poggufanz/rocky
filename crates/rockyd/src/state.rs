//! Per-agent status machine: hook events in, agent statuses out.

use std::collections::BTreeMap;

use rocky_proto::hook::HookEvent;
use rocky_proto::pipe::{Action, AgentKey, AgentStatus, RepoInfo, Status};

pub const DONE_TO_IDLE_MS: u64 = 30 * 60_000;
pub const QUIET_MS: u64 = 10 * 60_000;
pub const ENDED_REMOVE_MS: u64 = 60 * 60_000;

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
    in_flight: Vec<Action>,
    last_recv_ms: u64,
}

#[derive(Debug, Default)]
pub struct StatusState {
    agents: BTreeMap<AgentKey, Agent>,
    repos: BTreeMap<String, RepoInfo>,
}

impl StatusState {
    pub fn new() -> Self {
        Self::default()
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
        let agent = self.agents.entry(key.clone()).or_insert_with(|| Agent {
            status: AgentStatus {
                key: key.clone(),
                agent_type: None,
                status: Status::Idle,
                action: None,
                summary: None,
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
                    agent.in_flight.push(Action {
                        tool_name: tool,
                        target_path: ev.target_path.clone(),
                        tool_use_id: ev.tool_use_id.clone(),
                    });
                }
                agent.status.action = agent.in_flight.last().cloned();
            }
            "PostToolUse" | "PostToolUseFailure" => {
                if ev.hook_event_name == "PostToolUseFailure" {
                    agent.status.failures += 1;
                }
                remove_in_flight(&mut agent.in_flight, ev.tool_use_id.as_deref());
                agent.status.action = agent.in_flight.last().cloned();
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
        ApplyOutcome::Changed(Changes {
            upserted: vec![key],
            removed: Vec::new(),
        })
    }

    pub fn tick(&mut self, now_ms: u64) -> Changes {
        let mut upserted = Vec::new();
        let mut removed = Vec::new();
        for (key, agent) in self.agents.iter_mut() {
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

fn remove_in_flight(in_flight: &mut Vec<Action>, tool_use_id: Option<&str>) {
    match tool_use_id {
        Some(id) => {
            if let Some(pos) = in_flight
                .iter()
                .rposition(|a| a.tool_use_id.as_deref() == Some(id))
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
}
