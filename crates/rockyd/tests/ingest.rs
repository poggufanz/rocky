//! Spool ingest + prune tests: files in, status changes out.

use std::collections::HashSet;
use std::fs;
use std::path::Path;

use rocky_proto::hook::{DropReason, HookEvent};
use rocky_proto::pipe::{AgentKey, Gap, GapReason, RepoInfo};
use rocky_proto::spool::{SPOOL_VERSION, SpoolBody, SpoolRecord};
use rockyd::gaps::Gaps;
use rockyd::history::{HISTORY_CAP_BYTES, History, replay};
use rockyd::spool::{BAD_CAP, Ingestor, MAX_BYTES, MAX_FILES, prune};
use rockyd::state::StatusState;

/// Fixed clock: 2023-11-14T22:13:20Z, no test depends on wall time.
const NOW: u64 = 1_700_000_000_000;

fn stub_repo(_cwd: &str) -> RepoInfo {
    RepoInfo {
        root: None,
        main_root: None,
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
        command: None,
        description: None,
        prompt: None,
        truncated: false,
    }
}

fn record(recv_ms: u64, ev: HookEvent) -> SpoolRecord {
    SpoolRecord {
        v: SPOOL_VERSION,
        harness: "claude-code".into(),
        recv_ms,
        config_dir: None,
        body: SpoolBody::Event { event: ev },
    }
}

/// A history directory plus its open [`History`]; keep the temp dir alive.
fn hist() -> (tempfile::TempDir, History) {
    let dir = tempfile::tempdir().unwrap();
    let history = History::open(dir.path(), HISTORY_CAP_BYTES, true);
    (dir, history)
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

fn history_bytes(dir: &Path) -> Vec<u8> {
    let mut out = Vec::new();
    for entry in fs::read_dir(dir).unwrap().flatten() {
        out.extend(fs::read(entry.path()).unwrap());
    }
    out
}

fn sorted_srcs(srcs: HashSet<String>) -> Vec<String> {
    let mut out: Vec<String> = srcs.into_iter().collect();
    out.sort();
    out
}

#[test]
fn consumed_files_land_in_history_with_src() {
    let dir = tempfile::tempdir().unwrap();
    let (_h, mut history) = hist();
    write_record(
        dir.path(),
        "0000000000001-1.json",
        &record(1, event("SessionStart", "S1")),
    );
    write_record(
        dir.path(),
        "0000000000002-1.json",
        &record(2, event("SessionStart", "S2")),
    );
    let mut ing = Ingestor::new();
    let mut st = StatusState::new();
    let out = ing.ingest_once(dir.path(), &mut st, &mut stub_repo, &mut history, NOW);
    assert_eq!(out.changes.upserted.len(), 2);
    assert!(out.gaps.is_empty());
    assert_eq!(out.history_errors, 0);
    assert!(json_left(dir.path()).is_empty());

    let mut fresh = StatusState::new();
    let mut gaps = Gaps::new();
    let srcs = replay(&history, &mut fresh, &mut gaps, &mut stub_repo);
    let sids: Vec<String> = fresh
        .agents()
        .into_iter()
        .map(|a| a.key.session_id)
        .collect();
    assert_eq!(sids, vec!["S1".to_string(), "S2".to_string()]);
    assert_eq!(
        sorted_srcs(srcs),
        vec![
            "0000000000001-1.json".to_string(),
            "0000000000002-1.json".to_string()
        ]
    );
    assert!(gaps.to_vec().is_empty());
}

#[test]
fn seeded_names_are_deleted_not_reapplied() {
    let dir = tempfile::tempdir().unwrap();
    let (hdir, mut history) = hist();
    write_record(
        dir.path(),
        "0000000000005-1.json",
        &record(5, event("SessionStart", "S1")),
    );
    let names: HashSet<String> = ["0000000000005-1.json".to_string()].into();
    let mut ing = Ingestor::new();
    ing.seed_applied(dir.path(), &names);
    let mut st = StatusState::new();
    let out = ing.ingest_once(dir.path(), &mut st, &mut stub_repo, &mut history, NOW);
    assert!(!dir.path().join("0000000000005-1.json").exists());
    assert!(st.agents().is_empty());
    assert!(out.changes.upserted.is_empty());
    assert!(out.changes.removed.is_empty());
    assert_eq!(fs::read_dir(hdir.path()).unwrap().count(), 0);
}

#[test]
fn dropped_and_bad_files_become_gaps() {
    let dir = tempfile::tempdir().unwrap();
    let (_h, mut history) = hist();
    write_record(
        dir.path(),
        "0000000000007-1.json",
        &SpoolRecord {
            v: SPOOL_VERSION,
            harness: "claude-code".into(),
            recv_ms: 7,
            config_dir: None,
            body: SpoolBody::Dropped {
                reason: DropReason::Parse,
                bytes: 10,
            },
        },
    );
    write_json(dir.path(), "0000000000009-1.json", "{bad");
    let mut ing = Ingestor::new();
    let mut st = StatusState::new();
    let out = ing.ingest_once(dir.path(), &mut st, &mut stub_repo, &mut history, NOW);
    let want = vec![
        Gap {
            from_ms: 7,
            to_ms: 7,
            count: 1,
            reason: GapReason::HookDropped,
        },
        Gap {
            from_ms: 9,
            to_ms: 9,
            count: 1,
            reason: GapReason::BadFile,
        },
    ];
    assert_eq!(out.gaps, want);
    assert_eq!(ing.health.dropped_events, 1);
    assert_eq!(ing.health.bad_files, 1);
    assert!(json_left(dir.path()).is_empty());
    assert_eq!(
        json_left(&dir.path().join("bad")),
        vec!["0000000000009-1.json"]
    );

    let mut fresh = StatusState::new();
    let mut gaps = Gaps::new();
    let srcs = replay(&history, &mut fresh, &mut gaps, &mut stub_repo);
    assert_eq!(gaps.to_vec(), want);
    assert_eq!(
        sorted_srcs(srcs),
        vec![
            "0000000000007-1.json".to_string(),
            "0000000000009-1.json".to_string()
        ]
    );
}

#[test]
fn prune_reports_spool_full_range() {
    let dir = tempfile::tempdir().unwrap();
    for ms in [100u64, 200, 300] {
        write_json(dir.path(), &format!("{ms:013}-1.json"), "{}");
    }
    let pruned = prune(dir.path(), 1, u64::MAX, NOW).unwrap();
    assert_eq!(pruned.deleted, 2);
    assert_eq!(
        pruned.gap,
        Some(Gap {
            from_ms: 100,
            to_ms: 200,
            count: 2,
            reason: GapReason::SpoolFull,
        })
    );
    assert_eq!(json_left(dir.path()), vec!["0000000000300-1.json"]);

    // No deleted name carries a timestamp prefix: the gap falls back to now.
    let dir = tempfile::tempdir().unwrap();
    write_json(dir.path(), "a.json", "{}");
    let pruned = prune(dir.path(), 0, u64::MAX, NOW).unwrap();
    assert_eq!(
        pruned.gap,
        Some(Gap {
            from_ms: NOW,
            to_ms: NOW,
            count: 1,
            reason: GapReason::SpoolFull,
        })
    );
}

#[test]
fn tool_text_off_keeps_text_out_of_history() {
    let dir = tempfile::tempdir().unwrap();
    let (hdir, mut history) = hist();
    let mut ev = event("PreToolUse", "S1");
    ev.tool_name = Some("Bash".into());
    ev.tool_use_id = Some("t1".into());
    ev.command = Some("npm test".into());
    write_record(dir.path(), "0000000000001-1.json", &record(1, ev));
    let mut ing = Ingestor::new();
    let mut st = StatusState::new();
    st.set_tool_text(false);
    ing.ingest_once(dir.path(), &mut st, &mut stub_repo, &mut history, NOW);
    let bytes = history_bytes(hdir.path());
    assert!(!bytes.is_empty(), "event line was not written");
    let text = String::from_utf8_lossy(&bytes);
    assert!(text.contains(r#""kind":"event""#), "{text}");
    assert!(!text.contains("npm test"), "{text}");
}

#[test]
fn ingests_in_name_order_and_deletes() {
    let dir = tempfile::tempdir().unwrap();
    let (_h, mut history) = hist();
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
    let changes = ing
        .ingest_once(dir.path(), &mut st, &mut stub_repo, &mut history, NOW)
        .changes;
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
    let (_h, mut history) = hist();
    write_json(dir.path(), "0000000000001-100.json.tmp", "not json {{{");
    write_record(
        dir.path(),
        "0000000000001-100.json",
        &record(1, event("SessionStart", "S1")),
    );
    let mut ing = Ingestor::new();
    let mut st = StatusState::new();
    let changes = ing
        .ingest_once(dir.path(), &mut st, &mut stub_repo, &mut history, NOW)
        .changes;
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
    let pruned = prune(dir.path(), 10, u64::MAX, NOW).unwrap();
    assert_eq!(pruned.deleted, 2);
    assert_eq!(
        pruned.gap,
        Some(Gap {
            from_ms: NOW,
            to_ms: NOW,
            count: 2,
            reason: GapReason::SpoolFull,
        })
    );
    assert!(!dir.path().join("f00.json").exists());
    assert!(!dir.path().join("f01.json").exists());
    assert!(dir.path().join("f02.json").exists());
    assert_eq!(json_left(dir.path()).len(), 10);

    let dir = tempfile::tempdir().unwrap();
    for i in 0..3 {
        fs::write(dir.path().join(format!("g{i}.json")), vec![b'x'; 10]).unwrap();
    }
    write_json(dir.path(), "big.json.tmp", &"y".repeat(100));
    let pruned = prune(dir.path(), usize::MAX, 25, NOW).unwrap();
    assert_eq!(pruned.deleted, 1);
    assert!(pruned.gap.is_some());
    assert!(!dir.path().join("g0.json").exists());
    assert!(dir.path().join("g1.json").exists());
    assert!(dir.path().join("big.json.tmp").exists());
    let pruned = prune(dir.path(), usize::MAX, 25, NOW).unwrap();
    assert_eq!(pruned.deleted, 0);
    assert_eq!(pruned.gap, None);
}

#[test]
fn corrupt_goes_to_bad_with_cap() {
    let dir = tempfile::tempdir().unwrap();
    let (_h, mut history) = hist();
    for i in 0..105 {
        write_json(dir.path(), &format!("{i:03}.json"), "not json {{{");
    }
    let mut ing = Ingestor::new();
    let mut st = StatusState::new();
    let changes = ing
        .ingest_once(dir.path(), &mut st, &mut stub_repo, &mut history, NOW)
        .changes;
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
    let (_h, mut history) = hist();
    let mut v2 = serde_json::to_value(record(1, event("SessionStart", "S1"))).unwrap();
    v2["v"] = serde_json::json!(2);
    write_json(dir.path(), "n1.json", &serde_json::to_string(&v2).unwrap());
    // Valid JSON with a newer v, but not a parseable record.
    write_json(dir.path(), "n2.json", r#"{"v":3,"kind":"event"}"#);
    let mut ing = Ingestor::new();
    let mut st = StatusState::new();
    ing.ingest_once(dir.path(), &mut st, &mut stub_repo, &mut history, NOW);
    assert_eq!(ing.health.bad_files, 2);
    assert!(ing.health.hook_newer_than_daemon);
    assert_eq!(ing.health.spool_pending, 0);
    assert_eq!(json_left(&dir.path().join("bad")).len(), 2);
    assert!(st.agents().is_empty());

    // Older v goes to bad/ without the flag.
    let dir = tempfile::tempdir().unwrap();
    let (_h2, mut history) = hist();
    let mut v0 = serde_json::to_value(record(1, event("SessionStart", "S1"))).unwrap();
    v0["v"] = serde_json::json!(0);
    write_json(dir.path(), "o.json", &serde_json::to_string(&v0).unwrap());
    let mut ing = Ingestor::new();
    let mut st = StatusState::new();
    ing.ingest_once(dir.path(), &mut st, &mut stub_repo, &mut history, NOW);
    assert_eq!(ing.health.bad_files, 1);
    assert!(!ing.health.hook_newer_than_daemon);
    assert!(st.agents().is_empty());
}

#[test]
fn dropped_record_counts() {
    let dir = tempfile::tempdir().unwrap();
    let (_h, mut history) = hist();
    write_record(
        dir.path(),
        "0000000000001-100.json",
        &SpoolRecord {
            v: SPOOL_VERSION,
            harness: "claude-code".into(),
            recv_ms: 1,
            config_dir: None,
            body: SpoolBody::Dropped {
                reason: DropReason::Parse,
                bytes: 10,
            },
        },
    );
    let mut ing = Ingestor::new();
    let mut st = StatusState::new();
    let changes = ing
        .ingest_once(dir.path(), &mut st, &mut stub_repo, &mut history, NOW)
        .changes;
    assert!(changes.upserted.is_empty());
    assert_eq!(ing.health.dropped_events, 1);
    assert_eq!(ing.health.spool_pending, 0);
    assert!(json_left(dir.path()).is_empty());
    assert!(st.agents().is_empty());
}

#[test]
fn late_record_counts_and_deletes() {
    let dir = tempfile::tempdir().unwrap();
    let (_h, mut history) = hist();
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
    ing.ingest_once(dir.path(), &mut st, &mut stub_repo, &mut history, NOW);
    assert_eq!(ing.health.late_events, 1);
    assert_eq!(ing.health.spool_pending, 0);
    assert!(json_left(dir.path()).is_empty());
}

#[test]
#[cfg(windows)]
fn failed_delete_never_reapplies() {
    use std::os::windows::fs::OpenOptionsExt;

    let dir = tempfile::tempdir().unwrap();
    let (_h, mut history) = hist();
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
        let first = ing
            .ingest_once(dir.path(), &mut st, &mut stub_repo, &mut history, NOW)
            .changes;
        assert_eq!(first.upserted, vec![key.clone()]);
        assert_eq!(st.get(&key).unwrap().failures, 1);
        assert!(path.exists());

        let second = ing
            .ingest_once(dir.path(), &mut st, &mut stub_repo, &mut history, NOW)
            .changes;
        assert!(second.upserted.is_empty());
        assert_eq!(st.get(&key).unwrap().failures, 1);
        assert!(path.exists());
        assert_eq!(ing.health.late_events, 0);
    }
    let third = ing
        .ingest_once(dir.path(), &mut st, &mut stub_repo, &mut history, NOW)
        .changes;
    assert!(third.upserted.is_empty());
    assert!(!path.exists());
    assert_eq!(st.get(&key).unwrap().failures, 1);
    assert_eq!(ing.health.spool_pending, 0);
}
