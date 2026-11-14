//! Pipe protocol v4 between rockyd and rocky-desk: one JSON object per line.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::settings::Settings;

pub const PROTOCOL_VERSION: u32 = 4;
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub main_root: Option<String>,
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
    #[serde(default)]
    pub capture: Vec<CaptureHealth>,
}

/// Where one consented repo's capture stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureState {
    Starting,
    Ok,
    Partial,
    Elsewhere,
    Polling,
    Failed,
}

/// The daemon's last view of one repo's capture worker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CaptureHealth {
    pub root: String,
    pub state: CaptureState,
    #[serde(default)]
    pub last_reconcile_ms: Option<u64>,
    #[serde(default)]
    pub error: Option<String>,
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

/// The repo capture decision Node reports for a repo.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RepoDecisionState {
    Allowed,
    Declined,
    Undecided,
}

/// One checkout of a repo that Listening knows about.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorktreeEntry {
    pub root: String,
    pub bytes: u64,
    pub exists: bool,
}

/// One repo with a recorded capture decision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepoEntry {
    pub key: String,
    pub main: String,
    pub name: String,
    pub decision: RepoDecisionState,
    pub bytes: u64,
    #[serde(default)]
    pub worktrees: Vec<WorktreeEntry>,
}

fn default_true() -> bool {
    true
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
    ShellOn,
    ShellOff,
    RepoList,
    RepoPurge { root: String },
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
    Cards {
        id: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        query: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        before: Option<String>,
        limit: u32,
    },
    CardDetail {
        id: u64,
        card_id: String,
    },
    BlockDiff {
        id: u64,
        card_id: String,
        seq: u32,
        page: u32,
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
        #[serde(default)]
        harness_off: Vec<String>,
        #[serde(default = "default_true")]
        shell_hook: bool,
    },
    RepoList {
        id: u64,
        repos: Vec<RepoEntry>,
    },
    RepoPending {
        repos: Vec<PendingRepo>,
    },
    Cards {
        id: u64,
        items: Vec<crate::cards::Card>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        next: Option<String>,
    },
    Card {
        item: crate::cards::Card,
    },
    CardDetail {
        id: u64,
        card: crate::cards::Card,
        snippets: Vec<BlockSnippet>,
    },
    BlockDiff {
        id: u64,
        lines: Vec<DiffLine>,
        page: u32,
        pages: u32,
        missing: bool,
    },
}

/// One line of a block's code snippet in a card detail reply.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum SnippetLine {
    Context { text: String },
    Added { text: String },
    Removed { text: String },
    Fold { lines: u32 },
    More { lines: u32 },
}

/// Snippet lines attached to one block inside a card detail reply.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlockSnippet {
    pub seq: u32,
    pub lines: Vec<SnippetLine>,
}

/// Classification of one line inside a paged block diff.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiffLineKind {
    Context,
    Added,
    Removed,
}

/// One line inside a paged block diff.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiffLine {
    pub kind: DiffLineKind,
    pub text: String,
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
        AgentKey, AgentStatus, CaptureHealth, CaptureState, ClientMsg, CmdName, ConsentState,
        GapReason, Health, LINE_CAP, Outcome, PendingRepo, RepoDecisionState, RepoEntry, RepoInfo,
        ServerMsg, SetupAction, SetupHealth, SetupTarget, Status, StatusOp, TargetState,
        TimelineEntry, TimelineKind, WireError, WorktreeEntry, decode, encode,
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
    fn encode_uses_v4() {
        let s = encode(&ClientMsg::Subscribe);
        assert_eq!(s, "{\"v\":4,\"type\":\"subscribe\"}\n");
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
            decode::<ClientMsg>(r#"{"v":5,"type":"brand_new"}"#),
            Err(WireError::Version(5))
        ));
    }
    #[test]
    fn decode_rejects_long_line() {
        let line = format!(
            r#"{{"v":4,"type":"hello","client":"{}","version":"x"}}"#,
            "a".repeat(LINE_CAP)
        );
        assert!(matches!(
            decode::<ClientMsg>(&line),
            Err(WireError::TooLong)
        ));
    }
    #[test]
    fn show_wire_shape() {
        assert_eq!(encode(&ServerMsg::Show), "{\"v\":4,\"type\":\"show\"}\n");
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
                main_root: None,
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
                harness_off: vec!["codex".into()],
                shell_hook: false,
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
    fn quit_messages_round_trip_at_protocol_4() {
        assert_eq!(
            encode(&ClientMsg::Cmd {
                name: CmdName::Quit,
                id: 7,
            }),
            "{\"v\":4,\"type\":\"cmd\",\"name\":\"quit\",\"id\":7}\n"
        );
        assert_eq!(
            decode::<ServerMsg>(r#"{"v":4,"type":"quit"}"#).unwrap(),
            ServerMsg::Quit
        );
    }

    #[test]
    fn prior_protocol_frames_are_rejected() {
        assert!(matches!(
            decode::<ClientMsg>(r#"{"v":2,"type":"subscribe"}"#),
            Err(WireError::Version(2))
        ));
        assert!(matches!(
            decode::<ClientMsg>(r#"{"v":3,"type":"subscribe"}"#),
            Err(WireError::Version(3))
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
    fn setup_messages_round_trip_at_protocol_4() {
        let setup = ClientMsg::Setup {
            id: 4,
            action: SetupAction::HarnessOn {
                harness: "codex".into(),
            },
        };
        assert_eq!(
            encode(&setup),
            "{\"v\":4,\"type\":\"setup\",\"id\":4,\"action\":{\"name\":\"harness_on\",\"harness\":\"codex\"}}\n"
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
                harness_off: Vec::new(),
                shell_hook: true,
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
    fn consent_plan_without_new_fields_decodes() {
        let old = r#"{"v":4,"type":"consent_plan","id":1,"consent":"approved","targets":[]}"#;
        let ServerMsg::ConsentPlan {
            harness_off,
            shell_hook,
            ..
        } = decode::<ServerMsg>(old).unwrap()
        else {
            panic!("expected a consent plan");
        };
        assert!(harness_off.is_empty());
        assert!(shell_hook);
    }

    #[test]
    fn repo_list_round_trip() {
        let msg = ServerMsg::RepoList {
            id: 21,
            repos: vec![RepoEntry {
                key: "k1".into(),
                main: "C:/code/alpha".into(),
                name: "alpha".into(),
                decision: RepoDecisionState::Declined,
                bytes: 4096,
                worktrees: vec![WorktreeEntry {
                    root: "C:/code/alpha-wt".into(),
                    bytes: 512,
                    exists: false,
                }],
            }],
        };
        assert_eq!(decode::<ServerMsg>(encode(&msg).trim_end()).unwrap(), msg);
        let actions = [
            SetupAction::ShellOn,
            SetupAction::ShellOff,
            SetupAction::RepoList,
            SetupAction::RepoPurge {
                root: "C:/code/alpha".into(),
            },
        ];
        for (index, action) in actions.into_iter().enumerate() {
            let m = ClientMsg::Setup {
                id: index as u64,
                action,
            };
            assert_eq!(decode::<ClientMsg>(encode(&m).trim_end()).unwrap(), m);
        }
    }

    #[test]
    fn health_without_setup_decodes_to_default() {
        let bare = r#"{"v":4,"type":"health","health":{"spool_pending":0,"spool_dropped":0,"dropped_events":0,"bad_files":0,"late_events":0,"hook_newer_than_daemon":false}}"#;
        let ServerMsg::Health { health } = decode::<ServerMsg>(bare).unwrap() else {
            panic!("expected a health frame");
        };
        assert_eq!(health.setup, SetupHealth::default());

        let with_target = r#"{"v":4,"type":"health","health":{"spool_pending":0,"spool_dropped":0,"dropped_events":0,"bad_files":0,"late_events":0,"hook_newer_than_daemon":false,"setup":{"targets":[{"harness":"codex","kind":"mcp","path":"p","state":"foreign"}]}}}"#;
        let ServerMsg::Health { health } = decode::<ServerMsg>(with_target).unwrap() else {
            panic!("expected a health frame");
        };
        let target = &health.setup.targets[0];
        assert_eq!(target.state, TargetState::Foreign);
        assert_eq!(target.fights_10m, 0);
        assert_eq!(target.last_repair_ms, None);
    }

    #[test]
    fn health_without_capture_decodes_to_empty() {
        let v4 = r#"{"v":4,"type":"health","health":{"spool_pending":0,"spool_dropped":0,"dropped_events":0,"bad_files":0,"late_events":0,"hook_newer_than_daemon":false,"settings_unreadable":false,"setup":{}}}"#;
        let ServerMsg::Health { health } = decode::<ServerMsg>(v4).unwrap() else {
            panic!("expected a health frame");
        };
        assert!(health.capture.is_empty());
    }

    #[test]
    fn capture_state_is_snake_case() {
        let all = [
            (CaptureState::Starting, "starting"),
            (CaptureState::Ok, "ok"),
            (CaptureState::Partial, "partial"),
            (CaptureState::Elsewhere, "elsewhere"),
            (CaptureState::Polling, "polling"),
            (CaptureState::Failed, "failed"),
        ];
        for (state, name) in all {
            let wire = format!("\"{name}\"");
            assert_eq!(serde_json::to_string(&state).unwrap(), wire);
            assert_eq!(serde_json::from_str::<CaptureState>(&wire).unwrap(), state);
        }
    }

    #[test]
    fn capture_health_round_trips_in_a_health_frame() {
        let row = CaptureHealth {
            root: "C:/repo".into(),
            state: CaptureState::Partial,
            last_reconcile_ms: Some(42),
            error: Some("scan".into()),
        };
        let msg = ServerMsg::Health {
            health: Health {
                capture: vec![row],
                ..Health::default()
            },
        };
        assert_eq!(decode::<ServerMsg>(encode(&msg).trim_end()).unwrap(), msg);
    }

    #[test]
    fn hooks_restored_gap_reason_wire_name() {
        assert_eq!(
            serde_json::to_string(&GapReason::HooksRestored).unwrap(),
            "\"hooks_restored\""
        );
    }

    #[test]
    fn repo_info_main_root_omits_when_none_and_defaults_on_old_wire() {
        let without_main = RepoInfo {
            root: Some("C:/r".into()),
            main_root: None,
            name: "r".into(),
            branch: Some("main".into()),
        };
        let encoded = serde_json::to_string(&without_main).unwrap();
        assert!(
            !encoded.contains("main_root"),
            "unexpected field: {encoded}"
        );

        let legacy = r#"{"root":"C:/r","name":"r","branch":"main"}"#;
        let decoded: RepoInfo = serde_json::from_str(legacy).unwrap();
        assert_eq!(decoded, without_main);

        let with_main = RepoInfo {
            root: Some("C:/wt".into()),
            main_root: Some("C:/r".into()),
            name: "wt".into(),
            branch: Some("feat".into()),
        };
        let encoded_with = serde_json::to_string(&with_main).unwrap();
        assert!(encoded_with.contains("\"main_root\":\"C:/r\""));
        assert_eq!(
            serde_json::from_str::<RepoInfo>(&encoded_with).unwrap(),
            with_main
        );
    }

    #[test]
    fn card_protocol_messages_round_trip() {
        use crate::cards::{CARD_VERSION, Card, CardStatus, Coverage, CoverageState, Importance};
        use crate::pipe::{BlockSnippet, DiffLine, DiffLineKind, SnippetLine};

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
            flow: Vec::new(),
            outside_count: 0,
            coverage: Coverage {
                state: CoverageState::Full,
                reasons: Vec::new(),
            },
        };

        let client_msgs = [
            ClientMsg::Cards {
                id: 10,
                query: Some("auth".into()),
                before: Some("2000:c1".into()),
                limit: 20,
            },
            ClientMsg::Cards {
                id: 11,
                query: None,
                before: None,
                limit: 10,
            },
            ClientMsg::CardDetail {
                id: 12,
                card_id: "c1".into(),
            },
            ClientMsg::BlockDiff {
                id: 13,
                card_id: "c1".into(),
                seq: 1,
                page: 0,
            },
        ];
        for msg in &client_msgs {
            let wire = encode(msg);
            assert!(wire.starts_with("{\"v\":4,"), "bad wire: {wire}");
            let back: ClientMsg = decode(&wire).unwrap();
            assert_eq!(&back, msg);
        }

        let server_msgs = [
            ServerMsg::Cards {
                id: 10,
                items: vec![sample_card.clone()],
                next: Some("2000:c1".into()),
            },
            ServerMsg::Cards {
                id: 11,
                items: Vec::new(),
                next: None,
            },
            ServerMsg::Card {
                item: sample_card.clone(),
            },
            ServerMsg::CardDetail {
                id: 12,
                card: sample_card,
                snippets: vec![BlockSnippet {
                    seq: 1,
                    lines: vec![
                        SnippetLine::Context {
                            text: "fn f() {".into(),
                        },
                        SnippetLine::Removed {
                            text: "  old();".into(),
                        },
                        SnippetLine::Added {
                            text: "  new();".into(),
                        },
                        SnippetLine::Fold { lines: 3 },
                        SnippetLine::More { lines: 5 },
                    ],
                }],
            },
            ServerMsg::BlockDiff {
                id: 13,
                lines: vec![
                    DiffLine {
                        kind: DiffLineKind::Context,
                        text: "fn f() {".into(),
                    },
                    DiffLine {
                        kind: DiffLineKind::Removed,
                        text: "  old();".into(),
                    },
                    DiffLine {
                        kind: DiffLineKind::Added,
                        text: "  new();".into(),
                    },
                ],
                page: 0,
                pages: 1,
                missing: false,
            },
            ServerMsg::BlockDiff {
                id: 14,
                lines: Vec::new(),
                page: 0,
                pages: 0,
                missing: true,
            },
        ];
        for msg in &server_msgs {
            let wire = encode(msg);
            assert!(wire.starts_with("{\"v\":4,"), "bad wire: {wire}");
            let back: ServerMsg = decode(&wire).unwrap();
            assert_eq!(&back, msg);
        }
    }
}
