//! Read-only reader for the Listening store (`events.jsonl` and `objects/`).
//!
//! Reads incrementally from a per-store byte offset, restarts from the tail if
//! the log shrinks after eviction, and enforces the 2 MiB event-tail and
//! 1 MiB object caps. Never opens any store file for writing.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde::Deserialize;

/// Maximum bytes of `events.jsonl` read per call (2 MiB).
pub const MAX_TAIL_BYTES: u64 = 2 * 1024 * 1024;

/// Maximum object size read by [`read_object`] (1 MiB).
pub const MAX_OBJECT_BYTES: u64 = 1024 * 1024;

const EVENTS_FILE: &str = "events.jsonl";
const OBJECTS_DIR: &str = "objects";
const EVENT_VERSION: u64 = 1;
const FILE_VERSION_NODE: &str = "file_version";

/// One parsed `file_version` event from `events.jsonl`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Version {
    pub file_rel: String,
    pub ts: u64,
    pub sha: Option<String>,
    pub prev: Option<String>,
    pub created: bool,
    pub deleted: bool,
    pub baseline: bool,
}

/// What is known about the file content immediately before a [`Version`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Before {
    Known(String),
    Absent,
    Unknown,
}

impl Version {
    /// Resolves the "before" state in precedence order: `prev` -> `Known`,
    /// `created` -> `Absent`, otherwise `Unknown`.
    pub fn before(&self) -> Before {
        if let Some(prev) = self.prev.as_deref().filter(|s| !s.is_empty()) {
            Before::Known(prev.to_string())
        } else if self.created {
            Before::Absent
        } else {
            Before::Unknown
        }
    }
}

/// Outcome of reading a content-addressed object from `objects/`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ObjectRead {
    Text(String),
    TooLarge,
    Missing,
    Invalid,
}

/// Incremental, read-only reader over one repository's `events.jsonl` log.
#[derive(Debug)]
pub struct StoreReader {
    store_dir: PathBuf,
    offset: u64,
}

impl StoreReader {
    /// Creates a reader starting at offset 0 for `store_dir`.
    pub fn new(store_dir: PathBuf) -> StoreReader {
        StoreReader {
            store_dir,
            offset: 0,
        }
    }

    /// Reads newly appended `file_version` events with `ts >= from_ms`,
    /// bounded to at most 2 MiB from the tail. Returns `(versions, tail_cut)`,
    /// where `tail_cut` is `true` when unread bytes remain before the read window.
    pub fn versions_since(&mut self, from_ms: u64) -> io::Result<(Vec<Version>, bool)> {
        let events_path = self.store_dir.join(EVENTS_FILE);
        let meta = match fs::symlink_metadata(&events_path) {
            Ok(meta) => meta,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                self.offset = 0;
                return Ok((Vec::new(), false));
            }
            Err(e) => return Err(e),
        };
        if !meta.file_type().is_file() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "events.jsonl must be a regular file",
            ));
        }

        let mut file = match open_nofollow_readonly(&events_path) {
            Ok(file) => file,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                self.offset = 0;
                return Ok((Vec::new(), false));
            }
            Err(e) => return Err(e),
        };

        let len = file.metadata()?.len();
        // If the log shrank (eviction/compaction), restart from the tail of the new file.
        let base = if len < self.offset { 0 } else { self.offset };
        let start = base.max(len.saturating_sub(MAX_TAIL_BYTES));
        let tail_cut = start > base;
        if start >= len {
            self.offset = len;
            return Ok((Vec::new(), false));
        }

        let mid_line = if tail_cut {
            file.seek(SeekFrom::Start(start - 1))?;
            let mut prev = [0u8; 1];
            if file.read(&mut prev)? == 0 {
                self.offset = 0;
                return Ok((Vec::new(), false));
            }
            prev[0] != b'\n'
        } else {
            file.seek(SeekFrom::Start(start))?;
            false
        };

        let to_read = (len - start).min(MAX_TAIL_BYTES);
        let mut buf = Vec::with_capacity(to_read as usize);
        file.by_ref().take(to_read).read_to_end(&mut buf)?;
        if buf.is_empty() {
            self.offset = file.metadata().map_or(0, |m| m.len().min(start));
            return Ok((Vec::new(), false));
        }
        let end_offset = start + buf.len() as u64;

        let window = if mid_line {
            match buf.iter().position(|&b| b == b'\n') {
                Some(pos) => &buf[pos + 1..],
                None => {
                    self.offset = end_offset;
                    return Ok((Vec::new(), true));
                }
            }
        } else {
            &buf[..]
        };

        let mut versions = Vec::new();
        for line in window.split(|&b| b == b'\n') {
            if let Some(version) = parse_version_line(line)
                && version.ts >= from_ms
            {
                versions.push(version);
            }
        }
        self.offset = end_offset;
        Ok((versions, tail_cut))
    }
}

/// Reads an object from `store_dir/objects/<sha>` read-only.
///
/// Requires `sha` to be 64 lowercase hex characters, checks size before reading
/// (over 1 MiB -> [`ObjectRead::TooLarge`]), and requires valid UTF-8.
pub fn read_object(store_dir: &Path, sha: &str) -> ObjectRead {
    if !is_lower_hex_64(sha) {
        return ObjectRead::Invalid;
    }
    let path = store_dir.join(OBJECTS_DIR).join(sha);
    let meta = match fs::symlink_metadata(&path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return ObjectRead::Missing,
        Err(_) => return ObjectRead::Invalid,
    };
    if !meta.file_type().is_file() {
        return ObjectRead::Invalid;
    }
    if meta.len() > MAX_OBJECT_BYTES {
        return ObjectRead::TooLarge;
    }

    let file = match open_nofollow_readonly(&path) {
        Ok(file) => file,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return ObjectRead::Missing,
        Err(_) => return ObjectRead::Invalid,
    };
    let Ok(opened_meta) = file.metadata() else {
        return ObjectRead::Invalid;
    };
    if opened_meta.len() > MAX_OBJECT_BYTES {
        return ObjectRead::TooLarge;
    }

    let mut buf = Vec::with_capacity(opened_meta.len() as usize);
    if file
        .take(MAX_OBJECT_BYTES + 1)
        .read_to_end(&mut buf)
        .is_err()
    {
        return ObjectRead::Invalid;
    }
    if buf.len() as u64 > MAX_OBJECT_BYTES {
        return ObjectRead::TooLarge;
    }
    match String::from_utf8(buf) {
        Ok(text) => ObjectRead::Text(text),
        Err(_) => ObjectRead::Invalid,
    }
}

fn open_nofollow_readonly(path: &Path) -> io::Result<File> {
    let mut opts = OpenOptions::new();
    opts.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.custom_flags(libc::O_NOFOLLOW);
    }
    let file = opts.open(path)?;
    let opened = file.metadata()?;
    if !opened.file_type().is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "not a regular file",
        ));
    }
    Ok(file)
}

#[derive(Deserialize)]
struct RawEvent {
    #[serde(default)]
    v: Option<u64>,
    #[serde(default)]
    node: Option<String>,
    #[serde(default)]
    ts: Option<u64>,
    #[serde(default)]
    refs: Option<RawRefs>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawRefs {
    #[serde(default)]
    file_rel: Option<String>,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    prev: Option<String>,
    #[serde(default)]
    created: Option<bool>,
    #[serde(default)]
    deleted: Option<bool>,
    #[serde(default)]
    baseline: Option<bool>,
}

fn parse_version_line(raw: &[u8]) -> Option<Version> {
    let trimmed = raw.trim_ascii();
    if trimmed.is_empty() {
        return None;
    }
    let ev: RawEvent = serde_json::from_slice(trimmed).ok()?;
    if ev.v.is_some_and(|v| v != EVENT_VERSION) {
        return None;
    }
    if ev.node.as_deref() != Some(FILE_VERSION_NODE) {
        return None;
    }
    let ts = ev.ts?;
    let refs = ev.refs?;
    let file_rel = refs.file_rel.filter(|s| !s.is_empty())?;
    let deleted = refs.deleted.unwrap_or(false);
    // Deletion events store a random UUID in `refs.version`, not an object sha.
    let sha = if deleted {
        None
    } else {
        refs.version.filter(|s| is_hex_64(s))
    };
    let prev = refs.prev.filter(|s| !s.is_empty());
    Some(Version {
        file_rel,
        ts,
        sha,
        prev,
        created: refs.created.unwrap_or(false),
        deleted,
        baseline: refs.baseline.unwrap_or(false),
    })
}

fn is_hex_64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

fn is_lower_hex_64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

#[cfg(test)]
mod tests {
    use std::fs::{self, OpenOptions};
    use std::io::Write;
    use std::path::Path;

    use serde_json::{Map, Value, json};

    use super::{
        Before, MAX_OBJECT_BYTES, MAX_TAIL_BYTES, ObjectRead, StoreReader, Version, read_object,
    };

    fn sha_char(ch: char) -> String {
        std::iter::repeat_n(ch, 64).collect()
    }

    fn write_object(store_dir: &Path, name: &str, bytes: &[u8]) {
        let objects = store_dir.join("objects");
        fs::create_dir_all(&objects).unwrap();
        fs::write(objects.join(name), bytes).unwrap();
    }

    fn append_bytes(path: &Path, bytes: &[u8]) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        let mut f = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap();
        f.write_all(bytes).unwrap();
    }

    fn file_version_json(
        file_rel: Option<&str>,
        ts: u64,
        version: Option<&str>,
        prev: Option<&str>,
        created: Option<bool>,
        deleted: Option<bool>,
        baseline: Option<bool>,
    ) -> String {
        let mut refs = Map::new();
        if let Some(rel) = file_rel {
            refs.insert("fileRel".into(), json!(rel));
        }
        if let Some(v) = version {
            refs.insert("version".into(), json!(v));
        }
        if let Some(p) = prev {
            refs.insert("prev".into(), json!(p));
        }
        if let Some(c) = created {
            refs.insert("created".into(), json!(c));
        }
        if let Some(d) = deleted {
            refs.insert("deleted".into(), json!(d));
        }
        if let Some(b) = baseline {
            refs.insert("baseline".into(), json!(b));
        }
        json!({
            "v": 1,
            "eventId": format!("ev-{ts}"),
            "source": "watcher",
            "repoRoot": "C:/repo",
            "ts": ts,
            "adapterVersion": "listening-watcher/1",
            "node": "file_version",
            "nodeId": format!("node-{ts}"),
            "consent": { "host": false, "repo": true, "rawTrace": false },
            "redaction": { "applied": true, "truncated": false },
            "coverage": "complete",
            "refs": Value::Object(refs),
        })
        .to_string()
    }

    #[test]
    fn reads_file_version_events_incrementally() {
        let dir = tempfile::tempdir().unwrap();
        let events = dir.path().join("events.jsonl");
        let sha1 = sha_char('1');
        let sha2 = sha_char('2');
        let sha3 = sha_char('3');

        let mut initial = String::new();
        // Before `from_ms`
        initial.push_str(&file_version_json(
            Some("old.ts"),
            100,
            Some(&sha1),
            None,
            None,
            None,
            Some(true),
        ));
        initial.push('\n');
        // Not a file_version node
        initial.push_str(
            &json!({
                "v": 1,
                "eventId": "hunk-1",
                "source": "watcher",
                "ts": 250,
                "adapterVersion": "listening-watcher/1",
                "edge": { "kind": "generated_hunk", "from": "a", "to": "b", "basis": "filesystem_observed" },
                "consent": { "host": false, "repo": true, "rawTrace": false },
                "redaction": { "applied": true, "truncated": false },
                "coverage": "complete",
                "refs": { "fileRel": "a.ts", "version": "a" }
            })
            .to_string(),
        );
        initial.push('\n');
        // Missing fileRel
        initial.push_str(&file_version_json(
            None,
            260,
            Some(&sha1),
            None,
            None,
            None,
            None,
        ));
        initial.push('\n');
        // Included in first read
        initial.push_str(&file_version_json(
            Some("a.ts"),
            200,
            Some(&sha1),
            None,
            Some(true),
            None,
            Some(true),
        ));
        initial.push('\n');
        append_bytes(&events, initial.as_bytes());

        let mut reader = StoreReader::new(dir.path().to_path_buf());
        let (first, tail_cut) = reader.versions_since(200).unwrap();
        assert!(!tail_cut);
        assert_eq!(
            first,
            vec![Version {
                file_rel: "a.ts".into(),
                ts: 200,
                sha: Some(sha1),
                prev: None,
                created: true,
                deleted: false,
                baseline: true,
            }]
        );

        // Append more events and confirm disjoint incremental read.
        let mut more = String::new();
        more.push_str(&file_version_json(
            Some("b.ts"),
            300,
            Some(&sha2),
            Some(&sha3),
            None,
            None,
            None,
        ));
        more.push('\n');
        append_bytes(&events, more.as_bytes());

        let (second, tail_cut) = reader.versions_since(200).unwrap();
        assert!(!tail_cut);
        assert_eq!(
            second,
            vec![Version {
                file_rel: "b.ts".into(),
                ts: 300,
                sha: Some(sha2),
                prev: Some(sha3),
                created: false,
                deleted: false,
                baseline: false,
            }]
        );

        let (third, tail_cut) = reader.versions_since(200).unwrap();
        assert!(!tail_cut);
        assert!(third.is_empty());
    }

    #[test]
    fn before_follows_prev_created_unknown() {
        let dir = tempfile::tempdir().unwrap();
        let events = dir.path().join("events.jsonl");
        let prev_sha = sha_char('a');
        let cur_sha = sha_char('b');

        let lines = [
            // prev takes precedence even if created and baseline are true
            file_version_json(
                Some("with_prev.ts"),
                10,
                Some(&cur_sha),
                Some(&prev_sha),
                Some(true),
                None,
                Some(true),
            ),
            // created + baseline without prev -> Absent
            file_version_json(
                Some("created_and_baseline.ts"),
                20,
                Some(&cur_sha),
                None,
                Some(true),
                None,
                Some(true),
            ),
            // baseline only -> Unknown
            file_version_json(
                Some("baseline_only.ts"),
                30,
                Some(&cur_sha),
                None,
                None,
                None,
                Some(true),
            ),
            // old event without prev, created, or baseline -> Unknown
            file_version_json(
                Some("old_event.ts"),
                40,
                Some(&cur_sha),
                None,
                None,
                None,
                None,
            ),
        ];
        append_bytes(&events, format!("{}\n", lines.join("\n")).as_bytes());

        let mut reader = StoreReader::new(dir.path().to_path_buf());
        let (versions, tail_cut) = reader.versions_since(0).unwrap();
        assert!(!tail_cut);
        assert_eq!(versions.len(), 4);
        assert_eq!(versions[0].before(), Before::Known(prev_sha));
        assert_eq!(versions[1].before(), Before::Absent);
        assert_eq!(versions[2].before(), Before::Unknown);
        assert_eq!(versions[3].before(), Before::Unknown);
    }

    #[test]
    fn deletion_version_has_no_sha() {
        let dir = tempfile::tempdir().unwrap();
        let events = dir.path().join("events.jsonl");
        let prev_sha = sha_char('c');
        let decoy_hex = sha_char('d');

        let lines = [
            // Typical deletion with random UUID in refs.version
            file_version_json(
                Some("removed.ts"),
                100,
                Some("550e8400-e29b-41d4-a716-446655440000"),
                Some(&prev_sha),
                None,
                Some(true),
                None,
            ),
            // Deletion even if refs.version happens to be 64 hex chars
            file_version_json(
                Some("removed2.ts"),
                200,
                Some(&decoy_hex),
                Some(&prev_sha),
                None,
                Some(true),
                None,
            ),
            // Non-deletion with non-64-hex version also yields None sha
            file_version_json(
                Some("legacy.ts"),
                300,
                Some("550e8400-e29b-41d4-a716-446655440000"),
                None,
                None,
                None,
                None,
            ),
        ];
        append_bytes(&events, format!("{}\n", lines.join("\n")).as_bytes());

        let mut reader = StoreReader::new(dir.path().to_path_buf());
        let (versions, _) = reader.versions_since(0).unwrap();
        assert_eq!(versions.len(), 3);
        assert!(versions[0].deleted);
        assert_eq!(versions[0].sha, None);
        assert_eq!(versions[0].before(), Before::Known(prev_sha.clone()));

        assert!(versions[1].deleted);
        assert_eq!(versions[1].sha, None);
        assert_eq!(versions[1].before(), Before::Known(prev_sha));

        assert!(!versions[2].deleted);
        assert_eq!(versions[2].sha, None);
    }

    #[test]
    fn shrunk_log_restarts_from_tail() {
        let dir = tempfile::tempdir().unwrap();
        let events = dir.path().join("events.jsonl");
        let sha1 = sha_char('1');
        let sha2 = sha_char('2');

        let mut initial = String::new();
        for i in 0..5 {
            initial.push_str(&file_version_json(
                Some(&format!("initial_{i}.ts")),
                100 + i,
                Some(&sha1),
                None,
                None,
                None,
                None,
            ));
            initial.push('\n');
        }
        append_bytes(&events, initial.as_bytes());

        let mut reader = StoreReader::new(dir.path().to_path_buf());
        let (first, tail_cut) = reader.versions_since(0).unwrap();
        assert_eq!(first.len(), 5);
        assert!(!tail_cut);

        // Simulate compaction/eviction shrinking the file below the prior offset.
        let replacement = format!(
            "{}\n",
            file_version_json(
                Some("after_shrink.ts"),
                500,
                Some(&sha2),
                Some(&sha1),
                None,
                None,
                None,
            )
        );
        assert!(replacement.len() < initial.len());
        fs::write(&events, replacement.as_bytes()).unwrap();

        let (second, tail_cut) = reader.versions_since(0).unwrap();
        assert!(!tail_cut);
        assert_eq!(second.len(), 1);
        assert_eq!(second[0].file_rel, "after_shrink.ts");
        assert_eq!(second[0].ts, 500);
    }

    #[test]
    fn shrunk_log_over_2_mib_restarts_from_tail_window() {
        let dir = tempfile::tempdir().unwrap();
        let events = dir.path().join("events.jsonl");
        let sha1 = sha_char('1');
        let sha2 = sha_char('2');

        let pad_line = format!("{{\"v\":1,\"pad\":\"{}\"}}\n", "x".repeat(1000));
        let mut initial = Vec::new();
        while initial.len() <= MAX_TAIL_BYTES as usize + 512 * 1024 {
            initial.extend_from_slice(pad_line.as_bytes());
        }
        fs::write(&events, &initial).unwrap();

        let mut reader = StoreReader::new(dir.path().to_path_buf());
        let (_, tail_cut) = reader.versions_since(0).unwrap();
        assert!(tail_cut);

        // Shrink from ~2.5 MiB down to ~2.2 MiB with an early event outside the 2 MiB tail
        // and a recent event inside the 2 MiB tail.
        let mut compacted = Vec::new();
        compacted.extend_from_slice(
            file_version_json(
                Some("evicted_head.ts"),
                10,
                Some(&sha1),
                None,
                None,
                None,
                None,
            )
            .as_bytes(),
        );
        compacted.push(b'\n');
        while compacted.len() <= MAX_TAIL_BYTES as usize + 128 * 1024 {
            compacted.extend_from_slice(pad_line.as_bytes());
        }
        compacted.extend_from_slice(
            file_version_json(
                Some("kept_tail.ts"),
                20,
                Some(&sha2),
                Some(&sha1),
                None,
                None,
                None,
            )
            .as_bytes(),
        );
        compacted.push(b'\n');
        assert!(compacted.len() < initial.len());
        fs::write(&events, &compacted).unwrap();

        let (versions, tail_cut) = reader.versions_since(0).unwrap();
        assert!(tail_cut);
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].file_rel, "kept_tail.ts");
    }

    #[test]
    fn tail_over_2_mib_sets_tail_cut() {
        let dir = tempfile::tempdir().unwrap();
        let events = dir.path().join("events.jsonl");
        let sha1 = sha_char('1');
        let sha2 = sha_char('2');

        let mut data = String::new();
        let early = file_version_json(Some("early.ts"), 100, Some(&sha1), None, None, None, None);
        data.push_str(&early);
        data.push('\n');

        let pad_line = format!("{{\"v\":1,\"pad\":\"{}\"}}\n", "x".repeat(1000));
        while data.len() <= MAX_TAIL_BYTES as usize + 4096 {
            data.push_str(&pad_line);
        }

        let recent = file_version_json(
            Some("recent.ts"),
            999,
            Some(&sha2),
            Some(&sha1),
            None,
            None,
            None,
        );
        data.push_str(&recent);
        data.push('\n');
        fs::write(&events, data.as_bytes()).unwrap();

        let mut reader = StoreReader::new(dir.path().to_path_buf());
        let (versions, tail_cut) = reader.versions_since(0).unwrap();
        assert!(tail_cut);
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].file_rel, "recent.ts");
        assert_eq!(versions[0].ts, 999);

        // Following small append fits inside 2 MiB and has tail_cut = false.
        let followup = format!(
            "{}\n",
            file_version_json(
                Some("next.ts"),
                1000,
                Some(&sha1),
                Some(&sha2),
                None,
                None,
                None,
            )
        );
        append_bytes(&events, followup.as_bytes());
        let (next, tail_cut) = reader.versions_since(0).unwrap();
        assert!(!tail_cut);
        assert_eq!(next.len(), 1);
        assert_eq!(next[0].file_rel, "next.ts");

        // Appending > 2 MiB from a non-zero offset also cuts to the 2 MiB tail.
        let mut burst = Vec::new();
        burst.extend_from_slice(
            file_version_json(
                Some("dropped_burst.ts"),
                1100,
                Some(&sha1),
                None,
                None,
                None,
                None,
            )
            .as_bytes(),
        );
        burst.push(b'\n');
        while burst.len() <= MAX_TAIL_BYTES as usize + 4096 {
            burst.extend_from_slice(pad_line.as_bytes());
        }
        burst.extend_from_slice(
            file_version_json(
                Some("kept_burst.ts"),
                1200,
                Some(&sha2),
                Some(&sha1),
                None,
                None,
                None,
            )
            .as_bytes(),
        );
        burst.push(b'\n');
        append_bytes(&events, &burst);

        let (burst_versions, tail_cut) = reader.versions_since(0).unwrap();
        assert!(tail_cut);
        assert_eq!(burst_versions.len(), 1);
        assert_eq!(burst_versions[0].file_rel, "kept_burst.ts");
    }

    #[test]
    fn tail_window_boundary_exact_and_line_aligned() {
        let dir = tempfile::tempdir().unwrap();
        let events = dir.path().join("events.jsonl");
        let sha1 = sha_char('1');
        let sha2 = sha_char('2');

        // Exact 2 MiB file -> tail_cut is false and first line is kept.
        let first_line = format!(
            "{}\n",
            file_version_json(Some("first.ts"), 10, Some(&sha1), None, None, None, None)
        );
        let pad_count = MAX_TAIL_BYTES as usize - first_line.len();
        let mut exact = first_line.into_bytes();
        exact.resize(exact.len() + pad_count - 1, b' ');
        exact.push(b'\n');
        assert_eq!(exact.len(), MAX_TAIL_BYTES as usize);
        fs::write(&events, &exact).unwrap();

        let mut reader = StoreReader::new(dir.path().to_path_buf());
        let (versions, tail_cut) = reader.versions_since(0).unwrap();
        assert!(!tail_cut);
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].file_rel, "first.ts");

        // File of 2 MiB + 1 where the 2 MiB window begins right after a newline:
        // unread bytes exist before the window (tail_cut == true), and the line
        // starting right at `len - 2 MiB` must still be parsed.
        let mut aligned = vec![b'\n'];
        let boundary_line = format!(
            "{}\n",
            file_version_json(Some("aligned.ts"), 20, Some(&sha2), None, None, None, None)
        );
        aligned.extend_from_slice(boundary_line.as_bytes());
        aligned.resize(MAX_TAIL_BYTES as usize, b' ');
        aligned.push(b'\n');
        assert_eq!(aligned.len(), MAX_TAIL_BYTES as usize + 1);
        fs::write(&events, &aligned).unwrap();

        let mut reader2 = StoreReader::new(dir.path().to_path_buf());
        let (versions, tail_cut) = reader2.versions_since(0).unwrap();
        assert!(tail_cut);
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].file_rel, "aligned.ts");
    }

    #[test]
    fn missing_events_log_returns_empty_and_recovers_when_created() {
        let dir = tempfile::tempdir().unwrap();
        let events = dir.path().join("events.jsonl");
        let sha1 = sha_char('1');

        let mut reader = StoreReader::new(dir.path().to_path_buf());
        let (versions, tail_cut) = reader.versions_since(0).unwrap();
        assert!(!tail_cut);
        assert!(versions.is_empty());

        append_bytes(
            &events,
            format!(
                "{}\n",
                file_version_json(
                    Some("new.ts"),
                    50,
                    Some(&sha1),
                    None,
                    Some(true),
                    None,
                    None
                )
            )
            .as_bytes(),
        );
        let (versions, tail_cut) = reader.versions_since(0).unwrap();
        assert!(!tail_cut);
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].file_rel, "new.ts");
    }

    #[test]
    fn object_name_must_be_64_hex() {
        let dir = tempfile::tempdir().unwrap();
        let valid = sha_char('a');
        write_object(dir.path(), &valid, b"hello");

        assert_eq!(read_object(dir.path(), "../x"), ObjectRead::Invalid);
        assert_eq!(
            read_object(dir.path(), &"A".repeat(64)),
            ObjectRead::Invalid
        );
        assert_eq!(
            read_object(dir.path(), &format!("{}F", "a".repeat(63))),
            ObjectRead::Invalid
        );
        assert_eq!(
            read_object(dir.path(), &"a".repeat(63)),
            ObjectRead::Invalid
        );
        assert_eq!(
            read_object(dir.path(), &"a".repeat(65)),
            ObjectRead::Invalid
        );
        assert_eq!(read_object(dir.path(), ""), ObjectRead::Invalid);
        assert_eq!(
            read_object(dir.path(), &valid),
            ObjectRead::Text("hello".into())
        );
    }

    #[test]
    fn object_over_1_mib_is_too_large() {
        let dir = tempfile::tempdir().unwrap();
        let exact = sha_char('1');
        let over = sha_char('2');

        write_object(dir.path(), &exact, &vec![b'a'; MAX_OBJECT_BYTES as usize]);
        write_object(
            dir.path(),
            &over,
            &vec![b'b'; MAX_OBJECT_BYTES as usize + 1],
        );

        assert!(
            matches!(read_object(dir.path(), &exact), ObjectRead::Text(s) if s.len() == MAX_OBJECT_BYTES as usize)
        );
        assert_eq!(read_object(dir.path(), &over), ObjectRead::TooLarge);
    }

    #[test]
    fn missing_object() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_object(dir.path(), &sha_char('f')), ObjectRead::Missing);
    }

    #[test]
    fn non_utf8_object_is_invalid() {
        let dir = tempfile::tempdir().unwrap();
        let sha = sha_char('e');
        write_object(dir.path(), &sha, &[0xff, 0xfe, 0x00, 0x80]);
        assert_eq!(read_object(dir.path(), &sha), ObjectRead::Invalid);

        let dir_obj = sha_char('d');
        fs::create_dir_all(dir.path().join("objects").join(&dir_obj)).unwrap();
        assert_eq!(read_object(dir.path(), &dir_obj), ObjectRead::Invalid);
    }

    #[test]
    fn malformed_lines_are_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let events = dir.path().join("events.jsonl");
        let sha1 = sha_char('1');
        let sha2 = sha_char('2');

        let mut raw = Vec::new();
        raw.extend_from_slice(
            file_version_json(Some("first.ts"), 10, Some(&sha1), None, None, None, None).as_bytes(),
        );
        raw.extend_from_slice(b"\nnot json at all\n");
        raw.extend_from_slice(b"{\"v\":1,\"node\":\"file_version\"\n");
        raw.extend_from_slice(b"[1,2,3]\n");
        raw.extend_from_slice(
            b"{\"v\":1,\"node\":\"file_version\",\"ts\":\"bad\",\"refs\":{\"fileRel\":\"x.ts\"}}\n",
        );
        raw.extend_from_slice(
            b"{\"v\":2,\"node\":\"file_version\",\"ts\":15,\"refs\":{\"fileRel\":\"v2.ts\"}}\n",
        );
        raw.extend_from_slice(b"\xff\xfe\x80\n");
        raw.extend_from_slice(b"\n");
        raw.extend_from_slice(
            file_version_json(
                Some("second.ts"),
                20,
                Some(&sha2),
                Some(&sha1),
                None,
                None,
                None,
            )
            .as_bytes(),
        );
        raw.push(b'\n');
        fs::write(&events, &raw).unwrap();

        let mut reader = StoreReader::new(dir.path().to_path_buf());
        let (versions, tail_cut) = reader.versions_since(0).unwrap();
        assert!(!tail_cut);
        assert_eq!(versions.len(), 2);
        assert_eq!(versions[0].file_rel, "first.ts");
        assert_eq!(versions[1].file_rel, "second.ts");
    }
}
