use super::*;
use crate::i18n::SetupMsg;
use rocky_proto::pipe::{TargetHealth, WorktreeEntry};

fn plan_target(harness: &str, state: TargetState) -> SetupTarget {
    SetupTarget {
        harness: harness.into(),
        kind: "mcp".into(),
        path: format!("C:/h/{harness}.json"),
        state,
        detail: None,
    }
}

fn live(harness: &str, state: TargetState, repaired: Option<u64>) -> TargetHealth {
    TargetHealth {
        harness: harness.into(),
        kind: "mcp".into(),
        path: format!("C:/h/{harness}.json"),
        state,
        last_repair_ms: repaired,
        fights_10m: 0,
        error: None,
    }
}

fn setup_with(targets: Vec<TargetHealth>) -> SetupHealth {
    SetupHealth {
        consent_state: ConsentState::Approved,
        targets,
        ..SetupHealth::default()
    }
}

fn hhmm(_: u64) -> String {
    "09:41".to_string()
}

fn setup_msg(m: SetupMsg) -> Msg {
    Msg::Setup(m)
}

#[test]
fn harness_rows_include_switched_off_harnesses() {
    let rows = harness_rows(
        &[plan_target("claude-code", TargetState::Ok)],
        &["codex".to_string()],
        &SetupHealth::default(),
        &hhmm,
    );
    assert_eq!(rows.len(), 2);
    let claude = rows.iter().find(|r| r.harness == "claude-code").unwrap();
    assert!(claude.on);
    assert_eq!(claude.state, setup_msg(SetupMsg::HarnessOk));
    assert_eq!(claude.paths, vec!["C:/h/claude-code.json".to_string()]);
    let codex = rows.iter().find(|r| r.harness == "codex").unwrap();
    assert!(!codex.on);
    assert_eq!(codex.state, setup_msg(SetupMsg::HarnessOff));
}

#[test]
fn harness_state_prefers_live_health() {
    let plan = [plan_target("claude-code", TargetState::Ok)];
    let health = setup_with(vec![live("claude-code", TargetState::Ok, Some(1_000))]);
    let rows = harness_rows(&plan, &[], &health, &hhmm);
    assert_eq!(
        rows[0].state,
        setup_msg(SetupMsg::HarnessRestored {
            time: "09:41".into()
        })
    );
    let mut foreign = live("claude-code", TargetState::Foreign, None);
    foreign.error = None;
    let rows = harness_rows(&plan, &[], &setup_with(vec![foreign]), &hhmm);
    assert_eq!(rows[0].state, setup_msg(SetupMsg::HarnessForeign));
    let mut failed = live("claude-code", TargetState::Error, None);
    failed.error = Some("disk full".into());
    let rows = harness_rows(&plan, &[], &setup_with(vec![failed]), &hhmm);
    assert_eq!(
        rows[0].state,
        setup_msg(SetupMsg::HarnessFailed {
            error: "disk full".into()
        })
    );
    // A harness live health knows nothing about reads from the plan.
    let rows = harness_rows(
        &plan,
        &[],
        &setup_with(vec![live("codex", TargetState::Foreign, None)]),
        &hhmm,
    );
    let claude = rows.iter().find(|r| r.harness == "claude-code").unwrap();
    assert_eq!(claude.state, setup_msg(SetupMsg::HarnessOk));
}

#[test]
fn switch_shows_pending_until_answered() {
    let control = Control::Harness("codex".into());
    let mut requests = Requests::default();
    assert!(!control.busy(&requests));
    requests.start(RequestKind::HarnessOff("codex".into()), 1, 0);
    assert!(control.busy(&requests));
    assert!(!Control::Harness("gemini-cli".into()).busy(&requests));
    // The answer leaves the control and asks for a fresh plan.
    let (kind, outcome) = requests
        .on_message(&ServerMsg::Ack {
            id: 1,
            ok: true,
            error: None,
            cleanup_errors: 0,
        })
        .unwrap();
    let mut model = SetupSettings::default();
    let step = model.route(kind, outcome, "late");
    assert!(!control.busy(&requests));
    assert!(step.send_plan);
    assert_eq!(model.error(&control), None);
    // A lost answer leaves a retryable error on that control only.
    requests.start(RequestKind::HarnessOn("codex".into()), 2, 0);
    let expired = requests.expire(1_000_000);
    let (kind, outcome) = expired.into_iter().next().unwrap();
    let step = model.route(kind, outcome, "Rocky did not answer in time.");
    assert!(step.send_plan);
    assert_eq!(model.error(&control), Some("Rocky did not answer in time."));
    assert_eq!(model.error(&Control::Shell), None);
    model.clear_error(&control);
    assert_eq!(model.error(&control), None);
    assert_eq!(
        SetupSettings::harness_request("codex", true),
        RequestKind::HarnessOff("codex".into())
    );
    assert_eq!(
        SetupSettings::harness_request("codex", false),
        RequestKind::HarnessOn("codex".into())
    );
}

fn repo(main: &str, decision: RepoDecisionState, bytes: u64) -> RepoEntry {
    RepoEntry {
        key: format!("key-{main}"),
        main: main.into(),
        name: main.rsplit('/').next().unwrap().into(),
        decision,
        bytes,
        worktrees: Vec::new(),
    }
}

#[test]
fn repo_rows_merge_pending_and_capture() {
    let repos = [
        repo(
            "C:/work/app",
            RepoDecisionState::Allowed,
            3 * 1_048_576 + 524_288,
        ),
        repo("C:/work/old", RepoDecisionState::Declined, 0),
    ];
    let pending = [
        PendingRepo {
            key: "key-C:/work/app".into(),
            main: "C:/work/app".into(),
            name: "app".into(),
        },
        PendingRepo {
            key: "key-new".into(),
            main: "C:/work/new".into(),
            name: "new".into(),
        },
    ];
    let capture = [CaptureHealth {
        root: if cfg!(windows) {
            "C:\\work\\app"
        } else {
            "C:/work/app"
        }
        .into(),
        state: CaptureState::Ok,
        last_reconcile_ms: None,
        error: None,
    }];
    let rows = repo_rows(&repos, &pending, &capture);
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0].decision, setup_msg(SetupMsg::RepoAllowed));
    assert!(rows[0].allowed);
    assert_eq!(rows[0].size, "3.5 MiB");
    assert_eq!(rows[0].capture, Some(setup_msg(SetupMsg::CaptureOk)));
    assert_eq!(rows[1].decision, setup_msg(SetupMsg::RepoDeclined));
    assert_eq!(rows[1].capture, None);
    assert_eq!(rows[2].main, "C:/work/new");
    assert_eq!(rows[2].decision, setup_msg(SetupMsg::RepoNotAsked));
    assert!(!rows[2].allowed);
    assert_eq!(format_mib(0), "0.0 MiB");
}

#[test]
fn missing_worktree_offers_delete() {
    let mut entry = repo("C:/work/app", RepoDecisionState::Allowed, 1_048_576);
    entry.worktrees = vec![
        WorktreeEntry {
            root: "C:/work/app-wt".into(),
            bytes: 2_097_152,
            exists: true,
        },
        WorktreeEntry {
            root: "C:/work/gone".into(),
            bytes: 524_288,
            exists: false,
        },
    ];
    let rows = repo_rows(&[entry], &[], &[]);
    let wts = &rows[0].worktrees;
    assert!(!wts[0].missing);
    assert_eq!(wts[0].size, "2.0 MiB");
    assert!(wts[1].missing);
    assert_eq!(wts[1].size, "0.5 MiB");
    assert!(!wts[0].offers_delete());
    assert!(wts[1].offers_delete());
    // The delete step belongs to the worktree's own root.
    let mut model = SetupSettings::default();
    model.ask_purge("C:/work/gone");
    assert_eq!(model.purge_asked(), Some("C:/work/gone"));
}

#[test]
fn purge_needs_two_steps() {
    let mut model = SetupSettings::default();
    assert!(!model.confirm_purge("C:/work/app"));
    model.ask_purge("C:/work/app");
    assert!(!model.confirm_purge("C:/work/other"));
    assert!(model.confirm_purge("C:/work/app"));
    assert_eq!(model.purge_asked(), None);
    assert!(!model.confirm_purge("C:/work/app"));
    model.ask_purge("C:/work/app");
    model.cancel_purge();
    assert!(!model.confirm_purge("C:/work/app"));
}

#[test]
fn remove_needs_two_steps_and_disables_autostart_first() {
    let mut model = SetupSettings::default();
    let mut calls = 0;
    // Without the first step nothing runs.
    assert!(
        model
            .begin_remove(&mut || {
                calls += 1;
                Ok(())
            })
            .is_none()
    );
    assert_eq!(calls, 0);
    assert_eq!(model.remove, RemoveFlow::Idle);
    model.ask_remove();
    assert_eq!(model.remove, RemoveFlow::Confirm);
    let sent = model.begin_remove(&mut || {
        calls += 1;
        Ok(())
    });
    assert_eq!(calls, 1);
    assert!(matches!(sent, Some(None)));
    assert_eq!(model.remove, RemoveFlow::Removing);
    let step = model.route(
        RequestKind::Remove,
        Outcome::Done {
            ok: true,
            error: None,
            cleanup_errors: 0,
        },
        "late",
    );
    assert!(step.show_removed);
}

#[test]
fn remove_keeps_cleanup_errors_while_advancing_to_removed() {
    let mut model = SetupSettings::default();
    model.ask_remove();
    assert!(model.begin_remove(&mut || Ok(())).is_some());
    let step = model.route(
        RequestKind::Remove,
        Outcome::Done {
            ok: true,
            error: None,
            cleanup_errors: 2,
        },
        "late",
    );
    assert!(step.show_removed);
    assert_eq!(model.removed_cleanup_errors(), 2);

    // Retrying or starting a fresh remove clears stale cleanup counts.
    model.ask_remove();
    assert!(model.begin_remove(&mut || Ok(())).is_some());
    assert_eq!(model.removed_cleanup_errors(), 0);
}

#[test]
fn remove_failure_keeps_settings_with_retry() {
    let mut model = SetupSettings::default();
    model.ask_remove();
    let mut calls = 0;
    model.begin_remove(&mut || {
        calls += 1;
        Ok(())
    });
    let step = model.route(
        RequestKind::Remove,
        Outcome::Done {
            ok: false,
            error: Some("node exited 1".into()),
            cleanup_errors: 0,
        },
        "late",
    );
    assert!(!step.show_removed);
    assert_eq!(model.remove, RemoveFlow::Failed("node exited 1".into()));
    // Retry goes straight through and disables autostart again.
    let sent = model.begin_remove(&mut || {
        calls += 1;
        Ok(())
    });
    assert!(sent.is_some());
    assert_eq!(calls, 2);
    assert_eq!(model.remove, RemoveFlow::Removing);
    // A lost answer fails the same way, with the expiry text.
    let step = model.route(
        RequestKind::Remove,
        Outcome::Expired,
        "Rocky did not answer.",
    );
    assert!(!step.show_removed);
    assert_eq!(
        model.remove,
        RemoveFlow::Failed("Rocky did not answer.".into())
    );
    // A failed autostart write is returned for the log, not fatal.
    let sent = model.begin_remove(&mut || Err(io::Error::other("denied")));
    assert!(matches!(sent, Some(Some(_))));
    assert_eq!(model.remove, RemoveFlow::Removing);
    // A request that cannot be sent fails at once.
    model.remove_not_sent("not connected".into());
    assert_eq!(model.remove, RemoveFlow::Failed("not connected".into()));
}

#[test]
fn removed_view_quits_on_close() {
    assert_eq!(close_action(View::Removed), CloseAction::Quit);
    for view in [View::Agents, View::Settings, View::Consent] {
        assert_eq!(close_action(view), CloseAction::Hide);
    }
}

fn row_of(decision: RepoDecisionState) -> RepoRow {
    let entry = repo("C:/work/app", decision, 0);
    repo_rows(&[entry], &[], &[]).remove(0)
}

#[test]
fn revoke_is_enabled_only_for_an_allowed_repo() {
    let allowed = row_of(RepoDecisionState::Allowed).buttons();
    assert!(!allowed.allow_enabled);
    assert_eq!(allowed.second, SetupMsg::RepoRevoke);
    assert!(allowed.second_enabled);

    let declined = row_of(RepoDecisionState::Declined).buttons();
    assert!(declined.allow_enabled);
    assert_eq!(declined.second, SetupMsg::RepoRevoke);
    assert!(!declined.second_enabled);

    let not_asked = row_of(RepoDecisionState::Undecided).buttons();
    assert!(not_asked.allow_enabled);
    assert_eq!(not_asked.second, SetupMsg::RepoBannerNo);
    assert!(not_asked.second_enabled);
}

#[test]
fn delete_history_is_offered_only_for_a_decided_repo() {
    assert!(row_of(RepoDecisionState::Allowed).offers_delete());
    assert!(row_of(RepoDecisionState::Declined).offers_delete());
    assert!(!row_of(RepoDecisionState::Undecided).offers_delete());
}

#[test]
fn agent_tools_show_only_after_an_approved_plan() {
    let mut model = SetupSettings::default();
    assert!(!model.shows_agent_tools());
    for (consent, shown) in [
        (ConsentState::Later, false),
        (ConsentState::Removed, false),
        (ConsentState::Approved, true),
    ] {
        model.route(
            RequestKind::Plan,
            Outcome::Plan {
                consent,
                targets: Vec::new(),
                harness_off: Vec::new(),
                shell_hook: true,
            },
            "",
        );
        assert_eq!(model.shows_agent_tools(), shown, "{consent:?}");
    }
}

#[test]
fn shell_request_asks_for_the_opposite_state() {
    assert_eq!(SetupSettings::shell_request(true), RequestKind::ShellOff);
    assert_eq!(SetupSettings::shell_request(false), RequestKind::ShellOn);
}
