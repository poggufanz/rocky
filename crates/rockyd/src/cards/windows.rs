//! Turn and tool-window tracking for change cards.

use std::collections::BTreeMap;

use rocky_proto::hook::HookEvent;
use rocky_proto::paths::canonical_path;
use rocky_proto::pipe::{AgentKey, RepoInfo};

/// How long after a turn closes late events still update that turn.
pub const REVISION_WINDOW_MS: u64 = 60_000;

/// Prompt text captured from a `UserPromptSubmit` hook event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptIn {
    pub session_id: String,
    pub text: String,
    pub truncated: bool,
    pub recv_ms: u64,
}

/// Broad classification of a tool call for card attribution.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolKind {
    Edit,
    Bash,
    Other,
}

/// One `PreToolUse`..`PostToolUse` (or failure) window inside a turn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolWindow {
    pub tool_use_id: String,
    pub agent: AgentKey,
    pub kind: ToolKind,
    pub tool: String,
    pub target_path: Option<String>,
    pub command: Option<String>,
    pub pre_ms: u64,
    pub post_ms: Option<u64>,
    pub ok: Option<bool>,
}

/// Lifecycle state of a tracked turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnEnd {
    Open,
    Done,
    Failed,
    Unclosed,
}

/// One main-agent or subagent turn with its prompt, metadata, and tool windows.
#[derive(Debug, Clone, PartialEq)]
pub struct Turn {
    pub agent: AgentKey,
    pub agent_type: String,
    pub parent: Option<AgentKey>,
    pub cwd: Option<String>,
    pub repo: RepoInfo,
    pub prompt: Option<PromptIn>,
    pub started_ms: u64,
    pub ended_ms: Option<u64>,
    pub status: TurnEnd,
    pub transcript_path: Option<String>,
    pub windows: Vec<ToolWindow>,
}

/// Signals emitted by [`Tracker::on_event`] for capture flushing and card builds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TrackerSignal {
    EditDone { root: String, post_ms: u64 },
    TurnClosed(AgentKey),
    Late(AgentKey),
}

/// Tracks open turns per agent and keeps closed turns for their 60 s revision window.
#[derive(Debug, Default)]
pub struct Tracker {
    open: BTreeMap<AgentKey, Turn>,
    closed: Vec<Turn>,
}

impl Tracker {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn open_turn(&self, key: &AgentKey) -> Option<&Turn> {
        self.open.get(key)
    }

    pub fn closed_turn(&self, key: &AgentKey) -> Option<&Turn> {
        self.closed.iter().rev().find(|turn| &turn.agent == key)
    }

    /// Processes one hook event and returns signals for closed turns, late updates, and edits.
    pub fn on_event(
        &mut self,
        ev: &HookEvent,
        recv_ms: u64,
        repo: &RepoInfo,
    ) -> Vec<TrackerSignal> {
        let mut signals = Vec::new();
        let key = agent_key(ev);

        match ev.hook_event_name.as_str() {
            "UserPromptSubmit" => {
                if !key.agent_id.is_empty() {
                    return signals;
                }
                self.close_open_unclosed(&key, recv_ms, &mut signals);
                self.open.insert(
                    key.clone(),
                    Turn {
                        agent: key,
                        agent_type: ev.agent_type.clone().unwrap_or_default(),
                        parent: None,
                        cwd: ev.cwd.clone(),
                        repo: repo.clone(),
                        prompt: None,
                        started_ms: recv_ms,
                        ended_ms: None,
                        status: TurnEnd::Open,
                        transcript_path: ev.transcript_path.clone(),
                        windows: Vec::new(),
                    },
                );
            }
            "Stop" | "StopFailure" => {
                if !key.agent_id.is_empty() {
                    return signals;
                }
                if let Some(mut turn) = self.open.remove(&key) {
                    turn.ended_ms = Some(recv_ms);
                    turn.status = if ev.hook_event_name == "Stop" {
                        TurnEnd::Done
                    } else {
                        TurnEnd::Failed
                    };
                    if ev.transcript_path.is_some() {
                        turn.transcript_path = ev.transcript_path.clone();
                    }
                    fill_metadata(&mut turn, ev, repo);
                    self.closed.push(turn);
                    signals.push(TrackerSignal::TurnClosed(key));
                }
            }
            "SubagentStart" => {
                if key.agent_id.is_empty() {
                    return signals;
                }
                self.close_open_unclosed(&key, recv_ms, &mut signals);
                let parent = AgentKey {
                    session_id: ev.session_id.clone(),
                    agent_id: String::new(),
                };
                self.open.insert(
                    key.clone(),
                    Turn {
                        agent: key,
                        agent_type: ev.agent_type.clone().unwrap_or_default(),
                        parent: Some(parent),
                        cwd: ev.cwd.clone(),
                        repo: repo.clone(),
                        prompt: None,
                        started_ms: recv_ms,
                        ended_ms: None,
                        status: TurnEnd::Open,
                        transcript_path: None,
                        windows: Vec::new(),
                    },
                );
            }
            "SubagentStop" => {
                if key.agent_id.is_empty() {
                    return signals;
                }
                if let Some(mut turn) = self.open.remove(&key) {
                    turn.ended_ms = Some(recv_ms);
                    turn.status = TurnEnd::Done;
                    if ev.agent_transcript_path.is_some() {
                        turn.transcript_path = ev.agent_transcript_path.clone();
                    }
                    fill_metadata(&mut turn, ev, repo);
                    self.closed.push(turn);
                    signals.push(TrackerSignal::TurnClosed(key));
                }
            }
            "SessionEnd" => {
                let keys: Vec<AgentKey> = self
                    .open
                    .keys()
                    .filter(|k| k.session_id == ev.session_id)
                    .cloned()
                    .collect();
                for k in keys {
                    if let Some(mut turn) = self.open.remove(&k) {
                        turn.ended_ms = Some(recv_ms);
                        turn.status = TurnEnd::Unclosed;
                        if k.agent_id.is_empty()
                            && turn.transcript_path.is_none()
                            && ev.transcript_path.is_some()
                        {
                            turn.transcript_path = ev.transcript_path.clone();
                        }
                        fill_metadata(&mut turn, ev, repo);
                        self.closed.push(turn);
                        signals.push(TrackerSignal::TurnClosed(k));
                    }
                }
            }
            "PreToolUse" => {
                let Some(tool) = ev.tool_name.clone() else {
                    return signals;
                };
                let window = ToolWindow {
                    tool_use_id: ev.tool_use_id.clone().unwrap_or_default(),
                    agent: key.clone(),
                    kind: classify_tool(&tool),
                    tool,
                    target_path: ev.target_path.clone(),
                    command: ev.command.clone(),
                    pre_ms: recv_ms,
                    post_ms: None,
                    ok: None,
                };
                if let Some(turn) = self.open.get_mut(&key) {
                    fill_metadata(turn, ev, repo);
                    turn.windows.push(window);
                } else if let Some(turn) = self.latest_closed_within_window_mut(&key, recv_ms) {
                    fill_metadata(turn, ev, repo);
                    turn.windows.push(window);
                    signals.push(TrackerSignal::Late(key));
                }
            }
            "PostToolUse" | "PostToolUseFailure" => {
                let ok = ev.hook_event_name == "PostToolUse";
                let Some(tool_use_id) = ev.tool_use_id.as_deref().filter(|id| !id.is_empty())
                else {
                    return signals;
                };
                if let Some(turn) = self.open.get_mut(&key)
                    && let Some(edit_signal) =
                        close_matching_window(turn, tool_use_id, recv_ms, ok, ev, repo)
                {
                    if let Some(sig) = edit_signal {
                        signals.push(sig);
                    }
                    return signals;
                }
                if let Some(turn) = self.closed.iter_mut().rev().find(|turn| {
                    turn.agent == key
                        && within_revision_window(turn, recv_ms)
                        && has_open_window(turn, tool_use_id)
                }) && let Some(edit_signal) =
                    close_matching_window(turn, tool_use_id, recv_ms, ok, ev, repo)
                {
                    signals.push(TrackerSignal::Late(key));
                    if let Some(sig) = edit_signal {
                        signals.push(sig);
                    }
                }
            }
            _ => {}
        }

        signals
    }

    /// Attaches `p` to the session's open main turn, or drops it when no main turn is open.
    pub fn on_prompt(&mut self, p: PromptIn) {
        let key = AgentKey {
            session_id: p.session_id.clone(),
            agent_id: String::new(),
        };
        if let Some(turn) = self.open.get_mut(&key) {
            turn.prompt = Some(p);
        }
    }

    /// Removes and returns closed turns that have passed the 60 s revision window.
    pub fn expire(&mut self, now_ms: u64) -> Vec<Turn> {
        let mut expired = Vec::new();
        let mut kept = Vec::with_capacity(self.closed.len());
        for turn in self.closed.drain(..) {
            if turn
                .ended_ms
                .is_some_and(|ended| now_ms.saturating_sub(ended) >= REVISION_WINDOW_MS)
            {
                expired.push(turn);
            } else {
                kept.push(turn);
            }
        }
        self.closed = kept;
        expired
    }

    fn close_open_unclosed(
        &mut self,
        key: &AgentKey,
        recv_ms: u64,
        signals: &mut Vec<TrackerSignal>,
    ) {
        if let Some(mut prev) = self.open.remove(key) {
            prev.ended_ms = Some(recv_ms);
            prev.status = TurnEnd::Unclosed;
            self.closed.push(prev);
            signals.push(TrackerSignal::TurnClosed(key.clone()));
        }
    }

    fn latest_closed_within_window_mut(
        &mut self,
        key: &AgentKey,
        recv_ms: u64,
    ) -> Option<&mut Turn> {
        self.closed
            .iter_mut()
            .rev()
            .find(|turn| &turn.agent == key && within_revision_window(turn, recv_ms))
    }
}

fn agent_key(ev: &HookEvent) -> AgentKey {
    AgentKey {
        session_id: ev.session_id.clone(),
        agent_id: ev.agent_id.clone().unwrap_or_default(),
    }
}

fn classify_tool(name: &str) -> ToolKind {
    match name {
        "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => ToolKind::Edit,
        "Bash" => ToolKind::Bash,
        _ => ToolKind::Other,
    }
}

fn within_revision_window(turn: &Turn, recv_ms: u64) -> bool {
    turn.ended_ms
        .is_some_and(|ended| recv_ms.saturating_sub(ended) < REVISION_WINDOW_MS)
}

fn has_open_window(turn: &Turn, tool_use_id: &str) -> bool {
    turn.windows
        .iter()
        .any(|w| w.post_ms.is_none() && w.tool_use_id == tool_use_id)
}

fn fill_metadata(turn: &mut Turn, ev: &HookEvent, repo: &RepoInfo) {
    if turn.cwd.is_none() && ev.cwd.is_some() {
        turn.cwd = ev.cwd.clone();
    }
    if turn.repo.root.is_none() && repo.root.is_some() {
        turn.repo = repo.clone();
    }
}

/// Closes the matching open window and returns `Some(optional EditDone)` when one matched.
fn close_matching_window(
    turn: &mut Turn,
    tool_use_id: &str,
    recv_ms: u64,
    ok: bool,
    ev: &HookEvent,
    repo: &RepoInfo,
) -> Option<Option<TrackerSignal>> {
    let window = turn
        .windows
        .iter_mut()
        .rev()
        .find(|w| w.post_ms.is_none() && w.tool_use_id == tool_use_id)?;
    window.post_ms = Some(recv_ms);
    window.ok = Some(ok);
    if window.target_path.is_none() && ev.target_path.is_some() {
        window.target_path = ev.target_path.clone();
    }
    if window.command.is_none() && ev.command.is_some() {
        window.command = ev.command.clone();
    }
    let kind = window.kind;
    let target_path = window.target_path.clone();
    fill_metadata(turn, ev, repo);

    let edit_signal = if ok && kind == ToolKind::Edit {
        let root = turn.repo.root.as_deref().or(repo.root.as_deref());
        match (root, target_path.as_deref()) {
            (Some(root), Some(target)) if path_under_root(target, root) => {
                Some(TrackerSignal::EditDone {
                    root: root.to_string(),
                    post_ms: recv_ms,
                })
            }
            _ => None,
        }
    } else {
        None
    };
    Some(edit_signal)
}

fn normalize_absolute_lexical(path: &str) -> Option<String> {
    let canon = canonical_path(path, cfg!(windows));
    if canon.is_empty() {
        return None;
    }
    let bytes = canon.as_bytes();
    let prefix_len = if canon.starts_with("//") {
        2
    } else if canon.starts_with('/') {
        1
    } else if bytes.first().is_some_and(u8::is_ascii_alphabetic)
        && bytes.get(1) == Some(&b':')
        && bytes.get(2) == Some(&b'/')
    {
        3
    } else {
        return None;
    };

    let prefix = &canon[..prefix_len];
    let rest = &canon[prefix_len..];
    let mut stack: Vec<&str> = Vec::new();
    for seg in rest.split('/').filter(|s| !s.is_empty()) {
        if seg == ".." {
            stack.pop()?;
        } else {
            stack.push(seg);
        }
    }

    let mut out = String::with_capacity(canon.len());
    out.push_str(prefix);
    for (idx, seg) in stack.iter().enumerate() {
        if idx > 0 {
            out.push('/');
        }
        out.push_str(seg);
    }
    Some(out)
}

fn path_under_root(target: &str, root: &str) -> bool {
    let Some(t) = normalize_absolute_lexical(target) else {
        return false;
    };
    let Some(r) = normalize_absolute_lexical(root) else {
        return false;
    };
    if r.ends_with('/') {
        t.starts_with(&r) && t.len() > r.len()
    } else {
        t.starts_with(&r) && t.as_bytes().get(r.len()) == Some(&b'/') && t.len() > r.len() + 1
    }
}

#[cfg(test)]
mod tests {
    use rocky_proto::hook::HookEvent;
    use rocky_proto::pipe::{AgentKey, RepoInfo};

    use super::{PromptIn, ToolKind, Tracker, TrackerSignal, TurnEnd};

    fn repo(root: Option<&str>) -> RepoInfo {
        RepoInfo {
            root: root.map(str::to_string),
            main_root: root.map(str::to_string),
            name: "repo".into(),
            branch: Some("main".into()),
        }
    }

    fn key(sid: &str, aid: &str) -> AgentKey {
        AgentKey {
            session_id: sid.into(),
            agent_id: aid.into(),
        }
    }

    fn ev(name: &str, sid: &str, aid: Option<&str>) -> HookEvent {
        HookEvent {
            hook_event_name: name.into(),
            session_id: sid.into(),
            cwd: Some("C:/repo".into()),
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
            prompt: None,
            truncated: false,
        }
    }

    fn tool_ev(
        name: &str,
        sid: &str,
        aid: Option<&str>,
        tool: &str,
        id: &str,
        target: Option<&str>,
        command: Option<&str>,
    ) -> HookEvent {
        let mut e = ev(name, sid, aid);
        e.tool_name = Some(tool.into());
        e.tool_use_id = Some(id.into());
        e.target_path = target.map(str::to_string);
        e.command = command.map(str::to_string);
        e
    }

    #[test]
    fn main_turn_opens_and_closes() {
        let mut tracker = Tracker::new();
        let r = repo(Some("C:/repo"));
        assert!(
            tracker
                .on_event(&ev("UserPromptSubmit", "S1", None), 1_000, &r)
                .is_empty()
        );
        let open = tracker.open_turn(&key("S1", "")).expect("open main turn");
        assert_eq!(open.status, TurnEnd::Open);
        assert_eq!(open.started_ms, 1_000);
        assert_eq!(open.ended_ms, None);
        assert_eq!(open.parent, None);

        let mut stop = ev("Stop", "S1", None);
        stop.transcript_path = Some("C:/cfg/projects/repo/S1.jsonl".into());
        let sigs = tracker.on_event(&stop, 2_500, &r);
        assert_eq!(sigs, vec![TrackerSignal::TurnClosed(key("S1", ""))]);
        assert!(tracker.open_turn(&key("S1", "")).is_none());

        let closed = tracker
            .closed_turn(&key("S1", ""))
            .expect("closed main turn");
        assert_eq!(closed.status, TurnEnd::Done);
        assert_eq!(closed.ended_ms, Some(2_500));
        assert_eq!(
            closed.transcript_path.as_deref(),
            Some("C:/cfg/projects/repo/S1.jsonl")
        );

        tracker.on_event(&ev("UserPromptSubmit", "S2", None), 3_000, &r);
        let sigs = tracker.on_event(&ev("StopFailure", "S2", None), 3_500, &r);
        assert_eq!(sigs, vec![TrackerSignal::TurnClosed(key("S2", ""))]);
        let failed = tracker
            .closed_turn(&key("S2", ""))
            .expect("closed failed turn");
        assert_eq!(failed.status, TurnEnd::Failed);
        assert_eq!(failed.ended_ms, Some(3_500));
    }

    #[test]
    fn subagent_turn_has_parent_and_transcript() {
        let mut tracker = Tracker::new();
        let r = repo(Some("C:/repo"));
        tracker.on_event(&ev("UserPromptSubmit", "S1", None), 1_000, &r);

        let mut start = ev("SubagentStart", "S1", Some("A1"));
        start.agent_type = Some("Explore".into());
        assert!(tracker.on_event(&start, 1_500, &r).is_empty());

        let open = tracker
            .open_turn(&key("S1", "A1"))
            .expect("open subagent turn");
        assert_eq!(open.parent, Some(key("S1", "")));
        assert_eq!(open.agent_type, "Explore");
        assert_eq!(open.status, TurnEnd::Open);

        let mut stop = ev("SubagentStop", "S1", Some("A1"));
        stop.transcript_path = Some("C:/cfg/projects/repo/S1.jsonl".into());
        stop.agent_transcript_path =
            Some("C:/cfg/projects/repo/S1/subagents/agent-A1.jsonl".into());
        let sigs = tracker.on_event(&stop, 2_000, &r);
        assert_eq!(sigs, vec![TrackerSignal::TurnClosed(key("S1", "A1"))]);

        let closed = tracker
            .closed_turn(&key("S1", "A1"))
            .expect("closed subagent turn");
        assert_eq!(closed.status, TurnEnd::Done);
        assert_eq!(closed.ended_ms, Some(2_000));
        assert_eq!(
            closed.transcript_path.as_deref(),
            Some("C:/cfg/projects/repo/S1/subagents/agent-A1.jsonl")
        );

        let helper_stop = ev("SubagentStop", "S1", Some("A_helper"));
        assert!(tracker.on_event(&helper_stop, 2_100, &r).is_empty());
        assert!(tracker.closed_turn(&key("S1", "A_helper")).is_none());
    }

    #[test]
    fn session_end_closes_unclosed() {
        let mut tracker = Tracker::new();
        let r = repo(Some("C:/repo"));
        tracker.on_event(&ev("UserPromptSubmit", "S1", None), 1_000, &r);
        let mut sub = ev("SubagentStart", "S1", Some("A1"));
        sub.agent_type = Some("general-purpose".into());
        tracker.on_event(&sub, 1_500, &r);

        let sigs = tracker.on_event(&ev("SessionEnd", "S1", None), 3_000, &r);
        assert_eq!(sigs.len(), 2);
        assert!(sigs.contains(&TrackerSignal::TurnClosed(key("S1", ""))));
        assert!(sigs.contains(&TrackerSignal::TurnClosed(key("S1", "A1"))));
        assert!(tracker.open_turn(&key("S1", "")).is_none());
        assert!(tracker.open_turn(&key("S1", "A1")).is_none());

        let main_closed = tracker.closed_turn(&key("S1", "")).unwrap();
        assert_eq!(main_closed.status, TurnEnd::Unclosed);
        assert_eq!(main_closed.ended_ms, Some(3_000));

        let sub_closed = tracker.closed_turn(&key("S1", "A1")).unwrap();
        assert_eq!(sub_closed.status, TurnEnd::Unclosed);
        assert_eq!(sub_closed.ended_ms, Some(3_000));
    }

    #[test]
    fn windows_pair_by_tool_use_id_with_times() {
        let mut tracker = Tracker::new();
        let r = repo(Some("C:/repo"));
        tracker.on_event(&ev("UserPromptSubmit", "S1", None), 1_000, &r);

        assert!(
            tracker
                .on_event(
                    &tool_ev(
                        "PreToolUse",
                        "S1",
                        None,
                        "Read",
                        "t1",
                        Some("C:/repo/a.ts"),
                        None
                    ),
                    1_100,
                    &r
                )
                .is_empty()
        );
        assert!(
            tracker
                .on_event(
                    &tool_ev(
                        "PreToolUse",
                        "S1",
                        None,
                        "Edit",
                        "t2",
                        Some("C:/repo/b.ts"),
                        None
                    ),
                    1_200,
                    &r
                )
                .is_empty()
        );
        assert!(
            tracker
                .on_event(
                    &tool_ev(
                        "PreToolUse",
                        "S1",
                        None,
                        "Bash",
                        "t3",
                        None,
                        Some("npm test")
                    ),
                    1_300,
                    &r
                )
                .is_empty()
        );

        assert!(
            tracker
                .on_event(
                    &tool_ev("PostToolUse", "S1", None, "Read", "t1", None, None),
                    1_400,
                    &r
                )
                .is_empty()
        );
        assert!(
            tracker
                .on_event(
                    &tool_ev("PostToolUse", "S1", None, "Bash", "t3", None, None),
                    1_500,
                    &r
                )
                .is_empty()
        );
        let edit_sigs = tracker.on_event(
            &tool_ev(
                "PostToolUse",
                "S1",
                None,
                "Edit",
                "t2",
                Some("C:/repo/b.ts"),
                None,
            ),
            1_600,
            &r,
        );
        assert_eq!(
            edit_sigs,
            vec![TrackerSignal::EditDone {
                root: "C:/repo".into(),
                post_ms: 1_600
            }]
        );

        for (i, tool) in ["Write", "MultiEdit", "NotebookEdit"].iter().enumerate() {
            let id = format!("e{i}");
            let ts = 1_700 + i as u64 * 100;
            tracker.on_event(
                &tool_ev(
                    "PreToolUse",
                    "S1",
                    None,
                    tool,
                    &id,
                    Some("C:/repo/c.ts"),
                    None,
                ),
                ts,
                &r,
            );
            let sigs = tracker.on_event(
                &tool_ev(
                    "PostToolUse",
                    "S1",
                    None,
                    tool,
                    &id,
                    Some("C:/repo/c.ts"),
                    None,
                ),
                ts + 50,
                &r,
            );
            assert_eq!(
                sigs,
                vec![TrackerSignal::EditDone {
                    root: "C:/repo".into(),
                    post_ms: ts + 50
                }]
            );
        }

        let turn = tracker.open_turn(&key("S1", "")).unwrap();
        assert_eq!(turn.windows.len(), 6);
        assert_eq!(turn.windows[0].tool_use_id, "t1");
        assert_eq!(turn.windows[0].kind, ToolKind::Other);
        assert_eq!(turn.windows[0].pre_ms, 1_100);
        assert_eq!(turn.windows[0].post_ms, Some(1_400));
        assert_eq!(turn.windows[0].ok, Some(true));

        assert_eq!(turn.windows[1].tool_use_id, "t2");
        assert_eq!(turn.windows[1].kind, ToolKind::Edit);
        assert_eq!(turn.windows[1].pre_ms, 1_200);
        assert_eq!(turn.windows[1].post_ms, Some(1_600));
        assert_eq!(turn.windows[1].ok, Some(true));

        assert_eq!(turn.windows[2].tool_use_id, "t3");
        assert_eq!(turn.windows[2].kind, ToolKind::Bash);
        assert_eq!(turn.windows[2].command.as_deref(), Some("npm test"));
        assert_eq!(turn.windows[2].pre_ms, 1_300);
        assert_eq!(turn.windows[2].post_ms, Some(1_500));
        assert_eq!(turn.windows[2].ok, Some(true));
    }

    #[test]
    fn failure_closes_window_not_ok() {
        let mut tracker = Tracker::new();
        let r = repo(Some("C:/repo"));
        tracker.on_event(&ev("UserPromptSubmit", "S1", None), 1_000, &r);
        tracker.on_event(
            &tool_ev(
                "PreToolUse",
                "S1",
                None,
                "Bash",
                "t1",
                None,
                Some("cargo test"),
            ),
            1_100,
            &r,
        );
        let sigs = tracker.on_event(
            &tool_ev("PostToolUseFailure", "S1", None, "Bash", "t1", None, None),
            1_200,
            &r,
        );
        assert!(sigs.is_empty());

        tracker.on_event(
            &tool_ev(
                "PreToolUse",
                "S1",
                None,
                "Edit",
                "t2",
                Some("C:/repo/a.ts"),
                None,
            ),
            1_300,
            &r,
        );
        let edit_fail_sigs = tracker.on_event(
            &tool_ev(
                "PostToolUseFailure",
                "S1",
                None,
                "Edit",
                "t2",
                Some("C:/repo/a.ts"),
                None,
            ),
            1_400,
            &r,
        );
        assert!(edit_fail_sigs.is_empty());

        let turn = tracker.open_turn(&key("S1", "")).unwrap();
        assert_eq!(turn.windows.len(), 2);
        assert_eq!(turn.windows[0].post_ms, Some(1_200));
        assert_eq!(turn.windows[0].ok, Some(false));
        assert_eq!(turn.windows[1].post_ms, Some(1_400));
        assert_eq!(turn.windows[1].ok, Some(false));
    }

    #[test]
    fn late_post_within_60s_updates_closed_turn() {
        let mut tracker = Tracker::new();
        let r = repo(Some("C:/repo"));
        tracker.on_event(&ev("UserPromptSubmit", "S1", None), 1_000, &r);
        tracker.on_event(
            &tool_ev(
                "PreToolUse",
                "S1",
                None,
                "Edit",
                "t1",
                Some("C:/repo/a.ts"),
                None,
            ),
            1_100,
            &r,
        );
        assert_eq!(
            tracker.on_event(&ev("Stop", "S1", None), 2_000, &r),
            vec![TrackerSignal::TurnClosed(key("S1", ""))]
        );

        let late_ms = 2_000 + 59_999;
        let sigs = tracker.on_event(
            &tool_ev(
                "PostToolUse",
                "S1",
                None,
                "Edit",
                "t1",
                Some("C:/repo/a.ts"),
                None,
            ),
            late_ms,
            &r,
        );
        assert!(sigs.contains(&TrackerSignal::Late(key("S1", ""))));
        assert!(sigs.contains(&TrackerSignal::EditDone {
            root: "C:/repo".into(),
            post_ms: late_ms,
        }));

        let closed = tracker.closed_turn(&key("S1", "")).unwrap();
        assert_eq!(closed.windows[0].post_ms, Some(late_ms));
        assert_eq!(closed.windows[0].ok, Some(true));

        assert!(tracker.expire(late_ms).is_empty());
        let expired = tracker.expire(2_000 + 60_000);
        assert_eq!(expired.len(), 1);
        assert_eq!(expired[0].windows[0].post_ms, Some(late_ms));
        assert!(tracker.closed_turn(&key("S1", "")).is_none());
    }

    #[test]
    fn event_after_60s_is_ignored() {
        let mut tracker = Tracker::new();
        let r = repo(Some("C:/repo"));
        tracker.on_event(&ev("UserPromptSubmit", "S1", None), 1_000, &r);
        tracker.on_event(
            &tool_ev(
                "PreToolUse",
                "S1",
                None,
                "Read",
                "t1",
                Some("C:/repo/a.ts"),
                None,
            ),
            1_100,
            &r,
        );
        tracker.on_event(&ev("Stop", "S1", None), 2_000, &r);

        assert!(
            tracker
                .on_event(
                    &tool_ev("PostToolUse", "S1", None, "Read", "t1", None, None),
                    2_000 + 60_000,
                    &r
                )
                .is_empty()
        );
        assert!(
            tracker
                .on_event(
                    &tool_ev("PostToolUse", "S1", None, "Read", "t1", None, None),
                    2_000 + 65_000,
                    &r
                )
                .is_empty()
        );
        let closed = tracker.closed_turn(&key("S1", "")).unwrap();
        assert_eq!(closed.windows[0].post_ms, None);
        assert_eq!(closed.windows[0].ok, None);
    }

    #[test]
    fn prompt_attaches_to_open_main_turn() {
        let mut tracker = Tracker::new();
        let r = repo(Some("C:/repo"));
        tracker.on_event(&ev("UserPromptSubmit", "S1", None), 1_000, &r);
        let prompt = PromptIn {
            session_id: "S1".into(),
            text: "fix the cart".into(),
            truncated: false,
            recv_ms: 1_000,
        };
        tracker.on_prompt(prompt.clone());

        let open = tracker.open_turn(&key("S1", "")).unwrap();
        assert_eq!(open.prompt.as_ref(), Some(&prompt));

        tracker.on_event(&ev("Stop", "S1", None), 2_000, &r);
        let closed = tracker.closed_turn(&key("S1", "")).unwrap();
        assert_eq!(closed.prompt.as_ref(), Some(&prompt));
    }

    #[test]
    fn prompt_without_turn_is_dropped() {
        let mut tracker = Tracker::new();
        let r = repo(Some("C:/repo"));
        tracker.on_prompt(PromptIn {
            session_id: "S1".into(),
            text: "before turn".into(),
            truncated: false,
            recv_ms: 500,
        });
        assert!(tracker.open_turn(&key("S1", "")).is_none());

        tracker.on_event(&ev("UserPromptSubmit", "S1", None), 1_000, &r);
        tracker.on_event(&ev("Stop", "S1", None), 2_000, &r);
        tracker.on_prompt(PromptIn {
            session_id: "S1".into(),
            text: "after stop".into(),
            truncated: false,
            recv_ms: 2_500,
        });
        let closed = tracker.closed_turn(&key("S1", "")).unwrap();
        assert_eq!(closed.prompt, None);
    }

    #[test]
    fn edit_outside_repo_emits_no_flush() {
        let mut tracker = Tracker::new();
        let r = repo(Some("C:/repo"));
        tracker.on_event(&ev("UserPromptSubmit", "S1", None), 1_000, &r);

        for (i, path) in [
            "C:/other/a.ts",
            "C:/repo-other/a.ts",
            "C:/repo/../other/a.ts",
        ]
        .iter()
        .enumerate()
        {
            let id = format!("t{i}");
            let ts = 1_100 + i as u64 * 100;
            tracker.on_event(
                &tool_ev("PreToolUse", "S1", None, "Write", &id, Some(path), None),
                ts,
                &r,
            );
            let sigs = tracker.on_event(
                &tool_ev("PostToolUse", "S1", None, "Write", &id, Some(path), None),
                ts + 50,
                &r,
            );
            assert!(sigs.is_empty(), "unexpected flush for {path}: {sigs:?}");
        }

        let no_repo = repo(None);
        tracker.on_event(&ev("UserPromptSubmit", "S2", None), 2_000, &no_repo);
        tracker.on_event(
            &tool_ev(
                "PreToolUse",
                "S2",
                None,
                "Edit",
                "t9",
                Some("C:/repo/a.ts"),
                None,
            ),
            2_100,
            &no_repo,
        );
        let sigs = tracker.on_event(
            &tool_ev(
                "PostToolUse",
                "S2",
                None,
                "Edit",
                "t9",
                Some("C:/repo/a.ts"),
                None,
            ),
            2_200,
            &no_repo,
        );
        assert!(sigs.is_empty());
    }
}
