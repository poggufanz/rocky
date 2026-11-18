//! Command failure parsing for failed Bash and PowerShell hook events.

use std::sync::OnceLock;

use regex_lite::Regex;

use crate::redact::bound_tool_text;

/// Maximum bytes of raw `error` text inspected for exit code and head line.
pub const ERROR_SCAN_BYTES: usize = 16 * 1024;

const SIGNAL_PATTERN: &str = "(?i)error|exception|fail|fatal|cannot|unable|not found|missing|denied|refused|invalid|unexpected|undefined|panic|traceback";

fn signal_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(SIGNAL_PATTERN).expect("signal pattern is valid"))
}

fn parse_exit_code_line(line: &str) -> Option<i32> {
    let rest = line.strip_prefix("Exit code ")?;
    let digits = rest.strip_prefix('-').unwrap_or(rest);
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    rest.parse::<i32>().ok()
}

/// Returns `true` for the command-executing tools whose failure output we parse.
pub fn is_command_tool(tool_name: &str) -> bool {
    matches!(tool_name, "Bash" | "PowerShell")
}

/// Extract an optional exit code and bounded, redacted head error line from `error`.
pub fn parse_command_failure(error: &str, keep_text: bool) -> (Option<i32>, Option<String>) {
    let mut end = error.len().min(ERROR_SCAN_BYTES);
    while !error.is_char_boundary(end) {
        end -= 1;
    }
    let prefix = &error[..end];

    let mut lines = prefix
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line).trim());

    let mut first_remaining: Option<&str> = None;
    let exit_code = match lines.next() {
        Some(first) => {
            if let Some(code) = parse_exit_code_line(first) {
                Some(code)
            } else {
                first_remaining = Some(first);
                None
            }
        }
        None => None,
    };

    if !keep_text {
        return (exit_code, None);
    }

    let mut fallback: Option<&str> = None;
    let mut chosen: Option<&str> = None;
    for line in first_remaining.into_iter().chain(lines) {
        if line.is_empty() {
            continue;
        }
        if signal_regex().is_match(line) {
            chosen = Some(line);
            break;
        }
        fallback = Some(line);
    }

    let error_head = chosen.or(fallback).map(|line| bound_tool_text(line).0);
    (exit_code, error_head)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::redact::TOOL_TEXT_MAX_CHARS;

    #[test]
    fn exit_code_from_first_line() {
        let (code, head) =
            parse_command_failure("Exit code 1\nError: Cannot find module 'express'", true);
        assert_eq!(code, Some(1));
        assert_eq!(head.as_deref(), Some("Error: Cannot find module 'express'"));
    }
    #[test]
    fn signal_line_beats_banner() {
        let e = "Exit code 1\n> rocky@1.0.0 test\n> node scripts/test.mjs\n✗ auth.test.ts rejects expired token: expected 401, got 200\n1 failing";
        assert_eq!(
            parse_command_failure(e, true).1.as_deref(),
            Some("1 failing")
        );
    }
    #[test]
    fn signal_line_beats_trailing_non_signal() {
        let e = "Exit code 1\n> rocky@1.0.0 test\nError: auth.test.ts expired token\nsee log for details";
        assert_eq!(
            parse_command_failure(e, true).1.as_deref(),
            Some("Error: auth.test.ts expired token")
        );
    }
    #[test]
    fn falls_back_to_last_non_empty_line() {
        assert_eq!(
            parse_command_failure("Exit code 3\nfirst\nlast\n\n", true)
                .1
                .as_deref(),
            Some("last")
        );
    }
    #[test]
    fn crlf_is_handled() {
        let (code, head) =
            parse_command_failure("Exit code 2\r\nfatal: not a git repository\r\n", true);
        assert_eq!(code, Some(2));
        assert_eq!(head.as_deref(), Some("fatal: not a git repository"));
    }
    #[test]
    fn no_exit_line_still_picks_head() {
        let (code, head) = parse_command_failure(
            "Get-Item : Cannot find path 'C:\\x' because it does not exist.",
            true,
        );
        assert_eq!(code, None);
        assert!(head.unwrap().starts_with("Get-Item : Cannot find path"));
    }
    #[test]
    fn secret_on_signal_line_is_redacted() {
        let (_, head) = parse_command_failure(
            "Exit code 1\nerror: curl -H \"Authorization: Bearer abcdefghijklmnop\" failed",
            true,
        );
        let head = head.unwrap();
        assert!(!head.contains("abcdefghijklmnop"), "{head}");
    }
    #[test]
    fn huge_multibyte_output_is_bounded() {
        // 12-byte prefix + 3-byte chars ensures ERROR_SCAN_BYTES (16 KiB) lands mid-character.
        let e = format!("Exit code 1\n{}", "€".repeat(40 * 1024));
        let (code, head) = parse_command_failure(&e, true);
        assert_eq!(code, Some(1));
        let head = head.unwrap();
        assert!(head.chars().count() <= TOOL_TEXT_MAX_CHARS);
        assert!(!head.is_empty());
    }
    #[test]
    fn keep_text_false_drops_head_keeps_code() {
        assert_eq!(
            parse_command_failure("Exit code 1\nerror: x", false),
            (Some(1), None)
        );
    }
    #[test]
    fn command_tools_only() {
        assert!(is_command_tool("Bash") && is_command_tool("PowerShell"));
        assert!(!is_command_tool("Edit") && !is_command_tool("bash"));
    }
}
