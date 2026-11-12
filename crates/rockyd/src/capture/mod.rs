//! Capture decisions for the daemon: when the capture child starts and stops, which roots it
//! is asked to reconcile, and how its answers read as per-repo health.
//!
//! This module is pure state. It does no I/O, spawns nothing, and never reads a clock: every
//! time comes from the caller. The caller owns the child process and the file watcher, feeds
//! what happens to them in through the methods below, and runs the actions that
//! [`Capture::next_action`] returns.

use rocky_proto::pipe::{CaptureHealth, CaptureState};
use rocky_proto::respawn::RespawnPolicy;
use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet};

pub const CLI_MISSING: &str = "Rocky cannot find Node. Run rocky once.";
pub const SPAWN_FAILED: &str = "Node could not start.";
pub const RESTARTS: &str = "Capture stopped after 3 restarts in 5 minutes.";
pub const POLLING: &str = "Watching files failed; capturing every 60 seconds.";

/// The only `v` the capture child writes.
const WIRE_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CaptureConsts {
    /// How long after the first file event of a burst a root is sent.
    pub debounce_ms: u64,
    /// The least time between two sends for the same root.
    pub send_gap_ms: u64,
    pub respawn_max: usize,
    pub respawn_window_ms: u64,
}

impl Default for CaptureConsts {
    fn default() -> Self {
        Self {
            debounce_ms: 300,
            send_gap_ms: 2_000,
            respawn_max: 3,
            respawn_window_ms: 300_000,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Coverage {
    Complete,
    Partial,
    Unknown,
}

/// One root the child lists, and whether this child is the one capturing it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct RootOwner {
    pub root: String,
    pub owner: bool,
}

/// One reconcile outcome for a root.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Report {
    pub root: String,
    pub coverage: Coverage,
    pub gaps: u64,
    pub reason: Option<String>,
    pub at_ms: u64,
}

/// A line the capture child writes to stdout.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CaptureLine {
    Roots(Vec<RootOwner>),
    Result(Report),
}

/// What the caller must do next.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// Start the child, then report [`Capture::child_started`] or [`Capture::spawn_failed`].
    Spawn,
    /// Stop the child, then report [`Capture::child_exited`].
    Stop,
    /// Ask the running child to reconcile this root.
    Send(String),
}

/// The wire shapes, strict on purpose: a missing field, a wrong type, or a wrong `v` rejects
/// the whole line. `reason` must be present, as a string or null.
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Wire {
    Roots {
        v: u32,
        roots: Vec<RootOwner>,
    },
    Result {
        v: u32,
        root: String,
        coverage: Coverage,
        gaps: u64,
        #[serde(deserialize_with = "Option::deserialize")]
        reason: Option<String>,
        at_ms: u64,
    },
}

/// Parses one child stdout line. Anything that is not a version 1 `roots` or `result` line is
/// `None`.
pub fn parse_line(line: &str) -> Option<CaptureLine> {
    match serde_json::from_str::<Wire>(line).ok()? {
        Wire::Roots {
            v: WIRE_VERSION,
            roots,
        } => Some(CaptureLine::Roots(roots)),
        Wire::Result {
            v: WIRE_VERSION,
            root,
            coverage,
            gaps,
            reason,
            at_ms,
        } => Some(CaptureLine::Result(Report {
            root,
            coverage,
            gaps,
            reason,
            at_ms,
        })),
        _ => None,
    }
}

/// Plain words for a failed reconcile. Only the known reasons are named; anything else,
/// including a reason that carries a path, becomes the generic text.
pub fn reason_text(reason: Option<&str>) -> &'static str {
    match reason {
        Some("repo-consent-required") => "Capture is not allowed for this repo.",
        Some("git-unreadable") => "Git could not list the files.",
        Some("root-unusable") => "The repo folder cannot be read.",
        _ => "Capture failed.",
    }
}

/// Everything learned from the current child. A start wipes all of it: the new child lists its
/// roots again and reconciles each one on its own.
#[derive(Debug, Default)]
struct ChildRun {
    /// The last `roots` line. `None` until the child writes its first one.
    listed: Option<Vec<RootOwner>>,
    results: BTreeMap<String, Report>,
    watch_failed: BTreeSet<String>,
    extras_sent: BTreeSet<String>,
    /// Root to the time of its first file event since its last send.
    pending: BTreeMap<String, u64>,
    last_send: BTreeMap<String, u64>,
}

#[derive(Debug)]
pub struct Capture {
    consts: CaptureConsts,
    policy: RespawnPolicy,
    consented: BTreeSet<String>,
    extra: BTreeSet<String>,
    cli_found: bool,
    running: bool,
    /// The last spawn attempt failed. Only a successful start clears it.
    spawn_failed: bool,
    /// The last `next_action` wanted a spawn and the respawn limit said no.
    restarts_refused: bool,
    run: ChildRun,
}

impl Capture {
    pub fn new(consts: CaptureConsts) -> Self {
        Self {
            policy: RespawnPolicy::new(consts.respawn_max, consts.respawn_window_ms),
            consts,
            consented: BTreeSet::new(),
            extra: BTreeSet::new(),
            cli_found: false,
            running: false,
            spawn_failed: false,
            restarts_refused: false,
            run: ChildRun::default(),
        }
    }

    pub fn set_inputs(
        &mut self,
        consented: BTreeSet<String>,
        extra: BTreeSet<String>,
        cli_found: bool,
    ) {
        self.consented = consented;
        self.extra = extra;
        self.cli_found = cli_found;
    }

    pub fn child_started(&mut self) {
        self.running = true;
        self.spawn_failed = false;
        self.restarts_refused = false;
        self.run = ChildRun::default();
    }

    /// The spawn that [`Action::Spawn`] asked for did not produce a child.
    pub fn spawn_failed(&mut self) {
        self.running = false;
        self.spawn_failed = true;
    }

    pub fn child_exited(&mut self) {
        self.running = false;
    }

    pub fn line(&mut self, line: CaptureLine) {
        match line {
            CaptureLine::Roots(roots) => self.replace_roots(roots),
            CaptureLine::Result(report) => {
                if self.is_row(&report.root) {
                    self.run.results.insert(report.root.clone(), report);
                }
            }
        }
    }

    /// A file under `root` changed. Only roots this child owns are tracked.
    pub fn fs_event(&mut self, root: &str, now_ms: u64) {
        if self.owned().any(|owned| owned == root) {
            self.run.pending.entry(root.to_owned()).or_insert(now_ms);
        }
    }

    /// The watcher for `root` failed; the child now polls it instead.
    pub fn watch_failed(&mut self, root: &str) {
        if self.owned().any(|owned| owned == root) {
            self.run.watch_failed.insert(root.to_owned());
        }
    }

    /// The next thing to do, or `None`. Call again after each action until it returns `None`.
    /// After [`Action::Spawn`], report `child_started` or `spawn_failed` first: every `Spawn`
    /// returned counts against the respawn limit.
    pub fn next_action(&mut self, now_ms: u64) -> Option<Action> {
        if !self.running {
            if !self.wanted() || !self.cli_found {
                return None;
            }
            self.restarts_refused = !self.policy.allow(now_ms);
            return (!self.restarts_refused).then_some(Action::Spawn);
        }
        if !self.wanted() {
            return Some(Action::Stop);
        }
        self.next_send(now_ms)
    }

    /// The roots the caller should watch: the ones the child owns.
    pub fn watch_roots(&self) -> BTreeSet<String> {
        self.owned().map(str::to_owned).collect()
    }

    pub fn health(&self) -> Vec<CaptureHealth> {
        if !self.wanted() {
            return Vec::new();
        }
        let global = self.global_failure();
        self.rows()
            .into_iter()
            .map(|row| {
                let report = self.run.results.get(&row.root);
                let (state, error) = match global {
                    Some(text) => (CaptureState::Failed, Some(text)),
                    None => self.row_state(&row, report),
                };
                CaptureHealth {
                    root: row.root,
                    state,
                    last_reconcile_ms: report.map(|report| report.at_ms),
                    error: error.map(str::to_owned),
                }
            })
            .collect()
    }

    fn wanted(&self) -> bool {
        !self.consented.is_empty() || !self.extra.is_empty()
    }

    /// Roots the child owns. Empty before its first `roots` line and when nothing is wanted.
    fn owned(&self) -> impl Iterator<Item = &str> {
        let listed = if self.wanted() {
            self.run.listed.as_deref().unwrap_or_default()
        } else {
            &[]
        };
        listed
            .iter()
            .filter(|row| row.owner)
            .map(|row| row.root.as_str())
    }

    /// The rows health reports: what the child listed, else what is wanted.
    fn rows(&self) -> Vec<RootOwner> {
        match &self.run.listed {
            Some(listed) => listed.clone(),
            None => self
                .consented
                .union(&self.extra)
                .map(|root| RootOwner {
                    root: root.clone(),
                    owner: true,
                })
                .collect(),
        }
    }

    fn is_row(&self, root: &str) -> bool {
        match &self.run.listed {
            Some(listed) => listed.iter().any(|row| row.root == root),
            None => self.consented.contains(root) || self.extra.contains(root),
        }
    }

    fn replace_roots(&mut self, roots: Vec<RootOwner>) {
        let run = &mut self.run;
        run.results
            .retain(|root, _| roots.iter().any(|row| row.root == *root));
        run.pending
            .retain(|root, _| roots.iter().any(|row| row.owner && row.root == *root));
        run.watch_failed.clear();
        run.listed = Some(roots);
    }

    fn next_send(&mut self, now_ms: u64) -> Option<Action> {
        let unsent_extra = self
            .extra
            .iter()
            .find(|root| !self.run.extras_sent.contains(*root))
            .cloned();
        if let Some(root) = unsent_extra {
            self.run.extras_sent.insert(root.clone());
            return Some(Action::Send(root));
        }
        let due = self
            .run
            .pending
            .iter()
            .find(|&(root, &first_event_ms)| now_ms >= self.due_ms(root, first_event_ms))
            .map(|(root, _)| root.clone())?;
        self.run.pending.remove(&due);
        self.run.last_send.insert(due.clone(), now_ms);
        Some(Action::Send(due))
    }

    /// A root is due once its debounce has run from the first event since the last send, and
    /// the send gap has run from that send. Later events do not move the debounce.
    fn due_ms(&self, root: &str, first_event_ms: u64) -> u64 {
        let debounced = first_event_ms.saturating_add(self.consts.debounce_ms);
        match self.run.last_send.get(root) {
            Some(sent_ms) => debounced.max(sent_ms.saturating_add(self.consts.send_gap_ms)),
            None => debounced,
        }
    }

    /// A failure that hides every row. Missing Node outranks the restart limit, which
    /// outranks the last spawn failure.
    fn global_failure(&self) -> Option<&'static str> {
        if !self.cli_found {
            Some(CLI_MISSING)
        } else if self.restarts_refused {
            Some(RESTARTS)
        } else if self.spawn_failed {
            Some(SPAWN_FAILED)
        } else {
            None
        }
    }

    fn row_state(
        &self,
        row: &RootOwner,
        report: Option<&Report>,
    ) -> (CaptureState, Option<&'static str>) {
        if !row.owner {
            return (CaptureState::Elsewhere, None);
        }
        match report.map(|report| report.coverage) {
            Some(Coverage::Unknown) => {
                let reason = report.and_then(|report| report.reason.as_deref());
                (CaptureState::Failed, Some(reason_text(reason)))
            }
            _ if self.run.watch_failed.contains(&row.root) => {
                (CaptureState::Polling, Some(POLLING))
            }
            Some(Coverage::Complete) => (CaptureState::Ok, None),
            Some(Coverage::Partial) => (CaptureState::Partial, None),
            None => (CaptureState::Starting, None),
        }
    }
}

#[cfg(test)]
mod tests;
