//! The capture supervisor inside the daemon loop. It reads the consent store and the CLI record,
//! keeps the one Node capture child running while a repo is consented, watches the repos that
//! child owns, and asks it to reconcile a repo when a file in it changes. [`Capture`] decides what
//! to do; this module does the file, process, and watcher work.
//!
//! Log lines carry event names and counts only, never a root path, Node output, or watcher error
//! text.

use std::collections::BTreeSet;
use std::ffi::OsStr;
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::thread;
use std::time::{Duration, Instant};

use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
use rocky_proto::paths::{canonical_path, listening_dir, repo_consents_path};
use rocky_proto::pipe::{CaptureHealth, ServerMsg};
use rockyd::capture::child::{CHILD_STOP_GRACE, CaptureChild};
use rockyd::capture::{Action, Capture, CaptureConsts, CaptureLine, CaptureResult, RESTARTS};
use rockyd::guard::records::{CliRecord, cli_status, read_cli};
use rockyd::log::RotatingLog;
use rockyd::server::Hub;
use serde_json::Value;

use crate::guard_loop::is_change;
use crate::{Shared, now_ms};

/// The consent store file the daemon reads, and the only one it watches for.
const CONSENTS_FILE: &str = "repo-consents.json";

/// A file or folder with this name is git's own bookkeeping. Changes under it never wake capture.
const GIT_DIR: &str = ".git";

/// How long a child that cannot be written to, or that closed its output, gets to show its exit
/// code before it is killed. It bounds how long one pass can wait on a stuck child.
const EXIT_CODE_GRACE: Duration = Duration::from_millis(250);

/// How often a child that is being reaped is checked for an exit.
const EXIT_POLL: Duration = Duration::from_millis(10);

/// What the log says when an exit has no numeric code.
const NO_CODE: &str = "none";

/// The capture child and the watchers around it, as the daemon loop drives them. The loop owns
/// it. Watcher callbacks run on notify's threads and only post to channels.
pub(crate) struct CaptureLoop {
    home: PathBuf,
    capture: Capture,
    /// The CLI record from the last `check`. `None` until a valid one is read.
    cli: Option<CliRecord>,
    child: Option<CaptureChild>,
    /// The allowed session roots the last `check` saw.
    last_allowed: BTreeSet<String>,
    /// Watches the Listening directory. `None` when the platform has none; the 60 s check still
    /// covers the consent store then.
    consent_watcher: Option<RecommendedWatcher>,
    /// Whether the Listening directory is watched now. The directory may not exist yet, so the
    /// watch is retried on every check.
    consent_watched: bool,
    /// One ping per change event that names the consent store.
    consent_pings: Receiver<()>,
    /// Watches the repos the child owns. `None` when the platform has none.
    repo_watcher: Option<RecommendedWatcher>,
    /// The paths of each change event in a watched repo. An empty list is an event that names no
    /// path, so any watched repo may have changed.
    repo_events: Receiver<Vec<PathBuf>>,
    /// Roots the repo watcher covers now.
    watched: BTreeSet<String>,
    /// Roots whose watch failed. Cleared when the child lists its roots again, as the core
    /// clears its own watch failures, so each root is tried once per list.
    failed_watches: BTreeSet<String>,
    /// Whether the last pass was in a refused-restart episode. Each episode is logged once.
    refusal_logged: bool,
    /// The health last handed to the daemon, so an unchanged one takes no lock.
    published: Vec<CaptureHealth>,
}

impl CaptureLoop {
    /// A supervisor for the Rocky home at `home`. Nothing starts until `check` finds a consented
    /// repo.
    pub(crate) fn new(home: PathBuf, log: &RotatingLog) -> Self {
        let (consent_tx, consent_pings) = mpsc::channel();
        let consent_watcher =
            notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
                let relevant = match &res {
                    Ok(event) => is_change(&event.kind) && names_consents(&event.paths),
                    // A watcher fault still checks the store.
                    Err(_) => true,
                };
                if relevant {
                    let _ = consent_tx.send(());
                }
            })
            .ok();
        let (repo_tx, repo_events) = mpsc::channel();
        // Symlinks are not followed, so a link inside a repo never pulls in a folder outside it.
        let repo_watcher = RecommendedWatcher::new(
            move |res: Result<notify::Event, notify::Error>| {
                let paths = match res {
                    // Opens, reads, and closes include the capture's own reads of the repo.
                    // Counting them would wake capture forever.
                    Ok(event) if !is_change(&event.kind) => return,
                    Ok(event) => event.paths,
                    // A fault may have lost events, so the repos it names are checked.
                    Err(error) => error.paths,
                };
                let _ = repo_tx.send(paths);
            },
            Config::default().with_follow_symlinks(false),
        )
        .ok();
        if consent_watcher.is_none() || repo_watcher.is_none() {
            log.line("capture watcher unavailable, polling only");
        }
        Self {
            home,
            capture: Capture::new(CaptureConsts::default()),
            cli: None,
            child: None,
            last_allowed: BTreeSet::new(),
            consent_watcher,
            consent_watched: false,
            consent_pings,
            repo_watcher,
            repo_events,
            watched: BTreeSet::new(),
            failed_watches: BTreeSet::new(),
            refusal_logged: false,
            published: Vec::new(),
        }
    }

    /// Reads the CLI record and the consent store and gives the core its inputs. `allowed` is the
    /// session roots the guard has seen allowed. Runs at startup, on every tick, when a consent
    /// change is seen, and when `allowed` moves. Reads two small files and starts nothing.
    pub(crate) fn check(&mut self, allowed: &BTreeSet<String>) {
        self.ensure_consent_watch();
        let cli = read_cli(&self.home);
        let (cli_found, _) = cli_status(cli.as_ref());
        let consented = consented_roots(&repo_consents_path(&self.home));
        let extra = extra_roots(allowed, &consented);
        self.capture.set_inputs(consented, extra, cli_found);
        self.cli = cli;
        self.last_allowed = allowed.clone();
    }

    /// The capture work for one pass of the daemon loop: a check when the consent store or the
    /// allowed roots moved, the child's lines and exit, file changes, the core's next actions,
    /// the repo watches, and the health.
    pub(crate) fn service(
        &mut self,
        allowed: &BTreeSet<String>,
        shared: &Mutex<Shared>,
        hub: &Hub,
        log: &RotatingLog,
    ) -> Vec<CaptureResult> {
        let pinged = self.consent_pings.try_iter().count() > 0;
        if pinged || *allowed != self.last_allowed {
            self.check(allowed);
        }
        let results = self.drain_child(log);
        self.wake_changed_roots();
        self.run_actions(log);
        self.sync_watches(log);
        let health = self.capture.health();
        self.note_restart_refusal(&health, log);
        self.publish(health, shared, hub);
        results
    }

    /// Returns the repository roots currently owned by this capture child.
    pub(crate) fn owned_roots(&self) -> BTreeSet<String> {
        self.capture.watch_roots()
    }

    /// Triggers a capture reconcile flush when `root` matches an owned capture root.
    pub(crate) fn flush(&mut self, root: &str, now_ms: u64) {
        let target = canonical_path(root, cfg!(windows));
        if let Some(owned) = self
            .capture
            .watch_roots()
            .into_iter()
            .find(|r| canonical_path(r, cfg!(windows)) == target)
        {
            self.capture.flush(&owned, now_ms);
        }
    }

    /// Stops the child before the daemon exits: closes its input, waits for it, and kills it only
    /// at the grace limit.
    pub(crate) fn shutdown(&mut self, log: &RotatingLog) {
        if self.child.is_some() {
            self.stop_child(log);
        }
    }

    /// Watches the Listening directory once it exists. A failed watch is not an error: the tick
    /// check still covers the consent store.
    fn ensure_consent_watch(&mut self) {
        if self.consent_watched {
            return;
        }
        if let Some(watcher) = self.consent_watcher.as_mut() {
            let dir = listening_dir(&self.home);
            self.consent_watched = watcher.watch(&dir, RecursiveMode::NonRecursive).is_ok();
        }
    }

    /// Hands the core every line the child wrote, then reaps the child when it has exited or
    /// closed its output.
    fn drain_child(&mut self, log: &RotatingLog) -> Vec<CaptureResult> {
        let Some(child) = self.child.as_mut() else {
            return Vec::new();
        };
        let mut results = Vec::new();
        let mut output_closed = false;
        loop {
            match child.lines().try_recv() {
                Ok(line) => {
                    // The core clears its watch failures on a roots line, so the failed roots
                    // are tried again.
                    if matches!(line, CaptureLine::Roots(_)) {
                        self.failed_watches.clear();
                    }
                    if let Some(result) = self.capture.line(line) {
                        results.push(result);
                    }
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    output_closed = true;
                    break;
                }
            }
        }
        if output_closed || child.try_exit().is_some() {
            self.lose_child(log);
        }
        results
    }

    /// Tells the core which owned roots had file events since the last pass.
    fn wake_changed_roots(&mut self) {
        let batches: Vec<Vec<PathBuf>> = self.repo_events.try_iter().collect();
        if batches.is_empty() {
            return;
        }
        let roots = self.capture.watch_roots();
        let now = now_ms();
        for paths in &batches {
            if paths.is_empty() {
                for root in &roots {
                    self.capture.fs_event(root, now);
                }
                continue;
            }
            for path in paths {
                // Rocky's own files can sit inside a watched repo. Counting them would wake
                // capture on every lease, store, and log write.
                if under_home(path, &self.home) {
                    continue;
                }
                if let Some(root) = root_of(path, &roots) {
                    self.capture.fs_event(root, now);
                }
            }
        }
    }

    /// Runs every action the core has ready. Each `Spawn` is reported before the core is asked
    /// again, because every `Spawn` counts against its respawn limit.
    fn run_actions(&mut self, log: &RotatingLog) {
        while let Some(action) = self.capture.next_action(now_ms()) {
            match action {
                Action::Spawn => self.start_child(log),
                Action::Stop => self.stop_child(log),
                Action::Send(root) => self.send_root(&root, log),
            }
        }
    }

    fn start_child(&mut self, log: &RotatingLog) {
        let spawned = match &self.cli {
            Some(cli) => CaptureChild::spawn(cli, &self.home),
            // The core asks for a spawn only after `check` found a CLI.
            None => Err(io::Error::other("no CLI record")),
        };
        match spawned {
            Ok(child) => {
                self.child = Some(child);
                self.capture.child_started();
                log.line("capture started");
            }
            Err(_) => {
                self.capture.spawn_failed();
                log.line("capture spawn failed");
            }
        }
    }

    /// Asks the child to reconcile `root`. A failed send means the child is stalled or gone, so
    /// it is reaped now and the core decides whether to start another.
    fn send_root(&mut self, root: &str, log: &RotatingLog) {
        let sent = self
            .child
            .as_mut()
            .is_some_and(|child| child.send(root).is_ok());
        if !sent {
            self.lose_child(log);
        }
    }

    /// Stops the child the polite way: input closed, then up to the grace to leave.
    fn stop_child(&mut self, log: &RotatingLog) {
        if let Some(child) = self.child.take() {
            child.stop(CHILD_STOP_GRACE);
        }
        self.capture.child_exited();
        log_exit(log, None);
    }

    /// Takes in a child that exited, closed its output, or stopped reading. Its exit code is
    /// logged when it shows one within the short grace; it is killed otherwise.
    fn lose_child(&mut self, log: &RotatingLog) {
        let code = self.child.take().and_then(reap);
        self.capture.child_exited();
        log_exit(log, code);
    }

    /// Points the repo watcher at the roots the child owns: unwatches roots that dropped out and
    /// watches new ones. A failed watch is reported to the core, which then shows the repo as
    /// polling, and is counted once in the log.
    fn sync_watches(&mut self, log: &RotatingLog) {
        let desired = self.capture.watch_roots();
        let gone: Vec<String> = self.watched.difference(&desired).cloned().collect();
        for root in gone {
            if let Some(watcher) = self.repo_watcher.as_mut() {
                // Unwatching a removed folder fails, but the watch is gone either way.
                let _ = watcher.unwatch(Path::new(&root));
            }
            self.watched.remove(&root);
        }
        self.failed_watches.retain(|root| desired.contains(root));
        let mut failed = 0usize;
        for root in &desired {
            if self.watched.contains(root) || self.failed_watches.contains(root) {
                continue;
            }
            if try_watch(self.repo_watcher.as_mut(), root) {
                self.watched.insert(root.clone());
            } else {
                // A refused recursive watch can leave the folders it already reached watched.
                // Drop them so a polling repo does not hold the user's watch budget.
                if let Some(watcher) = self.repo_watcher.as_mut() {
                    let _ = watcher.unwatch(Path::new(root));
                }
                self.failed_watches.insert(root.clone());
                self.capture.watch_failed(root);
                failed += 1;
            }
        }
        if failed > 0 {
            log.line(&format!("capture watch failed ({failed} roots)"));
        }
    }

    /// Logs the start of a refused-restart episode once. The health already shows the limit for
    /// as long as it holds.
    fn note_restart_refusal(&mut self, health: &[CaptureHealth], log: &RotatingLog) {
        let refused = health
            .iter()
            .any(|row| row.error.as_deref() == Some(RESTARTS));
        if refused && !self.refusal_logged {
            log.line("capture start refused (restarts)");
        }
        self.refusal_logged = refused;
    }

    /// Stores the capture health for the daemon's broadcast health, and broadcasts it when it
    /// moved.
    fn publish(&mut self, health: Vec<CaptureHealth>, shared: &Mutex<Shared>, hub: &Hub) {
        if health == self.published {
            return;
        }
        self.published = health.clone();
        let (health, changed) = {
            let mut s = shared.lock().unwrap();
            s.capture = health;
            s.take_health()
        };
        if changed {
            hub.broadcast(&ServerMsg::Health { health });
        }
    }
}

/// Logs one capture exit. The code is the number alone, or a fixed token when there is none.
fn log_exit(log: &RotatingLog, code: Option<i32>) {
    let code = code.map_or_else(|| NO_CODE.to_string(), |code| code.to_string());
    log.line(&format!("capture exited {code}"));
}

/// Waits briefly for the exit code of a child that is gone or stuck, then kills and reaps it.
fn reap(mut child: CaptureChild) -> Option<i32> {
    let deadline = Instant::now() + EXIT_CODE_GRACE;
    loop {
        if let Some(status) = child.try_exit() {
            return status.code();
        }
        if Instant::now() >= deadline {
            child.stop(Duration::ZERO);
            return None;
        }
        thread::sleep(EXIT_POLL);
    }
}

/// Watches `root` and everything under it. `false` when there is no watcher or it refuses.
/// The caller drops what a refused watch left behind.
fn try_watch(watcher: Option<&mut RecommendedWatcher>, root: &str) -> bool {
    watcher.is_some_and(|watcher| {
        watcher
            .watch(Path::new(root), RecursiveMode::Recursive)
            .is_ok()
    })
}

/// Whether a change event in the Listening directory can be about the consent store.
/// An event that names no path might be, so it counts.
fn names_consents(paths: &[PathBuf]) -> bool {
    paths.is_empty()
        || paths
            .iter()
            .any(|path| path.file_name() == Some(OsStr::new(CONSENTS_FILE)))
}

/// The roots the consent store grants: the keys whose value is `true`. A missing file, bad JSON,
/// or anything that is not an object reads as no roots, so capture fails closed.
fn consented_roots(path: &Path) -> BTreeSet<String> {
    let Some(Value::Object(entries)) = fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
    else {
        return BTreeSet::new();
    };
    entries
        .into_iter()
        .filter(|(root, value)| !root.is_empty() && *value == Value::Bool(true))
        .map(|(root, _)| root)
        .collect()
}

/// The root a changed file belongs to: the longest root that is a path prefix of `path`, compared
/// whole component by whole component. `None` when no root holds it, and when any component
/// between the root and the file is `.git`. Case is ignored on Windows and kept elsewhere.
fn root_of<'a>(path: &Path, roots: &'a BTreeSet<String>) -> Option<&'a str> {
    let parts = components_of(path);
    let (root, root_len) = roots
        .iter()
        .filter_map(|root| {
            let root_parts = components_of(Path::new(root));
            (!root_parts.is_empty() && parts.starts_with(&root_parts))
                .then_some((root.as_str(), root_parts.len()))
        })
        .max_by_key(|&(_, len)| len)?;
    let in_git = parts[root_len..].iter().any(|part| part == GIT_DIR);
    (!in_git).then_some(root)
}

/// Whether `path` is the Rocky home or inside it, compared like [`root_of`].
fn under_home(path: &Path, home: &Path) -> bool {
    let home_parts = components_of(home);
    !home_parts.is_empty() && components_of(path).starts_with(&home_parts)
}

/// A root spelled the way the Node consent store keys it, so the two can be compared: on Windows
/// backslashes become slashes, case folds, and a trailing slash goes (a drive root keeps its
/// slash). Elsewhere the root is unchanged.
fn canonical_root(root: &str) -> String {
    if !cfg!(windows) {
        return root.to_string();
    }
    let slashed = root.replace('\\', "/").to_lowercase();
    let trimmed = slashed.trim_end_matches('/');
    if trimmed.is_empty() || trimmed.ends_with(':') {
        return slashed;
    }
    trimmed.to_string()
}

/// The allowed session roots that no consent key already covers, in the consent keys' spelling.
fn extra_roots(allowed: &BTreeSet<String>, consented: &BTreeSet<String>) -> BTreeSet<String> {
    let known: BTreeSet<String> = consented.iter().map(|root| canonical_root(root)).collect();
    allowed
        .iter()
        .map(|root| canonical_root(root))
        .filter(|root| !known.contains(root))
        .collect()
}

/// The path split into components, folded to lower case on Windows.
fn components_of(path: &Path) -> Vec<String> {
    path.components()
        .map(|part: Component<'_>| {
            let text = part.as_os_str().to_string_lossy();
            if cfg!(windows) {
                text.to_lowercase()
            } else {
                text.into_owned()
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::fs;
    use std::path::Path;

    use notify::Watcher;

    use super::{canonical_root, consented_roots, extra_roots, root_of, try_watch, under_home};

    fn roots(items: &[&str]) -> BTreeSet<String> {
        items.iter().map(|item| (*item).to_string()).collect()
    }

    #[test]
    fn root_of_finds_the_root_by_whole_components() {
        let roots = roots(&["/work/repo"]);

        assert_eq!(
            root_of(Path::new("/work/repo/src/a.ts"), &roots),
            Some("/work/repo")
        );
        assert_eq!(root_of(Path::new("/work/repo"), &roots), Some("/work/repo"));
        assert_eq!(root_of(Path::new("/work/repository/a.ts"), &roots), None);
        assert_eq!(root_of(Path::new("/work/other/a.ts"), &roots), None);
    }

    #[test]
    fn root_of_ignores_git_dirs() {
        let roots = roots(&["/work/repo"]);

        assert_eq!(root_of(Path::new("/work/repo/.git/index"), &roots), None);
        assert_eq!(root_of(Path::new("/work/repo/.git"), &roots), None);
        assert_eq!(root_of(Path::new("/work/repo/sub/.git/HEAD"), &roots), None);
        assert_eq!(
            root_of(Path::new("/work/repo/.gitignore"), &roots),
            Some("/work/repo")
        );
    }

    #[test]
    fn root_of_prefers_the_longest_root() {
        let roots = roots(&["/work", "/work/repo"]);

        assert_eq!(
            root_of(Path::new("/work/repo/a.ts"), &roots),
            Some("/work/repo")
        );
        assert_eq!(root_of(Path::new("/work/x.ts"), &roots), Some("/work"));
    }

    #[test]
    fn root_of_case_follows_platform() {
        let roots = roots(&["/work/repo"]);

        let found = root_of(Path::new("/Work/REPO/a.ts"), &roots);

        assert_eq!(found.is_some(), cfg!(windows));
    }

    #[cfg(windows)]
    #[test]
    fn root_of_accepts_the_mixed_separators_a_slash_root_produces() {
        let roots = roots(&["C:/work/repo"]);

        let found = root_of(Path::new(r"C:/work/repo\src\a.ts"), &roots);

        assert_eq!(found, Some("C:/work/repo"));
    }

    #[test]
    fn under_home_matches_whole_components_only() {
        let home = Path::new("/work/repo/.rocky");

        assert!(under_home(
            Path::new("/work/repo/.rocky/listening/lease"),
            home
        ));
        assert!(under_home(Path::new("/work/repo/.rocky"), home));
        assert!(!under_home(Path::new("/work/repo/.rocky2/a"), home));
        assert!(!under_home(Path::new("/work/repo/src/a.ts"), home));
        assert!(!under_home(Path::new("/work/repo/a.ts"), Path::new("")));
    }

    #[test]
    fn extra_roots_drops_roots_a_consent_key_covers() {
        let consented = roots(&["/a/repo"]);
        let allowed = roots(&["/a/repo", "/b/wt"]);

        assert_eq!(extra_roots(&allowed, &consented), roots(&["/b/wt"]));
    }

    #[cfg(windows)]
    #[test]
    fn canonical_root_matches_the_consent_key_spelling() {
        assert_eq!(canonical_root(r"C:\Users\Me\Repo\"), "c:/users/me/repo");
        assert_eq!(canonical_root("C:/Users/Me/Repo"), "c:/users/me/repo");
        assert_eq!(canonical_root("C:/"), "c:/");
        let consented = roots(&["c:/users/me/repo"]);
        let allowed = roots(&["C:/Users/Me/Repo", "D:/other"]);
        assert_eq!(extra_roots(&allowed, &consented), roots(&["d:/other"]));
    }

    #[cfg(not(windows))]
    #[test]
    fn canonical_root_leaves_roots_alone_off_windows() {
        assert_eq!(canonical_root("/Work/Repo/"), "/Work/Repo/");
    }

    #[test]
    fn a_refused_watch_reports_false() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("gone");
        let mut watcher = notify::RecommendedWatcher::new(
            |_res: Result<notify::Event, notify::Error>| {},
            notify::Config::default().with_follow_symlinks(false),
        )
        .unwrap();

        assert!(!try_watch(Some(&mut watcher), missing.to_str().unwrap()));
        assert!(!try_watch(None, dir.path().to_str().unwrap()));
        assert!(try_watch(Some(&mut watcher), dir.path().to_str().unwrap()));
    }

    #[test]
    fn root_of_skips_an_empty_root() {
        let roots = roots(&[""]);

        assert_eq!(root_of(Path::new("/work/repo/a.ts"), &roots), None);
    }

    #[test]
    fn consented_roots_reads_true_keys_only() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("repo-consents.json");
        fs::write(
            &path,
            r#"{"/a": true, "/b": false, "/c": "yes", "/d": 1, "": true}"#,
        )
        .unwrap();

        assert_eq!(consented_roots(&path), roots(&["/a"]));
    }

    #[test]
    fn consented_roots_is_empty_on_any_read_or_parse_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("repo-consents.json");
        assert!(consented_roots(&path).is_empty(), "missing file");

        fs::write(&path, "{not json").unwrap();
        assert!(consented_roots(&path).is_empty(), "garbage");

        fs::write(&path, r#"["/a"]"#).unwrap();
        assert!(consented_roots(&path).is_empty(), "not an object");

        fs::write(&path, vec![0xff, 0xfe, b'{']).unwrap();
        assert!(consented_roots(&path).is_empty(), "not UTF-8");
    }
}
