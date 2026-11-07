//! Secret redaction for text that crosses a log or tool-capture boundary.
//!
//! Terminal escape sequences and invisible format controls are removed before
//! matching. CR, LF, and TAB are removed from the matching view as well and
//! recorded, so a replacement can disclose that a logical record boundary was
//! swallowed instead of hiding it. Complete secret families are replaced; when
//! the caller knows its input may be a bounded prefix, a family fragment that
//! ends at the end of the input is scrubbed too.
//!
//! Two known differences from the reference implementation are accepted:
//!
//! - Counted quantifiers such as `{4,}` count Unicode scalar values, while the
//!   reference counts UTF-16 code units. A secret value built from characters
//!   outside the Basic Multilingual Plane (emoji, for example) can therefore
//!   stay untouched here while the reference redacts it. The shared vectors
//!   exclude that case.
//! - The reference also exposes secret-kind detection and its placeholder
//!   filtering for other callers. Neither participates in boundary redaction,
//!   so neither is ported here.
//!
//! Whitespace in the patterns is spelled out to the reference `\s` set instead
//! of using the engine's `\s`. The lighter engine matches only ASCII for `\s`,
//! while the reference set also covers the Unicode spaces; the shared vectors
//! pin that parity. The scoped case-insensitive flag is ASCII-only in the
//! lighter engine, which matches the ASCII keywords used here.
//!
//! Patterns are compiled lazily, one family at a time, and only when text is
//! actually redacted and the family's mandatory literal occurs in that text.
//! No function in this module may panic on arbitrary input.

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use regex_lite::Regex;

/// Bytes of raw text inspected by [`bound_tool_text`].
pub const TOOL_TEXT_SCAN_BYTES: usize = 4096;
/// Characters kept by [`bound_tool_text`].
pub const TOOL_TEXT_MAX_CHARS: usize = 200;

const AMBIGUOUS_SECRET_CONTINUATION: &str = "[redacted ambiguous continuation]";

/// The reference `\s` set, spelled out: the lighter engine's `\s` is ASCII
/// only (`[\t\n\v\f\r ]`), while the reference implementation also covers the
/// Unicode spaces below. One definition keeps every pattern on one set.
macro_rules! reference_whitespace {
    () => {
        r"\t\n\x0B\x0C\r \x{00A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}"
    };
}

/// The same set as a standalone bracketed class.
macro_rules! whitespace_class {
    () => {
        concat!("[", reference_whitespace!(), "]")
    };
}

struct SecretDefinition {
    label: &'static str,
    source: &'static str,
    leading_boundary: bool,
    trailing_boundary: bool,
    fragment_source: &'static str,
    assignment: bool,
    /// Literal every full and fragment match must contain, matched as written.
    /// A family without its literal in the text cannot match.
    anchors: &'static [&'static str],
    /// Same, for keywords the patterns match with ASCII case folding; checked
    /// against one lowercased copy of the matching view.
    lowercase_anchors: &'static [&'static str],
    full: OnceLock<Regex>,
    fragment: OnceLock<Regex>,
}

impl SecretDefinition {
    /// Whether the family's mandatory literal occurs, so compiling its pattern
    /// is worth doing. This is a necessary condition, not a match test.
    fn may_match(&self, text: &str, lowered: &str) -> bool {
        self.anchors.iter().any(|anchor| text.contains(anchor))
            || self
                .lowercase_anchors
                .iter()
                .any(|anchor| lowered.contains(anchor))
    }

    fn full_pattern(&self) -> &Regex {
        self.full
            .get_or_init(|| Regex::new(self.source).expect("secret definition patterns are valid"))
    }

    fn fragment_pattern(&self) -> &Regex {
        self.fragment.get_or_init(|| {
            Regex::new(self.fragment_source).expect("secret fragment patterns are valid")
        })
    }
}

/// Canonical secret families, in replacement order.
///
/// Patterns match the normalized view only, where C0/C1 controls (including
/// U+0085) and the invisible set (including U+FEFF) are already absent. The
/// whitespace class is the reference `\s` set spelled out, so it covers the
/// same characters whether or not the engine's own `\s` is Unicode-aware.
/// Case-insensitive keywords use a scoped ASCII-only flag; there is no global
/// `(?i)`.
static SECRET_DEFINITIONS: [SecretDefinition; 9] = [
    SecretDefinition {
        label: "aws access key",
        source: r"AKIA[0-9A-Z]{16}",
        leading_boundary: true,
        trailing_boundary: true,
        fragment_source: r"AKIA[0-9A-Z]{8,}",
        assignment: false,
        anchors: &["AKIA"],
        lowercase_anchors: &[],
        full: OnceLock::new(),
        fragment: OnceLock::new(),
    },
    SecretDefinition {
        label: "private key",
        source: r"-----BEGIN [A-Z ]*PRIVATE KEY-----",
        leading_boundary: false,
        trailing_boundary: false,
        fragment_source: r"-----BEGIN[ A-Za-z0-9_-]*",
        assignment: false,
        anchors: &["-----BEGIN"],
        lowercase_anchors: &[],
        full: OnceLock::new(),
        fragment: OnceLock::new(),
    },
    SecretDefinition {
        label: "github token",
        source: r"(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}",
        leading_boundary: true,
        trailing_boundary: true,
        fragment_source: r"(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{4,}|github_pat_[A-Za-z0-9_]{4,}",
        assignment: false,
        anchors: &["gh"],
        lowercase_anchors: &[],
        full: OnceLock::new(),
        fragment: OnceLock::new(),
    },
    SecretDefinition {
        label: "slack token",
        source: r"xox[baprs]-[A-Za-z0-9-]{10,}",
        leading_boundary: true,
        trailing_boundary: true,
        fragment_source: r"xox[baprs]-[A-Za-z0-9-]{4,}",
        assignment: false,
        anchors: &["xox"],
        lowercase_anchors: &[],
        full: OnceLock::new(),
        fragment: OnceLock::new(),
    },
    SecretDefinition {
        label: "anthropic key",
        source: r"sk-ant-[A-Za-z0-9_-]{20,}",
        leading_boundary: true,
        trailing_boundary: true,
        fragment_source: r"sk-ant-[A-Za-z0-9_-]{3,}",
        assignment: false,
        anchors: &["sk-ant-"],
        lowercase_anchors: &[],
        full: OnceLock::new(),
        fragment: OnceLock::new(),
    },
    SecretDefinition {
        label: "openai key",
        source: r"sk-[A-Za-z0-9_-]{20,}",
        leading_boundary: true,
        trailing_boundary: true,
        fragment_source: r"sk-[A-Za-z0-9_-]{3,}",
        assignment: false,
        anchors: &["sk-"],
        lowercase_anchors: &[],
        full: OnceLock::new(),
        fragment: OnceLock::new(),
    },
    SecretDefinition {
        label: "npm token",
        source: r"npm_[A-Za-z0-9]{36}",
        leading_boundary: true,
        trailing_boundary: true,
        fragment_source: r"npm_[A-Za-z0-9_]{8,}",
        assignment: false,
        anchors: &["npm_"],
        lowercase_anchors: &[],
        full: OnceLock::new(),
        fragment: OnceLock::new(),
    },
    SecretDefinition {
        label: "password assignment",
        source: concat!(
            r#"(?:(?:"(?i:password|secret)"|'(?i:password|secret)'|(?i:password|secret)))"#,
            whitespace_class!(),
            r#"*[:=]"#,
            whitespace_class!(),
            r#"*(?:"(?P<dq>[^'"\r\n]{4,})"|'(?P<sq>[^'"\r\n]{4,})'|(?P<uq>[^"#,
            reference_whitespace!(),
            r#"'`",;]{4,}))"#,
        ),
        leading_boundary: true,
        trailing_boundary: false,
        fragment_source: concat!(
            r#"(?:(?:"(?i:password|secret)"|'(?i:password|secret)'|(?i:password|secret)))"#,
            whitespace_class!(),
            r#"*[:=]"#,
            whitespace_class!(),
            r#"*(?:["'][^"']*|[^"#,
            reference_whitespace!(),
            r#"]*)"#,
        ),
        assignment: true,
        anchors: &[],
        lowercase_anchors: &["password", "secret"],
        full: OnceLock::new(),
        fragment: OnceLock::new(),
    },
    SecretDefinition {
        label: "credential assignment",
        source: concat!(
            r#"(?:(?:"(?i:token|api[_-]?key|authorization)"|'(?i:token|api[_-]?key|authorization)'|(?i:token|api[_-]?key|authorization)))"#,
            whitespace_class!(),
            r#"*[:=]"#,
            whitespace_class!(),
            r#"*(?:"(?P<dq>[^'"\r\n]{4,})"|'(?P<sq>[^'"\r\n]{4,})'|(?P<uq>(?:(?i:Bearer|Basic|Token)"#,
            whitespace_class!(),
            r#"+)?[^"#,
            reference_whitespace!(),
            r#"'`",;]{4,}))"#,
        ),
        leading_boundary: true,
        trailing_boundary: false,
        fragment_source: concat!(
            r#"(?:(?:"(?i:token|api[_-]?key|authorization)"|'(?i:token|api[_-]?key|authorization)'|(?i:token|api[_-]?key|authorization)))"#,
            whitespace_class!(),
            r#"*[:=]"#,
            whitespace_class!(),
            r#"*(?:["'][^"']*|(?:(?i:Bearer|Basic|Token)"#,
            whitespace_class!(),
            r#"+)?[^"#,
            reference_whitespace!(),
            r#"]*)"#,
        ),
        assignment: true,
        anchors: &[],
        lowercase_anchors: &["token", "api", "authorization"],
        full: OnceLock::new(),
        fragment: OnceLock::new(),
    },
];

const ESC: u32 = 0x1b;
const BEL: u32 = 0x07;
const ST: u32 = 0x9c;
const CSI_8BIT: u32 = 0x9b;
const SS2_8BIT: u32 = 0x8e;
const SS3_8BIT: u32 = 0x8f;
const OSC_8BIT: u32 = 0x9d;
const DCS_8BIT: u32 = 0x90;
const SOS_8BIT: u32 = 0x98;
const PM_8BIT: u32 = 0x9e;
const APC_8BIT: u32 = 0x9f;

/// The character starting at `offset`, or `None` at or past the end.
fn next_char(text: &str, offset: usize) -> Option<char> {
    text.get(offset..).and_then(|rest| rest.chars().next())
}

fn is_control_string_start(code: u32) -> bool {
    matches!(code, OSC_8BIT | DCS_8BIT | SOS_8BIT | PM_8BIT | APC_8BIT)
}

fn is_c0_or_c1(code: u32) -> bool {
    code <= 0x1f || code == 0x7f || (0x80..=0x9f).contains(&code)
}

fn is_invisible_control(character: char) -> bool {
    matches!(
        character,
        '\u{061C}'
            | '\u{200B}'..='\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{206F}'
            | '\u{FEFF}'
    )
}

fn consume_csi(text: &str, start: usize) -> usize {
    let mut offset = start;
    while let Some(character) = next_char(text, offset) {
        if (0x30..=0x3f).contains(&(character as u32)) {
            offset += character.len_utf8();
        } else {
            break;
        }
    }
    while let Some(character) = next_char(text, offset) {
        if (0x20..=0x2f).contains(&(character as u32)) {
            offset += character.len_utf8();
        } else {
            break;
        }
    }
    match next_char(text, offset) {
        Some(character) if (0x40..=0x7e).contains(&(character as u32)) => {
            offset + character.len_utf8()
        }
        // An unterminated sequence is still untrusted payload: consume the tail.
        _ => text.len(),
    }
}

fn consume_control_string(text: &str, start: usize, terminates_at_bel: bool) -> usize {
    let mut offset = start;
    while let Some(character) = next_char(text, offset) {
        let code = character as u32;
        if (terminates_at_bel && code == BEL) || code == ST {
            return offset + character.len_utf8();
        }
        if code == ESC && next_char(text, offset + 1) == Some('\\') {
            return offset + 2;
        }
        offset += character.len_utf8();
    }
    // A missing terminator must not expose its payload to later matching.
    text.len()
}

fn consume_escape(text: &str, start: usize) -> usize {
    let Some(next) = next_char(text, start + 1) else {
        return start + 1;
    };
    let code = next as u32;
    if code == 0x5b {
        return consume_csi(text, start + 2);
    }
    if code == 0x4e || code == 0x4f {
        return consume_shifted_graphic(text, start + 1);
    }
    if matches!(code, 0x5d | 0x50 | 0x58 | 0x5e | 0x5f) {
        return consume_control_string(text, start + 2, code == 0x5d);
    }
    if (0x20..=0x2f).contains(&code) {
        let mut offset = start + 2;
        while let Some(character) = next_char(text, offset) {
            if (0x20..=0x2f).contains(&(character as u32)) {
                offset += character.len_utf8();
            } else {
                break;
            }
        }
        return match next_char(text, offset) {
            Some(character) if (0x30..=0x7e).contains(&(character as u32)) => {
                offset + character.len_utf8()
            }
            _ => offset,
        };
    }
    // Standard two-byte ESC Fe sequences (and unknown ESC payload) go as a unit.
    if (0x40..=0x7e).contains(&code) {
        start + 2
    } else {
        start + 1
    }
}

fn consume_shifted_graphic(text: &str, introducer: usize) -> usize {
    let introducer_len = next_char(text, introducer).map_or(0, char::len_utf8);
    let next_start = introducer + introducer_len;
    match next_char(text, next_start) {
        Some(character) => next_start + character.len_utf8(),
        None => text.len(),
    }
}

struct NormalizedInput {
    /// Matching view: controls, escape sequences, and invisible characters gone.
    text: String,
    /// Display view: logical controls preserved, single C0/C1 replaced by spaces.
    display_text: String,
    /// Matching-view byte offsets where something was removed.
    removed_offsets: HashSet<usize>,
    /// Matching-view byte offset to display-view byte offset, per kept start.
    display_starts: HashMap<usize, usize>,
    /// Matching-view byte offset to display-view byte offset, per kept end.
    display_ends: HashMap<usize, usize>,
    /// Removed CR/LF/TAB characters and their matching-view byte offsets.
    logical_controls: Vec<(usize, char)>,
}

fn normalize_secret_boundary_input(text: &str) -> NormalizedInput {
    let mut normalized = NormalizedInput {
        text: String::new(),
        display_text: String::new(),
        removed_offsets: HashSet::new(),
        display_starts: HashMap::new(),
        display_ends: HashMap::new(),
        logical_controls: Vec::new(),
    };
    let mut source = 0;
    let mut matching = 0;
    let mut display = 0;

    while let Some(character) = next_char(text, source) {
        let code = character as u32;
        let mut end = source;
        let mut is_sequence = false;
        if code == ESC {
            end = consume_escape(text, source);
            is_sequence = true;
        } else if code == CSI_8BIT {
            end = consume_csi(text, source + character.len_utf8());
            is_sequence = true;
        } else if code == SS2_8BIT || code == SS3_8BIT {
            end = consume_shifted_graphic(text, source);
            is_sequence = true;
        } else if is_control_string_start(code) {
            end = consume_control_string(text, source + character.len_utf8(), code == OSC_8BIT);
            is_sequence = true;
        } else if is_c0_or_c1(code) {
            end = source + character.len_utf8();
        }

        if end != source {
            let is_logical_control = matches!(code, 0x09 | 0x0a | 0x0d);
            normalized.removed_offsets.insert(matching);
            if is_logical_control {
                normalized.logical_controls.push((matching, character));
                normalized.display_text.push(character);
                display += character.len_utf8();
            } else if !is_sequence {
                normalized.display_text.push(' ');
                display += 1;
            }
            source = end;
            continue;
        }

        if is_invisible_control(character) {
            normalized.removed_offsets.insert(matching);
            source += character.len_utf8();
            continue;
        }

        normalized.display_starts.insert(matching, display);
        normalized.text.push(character);
        normalized.display_text.push(character);
        matching += character.len_utf8();
        display += character.len_utf8();
        normalized.display_ends.insert(matching, display);
        source += character.len_utf8();
    }

    normalized
}

enum MatchShape {
    Standalone,
    Assignment { quoted: bool, value_start: usize },
}

struct Replacement {
    start: usize,
    end: usize,
    value: String,
    order: usize,
    shape: MatchShape,
}

fn is_ascii_word(character: Option<char>) -> bool {
    matches!(character, Some(character) if character.is_ascii_alphanumeric() || character == '_')
}

fn has_leading_boundary(text: &str, start: usize) -> bool {
    !is_ascii_word(
        text.get(..start)
            .and_then(|prefix| prefix.chars().next_back()),
    )
}

fn has_trailing_boundary(text: &str, end: usize) -> bool {
    !is_ascii_word(text.get(end..).and_then(|suffix| suffix.chars().next()))
}

fn assignment_shape(
    definition: &SecretDefinition,
    captures: &regex_lite::Captures<'_>,
) -> MatchShape {
    if !definition.assignment {
        return MatchShape::Standalone;
    }
    if let Some(value) = captures.name("dq").or_else(|| captures.name("sq")) {
        return MatchShape::Assignment {
            quoted: true,
            value_start: value.start(),
        };
    }
    match captures.name("uq") {
        Some(value) => MatchShape::Assignment {
            quoted: false,
            value_start: value.start(),
        },
        // Full assignment patterns always select one registered value group.
        None => MatchShape::Standalone,
    }
}

fn passes_full_boundaries(
    definition: &SecretDefinition,
    text: &str,
    removed_offsets: &HashSet<usize>,
    start: usize,
    end: usize,
) -> bool {
    let normal_leading = !definition.leading_boundary || has_leading_boundary(text, start);
    let normal_trailing = !definition.trailing_boundary || has_trailing_boundary(text, end);
    let recorded_leading = !definition.leading_boundary || removed_offsets.contains(&start);
    let recorded_trailing = !definition.trailing_boundary || removed_offsets.contains(&end);
    (normal_leading || recorded_leading) && (normal_trailing || recorded_trailing)
}

fn collect_replacements(normalized: &NormalizedInput, may_be_truncated: bool) -> Vec<Replacement> {
    let text = &normalized.text;
    let removed_offsets = &normalized.removed_offsets;
    let lowered = text.to_ascii_lowercase();
    let mut replacements = Vec::new();

    for (order, definition) in SECRET_DEFINITIONS.iter().enumerate() {
        if !definition.may_match(text, &lowered) {
            continue;
        }
        for captures in definition.full_pattern().captures_iter(text) {
            let matched = captures.get(0).expect("a match always has group zero");
            let start = matched.start();
            let end = matched.end();
            if !passes_full_boundaries(definition, text, removed_offsets, start, end) {
                continue;
            }
            replacements.push(Replacement {
                start,
                end,
                value: format!("[redacted {}]", definition.label),
                order,
                shape: assignment_shape(definition, &captures),
            });
        }
    }

    if !may_be_truncated {
        return replacements;
    }

    for (order, definition) in SECRET_DEFINITIONS.iter().enumerate() {
        if !definition.may_match(text, &lowered) {
            continue;
        }
        for matched in definition.fragment_pattern().find_iter(text) {
            // Only a fragment touching the end of the input can be the tail of
            // a value that was cut at the caller's cap.
            if matched.end() != text.len() {
                continue;
            }
            let start = matched.start();
            let normal_leading = !definition.leading_boundary || has_leading_boundary(text, start);
            let recorded_leading = !definition.leading_boundary || removed_offsets.contains(&start);
            if !normal_leading && !recorded_leading {
                continue;
            }
            replacements.push(Replacement {
                start,
                end: matched.end(),
                value: String::new(),
                order: SECRET_DEFINITIONS.len() + order,
                shape: MatchShape::Standalone,
            });
        }
    }

    replacements
}

fn preserve_logical_controls(replacement: &Replacement, normalized: &NormalizedInput) -> String {
    let mut value = replacement.value.clone();
    for (offset, character) in &normalized.logical_controls {
        if *offset <= replacement.start || *offset >= replacement.end {
            continue;
        }
        let ambiguous = match replacement.shape {
            MatchShape::Standalone => true,
            MatchShape::Assignment {
                quoted,
                value_start,
            } => !quoted && *offset >= value_start,
        };
        value.push(*character);
        if ambiguous {
            value.push_str(AMBIGUOUS_SECRET_CONTINUATION);
        }
    }
    value
}

/// Replace complete secrets, optionally including a fragment cut at end of input.
pub fn redact_secrets_at_boundary(text: &str, may_be_truncated: bool) -> String {
    if text.is_empty() {
        return String::new();
    }
    let normalized = normalize_secret_boundary_input(text);
    let mut replacements = collect_replacements(&normalized, may_be_truncated);
    replacements.sort_by(|left, right| {
        left.start
            .cmp(&right.start)
            .then(right.end.cmp(&left.end))
            .then(left.order.cmp(&right.order))
    });

    let mut selected: Vec<&Replacement> = Vec::new();
    for replacement in &replacements {
        if selected
            .iter()
            .any(|chosen| replacement.end > chosen.start && replacement.start < chosen.end)
        {
            continue;
        }
        selected.push(replacement);
    }

    let structured: Vec<(usize, usize, String)> = selected
        .iter()
        .map(|replacement| {
            (
                replacement.start,
                replacement.end,
                preserve_logical_controls(replacement, &normalized),
            )
        })
        .collect();

    let NormalizedInput {
        display_text: mut out,
        display_starts,
        display_ends,
        ..
    } = normalized;

    for (start, end, value) in structured.into_iter().rev() {
        let display_start = display_starts.get(&start).copied().unwrap_or(start);
        let display_end = display_ends.get(&end).copied().unwrap_or(end);
        // A match always maps to kept characters. Guard the splice anyway: this
        // runs inside a latency-bounded hook and must never panic.
        if display_start <= display_end
            && out.is_char_boundary(display_start)
            && out.is_char_boundary(display_end)
        {
            out.replace_range(display_start..display_end, &value);
        }
    }
    out
}

fn is_mapped_control(character: char) -> bool {
    let code = character as u32;
    code <= 0x1f || (0x7f..=0x9f).contains(&code)
}

/// Cut to the scan cap, redact the raw prefix, and map controls to spaces.
fn bound_tool_text_step(raw: &str) -> (String, bool) {
    let mut end = raw.len().min(TOOL_TEXT_SCAN_BYTES);
    while !raw.is_char_boundary(end) {
        end -= 1;
    }
    let redacted = redact_secrets_at_boundary(&raw[..end], true);
    let mapped: String = redacted
        .chars()
        .map(|character| {
            if is_mapped_control(character) {
                ' '
            } else {
                character
            }
        })
        .collect();
    (mapped, end < raw.len())
}

/// Bound a tool-text field for capture: scan cap, redaction, control mapping,
/// then character cap.
///
/// Redaction runs before control mapping so terminal escape sequences cannot
/// break a secret's word boundary and leave the token readable.
///
/// Returns the bounded text and whether either cut removed anything.
pub fn bound_tool_text(raw: &str) -> (String, bool) {
    let (redacted, mut was_cut) = bound_tool_text_step(raw);
    let mut text = redacted;
    if let Some((index, _)) = text.char_indices().nth(TOOL_TEXT_MAX_CHARS) {
        text.truncate(index);
        was_cut = true;
    }
    (text, was_cut)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bound_tool_text_redacts_before_the_char_cut() {
        let raw = format!(
            "{} ghp_{}{}",
            "x".repeat(189),
            "a".repeat(36),
            "y".repeat(20)
        );
        assert_eq!(raw.len(), 250);
        let (text, was_cut) = bound_tool_text(&raw);
        assert!(!text.contains("ghp_"));
        assert!(text.chars().count() <= TOOL_TEXT_MAX_CHARS);
        assert!(text.contains("[redacted "));
        assert!(was_cut);
    }

    #[test]
    fn bound_tool_text_drops_a_secret_split_by_the_byte_cut() {
        assert_eq!(redact_secrets_at_boundary("ghp_abcdef", true), "");
        let raw = format!(
            "{}ghp_abcdefghijklmnopqrstuvwxyz",
            " ".repeat(TOOL_TEXT_SCAN_BYTES - 10)
        );
        let (text, was_cut) = bound_tool_text_step(&raw);
        assert!(was_cut);
        assert!(!text.contains("ghp_"));
        assert!(!text.contains("abcdef"));
        assert!(text.trim_end().is_empty(), "unexpected tail: {text:?}");
    }

    #[test]
    fn bound_tool_text_maps_controls_to_spaces() {
        assert_eq!(
            bound_tool_text("a\u{1b}[31mb\tc"),
            ("ab c".to_string(), false)
        );
        assert_eq!(bound_tool_text("a\u{7}b"), ("a b".to_string(), false));
    }

    #[test]
    fn bound_tool_text_redacts_tokens_glued_to_terminal_sequences() {
        let token = "a".repeat(36);
        for raw in [
            format!("\u{1b}[31mghp_{token} done"),
            format!("\u{1b}]0;t\u{7}ghp_{token}"),
            format!("\u{9b}31mghp_{token}"),
        ] {
            let (text, _) = bound_tool_text(&raw);
            assert!(!text.contains("ghp_"), "{raw:?} -> {text:?}");
            assert!(
                text.contains("[redacted github token]"),
                "{raw:?} -> {text:?}"
            );
        }
    }

    #[test]
    fn bound_tool_text_cuts_on_char_boundaries() {
        let raw = format!("{}éb", "a".repeat(TOOL_TEXT_SCAN_BYTES - 1));
        let (text, was_cut) = bound_tool_text(&raw);
        assert_eq!(text, "a".repeat(TOOL_TEXT_MAX_CHARS));
        assert!(was_cut);

        let raw = "😀".repeat(300);
        let (text, was_cut) = bound_tool_text(&raw);
        assert_eq!(text.chars().count(), TOOL_TEXT_MAX_CHARS);
        assert!(text.chars().all(|character| character == '😀'));
        assert!(was_cut);
    }

    #[test]
    fn short_text_is_not_cut() {
        assert_eq!(bound_tool_text("npm test"), ("npm test".to_string(), false));
    }

    #[test]
    fn text_without_family_anchors_is_unchanged() {
        let input = "margin-top: 8px; color: red;";
        for may_be_truncated in [false, true] {
            assert_eq!(redact_secrets_at_boundary(input, may_be_truncated), input);
        }
    }
}
