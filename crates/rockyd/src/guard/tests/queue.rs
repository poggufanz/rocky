use rocky_proto::pipe::{
    ConsentState, PendingRepo, ServerMsg, SetupAction, SetupTarget, TargetState,
};

use super::super::node::{AutoResult, RepoDecisionState, RepoVerdict, RunError};
use super::super::{Effect, Guard, GuardConsts, Job, Observation};
use super::{CFG, OTHER, applied, approved, consent, target};

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
