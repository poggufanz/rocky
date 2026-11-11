//! Pipe protocol v3 between rockyd and rocky-desk: one JSON object per line.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::settings::Settings;

pub const PROTOCOL_VERSION: u32 = 3;
pub const LINE_CAP: usize = 64 * 1024;
pub const CLIENT_QUEUE_CAP: usize = 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Idle,
    Working,
    NeedsYou,
    Done,
    Failed,
    Ended,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct AgentKey {
    pub session_id: String,
    pub agent_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Action {
    pub tool_name: String,
    pub target_path: Option<String>,
    pub tool_use_id: Option<String>,
    #[serde(default)]
    pub command: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RepoInfo {
    pub root: Option<String>,
    pub name: String,
    pub branch: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentStatus {
    pub key: AgentKey,
    pub agent_type: Option<String>,
    pub status: Status,
    pub action: Option<Action>,
    pub summary: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    pub failures: u32,
    pub last_event_ms: u64,
    pub quiet_10m: bool,
    pub repo: RepoInfo,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GapReason {
    SpoolFull,
    HistoryFull,
    HookDropped,
    BadFile,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Gap {
    pub from_ms: u64,
    pub to_ms: u64,
    pub count: u64,
    pub reason: GapReason,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TimelineKind {
    SessionStart,
    TurnStart,
    Tool,
    NeedsYou,
    SubagentStart,
    SubagentStop,
    TurnDone,
    TurnFailed,
    SessionEnd,
    Gap,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Pending,
    Ok,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimelineEntry {
    pub ms: u64,
    pub kind: TimelineKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<Outcome>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Health {
    pub spool_pending: u64,
    pub spool_dropped: u64,
    pub dropped_events: u64,
    pub bad_files: u64,
    pub late_events: u64,
    pub hook_newer_than_daemon: bool,
    #[serde(default)]
    pub gaps: Vec<Gap>,
    #[serde(default)]
    pub settings_unreadable: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CmdName {
    Stop,
    Show,
    Quit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StatusOp {
    Upsert,
    Remove,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMsg {
    Hello {
        client: String,
        version: String,
    },
    Subscribe,
    Cmd {
        name: CmdName,
        id: u64,
    },
    Set {
        id: u64,
        name: String,
        value: serde_json::Value,
    },
    Timeline {
        id: u64,
        key: AgentKey,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMsg {
    Hello {
        daemon_version: String,
        pid: u32,
    },
    Error {
        code: String,
    },
    Snapshot {
        agents: Vec<AgentStatus>,
        aggregate: Status,
        health: Health,
        settings: Settings,
    },
    Status {
        op: StatusOp,
        agent: AgentStatus,
    },
    Health {
        health: Health,
    },
    Settings {
        settings: Settings,
    },
    Timeline {
        id: u64,
        key: AgentKey,
        entries: Vec<TimelineEntry>,
    },
    Show,
    Quit,
    Ack {
        id: u64,
        ok: bool,
        error: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WireError {
    TooLong,
    Version(u32),
    Malformed,
}

/// Serialize one message as a single JSON line with `"v"` first, ending in `\n`.
pub fn encode<T: Serialize>(msg: &T) -> String {
    let body = serde_json::to_string(msg).expect("pipe message serializes to JSON");
    if body == "{}" {
        return format!("{{\"v\":{PROTOCOL_VERSION}}}\n");
    }
    debug_assert!(body.starts_with('{'), "pipe messages are JSON objects");
    format!("{{\"v\":{PROTOCOL_VERSION},{}\n", &body[1..])
}

#[derive(Deserialize)]
struct VersionPeek {
    v: u32,
}

/// Decode one line: length check first, then major version, then body.
pub fn decode<T: DeserializeOwned>(line: &str) -> Result<T, WireError> {
    if line.len() > LINE_CAP {
        return Err(WireError::TooLong);
    }
    decode_unbounded(line)
}

/// Decode one line without the client-line length check, for receivers whose
/// peer lines are not subject to `LINE_CAP` (e.g. the desk reading daemon
/// snapshots).
/// The caller must enforce its own bound.
pub fn decode_unbounded<T: DeserializeOwned>(line: &str) -> Result<T, WireError> {
    let peek = serde_json::from_str::<VersionPeek>(line).map_err(|_| WireError::Malformed)?;
    if peek.v != PROTOCOL_VERSION {
        return Err(WireError::Version(peek.v));
    }
    serde_json::from_str(line).map_err(|_| WireError::Malformed)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::pipe::{
        AgentKey, AgentStatus, ClientMsg, CmdName, Health, LINE_CAP, Outcome, RepoInfo, ServerMsg,
        Status, StatusOp, TimelineEntry, TimelineKind, WireError, decode, encode,
    };
    use crate::settings::Settings;

    fn key() -> AgentKey {
        AgentKey {
            session_id: "s1".into(),
            agent_id: String::new(),
        }
    }

    #[test]
    fn encode_uses_v3() {
        let s = encode(&ClientMsg::Subscribe);
        assert_eq!(s, "{\"v\":3,\"type\":\"subscribe\"}\n");
    }
    #[test]
    fn v1_line_is_a_version_error() {
        assert!(matches!(
            decode::<ClientMsg>(r#"{"v":1,"type":"subscribe"}"#),
            Err(WireError::Version(1))
        ));
    }
    #[test]
    fn decode_rejects_other_major_before_body() {
        assert!(matches!(
            decode::<ClientMsg>(r#"{"v":4,"type":"brand_new"}"#),
            Err(WireError::Version(4))
        ));
    }
    #[test]
    fn decode_rejects_long_line() {
        let line = format!(
            r#"{{"v":3,"type":"hello","client":"{}","version":"x"}}"#,
            "a".repeat(LINE_CAP)
        );
        assert!(matches!(
            decode::<ClientMsg>(&line),
            Err(WireError::TooLong)
        ));
    }
    #[test]
    fn show_wire_shape() {
        assert_eq!(encode(&ServerMsg::Show), "{\"v\":3,\"type\":\"show\"}\n");
    }
    #[test]
    fn every_client_msg_roundtrips() {
        let msgs = [
            ClientMsg::Hello {
                client: "desk".into(),
                version: "0.1.0".into(),
            },
            ClientMsg::Subscribe,
            ClientMsg::Set {
                id: 1,
                name: "history".into(),
                value: json!(false),
            },
            ClientMsg::Timeline { id: 2, key: key() },
            ClientMsg::Cmd {
                name: crate::pipe::CmdName::Show,
                id: 4,
            },
            ClientMsg::Cmd {
                name: crate::pipe::CmdName::Quit,
                id: 5,
            },
        ];
        for m in msgs {
            assert_eq!(decode::<ClientMsg>(encode(&m).trim_end()).unwrap(), m);
        }
    }
    #[test]
    fn every_server_msg_roundtrips() {
        let agent = AgentStatus {
            key: key(),
            agent_type: Some("main".into()),
            status: Status::Working,
            action: None,
            summary: None,
            description: None,
            failures: 0,
            last_event_ms: 1,
            quiet_10m: false,
            repo: RepoInfo {
                root: None,
                name: "rocky".into(),
                branch: None,
            },
        };
        let health = Health::default();
        let msgs = [
            ServerMsg::Hello {
                daemon_version: "0.0.0".into(),
                pid: 1,
            },
            ServerMsg::Error {
                code: "version".into(),
            },
            ServerMsg::Snapshot {
                agents: vec![agent.clone()],
                aggregate: Status::Working,
                health: health.clone(),
                settings: Settings::default(),
            },
            ServerMsg::Status {
                op: StatusOp::Upsert,
                agent,
            },
            ServerMsg::Health { health },
            ServerMsg::Settings {
                settings: Settings::default(),
            },
            ServerMsg::Timeline {
                id: 3,
                key: key(),
                entries: vec![TimelineEntry {
                    ms: 1,
                    kind: TimelineKind::Tool,
                    tool_name: Some("Bash".into()),
                    text: Some("npm test".into()),
                    outcome: Some(Outcome::Pending),
                }],
            },
            ServerMsg::Show,
            ServerMsg::Quit,
            ServerMsg::Ack {
                id: 7,
                ok: true,
                error: None,
            },
        ];
        for m in msgs {
            assert_eq!(decode::<ServerMsg>(encode(&m).trim_end()).unwrap(), m);
        }
    }
    #[test]
    fn quit_messages_round_trip_at_protocol_3() {
        assert_eq!(
            encode(&ClientMsg::Cmd {
                name: CmdName::Quit,
                id: 7,
            }),
            "{\"v\":3,\"type\":\"cmd\",\"name\":\"quit\",\"id\":7}\n"
        );
        assert_eq!(
            decode::<ServerMsg>(r#"{"v":3,"type":"quit"}"#).unwrap(),
            ServerMsg::Quit
        );
    }

    #[test]
    fn protocol_2_frames_are_rejected() {
        assert!(matches!(
            decode::<ClientMsg>(r#"{"v":2,"type":"subscribe"}"#),
            Err(WireError::Version(2))
        ));
    }

    #[test]
    fn status_wire_names() {
        assert_eq!(
            serde_json::to_string(&Status::NeedsYou).unwrap(),
            "\"needs_you\""
        );
    }
}
