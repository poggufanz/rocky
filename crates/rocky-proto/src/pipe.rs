//! Pipe protocol v1 between rockyd and rocky-desk: one JSON object per line.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u32 = 1;
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
    pub failures: u32,
    pub last_event_ms: u64,
    pub quiet_10m: bool,
    pub repo: RepoInfo,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Health {
    pub spool_pending: u64,
    pub spool_dropped: u64,
    pub dropped_events: u64,
    pub bad_files: u64,
    pub late_events: u64,
    pub hook_newer_than_daemon: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CmdName {
    Stop,
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
    Hello { client: String, version: String },
    Subscribe,
    Cmd { name: CmdName, id: u64 },
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
    },
    Status {
        op: StatusOp,
        agent: AgentStatus,
    },
    Health {
        health: Health,
    },
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
    use crate::pipe::{ClientMsg, LINE_CAP, ServerMsg, Status, WireError, decode, encode};

    #[test]
    fn encode_puts_version_first_and_newline() {
        let s = encode(&ClientMsg::Subscribe);
        assert_eq!(s, "{\"v\":1,\"type\":\"subscribe\"}\n");
    }
    #[test]
    fn decode_rejects_other_major_before_body() {
        assert!(matches!(
            decode::<ClientMsg>(r#"{"v":2,"type":"brand_new"}"#),
            Err(WireError::Version(2))
        ));
    }
    #[test]
    fn decode_rejects_long_line() {
        let line = format!(
            r#"{{"v":1,"type":"hello","client":"{}","version":"x"}}"#,
            "a".repeat(LINE_CAP)
        );
        assert!(matches!(
            decode::<ClientMsg>(&line),
            Err(WireError::TooLong)
        ));
    }
    #[test]
    fn every_server_msg_roundtrips() {
        use crate::pipe::{AgentKey, AgentStatus, Health, RepoInfo, StatusOp};
        let agent = AgentStatus {
            key: AgentKey {
                session_id: "s1".into(),
                agent_id: String::new(),
            },
            agent_type: Some("main".into()),
            status: Status::Working,
            action: None,
            summary: None,
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
            },
            ServerMsg::Status {
                op: StatusOp::Upsert,
                agent,
            },
            ServerMsg::Health { health },
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
    fn status_wire_names() {
        assert_eq!(
            serde_json::to_string(&Status::NeedsYou).unwrap(),
            "\"needs_you\""
        );
    }
}
