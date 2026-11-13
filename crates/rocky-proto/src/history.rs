//! Desk history file lines: one JSON object per line.

use serde::{Deserialize, Serialize};

use crate::hook::HookEvent;
use crate::pipe::Gap;

pub const HISTORY_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HistoryLine {
    pub v: u32,
    #[serde(flatten)]
    pub body: HistoryBody,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub src: Option<String>,
}

// A gap is far smaller than an event; history lines are stack-local and
// short-lived once decoded, so boxing the common event is not worth it.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum HistoryBody {
    Event {
        harness: String,
        recv_ms: u64,
        event: HookEvent,
    },
    Gap(Gap),
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipe::GapReason;

    #[test]
    fn gap_line_wire_shape() {
        let l = HistoryLine {
            v: 1,
            body: HistoryBody::Gap(Gap {
                from_ms: 1,
                to_ms: 2,
                count: 3,
                reason: GapReason::SpoolFull,
            }),
            src: None,
        };
        assert_eq!(
            serde_json::to_string(&l).unwrap(),
            r#"{"v":1,"kind":"gap","from_ms":1,"to_ms":2,"count":3,"reason":"spool_full"}"#
        );
    }

    #[test]
    fn event_line_roundtrips_with_src() {
        let event = HookEvent {
            hook_event_name: "PreToolUse".into(),
            session_id: "s1".into(),
            cwd: None,
            agent_id: None,
            agent_type: None,
            tool_name: Some("Bash".into()),
            tool_use_id: None,
            transcript_path: None,
            agent_transcript_path: None,
            notification_type: None,
            target_path: None,
            command: None,
            description: None,
            prompt: None,
            truncated: false,
        };
        let l = HistoryLine {
            v: HISTORY_VERSION,
            body: HistoryBody::Event {
                harness: "claude-code".into(),
                recv_ms: 5,
                event,
            },
            src: Some("0000000000005-1.json".into()),
        };
        let json = serde_json::to_string(&l).unwrap();
        assert!(json.contains(r#""kind":"event""#), "{json}");
        assert!(json.contains(r#""src":"0000000000005-1.json""#), "{json}");
        assert_eq!(serde_json::from_str::<HistoryLine>(&json).unwrap(), l);
    }
}
