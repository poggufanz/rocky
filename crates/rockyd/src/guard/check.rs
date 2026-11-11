//! Pure checks over the setup records: which guarded files lost a snippet,
//! which directories to watch, and when a burst of change events may run one
//! check. File bytes arrive through an injected reader; nothing here writes one.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use rocky_proto::paths::{bin_dir, setup_dir};

use super::records::{Expected, ExpectedFile};

/// Expected files that `read` cannot return, or whose bytes lack at least one
/// snippet, in `expected` order. `read` is injected so tests can supply bytes.
pub fn missing_paths(
    expected: &Expected,
    read: &mut dyn FnMut(&Path) -> Option<Vec<u8>>,
) -> Vec<PathBuf> {
    expected
        .files
        .iter()
        .filter(|file| is_missing(file, read))
        .map(|file| file.path.clone())
        .collect()
}

fn is_missing(file: &ExpectedFile, read: &mut dyn FnMut(&Path) -> Option<Vec<u8>>) -> bool {
    match read(&file.path) {
        None => true,
        Some(bytes) => file
            .snippets
            .iter()
            .any(|snippet| !contains(&bytes, snippet.as_bytes())),
    }
}

// ponytail: naive byte search; guarded files are a few KiB.
fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    needle.is_empty()
        || haystack
            .windows(needle.len())
            .any(|window| window == needle)
}

/// Directories whose changes can break a guarded file: the parent of every
/// expected file, plus the setup and bin directories. Only existing
/// directories are kept.
pub fn watch_dirs(expected: &Expected, home: &Path) -> BTreeSet<PathBuf> {
    expected
        .files
        .iter()
        .filter_map(|file| file.path.parent().map(Path::to_path_buf))
        .chain([setup_dir(home), bin_dir(home)])
        .filter(|dir| dir.is_dir())
        .collect()
}

/// Turns a burst of change events into one due check. The first poke after a
/// quiet period sets the due time; later pokes leave it alone until it is taken.
#[derive(Debug)]
pub struct Debounce {
    window_ms: u64,
    due: Option<u64>,
}

impl Debounce {
    pub fn new(window_ms: u64) -> Self {
        Self {
            window_ms,
            due: None,
        }
    }

    pub fn poke(&mut self, now_ms: u64) {
        if self.due.is_none() {
            self.due = Some(now_ms.saturating_add(self.window_ms));
        }
    }

    /// True once when the due time has passed, then clears it.
    pub fn take_due(&mut self, now_ms: u64) -> bool {
        match self.due {
            Some(due) if now_ms >= due => {
                self.due = None;
                true
            }
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::fs;

    use rocky_proto::paths::bin_dir;
    use tempfile::TempDir;

    use super::*;

    #[test]
    fn missing_paths_checks_every_snippet() {
        let expected = Expected {
            files: vec![
                ExpectedFile {
                    path: PathBuf::from("/unreadable"),
                    snippets: vec!["alpha".to_string()],
                },
                ExpectedFile {
                    path: PathBuf::from("/only-a"),
                    snippets: vec!["alpha".to_string(), "beta".to_string()],
                },
                ExpectedFile {
                    path: PathBuf::from("/both"),
                    snippets: vec!["alpha".to_string(), "beta".to_string()],
                },
            ],
        };
        let contents: HashMap<PathBuf, Vec<u8>> = HashMap::from([
            (PathBuf::from("/only-a"), b"alpha only".to_vec()),
            (PathBuf::from("/both"), b"alpha and beta".to_vec()),
        ]);
        let mut read = |path: &Path| contents.get(path).cloned();

        assert_eq!(
            missing_paths(&expected, &mut read),
            vec![PathBuf::from("/unreadable"), PathBuf::from("/only-a")]
        );
    }

    #[test]
    fn watch_dirs_are_existing_parents_plus_setup_and_bin() {
        let home = TempDir::new().unwrap();
        let config = home.path().join("config");
        fs::create_dir_all(&config).unwrap();
        fs::create_dir_all(bin_dir(home.path())).unwrap();
        let expected = Expected {
            files: vec![
                ExpectedFile {
                    path: config.join("settings.json"),
                    snippets: Vec::new(),
                },
                ExpectedFile {
                    path: config.join("rules.toml"),
                    snippets: Vec::new(),
                },
                ExpectedFile {
                    path: home.path().join("absent").join("rules.md"),
                    snippets: Vec::new(),
                },
            ],
        };

        assert_eq!(
            watch_dirs(&expected, home.path()),
            BTreeSet::from([config, bin_dir(home.path())])
        );
    }

    #[test]
    fn debounce_storm_runs_one_check_per_window() {
        let mut debounce = Debounce::new(1000);
        for now in (0..1000).step_by(10) {
            debounce.poke(now);
        }
        assert!(!debounce.take_due(999));
        assert!(debounce.take_due(1000));
        assert!(!debounce.take_due(1000));

        debounce.poke(1500);
        assert!(!debounce.take_due(2499));
        assert!(debounce.take_due(2500));
        assert!(!debounce.take_due(2500));
    }
}
