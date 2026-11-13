//! Desk history segments: naming, append, cap, prune, and replay.

use std::collections::HashSet;
use std::fs;
use std::path::Path;

use rocky_proto::history::{HISTORY_VERSION, HistoryBody, HistoryLine};
use rocky_proto::hook::HookEvent;
use rocky_proto::pipe::{AgentKey, Gap, GapReason, RepoInfo, Status, TimelineKind};
use rockyd::gaps::{GAP_CAP, GAP_KEEP_MS, Gaps};
use rockyd::history::{HISTORY_CAP_BYTES, History, replay, segment_name, segment_start_ms};
use rockyd::state::StatusState;
use tempfile::TempDir;

/// 2025-11-07T00:00:00Z, an hour boundary.
const H0: u64 = 1_762_473_600_000;
const HOUR: u64 = 3_600_000;

fn repo(_cwd: &str) -> RepoInfo {
    RepoInfo {
        root: None,
        name: "r".into(),
        branch: None,
    }
}

fn event(name: &str, sid: &str) -> HookEvent {
    HookEvent {
        hook_event_name: name.into(),
        session_id: sid.into(),
        cwd: Some("C:/r".into()),
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

fn event_line(ev: HookEvent, recv_ms: u64, src: Option<&str>) -> HistoryLine {
    HistoryLine {
        v: HISTORY_VERSION,
        body: HistoryBody::Event {
            harness: "claude-code".into(),
            recv_ms,
            event: ev,
        },
        src: src.map(str::to_string),
    }
}

fn tool_line(sid: &str, command: &str, recv_ms: u64, src: Option<&str>) -> HistoryLine {
    let mut ev = event("PreToolUse", sid);
    ev.tool_name = Some("Bash".into());
    ev.tool_use_id = Some("t1".into());
    ev.command = Some(command.into());
    event_line(ev, recv_ms, src)
}

fn gap_line(gap: Gap) -> HistoryLine {
    HistoryLine {
        v: HISTORY_VERSION,
        body: HistoryBody::Gap(gap),
        src: None,
    }
}

fn write_lines(dir: &Path, name: &str, lines: &[HistoryLine]) {
    let mut text = String::new();
    for line in lines {
        text.push_str(&serde_json::to_string(line).unwrap());
        text.push('\n');
    }
    fs::write(dir.join(name), text).unwrap();
}

fn pad_segment(dir: &Path, name: &str, lines: usize, width: usize) {
    let mut text = String::new();
    for _ in 0..lines {
        text.push_str(&format!("{{\"pad\":\"{}\"}}\n", "x".repeat(width)));
    }
    fs::write(dir.join(name), text).unwrap();
}

fn dir_entries(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

fn main_key(sid: &str) -> AgentKey {
    AgentKey {
        session_id: sid.into(),
        agent_id: String::new(),
    }
}

fn kinds(state: &StatusState, key: &AgentKey) -> Vec<TimelineKind> {
    state.timeline(key).iter().map(|e| e.kind).collect()
}

fn small_gap(ms: u64) -> Gap {
    Gap {
        from_ms: ms,
        to_ms: ms,
        count: 1,
        reason: GapReason::HookDropped,
    }
}

#[test]
fn segment_names_are_utc_hours() {
    assert_eq!(segment_name(0), "1970010100.jsonl");
    assert_eq!(segment_name(1_762_473_600_000), "2025110700.jsonl");
    assert_eq!(segment_name(1_709_211_600_000), "2024022913.jsonl");
    assert_eq!(
        segment_start_ms("2024022913.jsonl"),
        Some(1_709_211_600_000)
    );
    assert_eq!(segment_start_ms("2024022913.jsonl.tmp"), None);
}

#[test]
fn replay_rebuilds_state_and_timeline() {
    let tmp = TempDir::new().unwrap();
    let dir = tmp.path().join("history");
    let mut history = History::open(&dir, HISTORY_CAP_BYTES, true);
    assert!(dir.exists());
    history
        .append(&event_line(event("SessionStart", "S1"), 10, Some("a")), H0)
        .unwrap();
    history
        .append(
            &event_line(event("UserPromptSubmit", "S1"), 20, Some("b")),
            H0,
        )
        .unwrap();
    history
        .append(&tool_line("S1", "npm test", 30, Some("c")), H0)
        .unwrap();

    let mut state = StatusState::new();
    let mut gaps = Gaps::new();
    let srcs = replay(&history, &mut state, &mut gaps, &mut repo);
    let main = main_key("S1");
    assert_eq!(state.get(&main).unwrap().status, Status::Working);
    assert_eq!(
        kinds(&state, &main),
        vec![
            TimelineKind::SessionStart,
            TimelineKind::TurnStart,
            TimelineKind::Tool
        ]
    );
    assert_eq!(
        srcs,
        HashSet::from(["a".to_string(), "b".to_string(), "c".to_string()])
    );
}

#[test]
fn old_segments_pruned_after_24h() {
    let tmp = TempDir::new().unwrap();
    let dir = tmp.path().join("history");
    let mut history = History::open(&dir, HISTORY_CAP_BYTES, true);
    history
        .append(&event_line(event("SessionStart", "S1"), 1, None), H0)
        .unwrap();
    history
        .append(
            &event_line(event("SessionStart", "S2"), 2, None),
            H0 + 2 * HOUR,
        )
        .unwrap();
    history.prune_old(H0 + 25 * HOUR).unwrap();
    assert!(!dir.join(segment_name(H0)).exists());
    assert!(dir.join(segment_name(H0 + 2 * HOUR)).exists());
}

#[test]
fn cap_drops_oldest_and_records_history_full() {
    let tmp = TempDir::new().unwrap();
    let dir = tmp.path().join("history");
    fs::create_dir_all(&dir).unwrap();
    let oldest = segment_name(H0);
    let middle = segment_name(H0 + 2 * HOUR);
    let current = segment_name(H0 + 4 * HOUR);
    pad_segment(&dir, &oldest, 3, 190);
    pad_segment(&dir, &middle, 3, 190);
    let mut history = History::open(&dir, 1024, true);
    let gap = history
        .append(
            &event_line(event("SessionStart", "S1"), 1, Some("cur")),
            H0 + 4 * HOUR,
        )
        .unwrap();
    let expected = Gap {
        from_ms: H0,
        to_ms: H0 + 3_599_999,
        count: 3,
        reason: GapReason::HistoryFull,
    };
    assert_eq!(gap, Some(expected));
    assert!(!dir.join(&oldest).exists());
    assert!(dir.join(&middle).exists());
    let text = fs::read_to_string(dir.join(&current)).unwrap();
    let last: HistoryLine = serde_json::from_str(text.lines().last().unwrap()).unwrap();
    assert_eq!(last, gap_line(expected));
}

#[test]
fn disabled_history_deletes_without_replay() {
    let tmp = TempDir::new().unwrap();
    let dir = tmp.path().join("history");
    fs::create_dir_all(&dir).unwrap();
    write_lines(
        &dir,
        &segment_name(H0),
        &[event_line(event("SessionStart", "S1"), 1, Some("x"))],
    );
    let mut history = History::open(&dir, HISTORY_CAP_BYTES, false);
    assert!(!history.enabled());
    history.set_enabled(false).unwrap();
    assert!(dir_entries(&dir).is_empty());

    let mut state = StatusState::new();
    let mut gaps = Gaps::new();
    let srcs = replay(&history, &mut state, &mut gaps, &mut repo);
    assert!(srcs.is_empty());
    assert!(state.agents().is_empty());
    assert_eq!(
        history
            .append(&event_line(event("SessionStart", "S2"), 2, None), H0)
            .unwrap(),
        None
    );
    assert!(dir_entries(&dir).is_empty());

    let missing = tmp.path().join("missing");
    let history = History::open(&missing, HISTORY_CAP_BYTES, false);
    assert!(!missing.exists());
    assert!(!history.enabled());
}

#[test]
fn replay_skips_torn_line_and_next_append_starts_fresh() {
    let tmp = TempDir::new().unwrap();
    let dir = tmp.path().join("history");
    fs::create_dir_all(&dir).unwrap();
    let name = segment_name(H0);
    let good =
        serde_json::to_string(&event_line(event("SessionStart", "S1"), 1, Some("a"))).unwrap();
    fs::write(dir.join(&name), format!("{good}\n{{\"v\":1,\"kind\":\"ev")).unwrap();

    let mut history = History::open(&dir, HISTORY_CAP_BYTES, true);
    let mut state = StatusState::new();
    let mut gaps = Gaps::new();
    let srcs = replay(&history, &mut state, &mut gaps, &mut repo);
    assert_eq!(srcs.len(), 1);
    assert_eq!(state.timeline(&main_key("S1")).len(), 1);

    history
        .append(
            &event_line(event("UserPromptSubmit", "S1"), 2, Some("b")),
            H0,
        )
        .unwrap();
    let text = fs::read_to_string(dir.join(&name)).unwrap();
    assert!(text.contains("\"kind\":\"ev\n"), "{text}");

    let mut state = StatusState::new();
    let mut gaps = Gaps::new();
    let srcs = replay(&history, &mut state, &mut gaps, &mut repo);
    assert_eq!(srcs.len(), 2);
    assert_eq!(
        kinds(&state, &main_key("S1")),
        vec![TimelineKind::SessionStart, TimelineKind::TurnStart]
    );
}

#[test]
fn replay_with_tool_text_off_drops_old_text() {
    let tmp = TempDir::new().unwrap();
    let dir = tmp.path().join("history");
    fs::create_dir_all(&dir).unwrap();
    write_lines(
        &dir,
        &segment_name(H0),
        &[tool_line("S1", "npm test", 1, Some("a"))],
    );
    let history = History::open(&dir, HISTORY_CAP_BYTES, true);
    let mut state = StatusState::new();
    state.set_tool_text(false);
    let mut gaps = Gaps::new();
    replay(&history, &mut state, &mut gaps, &mut repo);

    let status = state.get(&main_key("S1")).unwrap();
    let action = status.action.unwrap();
    assert_eq!(action.tool_name, "Bash");
    assert!(action.command.is_none());
    let timeline = state.timeline(&main_key("S1"));
    let last = timeline.last().unwrap();
    assert_eq!(last.kind, TimelineKind::Tool);
    assert!(last.text.is_none());
}

#[test]
fn foreign_files_in_history_dir_are_ignored() {
    let tmp = TempDir::new().unwrap();
    let dir = tmp.path().join("history");
    fs::create_dir_all(&dir).unwrap();
    let segment = segment_name(H0);
    write_lines(
        &dir,
        &segment,
        &[event_line(event("SessionStart", "S1"), 1, Some("seg"))],
    );
    fs::write(dir.join("notes.txt"), "x".repeat(10_000)).unwrap();
    fs::write(dir.join("2025110701.jsonl.tmp"), "{}").unwrap();
    fs::create_dir_all(dir.join("x")).unwrap();
    // A directory with an otherwise accepted segment name is still foreign.
    fs::create_dir_all(dir.join(segment_name(H0 + 2 * HOUR))).unwrap();

    let mut history = History::open(&dir, 500, true);
    let mut state = StatusState::new();
    let mut gaps = Gaps::new();
    let srcs = replay(&history, &mut state, &mut gaps, &mut repo);
    assert_eq!(srcs, HashSet::from(["seg".to_string()]));
    assert_eq!(state.agents().len(), 1);

    // Foreign bytes never count toward the cap, so a small append keeps the
    // old segment and records no gap.
    let gap = history
        .append(
            &event_line(event("SessionStart", "S2"), 2, Some("new")),
            H0 + 4 * HOUR,
        )
        .unwrap();
    assert_eq!(gap, None);
    assert!(dir.join(&segment).exists());

    history.prune_old(u64::MAX).unwrap();
    assert!(!dir.join(&segment).exists());
    assert!(dir.join("notes.txt").exists());
    assert!(dir.join("2025110701.jsonl.tmp").exists());
    assert!(dir.join("x").is_dir());
    assert!(dir.join(segment_name(H0 + 2 * HOUR)).is_dir());

    // Turning history off never touches foreign entries.
    history.set_enabled(false).unwrap();
    assert!(!history.enabled());
    assert!(dir.join("notes.txt").exists());
    assert!(dir.join(segment_name(H0 + 2 * HOUR)).is_dir());
    assert_eq!(
        history
            .append(&event_line(event("SessionStart", "S2"), 3, None), H0)
            .unwrap(),
        None
    );
}

#[test]
fn gaps_cap_and_age() {
    let mut gaps = Gaps::new();
    for i in 0..105u64 {
        gaps.push(small_gap(i));
    }
    let kept = gaps.to_vec();
    assert_eq!(kept.len(), GAP_CAP);
    assert_eq!(kept.first().unwrap().from_ms, 5);
    assert_eq!(kept.last().unwrap().from_ms, 104);

    let now = GAP_KEEP_MS + 1_000;
    assert!(gaps.prune(now));
    assert!(gaps.to_vec().is_empty());

    gaps.push(small_gap(now - 1));
    gaps.push(small_gap(now));
    assert!(!gaps.prune(now));
    assert_eq!(gaps.to_vec().len(), 2);
}

#[test]
fn replay_drops_prompt_from_history_event() {
    let tmp = TempDir::new().unwrap();
    let dir = tmp.path().join("history");
    fs::create_dir_all(&dir).unwrap();
    let mut ev = event("UserPromptSubmit", "S1");
    ev.prompt = Some("SECRET_HISTORY_PROMPT".into());
    write_lines(&dir, &segment_name(H0), &[event_line(ev, 1, Some("a"))]);
    let history = History::open(&dir, HISTORY_CAP_BYTES, true);
    let mut state = StatusState::new();
    let mut gaps = Gaps::new();
    replay(&history, &mut state, &mut gaps, &mut repo);

    let agents = state.agents();
    assert_eq!(agents.len(), 1);
    let agents_json = serde_json::to_string(&agents).unwrap();
    assert!(
        !agents_json.contains("SECRET_HISTORY_PROMPT"),
        "{agents_json}"
    );
    let timeline_json = serde_json::to_string(&state.timeline(&main_key("S1"))).unwrap();
    assert!(
        !timeline_json.contains("SECRET_HISTORY_PROMPT"),
        "{timeline_json}"
    );
}
