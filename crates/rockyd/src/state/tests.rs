use super::*;
use rocky_proto::pipe::Status::*;

fn ev(name: &str, sid: &str, aid: Option<&str>) -> HookEvent {
    HookEvent {
        hook_event_name: name.into(),
        session_id: sid.into(),
        cwd: Some("C:/r".into()),
        agent_id: aid.map(str::to_string),
        agent_type: None,
        tool_name: None,
        tool_use_id: None,
        transcript_path: None,
        agent_transcript_path: None,
        notification_type: None,
        target_path: None,
        command: None,
        description: None,
        prompt: None,
        truncated: false,
    }
}

fn repo(_: &str) -> RepoInfo {
    RepoInfo {
        root: Some("C:/r".into()),
        main_root: None,
        name: "r".into(),
        branch: Some("main".into()),
    }
}

fn key(s: &str, a: &str) -> AgentKey {
    AgentKey {
        session_id: s.into(),
        agent_id: a.into(),
    }
}

fn main_key(s: &str) -> AgentKey {
    key(s, "")
}

fn tool_ev(
    name: &str,
    sid: &str,
    aid: Option<&str>,
    tool: &str,
    id: &str,
    target: Option<&str>,
) -> HookEvent {
    let mut e = ev(name, sid, aid);
    e.tool_name = Some(tool.into());
    e.tool_use_id = Some(id.into());
    e.target_path = target.map(str::to_string);
    e
}

#[test]
fn session_start_is_idle() {
    let mut st = StatusState::new();
    let out = st.apply(&ev("SessionStart", "S1", None), 1, &mut repo);
    assert!(matches!(out, ApplyOutcome::Changed(_)));
    assert_eq!(st.get(&main_key("S1")).unwrap().status, Idle);
}

#[test]
fn prompt_then_pre_tool_is_working_with_action() {
    let mut st = StatusState::new();
    st.apply(&ev("SessionStart", "S1", None), 1, &mut repo);
    st.apply(&ev("UserPromptSubmit", "S1", None), 2, &mut repo);
    assert_eq!(st.get(&main_key("S1")).unwrap().status, Working);
    st.apply(
        &tool_ev("PreToolUse", "S1", None, "Edit", "t1", Some("C:/r/a.ts")),
        3,
        &mut repo,
    );
    let a = st.get(&main_key("S1")).unwrap();
    assert_eq!(a.status, Working);
    let action = a.action.unwrap();
    assert_eq!(action.tool_name, "Edit");
    assert_eq!(action.target_path.as_deref(), Some("C:/r/a.ts"));
}

#[test]
fn post_tool_failure_counts() {
    let mut st = StatusState::new();
    st.apply(
        &tool_ev("PreToolUse", "S1", None, "Edit", "t1", Some("C:/r/a.ts")),
        1,
        &mut repo,
    );
    st.apply(
        &tool_ev("PostToolUseFailure", "S1", None, "Edit", "t1", None),
        2,
        &mut repo,
    );
    let a = st.get(&main_key("S1")).unwrap();
    assert_eq!(a.failures, 1);
    assert_eq!(a.action, None);
}

#[test]
fn permission_request_needs_you_then_cleared_by_pre_tool() {
    let mut st = StatusState::new();
    let mut perm = ev("PermissionRequest", "S1", None);
    perm.tool_name = Some("Bash".into());
    st.apply(&perm, 1, &mut repo);
    let a = st.get(&main_key("S1")).unwrap();
    assert_eq!(a.status, NeedsYou);
    assert_eq!(a.summary.as_deref(), Some("Bash"));
    st.apply(
        &tool_ev("PreToolUse", "S1", None, "Bash", "t1", None),
        2,
        &mut repo,
    );
    assert_eq!(st.get(&main_key("S1")).unwrap().status, Working);
}

#[test]
fn notification_types_map_to_needs_you() {
    let mut st = StatusState::new();
    for (i, ty) in [
        "permission_prompt",
        "agent_needs_input",
        "elicitation_dialog",
    ]
    .iter()
    .enumerate()
    {
        let sid = format!("S{i}");
        let mut n = ev("Notification", &sid, None);
        n.notification_type = Some((*ty).into());
        st.apply(&n, 1, &mut repo);
        let a = st.get(&main_key(&sid)).unwrap();
        assert_eq!(a.status, NeedsYou, "{ty}");
        assert_eq!(a.summary.as_deref(), Some(*ty), "{ty}");
    }
    st.apply(&ev("SessionStart", "Sx", None), 1, &mut repo);
    let mut idle = ev("Notification", "Sx", None);
    idle.notification_type = Some("idle_prompt".into());
    st.apply(&idle, 2, &mut repo);
    assert_eq!(st.get(&main_key("Sx")).unwrap().status, Idle);
}

#[test]
fn subagent_lifecycle_and_tool_routing() {
    let mut st = StatusState::new();
    st.apply(&ev("SessionStart", "S1", None), 1, &mut repo);
    let mut start = ev("SubagentStart", "S1", Some("A1"));
    start.agent_type = Some("Explore".into());
    st.apply(&start, 2, &mut repo);
    let child = st.get(&key("S1", "A1")).unwrap();
    assert_eq!(child.status, Working);
    assert_eq!(child.agent_type.as_deref(), Some("Explore"));
    st.apply(
        &tool_ev("PreToolUse", "S1", Some("A1"), "Read", "t1", Some("f")),
        3,
        &mut repo,
    );
    assert_eq!(st.get(&main_key("S1")).unwrap().action, None);
    assert_eq!(
        st.get(&key("S1", "A1")).unwrap().action.unwrap().tool_name,
        "Read"
    );
    st.apply(&ev("SubagentStop", "S1", Some("A1")), 4, &mut repo);
    let child = st.get(&key("S1", "A1")).unwrap();
    assert_eq!(child.status, Done);
    assert_eq!(child.action, None);
}

#[test]
fn stop_done_and_stop_failure_failed() {
    let mut st = StatusState::new();
    st.apply(&ev("UserPromptSubmit", "S1", None), 1, &mut repo);
    st.apply(&ev("Stop", "S1", None), 2, &mut repo);
    assert_eq!(st.get(&main_key("S1")).unwrap().status, Done);
    st.apply(&ev("UserPromptSubmit", "S2", None), 3, &mut repo);
    st.apply(&ev("StopFailure", "S2", None), 4, &mut repo);
    assert_eq!(st.get(&main_key("S2")).unwrap().status, Failed);
}

#[test]
fn session_end_marks_all_ended_then_removed_after_hour() {
    let mut st = StatusState::new();
    st.apply(&ev("SessionStart", "S1", None), 1, &mut repo);
    st.apply(&ev("SubagentStart", "S1", Some("A1")), 2, &mut repo);
    st.apply(&ev("SessionEnd", "S1", None), 100, &mut repo);
    assert_eq!(st.get(&main_key("S1")).unwrap().status, Ended);
    assert_eq!(st.get(&key("S1", "A1")).unwrap().status, Ended);
    let ch = st.tick(100 + ENDED_REMOVE_MS);
    assert!(ch.removed.contains(&main_key("S1")));
    assert!(ch.removed.contains(&key("S1", "A1")));
    assert_eq!(st.get(&main_key("S1")), None);
    assert_eq!(st.get(&key("S1", "A1")), None);
}

#[test]
fn done_goes_idle_after_30m_and_working_flags_quiet_after_10m() {
    let mut st = StatusState::new();
    st.apply(&ev("UserPromptSubmit", "S1", None), 100, &mut repo);
    st.apply(&ev("Stop", "S1", None), 200, &mut repo);
    st.apply(&ev("UserPromptSubmit", "S2", None), 300, &mut repo);
    let ch = st.tick(200 + DONE_TO_IDLE_MS);
    assert_eq!(st.get(&main_key("S1")).unwrap().status, Idle);
    assert!(ch.upserted.contains(&main_key("S1")));
    let w = st.get(&main_key("S2")).unwrap();
    assert_eq!(w.status, Working);
    assert!(w.quiet_10m);
    assert!(ch.upserted.contains(&main_key("S2")));
}

#[test]
fn parallel_tools_keep_latest_in_flight() {
    let mut st = StatusState::new();
    st.apply(
        &tool_ev("PreToolUse", "S1", None, "Read", "t1", Some("a")),
        1,
        &mut repo,
    );
    st.apply(
        &tool_ev("PreToolUse", "S1", None, "Edit", "t2", Some("b")),
        2,
        &mut repo,
    );
    st.apply(
        &tool_ev("PostToolUse", "S1", None, "Read", "t1", None),
        3,
        &mut repo,
    );
    let action = st.get(&main_key("S1")).unwrap().action.unwrap();
    assert_eq!(action.tool_name, "Edit");
    assert_eq!(action.tool_use_id.as_deref(), Some("t2"));
    st.apply(
        &tool_ev("PostToolUse", "S1", None, "Edit", "t2", None),
        4,
        &mut repo,
    );
    assert_eq!(st.get(&main_key("S1")).unwrap().action, None);
}

#[test]
fn late_event_is_dropped() {
    let mut st = StatusState::new();
    st.apply(&ev("SessionStart", "S1", None), 100, &mut repo);
    let out = st.apply(&ev("UserPromptSubmit", "S1", None), 99, &mut repo);
    assert_eq!(out, ApplyOutcome::Late);
    assert_eq!(st.get(&main_key("S1")).unwrap().status, Idle);
    let out = st.apply(&ev("UserPromptSubmit", "S1", None), 100, &mut repo);
    assert!(matches!(out, ApplyOutcome::Changed(_)));
    assert_eq!(st.get(&main_key("S1")).unwrap().status, Working);
}

#[test]
fn unknown_session_creates_agent_lazily() {
    let mut st = StatusState::new();
    st.apply(
        &tool_ev("PreToolUse", "S1", None, "Read", "t1", None),
        1,
        &mut repo,
    );
    let a = st.get(&main_key("S1")).unwrap();
    assert_eq!(a.status, Working);
    assert_eq!(a.repo, repo("C:/r"));
}

#[test]
fn aggregate_priority() {
    let mut st = StatusState::new();
    let mut perm = ev("PermissionRequest", "S1", None);
    perm.tool_name = Some("Bash".into());
    st.apply(&perm, 1, &mut repo);
    st.apply(&ev("UserPromptSubmit", "S2", None), 2, &mut repo);
    st.apply(&ev("StopFailure", "S2", None), 3, &mut repo);
    st.apply(&ev("UserPromptSubmit", "S3", None), 4, &mut repo);
    st.apply(&ev("UserPromptSubmit", "S4", None), 5, &mut repo);
    st.apply(&ev("Stop", "S4", None), 6, &mut repo);
    st.apply(&ev("SessionStart", "S5", None), 7, &mut repo);
    st.apply(&ev("SessionStart", "S6", None), 8, &mut repo);
    st.apply(&ev("SessionEnd", "S6", None), 9, &mut repo);
    assert_eq!(st.aggregate(), NeedsYou);
    st.apply(&ev("SessionEnd", "S1", None), 10, &mut repo);
    assert_eq!(st.aggregate(), Failed);
    st.apply(&ev("SessionEnd", "S2", None), 11, &mut repo);
    assert_eq!(st.aggregate(), Working);
    st.apply(&ev("SessionEnd", "S3", None), 12, &mut repo);
    assert_eq!(st.aggregate(), Done);
    st.apply(&ev("SessionEnd", "S4", None), 13, &mut repo);
    assert_eq!(st.aggregate(), Idle);
    st.apply(&ev("SessionEnd", "S5", None), 14, &mut repo);
    assert_eq!(st.aggregate(), Idle);
}

fn with_description(mut e: HookEvent, description: &str) -> HookEvent {
    e.description = Some(description.into());
    e
}

#[test]
fn single_in_flight_agent_tool_names_the_child() {
    let mut st = StatusState::new();
    st.apply(&ev("UserPromptSubmit", "S1", None), 1, &mut repo);
    let pre = tool_ev("PreToolUse", "S1", None, "Agent", "t1", None);
    st.apply(&with_description(pre, "scan repo"), 2, &mut repo);
    let mut start = ev("SubagentStart", "S1", Some("A1"));
    start.agent_type = Some("general-purpose".into());
    st.apply(&start, 3, &mut repo);
    assert_eq!(
        st.get(&key("S1", "A1")).unwrap().description.as_deref(),
        Some("scan repo")
    );
    // The second child finds the only Agent call already paired.
    st.apply(&ev("SubagentStart", "S1", Some("A2")), 4, &mut repo);
    assert_eq!(st.get(&key("S1", "A2")).unwrap().description, None);
}

#[test]
fn zero_or_two_candidates_leave_description_empty() {
    let mut st = StatusState::new();
    st.apply(&ev("SubagentStart", "S1", Some("A1")), 1, &mut repo);
    assert_eq!(st.get(&key("S1", "A1")).unwrap().description, None);

    let mut st = StatusState::new();
    st.apply(&ev("UserPromptSubmit", "S1", None), 1, &mut repo);
    for (i, tool) in ["Agent", "Task"].into_iter().enumerate() {
        let id = format!("t{i}");
        let pre = tool_ev("PreToolUse", "S1", None, tool, &id, None);
        st.apply(&with_description(pre, tool), 2, &mut repo);
    }
    st.apply(&ev("SubagentStart", "S1", Some("A2")), 3, &mut repo);
    assert_eq!(st.get(&key("S1", "A2")).unwrap().description, None);
}

#[test]
fn main_done_leaves_working_child_working() {
    let mut st = StatusState::new();
    st.apply(&ev("UserPromptSubmit", "S1", None), 1, &mut repo);
    st.apply(&ev("SubagentStart", "S1", Some("A1")), 2, &mut repo);
    st.apply(&ev("Stop", "S1", None), 3, &mut repo);
    assert_eq!(st.get(&main_key("S1")).unwrap().status, Done);
    assert_eq!(st.get(&key("S1", "A1")).unwrap().status, Working);
}

#[test]
fn async_post_tool_use_after_stop_keeps_done_from_both_directions() {
    let mut st = StatusState::new();
    st.apply(
        &tool_ev("PreToolUse", "S1", None, "Bash", "t1", None),
        1,
        &mut repo,
    );
    st.apply(&ev("Stop", "S1", None), 2, &mut repo);
    st.apply(
        &tool_ev("PostToolUse", "S1", None, "Bash", "t1", None),
        3,
        &mut repo,
    );
    let a = st.get(&main_key("S1")).unwrap();
    assert_eq!(a.status, Done);
    assert_eq!(a.last_event_ms, 3);

    let mut st = StatusState::new();
    st.apply(
        &tool_ev("PreToolUse", "S1", None, "Bash", "t1", None),
        1,
        &mut repo,
    );
    st.apply(
        &tool_ev("PostToolUse", "S1", None, "Bash", "t1", None),
        2,
        &mut repo,
    );
    st.apply(&ev("Stop", "S1", None), 3, &mut repo);
    assert_eq!(st.get(&main_key("S1")).unwrap().status, Done);
}

#[test]
fn new_prompt_removes_finished_children_only() {
    let mut st = StatusState::new();
    st.apply(&ev("UserPromptSubmit", "S1", None), 1, &mut repo);
    st.apply(&ev("SubagentStart", "S1", Some("A1")), 2, &mut repo);
    st.apply(&ev("SubagentStop", "S1", Some("A1")), 3, &mut repo);
    st.apply(&ev("SubagentStart", "S1", Some("A2")), 4, &mut repo);
    let out = st.apply(&ev("UserPromptSubmit", "S1", None), 5, &mut repo);
    let ApplyOutcome::Changed(changes) = out else {
        panic!("prompt must be applied, got {out:?}");
    };
    assert_eq!(changes.removed, vec![key("S1", "A1")]);
    assert_eq!(st.get(&key("S1", "A1")), None);
    assert!(st.timeline(&key("S1", "A1")).is_empty());
    assert!(st.get(&key("S1", "A2")).is_some());
}

#[test]
fn finished_child_removed_after_30m_not_idled() {
    let mut st = StatusState::new();
    st.apply(&ev("UserPromptSubmit", "S1", None), 1, &mut repo);
    st.apply(&ev("SubagentStart", "S1", Some("A1")), 2, &mut repo);
    st.apply(&ev("SubagentStop", "S1", Some("A1")), 3, &mut repo);
    st.apply(&ev("Stop", "S1", None), 4, &mut repo);
    let ch = st.tick(4 + CHILD_REMOVE_MS);
    assert!(ch.removed.contains(&key("S1", "A1")));
    assert_eq!(st.get(&key("S1", "A1")), None);
    assert!(!ch.removed.contains(&main_key("S1")));
    assert!(ch.upserted.contains(&main_key("S1")));
    assert_eq!(st.get(&main_key("S1")).unwrap().status, Idle);

    st.apply(&ev("SubagentStart", "S1", Some("A2")), 5, &mut repo);
    st.apply(&ev("StopFailure", "S1", Some("A2")), 6, &mut repo);
    let ch = st.tick(6 + CHILD_REMOVE_MS);
    assert!(ch.removed.contains(&key("S1", "A2")));
    assert_eq!(st.get(&key("S1", "A2")), None);
}

#[test]
fn tool_text_off_strips_and_clears() {
    let mut st = StatusState::new();
    let mut pre = tool_ev("PreToolUse", "S1", None, "Bash", "t1", None);
    pre.command = Some("npm test".into());
    st.apply(&pre, 1, &mut repo);
    assert_eq!(
        st.get(&main_key("S1"))
            .unwrap()
            .action
            .unwrap()
            .command
            .as_deref(),
        Some("npm test")
    );
    assert_eq!(st.set_tool_text(false), vec![main_key("S1")]);
    assert_eq!(
        st.get(&main_key("S1")).unwrap().action.unwrap().command,
        None
    );
    assert!(!st.tool_text());

    let mut e = ev("PreToolUse", "S1", None);
    e.command = Some("npm test".into());
    e.description = Some("run the tests".into());
    let off = st.prepare(e.clone());
    assert_eq!(off.command, None);
    assert_eq!(off.description, None);
    st.set_tool_text(true);
    assert!(st.tool_text());
    assert_eq!(st.prepare(e.clone()), e);
}

#[test]
fn tool_text_off_clears_child_description_and_in_flight_text() {
    let mut st = StatusState::new();
    let mut pre = tool_ev("PreToolUse", "S1", None, "Agent", "t1", None);
    pre.command = Some("delegate".into());
    st.apply(&with_description(pre, "scan repo"), 1, &mut repo);
    st.apply(&ev("SubagentStart", "S1", Some("A1")), 2, &mut repo);
    // A second delegation is in flight when the text is turned off.
    let mut pre = tool_ev("PreToolUse", "S1", None, "Agent", "t2", None);
    pre.command = Some("delegate again".into());
    st.apply(&with_description(pre, "scan tests"), 3, &mut repo);
    assert_eq!(
        st.set_tool_text(false),
        vec![main_key("S1"), key("S1", "A1")]
    );
    assert_eq!(st.get(&key("S1", "A1")).unwrap().description, None);

    st.set_tool_text(true);
    st.apply(&ev("SubagentStart", "S1", Some("A2")), 4, &mut repo);
    assert_eq!(
        st.get(&key("S1", "A2")).unwrap().description,
        None,
        "the in-flight description was cleared"
    );
}

#[test]
fn tool_entry_pending_then_ok_or_failed() {
    let mut st = StatusState::new();
    st.apply(
        &tool_ev(
            "PreToolUse",
            "S1",
            None,
            "Edit",
            "t1",
            Some("C:/r/src/a.ts"),
        ),
        1,
        &mut repo,
    );
    let tl = st.timeline(&main_key("S1"));
    assert_eq!(tl.len(), 1);
    assert_eq!(tl[0].ms, 1);
    assert_eq!(tl[0].kind, TimelineKind::Tool);
    assert_eq!(tl[0].tool_name.as_deref(), Some("Edit"));
    assert_eq!(tl[0].text.as_deref(), Some("src/a.ts"));
    assert_eq!(tl[0].outcome, Some(Outcome::Pending));
    st.apply(
        &tool_ev("PostToolUse", "S1", None, "Edit", "t1", None),
        2,
        &mut repo,
    );
    assert_eq!(st.timeline(&main_key("S1"))[0].outcome, Some(Outcome::Ok));

    let mut pre = tool_ev("PreToolUse", "S1", None, "Bash", "t2", None);
    pre.command = Some("npm test".into());
    st.apply(&pre, 3, &mut repo);
    let tl = st.timeline(&main_key("S1"));
    assert_eq!(tl[1].text.as_deref(), Some("npm test"));
    assert_eq!(tl[1].outcome, Some(Outcome::Pending));
    st.apply(
        &tool_ev("PostToolUseFailure", "S1", None, "Bash", "t2", None),
        4,
        &mut repo,
    );
    assert_eq!(
        st.timeline(&main_key("S1"))[1].outcome,
        Some(Outcome::Failed)
    );

    // Without an id, the newest pending entry changes.
    st.apply(
        &tool_ev("PreToolUse", "S1", None, "Read", "t3", Some("C:/r/b.ts")),
        5,
        &mut repo,
    );
    let mut post = ev("PostToolUse", "S1", None);
    post.tool_name = Some("Read".into());
    st.apply(&post, 6, &mut repo);
    let tl = st.timeline(&main_key("S1"));
    assert_eq!(tl[2].outcome, Some(Outcome::Ok));
    assert_eq!(tl[2].text.as_deref(), Some("b.ts"));
}

#[test]
fn timeline_keeps_last_50() {
    let mut st = StatusState::new();
    for i in 0..60u64 {
        let id = format!("t{i}");
        let target = format!("C:/r/f{i}");
        st.apply(
            &tool_ev("PreToolUse", "S1", None, "Read", &id, Some(&target)),
            1 + i,
            &mut repo,
        );
    }
    let tl = st.timeline(&main_key("S1"));
    assert_eq!(tl.len(), 50);
    assert_eq!(tl[0].text.as_deref(), Some("f10"));
    assert_eq!(tl[0].ms, 11);
    assert_eq!(tl[49].text.as_deref(), Some("f59"));
}

#[test]
fn kinds_follow_the_event_table() {
    let mut st = StatusState::new();
    st.apply(&ev("SessionStart", "S1", None), 1, &mut repo);
    st.apply(&ev("UserPromptSubmit", "S1", None), 2, &mut repo);
    let mut perm = ev("PermissionRequest", "S1", None);
    perm.tool_name = Some("Bash".into());
    st.apply(&perm, 3, &mut repo);
    st.apply(&ev("Stop", "S1", None), 4, &mut repo);
    let tl = st.timeline(&main_key("S1"));
    let kinds: Vec<_> = tl.iter().map(|e| e.kind).collect();
    assert_eq!(
        kinds,
        vec![
            TimelineKind::SessionStart,
            TimelineKind::TurnStart,
            TimelineKind::NeedsYou,
            TimelineKind::TurnDone,
        ]
    );
    assert_eq!(tl[2].tool_name.as_deref(), Some("Bash"));

    st.apply(&ev("SubagentStart", "S1", Some("A1")), 5, &mut repo);
    st.apply(&ev("SubagentStop", "S1", Some("A1")), 6, &mut repo);
    let kinds: Vec<_> = st
        .timeline(&key("S1", "A1"))
        .iter()
        .map(|e| e.kind)
        .collect();
    assert_eq!(
        kinds,
        vec![TimelineKind::SubagentStart, TimelineKind::SubagentStop]
    );
}

#[test]
fn session_end_entry_on_every_updated_agent() {
    let mut st = StatusState::new();
    st.apply(&ev("SessionStart", "S1", None), 1, &mut repo);
    st.apply(&ev("SubagentStart", "S1", Some("A1")), 2, &mut repo);
    st.apply(&ev("SessionStart", "S2", None), 3, &mut repo);
    st.apply(&ev("SessionEnd", "S1", None), 4, &mut repo);
    assert_eq!(
        st.timeline(&main_key("S1")).last().unwrap().kind,
        TimelineKind::SessionEnd
    );
    assert_eq!(
        st.timeline(&key("S1", "A1")).last().unwrap().kind,
        TimelineKind::SessionEnd
    );
    assert_eq!(
        st.timeline(&main_key("S2")).last().unwrap().kind,
        TimelineKind::SessionStart
    );
}

#[test]
fn gap_marks_live_agents_only() {
    let mut st = StatusState::new();
    st.apply(&ev("UserPromptSubmit", "S1", None), 1, &mut repo);
    st.apply(&ev("UserPromptSubmit", "S2", None), 2, &mut repo);
    st.apply(&ev("SessionEnd", "S2", None), 3, &mut repo);
    let ended = st.timeline(&main_key("S2"));
    st.record_gap(&Gap {
        from_ms: 5,
        to_ms: 9,
        count: 2,
        reason: GapReason::HookDropped,
    });
    let tl = st.timeline(&main_key("S1"));
    let last = tl.last().unwrap();
    assert_eq!(last.ms, 9);
    assert_eq!(last.kind, TimelineKind::Gap);
    assert_eq!(last.text.as_deref(), Some("hook_dropped"));
    assert_eq!(st.timeline(&main_key("S2")), ended);
}

#[test]
fn tool_text_off_clears_command_text_keeps_paths() {
    let mut st = StatusState::new();
    let mut pre = tool_ev("PreToolUse", "S1", None, "Bash", "t2", None);
    pre.command = Some("npm test".into());
    st.apply(&pre, 1, &mut repo);
    st.apply(
        &tool_ev("PostToolUse", "S1", None, "Bash", "t2", None),
        2,
        &mut repo,
    );
    st.apply(
        &tool_ev(
            "PreToolUse",
            "S1",
            None,
            "Edit",
            "t1",
            Some("C:/r/src/a.ts"),
        ),
        3,
        &mut repo,
    );
    st.apply(
        &tool_ev("PostToolUse", "S1", None, "Edit", "t1", None),
        4,
        &mut repo,
    );
    assert!(st.set_tool_text(false).is_empty());
    let tl = st.timeline(&main_key("S1"));
    assert_eq!(tl[0].text, None);
    assert_eq!(tl[1].text.as_deref(), Some("src/a.ts"));
}

#[test]
fn subagent_start_entry_text_is_child_description() {
    let mut st = StatusState::new();
    st.apply(&ev("UserPromptSubmit", "S1", None), 1, &mut repo);
    let pre = tool_ev("PreToolUse", "S1", None, "Agent", "t1", None);
    st.apply(&with_description(pre, "scan repo"), 2, &mut repo);
    st.apply(&ev("SubagentStart", "S1", Some("A1")), 3, &mut repo);
    let tl = st.timeline(&key("S1", "A1"));
    assert_eq!(tl[0].kind, TimelineKind::SubagentStart);
    assert_eq!(tl[0].text.as_deref(), Some("scan repo"));
    st.set_tool_text(false);
    assert_eq!(st.timeline(&key("S1", "A1"))[0].text, None);
}

#[test]
fn tool_text_is_repo_relative_across_separators_and_case() {
    let mut st = StatusState::new();
    st.apply(
        &tool_ev(
            "PreToolUse",
            "S1",
            None,
            "Edit",
            "t1",
            Some("c:\\R\\src\\a.ts"),
        ),
        1,
        &mut repo,
    );
    let tl = st.timeline(&main_key("S1"));
    assert_eq!(tl[0].text.as_deref(), Some("src/a.ts"));

    st.apply(
        &tool_ev("PreToolUse", "S1", None, "Edit", "t2", Some("D:/x/b.ts")),
        2,
        &mut repo,
    );
    let tl = st.timeline(&main_key("S1"));
    assert_eq!(tl[1].text.as_deref(), Some("D:/x/b.ts"));
}

#[test]
fn unknown_key_has_empty_timeline() {
    let st = StatusState::new();
    assert!(st.timeline(&key("x", "")).is_empty());
}

/// Resolves a cwd to a repo whose root is the cwd itself.
fn repo_at(cwd: &str) -> RepoInfo {
    RepoInfo {
        root: Some(cwd.into()),
        main_root: None,
        name: cwd.into(),
        branch: None,
    }
}

/// The event with its cwd set, or with no cwd at all.
fn in_dir(mut e: HookEvent, cwd: Option<&str>) -> HookEvent {
    e.cwd = cwd.map(str::to_string);
    e
}

fn root_of(st: &StatusState, sid: &str) -> Option<String> {
    st.get(&main_key(sid)).unwrap().repo.root
}

#[test]
fn session_repo_follows_session_start_not_later_prompts() {
    let mut st = StatusState::new();
    st.apply(
        &in_dir(ev("SessionStart", "S1", None), Some("/a")),
        1,
        &mut repo_at,
    );
    st.apply(
        &in_dir(ev("UserPromptSubmit", "S1", None), Some("/b")),
        2,
        &mut repo_at,
    );
    assert_eq!(root_of(&st, "S1").as_deref(), Some("/a"));
}

#[test]
fn first_event_with_cwd_names_session_without_start() {
    let mut st = StatusState::new();
    let bare = tool_ev("PreToolUse", "S1", None, "Read", "t1", None);
    st.apply(&in_dir(bare, None), 1, &mut repo_at);
    let with_cwd = tool_ev("PreToolUse", "S1", None, "Read", "t2", None);
    st.apply(&in_dir(with_cwd, Some("/c")), 2, &mut repo_at);
    assert_eq!(root_of(&st, "S1").as_deref(), Some("/c"));
}

#[test]
fn session_start_with_cwd_always_sets_the_repo() {
    let mut st = StatusState::new();
    st.apply(
        &in_dir(ev("SessionStart", "S1", None), Some("/a")),
        1,
        &mut repo_at,
    );
    st.apply(
        &in_dir(ev("SessionStart", "S1", None), Some("/b")),
        2,
        &mut repo_at,
    );
    assert_eq!(root_of(&st, "S1").as_deref(), Some("/b"));
}

#[test]
fn session_roots_lists_distinct_roots() {
    let mut st = StatusState::new();
    st.apply(
        &in_dir(ev("SessionStart", "S1", None), Some("/a")),
        1,
        &mut repo_at,
    );
    st.apply(
        &in_dir(ev("SessionStart", "S2", None), Some("/a")),
        2,
        &mut repo_at,
    );
    st.apply(
        &in_dir(ev("SessionStart", "S3", None), Some("/b")),
        3,
        &mut repo_at,
    );
    st.apply(&in_dir(ev("PreToolUse", "S4", None), None), 4, &mut repo_at);
    assert_eq!(st.session_roots(), vec!["/a".to_string(), "/b".to_string()]);
}
