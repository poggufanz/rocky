//! Turn and tool-window tracking for change cards.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct WindowRef {
    turn_id: u64,
    window_idx: usize,
}

/// Tracks open turns per agent and keeps closed turns for their 60 s revision window.
#[derive(Debug, Default)]
pub struct Tracker {
    next_turn_id: u64,
    /// Open and retained-closed turns indexed by unique turn ID.
    turns: HashMap<u64, Turn>,
    /// Currently open turn ID per agent.
    open_by_agent: HashMap<AgentKey, u64>,
    /// Open agents grouped by session ID so SessionEnd touches only that session.
    open_by_session: HashMap<String, HashSet<AgentKey>>,
    /// Retained closed turn IDs per agent ordered by `(started_ms, turn_id)`.
    closed_by_agent: HashMap<AgentKey, BTreeMap<(u64, u64), u64>>,
    /// Retained closed turns ordered by `(ended_ms, turn_id)` for bounded expiration.
    expire_index: BTreeSet<(u64, u64)>,
    /// Outstanding (unclosed) tool windows indexed by `(AgentKey, tool_use_id)`.
    open_windows: HashMap<(AgentKey, String), Vec<WindowRef>>,
}

impl Tracker {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn open_turn(&self, key: &AgentKey) -> Option<&Turn> {
        self.open_by_agent
            .get(key)
            .and_then(|id| self.turns.get(id))
    }

    pub fn closed_turn(&self, key: &AgentKey) -> Option<&Turn> {
        self.closed_by_agent
            .get(key)
            .and_then(|by_start| by_start.values().next_back())
            .and_then(|id| self.turns.get(id))
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
                if self.close_open_if_not_newer(&key, recv_ms, &mut signals) {
                    self.insert_open_turn(Turn {
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
                    });
                }
            }
            "Stop" | "StopFailure" => {
                if !key.agent_id.is_empty() {
                    return signals;
                }
                let status = if ev.hook_event_name == "Stop" {
                    TurnEnd::Done
                } else {
                    TurnEnd::Failed
                };
                self.handle_terminal(
                    key,
                    recv_ms,
                    status,
                    ev.transcript_path.as_ref(),
                    ev,
                    repo,
                    &mut signals,
                );
            }
            "SubagentStart" => {
                if key.agent_id.is_empty() {
                    return signals;
                }
                if self.close_open_if_not_newer(&key, recv_ms, &mut signals) {
                    let parent = AgentKey {
                        session_id: ev.session_id.clone(),
                        agent_id: String::new(),
                    };
                    self.insert_open_turn(Turn {
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
                    });
                }
            }
            "SubagentStop" => {
                if key.agent_id.is_empty() {
                    return signals;
                }
                self.handle_terminal(
                    key,
                    recv_ms,
                    TurnEnd::Done,
                    ev.agent_transcript_path.as_ref(),
                    ev,
                    repo,
                    &mut signals,
                );
            }
            "SessionEnd" => {
                let Some(agents) = self.open_by_session.remove(&ev.session_id) else {
                    return signals;
                };
                let mut kept = HashSet::new();
                for k in agents {
                    let Some(&turn_id) = self.open_by_agent.get(&k) else {
                        continue;
                    };
                    if self
                        .turns
                        .get(&turn_id)
                        .is_some_and(|t| recv_ms < t.started_ms)
                    {
                        kept.insert(k);
                        continue;
                    }
                    self.move_open_to_closed(&k, turn_id, recv_ms, TurnEnd::Unclosed);
                    if let Some(turn) = self.turns.get_mut(&turn_id) {
                        if k.agent_id.is_empty()
                            && turn.transcript_path.is_none()
                            && ev.transcript_path.is_some()
                        {
                            turn.transcript_path = ev.transcript_path.clone();
                        }
                        fill_metadata(turn, ev, repo);
                    }
                    signals.push(TrackerSignal::TurnClosed(k));
                }
                if !kept.is_empty() {
                    self.open_by_session.insert(ev.session_id.clone(), kept);
                }
            }
            "PreToolUse" => {
                let Some(tool) = ev.tool_name.clone() else {
                    return signals;
                };
                let (turn_id, is_late) = if let Some(id) = self.open_turn_for(&key, recv_ms) {
                    (id, false)
                } else if let Some(id) = self.closed_turn_for(&key, recv_ms) {
                    (id, true)
                } else {
                    return signals;
                };
                let tool_use_id = ev.tool_use_id.clone().unwrap_or_default();
                let window = ToolWindow {
                    tool_use_id: tool_use_id.clone(),
                    agent: key.clone(),
                    kind: classify_tool(&tool),
                    tool,
                    target_path: ev.target_path.clone(),
                    command: ev.command.clone(),
                    pre_ms: recv_ms,
                    post_ms: None,
                    ok: None,
                };
                if let Some(turn) = self.turns.get_mut(&turn_id) {
                    fill_metadata(turn, ev, repo);
                    let window_idx = turn.windows.len();
                    turn.windows.push(window);
                    if !tool_use_id.is_empty() {
                        self.open_windows
                            .entry((key.clone(), tool_use_id))
                            .or_default()
                            .push(WindowRef {
                                turn_id,
                                window_idx,
                            });
                    }
                    if is_late {
                        signals.push(TrackerSignal::Late(key));
                    }
                }
            }
            "PostToolUse" | "PostToolUseFailure" => {
                let ok = ev.hook_event_name == "PostToolUse";
                let Some(tool_use_id) = ev.tool_use_id.as_deref().filter(|id| !id.is_empty())
                else {
                    return signals;
                };
                let lookup_key = (key.clone(), tool_use_id.to_owned());
                let Some(refs) = self.open_windows.get_mut(&lookup_key) else {
                    return signals;
                };
                let Some(pos) = refs.iter().rposition(|wref| {
                    self.turns.get(&wref.turn_id).is_some_and(|turn| {
                        turn.status == TurnEnd::Open || within_revision_window(turn, recv_ms)
                    })
                }) else {
                    return signals;
                };
                let wref = refs.remove(pos);
                if refs.is_empty() {
                    self.open_windows.remove(&lookup_key);
                }
                let Some(turn) = self.turns.get_mut(&wref.turn_id) else {
                    return signals;
                };
                let is_late = turn.status != TurnEnd::Open;
                let edit_signal = close_window_at(turn, wref.window_idx, recv_ms, ok, ev, repo);
                if is_late {
                    signals.push(TrackerSignal::Late(key));
                }
                if let Some(sig) = edit_signal {
                    signals.push(sig);
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
        if let Some(&turn_id) = self.open_by_agent.get(&key)
            && let Some(turn) = self.turns.get_mut(&turn_id)
        {
            turn.prompt = Some(p);
        }
    }

    /// Removes and returns closed turns that have passed the 60 s revision window.
    pub fn expire(&mut self, now_ms: u64) -> Vec<Turn> {
        let Some(cutoff) = now_ms.checked_sub(REVISION_WINDOW_MS) else {
            return Vec::new();
        };
        let mut expired = Vec::new();
        while let Some(&(ended_ms, turn_id)) = self.expire_index.first() {
            if ended_ms > cutoff {
                break;
            }
            self.expire_index.pop_first();
            let Some(turn) = self.turns.remove(&turn_id) else {
                continue;
            };
            if let Some(by_start) = self.closed_by_agent.get_mut(&turn.agent) {
                by_start.remove(&(turn.started_ms, turn_id));
                if by_start.is_empty() {
                    self.closed_by_agent.remove(&turn.agent);
                }
            }
            for w in &turn.windows {
                if w.post_ms.is_none() && !w.tool_use_id.is_empty() {
                    let lookup = (turn.agent.clone(), w.tool_use_id.clone());
                    if let Some(refs) = self.open_windows.get_mut(&lookup) {
                        refs.retain(|wref| wref.turn_id != turn_id);
                        if refs.is_empty() {
                            self.open_windows.remove(&lookup);
                        }
                    }
                }
            }
            expired.push(turn);
        }
        expired
    }

    fn insert_open_turn(&mut self, turn: Turn) -> u64 {
        let turn_id = self.next_turn_id;
        self.next_turn_id += 1;
        let key = turn.agent.clone();
        self.turns.insert(turn_id, turn);
        self.open_by_agent.insert(key.clone(), turn_id);
        self.open_by_session
            .entry(key.session_id.clone())
            .or_default()
            .insert(key);
        turn_id
    }

    /// Closes an open turn as Unclosed if it started at or before `recv_ms`.
    /// Returns `false` when an existing open turn is newer than `recv_ms`.
    fn close_open_if_not_newer(
        &mut self,
        key: &AgentKey,
        recv_ms: u64,
        signals: &mut Vec<TrackerSignal>,
    ) -> bool {
        if let Some(&prev_id) = self.open_by_agent.get(key) {
            if self
                .turns
                .get(&prev_id)
                .is_some_and(|prev| recv_ms < prev.started_ms)
            {
                return false;
            }
            self.move_open_to_closed(key, prev_id, recv_ms, TurnEnd::Unclosed);
            signals.push(TrackerSignal::TurnClosed(key.clone()));
        }
        true
    }

    fn move_open_to_closed(
        &mut self,
        key: &AgentKey,
        turn_id: u64,
        ended_ms: u64,
        status: TurnEnd,
    ) {
        self.open_by_agent.remove(key);
        if let Some(agents) = self.open_by_session.get_mut(&key.session_id) {
            agents.remove(key);
            if agents.is_empty() {
                self.open_by_session.remove(&key.session_id);
            }
        }
        let Some(turn) = self.turns.get_mut(&turn_id) else {
            return;
        };
        turn.ended_ms = Some(ended_ms);
        turn.status = status;
        self.closed_by_agent
            .entry(key.clone())
            .or_default()
            .insert((turn.started_ms, turn_id), turn_id);
        self.expire_index.insert((ended_ms, turn_id));
    }

    fn open_turn_for(&self, key: &AgentKey, recv_ms: u64) -> Option<u64> {
        let &turn_id = self.open_by_agent.get(key)?;
        self.turns
            .get(&turn_id)
            .is_some_and(|turn| turn.started_ms <= recv_ms)
            .then_some(turn_id)
    }

    fn closed_turn_for(&self, key: &AgentKey, recv_ms: u64) -> Option<u64> {
        let &turn_id = self
            .closed_by_agent
            .get(key)?
            .range(..=(recv_ms, u64::MAX))
            .next_back()?
            .1;
        let turn = self.turns.get(&turn_id)?;
        within_revision_window(turn, recv_ms).then_some(turn_id)
    }

    #[allow(clippy::too_many_arguments)]
    fn handle_terminal(
        &mut self,
        key: AgentKey,
        recv_ms: u64,
        status: TurnEnd,
        transcript_path: Option<&String>,
        ev: &HookEvent,
        repo: &RepoInfo,
        signals: &mut Vec<TrackerSignal>,
    ) {
        let (turn_id, signal) = if let Some(open_id) = self.open_turn_for(&key, recv_ms) {
            self.move_open_to_closed(&key, open_id, recv_ms, status);
            (open_id, TrackerSignal::TurnClosed(key))
        } else if let Some(closed_id) = self.closed_turn_for(&key, recv_ms) {
            let Some(turn) = self.turns.get_mut(&closed_id) else {
                return;
            };
            if let Some(old_ended) = turn.ended_ms {
                self.expire_index.remove(&(old_ended, closed_id));
            }
            turn.ended_ms = Some(recv_ms);
            turn.status = status;
            self.expire_index.insert((recv_ms, closed_id));
            (closed_id, TrackerSignal::Late(key))
        } else {
            return;
        };

        if let Some(turn) = self.turns.get_mut(&turn_id) {
            if let Some(path) = transcript_path {
                turn.transcript_path = Some(path.clone());
            }
            fill_metadata(turn, ev, repo);
        }
        signals.push(signal);
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

fn fill_metadata(turn: &mut Turn, ev: &HookEvent, repo: &RepoInfo) {
    if turn.cwd.is_none() && ev.cwd.is_some() {
        turn.cwd = ev.cwd.clone();
    }
    if turn.repo.root.is_none() && repo.root.is_some() {
        turn.repo = repo.clone();
    }
}

/// Closes the window at `window_idx` and returns `Some(EditDone)` when it is an in-repo edit.
fn close_window_at(
    turn: &mut Turn,
    window_idx: usize,
    recv_ms: u64,
    ok: bool,
    ev: &HookEvent,
    repo: &RepoInfo,
) -> Option<TrackerSignal> {
    let window = turn.windows.get_mut(window_idx)?;
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

    if ok && kind == ToolKind::Edit {
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
    }
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

    #[test]
    fn delayed_stop_after_next_prompt_closes_earlier_turn() {
        let mut tracker = Tracker::new();
        let r = repo(Some("C:/repo"));

        tracker.on_event(&ev("UserPromptSubmit", "S1", None), 1_000, &r);
        tracker.on_prompt(PromptIn {
            session_id: "S1".into(),
            text: "first prompt".into(),
            truncated: false,
            recv_ms: 1_000,
        });
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
            1_200,
            &r,
        );
        tracker.on_event(
            &tool_ev(
                "PostToolUse",
                "S1",
                None,
                "Edit",
                "t1",
                Some("C:/repo/a.ts"),
                None,
            ),
            1_400,
            &r,
        );

        let next_sigs = tracker.on_event(&ev("UserPromptSubmit", "S1", None), 3_000, &r);
        assert_eq!(next_sigs, vec![TrackerSignal::TurnClosed(key("S1", ""))]);
        tracker.on_prompt(PromptIn {
            session_id: "S1".into(),
            text: "second prompt".into(),
            truncated: false,
            recv_ms: 3_000,
        });

        let mut delayed_stop = ev("Stop", "S1", None);
        delayed_stop.transcript_path = Some("C:/cfg/projects/repo/S1.jsonl".into());
        let late_sigs = tracker.on_event(&delayed_stop, 2_000, &r);
        assert_eq!(late_sigs, vec![TrackerSignal::Late(key("S1", ""))]);

        // Newer open turn remains open and untouched.
        let open = tracker
            .open_turn(&key("S1", ""))
            .expect("second turn still open");
        assert_eq!(open.started_ms, 3_000);
        assert_eq!(open.ended_ms, None);
        assert_eq!(open.status, TurnEnd::Open);
        assert_eq!(
            open.prompt.as_ref().map(|p| p.text.as_str()),
            Some("second prompt")
        );

        // Stray Stop earlier than any turn start is ignored while the turn is open.
        assert!(
            tracker
                .on_event(&ev("Stop", "S1", None), 500, &r)
                .is_empty()
        );
        assert!(tracker.open_turn(&key("S1", "")).is_some());

        // Close the second turn at 4_000 and verify expiration of Turn 1 uses revised ended_ms 2_000.
        assert_eq!(
            tracker.on_event(&ev("Stop", "S1", None), 4_000, &r),
            vec![TrackerSignal::TurnClosed(key("S1", ""))]
        );
        let expired_first = tracker.expire(2_000 + 60_000);
        assert_eq!(expired_first.len(), 1);
        assert_eq!(expired_first[0].started_ms, 1_000);
        assert_eq!(expired_first[0].ended_ms, Some(2_000));
        assert_eq!(expired_first[0].status, TurnEnd::Done);
        assert_eq!(
            expired_first[0].transcript_path.as_deref(),
            Some("C:/cfg/projects/repo/S1.jsonl")
        );
        assert_eq!(
            expired_first[0].prompt.as_ref().map(|p| p.text.as_str()),
            Some("first prompt")
        );

        let kept_second = tracker
            .closed_turn(&key("S1", ""))
            .expect("second turn retained");
        assert_eq!(kept_second.started_ms, 3_000);
        assert_eq!(kept_second.ended_ms, Some(4_000));
        assert_eq!(kept_second.status, TurnEnd::Done);

        assert_eq!(tracker.expire(4_000 + 60_000).len(), 1);
    }

    #[test]
    fn terminal_correction_after_session_end_revises_retained_turn() {
        let mut tracker = Tracker::new();
        let r = repo(Some("C:/repo"));

        tracker.on_event(&ev("UserPromptSubmit", "S1", None), 1_000, &r);
        let mut sub_start = ev("SubagentStart", "S1", Some("A1"));
        sub_start.agent_type = Some("Explore".into());
        tracker.on_event(&sub_start, 1_500, &r);

        let end_sigs = tracker.on_event(&ev("SessionEnd", "S1", None), 3_000, &r);
        assert_eq!(end_sigs.len(), 2);

        // Late Stop arriving after SessionEnd (within 60 s) updates status, end time, and transcript.
        let mut late_stop = ev("Stop", "S1", None);
        late_stop.transcript_path = Some("C:/cfg/projects/repo/S1.jsonl".into());
        let main_late = tracker.on_event(&late_stop, 3_500, &r);
        assert_eq!(main_late, vec![TrackerSignal::Late(key("S1", ""))]);

        let main_closed = tracker.closed_turn(&key("S1", "")).unwrap();
        assert_eq!(main_closed.status, TurnEnd::Done);
        assert_eq!(main_closed.ended_ms, Some(3_500));
        assert_eq!(
            main_closed.transcript_path.as_deref(),
            Some("C:/cfg/projects/repo/S1.jsonl")
        );

        // Delayed SubagentStop timestamped before SessionEnd revises the retained subagent turn too.
        let mut late_sub = ev("SubagentStop", "S1", Some("A1"));
        late_sub.agent_transcript_path =
            Some("C:/cfg/projects/repo/S1/subagents/agent-A1.jsonl".into());
        let sub_late = tracker.on_event(&late_sub, 2_500, &r);
        assert_eq!(sub_late, vec![TrackerSignal::Late(key("S1", "A1"))]);

        let sub_closed = tracker.closed_turn(&key("S1", "A1")).unwrap();
        assert_eq!(sub_closed.status, TurnEnd::Done);
        assert_eq!(sub_closed.ended_ms, Some(2_500));
        assert_eq!(
            sub_closed.transcript_path.as_deref(),
            Some("C:/cfg/projects/repo/S1/subagents/agent-A1.jsonl")
        );

        // StopFailure after SessionEnd revises status to Failed.
        tracker.on_event(&ev("UserPromptSubmit", "S2", None), 1_000, &r);
        tracker.on_event(&ev("SessionEnd", "S2", None), 3_000, &r);
        assert_eq!(
            tracker.on_event(&ev("StopFailure", "S2", None), 3_200, &r),
            vec![TrackerSignal::Late(key("S2", ""))]
        );
        let failed = tracker.closed_turn(&key("S2", "")).unwrap();
        assert_eq!(failed.status, TurnEnd::Failed);
        assert_eq!(failed.ended_ms, Some(3_200));

        // Expired terminal correction (>= 60 s after SessionEnd) is ignored.
        tracker.on_event(&ev("UserPromptSubmit", "S3", None), 1_000, &r);
        tracker.on_event(&ev("SessionEnd", "S3", None), 3_000, &r);
        let mut expired_stop = ev("Stop", "S3", None);
        expired_stop.transcript_path = Some("C:/cfg/projects/repo/S3.jsonl".into());
        assert!(
            tracker
                .on_event(&expired_stop, 3_000 + 60_000, &r)
                .is_empty()
        );
        let s3_closed = tracker.closed_turn(&key("S3", "")).unwrap();
        assert_eq!(s3_closed.status, TurnEnd::Unclosed);
        assert_eq!(s3_closed.ended_ms, Some(3_000));
        assert_eq!(s3_closed.transcript_path, None);
    }

    #[test]
    fn out_of_order_tool_completions_across_multiple_retained_turns() {
        let mut tracker = Tracker::new();
        let r = repo(Some("C:/repo"));

        // Populate unrelated sessions with both retained closed turns and open turns.
        for i in 0..20 {
            let sid = format!("OTHER_{i}");
            tracker.on_event(&ev("UserPromptSubmit", &sid, None), 500, &r);
            tracker.on_event(
                &tool_ev(
                    "PreToolUse",
                    &sid,
                    None,
                    "Read",
                    &format!("o_closed_{i}"),
                    Some("C:/repo/x.ts"),
                    None,
                ),
                600,
                &r,
            );
            tracker.on_event(&ev("Stop", &sid, None), 700, &r);
            tracker.on_event(&ev("UserPromptSubmit", &sid, None), 800, &r);
            tracker.on_event(
                &tool_ev(
                    "PreToolUse",
                    &sid,
                    None,
                    "Read",
                    &format!("o_open_{i}"),
                    Some("C:/repo/y.ts"),
                    None,
                ),
                900,
                &r,
            );
        }

        // S1 Turn 1 (1_000..2_000) with two unclosed windows t1, t2.
        tracker.on_event(&ev("UserPromptSubmit", "S1", None), 1_000, &r);
        tracker.on_event(
            &tool_ev(
                "PreToolUse",
                "S1",
                None,
                "Edit",
                "t1",
                Some("C:/repo/one.ts"),
                None,
            ),
            1_100,
            &r,
        );
        tracker.on_event(
            &tool_ev(
                "PreToolUse",
                "S1",
                None,
                "Bash",
                "t2",
                None,
                Some("cargo test"),
            ),
            1_200,
            &r,
        );
        tracker.on_event(&ev("Stop", "S1", None), 2_000, &r);

        // S1 Turn 2 (3_000..4_000) with unclosed window t3.
        tracker.on_event(&ev("UserPromptSubmit", "S1", None), 3_000, &r);
        tracker.on_event(
            &tool_ev(
                "PreToolUse",
                "S1",
                None,
                "Write",
                "t3",
                Some("C:/repo/two.ts"),
                None,
            ),
            3_100,
            &r,
        );
        tracker.on_event(&ev("Stop", "S1", None), 4_000, &r);

        // S1 Turn 3 (5_000..open) with window t4.
        tracker.on_event(&ev("UserPromptSubmit", "S1", None), 5_000, &r);
        tracker.on_event(
            &tool_ev(
                "PreToolUse",
                "S1",
                None,
                "Read",
                "t4",
                Some("C:/repo/three.ts"),
                None,
            ),
            5_100,
            &r,
        );

        // Delayed PreToolUse timestamped inside Turn 2 attaches to Turn 2, not open Turn 3.
        let late_pre = tracker.on_event(
            &tool_ev(
                "PreToolUse",
                "S1",
                None,
                "Edit",
                "t5",
                Some("C:/repo/four.ts"),
                None,
            ),
            3_200,
            &r,
        );
        assert_eq!(late_pre, vec![TrackerSignal::Late(key("S1", ""))]);

        // Out-of-order completions across Turn 2, Turn 1, and open Turn 3.
        assert_eq!(
            tracker.on_event(
                &tool_ev("PostToolUse", "S1", None, "Write", "t3", None, None),
                5_200,
                &r
            ),
            vec![
                TrackerSignal::Late(key("S1", "")),
                TrackerSignal::EditDone {
                    root: "C:/repo".into(),
                    post_ms: 5_200,
                },
            ]
        );
        assert_eq!(
            tracker.on_event(
                &tool_ev("PostToolUse", "S1", None, "Edit", "t5", None, None),
                5_250,
                &r
            ),
            vec![
                TrackerSignal::Late(key("S1", "")),
                TrackerSignal::EditDone {
                    root: "C:/repo".into(),
                    post_ms: 5_250,
                },
            ]
        );
        assert_eq!(
            tracker.on_event(
                &tool_ev("PostToolUseFailure", "S1", None, "Bash", "t2", None, None),
                5_300,
                &r
            ),
            vec![TrackerSignal::Late(key("S1", ""))]
        );
        assert_eq!(
            tracker.on_event(
                &tool_ev("PostToolUse", "S1", None, "Edit", "t1", None, None),
                5_400,
                &r
            ),
            vec![
                TrackerSignal::Late(key("S1", "")),
                TrackerSignal::EditDone {
                    root: "C:/repo".into(),
                    post_ms: 5_400,
                },
            ]
        );
        assert!(
            tracker
                .on_event(
                    &tool_ev("PostToolUse", "S1", None, "Read", "t4", None, None),
                    5_500,
                    &r
                )
                .is_empty()
        );

        let open_turn3 = tracker.open_turn(&key("S1", "")).unwrap();
        assert_eq!(open_turn3.windows.len(), 1);
        assert_eq!(open_turn3.windows[0].tool_use_id, "t4");
        assert_eq!(open_turn3.windows[0].post_ms, Some(5_500));

        let closed_turn2 = tracker.closed_turn(&key("S1", "")).unwrap();
        assert_eq!(closed_turn2.started_ms, 3_000);
        assert_eq!(closed_turn2.windows.len(), 2);
        assert_eq!(closed_turn2.windows[0].post_ms, Some(5_200));
        assert_eq!(closed_turn2.windows[1].post_ms, Some(5_250));

        // SessionEnd closes S1's open Turn 3 without affecting OTHER_* sessions.
        let end_sigs = tracker.on_event(&ev("SessionEnd", "S1", None), 6_000, &r);
        assert_eq!(end_sigs, vec![TrackerSignal::TurnClosed(key("S1", ""))]);
        assert!(tracker.open_turn(&key("S1", "")).is_none());
        assert!(tracker.open_turn(&key("OTHER_0", "")).is_some());

        // Turn 1 expires at 2_000 + 60_000 while Turn 2 (4_000) and Turn 3 (6_000) remain.
        // Note: OTHER_* turns closed at 700 also expire here; filter for S1 to verify Turn 1 fields.
        let expired = tracker.expire(2_000 + 60_000);
        let s1_expired: Vec<_> = expired
            .into_iter()
            .filter(|t| t.agent == key("S1", ""))
            .collect();
        assert_eq!(s1_expired.len(), 1);
        assert_eq!(s1_expired[0].started_ms, 1_000);
        assert_eq!(s1_expired[0].windows[0].tool_use_id, "t1");
        assert_eq!(s1_expired[0].windows[0].post_ms, Some(5_400));
        assert_eq!(s1_expired[0].windows[0].ok, Some(true));
        assert_eq!(s1_expired[0].windows[1].tool_use_id, "t2");
        assert_eq!(s1_expired[0].windows[1].post_ms, Some(5_300));
        assert_eq!(s1_expired[0].windows[1].ok, Some(false));

        // Unclosed window from an expired OTHER_* turn is cleaned from the index.
        assert!(
            tracker
                .on_event(
                    &tool_ev(
                        "PostToolUse",
                        "OTHER_0",
                        None,
                        "Read",
                        "o_closed_0",
                        None,
                        None
                    ),
                    2_000 + 60_001,
                    &r
                )
                .is_empty()
        );
    }
}
