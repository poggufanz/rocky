//! The setup guard inside the daemon loop. Watches the setup and config
//! directories, checks the guarded files, runs one Node job at a time on a worker
//! thread, and carries out the effects the guard returns.

use std::collections::{BTreeSet, HashMap};
use std::io;
use std::panic::{self, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::mpsc::{self, Receiver, Sender, SyncSender};
use std::thread;

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use rocky_proto::pipe::{ConsentState, ServerMsg, SetupAction, TargetState};
use rockyd::guard::check::{Debounce, missing_paths, watch_dirs};
use rockyd::guard::node::{AutoResult, NODE_TIMEOUT, RunError, run_setup};
use rockyd::guard::records::{
    CliRecord, Expected, cli_status, read_bin_version, read_cli, read_consent, read_expected,
};
use rockyd::guard::{Effect, Guard, GuardConsts, Job, Observation};
use rockyd::log::RotatingLog;
use rockyd::server::Hub;

use crate::{Shared, now_ms};

/// A finished worker run: the job and what Node reported for it.
type JobResult = (Job, Result<AutoResult, RunError>);

/// The setup guard as the daemon loop drives it. The loop owns it. Only the
/// worker result channel crosses threads.
pub(crate) struct GuardLoop {
    home: PathBuf,
    guard: Guard,
    debounce: Debounce,
    /// The setup-directory watcher. `None` when the platform has none; the
    /// 60 s check still covers the guarded files then.
    watcher: Option<RecommendedWatcher>,
    /// One ping per change event in a watched directory.
    pings: Receiver<()>,
    /// Directories the watcher covers now.
    watched: BTreeSet<PathBuf>,
    /// Directories whose watch failed. Each is logged once.
    warned: BTreeSet<PathBuf>,
    /// Reply channels of client requests waiting on a job, keyed by token.
    replies: HashMap<u64, SyncSender<ServerMsg>>,
    /// The last token handed out.
    last_token: u64,
    results_tx: Sender<JobResult>,
    results: Receiver<JobResult>,
}

impl GuardLoop {
    /// A guard for the Rocky home at `home`. The first apply is due at `now`.
    pub(crate) fn new(home: PathBuf, log: &RotatingLog, now: u64) -> Self {
        let consts = GuardConsts::default();
        let (ping_tx, pings) = mpsc::channel();
        let watcher =
            match notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
                let relevant = match &res {
                    Ok(event) => is_change(&event.kind),
                    // A watcher fault still checks the files.
                    Err(_) => true,
                };
                if relevant {
                    let _ = ping_tx.send(());
                }
            }) {
                Ok(watcher) => Some(watcher),
                Err(_) => {
                    log.line("setup watcher unavailable, polling only");
                    None
                }
            };
        let (results_tx, results) = mpsc::channel();
        Self {
            home,
            guard: Guard::new(consts, now),
            debounce: Debounce::new(consts.debounce_ms),
            watcher,
            pings,
            watched: BTreeSet::new(),
            warned: BTreeSet::new(),
            replies: HashMap::new(),
            last_token: 0,
            results_tx,
            results,
        }
    }

    /// Reads the records and the guarded files, feeds the guard, and publishes the
    /// setup status. Runs at startup, after every job, when a debounced change is
    /// due, and on every tick.
    pub(crate) fn check(&mut self, shared: &Mutex<Shared>, hub: &Hub, log: &RotatingLog) {
        let expected = read_expected(&self.home);
        let observation = self.observation(&expected);
        let now = now_ms();
        let effects = self.guard.observe(observation, now);
        self.apply(effects, shared, hub, log);
        self.publish_setup(shared, hub, now);
        self.sync_watches(watch_dirs(&expected, &self.home), log);
    }

    /// What the records and guarded files say now. Guarded files are read only
    /// under approved consent, so none is judged missing otherwise.
    fn observation(&self, expected: &Expected) -> Observation {
        let consent = read_consent(&self.home);
        let cli = read_cli(&self.home);
        let (cli_found, cli_missing) = cli_status(cli.as_ref());
        let version_mismatch = match (&cli, read_bin_version(&self.home)) {
            (Some(record), Some(bin)) => record.version != bin,
            _ => false,
        };
        let missing = if consent.state == ConsentState::Approved {
            missing_paths(expected, &mut |path: &Path| std::fs::read(path).ok())
        } else {
            Vec::new()
        };
        Observation {
            consent,
            cli,
            cli_found,
            cli_missing,
            version_mismatch,
            missing,
        }
    }

    /// Stores the guard's setup status, and broadcasts health when it moved.
    fn publish_setup(&self, shared: &Mutex<Shared>, hub: &Hub, now: u64) {
        let (health, changed) = {
            let mut s = shared.lock().unwrap();
            s.setup = self.guard.health(now);
            s.take_health()
        };
        if changed {
            hub.broadcast(&ServerMsg::Health { health });
        }
    }

    /// Carries out the effects the guard returned: replies, gaps, the pending repo
    /// list, and log lines.
    fn apply(
        &mut self,
        effects: Vec<Effect>,
        shared: &Mutex<Shared>,
        hub: &Hub,
        log: &RotatingLog,
    ) {
        for effect in effects {
            match effect {
                Effect::Reply { token, msg } => {
                    // A client that hung up dropped its receiver, so a failed send is ignored.
                    if let Some(reply) = self.replies.remove(&token) {
                        let _ = reply.send(msg);
                    }
                }
                Effect::Gap(gap) => {
                    let mut s = shared.lock().unwrap();
                    s.gaps.push(gap);
                    s.state.record_gap(&gap);
                }
                Effect::PendingChanged => {
                    let repos = self.guard.pending();
                    shared.lock().unwrap().repo_pending = repos.clone();
                    hub.broadcast(&ServerMsg::RepoPending { repos });
                }
                Effect::Log(line) => log.line(&line),
            }
        }
    }

    /// Points the watcher at `desired`: unwatches directories no longer needed and
    /// watches new ones. A failed watch is logged once per directory, and the tick
    /// check still covers the files.
    fn sync_watches(&mut self, desired: BTreeSet<PathBuf>, log: &RotatingLog) {
        let Some(watcher) = self.watcher.as_mut() else {
            return;
        };
        let gone: Vec<PathBuf> = self.watched.difference(&desired).cloned().collect();
        for dir in gone {
            // Unwatching a removed directory fails, but the watch is gone either way.
            let _ = watcher.unwatch(&dir);
            self.watched.remove(&dir);
        }
        let added: Vec<PathBuf> = desired.difference(&self.watched).cloned().collect();
        for dir in added {
            match watcher.watch(&dir, RecursiveMode::NonRecursive) {
                Ok(()) => {
                    self.watched.insert(dir);
                }
                Err(_) => {
                    if self.warned.insert(dir) {
                        log.line(
                            "cannot watch one setup directory; the 60 s check still covers it",
                        );
                    }
                }
            }
        }
    }

    /// Starts the next job the guard hands out, when one is due and none is running.
    /// A job with no CLI record fails at once, since nothing can run. Any other job
    /// runs on a worker thread, and its result returns through the results channel.
    fn start_job(&mut self, shared: &Mutex<Shared>, hub: &Hub, log: &RotatingLog) {
        let Some(job) = self.guard.next_job(now_ms()) else {
            return;
        };
        let out = match self.guard.cli().cloned() {
            Some(cli) => match self.spawn_worker(cli, job.clone()) {
                Ok(()) => return,
                Err(error) => Err(RunError::Spawn(error.to_string())),
            },
            None => Err(RunError::NoCli),
        };
        self.finish(&job, out, shared, hub, log);
    }

    /// Runs one job on a worker thread under `cli`.
    fn spawn_worker(&self, cli: CliRecord, job: Job) -> io::Result<()> {
        let home = self.home.clone();
        let results = self.results_tx.clone();
        thread::Builder::new()
            .spawn(move || {
                // ponytail: a daemon exit mid-apply leaves Node running to completion;
                // the next apply's transaction recovery covers a kill.
                let out = run_contained(|| run_setup(&cli, &home, &job.args(), NODE_TIMEOUT));
                // A failed send means the loop has exited, so nothing is lost.
                let _ = results.send((job, out));
            })
            .map(|_handle| ())
    }

    /// Records one finished job: logs it, lets the guard take it, carries out its
    /// effects, and observes the files again before any next job.
    fn finish(
        &mut self,
        job: &Job,
        out: Result<AutoResult, RunError>,
        shared: &Mutex<Shared>,
        hub: &Hub,
        log: &RotatingLog,
    ) {
        log_outcome(job, &out, log);
        let effects = self.guard.finish(job, out, now_ms());
        self.apply(effects, shared, hub, log);
        self.check(shared, hub, log);
    }

    /// Finishes every worker run that has come back.
    fn drain_results(&mut self, shared: &Mutex<Shared>, hub: &Hub, log: &RotatingLog) {
        while let Ok((job, out)) = self.results.try_recv() {
            self.finish(&job, out, shared, hub, log);
        }
    }

    /// The guard's work for one pass of the daemon loop: finished jobs, a debounced
    /// check after watcher pings, and the next job.
    pub(crate) fn service(&mut self, shared: &Mutex<Shared>, hub: &Hub, log: &RotatingLog) {
        self.drain_results(shared, hub, log);
        let mut pinged = false;
        while self.pings.try_recv().is_ok() {
            pinged = true;
        }
        if pinged {
            self.debounce.poke(now_ms());
        }
        if self.debounce.take_due(now_ms()) {
            self.check(shared, hub, log);
        }
        self.start_job(shared, hub, log);
    }

    /// Queues a client `setup` request. Its reply goes to `reply` when the job
    /// finishes, or at once when the request is refused.
    pub(crate) fn setup_request(
        &mut self,
        id: u64,
        action: SetupAction,
        reply: SyncSender<ServerMsg>,
        shared: &Mutex<Shared>,
        hub: &Hub,
        log: &RotatingLog,
    ) {
        let token = self.store_reply(reply);
        if let Some(effect) = self.guard.setup_request(token, id, action) {
            self.apply(vec![effect], shared, hub, log);
        }
    }

    /// Queues a client `repo_decision` request. Its reply goes to `reply` when the
    /// job finishes.
    pub(crate) fn repo_request(
        &mut self,
        id: u64,
        root: String,
        allow: bool,
        reply: SyncSender<ServerMsg>,
    ) {
        let token = self.store_reply(reply);
        self.guard.repo_request(token, id, root, allow);
    }

    /// Keeps the reply channel of a queued request under a new token.
    fn store_reply(&mut self, reply: SyncSender<ServerMsg>) -> u64 {
        self.last_token += 1;
        self.replies.insert(self.last_token, reply);
        self.last_token
    }

    /// Session roots whose repo the owner has allowed capture for.
    pub(crate) fn allowed_roots(&self) -> BTreeSet<String> {
        self.guard.allowed_roots()
    }

    /// Queues the config dirs and session repos one rescan found.
    pub(crate) fn rescanned(&mut self, locations: &[(String, String)], roots: &[String]) {
        for (harness, location) in locations {
            self.guard.discovered(harness, location);
        }
        for root in roots {
            self.guard.session_root(root);
        }
    }
}

/// The log line for one finished job. It names the job kind and counts. It never
/// carries a path, config text, or Node's notes.
fn log_outcome(job: &Job, out: &Result<AutoResult, RunError>, log: &RotatingLog) {
    let label = job.log_label();
    let line = match out {
        Ok(result) => {
            let not_ok = result
                .targets
                .iter()
                .filter(|target| !is_ok(target.state))
                .count();
            format!("{label}: {} targets, {not_ok} not ok", result.targets.len())
        }
        Err(error) => format!("{label} failed: {error}"),
    };
    log.line(&line);
}

/// Whether a target needs no repair: it is in place, or Node just wrote it.
fn is_ok(state: TargetState) -> bool {
    matches!(state, TargetState::Ok | TargetState::Written)
}

/// Whether a watcher event can change a guarded file or record. Access events are
/// opens, reads, and closes. The check itself opens these files, so counting them
/// would re-run the check forever on inotify.
pub(crate) fn is_change(kind: &EventKind) -> bool {
    !matches!(kind, EventKind::Access(_))
}

/// Runs one Node job and turns a panic into an internal error result, so a finished
/// job always reaches the loop. The daemon's panic hook aborts the process before a
/// panic unwinds, so this catches only the panics that unwind.
fn run_contained(
    run: impl FnOnce() -> Result<AutoResult, RunError>,
) -> Result<AutoResult, RunError> {
    panic::catch_unwind(AssertUnwindSafe(run))
        .unwrap_or_else(|_| Err(RunError::Internal("worker stopped".to_string())))
}

#[cfg(test)]
mod tests {
    use notify::EventKind;
    use notify::event::{AccessKind, AccessMode, CreateKind, DataChange, ModifyKind, RemoveKind};
    use rockyd::guard::node::RunError;

    use super::{is_change, run_contained};

    #[test]
    fn opens_reads_and_closes_are_not_changes() {
        assert!(!is_change(&EventKind::Access(AccessKind::Open(
            AccessMode::Read
        ))));
        assert!(!is_change(&EventKind::Access(AccessKind::Open(
            AccessMode::Write
        ))));
        assert!(!is_change(&EventKind::Access(AccessKind::Close(
            AccessMode::Read
        ))));
        assert!(!is_change(&EventKind::Access(AccessKind::Close(
            AccessMode::Write
        ))));
        assert!(!is_change(&EventKind::Access(AccessKind::Read)));
    }

    #[test]
    fn creates_modifies_and_removes_are_changes() {
        assert!(is_change(&EventKind::Create(CreateKind::File)));
        assert!(is_change(&EventKind::Modify(ModifyKind::Data(
            DataChange::Content
        ))));
        assert!(is_change(&EventKind::Modify(ModifyKind::Any)));
        assert!(is_change(&EventKind::Remove(RemoveKind::File)));
    }

    #[test]
    fn a_panicking_run_reports_an_internal_error() {
        let out = run_contained(|| panic!("simulated worker panic"));
        assert_eq!(out, Err(RunError::Internal("worker stopped".to_string())));
    }

    #[test]
    fn a_finished_run_passes_its_result_through() {
        let out = run_contained(|| Err(RunError::Timeout));
        assert_eq!(out, Err(RunError::Timeout));
    }
}
