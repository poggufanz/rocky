//! Golden replay: real session fixtures through the status machine.

use std::collections::BTreeMap;

use rocky_proto::pipe::{AgentKey, Status};
use rocky_proto::spool::{SpoolBody, SpoolRecord};
use rockyd::repo::resolve_repo;
use rockyd::state::StatusState;

fn replay_fixture(name: &str) -> BTreeMap<AgentKey, Vec<Status>> {
    let path = format!(
        "{}/../../fixtures/hooks/claude-code-2.1.319/{name}",
        env!("CARGO_MANIFEST_DIR")
    );
    let text = std::fs::read_to_string(&path).unwrap();
    let mut st = StatusState::new();
    let mut seen: BTreeMap<AgentKey, Vec<Status>> = BTreeMap::new();
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        let rec: SpoolRecord = serde_json::from_str(line).unwrap();
        if let SpoolBody::Event { event } = rec.body {
            let _ = st.apply(&event, rec.recv_ms, &mut resolve_repo);
            for a in st.agents() {
                let entry = seen.entry(a.key.clone()).or_default();
                if entry.last() != Some(&a.status) {
                    entry.push(a.status);
                }
            }
        }
    }
    seen
}

fn main_agent<'a>(seen: &'a BTreeMap<AgentKey, Vec<Status>>, sid: &str) -> &'a [Status] {
    &seen[&AgentKey {
        session_id: sid.into(),
        agent_id: String::new(),
    }]
}

#[test]
fn stop_failure_session_ends_failed() {
    let seen = replay_fixture("stop-failure.jsonl");
    let statuses = main_agent(&seen, "S9");
    assert_eq!(
        statuses,
        &[Status::Idle, Status::Working, Status::Failed],
        "main agent statuses: {statuses:?}"
    );
}

fn key(sid: &str, aid: &str) -> AgentKey {
    AgentKey {
        session_id: sid.into(),
        agent_id: aid.into(),
    }
}

#[test]
fn real_session_main_agent_flow() {
    let seen = replay_fixture("session.jsonl");
    let s1 = main_agent(&seen, "S1");
    assert_eq!(s1.first(), Some(&Status::Idle), "{s1:?}");
    assert_eq!(s1.last(), Some(&Status::Ended), "{s1:?}");
    assert!(s1.contains(&Status::Done), "{s1:?}");
    // A PermissionRequest flips to NeedsYou; the answered tool's PostToolUse flips back.
    assert!(
        s1.windows(2)
            .any(|w| w == [Status::NeedsYou, Status::Working]),
        "{s1:?}"
    );
}

#[test]
fn real_subagent_tracked_and_helper_stops_ignored() {
    let seen = replay_fixture("session.jsonl");
    // A4 is the only subagent with a SubagentStart. A1-A3 and A5-A9 arrive as a
    // bare SubagentStop (agent_type "") after turns: internal helpers, not rows.
    let keys: Vec<AgentKey> = seen.keys().cloned().collect();
    assert_eq!(keys, [key("S1", ""), key("S1", "A4"), key("S2", "")]);
    assert_eq!(
        seen[&key("S1", "A4")],
        [Status::Working, Status::Done, Status::Ended]
    );
}

#[test]
fn async_post_tool_use_after_stop_keeps_done() {
    // S2 ran PostToolUse as an async hook that slept 3 s, so it lands after Stop.
    let seen = replay_fixture("session.jsonl");
    assert_eq!(
        main_agent(&seen, "S2"),
        &[Status::Idle, Status::Working, Status::Done]
    );
}

#[test]
fn replay_helper_tracks_all_agents() {
    let seen = replay_fixture("stop-failure.jsonl");
    assert_eq!(seen.len(), 1);
    assert!(seen.keys().all(|k| k.session_id == "S9"));
}
