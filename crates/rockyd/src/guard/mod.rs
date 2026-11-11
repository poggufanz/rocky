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
            self.targets
                .iter()
                .map(|target| self.target_health(target, now_ms))
                .collect()
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

    fn missing_repairable(&self, now_ms: u64) -> bool {
        self.missing_since
            .keys()
            .any(|path| self.brake.may_repair(path, now_ms))
    }

    /// Judges attempts made before this observation. Returns gap effects for restored hooks.
    fn judge_pending(&mut self, missing: &BTreeSet<PathBuf>) -> Vec<Effect> {
        let mut effects = Vec::new();
        for (path, finish_ms) in std::mem::take(&mut self.pending) {
            if missing.contains(&path) {
                self.brake.failed(&path, finish_ms);
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

    /// One target's health row. A stored entry at a missing path shows as `Missing`.
    fn target_health(&self, target: &SetupTarget, now_ms: u64) -> TargetHealth {
        let path = Path::new(&target.path);
        let missing = self.missing_since.contains_key(path);
        let state = match target.state {
            TargetState::Ok | TargetState::Written if missing => TargetState::Missing,
            other => other,
        };
        let error = match state {
            TargetState::Foreign | TargetState::Refused | TargetState::Error => {
                target.detail.clone()
            }
            _ if missing => self.errors.get(path).cloned(),
            _ => None,
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
mod tests {
    use super::*;

    const CFG: &str = "/home/u/.claude/settings.json";
    const OTHER: &str = "/home/u/.codex/config.toml";

    fn consent(state: ConsentState) -> ConsentView {
        ConsentView {
            state,
            locations: BTreeSet::new(),
        }
    }

    fn cli(node: &str) -> CliRecord {
        CliRecord {
            node: PathBuf::from(node),
            entry: PathBuf::from("/n/rocky.js"),
            version: "1.0.0".to_string(),
        }
    }

    /// Consent approved, the CLI found, and the given missing config paths.
    fn approved(missing: &[&str]) -> Observation {
        Observation {
            consent: consent(ConsentState::Approved),
            cli: Some(cli("/n/node")),
            cli_found: true,
            cli_missing: None,
            version_mismatch: false,
            missing: missing.iter().map(|p| PathBuf::from(*p)).collect(),
        }
    }

    fn target(kind: &str, path: &str, state: TargetState, detail: Option<&str>) -> SetupTarget {
        SetupTarget {
            harness: "codex".to_string(),
            kind: kind.to_string(),
            path: path.to_string(),
            state,
            detail: detail.map(str::to_string),
        }
    }

    fn applied(targets: Vec<SetupTarget>) -> Result<AutoResult, RunError> {
        Ok(AutoResult {
            consent: ConsentState::Approved,
            targets,
            notes: Vec::new(),
            repo: None,
        })
    }

    #[test]
    fn startup_apply_runs_once_when_approved() {
        let detect = GuardConsts::default().detect_every_ms;
        let mut guard = Guard::new(GuardConsts::default(), 0);
        guard.observe(approved(&[]), 0);
        assert_eq!(guard.next_job(0), Some(Job::Apply));
        assert!(guard.finish(&Job::Apply, applied(Vec::new()), 5).is_empty());
        assert_eq!(guard.next_job(5), None);
        assert_eq!(guard.next_job(5 + detect - 1), None);
        assert_eq!(guard.next_job(5 + detect), Some(Job::Apply));
    }

    #[test]
    fn failed_apply_waits_for_the_next_detection() {
        let mut guard = Guard::new(GuardConsts::default(), 0);
        guard.observe(approved(&[]), 0);
        assert_eq!(guard.next_job(0), Some(Job::Apply));
        guard.finish(&Job::Apply, Err(RunError::Timeout), 5);
        assert_eq!(guard.next_job(6), None);
    }

    #[test]
    fn no_apply_without_approved_consent() {
        for state in [
            ConsentState::None,
            ConsentState::Later,
            ConsentState::Removed,
            ConsentState::Invalid,
        ] {
            let mut guard = Guard::new(GuardConsts::default(), 0);
            let mut obs = approved(&[CFG]);
            obs.consent = consent(state);
            guard.observe(obs, 10);
            assert_eq!(guard.next_job(10), None, "consent {state:?}");
        }
    }

    #[test]
    fn no_apply_while_cli_is_missing() {
        let mut guard = Guard::new(GuardConsts::default(), 0);
        let mut obs = approved(&[CFG]);
        obs.cli = None;
        obs.cli_found = false;
        obs.cli_missing = Some("/n/node".to_string());
        guard.observe(obs, 10);
        assert_eq!(guard.next_job(10), None);
        assert_eq!(guard.health(10).cli_missing.as_deref(), Some("/n/node"));
    }

    #[test]
    fn missing_path_triggers_apply_and_restore_records_gap() {
        let mut guard = Guard::new(GuardConsts::default(), 0);
        assert!(guard.observe(approved(&[CFG]), 10).is_empty());
        assert_eq!(guard.next_job(10), Some(Job::Apply));
        let hooks = vec![target("desk-hooks", CFG, TargetState::Ok, None)];
        guard.finish(&Job::Apply, applied(hooks), 20);
        let effects = guard.observe(approved(&[]), 21);
        let expected = Gap {
            from_ms: 10,
            to_ms: 20,
            count: 0,
            reason: GapReason::HooksRestored,
        };
        assert_eq!(effects, vec![Effect::Gap(expected)]);
        assert_eq!(guard.health(21).targets[0].last_repair_ms, Some(20));
    }

    #[test]
    fn restore_of_mcp_target_records_no_gap() {
        let mut guard = Guard::new(GuardConsts::default(), 0);
        guard.observe(approved(&[CFG]), 10);
        assert_eq!(guard.next_job(10), Some(Job::Apply));
        let mcp = vec![target("mcp", CFG, TargetState::Ok, None)];
        guard.finish(&Job::Apply, applied(mcp), 20);
        assert!(guard.observe(approved(&[]), 21).is_empty());
    }

    #[test]
    fn fight_brake_limits_repairs_after_six_quick_losses() {
        let mut guard = Guard::new(GuardConsts::default(), 0);
        let hooks = vec![target("desk-hooks", CFG, TargetState::Ok, None)];
        let mut now = 0;
        guard.observe(approved(&[CFG]), now);
        for _ in 0..6 {
            assert_eq!(guard.next_job(now), Some(Job::Apply));
            now += 1_000;
            guard.finish(&Job::Apply, applied(hooks.clone()), now);
            now += 1_000;
            guard.observe(approved(&[]), now);
            now += 1_000;
            guard.observe(approved(&[CFG]), now);
        }
        assert_eq!(guard.health(now).targets[0].fights_10m, 6);
        assert_eq!(guard.next_job(now), None);
        let last_attempt = now - 2_000;
        guard.observe(approved(&[]), now + 500);
        guard.observe(approved(&[CFG]), now + 1_000);
        now += 1_000;
        assert_eq!(guard.next_job(now), None);
        assert_eq!(guard.next_job(last_attempt + 59_999), None);
        assert_eq!(guard.next_job(last_attempt + 60_000), Some(Job::Apply));
    }

    #[test]
    fn slow_losses_are_not_fights() {
        let mut guard = Guard::new(GuardConsts::default(), 0);
        let hooks = vec![target("desk-hooks", CFG, TargetState::Ok, None)];
        let mut now = 0;
        guard.observe(approved(&[CFG]), now);
        for _ in 0..3 {
            assert_eq!(guard.next_job(now), Some(Job::Apply));
            now += 1_000;
            guard.finish(&Job::Apply, applied(hooks.clone()), now);
            now += 1_000;
            guard.observe(approved(&[]), now);
            now += 35_000;
            guard.observe(approved(&[CFG]), now);
        }
        assert_eq!(guard.health(now).targets[0].fights_10m, 0);
    }

    #[test]
    fn failed_repair_waits_for_throttle_and_reports_error() {
        let mut guard = Guard::new(GuardConsts::default(), 0);
        guard.observe(approved(&[CFG]), 0);
        assert_eq!(guard.next_job(0), Some(Job::Apply));
        let hooks = vec![target(
            "desk-hooks",
            CFG,
            TargetState::Ok,
            Some("hooks were not written"),
        )];
        guard.finish(&Job::Apply, applied(hooks), 10);
        guard.observe(approved(&[CFG]), 11);
        assert_eq!(guard.next_job(11), None);
        assert_eq!(guard.next_job(60_009), None);
        assert_eq!(guard.next_job(60_010), Some(Job::Apply));
        let health = guard.health(11);
        assert_eq!(health.targets[0].state, TargetState::Missing);
        assert_eq!(
            health.targets[0].error.as_deref(),
            Some("hooks were not written")
        );
    }

    #[test]
    fn timed_out_repair_waits_for_throttle_and_reports_error() {
        let mut guard = Guard::new(GuardConsts::default(), 0);
        guard.observe(approved(&[CFG]), 0);
        assert_eq!(guard.next_job(0), Some(Job::Apply));
        let hooks = vec![target("desk-hooks", CFG, TargetState::Ok, None)];
        guard.finish(&Job::Apply, applied(hooks), 10);
        guard.observe(approved(&[]), 11);
        guard.observe(approved(&[CFG]), 12);
        assert_eq!(guard.next_job(12), Some(Job::Apply));
        guard.finish(&Job::Apply, Err(RunError::Timeout), 13);
        guard.observe(approved(&[CFG]), 14);
        assert_eq!(guard.next_job(14), None);
        assert_eq!(guard.next_job(13 + 59_999), None);
        assert_eq!(guard.next_job(13 + 60_000), Some(Job::Apply));
        let health = guard.health(14);
        assert_eq!(health.targets[0].state, TargetState::Missing);
        let timeout = RunError::Timeout.to_string();
        assert_eq!(health.targets[0].error.as_deref(), Some(timeout.as_str()));
    }

    #[test]
    fn changed_target_retries_with_backoff() {
        let mut guard = Guard::new(GuardConsts::default(), 0);
        guard.observe(approved(&[]), 0);
        assert_eq!(guard.next_job(0), Some(Job::Apply));
        let changed = vec![target("mcp", OTHER, TargetState::Changed, None)];
        guard.finish(&Job::Apply, applied(changed.clone()), 100);
        assert_eq!(guard.next_job(2_099), None);
        assert_eq!(guard.next_job(2_100), Some(Job::Apply));
        guard.finish(&Job::Apply, applied(changed.clone()), 2_200);
        assert_eq!(guard.next_job(6_199), None);
        assert_eq!(guard.next_job(6_200), Some(Job::Apply));
        guard.finish(&Job::Apply, applied(changed.clone()), 6_300);
        assert_eq!(guard.next_job(14_299), None);
        assert_eq!(guard.next_job(14_300), Some(Job::Apply));
        guard.finish(&Job::Apply, applied(Vec::new()), 14_400);
        assert_eq!(guard.next_job(16_400), None);
        let mut newer = approved(&[]);
        newer.cli = Some(cli("/n/node-2"));
        guard.observe(newer, 14_500);
        assert_eq!(guard.next_job(14_500), Some(Job::Apply));
        guard.finish(&Job::Apply, applied(changed), 14_600);
        assert_eq!(guard.next_job(16_599), None);
        assert_eq!(guard.next_job(16_600), Some(Job::Apply));
    }

    #[test]
    fn cli_change_triggers_apply() {
        let mut guard = Guard::new(GuardConsts::default(), 0);
        guard.observe(approved(&[]), 0);
        assert_eq!(guard.next_job(0), Some(Job::Apply));
        guard.finish(&Job::Apply, applied(Vec::new()), 5);
        assert_eq!(guard.next_job(6), None);
        let mut moved = approved(&[]);
        moved.cli = Some(cli("/opt/node"));
        guard.observe(moved, 7);
        assert_eq!(guard.next_job(7), Some(Job::Apply));
    }

    #[test]
    fn next_job_is_none_while_a_job_runs() {
        let mut guard = Guard::new(GuardConsts::default(), 0);
        guard.observe(approved(&[CFG]), 0);
        assert_eq!(guard.next_job(0), Some(Job::Apply));
        guard.observe(approved(&[CFG]), 1);
        assert_eq!(guard.next_job(1), None);
        guard.observe(approved(&[]), 2);
        guard.observe(approved(&[CFG]), 3);
        assert_eq!(guard.next_job(3), None);
    }

    #[test]
    fn version_mismatch_and_consent_pass_through_to_health() {
        let mut guard = Guard::new(GuardConsts::default(), 0);
        let mut obs = approved(&[CFG]);
        obs.version_mismatch = true;
        obs.consent = consent(ConsentState::Later);
        guard.observe(obs, 0);
        let health = guard.health(0);
        assert_eq!(health.consent_state, ConsentState::Later);
        assert!(health.version_mismatch);
        assert!(health.targets.is_empty());

        let mut approved_obs = approved(&[]);
        approved_obs.version_mismatch = true;
        guard.observe(approved_obs, 1);
        assert!(guard.health(1).version_mismatch);
        assert_eq!(guard.health(1).consent_state, ConsentState::Approved);
    }

    #[test]
    fn cli_reflects_the_last_observation() {
        let mut guard = Guard::new(GuardConsts::default(), 0);
        assert_eq!(guard.cli(), None);
        guard.observe(approved(&[]), 1);
        assert_eq!(guard.cli(), Some(&cli("/n/node")));
        let mut gone = approved(&[]);
        gone.cli = None;
        guard.observe(gone, 2);
        assert_eq!(guard.cli(), None);
    }

    #[test]
    fn job_args_follow_the_node_grammar() {
        assert_eq!(Job::Apply.args(), vec!["apply"]);
        let config_dir = Job::ConfigDir {
            harness: "codex".into(),
            location: "/x/.codex".into(),
        };
        assert_eq!(config_dir.args(), vec!["config-dir", "codex", "/x/.codex"]);
        let status = Job::RepoStatus { root: "/r".into() };
        assert_eq!(status.args(), vec!["repo", "status", "/r"]);
        let setup = |action| {
            Job::Setup {
                token: 1,
                id: 2,
                action,
            }
            .args()
        };
        assert_eq!(setup(SetupAction::Plan), vec!["plan"]);
        assert_eq!(setup(SetupAction::Apply), vec!["apply"]);
        assert_eq!(setup(SetupAction::Remove), vec!["remove"]);
        assert_eq!(
            setup(SetupAction::ConsentApprove),
            vec!["consent", "approve"]
        );
        assert_eq!(setup(SetupAction::ConsentLater), vec!["consent", "later"]);
        let on = SetupAction::HarnessOn {
            harness: "codex".into(),
        };
        assert_eq!(setup(on), vec!["harness", "codex", "on"]);
        let off = SetupAction::HarnessOff {
            harness: "codex".into(),
        };
        assert_eq!(setup(off), vec!["harness", "codex", "off"]);
        let decide = |allow| {
            Job::RepoDecision {
                token: 1,
                id: 2,
                root: "/r".into(),
                allow,
            }
            .args()
        };
        assert_eq!(decide(true), vec!["repo", "allow", "/r"]);
        assert_eq!(decide(false), vec!["repo", "decline", "/r"]);
    }
}
