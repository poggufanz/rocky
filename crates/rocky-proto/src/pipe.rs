//! Pipe protocol v3 between rockyd and rocky-desk: one JSON object per line.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::settings::Settings;

pub const PROTOCOL_VERSION: u32 = 3;
pub const LINE_CAP: usize = 64 * 1024;
pub const CLIENT_QUEUE_CAP: usize = 1024;
/// Limit for [`TargetHealth::fights_10m`].
pub const FIGHT_LIMIT: u32 = 5;

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
    HooksRestored,
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
    #[serde(default)]
    pub setup: SetupHealth,
}

/// Where one setup target stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TargetState {
    Ok,
    Missing,
    Stale,
    Written,
    Changed,
    Foreign,
    Refused,
    NotConsented,
    Error,
}

/// The owner's consent for setup writes. `None` means no answer yet.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConsentState {
    #[default]
    None,
    Approved,
    Later,
    Removed,
    Invalid,
}

/// One config entry that a setup plan covers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetupTarget {
    pub harness: String,
    pub kind: String,
    pub path: String,
    pub state: TargetState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// The daemon's last view of one setup target.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TargetHealth {
    pub harness: String,
    pub kind: String,
    pub path: String,
    pub state: TargetState,
    #[serde(default)]
    pub last_repair_ms: Option<u64>,
    #[serde(default)]
    pub fights_10m: u32,
    #[serde(default)]
    pub error: Option<String>,
}

/// Setup-guard status carried in [`Health`]. A frame without a `setup` key decodes to the default.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetupHealth {
    #[serde(default)]
    pub consent_state: ConsentState,
    #[serde(default)]
    pub cli_found: bool,
    #[serde(default)]
    pub cli_missing: Option<String>,
    #[serde(default)]
    pub version_mismatch: bool,
    #[serde(default)]
    pub targets: Vec<TargetHealth>,
}

/// A repo that is waiting for the owner's capture decision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingRepo {
    pub key: String,
    pub main: String,
    pub name: String,
}

/// What a `setup` request asks the daemon to do.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "name", rename_all = "snake_case")]
pub enum SetupAction {
    Plan,
    Apply,
    Remove,
    ConsentApprove,
    ConsentLater,
    HarnessOn { harness: String },
    HarnessOff { harness: String },
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
    Setup {
        id: u64,
        action: SetupAction,
    },
    RepoDecision {
        id: u64,
        root: String,
        allow: bool,
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
        #[serde(default)]
        repo_pending: Vec<PendingRepo>,
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
    ConsentPlan {
        id: u64,
        consent: ConsentState,
        targets: Vec<SetupTarget>,
    },
    RepoPending {
        repos: Vec<PendingRepo>,
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
        AgentKey, AgentStatus, ClientMsg, CmdName, ConsentState, GapReason, Health, LINE_CAP,
        Outcome, PendingRepo, RepoInfo, ServerMsg, SetupAction, SetupHealth, SetupTarget, Status,
        StatusOp, TargetState, TimelineEntry, TimelineKind, WireError, decode, encode,
    };
    use crate::settings::Settings;

    fn key() -> AgentKey {
        AgentKey {
            session_id: "s1".into(),
            agent_id: String::new(),
        }
    }

    fn pending_repo() -> PendingRepo {
        PendingRepo {
            key: "C:/repo".into(),
            main: "C:/repo".into(),
            name: "repo".into(),
        }
    }

    fn setup_target() -> SetupTarget {
        SetupTarget {
            harness: "codex".into(),
            kind: "mcp".into(),
            path: "C:/home/.codex/config.toml".into(),
            state: TargetState::Written,
            detail: None,
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
            ClientMsg::Setup {
                id: 6,
                action: SetupAction::Plan,
            },
            ClientMsg::Setup {
                id: 7,
                action: SetupAction::Apply,
            },
            ClientMsg::Setup {
                id: 8,
                action: SetupAction::Remove,
            },
            ClientMsg::Setup {
                id: 9,
                action: SetupAction::ConsentApprove,
            },
            ClientMsg::Setup {
                id: 10,
                action: SetupAction::ConsentLater,
            },
            ClientMsg::Setup {
                id: 11,
                action: SetupAction::HarnessOn {
                    harness: "codex".into(),
                },
            },
            ClientMsg::Setup {
                id: 12,
                action: SetupAction::HarnessOff {
                    harness: "codex".into(),
                },
            },
            ClientMsg::RepoDecision {
                id: 13,
                root: "C:/repo".into(),
                allow: true,
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
                repo_pending: Vec::new(),
            },
            ServerMsg::Snapshot {
                agents: Vec::new(),
                aggregate: Status::Idle,
                health: Health::default(),
                settings: Settings::default(),
                repo_pending: vec![pending_repo()],
            },
            ServerMsg::ConsentPlan {
                id: 14,
                consent: ConsentState::Approved,
                targets: vec![setup_target()],
            },
            ServerMsg::RepoPending {
                repos: vec![pending_repo()],
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

    #[test]
    fn setup_messages_round_trip_at_protocol_3() {
        let setup = ClientMsg::Setup {
            id: 4,
            action: SetupAction::HarnessOn {
                harness: "codex".into(),
            },
        };
        assert_eq!(
            encode(&setup),
            "{\"v\":3,\"type\":\"setup\",\"id\":4,\"action\":{\"name\":\"harness_on\",\"harness\":\"codex\"}}\n"
        );
        let client = [
            setup,
            ClientMsg::RepoDecision {
                id: 5,
                root: "C:/repo".into(),
                allow: false,
            },
        ];
        for m in client {
            assert_eq!(decode::<ClientMsg>(encode(&m).trim_end()).unwrap(), m);
        }
        let server = [
            ServerMsg::ConsentPlan {
                id: 4,
                consent: ConsentState::Later,
                targets: vec![setup_target()],
            },
            ServerMsg::RepoPending {
                repos: vec![pending_repo()],
            },
            ServerMsg::Snapshot {
                agents: Vec::new(),
                aggregate: Status::Idle,
                health: Health::default(),
                settings: Settings::default(),
                repo_pending: vec![pending_repo()],
            },
        ];
        for m in server {
            assert_eq!(decode::<ServerMsg>(encode(&m).trim_end()).unwrap(), m);
        }
    }

    #[test]
    fn health_without_setup_decodes_to_default() {
        let bare = r#"{"v":3,"type":"health","health":{"spool_pending":0,"spool_dropped":0,"dropped_events":0,"bad_files":0,"late_events":0,"hook_newer_than_daemon":false}}"#;
        let ServerMsg::Health { health } = decode::<ServerMsg>(bare).unwrap() else {
            panic!("expected a health frame");
        };
        assert_eq!(health.setup, SetupHealth::default());

        let with_target = r#"{"v":3,"type":"health","health":{"spool_pending":0,"spool_dropped":0,"dropped_events":0,"bad_files":0,"late_events":0,"hook_newer_than_daemon":false,"setup":{"targets":[{"harness":"codex","kind":"mcp","path":"p","state":"foreign"}]}}}"#;
        let ServerMsg::Health { health } = decode::<ServerMsg>(with_target).unwrap() else {
            panic!("expected a health frame");
        };
        let target = &health.setup.targets[0];
        assert_eq!(target.state, TargetState::Foreign);
        assert_eq!(target.fights_10m, 0);
        assert_eq!(target.last_repair_ms, None);
    }

    #[test]
    fn hooks_restored_gap_reason_wire_name() {
        assert_eq!(
            serde_json::to_string(&GapReason::HooksRestored).unwrap(),
            "\"hooks_restored\""
        );
    }
}
