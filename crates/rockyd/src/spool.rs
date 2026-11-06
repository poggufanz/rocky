//! Spool ingest: apply spool records to the status machine, then delete.
//!
//! `rockyd` is the only process that deletes or moves spool files.

use std::collections::HashSet;
use std::ffi::OsStr;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use rocky_proto::pipe::{Health, RepoInfo};
use rocky_proto::spool::{SPOOL_VERSION, SpoolBody, SpoolRecord, peek_spool_version};

use crate::state::{ApplyOutcome, Changes, StatusState};

pub const MAX_FILES: usize = 10_000;
pub const MAX_BYTES: u64 = 50 * 1024 * 1024;
pub const BAD_CAP: usize = 100;

/// Delete oldest top-level `*.json` files until count and total bytes fit the limits.
/// Returns the number of files deleted. Does not touch [`Health`].
pub fn prune(spool: &Path, max_files: usize, max_bytes: u64) -> io::Result<u64> {
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
    for (path, size) in &files {
        if count <= max_files && bytes <= max_bytes {
            break;
        }
        match fs::remove_file(path) {
            Ok(()) => {
                count -= 1;
                bytes = bytes.saturating_sub(*size);
                deleted += 1;
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                count -= 1;
                bytes = bytes.saturating_sub(*size);
            }
            Err(_) => {}
        }
    }
    Ok(deleted)
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

    /// Scan `spool` once: apply every top-level `*.json` in file-name order, delete
    /// what was applied, quarantine the rest to `bad/`. Returns merged [`Changes`].
    pub fn ingest_once(
        &mut self,
        spool: &Path,
        state: &mut StatusState,
        repo_of: &mut dyn FnMut(&str) -> RepoInfo,
    ) -> Changes {
        let mut upserted = Vec::new();
        let mut seen = HashSet::new();
        for path in json_files(spool) {
            if self.applied.contains(&path) {
                // Applied earlier; only re-try the delete, never re-apply.
                if try_delete(&path) {
                    self.applied.remove(&path);
                }
                continue;
            }
            let Ok(bytes) = fs::read(&path) else {
                // Transient (vanished mid-scan or locked): leave it for the next scan.
                continue;
            };
            match serde_json::from_slice::<SpoolRecord>(&bytes) {
                Ok(rec) if rec.v == SPOOL_VERSION => {
                    match rec.body {
                        SpoolBody::Event { event } => {
                            if let ApplyOutcome::Changed(c) =
                                state.apply(&event, rec.recv_ms, repo_of)
                            {
                                for key in c.upserted {
                                    if seen.insert(key.clone()) {
                                        upserted.push(key);
                                    }
                                }
                            } else {
                                self.health.late_events += 1;
                            }
                        }
                        SpoolBody::Dropped { .. } => {
                            self.health.dropped_events += 1;
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
                    self.move_to_bad(spool, &path);
                }
                Err(_) => {
                    if peek_spool_version(&bytes).is_some_and(|v| v > SPOOL_VERSION) {
                        self.health.hook_newer_than_daemon = true;
                    }
                    self.move_to_bad(spool, &path);
                }
            }
        }
        self.health.spool_pending = json_files(spool).len() as u64;
        Changes {
            upserted,
            removed: Vec::new(),
        }
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
