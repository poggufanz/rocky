//! Read-only Claude Code transcript reader for agent edit quotes and subagent prompts.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::ffi::OsStr;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};

use rocky_proto::redact::{PROMPT_SCAN_BYTES, bound_prompt, redact_secrets_at_boundary};
use serde::Deserialize;
use serde::de::IgnoredAny;

const MAX_TAIL_BYTES: u64 = 8 * 1024 * 1024;
const QUOTE_MAX_CHARS: usize = 500;
const TURN_START_SLACK_MS: u64 = 5_000;
const CLAUDE_CODE_HARNESS: &str = "claude-code";

/// One agent prose quote attached to an edit tool use.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Quote {
    /// Redacted prose truncated to at most 500 Unicode scalar values.
    pub text: String,
    /// `true` when the quote fell back to an earlier assistant message in the turn.
    pub shared: bool,
}

/// Extracted quotes and turn boundary status from a transcript read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranscriptRead {
    /// Redacted quotes keyed by `tool_use_id`.
    pub quotes: BTreeMap<String, Quote>,
    /// First non-empty user text block starting the turn, bounded to 1,000 chars.
    pub first_user_text: Option<(String, bool)>,
    /// `false` if the turn start lay before the 8 MiB tail window.
    pub complete: bool,
}

/// Validates that `path` is a canonical, non-symlink `.jsonl` file inside `<dir>/projects/`
/// for one of `config_dirs`.
pub fn validate_transcript_path(path: &str, config_dirs: &[PathBuf]) -> Option<PathBuf> {
    if path.is_empty() || path.contains('\0') {
        return None;
    }
    let raw = Path::new(path);
    if !raw.is_absolute()
        || raw
            .components()
            .any(|component| matches!(component, Component::ParentDir))
        || raw.extension() != Some(OsStr::new("jsonl"))
    {
        return None;
    }

    let meta = fs::symlink_metadata(raw).ok()?;
    if !meta.file_type().is_file() {
        return None;
    }

    let canon = fs::canonicalize(raw).ok()?;
    let canon_stripped = strip_verbatim_str(canon.to_str()?);
    if !paths_match(canon_stripped, path) {
        return None;
    }

    let canon_path = Path::new(canon_stripped);
    for dir in config_dirs {
        let Some(projects_dir) = canonical_projects_dir(dir) else {
            continue;
        };
        if canon_path.starts_with(&projects_dir) && canon_path != projects_dir {
            return Some(canon_path.to_path_buf());
        }
    }
    None
}

/// Collects `~/.claude` plus any Claude Code config directories recorded by the setup guard.
pub fn claude_config_dirs(rocky_home: &Path) -> Vec<PathBuf> {
    claude_config_dirs_from(std::env::home_dir().as_deref(), rocky_home)
}

/// Builds deduplicated Claude Code config directories from an explicit user home and `rocky_home`.
pub fn claude_config_dirs_from(user_home: Option<&Path>, rocky_home: &Path) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let mut push_unique = |candidate: PathBuf| {
        if !dirs.iter().any(|existing| existing == &candidate) {
            dirs.push(candidate);
        }
    };

    if let Some(home) = user_home {
        push_unique(home.join(".claude"));
    }

    let consent = crate::guard::records::read_consent(rocky_home);
    for (harness, dir) in consent.locations {
        if harness == CLAUDE_CODE_HARNESS && !dir.is_empty() {
            push_unique(PathBuf::from(dir));
        }
    }
    dirs
}

/// Reads at most the last 8 MiB of `path` and extracts redacted quotes for `tool_use_ids`.
pub fn read_quotes(
    path: &Path,
    tool_use_ids: &[String],
    turn_started_ms: u64,
) -> io::Result<TranscriptRead> {
    let tail = read_tail(path)?;

    let window = if tail.tail_truncated && !tail.starts_on_line_boundary {
        match tail.buf.iter().position(|&b| b == b'\n') {
            Some(pos) => &tail.buf[pos + 1..],
            None => {
                return Ok(TranscriptRead {
                    quotes: BTreeMap::new(),
                    first_user_text: None,
                    complete: false,
                });
            }
        }
    } else {
        tail.buf.as_slice()
    };

    let targets: HashSet<&str> = tool_use_ids.iter().map(String::as_str).collect();
    let scan = scan_window_backwards(window, &targets, turn_started_ms);
    let first_user_text = if scan.found_turn_start {
        scan.turn_user_text.as_deref().map(bound_prompt)
    } else {
        None
    };

    Ok(TranscriptRead {
        quotes: replay_turn(scan.assistant_lines_rev, &targets),
        first_user_text,
        complete: scan.found_turn_start,
    })
}

fn strip_verbatim_str(path_str: &str) -> &str {
    #[cfg(windows)]
    {
        path_str.strip_prefix(r"\\?\").unwrap_or(path_str)
    }
    #[cfg(not(windows))]
    {
        path_str
    }
}

fn paths_match(canon_stripped: &str, raw_input: &str) -> bool {
    #[cfg(windows)]
    {
        canon_stripped.to_lowercase() == raw_input.to_lowercase()
    }
    #[cfg(not(windows))]
    {
        canon_stripped == raw_input
    }
}

fn canonical_projects_dir(config_dir: &Path) -> Option<PathBuf> {
    if !config_dir.is_absolute() {
        return None;
    }
    let canon_dir = fs::canonicalize(config_dir).ok()?;
    let canon_dir_clean = Path::new(strip_verbatim_str(canon_dir.to_str()?));
    let projects_raw = canon_dir_clean.join("projects");
    let projects_meta = fs::symlink_metadata(&projects_raw).ok()?;
    if !projects_meta.file_type().is_dir() {
        return None;
    }
    let canon_projects = fs::canonicalize(&projects_raw).ok()?;
    let projects_clean = strip_verbatim_str(canon_projects.to_str()?);
    Some(PathBuf::from(projects_clean))
}

fn open_nofollow_readonly(path: &Path) -> io::Result<File> {
    let meta = fs::symlink_metadata(path)?;
    if !meta.file_type().is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "transcript path is not a regular file",
        ));
    }

    let mut opts = OpenOptions::new();
    opts.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.custom_flags(libc::O_NOFOLLOW);
    }

    let file = opts.open(path)?;
    let opened_meta = file.metadata()?;
    if !opened_meta.file_type().is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "opened transcript is not a regular file",
        ));
    }
    Ok(file)
}

struct TailRead {
    buf: Vec<u8>,
    tail_truncated: bool,
    starts_on_line_boundary: bool,
}

fn read_tail(path: &Path) -> io::Result<TailRead> {
    let mut file = open_nofollow_readonly(path)?;
    let len = file.metadata()?.len();
    if len <= MAX_TAIL_BYTES {
        let cap = usize::try_from(len).unwrap_or(MAX_TAIL_BYTES as usize);
        let mut buf = Vec::with_capacity(cap);
        file.take(MAX_TAIL_BYTES).read_to_end(&mut buf)?;
        return Ok(TailRead {
            buf,
            tail_truncated: false,
            starts_on_line_boundary: true,
        });
    }

    let start = len - MAX_TAIL_BYTES;
    file.seek(SeekFrom::Start(start - 1))?;
    let mut prev = [0u8; 1];
    file.read_exact(&mut prev)?;
    let starts_on_line_boundary = prev[0] == b'\n';

    let mut buf = Vec::with_capacity(MAX_TAIL_BYTES as usize);
    file.take(MAX_TAIL_BYTES).read_to_end(&mut buf)?;
    Ok(TailRead {
        buf,
        tail_truncated: true,
        starts_on_line_boundary,
    })
}

#[derive(Deserialize)]
#[serde(untagged)]
enum MaybeString {
    Str(String),
    Other(IgnoredAny),
}

impl MaybeString {
    fn into_string(self) -> Option<String> {
        match self {
            Self::Str(s) => Some(s),
            Self::Other(_) => None,
        }
    }
}

#[derive(Deserialize)]
#[serde(untagged)]
enum MaybeBool {
    Bool(bool),
    Other(IgnoredAny),
}

impl MaybeBool {
    fn into_bool(self) -> Option<bool> {
        match self {
            Self::Bool(b) => Some(b),
            Self::Other(_) => None,
        }
    }
}

#[derive(Deserialize)]
struct RawLine {
    #[serde(rename = "type", default)]
    kind: Option<MaybeString>,
    #[serde(default)]
    timestamp: Option<MaybeString>,
    #[serde(rename = "isMeta", default)]
    is_meta: Option<MaybeBool>,
    #[serde(default)]
    message: Option<RawMessage>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum RawMessage {
    Object(RawMessageFields),
    Other(IgnoredAny),
}

#[derive(Deserialize)]
struct RawMessageFields {
    #[serde(default)]
    id: Option<MaybeString>,
    #[serde(default)]
    content: Option<RawContent>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum RawContent {
    Text(String),
    Blocks(Vec<RawBlockEntry>),
    Other(IgnoredAny),
}

#[derive(Deserialize)]
#[serde(untagged)]
enum RawBlockEntry {
    Object(RawBlockFields),
    Other(IgnoredAny),
}

#[derive(Deserialize)]
struct RawBlockFields {
    #[serde(rename = "type", default)]
    kind: Option<MaybeString>,
    // `thinking` fields are intentionally omitted from deserialization so they are never read.
    #[serde(default)]
    text: Option<MaybeString>,
    #[serde(default)]
    id: Option<MaybeString>,
}

enum AssistantEvent {
    Text(String),
    ToolUse(String),
}

struct AssistantLine {
    message_id: Option<String>,
    events: Vec<AssistantEvent>,
}

struct CollectedAssistant {
    line: AssistantLine,
    ts_ms: Option<u64>,
}

struct WindowScan {
    assistant_lines_rev: Vec<AssistantLine>,
    found_turn_start: bool,
    turn_user_text: Option<String>,
}

fn parse_ascii_digits(bytes: &[u8]) -> Option<u32> {
    let mut acc: u32 = 0;
    for &b in bytes {
        if !b.is_ascii_digit() {
            return None;
        }
        acc = acc * 10 + u32::from(b - b'0');
    }
    Some(acc)
}

fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            let leap =
                year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400));
            if leap { 29 } else { 28 }
        }
        _ => 0,
    }
}

fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let y = year - i64::from(month <= 2);
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400) as u64;
    let m = u64::from(month);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + u64::from(day) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + (doe as i64) - 719_468
}

/// Parses fixed-format ISO 8601 UTC timestamps (`YYYY-MM-DDTHH:MM:SS(.fff)Z`) to Unix ms.
fn parse_iso_utc_ms(raw: &str) -> Option<u64> {
    if !raw.is_ascii() || raw.len() < 20 {
        return None;
    }
    let b = raw.as_bytes();
    if b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' {
        return None;
    }

    let year = parse_ascii_digits(&b[0..4])?;
    let month = parse_ascii_digits(&b[5..7])?;
    let day = parse_ascii_digits(&b[8..10])?;
    let hour = parse_ascii_digits(&b[11..13])?;
    let minute = parse_ascii_digits(&b[14..16])?;
    let second = parse_ascii_digits(&b[17..19])?;

    if year < 1970
        || !(1..=12).contains(&month)
        || !(1..=days_in_month(year, month)).contains(&day)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return None;
    }

    let millis = match &b[19..] {
        b"Z" => 0u64,
        [b'.', frac @ .., b'Z'] if !frac.is_empty() && frac.len() <= 9 => {
            if !frac.iter().all(u8::is_ascii_digit) {
                return None;
            }
            let d0 = u64::from(frac[0] - b'0');
            let d1 = frac.get(1).map_or(0, |&c| u64::from(c - b'0'));
            let d2 = frac.get(2).map_or(0, |&c| u64::from(c - b'0'));
            d0 * 100 + d1 * 10 + d2
        }
        _ => return None,
    };

    let days = days_from_civil(i64::from(year), month, day);
    let days_u64 = u64::try_from(days).ok()?;
    let day_ms = days_u64.checked_mul(86_400_000)?;
    let time_ms = u64::from(hour) * 3_600_000
        + u64::from(minute) * 60_000
        + u64::from(second) * 1_000
        + millis;
    day_ms.checked_add(time_ms)
}

fn into_assistant_lines(items: Vec<CollectedAssistant>) -> Vec<AssistantLine> {
    items.into_iter().map(|c| c.line).collect()
}

fn filter_assistant_lines_since(
    items: Vec<CollectedAssistant>,
    cutoff_ms: u64,
) -> Vec<AssistantLine> {
    items
        .into_iter()
        .filter(|c| c.ts_ms.is_none_or(|t| t >= cutoff_ms))
        .map(|c| c.line)
        .collect()
}

fn found_scan(current_rev: Vec<CollectedAssistant>, turn_user_text: Option<String>) -> WindowScan {
    WindowScan {
        assistant_lines_rev: into_assistant_lines(current_rev),
        found_turn_start: true,
        turn_user_text,
    }
}

fn incomplete_scan(
    current_rev: Vec<CollectedAssistant>,
    current_has_target: bool,
    min_ts: u64,
) -> WindowScan {
    let assistant_lines_rev = if current_has_target {
        filter_assistant_lines_since(current_rev, min_ts)
    } else {
        Vec::new()
    };
    WindowScan {
        assistant_lines_rev,
        found_turn_start: false,
        turn_user_text: None,
    }
}

fn scan_window_backwards(
    window: &[u8],
    targets: &HashSet<&str>,
    turn_started_ms: u64,
) -> WindowScan {
    let min_ts = turn_started_ms.saturating_sub(TURN_START_SLACK_MS);
    let max_ts = turn_started_ms.saturating_add(TURN_START_SLACK_MS);
    let mut current_rev: Vec<CollectedAssistant> = Vec::new();
    let mut current_has_target = false;

    for raw_line in window.rsplit(|&b| b == b'\n') {
        let trimmed = raw_line.trim_ascii();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(parsed) = serde_json::from_slice::<RawLine>(trimmed) else {
            continue;
        };
        let Some(kind) = parsed.kind.and_then(MaybeString::into_string) else {
            continue;
        };
        let line_ts_ms = parsed
            .timestamp
            .and_then(MaybeString::into_string)
            .as_deref()
            .and_then(parse_iso_utc_ms);

        match kind.as_str() {
            "assistant" => {
                if let Some(line) = parse_assistant_line(parsed.message) {
                    let has_target = line.events.iter().any(|ev| {
                        matches!(ev, AssistantEvent::ToolUse(id) if targets.contains(id.as_str()))
                    });
                    if has_target && line_ts_ms.is_none_or(|ts| ts >= min_ts) {
                        current_has_target = true;
                    }
                    current_rev.push(CollectedAssistant {
                        line,
                        ts_ms: line_ts_ms,
                    });
                }
            }
            "user" => {
                let is_meta = parsed
                    .is_meta
                    .and_then(MaybeBool::into_bool)
                    .unwrap_or(false);
                if is_meta {
                    continue;
                }
                let Some(user_text) = parse_turn_user_text(parsed.message) else {
                    continue;
                };

                match line_ts_ms {
                    Some(ts) if ts > max_ts => {
                        // Later turn prompt: discard any assistant lines collected after it.
                        current_rev.clear();
                        current_has_target = false;
                    }
                    Some(ts) if ts >= min_ts => {
                        return found_scan(current_rev, user_text);
                    }
                    Some(_) => {
                        return incomplete_scan(current_rev, current_has_target, min_ts);
                    }
                    None => {
                        if current_has_target || targets.is_empty() {
                            return found_scan(current_rev, user_text);
                        }
                        current_rev.clear();
                    }
                }
            }
            _ => {}
        }
    }

    incomplete_scan(current_rev, current_has_target, min_ts)
}

fn parse_assistant_line(message: Option<RawMessage>) -> Option<AssistantLine> {
    let RawMessage::Object(msg) = message? else {
        return None;
    };
    let message_id = msg
        .id
        .and_then(MaybeString::into_string)
        .filter(|id| !id.is_empty());
    let RawContent::Blocks(blocks) = msg.content? else {
        return None;
    };

    let mut events = Vec::new();
    for entry in blocks {
        let RawBlockEntry::Object(fields) = entry else {
            continue;
        };
        let Some(block_kind) = fields.kind.and_then(MaybeString::into_string) else {
            continue;
        };
        match block_kind.as_str() {
            "text" => {
                if let Some(text) = fields.text.and_then(MaybeString::into_string)
                    && !text.trim().is_empty()
                {
                    events.push(AssistantEvent::Text(text));
                }
            }
            "tool_use" => {
                if let Some(id) = fields.id.and_then(MaybeString::into_string)
                    && !id.is_empty()
                {
                    events.push(AssistantEvent::ToolUse(id));
                }
            }
            _ => {}
        }
    }

    if events.is_empty() {
        None
    } else {
        Some(AssistantLine { message_id, events })
    }
}

/// Returns `Some(first_non_empty_text)` when `message` starts a user turn, or `None` when
/// it carries `tool_result` blocks or malformed empty content.
fn parse_turn_user_text(message: Option<RawMessage>) -> Option<Option<String>> {
    let RawMessage::Object(msg) = message? else {
        return None;
    };
    match msg.content? {
        RawContent::Text(s) => {
            if s.trim().is_empty() {
                None
            } else {
                Some(Some(s))
            }
        }
        RawContent::Blocks(blocks) => {
            let mut first_text: Option<String> = None;
            let mut has_recognized_prompt_block = false;
            for entry in blocks {
                let RawBlockEntry::Object(fields) = entry else {
                    continue;
                };
                let Some(block_kind) = fields.kind.and_then(MaybeString::into_string) else {
                    continue;
                };
                match block_kind.as_str() {
                    "tool_result" => return None,
                    "text" => {
                        if let Some(text) = fields.text.and_then(MaybeString::into_string)
                            && !text.trim().is_empty()
                        {
                            has_recognized_prompt_block = true;
                            if first_text.is_none() {
                                first_text = Some(text);
                            }
                        }
                    }
                    "image" => {
                        has_recognized_prompt_block = true;
                    }
                    _ => {}
                }
            }
            if has_recognized_prompt_block {
                Some(first_text)
            } else {
                None
            }
        }
        RawContent::Other(_) => None,
    }
}

fn replay_turn(
    assistant_lines_rev: Vec<AssistantLine>,
    targets: &HashSet<&str>,
) -> BTreeMap<String, Quote> {
    let mut quotes = BTreeMap::new();
    if targets.is_empty() {
        return quotes;
    }

    let mut texts_by_msg: HashMap<String, Vec<String>> = HashMap::new();
    let mut last_text: Option<String> = None;

    for line in assistant_lines_rev.into_iter().rev() {
        for event in line.events {
            match event {
                AssistantEvent::Text(text) => {
                    last_text = Some(text.clone());
                    if let Some(mid) = line.message_id.as_ref() {
                        texts_by_msg.entry(mid.clone()).or_default().push(text);
                    }
                }
                AssistantEvent::ToolUse(tool_id) => {
                    if !targets.contains(tool_id.as_str()) {
                        continue;
                    }
                    if let Some(quote) = resolve_quote(
                        line.message_id.as_deref(),
                        &texts_by_msg,
                        last_text.as_deref(),
                    ) {
                        quotes.insert(tool_id, quote);
                    }
                }
            }
        }
    }

    quotes
}

fn resolve_quote(
    message_id: Option<&str>,
    texts_by_msg: &HashMap<String, Vec<String>>,
    last_text: Option<&str>,
) -> Option<Quote> {
    if let Some(mid) = message_id
        && let Some(parts) = texts_by_msg.get(mid)
        && !parts.is_empty()
    {
        let joined = parts.join("\n\n");
        if let Some(text) = format_quote(&joined) {
            return Some(Quote {
                text,
                shared: false,
            });
        }
    }

    if let Some(prev) = last_text
        && let Some(text) = format_quote(prev)
    {
        return Some(Quote { text, shared: true });
    }

    None
}

fn format_quote(raw: &str) -> Option<String> {
    if raw.trim().is_empty() {
        return None;
    }
    let scan_end = floor_char_boundary(raw, PROMPT_SCAN_BYTES);
    let may_be_truncated = scan_end < raw.len();
    let redacted = redact_secrets_at_boundary(&raw[..scan_end], may_be_truncated);
    let cut = truncate_chars(&redacted, QUOTE_MAX_CHARS);
    if cut.trim().is_empty() {
        return None;
    }
    Some(cut.to_string())
}

fn floor_char_boundary(s: &str, max_bytes: usize) -> usize {
    if s.len() <= max_bytes {
        return s.len();
    }
    let mut idx = max_bytes;
    while idx > 0 && !s.is_char_boundary(idx) {
        idx -= 1;
    }
    idx
}

fn truncate_chars(s: &str, max_chars: usize) -> &str {
    match s.char_indices().nth(max_chars) {
        Some((byte_idx, _)) => &s[..byte_idx],
        None => s,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{self, File};
    use std::io::Write;
    use tempfile::TempDir;

    fn synthetic_fixture(name: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/transcripts/synthetic")
            .join(name)
    }

    fn strip_verbatim(p: PathBuf) -> PathBuf {
        match p.to_str().and_then(|s| s.strip_prefix(r"\\?\")) {
            Some(stripped) => PathBuf::from(stripped),
            None => p,
        }
    }

    fn setup_projects_tree() -> (TempDir, PathBuf, PathBuf) {
        let temp = TempDir::new().expect("tempdir");
        let cfg = strip_verbatim(fs::canonicalize(temp.path()).expect("canonical temp"))
            .join("claude-cfg");
        let slug = cfg.join("projects").join("C--work-repo");
        fs::create_dir_all(&slug).expect("create projects tree");
        let valid = slug.join("session.jsonl");
        fs::write(
            &valid,
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"hi\"}}\n",
        )
        .expect("write valid session");
        let valid_canon = strip_verbatim(fs::canonicalize(&valid).expect("canonical valid"));
        (temp, cfg, valid_canon)
    }

    const NOV_13_2026_MIDNIGHT_MS: u64 = 1_794_528_000_000;

    fn nov_13_utc_ms(hour: u64, minute: u64, second: u64, millis: u64) -> u64 {
        NOV_13_2026_MIDNIGHT_MS + hour * 3_600_000 + minute * 60_000 + second * 1_000 + millis
    }

    #[test]
    fn quote_from_same_message_before_tool_use() {
        let path = synthetic_fixture("same_message.jsonl");
        let ids = vec!["toolu_01".to_string()];
        let out = read_quotes(&path, &ids, nov_13_utc_ms(10, 1, 0, 250))
            .expect("read same_message.jsonl");

        assert!(out.complete);
        assert_eq!(
            out.first_user_text,
            Some(("Update foo.rs to fix the bug.".to_string(), false))
        );
        let q = out.quotes.get("toolu_01").expect("quote for toolu_01");
        assert!(!q.shared);
        assert_eq!(
            q.text,
            "First note about foo.rs.\n\nI will update foo.rs to handle empty inputs."
        );
    }

    #[test]
    fn shared_fallback_from_earlier_text() {
        let path = synthetic_fixture("shared_fallback.jsonl");
        let ids = vec!["toolu_02".to_string(), "toolu_03".to_string()];
        let out = read_quotes(&path, &ids, nov_13_utc_ms(10, 2, 0, 250))
            .expect("read shared_fallback.jsonl");

        assert!(out.complete);
        let q2 = out.quotes.get("toolu_02").expect("quote for toolu_02");
        let q3 = out.quotes.get("toolu_03").expect("quote for toolu_03");
        assert!(q2.shared);
        assert!(q3.shared);
        assert_eq!(q2.text, "Cleaning up bar.rs helpers now.");
        assert_eq!(q3.text, "Cleaning up bar.rs helpers now.");
    }

    #[test]
    fn no_text_gives_no_quote() {
        let path = synthetic_fixture("no_text.jsonl");
        let ids = vec!["toolu_04".to_string()];
        let out =
            read_quotes(&path, &ids, nov_13_utc_ms(10, 4, 0, 250)).expect("read no_text.jsonl");

        assert!(out.complete);
        assert!(out.quotes.is_empty());
        assert_eq!(
            out.first_user_text,
            Some(("Edit silently without talking.".to_string(), false))
        );
    }

    #[test]
    fn thinking_is_never_read() {
        let path = synthetic_fixture("thinking_secret.jsonl");
        let ids = vec!["toolu_05".to_string(), "toolu_06".to_string()];
        let out = read_quotes(&path, &ids, nov_13_utc_ms(10, 5, 0, 250))
            .expect("read thinking_secret.jsonl");

        assert!(out.complete);
        let q5 = out.quotes.get("toolu_05").expect("quote for toolu_05");
        assert!(!q5.shared);
        assert_eq!(q5.text, "Updating config safely.");

        let q6 = out.quotes.get("toolu_06").expect("quote for toolu_06");
        assert!(q6.shared);
        assert_eq!(q6.text, "Updating config safely.");

        for quote in out.quotes.values() {
            assert!(!quote.text.contains("SECRET_THINKING_DO_NOT_LEAK"));
            assert!(!quote.text.contains("MORE_SECRET_THINKING"));
            assert!(!quote.text.contains("AKIAABCDEFGHIJKLMNOP"));
            assert!(!quote.text.contains("sk-ant-abcdefghijklmnopqrst123456"));
        }
    }

    #[test]
    fn malformed_lines_are_skipped() {
        let path = synthetic_fixture("malformed.jsonl");
        let ids = vec!["toolu_07".to_string()];
        let out =
            read_quotes(&path, &ids, nov_13_utc_ms(10, 6, 0, 250)).expect("read malformed.jsonl");

        assert!(out.complete);
        let q = out.quotes.get("toolu_07").expect("quote for toolu_07");
        assert!(!q.shared);
        assert_eq!(q.text, "Applying parser fix safely.");

        let temp = TempDir::new().expect("tempdir");
        let bad_utf8 = temp.path().join("bad_utf8.jsonl");
        let mut f = File::create(&bad_utf8).expect("create bad_utf8");
        f.write_all(
            br#"{"type":"user","timestamp":"2026-11-13T10:06:30.000Z","message":{"role":"user","content":"Recover cleanly"}}"#,
        )
        .expect("write user");
        f.write_all(b"\n\xff\xfe\xfd not utf8\n")
            .expect("write invalid utf8");
        f.write_all(
            br#"{"type":"assistant","timestamp":"2026-11-13T10:06:31.000Z","message":{"id":"msg_u","role":"assistant","content":[{"type":"text","text":"Recovered after bad bytes."},{"type":"tool_use","id":"toolu_utf8","name":"Edit"}]}}"#,
        )
        .expect("write assistant");
        f.write_all(b"\n").expect("newline");

        let out_utf8 = read_quotes(
            &bad_utf8,
            &["toolu_utf8".to_string()],
            nov_13_utc_ms(10, 6, 30, 250),
        )
        .expect("read bad_utf8");
        assert!(out_utf8.complete);
        assert_eq!(
            out_utf8.quotes.get("toolu_utf8").map(|q| q.text.as_str()),
            Some("Recovered after bad bytes.")
        );
    }

    #[test]
    fn quote_is_redacted_and_cut() {
        let path = synthetic_fixture("redact_and_cut.jsonl");
        let ids = vec!["toolu_08".to_string()];
        let out = read_quotes(&path, &ids, nov_13_utc_ms(10, 7, 0, 250))
            .expect("read redact_and_cut.jsonl");

        assert!(out.complete);
        let q = out.quotes.get("toolu_08").expect("quote for toolu_08");
        assert!(!q.shared);
        assert!(!q.text.contains("AKIAABCDEFGHIJKLMNOP"));
        assert!(!q.text.contains("sk-ant-abcdefghijklmnopqrst123456"));
        assert!(!q.text.contains("extra tail words"));
        assert!(q.text.contains("[redacted aws access key]"));
        assert!(q.text.contains("[redacted"));
        assert_eq!(q.text.chars().count(), 500);
    }

    #[test]
    fn turn_start_beyond_8_mib_marks_incomplete() {
        let temp = TempDir::new().expect("tempdir");

        let path_incomplete = temp.path().join("beyond_8mib.jsonl");
        {
            let mut f = File::create(&path_incomplete).expect("create beyond_8mib");
            writeln!(
                f,
                r#"{{"type":"user","timestamp":"2026-11-13T10:09:00.000Z","message":{{"role":"user","content":"Initial prompt outside 8 MiB"}}}}"#
            )
            .expect("write user");
            let pad = "a".repeat(2048);
            let filler = format!(
                r#"{{"type":"assistant","timestamp":"2026-11-13T10:09:01.000Z","message":{{"id":"msg_pad","role":"assistant","content":[{{"type":"thinking","thinking":"{pad}"}}]}}}}"#
            );
            for _ in 0..4200 {
                writeln!(f, "{filler}").expect("write filler");
            }
            writeln!(
                f,
                r#"{{"type":"assistant","timestamp":"2026-11-13T10:09:02.000Z","message":{{"id":"msg_tail","role":"assistant","content":[{{"type":"text","text":"Editing file near tail."}},{{"type":"tool_use","id":"toolu_tail","name":"Edit"}}]}}}}"#
            )
            .expect("write tail assistant");
        }

        let out = read_quotes(
            &path_incomplete,
            &["toolu_tail".to_string()],
            nov_13_utc_ms(10, 9, 0, 250),
        )
        .expect("read beyond_8mib");
        assert!(!out.complete);
        assert_eq!(out.first_user_text, None);
        let q = out.quotes.get("toolu_tail").expect("quote for toolu_tail");
        assert!(!q.shared);
        assert_eq!(q.text, "Editing file near tail.");

        let path_complete = temp.path().join("turn_inside_8mib.jsonl");
        {
            let mut f = File::create(&path_complete).expect("create turn_inside_8mib");
            let pad = "b".repeat(2048);
            let filler = format!(
                r#"{{"type":"assistant","timestamp":"2026-11-13T10:09:30.000Z","message":{{"id":"msg_old","role":"assistant","content":[{{"type":"text","text":"{pad}"}}]}}}}"#
            );
            for _ in 0..4200 {
                writeln!(f, "{filler}").expect("write filler");
            }
            writeln!(
                f,
                r#"{{"type":"user","timestamp":"2026-11-13T10:10:00.000Z","message":{{"role":"user","content":"Recent prompt inside window"}}}}"#
            )
            .expect("write recent user");
            writeln!(
                f,
                r#"{{"type":"assistant","timestamp":"2026-11-13T10:10:01.000Z","message":{{"id":"msg_new","role":"assistant","content":[{{"type":"tool_use","id":"toolu_new","name":"Edit"}}]}}}}"#
            )
            .expect("write recent assistant");
        }

        let out2 = read_quotes(
            &path_complete,
            &["toolu_new".to_string()],
            nov_13_utc_ms(10, 10, 0, 250),
        )
        .expect("read turn_inside_8mib");
        assert!(out2.complete);
        assert_eq!(
            out2.first_user_text,
            Some(("Recent prompt inside window".to_string(), false))
        );
        assert!(out2.quotes.is_empty());
    }

    #[test]
    fn first_user_text_for_subagent() {
        let path = synthetic_fixture("subagent_prompt.jsonl");
        let out = read_quotes(&path, &[], nov_13_utc_ms(10, 8, 1, 250))
            .expect("read subagent_prompt.jsonl");

        assert!(out.complete);
        assert_eq!(
            out.first_user_text,
            Some((
                "Analyze module X carefully and report findings.".to_string(),
                false
            ))
        );

        let temp = TempDir::new().expect("tempdir");
        let long_path = temp.path().join("long_subagent.jsonl");
        let long_prompt = format!("Key AKIAABCDEFGHIJKLMNOP {}", "p".repeat(1200));
        let line = serde_json::json!({
            "type": "user",
            "timestamp": "2026-11-13T10:08:30.000Z",
            "message": { "role": "user", "content": long_prompt }
        });
        fs::write(&long_path, format!("{line}\n")).expect("write long_subagent");

        let out_long = read_quotes(&long_path, &[], nov_13_utc_ms(10, 8, 30, 250))
            .expect("read long_subagent");
        assert!(out_long.complete);
        let (text, truncated) = out_long.first_user_text.expect("long first_user_text");
        assert!(truncated);
        assert!(!text.contains("AKIAABCDEFGHIJKLMNOP"));
        assert_eq!(text.chars().count(), rocky_proto::redact::PROMPT_MAX_CHARS);
    }

    #[test]
    fn delayed_read_after_later_turn_selects_requested_turn() {
        let temp = TempDir::new().expect("tempdir");
        let path = temp.path().join("multi_turn.jsonl");
        let lines = [
            r#"{"type":"user","timestamp":"2026-11-13T09:11:00.000Z","message":{"role":"user","content":"Turn 0 prompt"}}"#,
            r#"{"type":"assistant","timestamp":"2026-11-13T09:11:01.000Z","message":{"id":"msg_t0","role":"assistant","content":[{"type":"text","text":"Turn 0 quote"},{"type":"tool_use","id":"toolu_t0","name":"Edit"}]}}"#,
            r#"{"type":"user","timestamp":"2026-11-13T09:12:00.000Z","message":{"role":"user","content":"Turn 1 prompt"}}"#,
            r#"{"type":"assistant","timestamp":"2026-11-13T09:12:02.000Z","message":{"id":"msg_t1","role":"assistant","content":[{"type":"text","text":"Turn 1 quote"},{"type":"tool_use","id":"toolu_t1","name":"Edit"}]}}"#,
            r#"{"type":"user","timestamp":"2026-11-13T09:13:00.000Z","message":{"role":"user","content":"Turn 2 prompt"}}"#,
            r#"{"type":"assistant","timestamp":"2026-11-13T09:13:02.000Z","message":{"id":"msg_t2","role":"assistant","content":[{"type":"text","text":"Turn 2 quote"},{"type":"tool_use","id":"toolu_t2","name":"Edit"}]}}"#,
        ];
        fs::write(&path, format!("{}\n", lines.join("\n"))).expect("write multi_turn");

        let turn1_start = nov_13_utc_ms(9, 12, 3, 456);
        let out_empty = read_quotes(&path, &[], turn1_start).expect("read turn 1 empty ids");
        assert!(out_empty.complete);
        assert_eq!(
            out_empty.first_user_text,
            Some(("Turn 1 prompt".to_string(), false))
        );
        assert!(out_empty.quotes.is_empty());

        let out_t1 = read_quotes(&path, &["toolu_t1".to_string()], turn1_start)
            .expect("read turn 1 with tool id");
        assert!(out_t1.complete);
        assert_eq!(
            out_t1.first_user_text,
            Some(("Turn 1 prompt".to_string(), false))
        );
        assert_eq!(
            out_t1.quotes.get("toolu_t1").map(|q| q.text.as_str()),
            Some("Turn 1 quote")
        );

        let out_missing = read_quotes(&path, &["toolu_missing".to_string()], turn1_start)
            .expect("read turn 1 missing tool id");
        assert!(out_missing.complete);
        assert_eq!(
            out_missing.first_user_text,
            Some(("Turn 1 prompt".to_string(), false))
        );
        assert!(out_missing.quotes.is_empty());

        let turn2_start = nov_13_utc_ms(9, 13, 1, 0);
        let out_no_cross = read_quotes(&path, &["toolu_t1".to_string()], turn2_start)
            .expect("read turn 2 must not cross boundary");
        assert!(out_no_cross.complete);
        assert_eq!(
            out_no_cross.first_user_text,
            Some(("Turn 2 prompt".to_string(), false))
        );
        assert!(out_no_cross.quotes.is_empty());

        let two_turn = temp.path().join("two_turn_from_top.jsonl");
        fs::write(&two_turn, format!("{}\n", lines[2..].join("\n"))).expect("write two_turn");
        let out_first = read_quotes(&two_turn, &[], turn1_start).expect("read first turn of two");
        assert!(out_first.complete);
        assert_eq!(
            out_first.first_user_text,
            Some(("Turn 1 prompt".to_string(), false))
        );
    }

    #[test]
    fn in_window_prompt_with_missing_tool_id_beyond_8_mib_is_complete() {
        let temp = TempDir::new().expect("tempdir");
        let path = temp.path().join("missing_tool_in_window.jsonl");
        {
            let mut f = File::create(&path).expect("create missing_tool_in_window");
            writeln!(
                f,
                r#"{{"type":"user","timestamp":"2026-11-13T09:14:00.000Z","message":{{"role":"user","content":"Old turn outside 8 MiB"}}}}"#
            )
            .expect("write old user");
            let pad = "c".repeat(2048);
            let filler = format!(
                r#"{{"type":"assistant","timestamp":"2026-11-13T09:14:01.000Z","message":{{"id":"msg_fill","role":"assistant","content":[{{"type":"thinking","thinking":"{pad}"}}]}}}}"#
            );
            for _ in 0..4200 {
                writeln!(f, "{filler}").expect("write filler");
            }
            writeln!(
                f,
                r#"{{"type":"user","timestamp":"2026-11-13T09:15:00.000Z","message":{{"role":"user","content":"In-window prompt pending tool"}}}}"#
            )
            .expect("write in-window user");
            writeln!(
                f,
                r#"{{"type":"assistant","timestamp":"2026-11-13T09:15:02.000Z","message":{{"id":"msg_pending","role":"assistant","content":[{{"type":"text","text":"Preparing edit."}}]}}}}"#
            )
            .expect("write pending assistant");
            writeln!(
                f,
                r#"{{"type":"user","timestamp":"2026-11-13T09:16:00.000Z","message":{{"role":"user","content":"Later turn prompt"}}}}"#
            )
            .expect("write later user");
        }

        let out = read_quotes(
            &path,
            &["toolu_pending".to_string()],
            nov_13_utc_ms(9, 15, 1, 0),
        )
        .expect("read missing_tool_in_window");
        assert!(out.complete);
        assert_eq!(
            out.first_user_text,
            Some(("In-window prompt pending tool".to_string(), false))
        );
        assert!(out.quotes.is_empty());

        let path_before = write_early_prompt_outside_later_inside(temp.path());

        let out_before = read_quotes(
            &path_before,
            &["toolu_early".to_string()],
            nov_13_utc_ms(9, 14, 0, 500),
        )
        .expect("read path_before");
        assert!(!out_before.complete);
        assert_eq!(out_before.first_user_text, None);
        assert_eq!(
            out_before
                .quotes
                .get("toolu_early")
                .map(|q| q.text.as_str()),
            Some("Early turn quote")
        );
    }

    fn write_early_prompt_outside_later_inside(dir: &Path) -> PathBuf {
        let path = dir.join("early_prompt_outside_later_inside.jsonl");
        let mut f = File::create(&path).expect("create early_prompt_outside_later_inside");
        writeln!(
            f,
            r#"{{"type":"user","timestamp":"2026-11-13T09:14:00.000Z","message":{{"role":"user","content":"Early turn outside 8 MiB"}}}}"#
        )
        .expect("write early user");
        let pad = "d".repeat(2048);
        let filler = format!(
            r#"{{"type":"assistant","timestamp":"2026-11-13T09:14:01.000Z","message":{{"id":"msg_fill2","role":"assistant","content":[{{"type":"thinking","thinking":"{pad}"}}]}}}}"#
        );
        for _ in 0..4200 {
            writeln!(f, "{filler}").expect("write filler");
        }
        writeln!(
            f,
            r#"{{"type":"assistant","timestamp":"2026-11-13T09:14:02.000Z","message":{{"id":"msg_early","role":"assistant","content":[{{"type":"text","text":"Early turn quote"}},{{"type":"tool_use","id":"toolu_early","name":"Edit"}}]}}}}"#
        )
        .expect("write early assistant");
        writeln!(
            f,
            r#"{{"type":"user","timestamp":"2026-11-13T09:15:00.000Z","message":{{"role":"user","content":"Later turn prompt"}}}}"#
        )
        .expect("write later user");
        path
    }

    #[test]
    fn truncated_window_with_later_prompt_and_empty_or_absent_ids_is_incomplete() {
        let temp = TempDir::new().expect("tempdir");
        let path_before = write_early_prompt_outside_later_inside(temp.path());
        let requested_start = nov_13_utc_ms(9, 14, 0, 500);

        let out_empty = read_quotes(&path_before, &[], requested_start).expect("read empty ids");
        assert!(!out_empty.complete);
        assert_eq!(out_empty.first_user_text, None);
        assert!(out_empty.quotes.is_empty());

        let out_absent = read_quotes(&path_before, &["toolu_absent".to_string()], requested_start)
            .expect("read absent id");
        assert!(!out_absent.complete);
        assert_eq!(out_absent.first_user_text, None);
        assert!(out_absent.quotes.is_empty());

        let small_later_only = temp.path().join("small_later_only.jsonl");
        let small_lines = [
            r#"{"type":"user","timestamp":"2026-11-13T09:15:00.000Z","message":{"role":"user","content":"Later turn prompt"}}"#,
            r#"{"type":"assistant","timestamp":"2026-11-13T09:15:02.000Z","message":{"id":"msg_later","role":"assistant","content":[{"type":"text","text":"Later quote"},{"type":"tool_use","id":"toolu_later","name":"Edit"}]}}"#,
        ];
        fs::write(&small_later_only, format!("{}\n", small_lines.join("\n")))
            .expect("write small_later_only");

        for ids in [
            Vec::new(),
            vec!["toolu_absent".to_string()],
            vec!["toolu_later".to_string()],
        ] {
            let out_small = read_quotes(&small_later_only, &ids, requested_start)
                .expect("read small_later_only");
            assert!(!out_small.complete);
            assert_eq!(out_small.first_user_text, None);
            assert!(out_small.quotes.is_empty());
        }
    }

    #[test]
    fn in_range_prompt_followed_by_later_out_of_range_prompt_is_complete() {
        let temp = TempDir::new().expect("tempdir");
        let path = temp.path().join("in_range_then_later.jsonl");
        let lines = [
            r#"{"type":"user","timestamp":"2026-11-13T09:15:00.000Z","message":{"role":"user","content":"In-range turn prompt"}}"#,
            r#"{"type":"assistant","timestamp":"2026-11-13T09:15:02.000Z","message":{"id":"msg_in","role":"assistant","content":[{"type":"text","text":"In-range quote"},{"type":"tool_use","id":"toolu_in_range","name":"Edit"}]}}"#,
            r#"{"type":"assistant","timestamp":"2026-11-13T09:15:20.000Z","message":{"id":"msg_in_late","role":"assistant","content":[{"type":"text","text":"Follow-up step"},{"type":"tool_use","id":"toolu_late_step","name":"Edit"}]}}"#,
            r#"{"type":"user","timestamp":"2026-11-13T09:16:00.000Z","message":{"role":"user","content":"Later out-of-range prompt"}}"#,
            r#"{"type":"assistant","timestamp":"2026-11-13T09:16:02.000Z","message":{"id":"msg_after","role":"assistant","content":[{"type":"text","text":"Later quote"},{"type":"tool_use","id":"toolu_later","name":"Edit"}]}}"#,
        ];
        fs::write(&path, format!("{}\n", lines.join("\n"))).expect("write in_range_then_later");

        let requested_start = nov_13_utc_ms(9, 15, 1, 0);
        let out_empty = read_quotes(&path, &[], requested_start).expect("read empty ids");
        assert!(out_empty.complete);
        assert_eq!(
            out_empty.first_user_text,
            Some(("In-range turn prompt".to_string(), false))
        );
        assert!(out_empty.quotes.is_empty());

        let out_absent = read_quotes(&path, &["toolu_absent".to_string()], requested_start)
            .expect("read absent id");
        assert!(out_absent.complete);
        assert_eq!(
            out_absent.first_user_text,
            Some(("In-range turn prompt".to_string(), false))
        );
        assert!(out_absent.quotes.is_empty());

        let out_tools = read_quotes(
            &path,
            &["toolu_in_range".to_string(), "toolu_late_step".to_string()],
            requested_start,
        )
        .expect("read with tools");
        assert!(out_tools.complete);
        assert_eq!(
            out_tools.first_user_text,
            Some(("In-range turn prompt".to_string(), false))
        );
        assert_eq!(
            out_tools
                .quotes
                .get("toolu_in_range")
                .map(|q| q.text.as_str()),
            Some("In-range quote")
        );
        assert_eq!(
            out_tools
                .quotes
                .get("toolu_late_step")
                .map(|q| q.text.as_str()),
            Some("Follow-up step")
        );

        let prompt_ms = nov_13_utc_ms(9, 15, 0, 0);
        for in_bounds in [prompt_ms + 5_000, prompt_ms.saturating_sub(5_000)] {
            let out = read_quotes(&path, &[], in_bounds).expect("read slack bound");
            assert!(out.complete);
            assert_eq!(
                out.first_user_text,
                Some(("In-range turn prompt".to_string(), false))
            );
        }
        for out_of_bounds in [prompt_ms + 5_001, prompt_ms - 5_001] {
            let out = read_quotes(&path, &[], out_of_bounds).expect("read outside slack");
            assert!(!out.complete);
            assert_eq!(out.first_user_text, None);
            assert!(out.quotes.is_empty());
        }

        let truncated_with_in_range = temp.path().join("truncated_in_range_then_later.jsonl");
        {
            let mut f = File::create(&truncated_with_in_range).expect("create truncated_in_range");
            writeln!(
                f,
                r#"{{"type":"user","timestamp":"2026-11-13T09:14:00.000Z","message":{{"role":"user","content":"Old turn outside 8 MiB"}}}}"#
            )
            .expect("write old user");
            let pad = "g".repeat(2048);
            let filler = format!(
                r#"{{"type":"assistant","timestamp":"2026-11-13T09:14:01.000Z","message":{{"id":"msg_fill3","role":"assistant","content":[{{"type":"thinking","thinking":"{pad}"}}]}}}}"#
            );
            for _ in 0..4200 {
                writeln!(f, "{filler}").expect("write filler");
            }
            for line in &lines {
                writeln!(f, "{line}").expect("write tail lines");
            }
        }
        for ids in [Vec::new(), vec!["toolu_absent".to_string()]] {
            let out_trunc = read_quotes(&truncated_with_in_range, &ids, requested_start)
                .expect("read truncated_in_range");
            assert!(out_trunc.complete);
            assert_eq!(
                out_trunc.first_user_text,
                Some(("In-range turn prompt".to_string(), false))
            );
            assert!(out_trunc.quotes.is_empty());
        }
    }

    #[test]
    fn exact_8_mib_boundary_alignment_preserves_first_line() {
        let temp = TempDir::new().expect("tempdir");
        let max_tail = MAX_TAIL_BYTES as usize;
        let prefix = r#"{"type":"user","timestamp":"2026-11-13T09:19:00.000Z","message":{"role":"user","content":"Prefix outside window."}}"#.to_string() + "\n";

        let user_line = r#"{"type":"user","timestamp":"2026-11-13T09:20:00.000Z","message":{"role":"user","content":"Aligned boundary prompt."}}"#.to_string() + "\n";
        let tail_assistant = r#"{"type":"assistant","timestamp":"2026-11-13T09:20:02.000Z","message":{"id":"msg_al","role":"assistant","content":[{"type":"text","text":"Aligned quote."},{"type":"tool_use","id":"toolu_aligned","name":"Edit"}]}}"#.to_string() + "\n";

        let build_exact_tail = |head: &str, tail_end: &str, total: usize| -> String {
            let chunk_pad = "e".repeat(2048);
            let chunk = format!(
                r#"{{"type":"assistant","timestamp":"2026-11-13T09:20:01.000Z","message":{{"id":"msg_pad","role":"assistant","content":[{{"type":"thinking","thinking":"{chunk_pad}"}}]}}}}"#
            ) + "\n";
            let empty_pad_prefix = r#"{"type":"assistant","timestamp":"2026-11-13T09:20:01.000Z","message":{"id":"msg_pad_end","role":"assistant","content":[{"type":"thinking","thinking":""}]}}"#.to_string() + "\n";

            let mut mid = String::new();
            let remaining_after_ends = total - head.len() - tail_end.len();
            while mid.len() + chunk.len() + empty_pad_prefix.len() <= remaining_after_ends {
                mid.push_str(&chunk);
            }
            let final_pad_len = remaining_after_ends - mid.len() - empty_pad_prefix.len();
            let final_pad = "f".repeat(final_pad_len);
            let final_line = format!(
                r#"{{"type":"assistant","timestamp":"2026-11-13T09:20:01.000Z","message":{{"id":"msg_pad_end","role":"assistant","content":[{{"type":"thinking","thinking":"{final_pad}"}}]}}}}"#
            ) + "\n";
            mid.push_str(&final_line);
            assert_eq!(head.len() + mid.len() + tail_end.len(), total);
            mid
        };

        let aligned_mid = build_exact_tail(&user_line, &tail_assistant, max_tail);
        let aligned_path = temp.path().join("aligned_user.jsonl");
        {
            let mut f = File::create(&aligned_path).expect("create aligned_user");
            f.write_all(prefix.as_bytes()).expect("write prefix");
            f.write_all(user_line.as_bytes()).expect("write user_line");
            f.write_all(aligned_mid.as_bytes()).expect("write mid");
            f.write_all(tail_assistant.as_bytes()).expect("write tail");
        }
        let aligned_len = fs::metadata(&aligned_path).expect("meta").len();
        assert_eq!(aligned_len - MAX_TAIL_BYTES, prefix.len() as u64);

        let out_aligned = read_quotes(
            &aligned_path,
            &["toolu_aligned".to_string()],
            nov_13_utc_ms(9, 20, 0, 250),
        )
        .expect("read aligned_user");
        assert!(out_aligned.complete);
        assert_eq!(
            out_aligned.first_user_text,
            Some(("Aligned boundary prompt.".to_string(), false))
        );
        assert_eq!(
            out_aligned
                .quotes
                .get("toolu_aligned")
                .map(|q| q.text.as_str()),
            Some("Aligned quote.")
        );

        let partial_path = temp.path().join("partial_user.jsonl");
        let partial_mid = build_exact_tail(&user_line[1..], &tail_assistant, max_tail);
        {
            let mut f = File::create(&partial_path).expect("create partial_user");
            f.write_all(prefix.as_bytes()).expect("write prefix");
            f.write_all(user_line.as_bytes()).expect("write user_line");
            f.write_all(partial_mid.as_bytes()).expect("write mid");
            f.write_all(tail_assistant.as_bytes()).expect("write tail");
        }
        let out_partial = read_quotes(
            &partial_path,
            &["toolu_aligned".to_string()],
            nov_13_utc_ms(9, 20, 0, 250),
        )
        .expect("read partial_user");
        assert!(!out_partial.complete);
        assert_eq!(out_partial.first_user_text, None);
        assert_eq!(
            out_partial
                .quotes
                .get("toolu_aligned")
                .map(|q| q.text.as_str()),
            Some("Aligned quote.")
        );

        let aligned_assist = r#"{"type":"assistant","timestamp":"2026-11-13T09:21:01.000Z","message":{"id":"msg_al_a","role":"assistant","content":[{"type":"text","text":"Aligned tool quote."},{"type":"tool_use","id":"toolu_aligned_assist","name":"Edit"}]}}"#.to_string() + "\n";
        let assist_end = r#"{"type":"assistant","timestamp":"2026-11-13T09:21:02.000Z","message":{"id":"msg_end","role":"assistant","content":[{"type":"thinking","thinking":"done"}]}}"#.to_string() + "\n";
        let assist_mid = build_exact_tail(&aligned_assist, &assist_end, max_tail);
        let aligned_assist_path = temp.path().join("aligned_assistant.jsonl");
        {
            let mut f = File::create(&aligned_assist_path).expect("create aligned_assistant");
            let early_user = r#"{"type":"user","timestamp":"2026-11-13T09:21:00.000Z","message":{"role":"user","content":"Before window user."}}"#.to_string() + "\n";
            f.write_all(early_user.as_bytes()).expect("write early");
            f.write_all(aligned_assist.as_bytes())
                .expect("write aligned_assist");
            f.write_all(assist_mid.as_bytes()).expect("write mid");
            f.write_all(assist_end.as_bytes()).expect("write end");
        }
        let out_assist = read_quotes(
            &aligned_assist_path,
            &["toolu_aligned_assist".to_string()],
            nov_13_utc_ms(9, 21, 0, 250),
        )
        .expect("read aligned_assistant");
        assert!(!out_assist.complete);
        assert_eq!(out_assist.first_user_text, None);
        assert_eq!(
            out_assist
                .quotes
                .get("toolu_aligned_assist")
                .map(|q| q.text.as_str()),
            Some("Aligned tool quote.")
        );
    }

    #[test]
    fn missing_and_unparseable_timestamps_fall_back_to_tool_ids() {
        let temp = TempDir::new().expect("tempdir");
        let path = temp.path().join("fallback_timestamps.jsonl");
        let lines = [
            r#"{"type":"user","message":{"role":"user","content":"First untimestamped prompt"}}"#,
            r#"{"type":"assistant","timestamp":"not-a-timestamp","message":{"id":"msg_u1","role":"assistant","content":[{"type":"text","text":"First untimestamped quote"},{"type":"tool_use","id":"toolu_un_1","name":"Edit"}]}}"#,
            r#"{"type":"user","timestamp":"2026-11-13 09:22:00Z","message":{"role":"user","content":"Second space-sep prompt"}}"#,
            r#"{"type":"assistant","timestamp":"2026-11-13T09:22:00+00:00","message":{"id":"msg_u2","role":"assistant","content":[{"type":"text","text":"Second offset quote"},{"type":"tool_use","id":"toolu_un_2","name":"Edit"}]}}"#,
            r#"{"type":"user","timestamp":"2026-02-29T00:00:00Z","message":{"role":"user","content":"Third invalid leap prompt"}}"#,
            r#"{"type":"assistant","timestamp":"2026-11-13T09:23:00.Z","message":{"id":"msg_u3","role":"assistant","content":[{"type":"text","text":"Third bad frac quote"},{"type":"tool_use","id":"toolu_un_3","name":"Edit"}]}}"#,
        ];
        fs::write(&path, format!("{}\n", lines.join("\n"))).expect("write fallback_timestamps");

        let out = read_quotes(
            &path,
            &["toolu_un_1".to_string()],
            nov_13_utc_ms(9, 22, 5, 0),
        )
        .expect("read fallback_timestamps");
        assert!(out.complete);
        assert_eq!(
            out.first_user_text,
            Some(("First untimestamped prompt".to_string(), false))
        );
        assert_eq!(
            out.quotes.get("toolu_un_1").map(|q| q.text.as_str()),
            Some("First untimestamped quote")
        );
    }

    #[test]
    fn quote_preserves_leading_and_trailing_whitespace() {
        let temp = TempDir::new().expect("tempdir");
        let path = temp.path().join("verbatim_ws.jsonl");
        let lines = [
            r#"{"type":"user","timestamp":"2026-11-13T09:25:00.000Z","message":{"role":"user","content":"Keep quote whitespace."}}"#,
            r#"{"type":"assistant","timestamp":"2026-11-13T09:25:01.000Z","message":{"id":"msg_ws","role":"assistant","content":[{"type":"text","text":"  Keep indentation.\n"},{"type":"tool_use","id":"toolu_ws","name":"Edit"}]}}"#,
        ];
        fs::write(&path, format!("{}\n", lines.join("\n"))).expect("write verbatim_ws");

        let out = read_quotes(
            &path,
            &["toolu_ws".to_string()],
            nov_13_utc_ms(9, 25, 0, 250),
        )
        .expect("read verbatim_ws");
        assert_eq!(
            out.quotes.get("toolu_ws").map(|q| q.text.as_str()),
            Some("  Keep indentation.\n")
        );
    }

    #[test]
    fn parse_iso_utc_ms_valid_and_invalid_formats() {
        assert_eq!(parse_iso_utc_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_iso_utc_ms("1970-01-01T00:00:00.456Z"), Some(456));
        assert_eq!(
            parse_iso_utc_ms("2026-11-13T09:12:03.456Z"),
            Some(nov_13_utc_ms(9, 12, 3, 456))
        );
        assert_eq!(
            parse_iso_utc_ms("2026-11-13T09:12:03Z"),
            Some(nov_13_utc_ms(9, 12, 3, 0))
        );
        assert_eq!(
            parse_iso_utc_ms("2026-11-13T09:12:03.4Z"),
            Some(nov_13_utc_ms(9, 12, 3, 400))
        );
        assert_eq!(
            parse_iso_utc_ms("2026-11-13T09:12:03.45Z"),
            Some(nov_13_utc_ms(9, 12, 3, 450))
        );
        assert_eq!(
            parse_iso_utc_ms("2026-11-13T09:12:03.456789Z"),
            Some(nov_13_utc_ms(9, 12, 3, 456))
        );
        assert!(parse_iso_utc_ms("2024-02-29T23:59:59.999Z").is_some());
        assert!(parse_iso_utc_ms("2000-02-29T00:00:00Z").is_some());

        for bad in [
            "",
            "1969-12-31T23:59:59Z",
            "1900-02-29T00:00:00Z",
            "2025-02-29T00:00:00Z",
            "2026-11-31T00:00:00Z",
            "2026-13-01T00:00:00Z",
            "2026-00-01T00:00:00Z",
            "2026-11-00T00:00:00Z",
            "2026-11-13T24:00:00Z",
            "2026-11-13T00:60:00Z",
            "2026-11-13T00:00:60Z",
            "2026-11-13 09:12:03Z",
            "2026-11-13T09:12:03+00:00",
            "2026-11-13T09:12:03",
            "2026-11-13T09:12:03.Z",
            "2026-11-13T09:12:03.1234567890Z",
            "2026-11-13T09:12:03.abcZ",
            "2026-11-13t09:12:03z",
        ] {
            assert_eq!(parse_iso_utc_ms(bad), None, "expected None for {bad:?}");
        }
    }

    #[test]
    fn path_outside_projects_rejected() {
        let (temp, cfg, valid) = setup_projects_tree();
        assert_eq!(
            validate_transcript_path(valid.to_str().unwrap(), std::slice::from_ref(&cfg)),
            Some(valid)
        );

        let outside = temp.path().join("outside.jsonl");
        fs::write(&outside, "{}\n").expect("write outside");
        assert_eq!(
            validate_transcript_path(outside.to_str().unwrap(), std::slice::from_ref(&cfg)),
            None
        );

        let projects_evil = cfg.join("projects_evil").join("s.jsonl");
        fs::create_dir_all(projects_evil.parent().unwrap()).expect("create projects_evil");
        fs::write(&projects_evil, "{}\n").expect("write projects_evil");
        assert_eq!(
            validate_transcript_path(projects_evil.to_str().unwrap(), &[cfg]),
            None
        );
    }

    #[test]
    fn symlink_rejected() {
        let (_temp, cfg, valid) = setup_projects_tree();
        assert_eq!(
            validate_transcript_path(valid.to_str().unwrap(), std::slice::from_ref(&cfg)),
            Some(valid.clone())
        );

        let link = valid.parent().unwrap().join("link.jsonl");
        #[cfg(unix)]
        let res = std::os::unix::fs::symlink(&valid, &link);
        #[cfg(windows)]
        let res = std::os::windows::fs::symlink_file(&valid, &link);

        if let Err(err) = res {
            eprintln!("skipping symlink assertion: cannot create symlink on this host: {err}");
            return;
        }
        assert_eq!(
            validate_transcript_path(link.to_str().unwrap(), &[cfg]),
            None
        );
    }

    #[test]
    fn directory_rejected() {
        let (_temp, cfg, valid) = setup_projects_tree();
        assert_eq!(
            validate_transcript_path(valid.to_str().unwrap(), std::slice::from_ref(&cfg)),
            Some(valid.clone())
        );

        let dir_jsonl = valid.parent().unwrap().join("dir.jsonl");
        fs::create_dir_all(&dir_jsonl).expect("create dir.jsonl");
        assert_eq!(
            validate_transcript_path(dir_jsonl.to_str().unwrap(), &[cfg]),
            None
        );
    }

    #[test]
    fn non_jsonl_rejected() {
        let (_temp, cfg, valid) = setup_projects_tree();
        assert_eq!(
            validate_transcript_path(valid.to_str().unwrap(), std::slice::from_ref(&cfg)),
            Some(valid.clone())
        );

        for name in ["session.json", "session.txt", "session"] {
            let p = valid.parent().unwrap().join(name);
            fs::write(&p, "{}\n").expect("write non-jsonl");
            assert_eq!(
                validate_transcript_path(p.to_str().unwrap(), std::slice::from_ref(&cfg)),
                None
            );
        }
    }

    #[test]
    fn relative_path_rejected() {
        let (_temp, cfg, valid) = setup_projects_tree();
        assert_eq!(
            validate_transcript_path(valid.to_str().unwrap(), std::slice::from_ref(&cfg)),
            Some(valid)
        );
        assert_eq!(
            validate_transcript_path("projects/C--work-repo/session.jsonl", &[cfg]),
            None
        );
    }

    #[test]
    fn dotdot_rejected() {
        let (_temp, cfg, valid) = setup_projects_tree();
        assert_eq!(
            validate_transcript_path(valid.to_str().unwrap(), std::slice::from_ref(&cfg)),
            Some(valid.clone())
        );

        let slug_dir = valid.parent().unwrap();
        let dotdot = format!(
            "{}{}..{}C--work-repo{}session.jsonl",
            slug_dir.display(),
            std::path::MAIN_SEPARATOR,
            std::path::MAIN_SEPARATOR,
            std::path::MAIN_SEPARATOR,
        );
        assert_eq!(validate_transcript_path(&dotdot, &[cfg]), None);
    }

    #[test]
    fn verbatim_prefix_spelling_rejected_unless_equal() {
        let (_temp, cfg, valid) = setup_projects_tree();
        let valid_str = valid.to_str().expect("valid str");
        assert_eq!(
            validate_transcript_path(valid_str, std::slice::from_ref(&cfg)),
            Some(valid.clone())
        );

        let verbatim = format!(r"\\?\{valid_str}");
        assert_eq!(
            validate_transcript_path(&verbatim, std::slice::from_ref(&cfg)),
            None
        );

        let dot_segment = valid.parent().unwrap().join(".").join("session.jsonl");
        assert_eq!(
            validate_transcript_path(dot_segment.to_str().unwrap(), std::slice::from_ref(&cfg)),
            None
        );

        #[cfg(windows)]
        {
            let forward = valid_str.replace('\\', "/");
            assert_eq!(
                validate_transcript_path(&forward, std::slice::from_ref(&cfg)),
                None
            );

            // Windows comparison is case-insensitive when canonical spelling otherwise matches.
            let lower = valid_str.to_lowercase();
            assert_eq!(validate_transcript_path(&lower, &[cfg]), Some(valid));
        }
    }

    #[test]
    fn claude_config_dirs_includes_home_and_consent_dirs() {
        let temp = TempDir::new().expect("tempdir");
        let user_home = temp.path().join("user");
        let rocky_home = temp.path().join("rocky");
        let custom_cfg = temp.path().join("custom-claude");
        let other_cfg = temp.path().join("codex-cfg");
        fs::create_dir_all(&rocky_home).expect("create rocky_home");

        let consent_file = rocky_proto::paths::consent_path(&rocky_home);
        fs::create_dir_all(consent_file.parent().expect("consent parent"))
            .expect("create consent parent");

        let consent = serde_json::json!({
            "v": 1,
            "scope": 1,
            "state": "approved",
            "at": 1,
            "harness_off": [],
            "shell_hook": false,
            "config_dirs": {
                "claude-code": [
                    { "location": custom_cfg.to_string_lossy() },
                    { "location": user_home.join(".claude").to_string_lossy() },
                    { "location": "" }
                ],
                "codex": [
                    { "location": other_cfg.to_string_lossy() }
                ]
            }
        });
        fs::write(&consent_file, consent.to_string()).expect("write consent");

        let dirs = claude_config_dirs_from(Some(&user_home), &rocky_home);
        assert_eq!(dirs, vec![user_home.join(".claude"), custom_cfg]);
    }
}
