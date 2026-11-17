use super::*;
use crate::i18n::{Msg, UiLang, en, id, tr};
use rocky_proto::pipe::{
    Action, AgentKey, AgentStatus, Gap, GapReason, Health, Outcome, RepoInfo, ServerMsg, Status,
    TimelineEntry, TimelineKind,
};
use rocky_proto::settings::Settings;

fn agent(session: &str, agent_id: &str, status: Status) -> AgentStatus {
    AgentStatus {
        key: AgentKey {
            session_id: session.into(),
            agent_id: agent_id.into(),
        },
        agent_type: if agent_id.is_empty() {
            None
        } else {
            Some("Explore".into())
        },
        status,
        action: None,
        summary: None,
        description: None,
        failures: 0,
        last_event_ms: 1_000,
        quiet_10m: false,
        repo: RepoInfo {
            root: Some("C:/r".into()),
            main_root: None,
            name: "r".into(),
            branch: Some("main".into()),
        },
        prompt: None,
        harness: None,
    }
}

fn snapshot(agents: Vec<AgentStatus>) -> ServerMsg {
    ServerMsg::Snapshot {
        agents,
        aggregate: Status::Idle,
        health: Health::default(),
        settings: Settings::default(),
        repo_pending: Vec::new(),
    }
}

#[test]
fn tooltip_counts() {
    let m = Model::new();
    assert_eq!(
        m.tooltip(),
        Msg::Tooltip {
            working: 0,
            needs_you: 0,
            failed: 0,
            done: 0,
            idle: 0
        }
    );
    assert_eq!(en(&m.tooltip()), "rocky: idle");
    let mut m = Model::new();
    m.apply(snapshot(vec![
        agent("S1", "", Status::Working),
        agent("S2", "", Status::Working),
        agent("S3", "", Status::NeedsYou),
    ]));
    assert_eq!(
        m.tooltip(),
        Msg::Tooltip {
            working: 2,
            needs_you: 1,
            failed: 0,
            done: 0,
            idle: 0
        }
    );
    assert_eq!(en(&m.tooltip()), "rocky: 2 working, 1 needs you");
}

#[test]
fn action_text_relative_and_capped() {
    let a = Action {
        tool_name: "Edit".into(),
        target_path: Some("C:/r/src/core/memory.ts".into()),
        tool_use_id: None,
        command: None,
    };
    assert_eq!(action_text(&a, Some("C:/r")), "Edit src/core/memory.ts");
    // path panjang → len chars == 80 dan diakhiri '…'
    let long = Action {
        tool_name: "Edit".into(),
        target_path: Some(format!("C:/r/{}", "x".repeat(200))),
        tool_use_id: None,
        command: None,
    };
    let t = action_text(&long, Some("C:/r"));
    assert_eq!(t.chars().count(), 80);
    assert!(t.ends_with('…'));
    // backslash + root beda case → relatif, pakai '/'
    let win = Action {
        tool_name: "Read".into(),
        target_path: Some("C:\\r\\src\\a.ts".into()),
        tool_use_id: None,
        command: None,
    };
    assert_eq!(action_text(&win, Some("c:/R")), "Read src/a.ts");
    // tanpa target → nama tool saja
    let bare = Action {
        tool_name: "Bash".into(),
        target_path: None,
        tool_use_id: None,
        command: None,
    };
    assert_eq!(action_text(&bare, Some("C:/r")), "Bash");
}

#[test]
fn status_remove_deletes_row() {
    let mut m = Model::new();
    m.apply(snapshot(vec![agent("S1", "", Status::Working)]));
    assert_eq!(m.agents().len(), 1);
    m.apply(ServerMsg::Status {
        op: StatusOp::Remove,
        agent: agent("S1", "", Status::Working),
    });
    assert!(m.agents().is_empty());
}

#[test]
fn warnings_cover_health_and_conn() {
    let m = Model::new();
    assert!(m.warnings(&crate::clock::utc_hhmm).is_empty());
    let mut m = Model::new();
    m.apply(ServerMsg::Health {
        health: Health {
            bad_files: 2,
            dropped_events: 1,
            spool_dropped: 1,
            late_events: 1,
            hook_newer_than_daemon: true,
            ..Default::default()
        },
    });
    m.set_conn(Conn::VersionMismatch);
    let w = m.warnings(&crate::clock::utc_hhmm);
    assert_eq!(
        w,
        vec![
            Msg::SpoolDropped { n: 1 },
            Msg::DroppedEvents { n: 1 },
            Msg::BadFiles { n: 2 },
            Msg::LateEvents { n: 1 },
            Msg::HookNewer,
            Msg::ConnVersionMismatch,
        ]
    );
    assert_eq!(en(&w[0]), "1 spool files dropped.");
    assert_eq!(en(&w[1]), "1 dropped events.");
    assert_eq!(en(&w[2]), "2 bad spool files.");
    assert_eq!(en(&w[3]), "1 late events.");
    assert_eq!(en(&w[4]), "hook is newer than daemon, needs update.");
    assert_eq!(en(&w[5]), "daemon version mismatch, needs update.");
    let mut m = Model::new();
    m.set_conn(Conn::TiedToJob);
    assert_eq!(
        m.warnings(&crate::clock::utc_hhmm),
        vec![Msg::ConnTiedToJob]
    );
    assert_eq!(en(&Msg::ConnTiedToJob), "daemon tied to launcher job.");
    m.set_conn(Conn::KeepsCrashing);
    assert_eq!(
        m.warnings(&crate::clock::utc_hhmm),
        vec![Msg::ConnKeepsCrashing]
    );
    assert_eq!(en(&Msg::ConnKeepsCrashing), "daemon keeps crashing.");
    m.set_conn(Conn::ServerUnverified);
    assert_eq!(
        m.warnings(&crate::clock::utc_hhmm),
        vec![Msg::ConnUnverified]
    );
    assert_eq!(en(&Msg::ConnUnverified), "daemon could not be verified.");
    m.set_conn(Conn::Disconnected);
    assert_eq!(
        m.warnings(&crate::clock::utc_hhmm),
        vec![Msg::ConnDisconnected]
    );
    assert_eq!(en(&Msg::ConnDisconnected), "daemon disconnected.");
    m.set_conn(Conn::Connected);
    assert!(m.warnings(&crate::clock::utc_hhmm).is_empty());
}

#[test]
fn aggregate_priority_ignores_snapshot() {
    let mut m = Model::new();
    assert_eq!(m.aggregate(), Status::Idle);
    // snapshot mengklaim Idle tapi agen Working → hitung lokal
    m.apply(snapshot(vec![agent("S1", "", Status::Working)]));
    assert_eq!(m.aggregate(), Status::Working);
    m.apply(ServerMsg::Status {
        op: StatusOp::Upsert,
        agent: agent("S2", "", Status::Failed),
    });
    assert_eq!(m.aggregate(), Status::Failed);
    m.apply(ServerMsg::Status {
        op: StatusOp::Upsert,
        agent: agent("S3", "", Status::NeedsYou),
    });
    assert_eq!(m.aggregate(), Status::NeedsYou);
}

#[test]
fn age_boundaries() {
    let live_age = Msg::Age {
        secs: age_secs(130_000, 130_000),
    };
    assert_eq!(live_age, Msg::Age { secs: 0 });
    assert_eq!(en(&live_age), "now");
    let old_age = Msg::Age {
        secs: age_secs(130_000, 10_000),
    };
    assert_eq!(old_age, Msg::Age { secs: 120 });
    assert_eq!(en(&old_age), "2m");
}

#[test]
fn bash_command_wins_over_path_and_is_capped() {
    let bash = Action {
        tool_name: "Bash".into(),
        command: Some("npm test".into()),
        target_path: Some("C:/r/x".into()),
        tool_use_id: None,
    };
    assert_eq!(action_text(&bash, Some("C:/r")), "Bash npm test");
    let long = Action {
        tool_name: "Bash".into(),
        command: Some("x".repeat(200)),
        target_path: None,
        tool_use_id: None,
    };
    let t = action_text(&long, Some("C:/r"));
    assert_eq!(t.chars().count(), 80);
    assert!(t.ends_with('…'));
}

#[test]
fn gap_lines_use_formatter_and_are_bounded() {
    let mut gaps = Vec::new();
    for i in 0..6 {
        gaps.push(Gap {
            from_ms: 1_000_000 + i * 60_000,
            to_ms: 1_060_000 + i * 60_000,
            count: 1,
            reason: GapReason::HistoryFull,
        });
    }
    gaps.push(Gap {
        from_ms: 50_520_000,
        to_ms: 50_700_000,
        count: 3,
        reason: GapReason::SpoolFull,
    });
    let mut m = Model::new();
    m.apply(ServerMsg::Health {
        health: Health {
            gaps,
            ..Health::default()
        },
    });
    let w = m.warnings(&crate::clock::utc_hhmm);
    assert_eq!(w.len(), 6);
    assert_eq!(
        w[0],
        Msg::Gap {
            count: 3,
            from: "14:02".into(),
            to: "14:05".into(),
            reason: GapReason::SpoolFull,
        }
    );
    assert_eq!(
        w[..5]
            .iter()
            .filter(|m| matches!(m, Msg::Gap { .. }))
            .count(),
        5
    );
    assert_eq!(w[5], Msg::EarlierGaps { n: 2 });
    assert_eq!(
        en(&w[0]),
        "Missed 3 events between 14:02 and 14:05 (spool full)"
    );
    assert_eq!(
        en(&Msg::Gap {
            count: 1,
            from: "14:02".into(),
            to: "14:02".into(),
            reason: GapReason::BadFile,
        }),
        "Missed 1 event at 14:02 (bad file)"
    );
}

#[test]
fn every_nonzero_counter_has_a_sentence() {
    let mut m = Model::new();
    m.apply(ServerMsg::Health {
        health: Health {
            spool_pending: 1,
            spool_dropped: 1,
            dropped_events: 1,
            bad_files: 1,
            late_events: 1,
            hook_newer_than_daemon: true,
            settings_unreadable: true,
            ..Health::default()
        },
    });
    assert_eq!(
        m.warnings(&crate::clock::utc_hhmm),
        vec![
            Msg::SpoolPending { n: 1 },
            Msg::SpoolDropped { n: 1 },
            Msg::DroppedEvents { n: 1 },
            Msg::BadFiles { n: 1 },
            Msg::LateEvents { n: 1 },
            Msg::HookNewer,
            Msg::SettingsUnreadable,
        ]
    );
}

fn key(session: &str, agent_id: &str) -> AgentKey {
    AgentKey {
        session_id: session.into(),
        agent_id: agent_id.into(),
    }
}

fn timeline_msg(key: AgentKey, entries: Vec<TimelineEntry>) -> ServerMsg {
    ServerMsg::Timeline {
        id: 7,
        key,
        entries,
    }
}

fn entry(
    ms: u64,
    kind: TimelineKind,
    tool: Option<&str>,
    text: Option<&str>,
    outcome: Option<Outcome>,
) -> TimelineEntry {
    TimelineEntry {
        ms,
        kind,
        tool_name: tool.map(str::to_string),
        text: text.map(str::to_string),
        outcome,
        dur_ms: None,
    }
}

#[test]
fn opening_a_row_requests_its_timeline() {
    let mut m = Model::new();
    let a = key("S1", "");
    assert_eq!(m.toggle_open(&a), Some(a.clone()));
    assert!(m.is_open(&a));
    assert_eq!(m.toggle_open(&a), None);
    assert!(!m.is_open(&a));
}

#[test]
fn upsert_for_open_key_rerequests() {
    let a = key("S1", "");
    let b = key("S2", "");
    let mut m = Model::new();
    m.toggle_open(&a);
    assert_eq!(
        m.apply(ServerMsg::Status {
            op: StatusOp::Upsert,
            agent: agent("S1", "", Status::Working),
        }),
        vec![a.clone()]
    );
    assert_eq!(
        m.apply(ServerMsg::Status {
            op: StatusOp::Upsert,
            agent: agent("S2", "", Status::Working),
        }),
        Vec::<AgentKey>::new()
    );
    assert!(m.agents().contains_key(&b));
}

#[test]
fn settings_rerequests_every_open_timeline() {
    let a = key("S1", "");
    let b = key("S2", "");
    let mut m = Model::new();
    m.toggle_open(&a);
    m.toggle_open(&b);
    assert_eq!(
        m.apply(ServerMsg::Settings {
            settings: Settings::default(),
        }),
        vec![a, b]
    );
}

#[test]
fn snapshot_rerequests_present_keys_and_closes_missing() {
    let a = key("S1", "");
    let b = key("S2", "");
    let mut m = Model::new();
    m.toggle_open(&a);
    m.toggle_open(&b);
    m.apply(timeline_msg(
        b.clone(),
        vec![entry(1_000, TimelineKind::TurnStart, None, None, None)],
    ));
    assert_eq!(
        m.apply(snapshot(vec![agent("S1", "", Status::Working)])),
        vec![a.clone()]
    );
    assert!(m.is_open(&a));
    assert!(!m.is_open(&b));
    assert!(m.timeline_rows(&b, &crate::clock::utc_hhmm).is_empty());
}

#[test]
fn removed_agent_closes_its_timeline() {
    let a = key("S1", "");
    let mut m = Model::new();
    m.apply(snapshot(vec![agent("S1", "", Status::Working)]));
    m.toggle_open(&a);
    m.apply(timeline_msg(
        a.clone(),
        vec![entry(
            1_000,
            TimelineKind::Tool,
            Some("Bash"),
            Some("npm test"),
            Some(Outcome::Ok),
        )],
    ));
    assert_eq!(m.timeline_rows(&a, &crate::clock::utc_hhmm).len(), 1);
    assert_eq!(
        m.apply(ServerMsg::Status {
            op: StatusOp::Remove,
            agent: agent("S1", "", Status::Working),
        }),
        Vec::<AgentKey>::new()
    );
    assert!(!m.is_open(&a));
    assert!(m.timeline_rows(&a, &crate::clock::utc_hhmm).is_empty());
    assert_eq!(
        m.apply(ServerMsg::Status {
            op: StatusOp::Upsert,
            agent: agent("S1", "", Status::Working),
        }),
        Vec::<AgentKey>::new()
    );
}

#[test]
fn timeline_reply_for_closed_key_is_dropped() {
    let a = key("S1", "");
    let mut m = Model::new();
    m.apply(timeline_msg(
        a.clone(),
        vec![entry(1_000, TimelineKind::TurnStart, None, None, None)],
    ));
    assert!(m.timeline_rows(&a, &crate::clock::utc_hhmm).is_empty());
}

#[test]
fn timeline_rows_map_kinds_and_outcomes() {
    let a = key("S1", "");
    let mut m = Model::new();
    m.toggle_open(&a);
    m.apply(timeline_msg(
        a.clone(),
        vec![entry(
            50_520_000,
            TimelineKind::Tool,
            Some("Bash"),
            Some("npm test"),
            Some(Outcome::Pending),
        )],
    ));
    let rows = m.timeline_rows(&a, &crate::clock::utc_hhmm);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].time, "14:02");
    assert_eq!(en(&rows[0].text), "Bash npm test");
    assert_eq!(rows[0].outcome, Some(Outcome::Pending));
}

#[test]
fn timeline_entry_copy_reads_for_each_kind() {
    let a = key("S1", "");
    let mut m = Model::new();
    m.toggle_open(&a);
    m.apply(timeline_msg(
        a.clone(),
        vec![
            entry(1_000, TimelineKind::SessionStart, None, None, None),
            entry(2_000, TimelineKind::TurnStart, None, None, None),
            entry(
                3_000,
                TimelineKind::Tool,
                Some("Bash"),
                None,
                Some(Outcome::Ok),
            ),
            entry(4_000, TimelineKind::NeedsYou, Some("Bash"), None, None),
            entry(
                5_000,
                TimelineKind::SubagentStart,
                None,
                Some("Review the diff"),
                None,
            ),
            entry(6_000, TimelineKind::SubagentStop, None, None, None),
            entry(7_000, TimelineKind::TurnDone, None, None, Some(Outcome::Ok)),
            entry(
                8_000,
                TimelineKind::TurnFailed,
                None,
                None,
                Some(Outcome::Failed),
            ),
            entry(9_000, TimelineKind::Gap, None, Some("history full"), None),
            entry(10_000, TimelineKind::SessionEnd, None, None, None),
        ],
    ));
    let rows = m.timeline_rows(&a, &crate::clock::utc_hhmm);
    let text: Vec<String> = rows.iter().map(|r| en(&r.text)).collect();
    assert_eq!(
        text,
        vec![
            "session started",
            "turn started",
            "Bash",
            "needs you: Bash",
            "subagent started: Review the diff",
            "subagent stopped",
            "turn done",
            "turn failed",
            "events missed: history full",
            "session ended",
        ]
    );
    assert_eq!(tr(UiLang::Id, &rows[0].text), "sesi dimulai");
    assert_eq!(tr(UiLang::Id, &rows[2].text), "Bash");
    assert_eq!(en(&Msg::Outcome(Outcome::Ok)), "ok");
    assert_eq!(id(&Msg::Outcome(Outcome::Failed)), "gagal");
    assert_eq!(id(&Msg::Outcome(Outcome::Pending)), "tertunda");
}

#[test]
fn desk_ignores_card_messages() {
    use rocky_proto::cards::{CARD_VERSION, Card, CardStatus, Coverage, CoverageState, Importance};
    use rocky_proto::pipe::{BlockSnippet, DiffLine, DiffLineKind, SnippetLine};

    let sample_card = Card {
        v: CARD_VERSION,
        card_id: "c1".into(),
        rev: 1,
        repo_id: "r1".into(),
        root: String::new(),
        main_root: None,
        branch: Some("main".into()),
        session_id: "s1".into(),
        agent_id: "a1".into(),
        agent_type: "claude".into(),
        parent_card_id: None,
        started_ms: 1_000,
        ended_ms: Some(2_000),
        status: CardStatus::Done,
        prompt: "fix bug".into(),
        prompt_truncated: false,
        importance: Importance::Medium,
        blocks: Vec::new(),
        more_count: 0,
        flow: Vec::new(),
        flow_more: 0,
        outside_count: 0,
        reads: Vec::new(),
        reads_more: 0,
        coverage: Coverage {
            state: CoverageState::Full,
            reasons: Vec::new(),
        },
    };

    let mut m = Model::new();
    assert!(
        m.apply(ServerMsg::Cards {
            id: 1,
            items: vec![sample_card.clone()],
            next: Some("1000:c1".into()),
        })
        .is_empty()
    );
    assert!(
        m.apply(ServerMsg::Card {
            item: sample_card.clone(),
        })
        .is_empty()
    );
    assert!(
        m.apply(ServerMsg::CardDetail {
            id: 2,
            card: sample_card,
            snippets: vec![BlockSnippet {
                seq: 1,
                lines: vec![SnippetLine::Context {
                    text: "fn main() {}".into(),
                }],
            }],
        })
        .is_empty()
    );
    assert!(
        m.apply(ServerMsg::BlockDiff {
            id: 3,
            lines: vec![DiffLine {
                kind: DiffLineKind::Added,
                text: "let x = 1;".into(),
            }],
            page: 0,
            pages: 1,
            missing: false,
        })
        .is_empty()
    );
}

#[test]
fn wanted_idle_session_keeps_its_timeline() {
    let mut m = Model::new();
    m.apply(snapshot(vec![agent("s1", "", Status::Idle)]));
    let k = key("s1", "");
    assert_eq!(m.set_wanted(BTreeSet::from([k.clone()])), vec![k.clone()]);
    m.apply(timeline_msg(
        k.clone(),
        vec![entry(1, TimelineKind::Tool, Some("Bash"), None, None)],
    ));
    assert!(m.timeline(&k).is_some());
    m.set_wanted(BTreeSet::new());
    assert!(m.timeline(&k).is_none());
}

#[test]
fn upsert_of_a_wanted_idle_key_asks_for_its_timeline_again() {
    let mut m = Model::new();
    m.apply(snapshot(vec![agent("s1", "", Status::Idle)]));
    let k = key("s1", "");
    m.set_wanted(BTreeSet::from([k.clone()]));
    let asked = m.apply(ServerMsg::Status {
        op: StatusOp::Upsert,
        agent: agent("s1", "", Status::Idle),
    });
    assert_eq!(asked, vec![k]);
}

#[test]
fn set_wanted_skips_active_primaries_and_already_wanted_keys() {
    let mut m = Model::new();
    m.apply(snapshot(vec![
        agent("s1", "", Status::Working),
        agent("s2", "", Status::Idle),
    ]));
    let (a, b) = (key("s1", ""), key("s2", ""));
    assert_eq!(
        m.set_wanted(BTreeSet::from([a.clone(), b.clone()])),
        vec![b.clone()]
    );
    assert!(m.set_wanted(BTreeSet::from([a, b])).is_empty());
}

#[test]
fn closing_a_wanted_idle_row_keeps_its_timeline() {
    let mut m = Model::new();
    m.apply(snapshot(vec![agent("s1", "", Status::Idle)]));
    let k = key("s1", "");
    m.set_wanted(BTreeSet::from([k.clone()]));
    m.toggle_open(&k);
    m.apply(timeline_msg(
        k.clone(),
        vec![entry(1, TimelineKind::Tool, Some("Bash"), None, None)],
    ));
    m.toggle_open(&k);
    assert!(m.timeline(&k).is_some());
}

#[test]
fn snapshot_rerequests_wanted_keys() {
    let mut m = Model::new();
    let k = key("s2", "");
    m.set_wanted(BTreeSet::from([k.clone()]));

    let again = m.apply(snapshot(vec![agent("s2", "", Status::Idle)]));

    assert_eq!(again, vec![k]);
}

#[test]
fn snapshot_returns_a_key_both_open_and_wanted_once() {
    let mut m = Model::new();
    let k = key("s2", "");
    m.toggle_open(&k);
    m.set_wanted(BTreeSet::from([k.clone()]));

    let again = m.apply(snapshot(vec![agent("s2", "", Status::Idle)]));

    assert_eq!(again, vec![k]);
}
