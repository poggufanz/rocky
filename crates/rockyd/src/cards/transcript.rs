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
    let _ = turn_started_ms;
    let (buf, tail_cut) = read_tail(path)?;

    let window = if tail_cut {
        match buf.iter().position(|&b| b == b'\n') {
            Some(pos) => &buf[pos + 1..],
            None => {
                return Ok(TranscriptRead {
                    quotes: BTreeMap::new(),
                    first_user_text: None,
                    complete: false,
                });
            }
        }
    } else {
        buf.as_slice()
    };

    let targets: HashSet<&str> = tool_use_ids.iter().map(String::as_str).collect();
    let scan = scan_window_backwards(window, &targets);
    let complete = scan.found_turn_start || !tail_cut;
    let first_user_raw = if scan.found_turn_start {
        scan.turn_user_text
    } else if !tail_cut {
        scan.latest_turn_user_text
    } else {
        None
    };

    Ok(TranscriptRead {
        quotes: replay_turn(scan.assistant_lines_rev, &targets),
        first_user_text: first_user_raw.as_deref().map(bound_prompt),
        complete,
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

fn read_tail(path: &Path) -> io::Result<(Vec<u8>, bool)> {
    let mut file = open_nofollow_readonly(path)?;
    let len = file.metadata()?.len();
    let tail_cut = len > MAX_TAIL_BYTES;
    let start = len.saturating_sub(MAX_TAIL_BYTES);
    file.seek(SeekFrom::Start(start))?;

    let cap = usize::try_from(len - start).unwrap_or(MAX_TAIL_BYTES as usize);
    let mut buf = Vec::with_capacity(cap);
    file.take(MAX_TAIL_BYTES).read_to_end(&mut buf)?;
    Ok((buf, tail_cut))
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

struct WindowScan {
    assistant_lines_rev: Vec<AssistantLine>,
    found_turn_start: bool,
    turn_user_text: Option<String>,
    latest_turn_user_text: Option<String>,
}

fn scan_window_backwards(window: &[u8], targets: &HashSet<&str>) -> WindowScan {
    let mut assistant_lines_rev = Vec::new();
    let mut seen_target = false;
    let mut found_turn_start = false;
    let mut turn_user_text = None;
    let mut latest_turn_user_text: Option<Option<String>> = None;

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

        match kind.as_str() {
            "assistant" => {
                if let Some(line) = parse_assistant_line(parsed.message) {
                    if line.events.iter().any(|ev| {
                        matches!(ev, AssistantEvent::ToolUse(id) if targets.contains(id.as_str()))
                    }) {
                        seen_target = true;
                    }
                    assistant_lines_rev.push(line);
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
                if targets.is_empty() || seen_target {
                    found_turn_start = true;
                    turn_user_text = user_text;
                    break;
                }
                // Target tool uses belong to an earlier turn; discard newer turn chatter and keep scanning.
                if latest_turn_user_text.is_none() {
                    latest_turn_user_text = Some(user_text);
                }
                assistant_lines_rev.clear();
            }
            _ => {}
        }
    }

    WindowScan {
        assistant_lines_rev,
        found_turn_start,
        turn_user_text,
        latest_turn_user_text: latest_turn_user_text.flatten(),
    }
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
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let scan_end = floor_char_boundary(trimmed, PROMPT_SCAN_BYTES);
    let may_be_truncated = scan_end < trimmed.len();
    let redacted = redact_secrets_at_boundary(&trimmed[..scan_end], may_be_truncated);
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

    #[test]
    fn quote_from_same_message_before_tool_use() {
        let path = synthetic_fixture("same_message.jsonl");
        let ids = vec!["toolu_01".to_string()];
        let out = read_quotes(&path, &ids, 0).expect("read same_message.jsonl");

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
        let out = read_quotes(&path, &ids, 0).expect("read shared_fallback.jsonl");

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
        let out = read_quotes(&path, &ids, 0).expect("read no_text.jsonl");

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
        let out = read_quotes(&path, &ids, 0).expect("read thinking_secret.jsonl");

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
        let out = read_quotes(&path, &ids, 0).expect("read malformed.jsonl");

        assert!(out.complete);
        let q = out.quotes.get("toolu_07").expect("quote for toolu_07");
        assert!(!q.shared);
        assert_eq!(q.text, "Applying parser fix safely.");

        let temp = TempDir::new().expect("tempdir");
        let bad_utf8 = temp.path().join("bad_utf8.jsonl");
        let mut f = File::create(&bad_utf8).expect("create bad_utf8");
        f.write_all(br#"{"type":"user","message":{"role":"user","content":"Recover cleanly"}}"#)
            .expect("write user");
        f.write_all(b"\n\xff\xfe\xfd not utf8\n")
            .expect("write invalid utf8");
        f.write_all(
            br#"{"type":"assistant","message":{"id":"msg_u","role":"assistant","content":[{"type":"text","text":"Recovered after bad bytes."},{"type":"tool_use","id":"toolu_utf8","name":"Edit"}]}}"#,
        )
        .expect("write assistant");
        f.write_all(b"\n").expect("newline");

        let out_utf8 =
            read_quotes(&bad_utf8, &["toolu_utf8".to_string()], 0).expect("read bad_utf8");
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
        let out = read_quotes(&path, &ids, 0).expect("read redact_and_cut.jsonl");

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
                r#"{{"type":"user","message":{{"role":"user","content":"Initial prompt outside 8 MiB"}}}}"#
            )
            .expect("write user");
            let pad = "a".repeat(2048);
            let filler = format!(
                r#"{{"type":"assistant","message":{{"id":"msg_pad","role":"assistant","content":[{{"type":"thinking","thinking":"{pad}"}}]}}}}"#
            );
            for _ in 0..4200 {
                writeln!(f, "{filler}").expect("write filler");
            }
            writeln!(
                f,
                r#"{{"type":"assistant","message":{{"id":"msg_tail","role":"assistant","content":[{{"type":"text","text":"Editing file near tail."}},{{"type":"tool_use","id":"toolu_tail","name":"Edit"}}]}}}}"#
            )
            .expect("write tail assistant");
        }

        let out = read_quotes(&path_incomplete, &["toolu_tail".to_string()], 0)
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
                r#"{{"type":"assistant","message":{{"id":"msg_old","role":"assistant","content":[{{"type":"text","text":"{pad}"}}]}}}}"#
            );
            for _ in 0..4200 {
                writeln!(f, "{filler}").expect("write filler");
            }
            writeln!(
                f,
                r#"{{"type":"user","message":{{"role":"user","content":"Recent prompt inside window"}}}}"#
            )
            .expect("write recent user");
            writeln!(
                f,
                r#"{{"type":"assistant","message":{{"id":"msg_new","role":"assistant","content":[{{"type":"tool_use","id":"toolu_new","name":"Edit"}}]}}}}"#
            )
            .expect("write recent assistant");
        }

        let out2 = read_quotes(&path_complete, &["toolu_new".to_string()], 0)
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
        let out = read_quotes(&path, &[], 0).expect("read subagent_prompt.jsonl");

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
            "message": { "role": "user", "content": long_prompt }
        });
        fs::write(&long_path, format!("{line}\n")).expect("write long_subagent");

        let out_long = read_quotes(&long_path, &[], 0).expect("read long_subagent");
        assert!(out_long.complete);
        let (text, truncated) = out_long.first_user_text.expect("long first_user_text");
        assert!(truncated);
        assert!(!text.contains("AKIAABCDEFGHIJKLMNOP"));
        assert_eq!(text.chars().count(), rocky_proto::redact::PROMPT_MAX_CHARS);
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
