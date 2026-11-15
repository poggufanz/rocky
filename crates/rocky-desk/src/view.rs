//! Pure view-model for rocky-desk: grouping, aggregate, tooltip, warnings.

use rocky_proto::pipe::{
    AgentKey, AgentStatus, Health, Outcome, ServerMsg, Status, StatusOp, TimelineEntry,
};
use rocky_proto::settings::Settings;
use std::collections::{BTreeMap, BTreeSet};

use crate::capture_lines::capture_lines;
use crate::i18n::{Msg, UiLang, tr};
use crate::setup_lines::setup_lines;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Conn {
    #[default]
    Connecting,
    Connected,
    Disconnected,
    VersionMismatch,
    ServerUnverified,
    TiedToJob,
    KeepsCrashing,
    Unresponsive,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoGroup {
    /// Repo name as recorded; empty when the daemon reported none.
    pub name: String,
    pub branch: Option<String>,
    /// Distinct repo roots the group's live agents reported, in first-seen order.
    pub roots: Vec<String>,
    pub sessions: Vec<SessionRow>,
}

impl RepoGroup {
    /// Header text: the repo name is never translated; only the missing-name
    /// placeholder and the branch suffix are composed here.
    pub fn label(&self, lang: UiLang) -> String {
        let name = if self.name.is_empty() {
            tr(lang, &Msg::UnknownRepo)
        } else {
            self.name.clone()
        };
        match &self.branch {
            Some(b) if !b.is_empty() => format!("{name} @ {b}"),
            _ => name,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionRow {
    pub session_short: String,
    /// Main row first, then children by `agent_id` when the tree is on.
    pub rows: Vec<AgentRow>,
    /// Children the tree setting hides, with a count of the working ones.
    pub hidden_children: Option<Msg>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentRow {
    pub key: AgentKey,
    /// True for a row under a main agent.
    pub child: bool,
    /// Catalog label: the main agent is translated, subagent names are not.
    pub label: Msg,
    pub description: Option<String>,
    pub status: Status,
    pub action_text: Option<String>,
    pub age: Msg,
    pub failures: u32,
    /// Main-row detail for the session's remaining activity.
    pub note: Option<Msg>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TimelineRow {
    pub time: String,
    pub text: Msg,
    pub outcome: Option<Outcome>,
}

#[derive(Debug, Default)]
pub struct Model {
    agents: BTreeMap<AgentKey, AgentStatus>,
    health: Health,
    conn: Conn,
    settings: Option<Settings>,
    /// Agent rows whose timeline is expanded, and the entries last received.
    open: BTreeSet<AgentKey>,
    timelines: BTreeMap<AgentKey, Vec<TimelineEntry>>,
    /// Ids of `set` messages awaiting their ack.
    sent: BTreeSet<u64>,
    /// Error from the last failed `set`, shown until the next settings broadcast.
    set_error: Option<String>,
}

/// Agents bucketed by `(repo name, branch)`, then by session id.
type GroupMap<'a> = BTreeMap<(String, Option<String>), BTreeMap<String, Vec<&'a AgentStatus>>>;

impl Model {
    pub fn new() -> Self {
        Self::default()
    }

    /// Applies one daemon message and returns the timeline keys to (re)request.
    ///
    /// Keys come back for an upsert of an open row, for every open row on a
    /// settings broadcast, and for every open row a snapshot still carries.
    /// Rows that disappear close on the spot and are not requested again.
    pub fn apply(&mut self, msg: ServerMsg) -> Vec<AgentKey> {
        match msg {
            ServerMsg::Snapshot {
                agents,
                health,
                settings,
                ..
            } => {
                self.agents = agents.into_iter().map(|a| (a.key.clone(), a)).collect();
                self.health = health;
                self.settings = Some(settings);
                self.open.retain(|k| self.agents.contains_key(k));
                self.retain_timelines();
                self.open.iter().cloned().collect()
            }
            ServerMsg::Settings { settings } => {
                self.settings = Some(settings);
                self.set_error = None;
                self.open.iter().cloned().collect()
            }
            ServerMsg::Ack { id, ok, error, .. } => {
                if self.sent.remove(&id) && !ok {
                    self.set_error = Some(error.unwrap_or_default());
                }
                Vec::new()
            }
            ServerMsg::Status { op, agent } => match op {
                StatusOp::Upsert => {
                    let key = agent.key.clone();
                    self.agents.insert(key.clone(), agent);
                    self.retain_timelines();
                    if self.open.contains(&key) {
                        vec![key]
                    } else {
                        Vec::new()
                    }
                }
                StatusOp::Remove => {
                    self.agents.remove(&agent.key);
                    self.close(&agent.key);
                    self.retain_timelines();
                    Vec::new()
                }
            },
            ServerMsg::Timeline { key, entries, .. } => {
                if self.accepts_timeline(&key) {
                    self.timelines.insert(key, entries);
                }
                Vec::new()
            }
            ServerMsg::Health { health } => {
                self.health = health;
                Vec::new()
            }
            ServerMsg::Error { code } if code == "version" => {
                self.conn = Conn::VersionMismatch;
                Vec::new()
            }
            ServerMsg::Cards { .. }
            | ServerMsg::Card { .. }
            | ServerMsg::CardDetail { .. }
            | ServerMsg::BlockDiff { .. } => Vec::new(),
            _ => Vec::new(),
        }
    }

    /// Expands an agent row and returns the key when it opened; collapsing
    /// drops the stored entries and returns `None`.
    pub fn toggle_open(&mut self, key: &AgentKey) -> Option<AgentKey> {
        if self.open.remove(key) {
            if !self.active_primary_keys().contains(key) {
                self.timelines.remove(key);
            }
            None
        } else {
            self.open.insert(key.clone());
            Some(key.clone())
        }
    }

    pub fn is_open(&self, key: &AgentKey) -> bool {
        self.open.contains(key)
    }

    /// Entries of an open timeline in daemon order; empty while closed.
    pub fn timeline_rows(
        &self,
        key: &AgentKey,
        fmt_time: &dyn Fn(u64) -> String,
    ) -> Vec<TimelineRow> {
        if !self.open.contains(key) {
            return Vec::new();
        }
        self.timelines
            .get(key)
            .map(|entries| {
                entries
                    .iter()
                    .map(|e| TimelineRow {
                        time: fmt_time(e.ms),
                        text: Msg::TimelineEntry {
                            kind: e.kind,
                            tool: e.tool_name.clone(),
                            text: e.text.clone(),
                        },
                        outcome: e.outcome,
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    fn close(&mut self, key: &AgentKey) {
        self.open.remove(key);
        self.timelines.remove(key);
    }

    pub fn set_conn(&mut self, c: Conn) {
        self.conn = c;
    }

    /// The daemon's last health report.
    pub fn health(&self) -> &Health {
        &self.health
    }

    pub fn settings(&self) -> Option<&Settings> {
        self.settings.as_ref()
    }

    /// Record a `set` id so its failed ack can be attributed.
    pub fn set_sent(&mut self, id: u64) {
        self.sent.insert(id);
    }

    /// Error from the last failed `set`, cleared by the next settings broadcast.
    pub fn set_error(&self) -> Option<&str> {
        self.set_error.as_deref()
    }

    /// Settings accept changes only while connected and seeded.
    pub fn editable(&self) -> bool {
        self.conn == Conn::Connected && self.settings.is_some()
    }

    pub fn agents(&self) -> &BTreeMap<AgentKey, AgentStatus> {
        &self.agents
    }

    pub(crate) fn timeline(&self, key: &AgentKey) -> Option<&[TimelineEntry]> {
        self.timelines.get(key).map(Vec::as_slice)
    }

    fn retain_timelines(&mut self) {
        let active = self.active_primary_keys();
        self.timelines.retain(|k, _| {
            active.contains(k)
                || (self.open.contains(k)
                    && self
                        .agents
                        .get(k)
                        .is_none_or(|a| is_active_status(a.status)))
        });
    }

    fn accepts_timeline(&self, key: &AgentKey) -> bool {
        if self.active_primary_keys().contains(key) {
            return true;
        }
        self.open.contains(key)
            && self
                .agents
                .get(key)
                .is_none_or(|a| is_active_status(a.status))
    }

    pub(crate) fn subagent_tree_enabled(&self) -> bool {
        self.settings.as_ref().is_none_or(|s| s.subagent_tree)
    }

    pub(crate) fn active_primary_keys(&self) -> BTreeSet<AgentKey> {
        let mut by_session: BTreeMap<&str, &AgentKey> = BTreeMap::new();
        for k in self.agents.keys() {
            by_session
                .entry(k.session_id.as_str())
                .and_modify(|best| {
                    if (!k.agent_id.is_empty(), &k.agent_id)
                        < (!best.agent_id.is_empty(), &best.agent_id)
                    {
                        *best = k;
                    }
                })
                .or_insert(k);
        }
        by_session
            .into_values()
            .filter(|k| {
                self.agents
                    .get(*k)
                    .is_some_and(|a| is_active_status(a.status))
            })
            .cloned()
            .collect()
    }

    pub fn groups(&self, now_ms: u64) -> Vec<RepoGroup> {
        let mut by_group: GroupMap<'_> = BTreeMap::new();
        for a in self.agents.values() {
            if a.status == Status::Ended {
                continue;
            }
            by_group
                .entry((
                    a.repo.name.clone(),
                    a.repo.branch.clone().filter(|b| !b.is_empty()),
                ))
                .or_default()
                .entry(a.key.session_id.clone())
                .or_default()
                .push(a);
        }
        let tree = self.settings.as_ref().is_none_or(|s| s.subagent_tree);
        by_group
            .into_iter()
            .map(|((name, branch), sessions)| RepoGroup {
                name,
                branch,
                roots: distinct_roots(&sessions),
                sessions: sessions
                    .into_iter()
                    .map(|(session_id, mut agents)| {
                        agents.sort_by(|a, b| {
                            (!a.key.agent_id.is_empty(), &a.key.agent_id)
                                .cmp(&(!b.key.agent_id.is_empty(), &b.key.agent_id))
                        });
                        let children: Vec<&AgentStatus> = agents
                            .iter()
                            .copied()
                            .filter(|a| !a.key.agent_id.is_empty())
                            .collect();
                        let working_children = children
                            .iter()
                            .filter(|a| a.status == Status::Working)
                            .count() as u64;
                        let note = agents
                            .iter()
                            .find(|a| a.key.agent_id.is_empty())
                            .filter(|a| a.status == Status::Done)
                            .and_then(|_| {
                                (working_children > 0).then_some(Msg::SubagentsStillWorking {
                                    n: working_children,
                                })
                            });
                        let hidden_children = if tree || children.is_empty() {
                            None
                        } else {
                            Some(Msg::SubagentsHidden {
                                n: children.len() as u64,
                                working: working_children,
                            })
                        };
                        SessionRow {
                            session_short: short8(&session_id),
                            rows: agents
                                .iter()
                                .filter(|a| tree || a.key.agent_id.is_empty())
                                .map(|a| AgentRow {
                                    key: a.key.clone(),
                                    child: !a.key.agent_id.is_empty(),
                                    label: agent_label(a),
                                    description: a.description.clone(),
                                    status: a.status,
                                    action_text: a
                                        .action
                                        .as_ref()
                                        .map(|act| action_text(act, a.repo.root.as_deref())),
                                    age: Msg::Age {
                                        secs: age_secs(now_ms, a.last_event_ms),
                                    },
                                    failures: a.failures,
                                    note: if a.key.agent_id.is_empty() {
                                        note.clone()
                                    } else {
                                        None
                                    },
                                })
                                .collect(),
                            hidden_children,
                        }
                    })
                    .collect(),
            })
            .collect()
    }

    pub fn aggregate(&self) -> Status {
        self.agents
            .values()
            .filter(|a| a.status != Status::Ended)
            .map(|a| a.status)
            .max_by_key(|s| priority(*s))
            .unwrap_or(Status::Idle)
    }

    pub fn tooltip(&self) -> Msg {
        let mut n = [0u64; 5];
        for a in self.agents.values() {
            if a.status == Status::Ended {
                continue;
            }
            match a.status {
                Status::Working => n[0] += 1,
                Status::NeedsYou => n[1] += 1,
                Status::Failed => n[2] += 1,
                Status::Done => n[3] += 1,
                Status::Idle => n[4] += 1,
                Status::Ended => {}
            }
        }
        Msg::Tooltip {
            working: n[0],
            needs_you: n[1],
            failed: n[2],
            done: n[3],
            idle: n[4],
        }
    }

    /// Health and connection lines in display order. Gap timestamps go through
    /// `fmt_time` so tests can inject UTC and the desk can show local time.
    pub fn warnings(&self, fmt_time: &dyn Fn(u64) -> String) -> Vec<Msg> {
        let mut w = Vec::new();
        let h = &self.health;
        if h.spool_pending > 0 {
            w.push(Msg::SpoolPending { n: h.spool_pending });
        }
        if h.spool_dropped > 0 {
            w.push(Msg::SpoolDropped { n: h.spool_dropped });
        }
        if h.dropped_events > 0 {
            w.push(Msg::DroppedEvents {
                n: h.dropped_events,
            });
        }
        if h.bad_files > 0 {
            w.push(Msg::BadFiles { n: h.bad_files });
        }
        if h.late_events > 0 {
            w.push(Msg::LateEvents { n: h.late_events });
        }
        if h.hook_newer_than_daemon {
            w.push(Msg::HookNewer);
        }
        if h.settings_unreadable {
            w.push(Msg::SettingsUnreadable);
        }
        w.extend(setup_lines(&h.setup));
        w.extend(capture_lines(&h.capture));
        let mut gaps: Vec<_> = h.gaps.iter().collect();
        gaps.sort_by_key(|g| std::cmp::Reverse(g.to_ms));
        for gap in gaps.iter().take(GAP_LINES) {
            w.push(Msg::Gap {
                count: gap.count,
                from: fmt_time(gap.from_ms),
                to: fmt_time(gap.to_ms),
                reason: gap.reason,
            });
        }
        if gaps.len() > GAP_LINES {
            w.push(Msg::EarlierGaps {
                n: (gaps.len() - GAP_LINES) as u64,
            });
        }
        match self.conn {
            Conn::VersionMismatch => w.push(Msg::ConnVersionMismatch),
            Conn::ServerUnverified => w.push(Msg::ConnUnverified),
            Conn::Disconnected => w.push(Msg::ConnDisconnected),
            Conn::TiedToJob => w.push(Msg::ConnTiedToJob),
            Conn::KeepsCrashing => w.push(Msg::ConnKeepsCrashing),
            Conn::Unresponsive => w.push(Msg::ConnUnresponsive),
            Conn::Connecting | Conn::Connected => {}
        }
        w
    }
}

/// Gap lines the strip shows before the "earlier gaps" summary.
const GAP_LINES: usize = 5;

fn priority(s: Status) -> u8 {
    match s {
        Status::NeedsYou => 5,
        Status::Failed => 4,
        Status::Working => 3,
        Status::Done => 2,
        Status::Idle => 1,
        Status::Ended => 0,
    }
}

/// Distinct non-empty repo roots across a group's agents, first-seen order.
fn distinct_roots(sessions: &BTreeMap<String, Vec<&AgentStatus>>) -> Vec<String> {
    let mut roots: Vec<String> = Vec::new();
    for root in sessions
        .values()
        .flatten()
        .filter_map(|a| a.repo.root.as_deref())
        .filter(|r| !r.is_empty())
    {
        if !roots.iter().any(|seen| seen == root) {
            roots.push(root.to_string());
        }
    }
    roots
}

/// First 8 chars, char-safe.
pub(crate) fn is_active_status(status: Status) -> bool {
    matches!(status, Status::NeedsYou | Status::Working)
}

pub(crate) fn short8(s: &str) -> String {
    s.chars().take(8).collect()
}

pub(crate) fn agent_label(a: &AgentStatus) -> Msg {
    if a.key.agent_id.is_empty() {
        return Msg::MainAgent;
    }
    Msg::AgentName {
        label: match a.agent_type.as_deref() {
            Some(t) if !t.is_empty() => format!("{} {}", t, short8(&a.key.agent_id)),
            _ => short8(&a.key.agent_id),
        },
    }
}

pub(crate) fn age_secs(now_ms: u64, last_ms: u64) -> u64 {
    now_ms.saturating_sub(last_ms) / 1000
}

fn action_target_raw(a: &rocky_proto::pipe::Action, repo_root: Option<&str>) -> Option<String> {
    if let Some(command) = a.command.as_deref() {
        return Some(command.to_string());
    }
    let path = a.target_path.as_deref()?.replace('\\', "/");
    let rel = match repo_root {
        Some(root) => {
            let root = root.replace('\\', "/");
            let root = root.trim_end_matches('/');
            // ponytail: empty root can't prefix-match; fall through to full path
            if !root.is_empty()
                && path.len() > root.len()
                && path.as_bytes()[..root.len()].eq_ignore_ascii_case(root.as_bytes())
                && path.as_bytes()[root.len()] == b'/'
            {
                &path[root.len() + 1..]
            } else {
                &path
            }
        }
        None => &path,
    };
    Some(rel.to_string())
}

fn truncate_80(text: String) -> String {
    if text.chars().count() <= 80 {
        text
    } else {
        let head: String = text.chars().take(79).collect();
        format!("{head}…")
    }
}

pub(crate) fn action_target(
    a: &rocky_proto::pipe::Action,
    repo_root: Option<&str>,
) -> Option<String> {
    let raw = action_target_raw(a, repo_root)?;
    let clean = crate::cards_model::sanitize_single_line(&raw)
        .trim()
        .to_string();
    if clean.is_empty() {
        None
    } else {
        Some(truncate_80(clean))
    }
}

pub fn action_text(a: &rocky_proto::pipe::Action, repo_root: Option<&str>) -> String {
    let text = match action_target_raw(a, repo_root) {
        Some(target) => format!("{} {target}", a.tool_name),
        None => a.tool_name.clone(),
    };
    truncate_80(text)
}

#[cfg(test)]
mod tests;
