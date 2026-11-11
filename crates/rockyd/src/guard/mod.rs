//! Checks that Rocky's entries in agent config files are still present.
//!
//! The records are written by Node. This module reads them and checks bytes;
//! it never parses or writes an agent config.

pub mod brake;
pub mod check;
pub mod node;
pub mod records;

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use rocky_proto::pipe::{
    ConsentState, Gap, GapReason, ServerMsg, SetupAction, SetupHealth, SetupTarget, TargetHealth,
    TargetState,
};

use self::brake::{Brake, BrakeConsts};
use self::node::{AutoResult, RunError};
use self::records::{CliRecord, ConsentView};

/// The target kind that carries Rocky's desk hook entries.
const DESK_HOOKS_KIND: &str = "desk-hooks";

/// Error text for a path an apply reported as set up that is still missing afterwards.
const STILL_MISSING: &str = "still missing after setup ran";

/// Tunables for [`Guard`]. The daemon uses `Default`; tests override fields.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GuardConsts {
    /// Quiet time after a config file change before the files are checked again.
    pub debounce_ms: u64,
    /// Time between detection runs when nothing else is pending.
    pub detect_every_ms: u64,
    /// Retry delays after a `Changed` result. The last value repeats.
    pub changed_backoff_ms: [u64; 5],
    /// Cap on remembered client request ids.
    pub seen_cap: usize,
    /// Repair limits for each config path.
    pub brake: BrakeConsts,
}

impl Default for GuardConsts {
    fn default() -> Self {
        Self {
            debounce_ms: 1_000,
            detect_every_ms: 3_600_000,
            changed_backoff_ms: [2_000, 4_000, 8_000, 16_000, 30_000],
            seen_cap: 256,
            brake: BrakeConsts::default(),
        }
    }
}

/// What the daemon saw in the config files and records at one moment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Observation {
    pub consent: ConsentView,
    pub cli: Option<CliRecord>,
    pub cli_found: bool,
    pub cli_missing: Option<String>,
    pub version_mismatch: bool,
    /// Config paths that no longer hold Rocky's snippets.
    pub missing: Vec<PathBuf>,
}

/// One Node run the guard hands out.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Job {
    /// Restore every entry.
    Apply,
    /// Record the config directory for one harness.
    ConfigDir { harness: String, location: String },
    /// Read the capture decision for one repo.
    RepoStatus { root: String },
    /// A client `setup` request.
    Setup {
        token: u64,
        id: u64,
        action: SetupAction,
    },
    /// A client `repo_decision` request.
    RepoDecision {
        token: u64,
        id: u64,
        root: String,
        allow: bool,
    },
}

impl Job {
    /// The Node arguments for this job, without the `--json` flag.
    pub fn args(&self) -> Vec<String> {
        match self {
            Self::Apply => to_args(&["apply"]),
            Self::ConfigDir { harness, location } => {
                to_args(&["config-dir", harness.as_str(), location.as_str()])
            }
            Self::RepoStatus { root } => to_args(&["repo", "status", root.as_str()]),
            Self::Setup { action, .. } => setup_args(action),
            Self::RepoDecision { root, allow, .. } => {
                let verb = if *allow { "allow" } else { "decline" };
                to_args(&["repo", verb, root.as_str()])
            }
        }
    }
}

/// Copies static argument words into owned strings.
fn to_args(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|part| (*part).to_string()).collect()
}

/// The Node arguments for one `setup` action.
fn setup_args(action: &SetupAction) -> Vec<String> {
    match action {
        SetupAction::Plan => to_args(&["plan"]),
        SetupAction::Apply => to_args(&["apply"]),
        SetupAction::Remove => to_args(&["remove"]),
        SetupAction::ConsentApprove => to_args(&["consent", "approve"]),
        SetupAction::ConsentLater => to_args(&["consent", "later"]),
        SetupAction::HarnessOn { harness } => to_args(&["harness", harness.as_str(), "on"]),
        SetupAction::HarnessOff { harness } => to_args(&["harness", harness.as_str(), "off"]),
    }
}

/// Something the caller does after the guard changed state.
#[derive(Debug, Clone, PartialEq)]
// Effects are short-lived return values; boxing the reply would add an allocation per message.
#[allow(clippy::large_enum_variant)]
pub enum Effect {
    /// Send `msg` to the client that asked with `token`.
    Reply { token: u64, msg: ServerMsg },
    /// A stretch of time when hook entries were missing.
    Gap(Gap),
    /// The pending repo list changed.
    PendingChanged,
    /// A daemon log line.
    Log(String),
}

/// Decides when the daemon runs Node setup and what the desk shows.
///
/// Pure: the caller passes observations and times in, and runs the jobs the
/// guard hands out. One job is out at a time.
pub struct Guard {
    c: GuardConsts,
    brake: Brake,
    observed: Observation,
    /// Targets from the last successful apply.
    targets: Vec<SetupTarget>,
    /// Earliest time an apply may run when nothing else is pending.
    next_detect: u64,
    /// The CLI record the last apply ran under. `None` until an apply has run.
    applied_under: Option<Option<CliRecord>>,
    /// Consecutive applies that reported a `Changed` target.
    changed_streak: usize,
    /// When to retry after `Changed` targets.
    changed_retry: Option<u64>,
    in_flight: bool,
    /// Paths that are missing now, with the time each went missing.
    missing_since: BTreeMap<PathBuf, u64>,
    /// Paths an apply attempted, awaiting the next observation: path to finish time.
    pending: BTreeMap<PathBuf, u64>,
    /// Error text for missing paths whose last attempt did not restore them.
    errors: BTreeMap<PathBuf, String>,
}

impl Guard {
    /// A guard that has seen nothing yet. The first apply is due at `now_ms`.
    pub fn new(c: GuardConsts, now_ms: u64) -> Self {
        let brake = Brake::new(c.brake);
        Self {
            c,
            brake,
            observed: unobserved(),
            targets: Vec::new(),
            next_detect: now_ms,
            applied_under: None,
            changed_streak: 0,
            changed_retry: None,
            in_flight: false,
            missing_since: BTreeMap::new(),
            pending: BTreeMap::new(),
            errors: BTreeMap::new(),
        }
    }

    /// The CLI record from the last observation.
    pub fn cli(&self) -> Option<&CliRecord> {
        self.observed.cli.as_ref()
    }

    /// Takes in one observation and returns the effects of restored hooks.
    pub fn observe(&mut self, obs: Observation, now_ms: u64) -> Vec<Effect> {
        let effects = if obs.consent.state == ConsentState::Approved {
            let missing: BTreeSet<PathBuf> = obs.missing.iter().cloned().collect();
            let effects = self.judge_pending(&missing);
            self.track_missing(&missing, now_ms);
            effects
        } else {
            self.forget_missing();
            Vec::new()
        };
        self.observed = obs;
        effects
    }

    /// The next job to run, if one is due. One job is out at a time.
    pub fn next_job(&mut self, now_ms: u64) -> Option<Job> {
        if self.in_flight || !self.apply_due(now_ms) {
            return None;
        }
        self.in_flight = true;
        self.applied_under = Some(self.observed.cli.clone());
        self.changed_retry = None;
        Some(Job::Apply)
    }

    /// Records the outcome of a job the guard handed out.
    pub fn finish(
        &mut self,
        job: &Job,
        out: Result<AutoResult, RunError>,
        now_ms: u64,
    ) -> Vec<Effect> {
        self.in_flight = false;
        if matches!(job, Job::Apply) {
            self.next_detect = now_ms.saturating_add(self.c.detect_every_ms);
            match out {
                Ok(result) => self.apply_succeeded(result, now_ms),
                Err(err) => self.apply_failed(&err, now_ms),
            }
        }
        // Setup and repo jobs have no effects yet. Their replies come with the client requests.
        Vec::new()
    }

    /// The setup status the desk shows.
    pub fn health(&self, now_ms: u64) -> SetupHealth {
        let approved = self.observed.consent.state == ConsentState::Approved;
        let targets = if approved {
            self.health_targets(now_ms)
        } else {
            Vec::new()
        };
        SetupHealth {
            consent_state: self.observed.consent.state,
            cli_found: self.observed.cli_found,
            cli_missing: self.observed.cli_missing.clone(),
            version_mismatch: self.observed.version_mismatch,
            targets,
        }
    }

    /// Whether an apply is due now. Needs approved consent and a CLI that was found.
    fn apply_due(&self, now_ms: u64) -> bool {
        let ready =
            self.observed.consent.state == ConsentState::Approved && self.observed.cli_found;
        ready
            && (now_ms >= self.next_detect
                || self.cli_changed()
                || self.changed_retry.is_some_and(|at| now_ms >= at)
                || self.missing_repairable(now_ms))
    }

    /// The CLI record differs from the one the last apply ran under.
    fn cli_changed(&self) -> bool {
        matches!(&self.applied_under, Some(under) if *under != self.observed.cli)
    }

    /// A missing path that an apply attempted, and no observation has judged yet, does not count.
    fn missing_repairable(&self, now_ms: u64) -> bool {
        self.missing_since
            .keys()
            .filter(|path| !self.pending.contains_key(*path))
            .any(|path| self.brake.may_repair(path, now_ms))
    }

    /// Judges attempts made before this observation. Returns gap effects for restored hooks.
    fn judge_pending(&mut self, missing: &BTreeSet<PathBuf>) -> Vec<Effect> {
        let mut effects = Vec::new();
        for (path, finish_ms) in std::mem::take(&mut self.pending) {
            if missing.contains(&path) {
                self.brake.failed(&path, finish_ms);
                self.errors
                    .entry(path)
                    .or_insert_with(|| STILL_MISSING.to_string());
            } else {
                self.brake.repaired(&path, finish_ms);
                effects.extend(self.restored_gap(&path, finish_ms).map(Effect::Gap));
            }
        }
        effects
    }

    /// Updates missing tracking from the paths this observation shows missing.
    fn track_missing(&mut self, missing: &BTreeSet<PathBuf>, now_ms: u64) {
        let previous = std::mem::take(&mut self.missing_since);
        for path in missing {
            let since = match previous.get(path) {
                Some(&since) => since,
                None => {
                    self.brake.lost(path, now_ms);
                    now_ms
                }
            };
            self.missing_since.insert(path.clone(), since);
        }
        let tracked = &self.missing_since;
        self.errors.retain(|path, _| tracked.contains_key(path));
    }

    /// Clears all missing tracking, used while consent is not approved.
    fn forget_missing(&mut self) {
        self.missing_since.clear();
        self.pending.clear();
        self.errors.clear();
    }

    /// A gap for a restored path, when the last targets include a desk hooks entry there.
    fn restored_gap(&self, path: &Path, finish_ms: u64) -> Option<Gap> {
        let from_ms = *self.missing_since.get(path)?;
        let hooks = self
            .targets
            .iter()
            .any(|target| target.kind == DESK_HOOKS_KIND && Path::new(&target.path) == path);
        hooks.then_some(Gap {
            from_ms,
            to_ms: finish_ms,
            count: 0,
            reason: GapReason::HooksRestored,
        })
    }

    fn apply_succeeded(&mut self, result: AutoResult, now_ms: u64) {
        let changed = result
            .targets
            .iter()
            .any(|target| target.state == TargetState::Changed);
        self.targets = result.targets;
        self.schedule_changed_retry(changed, now_ms);
        for path in self.missing_paths() {
            self.brake.attempted(&path, now_ms);
            self.pending.insert(path.clone(), now_ms);
            match self.detail_for(&path) {
                Some(detail) => {
                    self.errors.insert(path, detail);
                }
                None => {
                    self.errors.remove(&path);
                }
            }
        }
    }

    fn apply_failed(&mut self, err: &RunError, now_ms: u64) {
        let text = err.to_string();
        for path in self.missing_paths() {
            self.brake.attempted(&path, now_ms);
            self.brake.failed(&path, now_ms);
            self.pending.remove(&path);
            self.errors.insert(path, text.clone());
        }
    }

    /// Sets the retry for `Changed` targets. A result without them resets the backoff.
    fn schedule_changed_retry(&mut self, changed: bool, now_ms: u64) {
        if !changed {
            self.changed_streak = 0;
            self.changed_retry = None;
            return;
        }
        let steps = self.c.changed_backoff_ms;
        let delay = steps[self.changed_streak.min(steps.len() - 1)];
        self.changed_streak = self.changed_streak.saturating_add(1);
        self.changed_retry = Some(now_ms.saturating_add(delay));
    }

    fn missing_paths(&self) -> Vec<PathBuf> {
        self.missing_since.keys().cloned().collect()
    }

    /// The detail Node gave the first target at `path`, if it gave one.
    fn detail_for(&self, path: &Path) -> Option<String> {
        self.targets
            .iter()
            .find(|target| Path::new(&target.path) == path)
            .and_then(|target| target.detail.clone())
    }

    /// Stored targets first, then one row for each missing path that no stored target names.
    fn health_targets(&self, now_ms: u64) -> Vec<TargetHealth> {
        let stored = self
            .targets
            .iter()
            .map(|target| self.target_health(target, now_ms));
        let unnamed = self
            .missing_since
            .keys()
            .filter(|path| !self.has_target(path.as_path()))
            .map(|path| self.missing_row(path, now_ms));
        stored.chain(unnamed).collect()
    }

    fn has_target(&self, path: &Path) -> bool {
        self.targets
            .iter()
            .any(|target| Path::new(&target.path) == path)
    }

    /// A row for a missing path that no stored target names, such as one whose apply failed.
    fn missing_row(&self, path: &Path, now_ms: u64) -> TargetHealth {
        TargetHealth {
            harness: String::new(),
            kind: String::new(),
            path: path.to_string_lossy().into_owned(),
            state: TargetState::Missing,
            last_repair_ms: self.brake.last_repair(path),
            fights_10m: self.brake.fights(path, now_ms),
            error: self.errors.get(path).cloned(),
        }
    }

    /// One target's health row. A stored Ok or Written entry at a missing path shows as `Missing`.
    /// At a missing path the kept repair error comes before the stored detail.
    fn target_health(&self, target: &SetupTarget, now_ms: u64) -> TargetHealth {
        let path = Path::new(&target.path);
        let missing = self.missing_since.contains_key(path);
        let state = match target.state {
            TargetState::Ok | TargetState::Written if missing => TargetState::Missing,
            other => other,
        };
        let error = if missing {
            self.errors
                .get(path)
                .cloned()
                .or_else(|| target.detail.clone())
        } else {
            match state {
                TargetState::Foreign | TargetState::Refused | TargetState::Error => {
                    target.detail.clone()
                }
                _ => None,
            }
        };
        TargetHealth {
            harness: target.harness.clone(),
            kind: target.kind.clone(),
            path: target.path.clone(),
            state,
            last_repair_ms: self.brake.last_repair(path),
            fights_10m: self.brake.fights(path, now_ms),
            error,
        }
    }
}

/// The observation before anything has been seen.
fn unobserved() -> Observation {
    Observation {
        consent: ConsentView {
            state: ConsentState::None,
            locations: BTreeSet::new(),
        },
        cli: None,
        cli_found: false,
        cli_missing: None,
        version_mismatch: false,
        missing: Vec::new(),
    }
}

#[cfg(test)]
mod tests;
