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
                self.timelines.retain(|k, _| self.open.contains(k));
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
                    if self.open.contains(&key) {
                        vec![key]
                    } else {
                        Vec::new()
                    }
                }
                StatusOp::Remove => {
                    self.agents.remove(&agent.key);
                    self.close(&agent.key);
                    Vec::new()
                }
            },
            ServerMsg::Timeline { key, entries, .. } => {
                if self.open.contains(&key) {
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
            self.timelines.remove(key);
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
fn short8(s: &str) -> String {
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

fn age_secs(now_ms: u64, last_ms: u64) -> u64 {
    now_ms.saturating_sub(last_ms) / 1000
}

pub fn action_text(a: &rocky_proto::pipe::Action, repo_root: Option<&str>) -> String {
    let text = if let Some(command) = a.command.as_deref() {
        format!("{} {command}", a.tool_name)
    } else if let Some(path) = a.target_path.as_deref() {
        let path = path.replace('\\', "/");
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
        format!("{} {rel}", a.tool_name)
    } else {
        a.tool_name.clone()
    };
    if text.chars().count() <= 80 {
        text
    } else {
        let head: String = text.chars().take(79).collect();
        format!("{head}…")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::i18n::{Msg, UiLang, en, id};
    use rocky_proto::pipe::{
        Action, AgentKey, AgentStatus, Gap, GapReason, Health, Outcome, RepoInfo, ServerMsg,
        Status, TimelineEntry, TimelineKind,
    };
    use rocky_proto::settings::Settings;

    fn agent(session: &str, agent_id: &str, status: Status) -> AgentStatus {
        AgentStatus {
            key: AgentKey {
                session_id: session.into(),
                agent_id: agent_id.into(),
            },
            agent_type: if agent_id.is_empty() {
                None
            } else {
                Some("Explore".into())
            },
            status,
            action: None,
            summary: None,
            description: None,
            failures: 0,
            last_event_ms: 1_000,
            quiet_10m: false,
            repo: RepoInfo {
                root: Some("C:/r".into()),
                main_root: None,
                name: "r".into(),
                branch: Some("main".into()),
            },
        }
    }

    fn snapshot(agents: Vec<AgentStatus>) -> ServerMsg {
        ServerMsg::Snapshot {
            agents,
            aggregate: Status::Idle,
            health: Health::default(),
            settings: Settings::default(),
            repo_pending: Vec::new(),
        }
    }

    #[test]
    fn unknown_repo_label_is_translated() {
        assert_eq!(en(&Msg::UnknownRepo), "unknown repo");
        let mut a = agent("S1", "", Status::Idle);
        a.repo.name = String::new();
        a.repo.branch = Some("main".into());
        let mut m = Model::new();
        m.apply(snapshot(vec![a]));
        let groups = m.groups(2_000);
        assert_eq!(groups[0].name, "");
        assert_eq!(groups[0].label(UiLang::En), "unknown repo @ main");
        assert_eq!(groups[0].label(UiLang::Id), "repo tidak dikenal @ main");
    }

    #[test]
    fn two_sessions_same_repo_are_separate_rows() {
        let mut m = Model::new();
        m.apply(snapshot(vec![
            agent("S1", "", Status::Working),
            agent("S2", "", Status::Idle),
        ]));
        let groups = m.groups(2_000);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].name, "r");
        assert_eq!(groups[0].branch.as_deref(), Some("main"));
        assert_eq!(groups[0].label(UiLang::En), "r @ main");
        assert_eq!(groups[0].sessions.len(), 2);
        assert_ne!(
            groups[0].sessions[0].session_short,
            groups[0].sessions[1].session_short
        );
    }

    #[test]
    fn main_agent_first_then_subagents() {
        let mut m = Model::new();
        m.apply(snapshot(vec![
            agent("S1", "bbbbbbbb-2", Status::Working),
            agent("S1", "aaaaaaaa-1", Status::Working),
            agent("S1", "", Status::Working),
        ]));
        let groups = m.groups(2_000);
        assert_eq!(groups.len(), 1);
        let rows = &groups[0].sessions[0].rows;
        assert_eq!(rows.len(), 3);
        assert_eq!(tr(UiLang::En, &rows[0].label), "main");
        assert_eq!(tr(UiLang::Id, &rows[0].label), "utama");
        assert_eq!(tr(UiLang::En, &rows[1].label), "Explore aaaaaaaa");
        assert_eq!(tr(UiLang::En, &rows[2].label), "Explore bbbbbbbb");
    }

    #[test]
    fn ended_agents_hidden() {
        let mut m = Model::new();
        m.apply(snapshot(vec![agent("S1", "", Status::Ended)]));
        assert!(m.groups(2_000).is_empty());
        let mut m = Model::new();
        m.apply(snapshot(vec![
            agent("S1", "", Status::Working),
            agent("S1", "aaaaaaaa-1", Status::Ended),
        ]));
        let groups = m.groups(2_000);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].sessions.len(), 1);
        assert_eq!(groups[0].sessions[0].rows.len(), 1);
        assert_eq!(tr(UiLang::En, &groups[0].sessions[0].rows[0].label), "main");
    }

    #[test]
    fn tooltip_counts() {
        let m = Model::new();
        assert_eq!(
            m.tooltip(),
            Msg::Tooltip {
                working: 0,
                needs_you: 0,
                failed: 0,
                done: 0,
                idle: 0
            }
        );
        assert_eq!(en(&m.tooltip()), "rocky: idle");
        let mut m = Model::new();
        m.apply(snapshot(vec![
            agent("S1", "", Status::Working),
            agent("S2", "", Status::Working),
            agent("S3", "", Status::NeedsYou),
        ]));
        assert_eq!(
            m.tooltip(),
            Msg::Tooltip {
                working: 2,
                needs_you: 1,
                failed: 0,
                done: 0,
                idle: 0
            }
        );
        assert_eq!(en(&m.tooltip()), "rocky: 2 working, 1 needs you");
    }

    #[test]
    fn action_text_relative_and_capped() {
        let a = Action {
            tool_name: "Edit".into(),
            target_path: Some("C:/r/src/core/memory.ts".into()),
            tool_use_id: None,
            command: None,
        };
        assert_eq!(action_text(&a, Some("C:/r")), "Edit src/core/memory.ts");
        // path panjang → len chars == 80 dan diakhiri '…'
        let long = Action {
            tool_name: "Edit".into(),
            target_path: Some(format!("C:/r/{}", "x".repeat(200))),
            tool_use_id: None,
            command: None,
        };
        let t = action_text(&long, Some("C:/r"));
        assert_eq!(t.chars().count(), 80);
        assert!(t.ends_with('…'));
        // backslash + root beda case → relatif, pakai '/'
        let win = Action {
            tool_name: "Read".into(),
            target_path: Some("C:\\r\\src\\a.ts".into()),
            tool_use_id: None,
            command: None,
        };
        assert_eq!(action_text(&win, Some("c:/R")), "Read src/a.ts");
        // tanpa target → nama tool saja
        let bare = Action {
            tool_name: "Bash".into(),
            target_path: None,
            tool_use_id: None,
            command: None,
        };
        assert_eq!(action_text(&bare, Some("C:/r")), "Bash");
    }

    #[test]
    fn status_remove_deletes_row() {
        let mut m = Model::new();
        m.apply(snapshot(vec![agent("S1", "", Status::Working)]));
        assert_eq!(m.groups(2_000).len(), 1);
        m.apply(ServerMsg::Status {
            op: StatusOp::Remove,
            agent: agent("S1", "", Status::Working),
        });
        assert!(m.groups(2_000).is_empty());
    }

    #[test]
    fn warnings_cover_health_and_conn() {
        let m = Model::new();
        assert!(m.warnings(&crate::clock::utc_hhmm).is_empty());
        let mut m = Model::new();
        m.apply(ServerMsg::Health {
            health: Health {
                bad_files: 2,
                dropped_events: 1,
                spool_dropped: 1,
                late_events: 1,
                hook_newer_than_daemon: true,
                ..Default::default()
            },
        });
        m.set_conn(Conn::VersionMismatch);
        let w = m.warnings(&crate::clock::utc_hhmm);
        assert_eq!(
            w,
            vec![
                Msg::SpoolDropped { n: 1 },
                Msg::DroppedEvents { n: 1 },
                Msg::BadFiles { n: 2 },
                Msg::LateEvents { n: 1 },
                Msg::HookNewer,
                Msg::ConnVersionMismatch,
            ]
        );
        assert_eq!(en(&w[0]), "1 spool files dropped.");
        assert_eq!(en(&w[1]), "1 dropped events.");
        assert_eq!(en(&w[2]), "2 bad spool files.");
        assert_eq!(en(&w[3]), "1 late events.");
        assert_eq!(en(&w[4]), "hook is newer than daemon, needs update.");
        assert_eq!(en(&w[5]), "daemon version mismatch, needs update.");
        let mut m = Model::new();
        m.set_conn(Conn::TiedToJob);
        assert_eq!(
            m.warnings(&crate::clock::utc_hhmm),
            vec![Msg::ConnTiedToJob]
        );
        assert_eq!(en(&Msg::ConnTiedToJob), "daemon tied to launcher job.");
        m.set_conn(Conn::KeepsCrashing);
        assert_eq!(
            m.warnings(&crate::clock::utc_hhmm),
            vec![Msg::ConnKeepsCrashing]
        );
        assert_eq!(en(&Msg::ConnKeepsCrashing), "daemon keeps crashing.");
        m.set_conn(Conn::ServerUnverified);
        assert_eq!(
            m.warnings(&crate::clock::utc_hhmm),
            vec![Msg::ConnUnverified]
        );
        assert_eq!(en(&Msg::ConnUnverified), "daemon could not be verified.");
        m.set_conn(Conn::Disconnected);
        assert_eq!(
            m.warnings(&crate::clock::utc_hhmm),
            vec![Msg::ConnDisconnected]
        );
        assert_eq!(en(&Msg::ConnDisconnected), "daemon disconnected.");
        m.set_conn(Conn::Connected);
        assert!(m.warnings(&crate::clock::utc_hhmm).is_empty());
    }

    #[test]
    fn aggregate_priority_ignores_snapshot() {
        let mut m = Model::new();
        assert_eq!(m.aggregate(), Status::Idle);
        // snapshot mengklaim Idle tapi agen Working → hitung lokal
        m.apply(snapshot(vec![agent("S1", "", Status::Working)]));
        assert_eq!(m.aggregate(), Status::Working);
        m.apply(ServerMsg::Status {
            op: StatusOp::Upsert,
            agent: agent("S2", "", Status::Failed),
        });
        assert_eq!(m.aggregate(), Status::Failed);
        m.apply(ServerMsg::Status {
            op: StatusOp::Upsert,
            agent: agent("S3", "", Status::NeedsYou),
        });
        assert_eq!(m.aggregate(), Status::NeedsYou);
    }

    #[test]
    fn age_boundaries() {
        let mut live = agent("S1", "", Status::Working);
        live.last_event_ms = 130_000;
        let mut old = agent("S2", "", Status::Idle);
        old.last_event_ms = 10_000;
        let mut m = Model::new();
        m.apply(snapshot(vec![live, old]));
        let groups = m.groups(130_000);
        let live_age = &groups[0].sessions[0].rows[0].age;
        assert_eq!(*live_age, Msg::Age { secs: 0 });
        assert_eq!(en(live_age), "now");
        let old_age = &groups[0].sessions[1].rows[0].age;
        assert_eq!(*old_age, Msg::Age { secs: 120 });
        assert_eq!(en(old_age), "2m");
    }

    #[test]
    fn child_rows_follow_main_with_description() {
        let mut child = agent("S1", "aaaaaaaa-1", Status::Working);
        child.description = Some("Review the diff".into());
        let mut m = Model::new();
        m.apply(snapshot(vec![child, agent("S1", "", Status::Working)]));
        let rows = &m.groups(2_000)[0].sessions[0].rows;
        assert_eq!(
            (rows[0].child, tr(UiLang::En, &rows[0].label).as_str()),
            (false, "main")
        );
        assert_eq!(
            (rows[1].child, tr(UiLang::En, &rows[1].label).as_str()),
            (true, "Explore aaaaaaaa")
        );
        assert_eq!(rows[1].description.as_deref(), Some("Review the diff"));
    }

    #[test]
    fn main_done_with_working_children_says_still_working() {
        let mut m = Model::new();
        m.apply(snapshot(vec![
            agent("S1", "", Status::Done),
            agent("S1", "aaaaaaaa-1", Status::Working),
            agent("S1", "bbbbbbbb-2", Status::Working),
            agent("S1", "cccccccc-3", Status::Done),
        ]));
        let rows = &m.groups(2_000)[0].sessions[0].rows;
        assert_eq!(
            rows[0].note.as_ref(),
            Some(&Msg::SubagentsStillWorking { n: 2 })
        );
        assert_eq!(
            en(&Msg::SubagentsStillWorking { n: 2 }),
            "2 subagents still working"
        );
        for row in &rows[1..] {
            assert_eq!(row.note, None);
        }
    }

    #[test]
    fn tree_off_hides_children_and_counts_them() {
        let mut m = Model::new();
        m.apply(ServerMsg::Snapshot {
            agents: vec![
                agent("S1", "", Status::Working),
                agent("S1", "aaaaaaaa-1", Status::NeedsYou),
                agent("S1", "bbbbbbbb-2", Status::Working),
                agent("S1", "cccccccc-3", Status::Done),
            ],
            aggregate: Status::Idle,
            health: Health::default(),
            repo_pending: Vec::new(),
            settings: Settings {
                subagent_tree: false,
                ..Settings::default()
            },
        });
        let session = &m.groups(2_000)[0].sessions[0];
        assert_eq!(session.rows.len(), 1);
        assert_eq!(
            session.hidden_children.as_ref(),
            Some(&Msg::SubagentsHidden { n: 3, working: 1 })
        );
        assert_eq!(
            en(&Msg::SubagentsHidden { n: 3, working: 1 }),
            "+3 subagents (1 working)"
        );
        assert_eq!(m.aggregate(), Status::NeedsYou);
    }

    #[test]
    fn bash_command_wins_over_path_and_is_capped() {
        let bash = Action {
            tool_name: "Bash".into(),
            command: Some("npm test".into()),
            target_path: Some("C:/r/x".into()),
            tool_use_id: None,
        };
        assert_eq!(action_text(&bash, Some("C:/r")), "Bash npm test");
        let long = Action {
            tool_name: "Bash".into(),
            command: Some("x".repeat(200)),
            target_path: None,
            tool_use_id: None,
        };
        let t = action_text(&long, Some("C:/r"));
        assert_eq!(t.chars().count(), 80);
        assert!(t.ends_with('…'));
    }

    #[test]
    fn gap_lines_use_formatter_and_are_bounded() {
        let mut gaps = Vec::new();
        for i in 0..6 {
            gaps.push(Gap {
                from_ms: 1_000_000 + i * 60_000,
                to_ms: 1_060_000 + i * 60_000,
                count: 1,
                reason: GapReason::HistoryFull,
            });
        }
        gaps.push(Gap {
            from_ms: 50_520_000,
            to_ms: 50_700_000,
            count: 3,
            reason: GapReason::SpoolFull,
        });
        let mut m = Model::new();
        m.apply(ServerMsg::Health {
            health: Health {
                gaps,
                ..Health::default()
            },
        });
        let w = m.warnings(&crate::clock::utc_hhmm);
        assert_eq!(w.len(), 6);
        assert_eq!(
            w[0],
            Msg::Gap {
                count: 3,
                from: "14:02".into(),
                to: "14:05".into(),
                reason: GapReason::SpoolFull,
            }
        );
        assert_eq!(
            w[..5]
                .iter()
                .filter(|m| matches!(m, Msg::Gap { .. }))
                .count(),
            5
        );
        assert_eq!(w[5], Msg::EarlierGaps { n: 2 });
        assert_eq!(
            en(&w[0]),
            "Missed 3 events between 14:02 and 14:05 (spool full)"
        );
        assert_eq!(
            en(&Msg::Gap {
                count: 1,
                from: "14:02".into(),
                to: "14:02".into(),
                reason: GapReason::BadFile,
            }),
            "Missed 1 event at 14:02 (bad file)"
        );
    }

    #[test]
    fn every_nonzero_counter_has_a_sentence() {
        let mut m = Model::new();
        m.apply(ServerMsg::Health {
            health: Health {
                spool_pending: 1,
                spool_dropped: 1,
                dropped_events: 1,
                bad_files: 1,
                late_events: 1,
                hook_newer_than_daemon: true,
                settings_unreadable: true,
                ..Health::default()
            },
        });
        assert_eq!(
            m.warnings(&crate::clock::utc_hhmm),
            vec![
                Msg::SpoolPending { n: 1 },
                Msg::SpoolDropped { n: 1 },
                Msg::DroppedEvents { n: 1 },
                Msg::BadFiles { n: 1 },
                Msg::LateEvents { n: 1 },
                Msg::HookNewer,
                Msg::SettingsUnreadable,
            ]
        );
    }

    fn key(session: &str, agent_id: &str) -> AgentKey {
        AgentKey {
            session_id: session.into(),
            agent_id: agent_id.into(),
        }
    }

    fn timeline_msg(key: AgentKey, entries: Vec<TimelineEntry>) -> ServerMsg {
        ServerMsg::Timeline {
            id: 7,
            key,
            entries,
        }
    }

    fn entry(
        ms: u64,
        kind: TimelineKind,
        tool: Option<&str>,
        text: Option<&str>,
        outcome: Option<Outcome>,
    ) -> TimelineEntry {
        TimelineEntry {
            ms,
            kind,
            tool_name: tool.map(str::to_string),
            text: text.map(str::to_string),
            outcome,
        }
    }

    #[test]
    fn opening_a_row_requests_its_timeline() {
        let mut m = Model::new();
        let a = key("S1", "");
        assert_eq!(m.toggle_open(&a), Some(a.clone()));
        assert!(m.is_open(&a));
        assert_eq!(m.toggle_open(&a), None);
        assert!(!m.is_open(&a));
    }

    #[test]
    fn upsert_for_open_key_rerequests() {
        let a = key("S1", "");
        let b = key("S2", "");
        let mut m = Model::new();
        m.toggle_open(&a);
        assert_eq!(
            m.apply(ServerMsg::Status {
                op: StatusOp::Upsert,
                agent: agent("S1", "", Status::Working),
            }),
            vec![a.clone()]
        );
        assert_eq!(
            m.apply(ServerMsg::Status {
                op: StatusOp::Upsert,
                agent: agent("S2", "", Status::Working),
            }),
            Vec::<AgentKey>::new()
        );
        assert!(m.agents().contains_key(&b));
    }

    #[test]
    fn settings_rerequests_every_open_timeline() {
        let a = key("S1", "");
        let b = key("S2", "");
        let mut m = Model::new();
        m.toggle_open(&a);
        m.toggle_open(&b);
        assert_eq!(
            m.apply(ServerMsg::Settings {
                settings: Settings::default(),
            }),
            vec![a, b]
        );
    }

    #[test]
    fn snapshot_rerequests_present_keys_and_closes_missing() {
        let a = key("S1", "");
        let b = key("S2", "");
        let mut m = Model::new();
        m.toggle_open(&a);
        m.toggle_open(&b);
        m.apply(timeline_msg(
            b.clone(),
            vec![entry(1_000, TimelineKind::TurnStart, None, None, None)],
        ));
        assert_eq!(
            m.apply(snapshot(vec![agent("S1", "", Status::Working)])),
            vec![a.clone()]
        );
        assert!(m.is_open(&a));
        assert!(!m.is_open(&b));
        assert!(m.timeline_rows(&b, &crate::clock::utc_hhmm).is_empty());
    }

    #[test]
    fn removed_agent_closes_its_timeline() {
        let a = key("S1", "");
        let mut m = Model::new();
        m.apply(snapshot(vec![agent("S1", "", Status::Working)]));
        m.toggle_open(&a);
        m.apply(timeline_msg(
            a.clone(),
            vec![entry(
                1_000,
                TimelineKind::Tool,
                Some("Bash"),
                Some("npm test"),
                Some(Outcome::Ok),
            )],
        ));
        assert_eq!(m.timeline_rows(&a, &crate::clock::utc_hhmm).len(), 1);
        assert_eq!(
            m.apply(ServerMsg::Status {
                op: StatusOp::Remove,
                agent: agent("S1", "", Status::Working),
            }),
            Vec::<AgentKey>::new()
        );
        assert!(!m.is_open(&a));
        assert!(m.timeline_rows(&a, &crate::clock::utc_hhmm).is_empty());
        assert_eq!(
            m.apply(ServerMsg::Status {
                op: StatusOp::Upsert,
                agent: agent("S1", "", Status::Working),
            }),
            Vec::<AgentKey>::new()
        );
    }

    #[test]
    fn timeline_reply_for_closed_key_is_dropped() {
        let a = key("S1", "");
        let mut m = Model::new();
        m.apply(timeline_msg(
            a.clone(),
            vec![entry(1_000, TimelineKind::TurnStart, None, None, None)],
        ));
        assert!(m.timeline_rows(&a, &crate::clock::utc_hhmm).is_empty());
    }

    #[test]
    fn timeline_rows_map_kinds_and_outcomes() {
        let a = key("S1", "");
        let mut m = Model::new();
        m.toggle_open(&a);
        m.apply(timeline_msg(
            a.clone(),
            vec![entry(
                50_520_000,
                TimelineKind::Tool,
                Some("Bash"),
                Some("npm test"),
                Some(Outcome::Pending),
            )],
        ));
        let rows = m.timeline_rows(&a, &crate::clock::utc_hhmm);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].time, "14:02");
        assert_eq!(en(&rows[0].text), "Bash npm test");
        assert_eq!(rows[0].outcome, Some(Outcome::Pending));
    }

    #[test]
    fn timeline_entry_copy_reads_for_each_kind() {
        let a = key("S1", "");
        let mut m = Model::new();
        m.toggle_open(&a);
        m.apply(timeline_msg(
            a.clone(),
            vec![
                entry(1_000, TimelineKind::SessionStart, None, None, None),
                entry(2_000, TimelineKind::TurnStart, None, None, None),
                entry(
                    3_000,
                    TimelineKind::Tool,
                    Some("Bash"),
                    None,
                    Some(Outcome::Ok),
                ),
                entry(4_000, TimelineKind::NeedsYou, Some("Bash"), None, None),
                entry(
                    5_000,
                    TimelineKind::SubagentStart,
                    None,
                    Some("Review the diff"),
                    None,
                ),
                entry(6_000, TimelineKind::SubagentStop, None, None, None),
                entry(7_000, TimelineKind::TurnDone, None, None, Some(Outcome::Ok)),
                entry(
                    8_000,
                    TimelineKind::TurnFailed,
                    None,
                    None,
                    Some(Outcome::Failed),
                ),
                entry(9_000, TimelineKind::Gap, None, Some("history full"), None),
                entry(10_000, TimelineKind::SessionEnd, None, None, None),
            ],
        ));
        let rows = m.timeline_rows(&a, &crate::clock::utc_hhmm);
        let text: Vec<String> = rows.iter().map(|r| en(&r.text)).collect();
        assert_eq!(
            text,
            vec![
                "session started",
                "turn started",
                "Bash",
                "needs you: Bash",
                "subagent started: Review the diff",
                "subagent stopped",
                "turn done",
                "turn failed",
                "events missed: history full",
                "session ended",
            ]
        );
        assert_eq!(tr(UiLang::Id, &rows[0].text), "sesi dimulai");
        assert_eq!(tr(UiLang::Id, &rows[2].text), "Bash");
        assert_eq!(en(&Msg::Outcome(Outcome::Ok)), "ok");
        assert_eq!(id(&Msg::Outcome(Outcome::Failed)), "gagal");
        assert_eq!(id(&Msg::Outcome(Outcome::Pending)), "tertunda");
    }

    #[test]
    fn desk_ignores_card_messages() {
        use rocky_proto::cards::{
            CARD_VERSION, Card, CardStatus, Coverage, CoverageState, Importance,
        };
        use rocky_proto::pipe::{BlockSnippet, DiffLine, DiffLineKind, SnippetLine};

        let sample_card = Card {
            v: CARD_VERSION,
            card_id: "c1".into(),
            rev: 1,
            repo_id: "r1".into(),
            root: String::new(),
            main_root: None,
            branch: Some("main".into()),
            session_id: "s1".into(),
            agent_id: "a1".into(),
            agent_type: "claude".into(),
            parent_card_id: None,
            started_ms: 1_000,
            ended_ms: Some(2_000),
            status: CardStatus::Done,
            prompt: "fix bug".into(),
            prompt_truncated: false,
            importance: Importance::Medium,
            blocks: Vec::new(),
            more_count: 0,
            flow: Vec::new(),
            flow_more: 0,
            outside_count: 0,
            coverage: Coverage {
                state: CoverageState::Full,
                reasons: Vec::new(),
            },
        };

        let mut m = Model::new();
        assert!(
            m.apply(ServerMsg::Cards {
                id: 1,
                items: vec![sample_card.clone()],
                next: Some("1000:c1".into()),
            })
            .is_empty()
        );
        assert!(
            m.apply(ServerMsg::Card {
                item: sample_card.clone(),
            })
            .is_empty()
        );
        assert!(
            m.apply(ServerMsg::CardDetail {
                id: 2,
                card: sample_card,
                snippets: vec![BlockSnippet {
                    seq: 1,
                    lines: vec![SnippetLine::Context {
                        text: "fn main() {}".into(),
                    }],
                }],
            })
            .is_empty()
        );
        assert!(
            m.apply(ServerMsg::BlockDiff {
                id: 3,
                lines: vec![DiffLine {
                    kind: DiffLineKind::Added,
                    text: "let x = 1;".into(),
                }],
                page: 0,
                pages: 1,
                missing: false,
            })
            .is_empty()
        );
    }
}
