//! Allowlisted hook payload parsing.
//!
//! Only the fields in [`HookEvent`] survive; everything else from the hook
//! payload (prompts, diffs, and any tool input that is not captured below) is
//! dropped before serialization. Bash `command` and the tool `description` are
//! captured through [`bound_tool_text`]: redacted, controls mapped to spaces,
//! at most [`TOOL_TEXT_MAX_CHARS`](crate::redact::TOOL_TEXT_MAX_CHARS)
//! characters, and absent when the `desk/tool-text-off` marker exists.

use serde::{Deserialize, Serialize};

use crate::redact::bound_tool_text;

pub const STDIN_CAP: usize = 8 * 1024 * 1024;
pub const ID_CAP: usize = 256;
pub const PATH_CAP: usize = 4096;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HookEvent {
    pub hook_event_name: String,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_use_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcript_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_transcript_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notification_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub truncated: bool,
}

fn is_false(b: &bool) -> bool {
    !b
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DropReason {
    Oversize,
    Parse,
}

#[derive(Deserialize)]
struct Raw {
    hook_event_name: String,
    session_id: String,
    cwd: Option<String>,
    agent_id: Option<String>,
    agent_type: Option<String>,
    tool_name: Option<String>,
    tool_use_id: Option<String>,
    transcript_path: Option<String>,
    agent_transcript_path: Option<String>,
    notification_type: Option<String>,
    tool_input: Option<RawToolInput>,
}

#[derive(Deserialize)]
struct RawToolInput {
    file_path: Option<String>,
    notebook_path: Option<String>,
    command: Option<serde_json::Value>,
    description: Option<serde_json::Value>,
}

fn truncate(s: &str, cap: usize) -> (&str, bool) {
    if s.len() <= cap {
        return (s, false);
    }
    let mut end = cap;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    (&s[..end], true)
}

fn cut(s: String, cap: usize, truncated: &mut bool) -> String {
    let (t, c) = truncate(&s, cap);
    *truncated |= c;
    t.to_owned()
}

fn cut_opt(s: Option<String>, cap: usize, truncated: &mut bool) -> Option<String> {
    s.map(|v| cut(v, cap, truncated))
}

/// Redact, bound, and flag one tool-text value. Non-strings are dropped.
fn bound_text(value: Option<serde_json::Value>, truncated: &mut bool) -> Option<String> {
    let (text, cut) = bound_tool_text(value?.as_str()?);
    *truncated |= cut;
    Some(text)
}

pub fn parse_hook_payload(bytes: &[u8], capture_tool_text: bool) -> Result<HookEvent, DropReason> {
    let raw: Raw = serde_json::from_slice(bytes).map_err(|_| DropReason::Parse)?;
    let mut truncated = false;
    let (target_path, command, description) = raw
        .tool_input
        .map(|t| (t.file_path.or(t.notebook_path), t.command, t.description))
        .unwrap_or_default();
    let (command, description) = if capture_tool_text {
        (
            bound_text(command, &mut truncated),
            bound_text(description, &mut truncated),
        )
    } else {
        (None, None)
    };
    Ok(HookEvent {
        hook_event_name: cut(raw.hook_event_name, ID_CAP, &mut truncated),
        session_id: cut(raw.session_id, ID_CAP, &mut truncated),
        cwd: cut_opt(raw.cwd, PATH_CAP, &mut truncated),
        agent_id: cut_opt(raw.agent_id, ID_CAP, &mut truncated),
        agent_type: cut_opt(raw.agent_type, ID_CAP, &mut truncated),
        tool_name: cut_opt(raw.tool_name, ID_CAP, &mut truncated),
        tool_use_id: cut_opt(raw.tool_use_id, ID_CAP, &mut truncated),
        transcript_path: cut_opt(raw.transcript_path, PATH_CAP, &mut truncated),
        agent_transcript_path: cut_opt(raw.agent_transcript_path, PATH_CAP, &mut truncated),
        notification_type: cut_opt(raw.notification_type, ID_CAP, &mut truncated),
        target_path: cut_opt(target_path, PATH_CAP, &mut truncated),
        command,
        description,
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use crate::hook::{DropReason, ID_CAP, parse_hook_payload};

    const EDIT: &str = r#"{"session_id":"s1","hook_event_name":"PreToolUse","cwd":"C:\\r","tool_name":"Edit","tool_use_id":"t1",
 "tool_input":{"file_path":"C:\\r\\a.ts","old_string":"SECRET_OLD","new_string":"SECRET_NEW"},"prompt":"SECRET_PROMPT"}"#;
    #[test]
    fn forbidden_fields_never_serialize() {
        let e = parse_hook_payload(EDIT.as_bytes(), true).unwrap();
        let out = serde_json::to_string(&e).unwrap();
        for s in [
            "SECRET_OLD",
            "SECRET_NEW",
            "SECRET_PROMPT",
            "old_string",
            "new_string",
            "prompt",
            "tool_input",
        ] {
            assert!(!out.contains(s), "{s} leaked: {out}");
        }
        assert_eq!(e.target_path.as_deref(), Some(r"C:\r\a.ts"));
    }
    #[test]
    fn bash_command_and_description_are_captured_redacted() {
        let raw = r#"{"session_id":"s","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"curl -H \"Authorization: Bearer abcdefghijklmnop\" x","description":"Run x"}}"#;
        let e = parse_hook_payload(raw.as_bytes(), true).unwrap();
        let command = e.command.as_deref().unwrap();
        assert!(
            command.contains("[redacted credential assignment]"),
            "{command}"
        );
        assert!(!command.contains("abcdefghijklmnop"), "{command}");
        assert_eq!(e.description.as_deref(), Some("Run x"));
    }
    #[test]
    fn tool_text_flag_off_drops_both_fields() {
        let raw = r#"{"session_id":"s","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"curl -H \"Authorization: Bearer abcdefghijklmnop\" x","description":"Run x"}}"#;
        let e = parse_hook_payload(raw.as_bytes(), false).unwrap();
        assert!(e.command.is_none() && e.description.is_none());
        let out = serde_json::to_string(&e).unwrap();
        assert!(!out.contains("curl"), "{out}");
    }
    #[test]
    fn non_string_tool_text_is_dropped_not_fatal() {
        for raw in [
            r#"{"session_id":"s","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":5,"description":{"a":1}}}"#,
            r#"{"session_id":"s","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":null,"description":null}}"#,
        ] {
            let e = parse_hook_payload(raw.as_bytes(), true).unwrap();
            assert!(e.command.is_none() && e.description.is_none());
        }
    }
    #[test]
    fn notebook_path_maps_to_target_path() {
        let raw = r#"{"session_id":"s","hook_event_name":"PostToolUse","tool_name":"NotebookEdit","tool_input":{"notebook_path":"C:\\n.ipynb"}}"#;
        assert_eq!(
            parse_hook_payload(raw.as_bytes(), true)
                .unwrap()
                .target_path
                .as_deref(),
            Some(r"C:\n.ipynb")
        );
    }
    #[test]
    fn long_id_truncates_on_char_boundary() {
        let raw = format!(
            r#"{{"session_id":"{}","hook_event_name":"Stop"}}"#,
            "é".repeat(200)
        );
        let e = parse_hook_payload(raw.as_bytes(), true).unwrap();
        assert!(e.session_id.len() <= ID_CAP && e.truncated);
    }
    #[test]
    fn missing_required_or_garbage_is_parse() {
        assert!(matches!(
            parse_hook_payload(br#"{"hook_event_name":"Stop"}"#, true),
            Err(DropReason::Parse)
        ));
        assert!(matches!(
            parse_hook_payload(b"", true),
            Err(DropReason::Parse)
        ));
        assert!(matches!(
            parse_hook_payload(&[0xff, 0xfe, 0x00], true),
            Err(DropReason::Parse)
        ));
        assert!(matches!(
            parse_hook_payload(b"[1,2]", true),
            Err(DropReason::Parse)
        ));
    }
}
