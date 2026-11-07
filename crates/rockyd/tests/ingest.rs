//! Spool ingest + prune tests: files in, status changes out.

use std::fs;
use std::path::Path;

use rocky_proto::hook::{DropReason, HookEvent};
use rocky_proto::pipe::{AgentKey, RepoInfo};
use rocky_proto::spool::{SPOOL_VERSION, SpoolBody, SpoolRecord};
use rockyd::spool::{BAD_CAP, Ingestor, MAX_BYTES, MAX_FILES, prune};
use rockyd::state::StatusState;

fn stub_repo(_cwd: &str) -> RepoInfo {
    RepoInfo {
        root: None,
        name: "repo".into(),
        branch: None,
    }
}

fn event(name: &str, sid: &str) -> HookEvent {
    HookEvent {
        hook_event_name: name.into(),
        session_id: sid.into(),
        cwd: None,
        agent_id: None,
        agent_type: None,
        tool_name: None,
        tool_use_id: None,
        transcript_path: None,
        agent_transcript_path: None,
        notification_type: None,
        target_path: None,
        truncated: false,
    }
}

fn record(recv_ms: u64, ev: HookEvent) -> SpoolRecord {
    SpoolRecord {
        v: SPOOL_VERSION,
        harness: "claude-code".into(),
        recv_ms,
        body: SpoolBody::Event { event: ev },
    }
}

fn write_json(dir: &Path, file: &str, text: &str) {
    fs::write(dir.join(file), text).unwrap();
}

fn write_record(dir: &Path, file: &str, rec: &SpoolRecord) {
    write_json(dir, file, &serde_json::to_string(rec).unwrap());
}

fn json_left(dir: &Path) -> Vec<String> {
    let mut out: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".json"))
        .collect();
    out.sort();
    out
}

#[test]
fn ingests_in_name_order_and_deletes() {
    let dir = tempfile::tempdir().unwrap();
    // Written out of order; file-name order applies recv 1, 2, 3.
    // Any other order would trip the status-machine watermark (late > 0).
    write_record(
        dir.path(),
        "0000000000003-100.json",
        &record(3, event("SessionStart", "S1")),
    );
    write_record(
        dir.path(),
        "0000000000001-100.json",
        &record(1, event("SessionStart", "S1")),
    );
    write_record(
        dir.path(),
        "0000000000002-100.json",
        &record(2, event("SessionStart", "S1")),
    );
    let mut ing = Ingestor::new();
    let mut st = StatusState::new();
    let changes = ing.ingest_once(dir.path(), &mut st, &mut stub_repo);
    assert_eq!(
        changes.upserted,
        vec![AgentKey {
            session_id: "S1".into(),
            agent_id: String::new(),
        }]
    );
    assert!(changes.removed.is_empty());
    assert_eq!(ing.health.late_events, 0);
    assert_eq!(ing.health.spool_pending, 0);
    assert!(json_left(dir.path()).is_empty());
}

#[test]
fn tmp_files_ignored() {
    let dir = tempfile::tempdir().unwrap();
    write_json(dir.path(), "0000000000001-100.json.tmp", "not json {{{");
    write_record(
        dir.path(),
        "0000000000001-100.json",
        &record(1, event("SessionStart", "S1")),
    );
    let mut ing = Ingestor::new();
    let mut st = StatusState::new();
    let changes = ing.ingest_once(dir.path(), &mut st, &mut stub_repo);
    assert_eq!(changes.upserted.len(), 1);
    assert_eq!(ing.health.bad_files, 0);
    assert_eq!(ing.health.spool_pending, 0);
    assert!(dir.path().join("0000000000001-100.json.tmp").exists());
    assert!(json_left(dir.path()).is_empty());
}

#[test]
fn prune_by_count_and_bytes() {
    assert_eq!(MAX_FILES, 10_000);
    assert_eq!(MAX_BYTES, 50 * 1024 * 1024);
    assert_eq!(BAD_CAP, 100);

    let dir = tempfile::tempdir().unwrap();
    for i in 0..12 {
        write_json(dir.path(), &format!("f{i:02}.json"), "{}");
    }
    let n = prune(dir.path(), 10, u64::MAX).unwrap();
    assert_eq!(n, 2);
    assert!(!dir.path().join("f00.json").exists());
    assert!(!dir.path().join("f01.json").exists());
    assert!(dir.path().join("f02.json").exists());
    assert_eq!(json_left(dir.path()).len(), 10);

    let dir = tempfile::tempdir().unwrap();
    for i in 0..3 {
        fs::write(dir.path().join(format!("g{i}.json")), vec![b'x'; 10]).unwrap();
    }
    write_json(dir.path(), "big.json.tmp", &"y".repeat(100));
    let n = prune(dir.path(), usize::MAX, 25).unwrap();
    assert_eq!(n, 1);
    assert!(!dir.path().join("g0.json").exists());
    assert!(dir.path().join("g1.json").exists());
    assert!(dir.path().join("big.json.tmp").exists());
    let n = prune(dir.path(), usize::MAX, 25).unwrap();
    assert_eq!(n, 0);
}

#[test]
fn corrupt_goes_to_bad_with_cap() {
    let dir = tempfile::tempdir().unwrap();
    for i in 0..105 {
        write_json(dir.path(), &format!("{i:03}.json"), "not json {{{");
    }
    let mut ing = Ingestor::new();
    let mut st = StatusState::new();
    let changes = ing.ingest_once(dir.path(), &mut st, &mut stub_repo);
    assert!(changes.upserted.is_empty());
    assert_eq!(ing.health.bad_files, 105);
    assert!(!ing.health.hook_newer_than_daemon);
    assert_eq!(ing.health.spool_pending, 0);
    assert!(json_left(dir.path()).is_empty());
    let bad = dir.path().join("bad");
    assert_eq!(json_left(&bad).len(), 100);
    assert!(!bad.join("004.json").exists());
    assert!(bad.join("005.json").exists());
    assert!(bad.join("104.json").exists());
}

#[test]
fn newer_version_flags_health() {
    let dir = tempfile::tempdir().unwrap();
    let mut v2 = serde_json::to_value(record(1, event("SessionStart", "S1"))).unwrap();
    v2["v"] = serde_json::json!(2);
    write_json(dir.path(), "n1.json", &serde_json::to_string(&v2).unwrap());
    // Valid JSON with a newer v, but not a parseable record.
    write_json(dir.path(), "n2.json", r#"{"v":3,"kind":"event"}"#);
    let mut ing = Ingestor::new();
    let mut st = StatusState::new();
    ing.ingest_once(dir.path(), &mut st, &mut stub_repo);
    assert_eq!(ing.health.bad_files, 2);
    assert!(ing.health.hook_newer_than_daemon);
    assert_eq!(ing.health.spool_pending, 0);
    assert_eq!(json_left(&dir.path().join("bad")).len(), 2);
    assert!(st.agents().is_empty());

    // Older v goes to bad/ without the flag.
    let dir = tempfile::tempdir().unwrap();
    let mut v0 = serde_json::to_value(record(1, event("SessionStart", "S1"))).unwrap();
    v0["v"] = serde_json::json!(0);
    write_json(dir.path(), "o.json", &serde_json::to_string(&v0).unwrap());
    let mut ing = Ingestor::new();
    let mut st = StatusState::new();
    ing.ingest_once(dir.path(), &mut st, &mut stub_repo);
    assert_eq!(ing.health.bad_files, 1);
    assert!(!ing.health.hook_newer_than_daemon);
    assert!(st.agents().is_empty());
}

#[test]
fn dropped_record_counts() {
    let dir = tempfile::tempdir().unwrap();
    write_record(
        dir.path(),
        "0000000000001-100.json",
        &SpoolRecord {
            v: SPOOL_VERSION,
            harness: "claude-code".into(),
            recv_ms: 1,
            body: SpoolBody::Dropped {
                reason: DropReason::Parse,
                bytes: 10,
            },
        },
    );
    let mut ing = Ingestor::new();
    let mut st = StatusState::new();
    let changes = ing.ingest_once(dir.path(), &mut st, &mut stub_repo);
    assert!(changes.upserted.is_empty());
    assert_eq!(ing.health.dropped_events, 1);
    assert_eq!(ing.health.spool_pending, 0);
    assert!(json_left(dir.path()).is_empty());
    assert!(st.agents().is_empty());
}

#[test]
fn late_record_counts_and_deletes() {
    let dir = tempfile::tempdir().unwrap();
    // Name order applies recv 5 first, so recv 3 arrives late.
    write_record(
        dir.path(),
        "a.json",
        &record(5, event("SessionStart", "S1")),
    );
    write_record(
        dir.path(),
        "b.json",
        &record(3, event("SessionStart", "S1")),
    );
    let mut ing = Ingestor::new();
    let mut st = StatusState::new();
    ing.ingest_once(dir.path(), &mut st, &mut stub_repo);
    assert_eq!(ing.health.late_events, 1);
    assert_eq!(ing.health.spool_pending, 0);
    assert!(json_left(dir.path()).is_empty());
}

#[test]
#[cfg(windows)]
fn failed_delete_never_reapplies() {
    use std::os::windows::fs::OpenOptionsExt;

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("0000000000001-100.json");
    write_record(
        dir.path(),
        "0000000000001-100.json",
        &record(1, event("PostToolUseFailure", "S1")),
    );
    let key = AgentKey {
        session_id: "S1".into(),
        agent_id: String::new(),
    };
    let mut ing = Ingestor::new();
    let mut st = StatusState::new();
    {
        // FILE_SHARE_READ: ingest can read+apply, but delete fails.
        let _held = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&path)
            .unwrap();
        let first = ing.ingest_once(dir.path(), &mut st, &mut stub_repo);
        assert_eq!(first.upserted, vec![key.clone()]);
        assert_eq!(st.get(&key).unwrap().failures, 1);
        assert!(path.exists());

        let second = ing.ingest_once(dir.path(), &mut st, &mut stub_repo);
        assert!(second.upserted.is_empty());
        assert_eq!(st.get(&key).unwrap().failures, 1);
        assert!(path.exists());
        assert_eq!(ing.health.late_events, 0);
    }
    let third = ing.ingest_once(dir.path(), &mut st, &mut stub_repo);
    assert!(third.upserted.is_empty());
    assert!(!path.exists());
    assert_eq!(st.get(&key).unwrap().failures, 1);
    assert_eq!(ing.health.spool_pending, 0);
}
