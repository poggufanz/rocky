//! Rotating file log: `rockyd.log` plus one `.1` backup, counts/errors/lifecycle only.

use std::fs::{self, OpenOptions};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const ROTATE_AT: u64 = 1024 * 1024;

/// Append-only log with rotation: once the file reaches 1 MiB, the next line
/// moves it to `<name>.1` (replacing any previous backup) and starts fresh.
/// Only two files are ever kept. All failures are silent: logging must never
/// crash or block the daemon.
pub struct RotatingLog {
    path: PathBuf,
    // The panic hook also writes through here; a poisoned mutex still logs.
    // `None` when the file could not be opened: lines are dropped and the
    // open is retried on the next `line()`, so an unwritable log never
    // panics the daemon.
    file: Mutex<Option<fs::File>>,
}

fn open_append(path: &Path) -> Option<fs::File> {
    OpenOptions::new().create(true).append(true).open(path).ok()
}

impl RotatingLog {
    pub fn new(path: &Path) -> Self {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let file = open_append(path);
        RotatingLog {
            path: path.to_path_buf(),
            file: Mutex::new(file),
        }
    }

    pub fn line(&self, msg: &str) {
        if self
            .file
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_mut()
            .is_some_and(|f| f.metadata().is_ok_and(|m| m.len() >= ROTATE_AT))
        {
            self.rotate();
        }
        let mut guard = self.file.lock().unwrap_or_else(|e| e.into_inner());
        if guard.is_none() {
            *guard = open_append(&self.path);
        }
        if let Some(file) = guard.as_mut() {
            let _ = writeln!(file, "{msg}");
            let _ = file.flush();
        }
    }

    fn rotate(&self) {
        let backup = self.path.with_extension("log.1");
        let _ = fs::remove_file(&backup);
        let _ = fs::rename(&self.path, &backup);
        *self.file.lock().unwrap_or_else(|e| e.into_inner()) = open_append(&self.path);
    }
}

/// Returns true iff `name` matches a card-engine worker thread (`rocky-card-worker-<digits>`).
pub fn is_card_worker_thread_name(name: Option<&str>) -> bool {
    name.and_then(|n| n.strip_prefix(crate::cards::CARD_WORKER_THREAD_PREFIX))
        .is_some_and(|rest| !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit()))
}

/// Installs the daemon process panic hook: contains card worker panics and aborts all others.
pub fn install_panic_hook(log: Arc<RotatingLog>) {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let current = std::thread::current();
        if is_card_worker_thread_name(current.name()) {
            log.line("cards: 1 worker panic");
            return;
        }
        default_hook(info);
        let at = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "unknown location".into());
        log.line(&format!("panic, aborting: {at}"));
        std::process::abort();
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotates_at_one_mib_keeping_two_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rockyd.log");
        let log = RotatingLog::new(&path);
        log.line(&"x".repeat(1024 * 1024));
        log.line("after rotation");
        let backup = path.with_extension("log.1");
        assert!(backup.exists(), "rotation backup missing");
        let backup_text = fs::read_to_string(&backup).unwrap();
        assert!(backup_text.len() >= 1024 * 1024, "backup too small");
        assert_eq!(fs::read_to_string(&path).unwrap(), "after rotation\n");
        // Second rotation replaces the backup instead of adding a third file.
        log.line(&"y".repeat(1024 * 1024));
        log.line("third");
        assert!(fs::read_to_string(&backup).unwrap().contains('y'));
        assert_eq!(fs::read_to_string(&path).unwrap(), "third\n");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 2);
    }

    #[test]
    fn appends_and_creates_parent_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sub").join("rockyd.log");
        let log = RotatingLog::new(&path);
        log.line("one");
        log.line("two");
        assert_eq!(fs::read_to_string(&path).unwrap(), "one\ntwo\n");
    }
    #[test]
    fn unwritable_path_never_panics_and_recovers() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rockyd.log");
        // Block the log path with a directory: open fails, lines drop silently.
        fs::create_dir(&path).unwrap();
        let log = RotatingLog::new(&path);
        log.line("dropped");
        // Once the path clears, the next line reopens and writes.
        fs::remove_dir(&path).unwrap();
        log.line("recovered");
        assert_eq!(fs::read_to_string(&path).unwrap(), "recovered\n");
    }

    #[test]
    fn worker_thread_name_matcher_only_matches_card_workers() {
        assert!(is_card_worker_thread_name(Some("rocky-card-worker-0")));
        assert!(is_card_worker_thread_name(Some("rocky-card-worker-12")));
        assert!(!is_card_worker_thread_name(None));
        assert!(!is_card_worker_thread_name(Some("")));
        assert!(!is_card_worker_thread_name(Some("rocky-card-worker-")));
        assert!(!is_card_worker_thread_name(Some("rocky-card-worker-a")));
        assert!(!is_card_worker_thread_name(Some("rockyd-cards-0")));
        assert!(!is_card_worker_thread_name(Some("main")));
    }
}
