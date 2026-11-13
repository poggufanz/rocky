//! Spool ingest: apply spool records to the status machine, record them in
//! desk history, then delete or quarantine.
//!
//! `rockyd` is the only process that deletes or moves spool files.

use std::collections::HashSet;
use std::ffi::OsStr;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use rocky_proto::history::{HISTORY_VERSION, HistoryBody, HistoryLine};
use rocky_proto::hook::HookEvent;
use rocky_proto::pipe::{Gap, GapReason, Health, RepoInfo};
use rocky_proto::spool::{
    SHELL_ENV_VARS, SPOOL_VERSION, SpoolBody, SpoolRecord, peek_spool_version,
};

use crate::history::History;
use crate::state::{ApplyOutcome, Changes, StatusState};

pub const MAX_FILES: usize = 10_000;
pub const MAX_BYTES: u64 = 50 * 1024 * 1024;
pub const BAD_CAP: usize = 100;

/// Result of a spool prune: how many files went, and the coverage gap for them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Pruned {
    pub deleted: u64,
    pub gap: Option<Gap>,
}

/// Delete oldest top-level `*.json` files until count and total bytes fit the limits.
/// Does not touch [`Health`].
pub fn prune(spool: &Path, max_files: usize, max_bytes: u64, now_ms: u64) -> io::Result<Pruned> {
    let mut files: Vec<(PathBuf, u64)> = Vec::new();
    for entry in fs::read_dir(spool)?.flatten() {
        if !entry.file_type().is_ok_and(|t| t.is_file()) {
            continue;
        }
        if entry.path().extension() != Some(OsStr::new("json")) {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        files.push((entry.path(), meta.len()));
    }
    files.sort_by(|a, b| a.0.file_name().cmp(&b.0.file_name()));

    let mut count = files.len();
    let mut bytes: u64 = files.iter().map(|f| f.1).sum();
    let mut deleted = 0u64;
    let mut from_ms: Option<u64> = None;
    let mut to_ms: Option<u64> = None;
    for (path, size) in &files {
        if count <= max_files && bytes <= max_bytes {
            break;
        }
        match fs::remove_file(path) {
            Ok(()) => {
                count -= 1;
                bytes = bytes.saturating_sub(*size);
                deleted += 1;
                if let Some(ms) = path
                    .file_name()
                    .and_then(OsStr::to_str)
                    .and_then(spool_name_ms)
                {
                    from_ms = Some(from_ms.map_or(ms, |v| v.min(ms)));
                    to_ms = Some(to_ms.map_or(ms, |v| v.max(ms)));
                }
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                count -= 1;
                bytes = bytes.saturating_sub(*size);
            }
            Err(_) => {}
        }
    }
    let gap = (deleted > 0).then(|| Gap {
        from_ms: from_ms.unwrap_or(now_ms),
        to_ms: to_ms.unwrap_or(now_ms),
        count: deleted,
        reason: GapReason::SpoolFull,
    });
    Ok(Pruned { deleted, gap })
}

/// The leading 13 ASCII digits of a spool file name, read as milliseconds.
pub fn spool_name_ms(name: &str) -> Option<u64> {
    let digits = name.as_bytes().get(..13)?;
    if !digits.iter().all(u8::is_ascii_digit) {
        return None;
    }
    std::str::from_utf8(digits).ok()?.parse().ok()
}

/// What one ingest pass produced beyond the status machine.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct IngestOutput {
    pub changes: Changes,
    pub gaps: Vec<Gap>,
    pub history_errors: u64,
    /// `(harness, location)` pairs from shell records and claude-code events, in file-name order.
    pub config_locations: Vec<(String, String)>,
}

#[derive(Debug, Default)]
pub struct Ingestor {
    pub health: Health,
    applied: HashSet<PathBuf>,
}

impl Ingestor {
    pub fn new() -> Self {
        Self::default()
    }

    /// Marks spool files as already applied, so the next scan deletes them
    /// without re-applying them or writing history lines again.
    pub fn seed_applied(&mut self, spool: &Path, names: &HashSet<String>) {
        for name in names {
            self.applied.insert(spool.join(name));
        }
    }

    /// Scan `spool` once: apply every top-level `*.json` in file-name order,
    /// write one history line per consumed file, delete what was applied, and
    /// quarantine the rest to `bad/`. Returns merged [`Changes`], gaps, and the
    /// config locations the pass saw.
    pub fn ingest_once(
        &mut self,
        spool: &Path,
        state: &mut StatusState,
        repo_of: &mut dyn FnMut(&str) -> RepoInfo,
        history: &mut History,
        now_ms: u64,
    ) -> IngestOutput {
        let mut changes = Changes::default();
        let mut gaps = Vec::new();
        let mut history_errors = 0u64;
        let mut seen_upserted = HashSet::new();
        let mut seen_removed = HashSet::new();
        let mut config_locations = Vec::new();
        for path in json_files(spool) {
            if self.applied.contains(&path) {
                // Applied earlier, history line already written; only re-try
                // the delete, never re-apply.
                if try_delete(&path) {
                    self.applied.remove(&path);
                }
                continue;
            }
            let Ok(bytes) = fs::read(&path) else {
                // Transient (vanished mid-scan or locked): leave it for the next scan.
                continue;
            };
            let Some(name) = path.file_name().map(|n| n.to_string_lossy().into_owned()) else {
                continue;
            };
            match serde_json::from_slice::<SpoolRecord>(&bytes) {
                Ok(rec) if rec.v == SPOOL_VERSION => {
                    match rec.body {
                        SpoolBody::Event { event } => {
                            let config_dir = rec
                                .config_dir
                                .as_deref()
                                .filter(|_| rec.harness == "claude-code");
                            if let Some(dir) = config_dir {
                                config_locations.push(("claude-code".to_string(), dir.to_string()));
                            }
                            let event = HookEvent {
                                prompt: None,
                                ..event
                            };
                            let ev = state.prepare(event);
                            if let ApplyOutcome::Changed(c) = state.apply(&ev, rec.recv_ms, repo_of)
                            {
                                for key in c.upserted {
                                    if seen_upserted.insert(key.clone()) {
                                        changes.upserted.push(key);
                                    }
                                }
                                for key in c.removed {
                                    if seen_removed.insert(key.clone()) {
                                        changes.removed.push(key);
                                    }
                                }
                            } else {
                                self.health.late_events += 1;
                            }
                            let line = HistoryLine {
                                v: HISTORY_VERSION,
                                body: HistoryBody::Event {
                                    harness: rec.harness,
                                    recv_ms: rec.recv_ms,
                                    event: ev,
                                },
                                src: Some(name),
                            };
                            if !append_line(history, &line, now_ms, &mut gaps) {
                                history_errors += 1;
                            }
                        }
                        SpoolBody::Dropped { .. } => {
                            self.health.dropped_events += 1;
                            let gap = Gap {
                                from_ms: rec.recv_ms,
                                to_ms: rec.recv_ms,
                                count: 1,
                                reason: GapReason::HookDropped,
                            };
                            gaps.push(gap);
                            let line = gap_line(gap, Some(name));
                            if !append_line(history, &line, now_ms, &mut gaps) {
                                history_errors += 1;
                            }
                        }
                        SpoolBody::ShellEnv { env } => {
                            for (var, harness) in SHELL_ENV_VARS {
                                if let Some(value) = env.get(var) {
                                    config_locations.push((harness.to_string(), value.clone()));
                                }
                            }
                        }
                    }
                    if !try_delete(&path) {
                        self.applied.insert(path);
                    }
                }
                Ok(rec) => {
                    if rec.v > SPOOL_VERSION {
                        self.health.hook_newer_than_daemon = true;
                    }
                    self.record_bad_file(
                        spool,
                        &path,
                        name,
                        history,
                        now_ms,
                        &mut gaps,
                        &mut history_errors,
                    );
                }
                Err(_) => {
                    if peek_spool_version(&bytes).is_some_and(|v| v > SPOOL_VERSION) {
                        self.health.hook_newer_than_daemon = true;
                    }
                    self.record_bad_file(
                        spool,
                        &path,
                        name,
                        history,
                        now_ms,
                        &mut gaps,
                        &mut history_errors,
                    );
                }
            }
        }
        self.health.spool_pending = json_files(spool).len() as u64;
        IngestOutput {
            changes,
            gaps,
            history_errors,
            config_locations,
        }
    }

    /// Writes the `bad_file` gap line, then quarantines the file.
    #[allow(clippy::too_many_arguments)]
    fn record_bad_file(
        &mut self,
        spool: &Path,
        path: &Path,
        name: String,
        history: &mut History,
        now_ms: u64,
        gaps: &mut Vec<Gap>,
        history_errors: &mut u64,
    ) {
        let ms = spool_name_ms(&name).unwrap_or(now_ms);
        let gap = Gap {
            from_ms: ms,
            to_ms: ms,
            count: 1,
            reason: GapReason::BadFile,
        };
        gaps.push(gap);
        let line = gap_line(gap, Some(name));
        if !append_line(history, &line, now_ms, gaps) {
            *history_errors += 1;
        }
        self.move_to_bad(spool, path);
    }

    fn move_to_bad(&mut self, spool: &Path, path: &Path) {
        let bad = spool.join("bad");
        if fs::create_dir_all(&bad).is_err() {
            return;
        }
        let Some(name) = path.file_name() else {
            return;
        };
        let dest = bad.join(name);
        let _ = fs::remove_file(&dest);
        if fs::rename(path, &dest).is_err() {
            return;
        }
        self.health.bad_files += 1;
        let files = json_files(&bad);
        if files.len() > BAD_CAP {
            for victim in files.iter().take(files.len() - BAD_CAP) {
                let _ = fs::remove_file(victim);
            }
        }
    }
}

/// Appends one history line; a failure is counted and never stops ingest.
/// Returns the `history_full` gap, if any, through `gaps`.
fn append_line(
    history: &mut History,
    line: &HistoryLine,
    now_ms: u64,
    gaps: &mut Vec<Gap>,
) -> bool {
    match history.append(line, now_ms) {
        Ok(Some(gap)) => {
            gaps.push(gap);
            true
        }
        Ok(None) => true,
        Err(_) => false,
    }
}

fn gap_line(gap: Gap, src: Option<String>) -> HistoryLine {
    HistoryLine {
        v: HISTORY_VERSION,
        body: HistoryBody::Gap(gap),
        src,
    }
}

/// Top-level `*.json` files, oldest first by file name. Never includes `bad/`.
fn json_files(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        if !entry.file_type().is_ok_and(|t| t.is_file()) {
            continue;
        }
        if entry.path().extension() != Some(OsStr::new("json")) {
            continue;
        }
        out.push(entry.path());
    }
    out.sort_by(|a, b| a.file_name().cmp(&b.file_name()));
    out
}

/// True once the file is gone.
fn try_delete(path: &Path) -> bool {
    match fs::remove_file(path) {
        Ok(()) => true,
        Err(e) if e.kind() == io::ErrorKind::NotFound => true,
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use rocky_proto::pipe::RepoInfo;

    use super::Ingestor;
    use crate::history::{HISTORY_CAP_BYTES, History};
    use crate::state::StatusState;

    #[test]
    fn ingest_collects_config_locations_and_deletes_shell_env() {
        let spool = tempfile::tempdir().unwrap();
        let history_dir = tempfile::tempdir().unwrap();
        let mut history = History::open(history_dir.path(), HISTORY_CAP_BYTES, true);
        let mut state = StatusState::new();
        let mut ingestor = Ingestor::new();
        let shell_env = r#"{"v":1,"harness":"shell","recv_ms":1,"kind":"shell_env","env":{"CLAUDE_CONFIG_DIR":"/h/claude","SOME_OTHER":"x"}}"#;
        let event = r#"{"v":1,"harness":"claude-code","recv_ms":2,"config_dir":"/h/other","kind":"event","event":{"hook_event_name":"SessionStart","session_id":"S1"}}"#;
        fs::write(spool.path().join("0000000000001-1.json"), shell_env).unwrap();
        fs::write(spool.path().join("0000000000002-1.json"), event).unwrap();

        let out = ingestor.ingest_once(
            spool.path(),
            &mut state,
            &mut |_: &str| RepoInfo {
                root: None,
                main_root: None,
                name: "repo".into(),
                branch: None,
            },
            &mut history,
            1_700_000_000_000,
        );

        assert_eq!(
            out.config_locations,
            vec![
                ("claude-code".to_string(), "/h/claude".to_string()),
                ("claude-code".to_string(), "/h/other".to_string()),
            ]
        );
        assert!(!spool.path().join("0000000000001-1.json").exists());
        assert_eq!(out.changes.upserted.len(), 1);
        assert_eq!(out.changes.upserted[0].session_id, "S1");
        assert!(out.gaps.is_empty());
        assert_eq!(out.history_errors, 0);
    }

    #[test]
    fn prompt_never_reaches_history_or_status() {
        let spool = tempfile::tempdir().unwrap();
        let history_dir = tempfile::tempdir().unwrap();
        let mut history = History::open(history_dir.path(), HISTORY_CAP_BYTES, true);
        let mut state = StatusState::new();
        let mut ingestor = Ingestor::new();
        let record = r#"{"v":1,"harness":"claude-code","recv_ms":1,"kind":"event","event":{"hook_event_name":"UserPromptSubmit","session_id":"S1","prompt":"SECRET_PROMPT_TEXT"}}"#;
        fs::write(spool.path().join("0000000000001-1.json"), record).unwrap();

        let out = ingestor.ingest_once(
            spool.path(),
            &mut state,
            &mut |_: &str| RepoInfo {
                root: None,
                main_root: None,
                name: "repo".into(),
                branch: None,
            },
            &mut history,
            1_700_000_000_000,
        );

        assert_eq!(out.history_errors, 0);
        assert!(!spool.path().join("0000000000001-1.json").exists());

        let mut history_bytes = Vec::new();
        for entry in fs::read_dir(history_dir.path()).unwrap().flatten() {
            history_bytes.extend(fs::read(entry.path()).unwrap());
        }
        assert!(!history_bytes.is_empty());
        let history_text = String::from_utf8_lossy(&history_bytes);
        assert!(history_text.contains(r#""kind":"event""#), "{history_text}");
        assert!(
            !history_text.contains("SECRET_PROMPT_TEXT"),
            "prompt text leaked into history: {history_text}"
        );
        assert!(
            !history_text.contains(r#""prompt""#),
            "prompt key leaked into history: {history_text}"
        );

        let agents = state.agents();
        assert_eq!(agents.len(), 1);
        let agents_json = serde_json::to_string(&agents).unwrap();
        assert!(!agents_json.contains("SECRET_PROMPT_TEXT"), "{agents_json}");
        assert!(!agents_json.contains(r#""prompt""#), "{agents_json}");

        let timeline = state.timeline(&agents[0].key);
        assert!(!timeline.is_empty());
        let timeline_json = serde_json::to_string(&timeline).unwrap();
        assert!(
            !timeline_json.contains("SECRET_PROMPT_TEXT"),
            "{timeline_json}"
        );
        assert!(!timeline_json.contains(r#""prompt""#), "{timeline_json}");
    }

    #[test]
    fn old_spool_record_without_prompt_ingests() {
        let spool = tempfile::tempdir().unwrap();
        let history_dir = tempfile::tempdir().unwrap();
        let mut history = History::open(history_dir.path(), HISTORY_CAP_BYTES, true);
        let mut state = StatusState::new();
        let mut ingestor = Ingestor::new();
        let record = r#"{"v":1,"harness":"claude-code","recv_ms":49492,"kind":"event","event":{"hook_event_name":"UserPromptSubmit","session_id":"S1","cwd":"C:\\scratch-capture","transcript_path":"<CLAUDE_CONFIG>\\projects\\C--scratch-capture\\S1.jsonl"}}"#;
        let path = spool.path().join("0000000049492-1.json");
        fs::write(&path, record).unwrap();

        let out = ingestor.ingest_once(
            spool.path(),
            &mut state,
            &mut |_: &str| RepoInfo {
                root: None,
                main_root: None,
                name: "repo".into(),
                branch: None,
            },
            &mut history,
            1_700_000_000_000,
        );

        assert!(!path.exists());
        assert_eq!(out.changes.upserted.len(), 1);
        assert_eq!(out.changes.upserted[0].session_id, "S1");
        assert!(out.gaps.is_empty());
        assert_eq!(out.history_errors, 0);
        assert_eq!(ingestor.health.bad_files, 0);
        assert_eq!(state.agents().len(), 1);
    }
}
