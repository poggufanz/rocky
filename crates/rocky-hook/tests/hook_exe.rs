use std::collections::BTreeMap;
use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use rocky_proto::hook::{DropReason, STDIN_CAP};
use rocky_proto::spool::{ENV_VALUE_CAP, SpoolBody, SpoolRecord};

const EDIT_FIXTURE: &[u8] = include_bytes!("fixtures/edit.json");

fn run(args: &[&str], stdin: &[u8], home: &Path) -> (i32, Vec<u8>, Vec<u8>) {
    run_with_env(args, stdin, &[], home)
}

/// Runs the hook with a cleared environment: only `env` and `ROCKY_HOME` are set.
fn run_with_env(
    args: &[&str],
    stdin: &[u8],
    env: &[(&str, &str)],
    home: &Path,
) -> (i32, Vec<u8>, Vec<u8>) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_rocky-hook"))
        .args(args)
        .env_clear()
        .envs(env.iter().copied())
        .env("ROCKY_HOME", home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let data = stdin.to_vec();
    let mut input = child.stdin.take().unwrap();
    // Write from a thread so large stdin cannot deadlock against wait_with_output.
    let writer = std::thread::spawn(move || {
        let _ = input.write_all(&data);
    });
    let out = child.wait_with_output().unwrap();
    writer.join().unwrap();
    (out.status.code().unwrap_or(-1), out.stdout, out.stderr)
}

fn spool_files(home: &Path) -> Vec<PathBuf> {
    let dir = home.join("desk").join("spool");
    let mut files: Vec<PathBuf> = fs::read_dir(&dir)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .map(|e| e.path())
                .filter(|p| p.extension().is_some_and(|ext| ext == "json"))
                .collect()
        })
        .unwrap_or_default();
    files.sort();
    files
}

fn read_record(path: &Path) -> SpoolRecord {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}

#[test]
fn valid_payload_writes_one_record() {
    let home = tempfile::tempdir().unwrap();
    let (code, out, err) = run(&["desk-hook", "claude-code"], EDIT_FIXTURE, home.path());
    assert_eq!((code, out.len(), err.len()), (0, 0, 0));
    let files = spool_files(home.path());
    assert_eq!(files.len(), 1);
    let rec = read_record(&files[0]);
    assert!(
        matches!(rec.body, SpoolBody::Event { .. }) && rec.harness == "claude-code" && rec.v == 1
    );
}

#[test]
fn oversize_writes_dropped() {
    let home = tempfile::tempdir().unwrap();
    let big = vec![b'x'; STDIN_CAP + 1];
    let (code, out, err) = run(&["desk-hook", "claude-code"], &big, home.path());
    assert_eq!((code, out.len(), err.len()), (0, 0, 0));
    let files = spool_files(home.path());
    assert_eq!(files.len(), 1);
    let rec = read_record(&files[0]);
    assert_eq!(rec.harness, "claude-code");
    assert!(matches!(
        rec.body,
        SpoolBody::Dropped {
            reason: DropReason::Oversize,
            bytes,
        } if bytes == (STDIN_CAP + 1) as u64
    ));
}

#[test]
fn empty_and_non_utf8_stdin_write_dropped_parse() {
    for (stdin, n) in [(b"".as_slice(), 0u64), (b"\xff\xfe".as_slice(), 2u64)] {
        let home = tempfile::tempdir().unwrap();
        let (code, out, err) = run(&["desk-hook", "claude-code"], stdin, home.path());
        assert_eq!((code, out.len(), err.len()), (0, 0, 0));
        let files = spool_files(home.path());
        assert_eq!(files.len(), 1);
        let rec = read_record(&files[0]);
        assert!(matches!(
            rec.body,
            SpoolBody::Dropped {
                reason: DropReason::Parse,
                bytes,
            } if bytes == n
        ));
    }
}

#[test]
fn missing_dirs_are_created() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("not-there-yet");
    let (code, out, err) = run(&["desk-hook", "claude-code"], EDIT_FIXTURE, &home);
    assert_eq!((code, out.len(), err.len()), (0, 0, 0));
    assert_eq!(spool_files(&home).len(), 1);
}

#[test]
fn unwritable_spool_still_exits_zero() {
    let home = tempfile::tempdir().unwrap();
    fs::write(home.path().join("desk"), b"not a dir").unwrap();
    let (code, out, err) = run(&["desk-hook", "claude-code"], EDIT_FIXTURE, home.path());
    assert_eq!((code, out.len(), err.len()), (0, 0, 0));
}

#[test]
fn unknown_args_exit_zero_without_file() {
    let home = tempfile::tempdir().unwrap();
    let (code, out, err) = run(&["foo"], EDIT_FIXTURE, home.path());
    assert_eq!((code, out.len(), err.len()), (0, 0, 0));
    assert!(spool_files(home.path()).is_empty());
}

#[test]
fn home_with_spaces_and_non_ascii() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("José Ñ rocky");
    let (code, out, err) = run(&["desk-hook", "claude-code"], EDIT_FIXTURE, &home);
    assert_eq!((code, out.len(), err.len()), (0, 0, 0));
    assert_eq!(spool_files(&home).len(), 1);
}

fn bash_payload(command: &str, description: &str) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "session_id": "s1",
        "hook_event_name": "PreToolUse",
        "tool_name": "Bash",
        "tool_use_id": "t1",
        "tool_input": {"command": command, "description": description},
    }))
    .unwrap()
}

fn event(rec: SpoolRecord) -> rocky_proto::hook::HookEvent {
    match rec.body {
        SpoolBody::Event { event } => event,
        other => panic!("expected an event record, got {other:?}"),
    }
}

#[test]
fn secret_in_bash_command_never_reaches_spool_bytes() {
    let home = tempfile::tempdir().unwrap();
    let payload = bash_payload(
        r#"curl -H "Authorization: Bearer abcdefghijklmnop" https://example.test"#,
        "Call the endpoint",
    );
    let (code, out, err) = run(&["desk-hook", "claude-code"], &payload, home.path());
    assert_eq!((code, out.len(), err.len()), (0, 0, 0));
    let files = spool_files(home.path());
    assert_eq!(files.len(), 1);
    let text = String::from_utf8(fs::read(&files[0]).unwrap()).unwrap();
    assert!(!text.contains("abcdefghijklmnop"), "{text}");
    let event = event(read_record(&files[0]));
    assert!(
        event
            .command
            .as_deref()
            .unwrap()
            .contains("[redacted credential assignment]")
    );
    assert_eq!(event.description.as_deref(), Some("Call the endpoint"));
}

#[test]
fn marker_disables_tool_text_capture() {
    let home = tempfile::tempdir().unwrap();
    fs::create_dir_all(home.path().join("desk")).unwrap();
    fs::write(home.path().join("desk").join("tool-text-off"), b"").unwrap();
    let payload = bash_payload("echo hello", "Say hello");
    let (code, out, err) = run(&["desk-hook", "claude-code"], &payload, home.path());
    assert_eq!((code, out.len(), err.len()), (0, 0, 0));
    let files = spool_files(home.path());
    assert_eq!(files.len(), 1);
    let event = event(read_record(&files[0]));
    assert!(event.command.is_none() && event.description.is_none());
    let text = String::from_utf8(fs::read(&files[0]).unwrap()).unwrap();
    assert!(
        !text.contains("echo hello") && !text.contains("Say hello"),
        "{text}"
    );
}

#[test]
fn long_command_is_cut_and_flagged() {
    let home = tempfile::tempdir().unwrap();
    let payload = bash_payload(&"x".repeat(500), "A long command");
    let (code, out, err) = run(&["desk-hook", "claude-code"], &payload, home.path());
    assert_eq!((code, out.len(), err.len()), (0, 0, 0));
    let files = spool_files(home.path());
    assert_eq!(files.len(), 1);
    let event = event(read_record(&files[0]));
    assert!(event.command.as_deref().unwrap().chars().count() <= 200);
    assert!(event.truncated);
    let text = String::from_utf8(fs::read(&files[0]).unwrap()).unwrap();
    assert!(text.contains("\"truncated\":true"), "{text}");
}

#[test]
fn multibyte_command_crossing_the_scan_cut_stays_well_formed() {
    let home = tempfile::tempdir().unwrap();
    let command = format!("a{}", "😀".repeat(1100));
    let payload = bash_payload(&command, "Emoji punctuation");
    let (code, out, err) = run(&["desk-hook", "claude-code"], &payload, home.path());
    assert_eq!((code, out.len(), err.len()), (0, 0, 0));
    let files = spool_files(home.path());
    assert_eq!(files.len(), 1);
    let event = event(read_record(&files[0]));
    assert!(event.command.as_deref().unwrap().chars().count() <= 200);
    assert!(event.truncated);
}

fn shell_env_map(rec: SpoolRecord) -> BTreeMap<String, String> {
    match rec.body {
        SpoolBody::ShellEnv { env } => env,
        other => panic!("expected a shell_env record, got {other:?}"),
    }
}

#[test]
fn shell_env_writes_one_record_with_only_the_five_names() {
    let home = tempfile::tempdir().unwrap();
    let (code, out, err) = run_with_env(
        &["shell-env"],
        b"",
        &[
            ("CLAUDE_CONFIG_DIR", "/a"),
            ("CODEX_HOME", "/b"),
            ("PATH", "/usr/bin"),
            ("SECRET_TOKEN", "x"),
        ],
        home.path(),
    );
    assert_eq!((code, out.len(), err.len()), (0, 0, 0));
    let files = spool_files(home.path());
    assert_eq!(files.len(), 1);
    let rec = read_record(&files[0]);
    assert_eq!(rec.v, 1);
    assert_eq!(rec.harness, "shell");
    assert_eq!(
        shell_env_map(rec),
        BTreeMap::from([
            ("CLAUDE_CONFIG_DIR".to_owned(), "/a".to_owned()),
            ("CODEX_HOME".to_owned(), "/b".to_owned()),
        ])
    );
}

#[test]
fn shell_env_without_known_vars_writes_nothing() {
    let home = tempfile::tempdir().unwrap();
    let (code, out, err) = run_with_env(
        &["shell-env"],
        b"",
        &[("PATH", "/usr/bin"), ("SECRET_TOKEN", "x")],
        home.path(),
    );
    assert_eq!((code, out.len(), err.len()), (0, 0, 0));
    assert!(spool_files(home.path()).is_empty());
}

#[test]
fn shell_env_drops_oversized_values() {
    let home = tempfile::tempdir().unwrap();
    let oversized = "x".repeat(ENV_VALUE_CAP + 1);
    let (code, out, err) = run_with_env(
        &["shell-env"],
        b"",
        &[("CODEX_HOME", oversized.as_str()), ("COPILOT_HOME", "/c")],
        home.path(),
    );
    assert_eq!((code, out.len(), err.len()), (0, 0, 0));
    let files = spool_files(home.path());
    assert_eq!(files.len(), 1);
    assert_eq!(
        shell_env_map(read_record(&files[0])),
        BTreeMap::from([("COPILOT_HOME".to_owned(), "/c".to_owned())])
    );

    let only_oversized = tempfile::tempdir().unwrap();
    let (code, out, err) = run_with_env(
        &["shell-env"],
        b"",
        &[("CODEX_HOME", oversized.as_str())],
        only_oversized.path(),
    );
    assert_eq!((code, out.len(), err.len()), (0, 0, 0));
    assert!(spool_files(only_oversized.path()).is_empty());
}

#[test]
fn shell_env_keeps_a_value_of_exactly_the_cap() {
    let home = tempfile::tempdir().unwrap();
    let at_cap = "y".repeat(ENV_VALUE_CAP);
    let (code, out, err) = run_with_env(
        &["shell-env"],
        b"",
        &[("OPENCODE_CONFIG", at_cap.as_str())],
        home.path(),
    );
    assert_eq!((code, out.len(), err.len()), (0, 0, 0));
    let files = spool_files(home.path());
    assert_eq!(files.len(), 1);
    assert_eq!(
        shell_env_map(read_record(&files[0])).get("OPENCODE_CONFIG"),
        Some(&at_cap)
    );
}

#[test]
fn shell_env_drops_empty_values() {
    let home = tempfile::tempdir().unwrap();
    let (code, out, err) = run_with_env(
        &["shell-env"],
        b"",
        &[("CLAUDE_CONFIG_DIR", "")],
        home.path(),
    );
    assert_eq!((code, out.len(), err.len()), (0, 0, 0));
    assert!(spool_files(home.path()).is_empty());
}

#[test]
fn shell_env_with_extra_argv_writes_nothing() {
    let home = tempfile::tempdir().unwrap();
    let (code, out, err) = run_with_env(
        &["shell-env", "extra"],
        b"",
        &[("CLAUDE_CONFIG_DIR", "/a")],
        home.path(),
    );
    assert_eq!((code, out.len(), err.len()), (0, 0, 0));
    assert!(spool_files(home.path()).is_empty());
}

#[test]
fn desk_hook_records_claude_config_dir() {
    let home = tempfile::tempdir().unwrap();
    let (code, out, err) = run_with_env(
        &["desk-hook", "claude-code"],
        EDIT_FIXTURE,
        &[("CLAUDE_CONFIG_DIR", "/p")],
        home.path(),
    );
    assert_eq!((code, out.len(), err.len()), (0, 0, 0));
    let files = spool_files(home.path());
    assert_eq!(files.len(), 1);
    assert_eq!(read_record(&files[0]).config_dir.as_deref(), Some("/p"));
}

#[test]
fn desk_hook_omits_config_dir_without_the_variable() {
    let home = tempfile::tempdir().unwrap();
    let (code, out, err) = run(&["desk-hook", "claude-code"], EDIT_FIXTURE, home.path());
    assert_eq!((code, out.len(), err.len()), (0, 0, 0));
    let files = spool_files(home.path());
    assert_eq!(files.len(), 1);
    let text = String::from_utf8(fs::read(&files[0]).unwrap()).unwrap();
    assert!(!text.contains("config_dir"), "{text}");
}

#[test]
fn desk_hook_ignores_claude_config_dir_for_other_harnesses() {
    let home = tempfile::tempdir().unwrap();
    let (code, out, err) = run_with_env(
        &["desk-hook", "codex"],
        EDIT_FIXTURE,
        &[("CLAUDE_CONFIG_DIR", "/p")],
        home.path(),
    );
    assert_eq!((code, out.len(), err.len()), (0, 0, 0));
    let files = spool_files(home.path());
    assert_eq!(files.len(), 1);
    assert_eq!(read_record(&files[0]).config_dir, None);
}

#[test]
fn desk_hook_config_dir_follows_the_value_cap() {
    let at_cap = "p".repeat(ENV_VALUE_CAP);
    let over_cap = "p".repeat(ENV_VALUE_CAP + 1);
    for (value, kept) in [
        (at_cap.as_str(), true),
        (over_cap.as_str(), false),
        ("", false),
    ] {
        let home = tempfile::tempdir().unwrap();
        let (code, out, err) = run_with_env(
            &["desk-hook", "claude-code"],
            EDIT_FIXTURE,
            &[("CLAUDE_CONFIG_DIR", value)],
            home.path(),
        );
        assert_eq!((code, out.len(), err.len()), (0, 0, 0));
        let files = spool_files(home.path());
        assert_eq!(files.len(), 1);
        assert_eq!(
            read_record(&files[0]).config_dir.is_some(),
            kept,
            "CLAUDE_CONFIG_DIR of {} bytes",
            value.len()
        );
    }
}
