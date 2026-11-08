//! Append-once error log for the desk.

use std::fmt::Display;
use std::io::Write;
use std::path::PathBuf;

/// Appends one line per error kind per process. A failed write is not
/// remembered, so a later occurrence can still record.
pub struct LogOnce {
    path: PathBuf,
    seen: Vec<&'static str>,
}

impl LogOnce {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            seen: Vec::new(),
        }
    }

    /// Append `"{kind}: {err}\n"` the first time `kind` is seen.
    /// Returns whether it wrote.
    pub fn once(&mut self, kind: &'static str, err: &dyn Display) -> bool {
        if self.seen.contains(&kind) {
            return false;
        }
        let wrote = self.append(kind, err);
        if wrote {
            self.seen.push(kind);
        }
        wrote
    }

    /// Best effort: the desk has nowhere better to report a log failure.
    fn append(&self, kind: &str, err: &dyn Display) -> bool {
        let result: std::io::Result<()> = (|| {
            if let Some(dir) = self.path.parent().filter(|d| !d.as_os_str().is_empty()) {
                std::fs::create_dir_all(dir)?;
            }
            let mut file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&self.path)?;
            writeln!(file, "{kind}: {err}")
        })();
        result.is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn logs_each_kind_once() {
        let dir = TempDir::new().unwrap();
        let mut log = LogOnce::new(dir.path().join("rocky-desk.log"));
        assert!(log.once("set_icon", &"e1"));
        assert!(!log.once("set_icon", &"e2"));
        assert!(log.once("set_tooltip", &"e3"));
        let text = std::fs::read_to_string(dir.path().join("rocky-desk.log")).unwrap();
        assert_eq!(text, "set_icon: e1\nset_tooltip: e3\n");
    }
}
