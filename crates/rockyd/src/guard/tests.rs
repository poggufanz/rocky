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
