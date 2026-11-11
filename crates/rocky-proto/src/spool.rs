//! Spool record envelope (v1).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::hook::{DropReason, HookEvent};

pub const SPOOL_VERSION: u32 = 1;

/// Environment variables a shell record carries, each with the harness it points at.
pub const SHELL_ENV_VARS: [(&str, &str); 5] = [
    ("CLAUDE_CONFIG_DIR", "claude-code"),
    ("CODEX_HOME", "codex"),
    ("OPENCODE_CONFIG", "opencode"),
    ("GEMINI_SETTINGS", "gemini-cli"),
    ("COPILOT_HOME", "copilot-cli"),
];

/// Byte cap for one environment value a hook records: each value of a shell
/// record, and the `config_dir` of a desk-hook record.
pub const ENV_VALUE_CAP: usize = 4096;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SpoolRecord {
    pub v: u32,
    pub harness: String,
    pub recv_ms: u64,
    /// Config directory the hook reported for this event, when it saw one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_dir: Option<String>,
    #[serde(flatten)]
    pub body: SpoolBody,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[allow(clippy::large_enum_variant)]
pub enum SpoolBody {
    Event { event: HookEvent },
    Dropped { reason: DropReason, bytes: u64 },
    ShellEnv { env: BTreeMap<String, String> },
}

#[derive(Deserialize)]
struct VersionPeek {
    v: u32,
}

pub fn peek_spool_version(bytes: &[u8]) -> Option<u32> {
    serde_json::from_slice::<VersionPeek>(bytes)
        .map(|p| p.v)
        .ok()
}

#[cfg(test)]
mod tests {
    use crate::hook::DropReason;
    use crate::spool::{SpoolBody, SpoolRecord, peek_spool_version};

    #[test]
    fn spool_record_wire_shape() {
        let r = SpoolRecord {
            v: 1,
            harness: "claude-code".into(),
            recv_ms: 5,
            config_dir: None,
            body: SpoolBody::Dropped {
                reason: DropReason::Oversize,
                bytes: 9,
            },
        };
        let wire = serde_json::to_string(&r).unwrap();
        assert_eq!(
            wire,
            r#"{"v":1,"harness":"claude-code","recv_ms":5,"kind":"dropped","reason":"oversize","bytes":9}"#
        );
        assert_eq!(serde_json::from_str::<SpoolRecord>(&wire).unwrap(), r);
        assert_eq!(
            peek_spool_version(br#"{"v":7,"kind":"future_thing"}"#),
            Some(7)
        );
    }

    #[test]
    fn shell_env_record_round_trips() {
        let wire = r#"{"v":1,"harness":"shell","recv_ms":5,"kind":"shell_env","env":{"CODEX_HOME":"/h/c"}}"#;
        let rec: SpoolRecord = serde_json::from_str(wire).unwrap();
        let SpoolBody::ShellEnv { env } = &rec.body else {
            panic!("expected a shell_env body, got {rec:?}");
        };
        assert_eq!(env.get("CODEX_HOME").map(String::as_str), Some("/h/c"));
        assert_eq!(serde_json::to_string(&rec).unwrap(), wire);
    }

    #[test]
    fn config_dir_is_kept_only_when_present() {
        let bare = r#"{"v":1,"harness":"claude-code","recv_ms":5,"kind":"event","event":{"hook_event_name":"SessionStart","session_id":"S1"}}"#;
        let rec: SpoolRecord = serde_json::from_str(bare).unwrap();
        assert_eq!(rec.config_dir, None);
        assert_eq!(serde_json::to_string(&rec).unwrap(), bare);

        let with_dir = r#"{"v":1,"harness":"claude-code","recv_ms":5,"config_dir":"/h/claude","kind":"event","event":{"hook_event_name":"SessionStart","session_id":"S1"}}"#;
        let rec: SpoolRecord = serde_json::from_str(with_dir).unwrap();
        assert_eq!(rec.config_dir.as_deref(), Some("/h/claude"));
        assert_eq!(serde_json::to_string(&rec).unwrap(), with_dir);
    }
}
