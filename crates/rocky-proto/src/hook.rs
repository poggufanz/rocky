//! Allowlisted hook payload parsing.
//!
//! Only the fields in [`HookEvent`] survive; everything else from the hook
//! payload (diffs and any tool input that is not captured below) is dropped
//! before serialization. Bash `command` and the tool `description` are captured
//! through [`bound_tool_text`]: redacted, controls mapped to spaces, at most
//! [`TOOL_TEXT_MAX_CHARS`](crate::redact::TOOL_TEXT_MAX_CHARS) characters, and
//! absent when the `desk/tool-text-off` marker exists. On `UserPromptSubmit`,
//! `prompt` is captured through [`bound_prompt`]: redacted, controls other than
//! `\n` and `\t` mapped to spaces, at most
//! [`PROMPT_MAX_CHARS`](crate::redact::PROMPT_MAX_CHARS) characters, and absent
//! when the `desk/cards-off` marker exists.

use serde::{Deserialize, Serialize};

use crate::redact::{bound_prompt, bound_tool_text};

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub truncated: bool,
}

/// Which optional payload text fields to retain during parsing.
#[derive(Debug, Clone, Copy)]
pub struct Capture {
    pub tool_text: bool,
    pub prompt: bool,
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
    prompt: Option<serde_json::Value>,
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

/// Redact, bound, and flag one optional text value. Non-strings are dropped.
fn bound_json_text(
    value: Option<serde_json::Value>,
    truncated: &mut bool,
    bound_fn: fn(&str) -> (String, bool),
) -> Option<String> {
    let (text, cut) = bound_fn(value?.as_str()?);
    *truncated |= cut;
    Some(text)
}

pub fn parse_hook_payload(bytes: &[u8], capture: Capture) -> Result<HookEvent, DropReason> {
    let raw: Raw = serde_json::from_slice(bytes).map_err(|_| DropReason::Parse)?;
    let mut truncated = false;
    let (target_path, command, description) = raw
        .tool_input
        .map(|t| (t.file_path.or(t.notebook_path), t.command, t.description))
        .unwrap_or_default();
    let (command, description) = if capture.tool_text {
        (
            bound_json_text(command, &mut truncated, bound_tool_text),
            bound_json_text(description, &mut truncated, bound_tool_text),
        )
    } else {
        (None, None)
    };
    let prompt = if capture.prompt && raw.hook_event_name == "UserPromptSubmit" {
        bound_json_text(raw.prompt, &mut truncated, bound_prompt)
    } else {
        None
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
        prompt,
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use crate::hook::{Capture, DropReason, ID_CAP, parse_hook_payload};

    const ALL_CAPTURE: Capture = Capture {
        tool_text: true,
        prompt: true,
    };

    const EDIT: &str = r#"{"session_id":"s1","hook_event_name":"PreToolUse","cwd":"C:\\r","tool_name":"Edit","tool_use_id":"t1",
 "tool_input":{"file_path":"C:\\r\\a.ts","old_string":"SECRET_OLD","new_string":"SECRET_NEW"},"prompt":"SECRET_PROMPT"}"#;
    #[test]
    fn forbidden_fields_never_serialize() {
        let e = parse_hook_payload(EDIT.as_bytes(), ALL_CAPTURE).unwrap();
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
        let e = parse_hook_payload(raw.as_bytes(), ALL_CAPTURE).unwrap();
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
        let e = parse_hook_payload(
            raw.as_bytes(),
            Capture {
                tool_text: false,
                prompt: true,
            },
        )
        .unwrap();
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
            let e = parse_hook_payload(raw.as_bytes(), ALL_CAPTURE).unwrap();
            assert!(e.command.is_none() && e.description.is_none());
        }
    }
    #[test]
    fn notebook_path_maps_to_target_path() {
        let raw = r#"{"session_id":"s","hook_event_name":"PostToolUse","tool_name":"NotebookEdit","tool_input":{"notebook_path":"C:\\n.ipynb"}}"#;
        assert_eq!(
            parse_hook_payload(raw.as_bytes(), ALL_CAPTURE)
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
        let e = parse_hook_payload(raw.as_bytes(), ALL_CAPTURE).unwrap();
        assert!(e.session_id.len() <= ID_CAP && e.truncated);
    }
    #[test]
    fn missing_required_or_garbage_is_parse() {
        assert!(matches!(
            parse_hook_payload(br#"{"hook_event_name":"Stop"}"#, ALL_CAPTURE),
            Err(DropReason::Parse)
        ));
        assert!(matches!(
            parse_hook_payload(b"", ALL_CAPTURE),
            Err(DropReason::Parse)
        ));
        assert!(matches!(
            parse_hook_payload(&[0xff, 0xfe, 0x00], ALL_CAPTURE),
            Err(DropReason::Parse)
        ));
        assert!(matches!(
            parse_hook_payload(b"[1,2]", ALL_CAPTURE),
            Err(DropReason::Parse)
        ));
    }
    #[test]
    fn prompt_captured_only_on_user_prompt_submit() {
        let submit =
            r#"{"hook_event_name":"UserPromptSubmit","session_id":"s","prompt":"fix the cart"}"#;
        let e = parse_hook_payload(submit.as_bytes(), ALL_CAPTURE).unwrap();
        assert_eq!(e.prompt.as_deref(), Some("fix the cart"));

        let stop = r#"{"hook_event_name":"Stop","session_id":"s","prompt":"fix the cart"}"#;
        let e = parse_hook_payload(stop.as_bytes(), ALL_CAPTURE).unwrap();
        assert_eq!(e.prompt, None);
        let out = serde_json::to_string(&e).unwrap();
        assert!(!out.contains("prompt"), "{out}");
    }
    #[test]
    fn user_prompt_submit_still_drops_edit_content() {
        let raw = r#"{"hook_event_name":"UserPromptSubmit","session_id":"s","prompt":"fix it","tool_input":{"file_path":"a.ts","old_string":"SECRET_OLD","new_string":"SECRET_NEW","content":"SECRET_CONTENT"},"tool_response":"SECRET_RESPONSE"}"#;
        let e = parse_hook_payload(raw.as_bytes(), ALL_CAPTURE).unwrap();
        assert_eq!(e.prompt.as_deref(), Some("fix it"));
        let out = serde_json::to_string(&e).unwrap();
        for forbidden in [
            "SECRET_OLD",
            "SECRET_NEW",
            "SECRET_CONTENT",
            "SECRET_RESPONSE",
            "old_string",
            "new_string",
            "content",
            "tool_response",
        ] {
            assert!(!out.contains(forbidden), "{forbidden} leaked: {out}");
        }
    }
    #[test]
    fn prompt_is_redacted() {
        let raw = r#"{"hook_event_name":"UserPromptSubmit","session_id":"s","prompt":"use ghp_abcdefghijklmnopqrstuvwxyz0123456789 now"}"#;
        let e = parse_hook_payload(raw.as_bytes(), ALL_CAPTURE).unwrap();
        let prompt = e.prompt.as_deref().unwrap();
        assert!(!prompt.contains("ghp_"), "{prompt}");
        assert!(prompt.contains("[redacted github token]"), "{prompt}");
    }
    #[test]
    fn prompt_is_cut_to_1000_chars() {
        let long = format!(
            r#"{{"hook_event_name":"UserPromptSubmit","session_id":"s","prompt":"{}"}}"#,
            "é".repeat(1500)
        );
        let e = parse_hook_payload(long.as_bytes(), ALL_CAPTURE).unwrap();
        assert_eq!(e.prompt.as_deref().unwrap().chars().count(), 1000);
        assert!(e.truncated);

        let short = format!(
            r#"{{"hook_event_name":"UserPromptSubmit","session_id":"s","prompt":"{}"}}"#,
            "é".repeat(999)
        );
        let e = parse_hook_payload(short.as_bytes(), ALL_CAPTURE).unwrap();
        assert_eq!(e.prompt.as_deref().unwrap().chars().count(), 999);
        assert!(!e.truncated);
    }
    #[test]
    fn prompt_keeps_newlines_maps_other_controls() {
        // Non-escape C0 controls map to spaces while \n and \t survive.
        let bel = r#"{"hook_event_name":"UserPromptSubmit","session_id":"s","prompt":"a\nb\tc\u0007d\re"}"#;
        let e = parse_hook_payload(bel.as_bytes(), ALL_CAPTURE).unwrap();
        assert_eq!(e.prompt.as_deref(), Some("a\nb\tc d e"));
        assert!(!e.truncated);

        // Escape sequences are stripped by boundary redaction before control mapping.
        let esc_fe = r#"{"hook_event_name":"UserPromptSubmit","session_id":"s","prompt":"a\nb\tc\u001bd\re"}"#;
        let e = parse_hook_payload(esc_fe.as_bytes(), ALL_CAPTURE).unwrap();
        assert_eq!(e.prompt.as_deref(), Some("a\nb\tc e"));

        let csi = r#"{"hook_event_name":"UserPromptSubmit","session_id":"s","prompt":"a\nb\tc\u001b[31md\re"}"#;
        let e = parse_hook_payload(csi.as_bytes(), ALL_CAPTURE).unwrap();
        assert_eq!(e.prompt.as_deref(), Some("a\nb\tcd e"));
    }
    #[test]
    fn prompt_secret_at_scan_cut_is_redacted() {
        let prompt = format!(
            "{}ghp_abcdefghijklmnopqrstuvwxyz0123456789",
            "x ".repeat(8190)
        );
        let raw = serde_json::to_vec(&serde_json::json!({
            "hook_event_name": "UserPromptSubmit",
            "session_id": "s",
            "prompt": prompt,
        }))
        .unwrap();
        let e = parse_hook_payload(&raw, ALL_CAPTURE).unwrap();
        let captured = e.prompt.as_deref().unwrap();
        assert!(!captured.contains("ghp_"), "{captured}");
        assert!(e.truncated);
    }
    #[test]
    fn non_string_prompt_is_ignored() {
        for prompt in [
            serde_json::json!(5),
            serde_json::json!({}),
            serde_json::json!([]),
            serde_json::Value::Null,
        ] {
            let raw = serde_json::to_vec(&serde_json::json!({
                "hook_event_name": "UserPromptSubmit",
                "session_id": "s",
                "prompt": prompt,
            }))
            .unwrap();
            let e = parse_hook_payload(&raw, ALL_CAPTURE).unwrap();
            assert_eq!(e.prompt, None);
        }
    }
    #[test]
    fn capture_prompt_false_drops_prompt() {
        let raw =
            r#"{"hook_event_name":"UserPromptSubmit","session_id":"s","prompt":"fix the cart"}"#;
        let e = parse_hook_payload(
            raw.as_bytes(),
            Capture {
                tool_text: true,
                prompt: false,
            },
        )
        .unwrap();
        assert_eq!(e.prompt, None);
        let out = serde_json::to_string(&e).unwrap();
        assert!(
            !out.contains("prompt") && !out.contains("fix the cart"),
            "{out}"
        );
    }
}
