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

#[test]
fn replay_helper_tracks_all_agents() {
    let seen = replay_fixture("stop-failure.jsonl");
    assert_eq!(seen.len(), 1);
    assert!(seen.keys().all(|k| k.session_id == "S9"));
}
