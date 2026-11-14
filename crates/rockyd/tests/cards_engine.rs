//! Integration tests for the change card engine (`rockyd::cards::Engine`).

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use rocky_proto::cards::{BlockVia, Card, CardStatus, CoverageReason, CoverageState, Label};
use rocky_proto::hook::HookEvent;
use rocky_proto::paths::{canonical_path, listening_store_dir, repo_id};
use rocky_proto::pipe::{CaptureHealth, CaptureState, RepoInfo};
use rockyd::capture::CaptureResult;
use rockyd::cards::windows::PromptIn;
use rockyd::cards::{Engine, EngineCtx, card_id};
use rockyd::log::{RotatingLog, install_panic_hook};
use rockyd::spool::IngestOutput;
use serde_json::json;
use tempfile::TempDir;

struct Fixture {
    _tmp: TempDir,
    home: std::path::PathBuf,
    repo_root: std::path::PathBuf,
    repo_canon: String,
    store_dir: std::path::PathBuf,
    config_dir: std::path::PathBuf,
    transcript_path: std::path::PathBuf,
}

fn canonical_temp_root(path: &Path) -> PathBuf {
    let canon = fs::canonicalize(path).expect("canonicalize tempdir");
    #[cfg(windows)]
    if let Some(stripped) = canon.to_str().and_then(|s| s.strip_prefix(r"\\?\")) {
        return PathBuf::from(stripped);
    }
    canon
}

impl Fixture {
    fn new(session_id: &str) -> Self {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = canonical_temp_root(tmp.path());
        let home = root.join("home");
        let repo_root = root.join("repo");
        let config_dir = root.join("claude");
        let projects_dir = config_dir.join("projects").join("proj-a");
        fs::create_dir_all(&home).expect("create home");
        fs::create_dir_all(repo_root.join("src")).expect("create repo src");
        fs::create_dir_all(&projects_dir).expect("create projects dir");

        let repo_canon = canonical_path(&repo_root.to_string_lossy(), cfg!(windows));
        let rid = repo_id(&repo_canon, cfg!(windows));
        let store_dir = listening_store_dir(&home, &rid);
        fs::create_dir_all(store_dir.join("objects")).expect("create objects dir");

        let transcript_path = projects_dir.join(format!("{session_id}.jsonl"));
        fs::write(&transcript_path, "").expect("init transcript");

        Self {
            _tmp: tmp,
            home,
            repo_root,
            repo_canon,
            store_dir,
            config_dir,
            transcript_path,
        }
    }

    fn repo_info(&self) -> RepoInfo {
        RepoInfo {
            root: Some(self.repo_canon.clone()),
            main_root: None,
            name: "repo".to_string(),
            branch: Some("main".to_string()),
        }
    }

    fn ctx(&self, cards: bool) -> EngineCtx {
        let mut owned_roots = BTreeSet::new();
        owned_roots.insert(self.repo_canon.clone());
        EngineCtx {
            cards,
            owned_roots,
            capture: vec![CaptureHealth {
                root: self.repo_canon.clone(),
                state: CaptureState::Ok,
                last_reconcile_ms: None,
                error: None,
            }],
            gaps: Vec::new(),
            config_dirs: vec![self.config_dir.clone()],
        }
    }

    fn put_object(&self, name_seed: u8, text: &str) -> String {
        let sha = hex_sha_like(name_seed, text.as_bytes());
        fs::write(self.store_dir.join("objects").join(&sha), text).expect("write store object");
        sha
    }

    fn append_version(
        &self,
        file_rel: &str,
        ts: u64,
        sha: &str,
        prev: Option<&str>,
        created: bool,
    ) {
        let line = json!({
            "v": 1,
            "node": "file_version",
            "ts": ts,
            "refs": {
                "fileRel": file_rel,
                "version": sha,
                "prev": prev,
                "created": created,
                "deleted": false,
                "baseline": false
            }
        });
        append_jsonl(&self.store_dir.join("events.jsonl"), &line.to_string());
    }

    fn write_transcript(&self, prompt_iso: &str, prompt: &str, tool_uses: &[(&str, &str)]) {
        let path = &self.transcript_path;
        fs::write(path, "").expect("reset transcript");
        let user_line = json!({
            "type": "user",
            "timestamp": prompt_iso,
            "message": { "content": prompt }
        });
        append_jsonl(path, &user_line.to_string());

        for (idx, (id, quote_text)) in tool_uses.iter().enumerate() {
            let assistant_line = json!({
                "type": "assistant",
                "timestamp": prompt_iso,
                "message": {
                    "id": format!("msg-{idx}"),
                    "content": [
                        { "type": "text", "text": quote_text },
                        { "type": "tool_use", "id": id }
                    ]
                }
            });
            append_jsonl(path, &assistant_line.to_string());
        }
    }

    fn file_abs(&self, rel: &str) -> String {
        self.repo_root.join(rel).to_string_lossy().into_owned()
    }
}

fn append_jsonl(path: &Path, line: &str) {
    use std::io::Write;
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .expect("open jsonl for append");
    writeln!(f, "{line}").expect("write jsonl line");
}

fn hex_sha_like(seed: u8, data: &[u8]) -> String {
    // Deterministic 64-hex identifier distinct per seed + content (store tests only validate 64 hex).
    let mut h1: u64 = 0xcbf2_9ce4_8422_2325 ^ u64::from(seed);
    let mut h2: u64 = 0x1000_0000_01b3 ^ (u64::from(seed) << 8);
    let mut h3: u64 = 0x9e37_79b9_7f4a_7c15 ^ (data.len() as u64);
    let mut h4: u64 = 0xbf58_476d_1ce4_e5b9;
    for &b in data {
        h1 = h1.wrapping_mul(0x100_0000_01b3) ^ u64::from(b);
        h2 = h2
            .rotate_left(7)
            .wrapping_add(u64::from(b).wrapping_mul(31));
        h3 = h3.wrapping_mul(0x94d0_49bb_1331_11eb) ^ u64::from(b);
        h4 = h4.rotate_right(11) ^ h1.wrapping_add(h2);
    }
    format!("{h1:016x}{h2:016x}{h3:016x}{h4:016x}")
}

fn bash_pre_event(
    session_id: &str,
    cwd: &str,
    transcript: &Path,
    tool_use_id: &str,
    command: &str,
) -> HookEvent {
    let mut ev = base_event("PreToolUse", session_id, cwd, Some(transcript));
    ev.tool_name = Some("Bash".to_string());
    ev.tool_use_id = Some(tool_use_id.to_string());
    ev.command = Some(command.to_string());
    ev
}

fn bash_post_event(session_id: &str, cwd: &str, transcript: &Path, tool_use_id: &str) -> HookEvent {
    let mut ev = base_event("PostToolUse", session_id, cwd, Some(transcript));
    ev.tool_name = Some("Bash".to_string());
    ev.tool_use_id = Some(tool_use_id.to_string());
    ev
}

fn base_event(name: &str, session_id: &str, cwd: &str, transcript: Option<&Path>) -> HookEvent {
    HookEvent {
        hook_event_name: name.to_string(),
        session_id: session_id.to_string(),
        cwd: Some(cwd.to_string()),
        agent_id: None,
        agent_type: None,
        tool_name: None,
        tool_use_id: None,
        transcript_path: transcript.map(|p| p.to_string_lossy().into_owned()),
        agent_transcript_path: None,
        notification_type: None,
        target_path: None,
        command: None,
        description: None,
        prompt: None,
        truncated: false,
    }
}

fn user_prompt_out(
    session_id: &str,
    cwd: &str,
    transcript: &Path,
    prompt_text: &str,
    ts: u64,
) -> IngestOutput {
    IngestOutput {
        prompts: vec![PromptIn {
            session_id: session_id.to_string(),
            text: prompt_text.to_string(),
            truncated: false,
            recv_ms: ts,
        }],
        events: vec![(
            base_event("UserPromptSubmit", session_id, cwd, Some(transcript)),
            ts,
        )],
        ..IngestOutput::default()
    }
}

fn edit_pre_event(
    session_id: &str,
    cwd: &str,
    transcript: &Path,
    tool_use_id: &str,
    target_path: &str,
) -> HookEvent {
    let mut ev = base_event("PreToolUse", session_id, cwd, Some(transcript));
    ev.tool_name = Some("Edit".to_string());
    ev.tool_use_id = Some(tool_use_id.to_string());
    ev.target_path = Some(target_path.to_string());
    ev
}

fn edit_post_event(
    session_id: &str,
    cwd: &str,
    transcript: &Path,
    tool_use_id: &str,
    target_path: &str,
) -> HookEvent {
    let mut ev = base_event("PostToolUse", session_id, cwd, Some(transcript));
    ev.tool_name = Some("Edit".to_string());
    ev.tool_use_id = Some(tool_use_id.to_string());
    ev.target_path = Some(target_path.to_string());
    ev
}

fn poll_until_cards(
    engine: &mut Engine,
    now_ms: u64,
    ctx: &EngineCtx,
    expected_count: usize,
) -> Vec<Card> {
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut collected = Vec::new();
    while Instant::now() < deadline {
        collected.extend(engine.poll(now_ms, ctx));
        if collected.len() >= expected_count {
            return collected;
        }
        thread::sleep(Duration::from_millis(5));
    }
    panic!(
        "timed out waiting for {expected_count} cards, got {}",
        collected.len()
    );
}

fn assert_no_cards_for(engine: &mut Engine, now_ms: u64, ctx: &EngineCtx, wait: Duration) {
    let deadline = Instant::now() + wait;
    while Instant::now() < deadline {
        let cards = engine.poll(now_ms, ctx);
        assert!(
            cards.is_empty(),
            "expected no cards at {now_ms} ms, got {:?}",
            cards
        );
        thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn card_after_stop_within_budget() {
    let fx = Fixture::new("sess-1");
    let before = "export function add(a: number): number { return a; }\n";
    let after = "export function add(a: number, b: number): number { return a + b; }\n";
    let b_sha = fx.put_object(1, before);
    let a_sha = fx.put_object(2, after);
    fx.append_version("src/a.ts", 1_600, &a_sha, Some(&b_sha), false);
    fx.write_transcript(
        "1970-01-01T00:00:01.000Z",
        "Add second parameter",
        &[("tu-1", "Adding parameter b to add().")],
    );

    let mut engine = Engine::new(fx.home.clone(), 2);
    let mut repo_of = |_: &str| fx.repo_info();
    let ctx = fx.ctx(true);

    let _ = engine.on_ingest(
        &user_prompt_out(
            "sess-1",
            &fx.repo_canon,
            &fx.transcript_path,
            "Add second parameter",
            1_000,
        ),
        &mut repo_of,
        1_000,
    );
    let target = fx.file_abs("src/a.ts");
    let flushes = engine.on_ingest(
        &IngestOutput {
            events: vec![
                (
                    edit_pre_event(
                        "sess-1",
                        &fx.repo_canon,
                        &fx.transcript_path,
                        "tu-1",
                        &target,
                    ),
                    1_100,
                ),
                (
                    edit_post_event(
                        "sess-1",
                        &fx.repo_canon,
                        &fx.transcript_path,
                        "tu-1",
                        &target,
                    ),
                    1_500,
                ),
            ],
            ..IngestOutput::default()
        },
        &mut repo_of,
        1_500,
    );
    assert_eq!(flushes.len(), 1);
    assert_eq!(flushes[0].post_ms, 1_500);

    let _ = engine.on_ingest(
        &IngestOutput {
            events: vec![(
                base_event("Stop", "sess-1", &fx.repo_canon, Some(&fx.transcript_path)),
                2_000,
            )],
            ..IngestOutput::default()
        },
        &mut repo_of,
        2_000,
    );

    // Not ready before matching capture result or 4 s timeout.
    thread::sleep(Duration::from_millis(30));
    assert!(engine.poll(2_100, &ctx).is_empty());

    // Capture results with started_ms == 0 or started_ms < post_ms must not satisfy correlation.
    engine.on_capture(&[
        CaptureResult {
            root: fx.repo_canon.clone(),
            started_ms: 0,
            at_ms: 1_900,
            coverage: "complete".to_string(),
        },
        CaptureResult {
            root: fx.repo_canon.clone(),
            started_ms: 1_499,
            at_ms: 1_950,
            coverage: "complete".to_string(),
        },
    ]);
    thread::sleep(Duration::from_millis(30));
    assert!(engine.poll(2_200, &ctx).is_empty());

    // Matching capture result arrives (started_ms >= 1_500).
    engine.on_capture(&[CaptureResult {
        root: fx.repo_canon.clone(),
        started_ms: 1_500,
        at_ms: 1_750,
        coverage: "complete".to_string(),
    }]);
    let cards = poll_until_cards(&mut engine, 2_250, &ctx, 1);
    let card = &cards[0];
    assert_eq!(card.rev, 1);
    assert_eq!(card.card_id, "4e5e1a6d22cea72d7a8b3985c9c27fcf");
    assert_eq!(card.status, CardStatus::Done);
    assert_eq!(
        card.coverage.state,
        CoverageState::Full,
        "coverage reasons: {:?}",
        card.coverage.reasons
    );
    assert!(!card.blocks.is_empty());
    assert_eq!(card.blocks[0].via, BlockVia::Edit);
    assert_eq!(card.blocks[0].path, "src/a.ts");

    // Second turn with no capture result and no version must build after 4 s of simulated time.
    let _ = engine.on_ingest(
        &user_prompt_out(
            "sess-1",
            &fx.repo_canon,
            &fx.transcript_path,
            "Add third parameter",
            10_000,
        ),
        &mut repo_of,
        10_000,
    );
    let _ = engine.on_ingest(
        &IngestOutput {
            events: vec![
                (
                    edit_pre_event(
                        "sess-1",
                        &fx.repo_canon,
                        &fx.transcript_path,
                        "tu-2",
                        &target,
                    ),
                    10_100,
                ),
                (
                    edit_post_event(
                        "sess-1",
                        &fx.repo_canon,
                        &fx.transcript_path,
                        "tu-2",
                        &target,
                    ),
                    10_500,
                ),
                (
                    base_event("Stop", "sess-1", &fx.repo_canon, Some(&fx.transcript_path)),
                    11_000,
                ),
            ],
            ..IngestOutput::default()
        },
        &mut repo_of,
        11_000,
    );

    thread::sleep(Duration::from_millis(30));
    assert!(engine.poll(14_999, &ctx).is_empty());

    let timeout_cards = poll_until_cards(&mut engine, 15_000, &ctx, 1);
    assert_eq!(timeout_cards[0].rev, 1);
    assert_eq!(timeout_cards[0].card_id, "17b1b3f588f31f772403df672a986d52");
    assert!(
        timeout_cards[0]
            .coverage
            .reasons
            .contains(&CoverageReason::CaptureLate)
    );
}

#[test]
fn subagent_card_has_parent() {
    let fx = Fixture::new("sess-parent");
    let before = "const x = 1;\n";
    let after = "const x = 2;\n";
    let b_sha = fx.put_object(10, before);
    let a_sha = fx.put_object(11, after);
    fx.append_version("src/b.ts", 1_650, &a_sha, Some(&b_sha), false);
    fx.write_transcript(
        "1970-01-01T00:00:01.000Z",
        "Update constant via helper",
        &[],
    );

    let mut engine = Engine::new(fx.home.clone(), 2);
    let mut repo_of = |_: &str| fx.repo_info();
    let ctx = fx.ctx(true);

    // Start parent main turn at 1_000.
    let _ = engine.on_ingest(
        &user_prompt_out(
            "sess-parent",
            &fx.repo_canon,
            &fx.transcript_path,
            "Update constant via helper",
            1_000,
        ),
        &mut repo_of,
        1_000,
    );

    // Start subagent turn at 1_500, edit src/b.ts, stop subagent at 2_000.
    let target = fx.file_abs("src/b.ts");
    let mut sub_start = base_event("SubagentStart", "sess-parent", &fx.repo_canon, None);
    sub_start.agent_id = Some("sub-1".to_string());
    sub_start.agent_type = Some("Explore".to_string());

    let mut sub_pre = edit_pre_event(
        "sess-parent",
        &fx.repo_canon,
        &fx.transcript_path,
        "tu-sub",
        &target,
    );
    sub_pre.agent_id = Some("sub-1".to_string());

    let mut sub_post = edit_post_event(
        "sess-parent",
        &fx.repo_canon,
        &fx.transcript_path,
        "tu-sub",
        &target,
    );
    sub_post.agent_id = Some("sub-1".to_string());

    let mut sub_stop = base_event("SubagentStop", "sess-parent", &fx.repo_canon, None);
    sub_stop.agent_id = Some("sub-1".to_string());

    let _ = engine.on_ingest(
        &IngestOutput {
            events: vec![
                (sub_start, 1_500),
                (sub_pre, 1_600),
                (sub_post, 1_620),
                (sub_stop, 2_000),
            ],
            ..IngestOutput::default()
        },
        &mut repo_of,
        2_000,
    );
    engine.on_capture(&[CaptureResult {
        root: fx.repo_canon.clone(),
        started_ms: 1_700,
        at_ms: 1_800,
        coverage: "complete".to_string(),
    }]);

    let cards = poll_until_cards(&mut engine, 2_100, &ctx, 1);
    assert_eq!(cards[0].agent_id, "sub-1");
    assert_eq!(cards[0].agent_type, "Explore");
    assert_eq!(
        cards[0].parent_card_id.as_deref(),
        Some("ae5a08b0f67a3ad3417ce7b1b6dc76c8")
    );

    // Standalone subagent without a tracked main turn must have parent_card_id = None.
    let b2_sha = fx.put_object(12, "const x = 3;\n");
    fx.append_version("src/b.ts", 20_650, &b2_sha, Some(&a_sha), false);

    let mut orphan_start = base_event("SubagentStart", "sess-orphan", &fx.repo_canon, None);
    orphan_start.agent_id = Some("sub-orphan".to_string());
    orphan_start.agent_type = Some("Worker".to_string());

    let mut orphan_pre = edit_pre_event(
        "sess-orphan",
        &fx.repo_canon,
        &fx.transcript_path,
        "tu-o",
        &target,
    );
    orphan_pre.agent_id = Some("sub-orphan".to_string());

    let mut orphan_post = edit_post_event(
        "sess-orphan",
        &fx.repo_canon,
        &fx.transcript_path,
        "tu-o",
        &target,
    );
    orphan_post.agent_id = Some("sub-orphan".to_string());

    let mut orphan_stop = base_event("SubagentStop", "sess-orphan", &fx.repo_canon, None);
    orphan_stop.agent_id = Some("sub-orphan".to_string());

    let _ = engine.on_ingest(
        &IngestOutput {
            events: vec![
                (orphan_start, 20_000),
                (orphan_pre, 20_500),
                (orphan_post, 20_600),
                (orphan_stop, 21_000),
            ],
            ..IngestOutput::default()
        },
        &mut repo_of,
        21_000,
    );
    engine.on_capture(&[CaptureResult {
        root: fx.repo_canon.clone(),
        started_ms: 20_700,
        at_ms: 20_800,
        coverage: "complete".to_string(),
    }]);

    let orphan_cards = poll_until_cards(&mut engine, 21_100, &ctx, 1);
    assert_eq!(orphan_cards[0].parent_card_id, None);
}

#[test]
fn revision_after_late_event() {
    let fx = Fixture::new("sess-rev");
    let v0 = "const count = 1;\n";
    let v1 = "const count = 2;\n";
    let v2 = "const count = 3;\n";
    let s0 = fx.put_object(20, v0);
    let s1 = fx.put_object(21, v1);
    let s2 = fx.put_object(22, v2);
    fx.append_version("src/c.ts", 1_550, &s1, Some(&s0), false);
    fx.write_transcript("1970-01-01T00:00:01.000Z", "Update count", &[]);

    let mut engine = Engine::new(fx.home.clone(), 2);
    let mut repo_of = |_: &str| fx.repo_info();
    let ctx = fx.ctx(true);
    let target = fx.file_abs("src/c.ts");

    let _ = engine.on_ingest(
        &user_prompt_out(
            "sess-rev",
            &fx.repo_canon,
            &fx.transcript_path,
            "Update count",
            1_000,
        ),
        &mut repo_of,
        1_000,
    );
    let _ = engine.on_ingest(
        &IngestOutput {
            events: vec![
                (
                    edit_pre_event(
                        "sess-rev",
                        &fx.repo_canon,
                        &fx.transcript_path,
                        "tu-r1",
                        &target,
                    ),
                    1_100,
                ),
                (
                    edit_post_event(
                        "sess-rev",
                        &fx.repo_canon,
                        &fx.transcript_path,
                        "tu-r1",
                        &target,
                    ),
                    1_500,
                ),
                (
                    edit_pre_event(
                        "sess-rev",
                        &fx.repo_canon,
                        &fx.transcript_path,
                        "tu-r2",
                        &target,
                    ),
                    1_800,
                ),
                (
                    base_event(
                        "Stop",
                        "sess-rev",
                        &fx.repo_canon,
                        Some(&fx.transcript_path),
                    ),
                    2_000,
                ),
            ],
            ..IngestOutput::default()
        },
        &mut repo_of,
        2_000,
    );
    engine.on_capture(&[CaptureResult {
        root: fx.repo_canon.clone(),
        started_ms: 1_600,
        at_ms: 1_700,
        coverage: "complete".to_string(),
    }]);

    let rev1 = poll_until_cards(&mut engine, 2_100, &ctx, 1);
    assert_eq!(rev1[0].rev, 1);
    let expected_id = rev1[0].card_id.clone();

    // Late PostToolUse for tu-r2 arrives within 60 s along with new version + capture result.
    fx.append_version("src/c.ts", 5_100, &s2, Some(&s1), false);
    let _ = engine.on_ingest(
        &IngestOutput {
            events: vec![(
                edit_post_event(
                    "sess-rev",
                    &fx.repo_canon,
                    &fx.transcript_path,
                    "tu-r2",
                    &target,
                ),
                5_000,
            )],
            ..IngestOutput::default()
        },
        &mut repo_of,
        5_000,
    );
    engine.on_capture(&[CaptureResult {
        root: fx.repo_canon.clone(),
        started_ms: 5_150,
        at_ms: 5_200,
        coverage: "complete".to_string(),
    }]);

    let rev2 = poll_until_cards(&mut engine, 5_300, &ctx, 1);
    assert_eq!(rev2[0].card_id, expected_id);
    assert_eq!(rev2[0].rev, 2);
}

#[test]
fn final_after_60s() {
    let fx = Fixture::new("sess-final");
    let v0 = "const z = 1;\n";
    let v1 = "const z = 2;\n";
    let s0 = fx.put_object(30, v0);
    let s1 = fx.put_object(31, v1);
    fx.append_version("src/z.ts", 1_550, &s1, Some(&s0), false);
    fx.write_transcript("1970-01-01T00:00:01.000Z", "Change z", &[]);

    let mut engine = Engine::new(fx.home.clone(), 1);
    let mut repo_of = |_: &str| fx.repo_info();
    let ctx = fx.ctx(true);
    let target = fx.file_abs("src/z.ts");

    let _ = engine.on_ingest(
        &user_prompt_out(
            "sess-final",
            &fx.repo_canon,
            &fx.transcript_path,
            "Change z",
            1_000,
        ),
        &mut repo_of,
        1_000,
    );
    let _ = engine.on_ingest(
        &IngestOutput {
            events: vec![
                (
                    edit_pre_event(
                        "sess-final",
                        &fx.repo_canon,
                        &fx.transcript_path,
                        "tu-f1",
                        &target,
                    ),
                    1_100,
                ),
                (
                    edit_post_event(
                        "sess-final",
                        &fx.repo_canon,
                        &fx.transcript_path,
                        "tu-f1",
                        &target,
                    ),
                    1_500,
                ),
                (
                    edit_pre_event(
                        "sess-final",
                        &fx.repo_canon,
                        &fx.transcript_path,
                        "tu-f2",
                        &target,
                    ),
                    1_800,
                ),
                (
                    base_event(
                        "Stop",
                        "sess-final",
                        &fx.repo_canon,
                        Some(&fx.transcript_path),
                    ),
                    2_000,
                ),
            ],
            ..IngestOutput::default()
        },
        &mut repo_of,
        2_000,
    );
    engine.on_capture(&[CaptureResult {
        root: fx.repo_canon.clone(),
        started_ms: 1_600,
        at_ms: 1_700,
        coverage: "complete".to_string(),
    }]);

    let rev1 = poll_until_cards(&mut engine, 2_100, &ctx, 1);
    assert_eq!(rev1[0].rev, 1);

    // At 62_000 (ended_ms + 60_000), late event is outside the 60 s revision window.
    let s2 = fx.put_object(32, "const z = 3;\n");
    fx.append_version("src/z.ts", 62_050, &s2, Some(&s1), false);
    let _ = engine.on_ingest(
        &IngestOutput {
            events: vec![(
                edit_post_event(
                    "sess-final",
                    &fx.repo_canon,
                    &fx.transcript_path,
                    "tu-f2",
                    &target,
                ),
                62_000,
            )],
            ..IngestOutput::default()
        },
        &mut repo_of,
        62_000,
    );
    engine.on_capture(&[CaptureResult {
        root: fx.repo_canon.clone(),
        started_ms: 62_100,
        at_ms: 62_150,
        coverage: "complete".to_string(),
    }]);

    thread::sleep(Duration::from_millis(80));
    assert!(engine.poll(62_500, &ctx).is_empty());
}

#[test]
fn cards_off_builds_nothing_and_never_flushes() {
    let fx = Fixture::new("sess-off");
    let s0 = fx.put_object(40, "const off = 1;\n");
    let s1 = fx.put_object(41, "const off = 2;\n");
    fx.append_version("src/off.ts", 1_550, &s1, Some(&s0), false);
    fx.write_transcript("1970-01-01T00:00:01.000Z", "Turn while off", &[]);

    let mut engine = Engine::new(fx.home.clone(), 1);
    let mut repo_of = |_: &str| fx.repo_info();
    let ctx_off = fx.ctx(false);
    let ctx_on = fx.ctx(true);

    // Inform engine that cards are disabled.
    assert!(engine.poll(500, &ctx_off).is_empty());

    let target = fx.file_abs("src/off.ts");
    let flushes_prompt = engine.on_ingest(
        &user_prompt_out(
            "sess-off",
            &fx.repo_canon,
            &fx.transcript_path,
            "Turn while off",
            1_000,
        ),
        &mut repo_of,
        1_000,
    );
    assert!(flushes_prompt.is_empty());

    let flushes_edit = engine.on_ingest(
        &IngestOutput {
            events: vec![
                (
                    edit_pre_event(
                        "sess-off",
                        &fx.repo_canon,
                        &fx.transcript_path,
                        "tu-off",
                        &target,
                    ),
                    1_100,
                ),
                (
                    edit_post_event(
                        "sess-off",
                        &fx.repo_canon,
                        &fx.transcript_path,
                        "tu-off",
                        &target,
                    ),
                    1_500,
                ),
                (
                    base_event(
                        "Stop",
                        "sess-off",
                        &fx.repo_canon,
                        Some(&fx.transcript_path),
                    ),
                    2_000,
                ),
            ],
            ..IngestOutput::default()
        },
        &mut repo_of,
        2_000,
    );
    assert!(
        flushes_edit.is_empty(),
        "cards == false must never request a flush"
    );

    engine.on_capture(&[CaptureResult {
        root: fx.repo_canon.clone(),
        started_ms: 1_600,
        at_ms: 1_700,
        coverage: "complete".to_string(),
    }]);
    thread::sleep(Duration::from_millis(80));
    assert!(engine.poll(7_000, &ctx_off).is_empty());

    // Turning cards back on must not retroactively emit the turn that ran while off.
    thread::sleep(Duration::from_millis(50));
    assert!(engine.poll(8_000, &ctx_on).is_empty());
}

#[test]
fn turn_without_changes_gives_no_card() {
    let fx = Fixture::new("sess-read");
    let outside_sha = fx.put_object(50, "// manual edit\n");
    fx.append_version("src/manual.ts", 1_400, &outside_sha, None, true);
    fx.write_transcript("1970-01-01T00:00:01.000Z", "Inspect files", &[]);

    let mut engine = Engine::new(fx.home.clone(), 1);
    let mut repo_of = |_: &str| fx.repo_info();
    let ctx = fx.ctx(true);

    let mut read_pre = base_event(
        "PreToolUse",
        "sess-read",
        &fx.repo_canon,
        Some(&fx.transcript_path),
    );
    read_pre.tool_name = Some("Read".to_string());
    read_pre.tool_use_id = Some("tu-r1".to_string());
    read_pre.target_path = Some(fx.file_abs("src/manual.ts"));

    let mut read_post = base_event(
        "PostToolUse",
        "sess-read",
        &fx.repo_canon,
        Some(&fx.transcript_path),
    );
    read_post.tool_name = Some("Read".to_string());
    read_post.tool_use_id = Some("tu-r1".to_string());
    read_post.target_path = Some(fx.file_abs("src/manual.ts"));

    let _ = engine.on_ingest(
        &user_prompt_out(
            "sess-read",
            &fx.repo_canon,
            &fx.transcript_path,
            "Inspect files",
            1_000,
        ),
        &mut repo_of,
        1_000,
    );
    let flushes = engine.on_ingest(
        &IngestOutput {
            events: vec![
                (read_pre, 1_100),
                (read_post, 1_200),
                (
                    base_event(
                        "Stop",
                        "sess-read",
                        &fx.repo_canon,
                        Some(&fx.transcript_path),
                    ),
                    2_000,
                ),
            ],
            ..IngestOutput::default()
        },
        &mut repo_of,
        2_000,
    );
    assert!(flushes.is_empty());

    thread::sleep(Duration::from_millis(80));
    assert!(engine.poll(7_000, &ctx).is_empty());
}

#[test]
fn stop_without_open_turn_is_ignored() {
    let fx = Fixture::new("sess-nostart");
    let mut engine = Engine::new(fx.home.clone(), 1);
    let mut repo_of = |_: &str| fx.repo_info();
    let ctx = fx.ctx(true);

    let flushes = engine.on_ingest(
        &IngestOutput {
            events: vec![(
                base_event("Stop", "sess-nostart", &fx.repo_canon, None),
                1_000,
            )],
            ..IngestOutput::default()
        },
        &mut repo_of,
        1_000,
    );
    assert!(flushes.is_empty());

    thread::sleep(Duration::from_millis(80));
    assert!(engine.poll(6_000, &ctx).is_empty());
}

#[test]
fn worker_panic_is_contained() {
    let fx = Fixture::new("panic-sess");
    let s0 = fx.put_object(60, "export const v = 1;\n");
    let s1 = fx.put_object(61, "export const v = 2;\n");
    fx.append_version("src/p.ts", 1_550, &s1, Some(&s0), false);
    fx.append_version("src/p.ts", 10_550, &s1, Some(&s0), false);
    fx.write_transcript("1970-01-01T00:00:01.000Z", "Trigger panic", &[]);

    let panicked_once = Arc::new(AtomicBool::new(false));
    let hook_flag = Arc::clone(&panicked_once);
    let mut engine = Engine::new_with_build_hook(
        fx.home.clone(),
        1,
        Arc::new(move |input| {
            if input.turn.agent.session_id == "panic-sess"
                && !hook_flag.swap(true, Ordering::SeqCst)
            {
                panic!("simulated worker panic");
            }
        }),
    );

    let mut repo_of = |_: &str| fx.repo_info();
    let ctx = fx.ctx(true);
    let target = fx.file_abs("src/p.ts");

    let _ = engine.on_ingest(
        &user_prompt_out(
            "panic-sess",
            &fx.repo_canon,
            &fx.transcript_path,
            "Trigger panic",
            1_000,
        ),
        &mut repo_of,
        1_000,
    );
    let _ = engine.on_ingest(
        &IngestOutput {
            events: vec![
                (
                    edit_pre_event(
                        "panic-sess",
                        &fx.repo_canon,
                        &fx.transcript_path,
                        "tu-p1",
                        &target,
                    ),
                    1_100,
                ),
                (
                    edit_post_event(
                        "panic-sess",
                        &fx.repo_canon,
                        &fx.transcript_path,
                        "tu-p1",
                        &target,
                    ),
                    1_500,
                ),
                (
                    base_event(
                        "Stop",
                        "panic-sess",
                        &fx.repo_canon,
                        Some(&fx.transcript_path),
                    ),
                    2_000,
                ),
            ],
            ..IngestOutput::default()
        },
        &mut repo_of,
        2_000,
    );
    engine.on_capture(&[CaptureResult {
        root: fx.repo_canon.clone(),
        started_ms: 1_600,
        at_ms: 1_700,
        coverage: "complete".to_string(),
    }]);

    // Wait for panic to be caught by worker thread.
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        assert!(engine.poll(2_100, &ctx).is_empty());
        if engine.worker_panics() >= 1 {
            break;
        }
        thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(engine.worker_panics(), 1);
    assert_eq!(engine.take_worker_panics(), 1);
    assert_eq!(engine.worker_panics(), 0);

    // Subsequent valid turn on the single-worker pool still builds a card.
    let _ = engine.on_ingest(
        &user_prompt_out(
            "ok-sess",
            &fx.repo_canon,
            &fx.transcript_path,
            "Normal turn",
            10_000,
        ),
        &mut repo_of,
        10_000,
    );
    let _ = engine.on_ingest(
        &IngestOutput {
            events: vec![
                (
                    edit_pre_event(
                        "ok-sess",
                        &fx.repo_canon,
                        &fx.transcript_path,
                        "tu-ok",
                        &target,
                    ),
                    10_100,
                ),
                (
                    edit_post_event(
                        "ok-sess",
                        &fx.repo_canon,
                        &fx.transcript_path,
                        "tu-ok",
                        &target,
                    ),
                    10_500,
                ),
                (
                    base_event("Stop", "ok-sess", &fx.repo_canon, Some(&fx.transcript_path)),
                    11_000,
                ),
            ],
            ..IngestOutput::default()
        },
        &mut repo_of,
        11_000,
    );
    engine.on_capture(&[CaptureResult {
        root: fx.repo_canon.clone(),
        started_ms: 10_600,
        at_ms: 10_700,
        coverage: "complete".to_string(),
    }]);

    let cards = poll_until_cards(&mut engine, 11_100, &ctx, 1);
    assert_eq!(cards[0].session_id, "ok-sess");
    assert_eq!(cards[0].rev, 1);
}

#[test]
#[ignore]
fn typical_load_under_500ms() {
    let fx = Fixture::new("sess-bench");
    let make_ts = |variant: usize| -> String {
        let mut s = String::with_capacity(32 * 1024);
        for i in 0..350 {
            s.push_str(&format!(
                "export function computeItem{i}(input: number, flag: boolean): number {{\n  if (flag && input > {variant}) {{\n    return input * {i} + {variant};\n  }}\n  return input + {i};\n}}\n",
            ));
        }
        s
    };

    let before_text = make_ts(0);
    let after_text = make_ts(1);
    assert!(
        before_text.len() >= 30 * 1024,
        "before size {}",
        before_text.len()
    );
    assert!(
        after_text.len() >= 30 * 1024,
        "after size {}",
        after_text.len()
    );

    let mut tool_uses = Vec::new();
    let mut events = Vec::new();
    for idx in 0..5 {
        let rel = format!("src/mod_{idx}.ts");
        let abs = fx.file_abs(&rel);
        let b_sha = fx.put_object((idx * 2 + 1) as u8, &before_text);
        let a_sha = fx.put_object((idx * 2 + 2) as u8, &after_text);
        let pre_ms = 1_100 + (idx as u64) * 100;
        let post_ms = pre_ms + 40;
        let ver_ms = post_ms + 10;
        fx.append_version(&rel, ver_ms, &a_sha, Some(&b_sha), false);
        let id = format!("tu-bench-{idx}");
        tool_uses.push((id.clone(), format!("Updated module {idx}.")));
        events.push((
            edit_pre_event("sess-bench", &fx.repo_canon, &fx.transcript_path, &id, &abs),
            pre_ms,
        ));
        events.push((
            edit_post_event("sess-bench", &fx.repo_canon, &fx.transcript_path, &id, &abs),
            post_ms,
        ));
    }
    let tool_refs: Vec<(&str, &str)> = tool_uses
        .iter()
        .map(|(a, b)| (a.as_str(), b.as_str()))
        .collect();
    fx.write_transcript(
        "1970-01-01T00:00:01.000Z",
        "Refactor five TypeScript modules",
        &tool_refs,
    );

    let mut engine = Engine::new(fx.home.clone(), 1);
    let mut repo_of = |_: &str| fx.repo_info();
    let ctx = fx.ctx(true);

    let _ = engine.on_ingest(
        &user_prompt_out(
            "sess-bench",
            &fx.repo_canon,
            &fx.transcript_path,
            "Refactor five TypeScript modules",
            1_000,
        ),
        &mut repo_of,
        1_000,
    );
    let _ = engine.on_ingest(
        &IngestOutput {
            events,
            ..IngestOutput::default()
        },
        &mut repo_of,
        1_600,
    );

    let start = Instant::now();
    let _ = engine.on_ingest(
        &IngestOutput {
            events: vec![(
                base_event(
                    "Stop",
                    "sess-bench",
                    &fx.repo_canon,
                    Some(&fx.transcript_path),
                ),
                2_000,
            )],
            ..IngestOutput::default()
        },
        &mut repo_of,
        2_000,
    );
    engine.on_capture(&[CaptureResult {
        root: fx.repo_canon.clone(),
        started_ms: 1_700,
        at_ms: 1_800,
        coverage: "complete".to_string(),
    }]);
    let cards = poll_until_cards(&mut engine, 2_010, &ctx, 1);
    let elapsed = start.elapsed();

    println!("typical_load_under_500ms: {:?}", elapsed);
    assert!(!cards[0].blocks.is_empty());
    if !cfg!(debug_assertions) {
        assert!(
            elapsed <= Duration::from_millis(500),
            "single-worker build took {:?}, expected <= 500ms",
            elapsed
        );
    }
}

#[test]
fn card_id_matches_fixed_vectors() {
    assert_eq!(card_id("s", "a", 123), "085fd43e5e4c84caf8d98e99af9d6ff2");
    assert_eq!(card_id("sa", "", 123), "a4a2a32beaaf4d9e15c7f0c649393eb4");
    assert_eq!(card_id("s", "a1", 23), "bcb390a344d2e7e6b1f5bf2650a1dd60");
    assert_eq!(
        card_id("sess-1", "", 1_000),
        "4e5e1a6d22cea72d7a8b3985c9c27fcf"
    );
    assert_eq!(
        card_id("sess-1", "sub-1", 1_000),
        "97394ac43381e6ac7a3b66cb264cd2b9"
    );
}

#[test]
fn daemon_panic_hook_contains_worker_and_aborts_others() {
    if let Ok(mode) = std::env::var("ROCKY_PANIC_HOOK_TEST") {
        let log_dir = PathBuf::from(std::env::var_os("ROCKY_PANIC_LOG_DIR").expect("log dir env"));
        let log = Arc::new(RotatingLog::new(&log_dir.join("rockyd.log")));
        install_panic_hook(Arc::clone(&log));

        match mode.as_str() {
            "worker" => {
                let fx = Fixture::new("panic-child");
                let s0 = fx.put_object(1, "export const v = 1;\n");
                let s1 = fx.put_object(2, "export const v = 2;\n");
                fx.append_version("src/p.ts", 1_550, &s1, Some(&s0), false);
                fx.append_version("src/p.ts", 10_550, &s1, Some(&s0), false);
                fx.write_transcript("1970-01-01T00:00:01.000Z", "Prompt", &[]);

                let panicked_once = Arc::new(AtomicBool::new(false));
                let flag = Arc::clone(&panicked_once);
                let mut engine = Engine::new_with_build_hook(
                    fx.home.clone(),
                    1,
                    Arc::new(move |input| {
                        if input.turn.agent.session_id == "panic-child"
                            && !flag.swap(true, Ordering::SeqCst)
                        {
                            panic!("SECRET_LEAK_TOKEN");
                        }
                    }),
                );
                let mut repo_of = |_: &str| fx.repo_info();
                let ctx = fx.ctx(true);
                let target = fx.file_abs("src/p.ts");

                let _ = engine.on_ingest(
                    &user_prompt_out(
                        "panic-child",
                        &fx.repo_canon,
                        &fx.transcript_path,
                        "Prompt",
                        1_000,
                    ),
                    &mut repo_of,
                    1_000,
                );
                let _ = engine.on_ingest(
                    &IngestOutput {
                        events: vec![
                            (
                                edit_pre_event(
                                    "panic-child",
                                    &fx.repo_canon,
                                    &fx.transcript_path,
                                    "tu-1",
                                    &target,
                                ),
                                1_100,
                            ),
                            (
                                edit_post_event(
                                    "panic-child",
                                    &fx.repo_canon,
                                    &fx.transcript_path,
                                    "tu-1",
                                    &target,
                                ),
                                1_500,
                            ),
                            (
                                base_event(
                                    "Stop",
                                    "panic-child",
                                    &fx.repo_canon,
                                    Some(&fx.transcript_path),
                                ),
                                2_000,
                            ),
                        ],
                        ..IngestOutput::default()
                    },
                    &mut repo_of,
                    2_000,
                );
                engine.on_capture(&[CaptureResult {
                    root: fx.repo_canon.clone(),
                    started_ms: 1_600,
                    at_ms: 1_700,
                    coverage: "complete".to_string(),
                }]);

                let deadline = Instant::now() + Duration::from_secs(3);
                while Instant::now() < deadline {
                    assert!(engine.poll(2_100, &ctx).is_empty());
                    if engine.worker_panics() >= 1 {
                        break;
                    }
                    thread::sleep(Duration::from_millis(5));
                }
                assert_eq!(engine.take_worker_panics(), 1);

                let _ = engine.on_ingest(
                    &user_prompt_out(
                        "ok-child",
                        &fx.repo_canon,
                        &fx.transcript_path,
                        "Next",
                        10_000,
                    ),
                    &mut repo_of,
                    10_000,
                );
                let _ = engine.on_ingest(
                    &IngestOutput {
                        events: vec![
                            (
                                edit_pre_event(
                                    "ok-child",
                                    &fx.repo_canon,
                                    &fx.transcript_path,
                                    "tu-2",
                                    &target,
                                ),
                                10_100,
                            ),
                            (
                                edit_post_event(
                                    "ok-child",
                                    &fx.repo_canon,
                                    &fx.transcript_path,
                                    "tu-2",
                                    &target,
                                ),
                                10_500,
                            ),
                            (
                                base_event(
                                    "Stop",
                                    "ok-child",
                                    &fx.repo_canon,
                                    Some(&fx.transcript_path),
                                ),
                                11_000,
                            ),
                        ],
                        ..IngestOutput::default()
                    },
                    &mut repo_of,
                    11_000,
                );
                engine.on_capture(&[CaptureResult {
                    root: fx.repo_canon.clone(),
                    started_ms: 10_600,
                    at_ms: 10_700,
                    coverage: "complete".to_string(),
                }]);
                let cards = poll_until_cards(&mut engine, 11_100, &ctx, 1);
                assert_eq!(cards[0].session_id, "ok-child");
            }
            "other" => {
                let handle = thread::Builder::new()
                    .name("daemon-other".to_string())
                    .spawn(|| {
                        let _ = std::panic::catch_unwind(|| {
                            panic!("non-worker panic must abort");
                        });
                    })
                    .expect("spawn non-worker thread");
                let _ = handle.join();
            }
            other => panic!("unexpected mode: {other}"),
        }
        return;
    }

    let exe = std::env::current_exe().expect("current test exe");

    let worker_dir = tempfile::tempdir().expect("worker log dir");
    let mut worker_cmd = Command::new(&exe);
    worker_cmd
        .args([
            "--exact",
            "daemon_panic_hook_contains_worker_and_aborts_others",
            "--nocapture",
        ])
        .env("ROCKY_PANIC_HOOK_TEST", "worker")
        .env("ROCKY_PANIC_LOG_DIR", worker_dir.path());
    let worker_out = run_command_with_timeout(&mut worker_cmd, Duration::from_secs(15));
    assert!(
        worker_out.status.success(),
        "worker panic child aborted or failed: status={:?}, stdout={}, stderr={}",
        worker_out.status,
        String::from_utf8_lossy(&worker_out.stdout),
        String::from_utf8_lossy(&worker_out.stderr)
    );
    let worker_log =
        fs::read_to_string(worker_dir.path().join("rockyd.log")).expect("read worker log");
    assert!(
        worker_log.contains("worker panic"),
        "expected count-only worker panic log line, got: {worker_log:?}"
    );
    assert!(!worker_log.contains("SECRET_LEAK_TOKEN"));
    assert!(!worker_log.contains("panic, aborting"));
    assert!(!String::from_utf8_lossy(&worker_out.stderr).contains("SECRET_LEAK_TOKEN"));

    let other_dir = tempfile::tempdir().expect("other log dir");
    let mut other_cmd = Command::new(&exe);
    other_cmd
        .args([
            "--exact",
            "daemon_panic_hook_contains_worker_and_aborts_others",
            "--nocapture",
        ])
        .env("ROCKY_PANIC_HOOK_TEST", "other")
        .env("ROCKY_PANIC_LOG_DIR", other_dir.path());
    let other_out = run_command_with_timeout(&mut other_cmd, Duration::from_secs(15));
    assert!(
        !other_out.status.success(),
        "non-worker panic child unexpectedly succeeded"
    );
    let other_log =
        fs::read_to_string(other_dir.path().join("rockyd.log")).expect("read other log");
    assert!(
        other_log.contains("panic, aborting:"),
        "expected abort log line, got: {other_log:?}"
    );
}

#[test]
fn late_edit_waits_for_capture_then_includes_change() {
    let fx = Fixture::new("sess-late-wait");
    let s0 = fx.put_object(1, "export const a = 1;\n");
    let s1 = fx.put_object(2, "export const a = 2;\n");
    let s2 = fx.put_object(3, "export const b = 10;\n");
    fx.append_version("src/c.ts", 1_550, &s1, Some(&s0), false);
    fx.write_transcript("1970-01-01T00:00:01.000Z", "Late edit wait", &[]);

    let mut engine = Engine::new(fx.home.clone(), 1);
    let mut repo_of = |_: &str| fx.repo_info();
    let ctx = fx.ctx(true);
    let c_abs = fx.file_abs("src/c.ts");
    let d_abs = fx.file_abs("src/d.ts");

    let _ = engine.on_ingest(
        &user_prompt_out(
            "sess-late-wait",
            &fx.repo_canon,
            &fx.transcript_path,
            "Late edit wait",
            1_000,
        ),
        &mut repo_of,
        1_000,
    );
    let _ = engine.on_ingest(
        &IngestOutput {
            events: vec![
                (
                    edit_pre_event(
                        "sess-late-wait",
                        &fx.repo_canon,
                        &fx.transcript_path,
                        "tu-1",
                        &c_abs,
                    ),
                    1_100,
                ),
                (
                    edit_post_event(
                        "sess-late-wait",
                        &fx.repo_canon,
                        &fx.transcript_path,
                        "tu-1",
                        &c_abs,
                    ),
                    1_500,
                ),
                (
                    edit_pre_event(
                        "sess-late-wait",
                        &fx.repo_canon,
                        &fx.transcript_path,
                        "tu-2",
                        &d_abs,
                    ),
                    1_800,
                ),
                (
                    base_event(
                        "Stop",
                        "sess-late-wait",
                        &fx.repo_canon,
                        Some(&fx.transcript_path),
                    ),
                    2_000,
                ),
            ],
            ..IngestOutput::default()
        },
        &mut repo_of,
        2_000,
    );
    engine.on_capture(&[CaptureResult {
        root: fx.repo_canon.clone(),
        started_ms: 1_600,
        at_ms: 1_700,
        coverage: "complete".to_string(),
    }]);

    let rev1 = poll_until_cards(&mut engine, 2_100, &ctx, 1);
    assert_eq!(rev1[0].rev, 1);
    assert_eq!(rev1[0].blocks.len(), 2);

    // Late edit completion arrives at 5_000 before capture >= 5_000.
    let flushes = engine.on_ingest(
        &IngestOutput {
            events: vec![(
                edit_post_event(
                    "sess-late-wait",
                    &fx.repo_canon,
                    &fx.transcript_path,
                    "tu-2",
                    &d_abs,
                ),
                5_000,
            )],
            ..IngestOutput::default()
        },
        &mut repo_of,
        5_000,
    );
    assert_eq!(flushes.len(), 1);
    assert_eq!(flushes[0].post_ms, 5_000);

    // Must hold the revision until capture arrives or 4 s passes.
    assert_no_cards_for(&mut engine, 5_200, &ctx, Duration::from_millis(120));

    fx.append_version("src/d.ts", 5_100, &s2, None, true);
    engine.on_capture(&[CaptureResult {
        root: fx.repo_canon.clone(),
        started_ms: 5_150,
        at_ms: 5_250,
        coverage: "complete".to_string(),
    }]);
    let rev2 = poll_until_cards(&mut engine, 5_300, &ctx, 1);
    assert_eq!(rev2[0].rev, 2);
    assert_eq!(rev2[0].card_id, rev1[0].card_id);
    assert_eq!(
        rev2[0].coverage.state,
        CoverageState::Full,
        "coverage reasons: {:?}",
        rev2[0].coverage.reasons
    );
    assert_eq!(rev2[0].blocks.len(), 2);
    assert_eq!(rev2[0].blocks[0].path, "src/c.ts");
    assert_eq!(rev2[0].blocks[0].after.as_deref(), Some(s1.as_str()));
    assert_eq!(rev2[0].blocks[1].path, "src/d.ts");
    assert_eq!(rev2[0].blocks[1].after.as_deref(), Some(s2.as_str()));
}

#[test]
fn late_event_routes_to_updated_turn_with_newer_closed_and_open_turns() {
    let fx = Fixture::new("sess-multi");
    let s0 = fx.put_object(1, "export const v = 0;\n");
    let s_a1 = fx.put_object(2, "export const v = 1;\n");
    let s_a2 = fx.put_object(3, "export const a2 = 2;\n");
    let s0_b1 = fx.put_object(4, "export const b1 = 0;\n");
    let s_b1 = fx.put_object(5, "export const b1 = 3;\n");
    let s0_c1 = fx.put_object(6, "export const c1 = 0;\n");
    let s_c1 = fx.put_object(7, "export const c1 = 4;\n");
    fx.append_version("src/a1.ts", 1_550, &s_a1, Some(&s0), false);
    fx.append_version("src/b1.ts", 3_550, &s_b1, Some(&s0_b1), false);
    fx.append_version("src/c1.ts", 5_250, &s_c1, Some(&s0_c1), false);
    fx.write_transcript("1970-01-01T00:00:01.000Z", "Multi turns", &[]);

    let mut engine = Engine::new(fx.home.clone(), 1);
    let mut repo_of = |_: &str| fx.repo_info();
    let ctx = fx.ctx(true);

    // Turn A (started 1_000, closed 2_000) with outstanding tu-a2.
    let a1_abs = fx.file_abs("src/a1.ts");
    let a2_abs = fx.file_abs("src/a2.ts");
    let b1_abs = fx.file_abs("src/b1.ts");
    let c1_abs = fx.file_abs("src/c1.ts");

    let _ = engine.on_ingest(
        &user_prompt_out(
            "sess-multi",
            &fx.repo_canon,
            &fx.transcript_path,
            "Turn A",
            1_000,
        ),
        &mut repo_of,
        1_000,
    );
    let _ = engine.on_ingest(
        &IngestOutput {
            events: vec![
                (
                    edit_pre_event(
                        "sess-multi",
                        &fx.repo_canon,
                        &fx.transcript_path,
                        "tu-a1",
                        &a1_abs,
                    ),
                    1_100,
                ),
                (
                    edit_post_event(
                        "sess-multi",
                        &fx.repo_canon,
                        &fx.transcript_path,
                        "tu-a1",
                        &a1_abs,
                    ),
                    1_500,
                ),
                (
                    edit_pre_event(
                        "sess-multi",
                        &fx.repo_canon,
                        &fx.transcript_path,
                        "tu-a2",
                        &a2_abs,
                    ),
                    1_800,
                ),
                (
                    base_event(
                        "Stop",
                        "sess-multi",
                        &fx.repo_canon,
                        Some(&fx.transcript_path),
                    ),
                    2_000,
                ),
            ],
            ..IngestOutput::default()
        },
        &mut repo_of,
        2_000,
    );
    engine.on_capture(&[CaptureResult {
        root: fx.repo_canon.clone(),
        started_ms: 1_600,
        at_ms: 1_700,
        coverage: "complete".to_string(),
    }]);
    let card_a_rev1 = poll_until_cards(&mut engine, 2_100, &ctx, 1);
    let turn_a_id = card_a_rev1[0].card_id.clone();

    // Turn B (started 3_000, closed 4_000).
    let _ = engine.on_ingest(
        &user_prompt_out(
            "sess-multi",
            &fx.repo_canon,
            &fx.transcript_path,
            "Turn B",
            3_000,
        ),
        &mut repo_of,
        3_000,
    );
    let _ = engine.on_ingest(
        &IngestOutput {
            events: vec![
                (
                    edit_pre_event(
                        "sess-multi",
                        &fx.repo_canon,
                        &fx.transcript_path,
                        "tu-b1",
                        &b1_abs,
                    ),
                    3_100,
                ),
                (
                    edit_post_event(
                        "sess-multi",
                        &fx.repo_canon,
                        &fx.transcript_path,
                        "tu-b1",
                        &b1_abs,
                    ),
                    3_500,
                ),
                (
                    base_event(
                        "Stop",
                        "sess-multi",
                        &fx.repo_canon,
                        Some(&fx.transcript_path),
                    ),
                    4_000,
                ),
            ],
            ..IngestOutput::default()
        },
        &mut repo_of,
        4_000,
    );
    engine.on_capture(&[CaptureResult {
        root: fx.repo_canon.clone(),
        started_ms: 3_600,
        at_ms: 3_700,
        coverage: "complete".to_string(),
    }]);
    let card_b_rev1 = poll_until_cards(&mut engine, 4_100, &ctx, 1);
    let turn_b_id = card_b_rev1[0].card_id.clone();
    assert_ne!(turn_a_id, turn_b_id);

    // Turn C (started 5_000, stays open while tu-a2 completes).
    let _ = engine.on_ingest(
        &user_prompt_out(
            "sess-multi",
            &fx.repo_canon,
            &fx.transcript_path,
            "Turn C",
            5_000,
        ),
        &mut repo_of,
        5_000,
    );
    let _ = engine.on_ingest(
        &IngestOutput {
            events: vec![
                (
                    edit_pre_event(
                        "sess-multi",
                        &fx.repo_canon,
                        &fx.transcript_path,
                        "tu-c1",
                        &c1_abs,
                    ),
                    5_100,
                ),
                (
                    edit_post_event(
                        "sess-multi",
                        &fx.repo_canon,
                        &fx.transcript_path,
                        "tu-c1",
                        &c1_abs,
                    ),
                    5_200,
                ),
            ],
            ..IngestOutput::default()
        },
        &mut repo_of,
        5_200,
    );
    engine.on_capture(&[CaptureResult {
        root: fx.repo_canon.clone(),
        started_ms: 5_300,
        at_ms: 5_400,
        coverage: "complete".to_string(),
    }]);

    // Late completion for Turn A's tu-a2 at 6_000 (while Turn B is closed and Turn C is open).
    fx.append_version("src/a2.ts", 6_100, &s_a2, None, true);
    let _ = engine.on_ingest(
        &IngestOutput {
            events: vec![(
                edit_post_event(
                    "sess-multi",
                    &fx.repo_canon,
                    &fx.transcript_path,
                    "tu-a2",
                    &a2_abs,
                ),
                6_000,
            )],
            ..IngestOutput::default()
        },
        &mut repo_of,
        6_000,
    );

    // Close Turn C at 6_500 before capture >= 6_000 arrives.
    // Turn C's only edit finished at 5_200 (already captured at 5_300), so Turn C must build
    // immediately without waiting on Turn A's 6_000 edit.
    let _ = engine.on_ingest(
        &IngestOutput {
            events: vec![(
                base_event(
                    "Stop",
                    "sess-multi",
                    &fx.repo_canon,
                    Some(&fx.transcript_path),
                ),
                6_500,
            )],
            ..IngestOutput::default()
        },
        &mut repo_of,
        6_500,
    );

    let turn_c_cards = poll_until_cards(&mut engine, 6_600, &ctx, 1);
    assert_eq!(turn_c_cards.len(), 1);
    assert_eq!(turn_c_cards[0].started_ms, 5_000);
    assert_eq!(turn_c_cards[0].rev, 1);
    assert_eq!(turn_c_cards[0].blocks.len(), 1);
    assert_eq!(turn_c_cards[0].blocks[0].path, "src/c1.ts");

    // Turn A must still be waiting for capture >= 6_000, and Turn B must not emit a rev 2.
    assert_no_cards_for(&mut engine, 6_650, &ctx, Duration::from_millis(120));

    engine.on_capture(&[CaptureResult {
        root: fx.repo_canon.clone(),
        started_ms: 6_150,
        at_ms: 6_250,
        coverage: "complete".to_string(),
    }]);
    let turn_a_rev2 = poll_until_cards(&mut engine, 6_700, &ctx, 1);
    assert_eq!(turn_a_rev2.len(), 1);
    assert_eq!(turn_a_rev2[0].card_id, turn_a_id);
    assert_eq!(turn_a_rev2[0].rev, 2);
    assert_eq!(turn_a_rev2[0].blocks.len(), 2);
    assert_eq!(turn_a_rev2[0].blocks[0].path, "src/a1.ts");
    assert_eq!(turn_a_rev2[0].blocks[1].path, "src/a2.ts");
    assert_eq!(
        turn_a_rev2[0].blocks[1].after.as_deref(),
        Some(s_a2.as_str())
    );

    assert_no_cards_for(&mut engine, 6_800, &ctx, Duration::from_millis(120));
}

#[test]
fn shared_cache_retains_versions_for_overlapping_open_session() {
    let fx = Fixture::new("sess-a");
    let s0_a = fx.put_object(1, "export const a = 0;\n");
    let s_a = fx.put_object(2, "export const a = 1;\n");
    let s0_b = fx.put_object(3, "export const b = 0;\n");
    let s_b = fx.put_object(4, "export const b = 2;\n");
    fx.append_version("src/a.ts", 1_550, &s_a, Some(&s0_a), false);
    fx.append_version("src/b.ts", 3_550, &s_b, Some(&s0_b), false);
    fx.write_transcript("1970-01-01T00:00:01.000Z", "Session A", &[]);

    let mut engine = Engine::new(fx.home.clone(), 1);
    let mut repo_of = |_: &str| fx.repo_info();
    let ctx = fx.ctx(true);
    let a_abs = fx.file_abs("src/a.ts");
    let b_abs = fx.file_abs("src/b.ts");

    // Session A opens and edits at 1_100..1_500, remaining open.
    let _ = engine.on_ingest(
        &user_prompt_out(
            "sess-a",
            &fx.repo_canon,
            &fx.transcript_path,
            "Session A",
            1_000,
        ),
        &mut repo_of,
        1_000,
    );
    let _ = engine.on_ingest(
        &IngestOutput {
            events: vec![
                (
                    edit_pre_event(
                        "sess-a",
                        &fx.repo_canon,
                        &fx.transcript_path,
                        "tu-a",
                        &a_abs,
                    ),
                    1_100,
                ),
                (
                    edit_post_event(
                        "sess-a",
                        &fx.repo_canon,
                        &fx.transcript_path,
                        "tu-a",
                        &a_abs,
                    ),
                    1_500,
                ),
            ],
            ..IngestOutput::default()
        },
        &mut repo_of,
        1_500,
    );

    // Session B starts later, closes, and builds first.
    let _ = engine.on_ingest(
        &user_prompt_out(
            "sess-b",
            &fx.repo_canon,
            &fx.transcript_path,
            "Session B",
            3_000,
        ),
        &mut repo_of,
        3_000,
    );
    let _ = engine.on_ingest(
        &IngestOutput {
            events: vec![
                (
                    edit_pre_event(
                        "sess-b",
                        &fx.repo_canon,
                        &fx.transcript_path,
                        "tu-b",
                        &b_abs,
                    ),
                    3_100,
                ),
                (
                    edit_post_event(
                        "sess-b",
                        &fx.repo_canon,
                        &fx.transcript_path,
                        "tu-b",
                        &b_abs,
                    ),
                    3_500,
                ),
                (
                    base_event("Stop", "sess-b", &fx.repo_canon, Some(&fx.transcript_path)),
                    4_000,
                ),
            ],
            ..IngestOutput::default()
        },
        &mut repo_of,
        4_000,
    );
    engine.on_capture(&[CaptureResult {
        root: fx.repo_canon.clone(),
        started_ms: 3_600,
        at_ms: 3_700,
        coverage: "complete".to_string(),
    }]);
    let card_b = poll_until_cards(&mut engine, 4_100, &ctx, 1);
    assert_eq!(card_b[0].blocks[0].after.as_deref(), Some(s_b.as_str()));

    // Now Session A stops and builds; version at 1_550 must still be retained.
    let _ = engine.on_ingest(
        &IngestOutput {
            events: vec![(
                base_event("Stop", "sess-a", &fx.repo_canon, Some(&fx.transcript_path)),
                5_000,
            )],
            ..IngestOutput::default()
        },
        &mut repo_of,
        5_000,
    );
    let card_a = poll_until_cards(&mut engine, 5_100, &ctx, 1);
    assert_eq!(card_a[0].session_id, "sess-a");
    assert_eq!(card_a[0].blocks.len(), 1);
    assert_eq!(card_a[0].blocks[0].path, "src/a.ts");
    assert_eq!(card_a[0].blocks[0].before.as_deref(), Some(s0_a.as_str()));
    assert_eq!(card_a[0].blocks[0].after.as_deref(), Some(s_a.as_str()));
}

#[test]
fn shared_cache_retains_versions_across_intervening_build_for_revision() {
    let fx = Fixture::new("sess-c");
    let s0_c1 = fx.put_object(1, "export const c1 = 0;\n");
    let s_c1 = fx.put_object(2, "export const c1 = 1;\n");
    let s_c2 = fx.put_object(3, "export const c2 = 2;\n");
    let s0_d = fx.put_object(4, "export const d = 0;\n");
    let s_d = fx.put_object(5, "export const d = 3;\n");
    fx.append_version("src/c1.ts", 10_550, &s_c1, Some(&s0_c1), false);
    fx.append_version("src/d.ts", 20_550, &s_d, Some(&s0_d), false);
    fx.write_transcript("1970-01-01T00:00:10.000Z", "Session C", &[]);

    let mut engine = Engine::new(fx.home.clone(), 1);
    let mut repo_of = |_: &str| fx.repo_info();
    let ctx = fx.ctx(true);
    let c1_abs = fx.file_abs("src/c1.ts");
    let c2_abs = fx.file_abs("src/c2.ts");
    let d_abs = fx.file_abs("src/d.ts");

    // Session C builds rev 1 with src/c1.ts and unclosed tu-c2.
    let _ = engine.on_ingest(
        &user_prompt_out(
            "sess-c",
            &fx.repo_canon,
            &fx.transcript_path,
            "Session C",
            10_000,
        ),
        &mut repo_of,
        10_000,
    );
    let _ = engine.on_ingest(
        &IngestOutput {
            events: vec![
                (
                    edit_pre_event(
                        "sess-c",
                        &fx.repo_canon,
                        &fx.transcript_path,
                        "tu-c1",
                        &c1_abs,
                    ),
                    10_100,
                ),
                (
                    edit_post_event(
                        "sess-c",
                        &fx.repo_canon,
                        &fx.transcript_path,
                        "tu-c1",
                        &c1_abs,
                    ),
                    10_500,
                ),
                (
                    edit_pre_event(
                        "sess-c",
                        &fx.repo_canon,
                        &fx.transcript_path,
                        "tu-c2",
                        &c2_abs,
                    ),
                    11_000,
                ),
                (
                    base_event("Stop", "sess-c", &fx.repo_canon, Some(&fx.transcript_path)),
                    12_000,
                ),
            ],
            ..IngestOutput::default()
        },
        &mut repo_of,
        12_000,
    );
    engine.on_capture(&[CaptureResult {
        root: fx.repo_canon.clone(),
        started_ms: 10_600,
        at_ms: 10_700,
        coverage: "complete".to_string(),
    }]);
    let c_rev1 = poll_until_cards(&mut engine, 12_100, &ctx, 1);
    assert_eq!(c_rev1[0].rev, 1);

    // Session D runs and builds an intervening card in the same repo.
    let _ = engine.on_ingest(
        &user_prompt_out(
            "sess-d",
            &fx.repo_canon,
            &fx.transcript_path,
            "Session D",
            20_000,
        ),
        &mut repo_of,
        20_000,
    );
    let _ = engine.on_ingest(
        &IngestOutput {
            events: vec![
                (
                    edit_pre_event(
                        "sess-d",
                        &fx.repo_canon,
                        &fx.transcript_path,
                        "tu-d",
                        &d_abs,
                    ),
                    20_100,
                ),
                (
                    edit_post_event(
                        "sess-d",
                        &fx.repo_canon,
                        &fx.transcript_path,
                        "tu-d",
                        &d_abs,
                    ),
                    20_500,
                ),
                (
                    base_event("Stop", "sess-d", &fx.repo_canon, Some(&fx.transcript_path)),
                    22_000,
                ),
            ],
            ..IngestOutput::default()
        },
        &mut repo_of,
        22_000,
    );
    engine.on_capture(&[CaptureResult {
        root: fx.repo_canon.clone(),
        started_ms: 20_600,
        at_ms: 20_700,
        coverage: "complete".to_string(),
    }]);
    let card_d = poll_until_cards(&mut engine, 22_100, &ctx, 1);
    assert_eq!(card_d[0].session_id, "sess-d");

    // Late completion for Session C inside its 60 s revision window must retain c1's version.
    fx.append_version("src/c2.ts", 25_100, &s_c2, None, true);
    let _ = engine.on_ingest(
        &IngestOutput {
            events: vec![(
                edit_post_event(
                    "sess-c",
                    &fx.repo_canon,
                    &fx.transcript_path,
                    "tu-c2",
                    &c2_abs,
                ),
                25_000,
            )],
            ..IngestOutput::default()
        },
        &mut repo_of,
        25_000,
    );
    engine.on_capture(&[CaptureResult {
        root: fx.repo_canon.clone(),
        started_ms: 25_150,
        at_ms: 25_250,
        coverage: "complete".to_string(),
    }]);
    let c_rev2 = poll_until_cards(&mut engine, 25_300, &ctx, 1);
    assert_eq!(c_rev2[0].session_id, "sess-c");
    assert_eq!(c_rev2[0].rev, 2);
    assert_eq!(c_rev2[0].blocks.len(), 2);
    assert_eq!(c_rev2[0].blocks[0].path, "src/c1.ts");
    assert_eq!(c_rev2[0].blocks[0].before.as_deref(), Some(s0_c1.as_str()));
    assert_eq!(c_rev2[0].blocks[0].after.as_deref(), Some(s_c1.as_str()));
    assert_eq!(c_rev2[0].blocks[1].path, "src/c2.ts");
    assert_eq!(c_rev2[0].blocks[1].after.as_deref(), Some(s_c2.as_str()));
}

#[test]
fn bash_only_turn_waits_for_capture_while_unchanged_stays_empty() {
    let fx = Fixture::new("sess-bash");
    let s0 = fx.put_object(1, "export const b = 1;\n");
    let s1 = fx.put_object(2, "export const b = 2;\n");
    fx.write_transcript("1970-01-01T00:00:01.000Z", "Run bash script", &[]);

    let mut engine = Engine::new(fx.home.clone(), 1);
    let mut repo_of = |_: &str| fx.repo_info();
    let ctx = fx.ctx(true);

    let _ = engine.on_ingest(
        &user_prompt_out(
            "sess-bash",
            &fx.repo_canon,
            &fx.transcript_path,
            "Run bash script",
            1_000,
        ),
        &mut repo_of,
        1_000,
    );
    let _ = engine.on_ingest(
        &IngestOutput {
            events: vec![
                (
                    bash_pre_event(
                        "sess-bash",
                        &fx.repo_canon,
                        &fx.transcript_path,
                        "tu-b1",
                        "sed -i s/1/2/ src/bash.ts",
                    ),
                    1_100,
                ),
                (
                    bash_post_event("sess-bash", &fx.repo_canon, &fx.transcript_path, "tu-b1"),
                    1_500,
                ),
                (
                    base_event(
                        "Stop",
                        "sess-bash",
                        &fx.repo_canon,
                        Some(&fx.transcript_path),
                    ),
                    2_000,
                ),
            ],
            ..IngestOutput::default()
        },
        &mut repo_of,
        2_000,
    );

    // Before capture >= 1_500 arrives, turn must wait rather than dropping an empty card.
    thread::sleep(Duration::from_millis(80));
    assert!(
        engine.poll(2_100, &ctx).is_empty(),
        "completed Bash turn must wait for capture"
    );

    // Capture finishes and version arrives.
    fx.append_version("src/bash.ts", 1_550, &s1, Some(&s0), false);
    engine.on_capture(&[CaptureResult {
        root: fx.repo_canon.clone(),
        started_ms: 1_600,
        at_ms: 1_700,
        coverage: "complete".to_string(),
    }]);

    let cards = poll_until_cards(&mut engine, 2_200, &ctx, 1);
    assert_eq!(cards[0].blocks.len(), 1);
    assert_eq!(cards[0].blocks[0].via, BlockVia::Bash);
    assert_eq!(cards[0].blocks[0].path, "src/bash.ts");
    assert_eq!(cards[0].blocks[0].after.as_deref(), Some(s1.as_str()));

    // Truly unchanged Bash turn must still be suppressed after capture/timeout.
    let _ = engine.on_ingest(
        &user_prompt_out(
            "sess-bash-noop",
            &fx.repo_canon,
            &fx.transcript_path,
            "Check git status",
            10_000,
        ),
        &mut repo_of,
        10_000,
    );
    let _ = engine.on_ingest(
        &IngestOutput {
            events: vec![
                (
                    bash_pre_event(
                        "sess-bash-noop",
                        &fx.repo_canon,
                        &fx.transcript_path,
                        "tu-b2",
                        "git status",
                    ),
                    10_100,
                ),
                (
                    bash_post_event(
                        "sess-bash-noop",
                        &fx.repo_canon,
                        &fx.transcript_path,
                        "tu-b2",
                    ),
                    10_500,
                ),
                (
                    base_event(
                        "Stop",
                        "sess-bash-noop",
                        &fx.repo_canon,
                        Some(&fx.transcript_path),
                    ),
                    11_000,
                ),
            ],
            ..IngestOutput::default()
        },
        &mut repo_of,
        11_000,
    );
    engine.on_capture(&[CaptureResult {
        root: fx.repo_canon.clone(),
        started_ms: 10_600,
        at_ms: 10_700,
        coverage: "complete".to_string(),
    }]);
    thread::sleep(Duration::from_millis(80));
    assert!(engine.poll(11_200, &ctx).is_empty());
    assert!(engine.poll(16_000, &ctx).is_empty());
}

#[test]
fn late_bash_completion_waits_for_capture_and_revises_card() {
    let fx = Fixture::new("sess-late-bash");
    let s0 = fx.put_object(1, "export const e = 1;\n");
    let s1 = fx.put_object(2, "export const e = 2;\n");
    let s2 = fx.put_object(3, "export const gen = 1;\n");
    fx.append_version("src/e.ts", 1_550, &s1, Some(&s0), false);
    fx.write_transcript("1970-01-01T00:00:01.000Z", "Edit plus bash", &[]);

    let mut engine = Engine::new(fx.home.clone(), 1);
    let mut repo_of = |_: &str| fx.repo_info();
    let ctx = fx.ctx(true);
    let e_abs = fx.file_abs("src/e.ts");

    let _ = engine.on_ingest(
        &user_prompt_out(
            "sess-late-bash",
            &fx.repo_canon,
            &fx.transcript_path,
            "Edit plus bash",
            1_000,
        ),
        &mut repo_of,
        1_000,
    );
    let _ = engine.on_ingest(
        &IngestOutput {
            events: vec![
                (
                    edit_pre_event(
                        "sess-late-bash",
                        &fx.repo_canon,
                        &fx.transcript_path,
                        "tu-e1",
                        &e_abs,
                    ),
                    1_100,
                ),
                (
                    edit_post_event(
                        "sess-late-bash",
                        &fx.repo_canon,
                        &fx.transcript_path,
                        "tu-e1",
                        &e_abs,
                    ),
                    1_500,
                ),
                (
                    bash_pre_event(
                        "sess-late-bash",
                        &fx.repo_canon,
                        &fx.transcript_path,
                        "tu-b",
                        "node gen.js",
                    ),
                    1_800,
                ),
                (
                    base_event(
                        "Stop",
                        "sess-late-bash",
                        &fx.repo_canon,
                        Some(&fx.transcript_path),
                    ),
                    2_000,
                ),
            ],
            ..IngestOutput::default()
        },
        &mut repo_of,
        2_000,
    );
    engine.on_capture(&[CaptureResult {
        root: fx.repo_canon.clone(),
        started_ms: 1_600,
        at_ms: 1_700,
        coverage: "complete".to_string(),
    }]);
    let rev1 = poll_until_cards(&mut engine, 2_100, &ctx, 1);
    assert_eq!(rev1[0].rev, 1);

    let _ = engine.on_ingest(
        &IngestOutput {
            events: vec![(
                bash_post_event(
                    "sess-late-bash",
                    &fx.repo_canon,
                    &fx.transcript_path,
                    "tu-b",
                ),
                5_000,
            )],
            ..IngestOutput::default()
        },
        &mut repo_of,
        5_000,
    );

    assert_no_cards_for(&mut engine, 5_200, &ctx, Duration::from_millis(120));

    fx.append_version("src/gen.ts", 5_100, &s2, None, true);
    engine.on_capture(&[CaptureResult {
        root: fx.repo_canon.clone(),
        started_ms: 5_150,
        at_ms: 5_250,
        coverage: "complete".to_string(),
    }]);
    let rev2 = poll_until_cards(&mut engine, 5_300, &ctx, 1);
    assert_eq!(rev2[0].rev, 2);
    assert_eq!(rev2[0].blocks.len(), 2);
    assert_eq!(rev2[0].blocks[1].via, BlockVia::Bash);
    assert_eq!(rev2[0].blocks[1].path, "src/gen.ts");
    assert_eq!(rev2[0].blocks[1].after.as_deref(), Some(s2.as_str()));
}

#[test]
fn store_error_after_cache_prime_suppresses_code_and_marks_capture_off() {
    let fx = Fixture::new("sess-store-err");
    let s0 = fx.put_object(1, "export const v = 0;\n");
    let s1 = fx.put_object(2, "export const v = 1;\n");
    fx.append_version("src/a.ts", 1_550, &s1, Some(&s0), false);
    fx.write_transcript("1970-01-01T00:00:01.000Z", "Prime cache", &[]);

    let mut engine = Engine::new(fx.home.clone(), 1);
    let mut repo_of = |_: &str| fx.repo_info();
    let ctx = fx.ctx(true);
    let a_abs = fx.file_abs("src/a.ts");
    let b_abs = fx.file_abs("src/b.ts");

    let _ = engine.on_ingest(
        &user_prompt_out(
            "sess-store-err",
            &fx.repo_canon,
            &fx.transcript_path,
            "Prime cache",
            1_000,
        ),
        &mut repo_of,
        1_000,
    );
    let _ = engine.on_ingest(
        &IngestOutput {
            events: vec![
                (
                    edit_pre_event(
                        "sess-store-err",
                        &fx.repo_canon,
                        &fx.transcript_path,
                        "tu-1",
                        &a_abs,
                    ),
                    1_100,
                ),
                (
                    edit_post_event(
                        "sess-store-err",
                        &fx.repo_canon,
                        &fx.transcript_path,
                        "tu-1",
                        &a_abs,
                    ),
                    1_500,
                ),
                (
                    edit_pre_event(
                        "sess-store-err",
                        &fx.repo_canon,
                        &fx.transcript_path,
                        "tu-2",
                        &b_abs,
                    ),
                    1_800,
                ),
                (
                    base_event(
                        "Stop",
                        "sess-store-err",
                        &fx.repo_canon,
                        Some(&fx.transcript_path),
                    ),
                    2_000,
                ),
            ],
            ..IngestOutput::default()
        },
        &mut repo_of,
        2_000,
    );
    engine.on_capture(&[CaptureResult {
        root: fx.repo_canon.clone(),
        started_ms: 2_050,
        at_ms: 2_100,
        coverage: "complete".to_string(),
    }]);
    let rev1 = poll_until_cards(&mut engine, 2_100, &ctx, 1);
    assert_eq!(rev1[0].blocks[0].after.as_deref(), Some(s1.as_str()));
    assert_eq!(
        rev1[0].coverage.state,
        CoverageState::Full,
        "coverage reasons: {:?}",
        rev1[0].coverage.reasons
    );

    // Replace events.jsonl with a directory so StoreReader::versions_since returns an error.
    let events_path = fx.store_dir.join("events.jsonl");
    fs::remove_file(&events_path).expect("remove events.jsonl");
    fs::create_dir(&events_path).expect("create dir at events.jsonl");

    let _ = engine.on_ingest(
        &IngestOutput {
            events: vec![(
                edit_post_event(
                    "sess-store-err",
                    &fx.repo_canon,
                    &fx.transcript_path,
                    "tu-2",
                    &b_abs,
                ),
                5_000,
            )],
            ..IngestOutput::default()
        },
        &mut repo_of,
        5_000,
    );
    engine.on_capture(&[CaptureResult {
        root: fx.repo_canon.clone(),
        started_ms: 5_100,
        at_ms: 5_200,
        coverage: "complete".to_string(),
    }]);

    let rev2 = poll_until_cards(&mut engine, 5_300, &ctx, 1);
    assert_eq!(rev2[0].rev, 2);
    assert_eq!(rev2[0].blocks.len(), 2);
    for blk in &rev2[0].blocks {
        assert!(
            blk.before.is_none(),
            "expected no before sha on store error"
        );
        assert!(blk.after.is_none(), "expected no after sha on store error");
        assert!(blk.symbol.is_none(), "expected no symbol on store error");
        assert!(blk.added.is_none());
        assert!(blk.removed.is_none());
        assert_eq!(blk.labels, vec![Label::NotCaptured {}]);
    }
    assert_eq!(
        rev2[0].coverage.state,
        CoverageState::Partial,
        "coverage reasons: {:?}",
        rev2[0].coverage.reasons
    );
    assert!(
        rev2[0]
            .coverage
            .reasons
            .contains(&CoverageReason::CaptureOff),
        "expected capture_off, got {:?}",
        rev2[0].coverage.reasons
    );
}

#[test]
fn store_tail_cut_marks_capture_late() {
    let fx = Fixture::new("sess-tail-cut");
    let s0 = fx.put_object(1, "export const t = 0;\n");
    let s1 = fx.put_object(2, "export const t = 1;\n");
    let pad_line = "{\"v\":1,\"node\":\"ignore\",\"ts\":500}\n";
    let mut padded = String::with_capacity(2 * 1024 * 1024 + 8192);
    while padded.len() <= 2 * 1024 * 1024 + 4096 {
        padded.push_str(pad_line);
    }
    fs::write(fx.store_dir.join("events.jsonl"), padded).expect("write padded events.jsonl");
    fx.append_version("src/t.ts", 1_550, &s1, Some(&s0), false);
    fx.write_transcript("1970-01-01T00:00:01.000Z", "Tail cut turn", &[]);

    let mut engine = Engine::new(fx.home.clone(), 1);
    let mut repo_of = |_: &str| fx.repo_info();
    let ctx = fx.ctx(true);
    let t_abs = fx.file_abs("src/t.ts");

    let _ = engine.on_ingest(
        &user_prompt_out(
            "sess-tail-cut",
            &fx.repo_canon,
            &fx.transcript_path,
            "Tail cut turn",
            1_000,
        ),
        &mut repo_of,
        1_000,
    );
    let _ = engine.on_ingest(
        &IngestOutput {
            events: vec![
                (
                    edit_pre_event(
                        "sess-tail-cut",
                        &fx.repo_canon,
                        &fx.transcript_path,
                        "tu-t1",
                        &t_abs,
                    ),
                    1_100,
                ),
                (
                    edit_post_event(
                        "sess-tail-cut",
                        &fx.repo_canon,
                        &fx.transcript_path,
                        "tu-t1",
                        &t_abs,
                    ),
                    1_500,
                ),
                (
                    base_event(
                        "Stop",
                        "sess-tail-cut",
                        &fx.repo_canon,
                        Some(&fx.transcript_path),
                    ),
                    2_000,
                ),
            ],
            ..IngestOutput::default()
        },
        &mut repo_of,
        2_000,
    );
    engine.on_capture(&[CaptureResult {
        root: fx.repo_canon.clone(),
        started_ms: 1_600,
        at_ms: 1_700,
        coverage: "complete".to_string(),
    }]);

    let cards = poll_until_cards(&mut engine, 2_100, &ctx, 1);
    assert_eq!(cards[0].blocks.len(), 1);
    assert_eq!(cards[0].blocks[0].after.as_deref(), Some(s1.as_str()));
    assert_eq!(
        cards[0].coverage.state,
        CoverageState::Partial,
        "coverage reasons: {:?}",
        cards[0].coverage.reasons
    );
    assert!(
        cards[0]
            .coverage
            .reasons
            .contains(&CoverageReason::CaptureLate),
        "expected capture_late on tail_cut, got {:?}",
        cards[0].coverage.reasons
    );
}

#[test]
fn set_removed_drops_pending_discards_in_flight_and_ignores_reenable() {
    use std::sync::{Mutex, mpsc};

    let fx = Fixture::new("sess-rm-1");
    let before = "export function a(): number { return 1; }\n";
    let after = "export function a(): number { return 2; }\n";
    let b_sha = fx.put_object(1, before);
    let a_sha = fx.put_object(2, after);
    fx.append_version("src/a.ts", 1_600, &a_sha, Some(&b_sha), false);
    fx.write_transcript(
        "1970-01-01T00:00:01.000Z",
        "Update a",
        &[("tu-1", "Updating a.")],
    );

    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::sync_channel::<()>(1);
    let entered_tx = Mutex::new(entered_tx);
    let release_rx = Mutex::new(release_rx);
    let hook_once = AtomicBool::new(false);

    let mut engine = Engine::new_with_build_hook(
        fx.home.clone(),
        1,
        Arc::new(move |_| {
            if !hook_once.swap(true, Ordering::SeqCst) {
                let _ = entered_tx.lock().unwrap().send(());
                let _ = release_rx
                    .lock()
                    .unwrap()
                    .recv_timeout(Duration::from_secs(10));
            }
        }),
    );
    struct DropRelease(mpsc::SyncSender<()>);
    impl Drop for DropRelease {
        fn drop(&mut self) {
            let _ = self.0.try_send(());
        }
    }
    let _unblock = DropRelease(release_tx.clone());

    let mut repo_of = |_: &str| fx.repo_info();
    let ctx = fx.ctx(true);
    let target = fx.file_abs("src/a.ts");

    // Turn 1 enters the worker and waits on the build hook.
    let _ = engine.on_ingest(
        &user_prompt_out(
            "sess-rm-1",
            &fx.repo_canon,
            &fx.transcript_path,
            "p1",
            1_000,
        ),
        &mut repo_of,
        1_000,
    );
    let _ = engine.on_ingest(
        &IngestOutput {
            events: vec![
                (
                    edit_pre_event(
                        "sess-rm-1",
                        &fx.repo_canon,
                        &fx.transcript_path,
                        "tu-1",
                        &target,
                    ),
                    1_100,
                ),
                (
                    edit_post_event(
                        "sess-rm-1",
                        &fx.repo_canon,
                        &fx.transcript_path,
                        "tu-1",
                        &target,
                    ),
                    1_500,
                ),
                (
                    base_event(
                        "Stop",
                        "sess-rm-1",
                        &fx.repo_canon,
                        Some(&fx.transcript_path),
                    ),
                    1_800,
                ),
            ],
            ..IngestOutput::default()
        },
        &mut repo_of,
        1_800,
    );
    engine.on_capture(&[CaptureResult {
        root: fx.repo_canon.clone(),
        started_ms: 1_500,
        at_ms: 1_600,
        coverage: "complete".to_string(),
    }]);
    assert!(engine.poll(2_000, &ctx).is_empty());
    entered_rx
        .recv_timeout(Duration::from_secs(3))
        .expect("turn 1 should enter build worker");

    // Turn 2 stays pending awaiting capture.
    let _ = engine.on_ingest(
        &user_prompt_out(
            "sess-rm-2",
            &fx.repo_canon,
            &fx.transcript_path,
            "p2",
            3_000,
        ),
        &mut repo_of,
        3_000,
    );
    let _ = engine.on_ingest(
        &IngestOutput {
            events: vec![
                (
                    edit_pre_event(
                        "sess-rm-2",
                        &fx.repo_canon,
                        &fx.transcript_path,
                        "tu-2",
                        &target,
                    ),
                    3_100,
                ),
                (
                    edit_post_event(
                        "sess-rm-2",
                        &fx.repo_canon,
                        &fx.transcript_path,
                        "tu-2",
                        &target,
                    ),
                    3_500,
                ),
                (
                    base_event(
                        "Stop",
                        "sess-rm-2",
                        &fx.repo_canon,
                        Some(&fx.transcript_path),
                    ),
                    3_800,
                ),
            ],
            ..IngestOutput::default()
        },
        &mut repo_of,
        3_800,
    );

    engine.set_removed();
    engine.set_enabled(true);
    assert!(
        engine
            .on_ingest(
                &user_prompt_out(
                    "sess-rm-3",
                    &fx.repo_canon,
                    &fx.transcript_path,
                    "p3",
                    4_000
                ),
                &mut repo_of,
                4_000,
            )
            .is_empty()
    );
    let _ = engine.on_ingest(
        &IngestOutput {
            events: vec![
                (
                    edit_pre_event(
                        "sess-rm-3",
                        &fx.repo_canon,
                        &fx.transcript_path,
                        "tu-3",
                        &target,
                    ),
                    4_100,
                ),
                (
                    edit_post_event(
                        "sess-rm-3",
                        &fx.repo_canon,
                        &fx.transcript_path,
                        "tu-3",
                        &target,
                    ),
                    4_500,
                ),
                (
                    base_event(
                        "Stop",
                        "sess-rm-3",
                        &fx.repo_canon,
                        Some(&fx.transcript_path),
                    ),
                    4_800,
                ),
            ],
            ..IngestOutput::default()
        },
        &mut repo_of,
        4_800,
    );
    engine.on_capture(&[CaptureResult {
        root: fx.repo_canon.clone(),
        started_ms: 5_000,
        at_ms: 5_100,
        coverage: "complete".to_string(),
    }]);

    release_tx.send(()).unwrap();
    // Even with ctx.cards == true, the completed in-flight card and pending turns are dropped.
    assert_no_cards_for(&mut engine, 20_000, &ctx, Duration::from_millis(200));
}

#[test]
fn parallel_subagent_edit_and_open_bash_attribution() {
    let fx = Fixture::new("sess-par");
    let before = "export const v = 1;\n";
    let after = "export const v = 2;\n";
    let b_sha = fx.put_object(1, before);
    let a_sha = fx.put_object(2, after);
    fx.append_version("src/sub_file.ts", 40_500, &a_sha, Some(&b_sha), false);
    fx.append_version("src/bash_file.ts", 45_000, &a_sha, Some(&b_sha), false);
    fx.write_transcript("1970-01-01T00:00:01.000Z", "run tests", &[]);

    let mut engine = Engine::new(fx.home.clone(), 1);
    let info = fx.repo_info();
    let mut repo_of = |_: &str| info.clone();
    let ctx = fx.ctx(true);

    let _ = engine.on_ingest(
        &user_prompt_out(
            "sess-par",
            &fx.repo_canon,
            &fx.transcript_path,
            "run tests",
            1_000,
        ),
        &mut repo_of,
        1_000,
    );

    let sub_target = fx.repo_root.join("src/sub_file.ts");
    let mut sub_start = base_event(
        "SubagentStart",
        "sess-par",
        &fx.repo_canon,
        Some(&fx.transcript_path),
    );
    sub_start.agent_id = Some("sub-1".to_string());
    sub_start.agent_type = Some("Worker".to_string());

    let mut sub_bash_pre = bash_pre_event(
        "sess-par",
        &fx.repo_canon,
        &fx.transcript_path,
        "tu-sub-bash",
        "npm run watch",
    );
    sub_bash_pre.agent_id = Some("sub-1".to_string());

    let mut sub_edit_pre = edit_pre_event(
        "sess-par",
        &fx.repo_canon,
        &fx.transcript_path,
        "tu-sub-edit",
        &sub_target.to_string_lossy(),
    );
    sub_edit_pre.agent_id = Some("sub-1".to_string());

    let mut sub_edit_post = edit_post_event(
        "sess-par",
        &fx.repo_canon,
        &fx.transcript_path,
        "tu-sub-edit",
        &sub_target.to_string_lossy(),
    );
    sub_edit_post.agent_id = Some("sub-1".to_string());

    let main_bash_pre = bash_pre_event(
        "sess-par",
        &fx.repo_canon,
        &fx.transcript_path,
        "tu-main-bash",
        "cargo test",
    );
    let main_bash_post = bash_post_event(
        "sess-par",
        &fx.repo_canon,
        &fx.transcript_path,
        "tu-main-bash",
    );

    let _ = engine.on_ingest(
        &IngestOutput {
            events: vec![
                (sub_start, 1_200),
                (sub_bash_pre, 2_000),
                (main_bash_pre, 39_000),
                (sub_edit_pre, 40_000),
                (sub_edit_post, 41_000),
                (main_bash_post, 50_000),
                (
                    base_event(
                        "Stop",
                        "sess-par",
                        &fx.repo_canon,
                        Some(&fx.transcript_path),
                    ),
                    50_500,
                ),
            ],
            ..IngestOutput::default()
        },
        &mut repo_of,
        50_500,
    );

    engine.on_capture(&[CaptureResult {
        root: fx.repo_canon.clone(),
        started_ms: 50_600,
        at_ms: 50_700,
        coverage: "ok".to_string(),
    }]);

    let cards = poll_until_cards(&mut engine, 50_800, &ctx, 1);
    let main_card = cards
        .iter()
        .find(|c| c.agent_id.is_empty())
        .expect("expected main card");
    assert_eq!(main_card.outside_count, 0);
    assert_eq!(main_card.blocks.len(), 1);
    assert_eq!(main_card.blocks[0].path, "src/bash_file.ts");
    assert_eq!(main_card.blocks[0].via, BlockVia::Bash);
    assert_eq!(main_card.blocks[0].bash.as_ref().unwrap().candidates, 2);
}

#[test]
fn store_log_shrink_during_turn_does_not_duplicate_outside_count() {
    let fx = Fixture::new("sess-shrink");
    let s0 = fx.put_object(1, "const z = 1;\n");
    let s1 = fx.put_object(2, "const z = 2;\n");
    let s2 = fx.put_object(3, "const z = 3;\n");
    let out_sha = fx.put_object(4, "const outside = true;\n");

    let events_path = fx.store_dir.join("events.jsonl");
    let pad = "x".repeat(700);
    let pad_line = format!(
        "{{\"v\":1,\"node\":\"file_version\",\"ts\":500,\"file_rel\":\"src/pad.ts\",\"sha\":\"{s0}\",\"pad\":\"{pad}\"}}\n"
    );
    fs::write(&events_path, pad_line.as_bytes()).expect("write pad line");
    fx.append_version("src/out.ts", 1_200, &out_sha, None, true);
    fx.append_version("src/z.ts", 1_550, &s1, Some(&s0), false);
    fx.write_transcript("1970-01-01T00:00:01.000Z", "Change z", &[]);

    let mut engine = Engine::new(fx.home.clone(), 1);
    let mut repo_of = |_: &str| fx.repo_info();
    let ctx = fx.ctx(true);
    let target = fx.file_abs("src/z.ts");

    let _ = engine.on_ingest(
        &user_prompt_out(
            "sess-shrink",
            &fx.repo_canon,
            &fx.transcript_path,
            "Change z",
            1_000,
        ),
        &mut repo_of,
        1_000,
    );
    let _ = engine.on_ingest(
        &IngestOutput {
            events: vec![
                (
                    edit_pre_event(
                        "sess-shrink",
                        &fx.repo_canon,
                        &fx.transcript_path,
                        "tu-1",
                        &target,
                    ),
                    1_100,
                ),
                (
                    edit_post_event(
                        "sess-shrink",
                        &fx.repo_canon,
                        &fx.transcript_path,
                        "tu-1",
                        &target,
                    ),
                    1_500,
                ),
                (
                    edit_pre_event(
                        "sess-shrink",
                        &fx.repo_canon,
                        &fx.transcript_path,
                        "tu-2",
                        &target,
                    ),
                    1_800,
                ),
                (
                    base_event(
                        "Stop",
                        "sess-shrink",
                        &fx.repo_canon,
                        Some(&fx.transcript_path),
                    ),
                    2_000,
                ),
            ],
            ..IngestOutput::default()
        },
        &mut repo_of,
        2_000,
    );
    engine.on_capture(&[CaptureResult {
        root: fx.repo_canon.clone(),
        started_ms: 1_600,
        at_ms: 1_700,
        coverage: "complete".to_string(),
    }]);

    let rev1 = poll_until_cards(&mut engine, 2_100, &ctx, 1);
    assert_eq!(rev1[0].rev, 1);
    assert_eq!(rev1[0].outside_count, 1);

    // Compact events.jsonl (remove padded line so length shrinks) while preserving
    // src/out.ts + src/z.ts and appending another event for the late edit.
    let before_compact_len = fs::metadata(&events_path).unwrap().len();
    fs::write(&events_path, b"").expect("clear events.jsonl for compaction");
    fx.append_version("src/out.ts", 1_200, &out_sha, None, true);
    fx.append_version("src/z.ts", 1_550, &s1, Some(&s0), false);
    fx.append_version("src/z.ts", 5_100, &s2, Some(&s1), false);
    assert!(fs::metadata(&events_path).unwrap().len() < before_compact_len);

    let _ = engine.on_ingest(
        &IngestOutput {
            events: vec![(
                edit_post_event(
                    "sess-shrink",
                    &fx.repo_canon,
                    &fx.transcript_path,
                    "tu-2",
                    &target,
                ),
                5_000,
            )],
            ..IngestOutput::default()
        },
        &mut repo_of,
        5_000,
    );
    engine.on_capture(&[CaptureResult {
        root: fx.repo_canon.clone(),
        started_ms: 5_200,
        at_ms: 5_300,
        coverage: "complete".to_string(),
    }]);

    let rev2 = poll_until_cards(&mut engine, 5_400, &ctx, 1);
    assert_eq!(rev2[0].rev, 2);
    assert_eq!(rev2[0].outside_count, 1);
}

fn run_command_with_timeout(cmd: &mut Command, timeout: Duration) -> std::process::Output {
    let mut child = cmd
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("spawn child");
    let stdout_pipe = child.stdout.take().expect("piped stdout");
    let stderr_pipe = child.stderr.take().expect("piped stderr");
    let out_t = std::thread::spawn(move || {
        use std::io::Read;
        let mut buf = Vec::new();
        let mut r = stdout_pipe;
        let _ = r.read_to_end(&mut buf);
        buf
    });
    let err_t = std::thread::spawn(move || {
        use std::io::Read;
        let mut buf = Vec::new();
        let mut r = stderr_pipe;
        let _ = r.read_to_end(&mut buf);
        buf
    });
    let start = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().expect("try_wait child") {
            break status;
        }
        if start.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            let stdout = out_t.join().unwrap_or_default();
            let stderr = err_t.join().unwrap_or_default();
            panic!(
                "child timed out after {timeout:?}; stdout={}, stderr={}",
                String::from_utf8_lossy(&stdout),
                String::from_utf8_lossy(&stderr),
            );
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    let stdout = out_t.join().unwrap_or_default();
    let stderr = err_t.join().unwrap_or_default();
    std::process::Output {
        status,
        stdout,
        stderr,
    }
}
