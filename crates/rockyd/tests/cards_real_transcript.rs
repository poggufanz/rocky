//! Real Claude Code 2.1.325 transcript fixture and tracker integration tests.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use rocky_proto::pipe::{AgentKey, RepoInfo};
use rocky_proto::spool::{SpoolBody, SpoolRecord};
use rockyd::cards::transcript::{read_quotes, validate_transcript_path};
use rockyd::cards::windows::{ToolKind, Tracker, TrackerSignal, TurnEnd};
use serde_json::Value;
use tempfile::TempDir;

const SESSION_ID: &str = "bc872098-2865-4f6d-9f6a-bd1a1ce52131";
const SUBAGENT_ID: &str = "ab84124e0de11b590";
const REPO_SLUG: &str = "C--work-fixture-repo";
const FIXTURE_REPO: &str = r"C:\work\fixture-repo";

const MAIN_EDIT_TOOL_ID: &str = "toolu_013cLuVHFNaghtzsurfQgqrB";
const SUBAGENT_READ_TOOL_ID: &str = "toolu_01N6fHzu4K6U2Z1Eq8wbLez5";
const SUBAGENT_EDIT_TOOL_ID: &str = "toolu_01LdWr9ZxzAFzY92fEP4RJyZ";

struct RealFixture {
    _tmp: TempDir,
    config_dirs: Vec<PathBuf>,
    main_transcript: PathBuf,
    subagent_transcript: PathBuf,
    spool_records: Vec<(SpoolRecord, rocky_proto::hook::HookEvent)>,
}

fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/transcripts/claude-code-2.1.325")
}

fn canonical_temp_root(path: &Path) -> PathBuf {
    let canon = fs::canonicalize(path).expect("canonicalize tempdir");
    #[cfg(windows)]
    if let Some(stripped) = canon.to_str().and_then(|s| s.strip_prefix(r"\\?\")) {
        return PathBuf::from(stripped);
    }
    canon
}

impl RealFixture {
    fn load() -> Self {
        let tmp = TempDir::new().expect("tempdir");
        let root = canonical_temp_root(tmp.path());
        let config_dir = root.join("config");
        let project_dir = config_dir.join("projects").join(REPO_SLUG);
        let subagents_dir = project_dir.join(SESSION_ID).join("subagents");
        fs::create_dir_all(&subagents_dir).expect("create subagents dir");

        let src_dir = fixture_dir();
        let main_transcript = project_dir.join(format!("{SESSION_ID}.jsonl"));
        let subagent_transcript = subagents_dir.join(format!("agent-{SUBAGENT_ID}.jsonl"));
        fs::copy(src_dir.join("transcript.jsonl"), &main_transcript).expect("copy main transcript");
        fs::copy(
            src_dir.join(format!("subagent-agent-{SUBAGENT_ID}.jsonl")),
            &subagent_transcript,
        )
        .expect("copy subagent transcript");

        let spool_text = fs::read_to_string(src_dir.join("spool.jsonl")).expect("read spool.jsonl");
        let mut spool_records = Vec::new();
        for line in spool_text.lines().filter(|l| !l.trim().is_empty()) {
            let rec: SpoolRecord = serde_json::from_str(line).expect("parse SpoolRecord");
            assert_eq!(rec.harness, "claude-code");
            let SpoolBody::Event { event } = rec.body.clone() else {
                panic!("expected event record in spool.jsonl");
            };
            spool_records.push((rec, event));
        }

        Self {
            _tmp: tmp,
            config_dirs: vec![config_dir],
            main_transcript,
            subagent_transcript,
            spool_records,
        }
    }

    fn main_started_ms(&self) -> u64 {
        self.spool_records
            .iter()
            .find(|(_, ev)| ev.hook_event_name == "UserPromptSubmit")
            .map(|(rec, _)| rec.recv_ms)
            .expect("UserPromptSubmit in spool.jsonl")
    }

    fn subagent_started_ms(&self) -> u64 {
        self.spool_records
            .iter()
            .find(|(_, ev)| {
                ev.hook_event_name == "SubagentStart" && ev.agent_id.as_deref() == Some(SUBAGENT_ID)
            })
            .map(|(rec, _)| rec.recv_ms)
            .expect("SubagentStart in spool.jsonl")
    }
}

fn collect_tool_ids_from_jsonl(path: &Path) -> Vec<String> {
    let raw = fs::read_to_string(path).expect("read transcript");
    let mut ids = BTreeSet::new();
    for line in raw.lines().filter(|l| !l.trim().is_empty()) {
        let val: Value = serde_json::from_str(line).expect("parse transcript line");
        if let Some(blocks) = val
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(Value::as_array)
        {
            for block in blocks {
                if block.get("type").and_then(Value::as_str) == Some("tool_use")
                    && let Some(id) = block.get("id").and_then(Value::as_str)
                    && !id.is_empty()
                {
                    ids.insert(id.to_string());
                }
            }
        }
    }
    ids.into_iter().collect()
}

fn test_repo_resolver(cwd: &str) -> RepoInfo {
    assert_eq!(cwd, FIXTURE_REPO, "unexpected cwd in spool fixture");
    RepoInfo {
        root: Some(FIXTURE_REPO.to_string()),
        main_root: Some(FIXTURE_REPO.to_string()),
        name: "fixture-repo".to_string(),
        branch: Some("main".to_string()),
    }
}

#[test]
fn real_transcript_quotes_main_edit() {
    let fx = RealFixture::load();
    let raw_path = fx.main_transcript.to_str().expect("utf-8 main path");
    let validated =
        validate_transcript_path(raw_path, &fx.config_dirs).expect("main path should validate");
    assert_eq!(validated, fx.main_transcript);

    let out = read_quotes(
        &validated,
        &[MAIN_EDIT_TOOL_ID.to_string()],
        fx.main_started_ms(),
    )
    .expect("read main transcript");

    assert!(out.complete);
    let quote = out
        .quotes
        .get(MAIN_EDIT_TOOL_ID)
        .expect("quote for main edit tool");
    assert!(!quote.shared);
    assert_eq!(
        quote.text,
        "Saya akan menambahkan guard di awal `applyDiscount` supaya fungsi mengembalikan `total` apa adanya ketika member tidak aktif."
    );
}

#[test]
fn real_transcript_quotes_subagent_edit() {
    let fx = RealFixture::load();
    let raw_path = fx
        .subagent_transcript
        .to_str()
        .expect("utf-8 subagent path");
    let validated =
        validate_transcript_path(raw_path, &fx.config_dirs).expect("subagent path should validate");
    assert_eq!(validated, fx.subagent_transcript);

    let out = read_quotes(
        &validated,
        &[SUBAGENT_EDIT_TOOL_ID.to_string()],
        fx.subagent_started_ms(),
    )
    .expect("read subagent transcript");

    assert!(out.complete);
    let quote = out
        .quotes
        .get(SUBAGENT_EDIT_TOOL_ID)
        .expect("quote for subagent edit tool");
    assert!(!quote.shared);
    assert_eq!(
        quote.text,
        "Saya akan menambahkan fungsi `total` di akhir src/lib.rs untuk menjumlahkan harga semua item sebagai u32."
    );
    let (first_user, _) = out
        .first_user_text
        .as_ref()
        .expect("subagent first_user_text");
    assert!(
        first_user.starts_with(r"Working directory: C:\work\fixture-repo"),
        "unexpected first_user_text: {first_user:?}"
    );
}

#[test]
fn real_transcript_tool_use_without_prior_text_has_no_quote() {
    let fx = RealFixture::load();
    let raw_path = fx
        .subagent_transcript
        .to_str()
        .expect("utf-8 subagent path");
    let validated =
        validate_transcript_path(raw_path, &fx.config_dirs).expect("subagent path should validate");

    let out = read_quotes(
        &validated,
        &[SUBAGENT_READ_TOOL_ID.to_string()],
        fx.subagent_started_ms(),
    )
    .expect("read subagent transcript");

    assert!(out.complete);
    assert!(
        !out.quotes.contains_key(SUBAGENT_READ_TOOL_ID),
        "unexpected quote for tool without prior text: {:?}",
        out.quotes
    );
}

#[test]
fn real_transcript_blocks_split_across_lines_share_message_id() {
    let main_raw =
        fs::read_to_string(fixture_dir().join("transcript.jsonl")).expect("read transcript.jsonl");

    let mut text_lines: Vec<(usize, String)> = Vec::new();
    let mut tool_line: Option<(usize, String)> = None;

    for (idx, line) in main_raw.lines().enumerate() {
        let val: Value = serde_json::from_str(line).expect("parse transcript line");
        if val.get("type").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let msg_id = val
            .get("message")
            .and_then(|m| m.get("id"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let Some(blocks) = val
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(Value::as_array)
        else {
            continue;
        };
        for block in blocks {
            match block.get("type").and_then(Value::as_str) {
                Some("text")
                    if block.get("text").and_then(Value::as_str).is_some_and(|t| {
                        t.starts_with("Saya akan menambahkan guard di awal `applyDiscount`")
                    }) =>
                {
                    text_lines.push((idx + 1, msg_id.clone()));
                }
                Some("tool_use")
                    if block.get("id").and_then(Value::as_str) == Some(MAIN_EDIT_TOOL_ID) =>
                {
                    tool_line = Some((idx + 1, msg_id.clone()));
                }
                _ => {}
            }
        }
    }

    assert_eq!(text_lines.len(), 1);
    let (text_ln, text_mid) = text_lines.pop().unwrap();
    let (tool_ln, tool_mid) = tool_line.expect("assistant tool_use line for MAIN_EDIT_TOOL_ID");
    assert_ne!(
        text_ln, tool_ln,
        "text and tool_use should be on separate JSONL lines"
    );
    assert!(!text_mid.is_empty());
    assert_eq!(
        text_mid, tool_mid,
        "separate lines must share the same message.id"
    );
}

#[test]
fn real_transcript_never_quotes_thinking_or_non_assistant() {
    let fx = RealFixture::load();
    let main_ids = collect_tool_ids_from_jsonl(&fx.main_transcript);
    let sub_ids = collect_tool_ids_from_jsonl(&fx.subagent_transcript);
    assert!(!main_ids.is_empty());
    assert!(!sub_ids.is_empty());

    let main_out =
        read_quotes(&fx.main_transcript, &main_ids, fx.main_started_ms()).expect("read main");
    let sub_out = read_quotes(&fx.subagent_transcript, &sub_ids, fx.subagent_started_ms())
        .expect("read subagent");

    for out in [&main_out, &sub_out] {
        assert!(out.complete);
        for quote in out.quotes.values() {
            assert!(
                !quote.text.contains("THINKING_MARKER_DO_NOT_QUOTE"),
                "thinking marker leaked into quote: {:?}",
                quote.text
            );
            assert!(
                !quote.text.contains("NON_ASSISTANT_DUPLICATE_DO_NOT_QUOTE"),
                "non-assistant duplicate leaked into quote: {:?}",
                quote.text
            );
        }
    }
}

#[test]
fn real_spool_drives_tracker_turns() {
    let fx = RealFixture::load();
    let mut tracker = Tracker::new();

    let mut stop_transcript_path = None;
    let mut subagent_stop_transcript_path = None;
    let mut all_signals = Vec::new();

    for (rec, ev) in &fx.spool_records {
        let repo = ev
            .cwd
            .as_deref()
            .map(test_repo_resolver)
            .expect("cwd present in spool event");
        if ev.hook_event_name == "Stop" {
            stop_transcript_path = ev.transcript_path.clone();
        } else if ev.hook_event_name == "SubagentStop" {
            subagent_stop_transcript_path = ev.agent_transcript_path.clone();
        }
        let sigs = tracker.on_event(ev, rec.recv_ms, &repo);
        all_signals.extend(sigs);
    }

    let stop_transcript = stop_transcript_path.expect("Stop transcript_path");
    let sub_transcript = subagent_stop_transcript_path.expect("SubagentStop agent_transcript_path");

    let turns: Vec<_> = tracker.retained_turns().collect();
    assert_eq!(turns.len(), 2, "expected 1 main turn + 1 subagent turn");

    let main_key = AgentKey {
        session_id: SESSION_ID.to_string(),
        agent_id: String::new(),
    };
    let sub_key = AgentKey {
        session_id: SESSION_ID.to_string(),
        agent_id: SUBAGENT_ID.to_string(),
    };

    let main_turn = tracker.closed_turn(&main_key).expect("closed main turn");
    assert_eq!(main_turn.parent, None);
    assert_eq!(main_turn.status, TurnEnd::Done);
    assert_eq!(
        main_turn.transcript_path.as_deref(),
        Some(stop_transcript.as_str())
    );
    let main_edits: Vec<_> = main_turn
        .windows
        .iter()
        .filter(|w| w.kind == ToolKind::Edit)
        .collect();
    assert_eq!(main_edits.len(), 1);
    assert_eq!(main_edits[0].tool_use_id, MAIN_EDIT_TOOL_ID);
    assert!(main_edits[0].post_ms.is_some());
    assert_eq!(main_edits[0].ok, Some(true));

    let sub_turn = tracker.closed_turn(&sub_key).expect("closed subagent turn");
    assert_eq!(sub_turn.parent, Some(main_key.clone()));
    assert_eq!(sub_turn.status, TurnEnd::Done);
    assert_eq!(
        sub_turn.transcript_path.as_deref(),
        Some(sub_transcript.as_str())
    );
    let sub_edits: Vec<_> = sub_turn
        .windows
        .iter()
        .filter(|w| w.kind == ToolKind::Edit)
        .collect();
    assert_eq!(sub_edits.len(), 1);
    assert_eq!(sub_edits[0].tool_use_id, SUBAGENT_EDIT_TOOL_ID);
    assert!(sub_edits[0].post_ms.is_some());
    assert_eq!(sub_edits[0].ok, Some(true));

    assert!(all_signals.contains(&TrackerSignal::TurnClosed(sub_key.clone())));
    assert!(all_signals.contains(&TrackerSignal::TurnClosed(main_key.clone())));
    assert!(all_signals.iter().any(|s| matches!(
        s,
        TrackerSignal::EditDone { agent, post_ms, .. }
            if agent == &main_key && *post_ms == main_edits[0].post_ms.unwrap()
    )));
    assert!(all_signals.iter().any(|s| matches!(
        s,
        TrackerSignal::EditDone { agent, post_ms, .. }
            if agent == &sub_key && *post_ms == sub_edits[0].post_ms.unwrap()
    )));
}
