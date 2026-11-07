//! Pure view-model for rocky-desk: grouping, aggregate, tooltip, warnings.

use rocky_proto::pipe::{AgentKey, AgentStatus, Health, ServerMsg, Status, StatusOp};
use std::collections::BTreeMap;

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
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoGroup {
    pub label: String,
    pub sessions: Vec<SessionRow>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionRow {
    pub session_short: String,
    pub agents: Vec<AgentRow>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentRow {
    pub label: String,
    pub status: Status,
    pub action_text: Option<String>,
    pub age_text: String,
    pub failures: u32,
}

#[derive(Debug, Default)]
pub struct Model {
    agents: BTreeMap<AgentKey, AgentStatus>,
    health: Health,
    conn: Conn,
}

impl Model {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn apply(&mut self, msg: ServerMsg) {
        match msg {
            ServerMsg::Snapshot { agents, health, .. } => {
                self.agents = agents.into_iter().map(|a| (a.key.clone(), a)).collect();
                self.health = health;
            }
            ServerMsg::Status { op, agent } => match op {
                StatusOp::Upsert => {
                    self.agents.insert(agent.key.clone(), agent);
                }
                StatusOp::Remove => {
                    self.agents.remove(&agent.key);
                }
            },
            ServerMsg::Health { health } => {
                self.health = health;
            }
            ServerMsg::Error { code } if code == "version" => {
                self.conn = Conn::VersionMismatch;
            }
            _ => {}
        }
    }

    pub fn set_conn(&mut self, c: Conn) {
        self.conn = c;
    }

    pub fn groups(&self, now_ms: u64) -> Vec<RepoGroup> {
        let mut by_group: BTreeMap<String, BTreeMap<String, Vec<&AgentStatus>>> = BTreeMap::new();
        for a in self.agents.values() {
            if a.status == Status::Ended {
                continue;
            }
            by_group
                .entry(group_label(&a.repo.name, a.repo.branch.as_deref()))
                .or_default()
                .entry(a.key.session_id.clone())
                .or_default()
                .push(a);
        }
        by_group
            .into_iter()
            .map(|(label, sessions)| RepoGroup {
                label,
                sessions: sessions
                    .into_iter()
                    .map(|(session_id, mut agents)| {
                        agents.sort_by(|a, b| {
                            (!a.key.agent_id.is_empty(), &a.key.agent_id)
                                .cmp(&(!b.key.agent_id.is_empty(), &b.key.agent_id))
                        });
                        SessionRow {
                            session_short: short8(&session_id),
                            agents: agents
                                .into_iter()
                                .map(|a| AgentRow {
                                    label: agent_label(a),
                                    status: a.status,
                                    action_text: a
                                        .action
                                        .as_ref()
                                        .map(|act| action_text(act, a.repo.root.as_deref())),
                                    age_text: age_text(now_ms, a.last_event_ms),
                                    failures: a.failures,
                                })
                                .collect(),
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

    pub fn tooltip(&self) -> String {
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
        let segs: Vec<String> = [
            (n[0], "working"),
            (n[1], "needs you"),
            (n[2], "failed"),
            (n[3], "done"),
            (n[4], "idle"),
        ]
        .into_iter()
        .filter(|(c, _)| *c > 0)
        .map(|(c, name)| format!("{c} {name}"))
        .collect();
        if segs.is_empty() {
            "rocky: idle".to_string()
        } else {
            format!("rocky: {}", segs.join(", "))
        }
    }

    pub fn warnings(&self) -> Vec<String> {
        let mut w = Vec::new();
        let h = &self.health;
        if h.bad_files > 0 {
            w.push(format!("{} bad spool files.", h.bad_files));
        }
        if h.dropped_events > 0 {
            w.push(format!("{} dropped events.", h.dropped_events));
        }
        if h.spool_dropped > 0 {
            w.push(format!("{} spool files dropped.", h.spool_dropped));
        }
        if h.late_events > 0 {
            w.push(format!("{} late events.", h.late_events));
        }
        if h.hook_newer_than_daemon {
            w.push("hook is newer than daemon, needs update.".to_string());
        }
        match self.conn {
            Conn::VersionMismatch => w.push("daemon version mismatch, needs update.".to_string()),
            Conn::ServerUnverified => w.push("daemon could not be verified.".to_string()),
            Conn::Disconnected => w.push("daemon disconnected.".to_string()),
            Conn::TiedToJob => w.push("daemon tied to launcher job.".to_string()),
            Conn::KeepsCrashing => w.push("daemon keeps crashing.".to_string()),
            Conn::Connecting | Conn::Connected => {}
        }
        w
    }
}

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

fn group_label(name: &str, branch: Option<&str>) -> String {
    let name = if name.is_empty() {
        "unknown repo"
    } else {
        name
    };
    match branch {
        Some(b) if !b.is_empty() => format!("{name} @ {b}"),
        _ => name.to_string(),
    }
}

/// First 8 chars, char-safe.
fn short8(s: &str) -> String {
    s.chars().take(8).collect()
}

fn agent_label(a: &AgentStatus) -> String {
    if a.key.agent_id.is_empty() {
        return "main".to_string();
    }
    match a.agent_type.as_deref() {
        Some(t) if !t.is_empty() => format!("{} {}", t, short8(&a.key.agent_id)),
        _ => short8(&a.key.agent_id),
    }
}

fn age_text(now_ms: u64, last_ms: u64) -> String {
    let secs = now_ms.saturating_sub(last_ms) / 1000;
    if secs < 10 {
        "now".to_string()
    } else if secs < 60 {
        format!("{secs}s")
    } else if secs < 3600 {
        format!("{}m", secs / 60)
    } else if secs < 86400 {
        format!("{}h", secs / 3600)
    } else {
        format!("{}d", secs / 86400)
    }
}

pub fn action_text(a: &rocky_proto::pipe::Action, repo_root: Option<&str>) -> String {
    let Some(path) = a.target_path.as_deref() else {
        return a.tool_name.clone();
    };
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
    let text = format!("{} {rel}", a.tool_name);
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
    use rocky_proto::pipe::{Action, AgentKey, AgentStatus, Health, RepoInfo, ServerMsg, Status};

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
            failures: 0,
            last_event_ms: 1_000,
            quiet_10m: false,
            repo: RepoInfo {
                root: Some("C:/r".into()),
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
        }
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
        assert_eq!(groups[0].label, "r @ main");
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
        let agents = &groups[0].sessions[0].agents;
        assert_eq!(agents.len(), 3);
        assert_eq!(agents[0].label, "main");
        assert_eq!(agents[1].label, "Explore aaaaaaaa");
        assert_eq!(agents[2].label, "Explore bbbbbbbb");
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
        assert_eq!(groups[0].sessions[0].agents.len(), 1);
        assert_eq!(groups[0].sessions[0].agents[0].label, "main");
    }

    #[test]
    fn tooltip_counts() {
        let m = Model::new();
        assert_eq!(m.tooltip(), "rocky: idle");
        let mut m = Model::new();
        m.apply(snapshot(vec![
            agent("S1", "", Status::Working),
            agent("S2", "", Status::Working),
            agent("S3", "", Status::NeedsYou),
        ]));
        assert_eq!(m.tooltip(), "rocky: 2 working, 1 needs you");
    }

    #[test]
    fn action_text_relative_and_capped() {
        let a = Action {
            tool_name: "Edit".into(),
            target_path: Some("C:/r/src/core/memory.ts".into()),
            tool_use_id: None,
        };
        assert_eq!(action_text(&a, Some("C:/r")), "Edit src/core/memory.ts");
        // path panjang → len chars == 80 dan diakhiri '…'
        let long = Action {
            tool_name: "Edit".into(),
            target_path: Some(format!("C:/r/{}", "x".repeat(200))),
            tool_use_id: None,
        };
        let t = action_text(&long, Some("C:/r"));
        assert_eq!(t.chars().count(), 80);
        assert!(t.ends_with('…'));
        // backslash + root beda case → relatif, pakai '/'
        let win = Action {
            tool_name: "Read".into(),
            target_path: Some("C:\\r\\src\\a.ts".into()),
            tool_use_id: None,
        };
        assert_eq!(action_text(&win, Some("c:/R")), "Read src/a.ts");
        // tanpa target → nama tool saja
        let bare = Action {
            tool_name: "Bash".into(),
            target_path: None,
            tool_use_id: None,
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
        assert!(m.warnings().is_empty());
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
        let w = m.warnings();
        assert_eq!(w.len(), 6);
        assert!(w.iter().any(|s| s.contains("bad spool files")));
        assert!(w.iter().any(|s| s.contains("dropped events")));
        assert!(w.iter().any(|s| s.contains("needs update")));
        let mut m = Model::new();
        m.set_conn(Conn::TiedToJob);
        assert!(
            m.warnings()
                .iter()
                .any(|s| s.contains("tied to launcher job"))
        );
        m.set_conn(Conn::KeepsCrashing);
        assert!(m.warnings().iter().any(|s| s.contains("keeps crashing")));
        m.set_conn(Conn::ServerUnverified);
        assert!(
            m.warnings()
                .iter()
                .any(|s| s.contains("could not be verified"))
        );
        m.set_conn(Conn::Disconnected);
        assert!(m.warnings().iter().any(|s| s.contains("disconnected")));
        m.set_conn(Conn::Connected);
        assert!(m.warnings().is_empty());
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
    fn age_text_boundaries() {
        let mut live = agent("S1", "", Status::Working);
        live.last_event_ms = 130_000;
        let mut old = agent("S2", "", Status::Idle);
        old.last_event_ms = 10_000;
        let mut m = Model::new();
        m.apply(snapshot(vec![live, old]));
        let groups = m.groups(130_000);
        assert_eq!(groups[0].sessions[0].agents[0].age_text, "now");
        assert_eq!(groups[0].sessions[1].agents[0].age_text, "2m");
    }
}
