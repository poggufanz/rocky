use rocky_proto::pipe::PendingRepo;

use super::node::{RepoDecisionState, RepoVerdict};
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
fn no_apply_or_config_dir_without_approved_consent() {
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
        guard.discovered("codex", "/x/.codex");
        guard.discovered("codex", "/y/.codex");
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

#[test]
fn ok_apply_is_not_repeated_before_observation() {
    let mut guard = Guard::new(GuardConsts::default(), 0);
    guard.observe(approved(&[CFG]), 0);
    assert_eq!(guard.next_job(0), Some(Job::Apply));
    let unwritable = vec![target("desk-hooks", CFG, TargetState::Error, None)];
    guard.finish(&Job::Apply, applied(unwritable), 10);
    assert_eq!(guard.next_job(11), None);
    guard.observe(approved(&[CFG]), 11);
    assert_eq!(guard.next_job(60_009), None);
    assert_eq!(guard.next_job(60_010), Some(Job::Apply));
}

#[test]
fn first_failed_apply_names_path_and_error() {
    let mut guard = Guard::new(GuardConsts::default(), 0);
    guard.observe(approved(&[CFG]), 0);
    assert_eq!(guard.next_job(0), Some(Job::Apply));
    guard.finish(&Job::Apply, Err(RunError::Timeout), 10);
    guard.observe(approved(&[CFG]), 11);
    let health = guard.health(11);
    assert_eq!(health.targets.len(), 1);
    assert_eq!(health.targets[0].path, CFG);
    assert_eq!(health.targets[0].state, TargetState::Missing);
    let timeout = RunError::Timeout.to_string();
    assert_eq!(health.targets[0].error.as_deref(), Some(timeout.as_str()));
}

#[test]
fn ok_apply_without_detail_reports_still_missing() {
    let mut guard = Guard::new(GuardConsts::default(), 0);
    guard.observe(approved(&[CFG]), 0);
    assert_eq!(guard.next_job(0), Some(Job::Apply));
    guard.finish(&Job::Apply, applied(Vec::new()), 10);
    guard.observe(approved(&[CFG]), 11);
    let health = guard.health(11);
    assert_eq!(health.targets.len(), 1);
    assert_eq!(health.targets[0].path, CFG);
    assert_eq!(health.targets[0].state, TargetState::Missing);
    assert_eq!(
        health.targets[0].error.as_deref(),
        Some("still missing after setup ran")
    );
}

#[test]
fn ok_target_without_detail_reports_still_missing() {
    let mut guard = Guard::new(GuardConsts::default(), 0);
    guard.observe(approved(&[CFG]), 0);
    assert_eq!(guard.next_job(0), Some(Job::Apply));
    let hooks = vec![target("desk-hooks", CFG, TargetState::Ok, None)];
    guard.finish(&Job::Apply, applied(hooks), 10);
    guard.observe(approved(&[CFG]), 11);
    let health = guard.health(11);
    assert_eq!(health.targets.len(), 1);
    assert_eq!(
        health.targets[0].error.as_deref(),
        Some("still missing after setup ran")
    );
}

#[test]
fn stored_error_target_without_detail_reports_still_missing() {
    let mut guard = Guard::new(GuardConsts::default(), 0);
    guard.observe(approved(&[CFG]), 0);
    assert_eq!(guard.next_job(0), Some(Job::Apply));
    let unwritable = vec![target("desk-hooks", CFG, TargetState::Error, None)];
    guard.finish(&Job::Apply, applied(unwritable), 10);
    guard.observe(approved(&[CFG]), 11);
    let health = guard.health(11);
    assert_eq!(health.targets.len(), 1);
    assert_eq!(health.targets[0].path, CFG);
    assert_eq!(
        health.targets[0].error.as_deref(),
        Some("still missing after setup ran")
    );
}

#[test]
fn later_timeout_error_wins_over_older_stored_detail() {
    let mut guard = Guard::new(GuardConsts::default(), 0);
    guard.observe(approved(&[CFG]), 0);
    assert_eq!(guard.next_job(0), Some(Job::Apply));
    let stale = vec![target(
        "desk-hooks",
        CFG,
        TargetState::Error,
        Some("old detail"),
    )];
    guard.finish(&Job::Apply, applied(stale), 10);
    guard.observe(approved(&[CFG]), 11);
    assert_eq!(guard.next_job(11), None);
    assert_eq!(guard.next_job(60_010), Some(Job::Apply));
    guard.finish(&Job::Apply, Err(RunError::Timeout), 60_011);
    guard.observe(approved(&[CFG]), 60_012);
    let health = guard.health(60_012);
    let timeout = RunError::Timeout.to_string();
    assert_eq!(health.targets[0].error.as_deref(), Some(timeout.as_str()));
}

#[test]
fn repaired_path_drops_its_kept_error() {
    let mut guard = Guard::new(GuardConsts::default(), 0);
    guard.observe(approved(&[CFG]), 0);
    assert_eq!(guard.next_job(0), Some(Job::Apply));
    let hooks = vec![target("desk-hooks", CFG, TargetState::Ok, None)];
    guard.finish(&Job::Apply, applied(hooks), 10);
    guard.observe(approved(&[CFG]), 11);
    assert_eq!(guard.next_job(60_010), Some(Job::Apply));
    guard.finish(&Job::Apply, Err(RunError::Timeout), 60_011);
    guard.observe(approved(&[]), 60_012);
    assert_eq!(guard.health(60_012).targets[0].error, None);
    guard.observe(approved(&[CFG]), 60_013);
    assert_eq!(guard.health(60_013).targets[0].error, None);
}

/// A `Job::ConfigDir` for one harness and location.
fn config_job(harness: &str, location: &str) -> Job {
    Job::ConfigDir {
        harness: harness.to_string(),
        location: location.to_string(),
    }
}

fn verdict(key: &str, main: &str, decision: RepoDecisionState) -> RepoVerdict {
    RepoVerdict {
        key: key.to_string(),
        main: main.to_string(),
        decision,
    }
}

fn pending_repo(key: &str, main: &str, name: &str) -> PendingRepo {
    PendingRepo {
        key: key.to_string(),
        main: main.to_string(),
        name: name.to_string(),
    }
}

/// A Node result that carries a repo verdict and nothing else.
fn with_repo(verdict: RepoVerdict) -> Result<AutoResult, RunError> {
    Ok(AutoResult {
        consent: ConsentState::Approved,
        targets: Vec::new(),
        notes: Vec::new(),
        repo: Some(verdict),
    })
}

/// A Node result with the given targets and notes.
fn result_with(targets: Vec<SetupTarget>, notes: &[&str]) -> Result<AutoResult, RunError> {
    Ok(AutoResult {
        consent: ConsentState::Approved,
        targets,
        notes: notes.iter().map(|note| note.to_string()).collect(),
        repo: None,
    })
}

/// A guard whose startup apply has run, so only jobs queued later are left.
fn settled(obs: Observation) -> Guard {
    let mut guard = Guard::new(GuardConsts::default(), 0);
    guard.observe(obs, 0);
    assert_eq!(guard.next_job(0), Some(Job::Apply));
    guard.finish(&Job::Apply, applied(Vec::new()), 0);
    guard
}

/// Hands out every job due now, finishing each with an empty result.
fn drain(guard: &mut Guard, now_ms: u64) -> Vec<Job> {
    let mut jobs = Vec::new();
    while let Some(job) = guard.next_job(now_ms) {
        guard.finish(&job, applied(Vec::new()), now_ms);
        jobs.push(job);
    }
    jobs
}

#[test]
fn discovered_location_queues_once() {
    let mut guard = settled(approved(&[]));
    for _ in 0..50 {
        guard.discovered("codex", "/x/.codex");
    }
    let job = config_job("codex", "/x/.codex");
    assert_eq!(guard.next_job(0), Some(job.clone()));
    assert!(guard.finish(&job, applied(Vec::new()), 1).is_empty());
    assert_eq!(guard.next_job(1), None);
}

#[test]
fn discovered_pair_already_recorded_queues_nothing() {
    let mut obs = approved(&[]);
    obs.consent
        .locations
        .insert(("codex".to_string(), "/x/.codex".to_string()));
    let mut guard = settled(obs);
    guard.discovered("codex", "/x/.codex");
    assert_eq!(guard.next_job(0), None);
}

#[test]
fn discovery_ignores_empty_harness_or_location() {
    let mut guard = settled(approved(&[]));
    guard.discovered("", "/x/.codex");
    guard.discovered("codex", "");
    assert_eq!(guard.next_job(0), None);
}

#[test]
fn discovery_stops_at_the_seen_cap() {
    let consts = GuardConsts {
        seen_cap: 2,
        ..GuardConsts::default()
    };
    let mut guard = Guard::new(consts, 0);
    guard.observe(approved(&[]), 0);
    assert_eq!(guard.next_job(0), Some(Job::Apply));
    guard.finish(&Job::Apply, applied(Vec::new()), 0);
    for location in ["/a", "/b", "/c"] {
        guard.discovered("codex", location);
    }
    assert_eq!(drain(&mut guard, 0).len(), 2);
}

#[test]
fn queued_config_dir_waits_for_approved_consent() {
    let mut guard = settled(approved(&[]));
    guard.discovered("codex", "/x/.codex");
    let mut later = approved(&[]);
    later.consent = consent(ConsentState::Later);
    guard.observe(later, 1);
    assert_eq!(guard.next_job(1), None);
    guard.observe(approved(&[]), 2);
    assert_eq!(guard.next_job(2), Some(config_job("codex", "/x/.codex")));
}

#[test]
fn undecided_repo_becomes_pending_once_per_main() {
    let mut guard = settled(approved(&[]));
    guard.session_root("/w/a");
    guard.session_root("/w/b");
    let undecided = RepoDecisionState::Undecided;
    let first = guard.next_job(0).expect("first root");
    let effects = guard.finish(&first, with_repo(verdict("k1", "/code/repo", undecided)), 1);
    assert_eq!(effects, vec![Effect::PendingChanged]);
    let second = guard.next_job(1).expect("second root");
    let effects = guard.finish(
        &second,
        with_repo(verdict("k2", "/code/repo", undecided)),
        2,
    );
    assert!(effects.is_empty());
    assert_eq!(
        guard.pending(),
        vec![pending_repo("k1", "/code/repo", "repo")]
    );
}

#[test]
fn pending_is_ordered_by_main_and_names_last_segment() {
    let mut guard = settled(approved(&[]));
    guard.session_root("/w/1");
    guard.session_root("/w/2");
    let undecided = RepoDecisionState::Undecided;
    let first = guard.next_job(0).expect("first root");
    guard.finish(
        &first,
        with_repo(verdict("k2", "C:\\a\\beta", undecided)),
        1,
    );
    let second = guard.next_job(1).expect("second root");
    guard.finish(&second, with_repo(verdict("k1", "/b/alpha/", undecided)), 2);
    assert_eq!(
        guard.pending(),
        vec![
            pending_repo("k1", "/b/alpha/", "alpha"),
            pending_repo("k2", "C:\\a\\beta", "beta"),
        ]
    );
}

#[test]
fn session_root_queues_each_root_once() {
    let mut guard = settled(approved(&[]));
    guard.session_root("/r");
    guard.session_root("/r");
    let status = Job::RepoStatus {
        root: "/r".to_string(),
    };
    assert_eq!(drain(&mut guard, 0), vec![status]);
    guard.session_root("/r");
    assert_eq!(guard.next_job(0), None);
}

#[test]
fn failed_repo_status_is_not_retried() {
    let mut guard = settled(approved(&[]));
    guard.session_root("/r");
    let job = guard.next_job(0).expect("status job");
    assert!(guard.finish(&job, Err(RunError::Timeout), 1).is_empty());
    guard.session_root("/r");
    assert_eq!(guard.next_job(1), None);
    assert!(guard.pending().is_empty());
}

#[test]
fn repo_decision_clears_pending_and_acks() {
    let mut guard = settled(approved(&[]));
    guard.session_root("/w/a");
    let status = guard.next_job(0).expect("status job");
    let undecided = verdict("k1", "/code/repo", RepoDecisionState::Undecided);
    guard.finish(&status, with_repo(undecided), 1);
    guard.repo_request(7, 42, "/w/a".to_string(), true);
    let decide = guard.next_job(1).expect("decision job");
    let request = Job::RepoDecision {
        token: 7,
        id: 42,
        root: "/w/a".to_string(),
        allow: true,
    };
    assert_eq!(decide, request);
    let allowed = verdict("k1", "/code/repo", RepoDecisionState::Allowed);
    let effects = guard.finish(&decide, with_repo(allowed), 2);
    let ack = ServerMsg::Ack {
        id: 42,
        ok: true,
        error: None,
    };
    assert_eq!(
        effects,
        vec![Effect::PendingChanged, Effect::Reply { token: 7, msg: ack }]
    );
    assert!(guard.pending().is_empty());
    let cached = ("/code/repo".to_string(), RepoDecisionState::Allowed);
    assert_eq!(guard.root_verdicts.get("/w/a"), Some(&cached));
}

#[test]
fn repo_decision_failure_acks_with_the_error() {
    let mut guard = settled(approved(&[]));
    guard.repo_request(7, 42, "/w/a".to_string(), false);
    let job = guard.next_job(0).expect("decision job");
    let effects = guard.finish(&job, Err(RunError::NoCli), 1);
    let msg = ServerMsg::Ack {
        id: 42,
        ok: false,
        error: Some(RunError::NoCli.to_string()),
    };
    assert_eq!(effects, vec![Effect::Reply { token: 7, msg }]);
}

#[test]
fn plan_request_replies_consent_plan_without_touching_health() {
    let stored = vec![target("mcp", OTHER, TargetState::Ok, None)];
    let mut guard = Guard::new(GuardConsts::default(), 0);
    guard.observe(approved(&[]), 0);
    assert_eq!(guard.next_job(0), Some(Job::Apply));
    guard.finish(&Job::Apply, applied(stored), 0);
    assert!(guard.setup_request(3, 5, SetupAction::Plan).is_none());
    let job = guard.next_job(0).expect("plan job");
    let planned = vec![target("desk-hooks", CFG, TargetState::Missing, None)];
    let effects = guard.finish(&job, applied(planned.clone()), 1);
    let msg = ServerMsg::ConsentPlan {
        id: 5,
        consent: ConsentState::Approved,
        targets: planned,
    };
    assert_eq!(effects, vec![Effect::Reply { token: 3, msg }]);
    let health = guard.health(1).targets;
    assert_eq!(health.len(), 1);
    assert_eq!(health[0].path, OTHER);
}

#[test]
fn unknown_harness_is_refused_without_node() {
    let mut guard = settled(approved(&[]));
    let cursor = SetupAction::HarnessOn {
        harness: "cursor".to_string(),
    };
    let refused = guard.setup_request(3, 9, cursor);
    let msg = ServerMsg::Ack {
        id: 9,
        ok: false,
        error: Some("unknown harness cursor".to_string()),
    };
    assert_eq!(refused, Some(Effect::Reply { token: 3, msg }));
    assert_eq!(guard.next_job(0), None);
    let codex = SetupAction::HarnessOff {
        harness: "codex".to_string(),
    };
    assert!(guard.setup_request(4, 10, codex.clone()).is_none());
    let queued = Job::Setup {
        token: 4,
        id: 10,
        action: codex,
    };
    assert_eq!(guard.next_job(0), Some(queued));
}

#[test]
fn client_requests_jump_the_queue() {
    let mut guard = Guard::new(GuardConsts::default(), 0);
    guard.observe(approved(&[CFG]), 0);
    guard.session_root("/r");
    assert!(guard.setup_request(1, 2, SetupAction::Apply).is_none());
    let request = Job::Setup {
        token: 1,
        id: 2,
        action: SetupAction::Apply,
    };
    assert_eq!(guard.next_job(0), Some(request));
}

#[test]
fn next_job_order_is_request_apply_config_dir_repo() {
    let mut guard = Guard::new(GuardConsts::default(), 0);
    guard.observe(approved(&[]), 0);
    guard.discovered("codex", "/x/.codex");
    guard.session_root("/r");
    guard.repo_request(1, 2, "/r".to_string(), true);
    let decide = Job::RepoDecision {
        token: 1,
        id: 2,
        root: "/r".to_string(),
        allow: true,
    };
    let status = Job::RepoStatus {
        root: "/r".to_string(),
    };
    let order = drain(&mut guard, 0);
    assert_eq!(
        order,
        vec![decide, Job::Apply, config_job("codex", "/x/.codex"), status]
    );
}

#[test]
fn finish_for_a_job_not_in_flight_is_ignored() {
    let mut guard = Guard::new(GuardConsts::default(), 0);
    guard.observe(approved(&[]), 0);
    assert_eq!(guard.next_job(0), Some(Job::Apply));
    guard.session_root("/r");
    let stray = Job::RepoStatus {
        root: "/r".to_string(),
    };
    let undecided = verdict("k1", "/code/repo", RepoDecisionState::Undecided);
    assert!(guard.finish(&stray, with_repo(undecided), 1).is_empty());
    assert!(guard.pending().is_empty());
    assert_eq!(guard.next_job(1), None, "the apply is still out");
    guard.finish(&Job::Apply, applied(Vec::new()), 2);
    assert_eq!(guard.next_job(2), Some(stray));
}

#[test]
fn no_cli_finishes_each_request_kind_with_its_error() {
    let mut guard = settled(approved(&[]));
    guard.setup_request(1, 2, SetupAction::Apply);
    guard.repo_request(3, 4, "/w/a".to_string(), true);
    guard.session_root("/w/a");
    guard.discovered("codex", "/x/.codex");
    let no_cli = RunError::NoCli.to_string();

    let setup = guard.next_job(0).expect("setup job");
    let msg = ServerMsg::Ack {
        id: 2,
        ok: false,
        error: Some(no_cli.clone()),
    };
    let effects = guard.finish(&setup, Err(RunError::NoCli), 0);
    assert_eq!(effects, vec![Effect::Reply { token: 1, msg }]);

    let decide = guard.next_job(0).expect("decision job");
    let msg = ServerMsg::Ack {
        id: 4,
        ok: false,
        error: Some(no_cli.clone()),
    };
    let effects = guard.finish(&decide, Err(RunError::NoCli), 0);
    assert_eq!(effects, vec![Effect::Reply { token: 3, msg }]);

    let config = guard.next_job(0).expect("config dir job");
    let effects = guard.finish(&config, Err(RunError::NoCli), 0);
    assert_eq!(
        effects,
        vec![Effect::Log(format!("config dir codex: {no_cli}"))]
    );

    let status = guard.next_job(0).expect("status job");
    assert!(guard.finish(&status, Err(RunError::NoCli), 0).is_empty());
    guard.session_root("/w/a");
    assert_eq!(guard.next_job(0), None);
}

#[test]
fn config_dir_result_logs_notes_and_replaces_targets() {
    let mut guard = settled(approved(&[]));
    guard.discovered("codex", "/x/.codex");
    let job = guard.next_job(0).expect("config dir job");
    let hooks = vec![target("desk-hooks", CFG, TargetState::Ok, None)];
    let notes = ["bad location", "harness not detected: codex"];
    let effects = guard.finish(&job, result_with(hooks, &notes), 1);
    assert_eq!(
        effects,
        vec![Effect::Log(
            "config dir codex: bad location; harness not detected: codex".to_string()
        )]
    );
    assert_eq!(guard.health(1).targets[0].path, CFG);

    guard.discovered("opencode", "/y/.opencode");
    let job = guard.next_job(1).expect("second config dir job");
    let effects = guard.finish(&job, Err(RunError::Timeout), 2);
    let timeout = RunError::Timeout.to_string();
    assert_eq!(
        effects,
        vec![Effect::Log(format!("config dir opencode: {timeout}"))]
    );
}
