//! Integration tests for the change card engine (`rockyd::cards::Engine`).

use std::collections::BTreeSet;
use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use rocky_proto::cards::{BlockVia, Card, CardStatus, CoverageReason, CoverageState};
use rocky_proto::hook::HookEvent;
use rocky_proto::paths::{canonical_path, listening_store_dir, repo_id};
use rocky_proto::pipe::{CaptureHealth, CaptureState, RepoInfo};
use rockyd::capture::CaptureResult;
use rockyd::cards::windows::PromptIn;
use rockyd::cards::{Engine, EngineCtx};
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

impl Fixture {
    fn new(session_id: &str) -> Self {
        let tmp = tempfile::tempdir().expect("tempdir");
        let home = tmp.path().join("home");
        let repo_root = tmp.path().join("repo");
        let config_dir = tmp.path().join("claude");
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

fn sha256_hex_prefix32(session_id: &str, agent_id: &str, started_ms: u64) -> String {
    // Minimal standalone SHA-256 over "{session_id}\0{agent_id}\0{started_ms}" for golden assertions.
    const K: [u32; 64] = [
        0x428a_2f98,
        0x7137_4491,
        0xb5c0_fbcf,
        0xe9b5_dba5,
        0x3956_c25b,
        0x59f1_11f1,
        0x923f_82a4,
        0xab1c_5ed5,
        0xd807_aa98,
        0x1283_5b01,
        0x2431_85be,
        0x550c_7dc3,
        0x72be_5d74,
        0x80de_b1fe,
        0x9bdc_06a7,
        0xc19b_f174,
        0xe49b_69c1,
        0xefbe_4786,
        0x0fc1_9dc6,
        0x240c_a1cc,
        0x2de9_2c6f,
        0x4a74_84aa,
        0x5cb0_a9dc,
        0x76f9_88da,
        0x983e_5152,
        0xa831_c66d,
        0xb003_27c8,
        0xbf59_7fc7,
        0xc6e0_0bf3,
        0xd5a7_9147,
        0x06ca_6351,
        0x1429_2967,
        0x27b7_0a85,
        0x2e1b_2138,
        0x4d2c_6dfc,
        0x5338_0d13,
        0x650a_7354,
        0x766a_0abb,
        0x81c2_c92e,
        0x9272_2c85,
        0xa2bf_e8a1,
        0xa81a_664b,
        0xc24b_8b70,
        0xc76c_51a3,
        0xd192_e819,
        0xd699_0624,
        0xf40e_3585,
        0x106a_a070,
        0x19a4_c116,
        0x1e37_6c08,
        0x2748_774c,
        0x34b0_bcb5,
        0x391c_0cb3,
        0x4ed8_aa4a,
        0x5b9c_ca4f,
        0x682e_6ff3,
        0x748f_82ee,
        0x78a5_636f,
        0x84c8_7814,
        0x8cc7_0208,
        0x90be_fffa,
        0xa450_6ceb,
        0xbef9_a3f7,
        0xc671_78f2,
    ];
    let mut msg = format!("{session_id}\0{agent_id}\0{started_ms}").into_bytes();
    let bit_len = (msg.len() as u64) * 8;
    msg.push(0x80);
    while (msg.len() % 64) != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_be_bytes());
    let mut h: [u32; 8] = [
        0x6a09_e667,
        0xbb67_ae85,
        0x3c6e_f372,
        0xa54f_f53a,
        0x510e_527f,
        0x9b05_688c,
        0x1f83_d9ab,
        0x5be0_cd19,
    ];
    for chunk in msg.chunks_exact(64) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes(chunk[i * 4..i * 4 + 4].try_into().unwrap());
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh] = h;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let t1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        for (slot, delta) in h.iter_mut().zip([a, b, c, d, e, f, g, hh]) {
            *slot = slot.wrapping_add(delta);
        }
    }
    let hex: String = h.iter().map(|w| format!("{w:08x}")).collect();
    hex[..32].to_string()
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
    assert_eq!(card.card_id, sha256_hex_prefix32("sess-1", "", 1_000));
    assert_eq!(card.status, CardStatus::Done);
    assert_eq!(card.coverage.state, CoverageState::Full);
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
    assert_eq!(
        timeout_cards[0].card_id,
        sha256_hex_prefix32("sess-1", "", 10_000)
    );
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
        Some(sha256_hex_prefix32("sess-parent", "", 1_000).as_str())
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
    assert!(
        elapsed <= Duration::from_millis(500),
        "single-worker build took {:?}, expected <= 500ms",
        elapsed
    );
}
