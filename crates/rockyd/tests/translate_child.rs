//! Integration tests for `rockyd::translate::child` against the fake Node CLI.
//! Each test uses a temporary Rocky home and requires `node` on `PATH`.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};

use rocky_proto::translate::{QuoteLang, TranslateFailure, TranslatePair};
use rockyd::guard::records::CliRecord;
use rockyd::translate::child::{
    INSTALL_TIMEOUT, InstallEvent, MAX_RUN_QUOTES, RUN_TIMEOUT, RunEvent, RunReply, RunRequest,
    start_install, start_run,
};
use rockyd::translate::marker;
use serde_json::{Value, json};
use tempfile::TempDir;

/// Longest any wait may take. A test that goes past it fails instead of hanging.
const GUARD: Duration = Duration::from_secs(20);

/// The first `node` on `PATH`. Panics when Node is not installed.
fn node_on_path() -> PathBuf {
    let names: &[&str] = if cfg!(windows) {
        &["node.exe", "node"]
    } else {
        &["node"]
    };
    let path = std::env::var_os("PATH").unwrap_or_default();
    std::env::split_paths(&path)
        .flat_map(|dir| names.iter().map(move |name| dir.join(name)))
        .find(|candidate| candidate.is_file())
        .unwrap_or_else(|| {
            panic!(
                "node is not on PATH; these tests run the fake CLI with Node.js and need it installed"
            )
        })
}

fn fake_cli() -> CliRecord {
    CliRecord {
        node: node_on_path(),
        entry: Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("fake-cli.cjs"),
        version: "0.0.0".to_string(),
    }
}

fn configure(home: &Path, config: &Value) {
    fs::write(home.join("fake-translate.json"), config.to_string())
        .expect("write fake translate config");
}

fn req(key: &str, to: QuoteLang, text: &str) -> RunRequest {
    RunRequest {
        key: key.to_string(),
        to,
        text: text.to_string(),
    }
}

fn wait_until(what: &str, mut condition: impl FnMut() -> bool) {
    let start = Instant::now();
    while !condition() {
        assert!(start.elapsed() < GUARD, "{what} never happened");
        thread::sleep(Duration::from_millis(15));
    }
}

fn collect_run(job: &mut rockyd::translate::child::RunJob, limit: Duration) -> Vec<RunReply> {
    let start = Instant::now();
    let mut replies = Vec::new();
    loop {
        if let Some(event) = job.try_next() {
            match event {
                RunEvent::Reply(reply) => replies.push(reply),
                RunEvent::Done => return replies,
            }
            continue;
        }
        assert!(
            start.elapsed() < limit,
            "timed out waiting for RunEvent::Done"
        );
        thread::sleep(Duration::from_millis(10));
    }
}

fn collect_install(
    job: &mut rockyd::translate::child::InstallJob,
    limit: Duration,
) -> (Vec<(u64, u64)>, Result<(), TranslateFailure>) {
    let start = Instant::now();
    let mut progress = Vec::new();
    loop {
        if let Some(event) = job.try_next() {
            match event {
                InstallEvent::Progress {
                    done_bytes,
                    total_bytes,
                } => progress.push((done_bytes, total_bytes)),
                InstallEvent::Finished(result) => return (progress, result),
            }
            continue;
        }
        assert!(
            start.elapsed() < limit,
            "timed out waiting for InstallEvent::Finished"
        );
        thread::sleep(Duration::from_millis(10));
    }
}

fn read_logged_argv(home: &Path) -> Vec<Vec<String>> {
    let text = fs::read_to_string(home.join("fake-cli.log")).expect("read fake-cli.log");
    text.lines()
        .map(|line| {
            let entry: Value = serde_json::from_str(line).expect("argv log JSON");
            entry["argv"]
                .as_array()
                .expect("argv array")
                .iter()
                .map(|arg| arg.as_str().expect("argv str").to_string())
                .collect()
        })
        .collect()
}

fn wait_for_pid(home: &Path) -> u32 {
    let path = home.join("fake-translate.pid");
    let mut pid = None;
    wait_until("fake-translate.pid to be written", || {
        let Ok(raw) = fs::read_to_string(&path) else {
            return false;
        };
        if let Ok(parsed) = raw.trim().parse::<u32>() {
            pid = Some(parsed);
            true
        } else {
            false
        }
    });
    pid.expect("pid")
}

#[cfg(windows)]
fn is_pid_alive(pid: u32) -> bool {
    let filter = format!("PID eq {pid}");
    let Ok(output) = Command::new("tasklist")
        .args(["/FI", &filter, "/NH", "/FO", "CSV"])
        .output()
    else {
        return false;
    };
    let pid_str = pid.to_string();
    String::from_utf8_lossy(&output.stdout).lines().any(|line| {
        line.split(',')
            .nth(1)
            .is_some_and(|col| col.trim().trim_matches('"') == pid_str)
    })
}

#[cfg(unix)]
fn is_pid_alive(pid: u32) -> bool {
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .status()
        .is_ok_and(|status| status.success())
}

#[test]
fn run_replies_in_order_then_done() {
    let home = TempDir::new().expect("temp home");
    let requests = vec![
        req("k1", QuoteLang::En, "satu"),
        req("k2", QuoteLang::Id, "two"),
        req("k3", QuoteLang::En, "tiga"),
    ];

    let mut job = start_run(&fake_cli(), home.path(), &requests, RUN_TIMEOUT).expect("start run");
    let replies = collect_run(&mut job, GUARD);

    assert_eq!(
        replies,
        vec![
            RunReply::Translated {
                key: "k1".to_string(),
                from: QuoteLang::Id,
                text: "T:satu".to_string(),
            },
            RunReply::Translated {
                key: "k2".to_string(),
                from: QuoteLang::En,
                text: "T:two".to_string(),
            },
            RunReply::Translated {
                key: "k3".to_string(),
                from: QuoteLang::Id,
                text: "T:tiga".to_string(),
            },
        ]
    );
    assert_eq!(job.try_next(), None);

    let runs = read_logged_argv(home.path());
    assert_eq!(runs.len(), 1);
    assert!(runs[0][0].ends_with("fake-cli.cjs"));
    assert_eq!(runs[0][1..], ["translate", "run"]);
}

#[test]
fn same_language_is_original() {
    let home = TempDir::new().expect("temp home");
    configure(home.path(), &json!({ "same": true }));
    let requests = vec![req("k1", QuoteLang::En, "already english")];

    let mut job = start_run(&fake_cli(), home.path(), &requests, RUN_TIMEOUT).expect("start run");
    let replies = collect_run(&mut job, GUARD);

    assert_eq!(
        replies,
        vec![RunReply::Original {
            key: "k1".to_string(),
        }]
    );
}

#[test]
fn run_maps_no_prose_other_failures_and_ignores_unknown_lines() {
    let home = TempDir::new().expect("temp home");
    configure(
        home.path(),
        &json!({ "no_prose": true, "extra_noise": true }),
    );
    let requests = vec![req("k1", QuoteLang::En, "12345")];

    let mut job = start_run(&fake_cli(), home.path(), &requests, RUN_TIMEOUT).expect("start run");
    let replies = collect_run(&mut job, GUARD);
    assert_eq!(
        replies,
        vec![RunReply::Original {
            key: "k1".to_string(),
        }]
    );

    let home2 = TempDir::new().expect("temp home 2");
    configure(home2.path(), &json!({ "fail": true }));
    let mut job2 =
        start_run(&fake_cli(), home2.path(), &requests, RUN_TIMEOUT).expect("start run 2");
    let replies2 = collect_run(&mut job2, GUARD);
    assert_eq!(
        replies2,
        vec![RunReply::Failed {
            key: "k1".to_string(),
        }]
    );
}

#[test]
fn crash_mid_batch_keeps_earlier_replies() {
    let home = TempDir::new().expect("temp home");
    configure(home.path(), &json!({ "crash_after": 1 }));
    let requests = vec![
        req("k1", QuoteLang::En, "satu"),
        req("k2", QuoteLang::En, "dua"),
        req("k3", QuoteLang::En, "tiga"),
    ];

    let mut job = start_run(&fake_cli(), home.path(), &requests, RUN_TIMEOUT).expect("start run");
    let replies = collect_run(&mut job, GUARD);

    assert_eq!(
        replies,
        vec![RunReply::Translated {
            key: "k1".to_string(),
            from: QuoteLang::Id,
            text: "T:satu".to_string(),
        }]
    );
}

#[test]
fn hang_ends_at_deadline() {
    let home = TempDir::new().expect("temp home");
    configure(home.path(), &json!({ "hang": true }));
    let requests = vec![req("k1", QuoteLang::En, "halo")];

    let started = Instant::now();
    let mut job = start_run(
        &fake_cli(),
        home.path(),
        &requests,
        Duration::from_millis(500),
    )
    .expect("start run");
    let pid = wait_for_pid(home.path());
    let replies = collect_run(&mut job, Duration::from_secs(5));

    assert!(replies.is_empty());
    assert!(started.elapsed() < Duration::from_secs(5));
    assert!(!is_pid_alive(pid), "hung child {pid} should be gone");
}

#[test]
fn install_reports_progress_and_writes_markers() {
    let home = TempDir::new().expect("temp home");

    let mut job = start_install(
        &fake_cli(),
        home.path(),
        TranslatePair::IdEn,
        INSTALL_TIMEOUT,
    )
    .expect("start install");
    let (progress, result) = collect_install(&mut job, GUARD);

    assert_eq!(progress, vec![(50, 100), (100, 100)]);
    assert_eq!(result, Ok(()));
    assert_eq!(marker::ready_pairs(home.path()), vec![TranslatePair::IdEn]);
    assert_eq!(job.try_next(), None);

    let runs = read_logged_argv(home.path());
    assert_eq!(runs.len(), 1);
    assert!(runs[0][0].ends_with("fake-cli.cjs"));
    assert_eq!(runs[0][1..], ["translate", "install", "--pair", "id-en"]);
}

#[test]
fn install_checksum_and_crash_and_hang() {
    // checksum
    let home_checksum = TempDir::new().expect("temp home checksum");
    configure(home_checksum.path(), &json!({ "install": "checksum" }));
    let mut job = start_install(
        &fake_cli(),
        home_checksum.path(),
        TranslatePair::IdEn,
        INSTALL_TIMEOUT,
    )
    .expect("start install checksum");
    let (_, result) = collect_install(&mut job, GUARD);
    assert_eq!(result, Err(TranslateFailure::Checksum));

    // crash
    let home_crash = TempDir::new().expect("temp home crash");
    configure(home_crash.path(), &json!({ "install": "crash" }));
    let mut job = start_install(
        &fake_cli(),
        home_crash.path(),
        TranslatePair::EnId,
        INSTALL_TIMEOUT,
    )
    .expect("start install crash");
    let (_, result) = collect_install(&mut job, GUARD);
    assert_eq!(result, Err(TranslateFailure::Engine));

    // hang
    let home_hang = TempDir::new().expect("temp home hang");
    configure(home_hang.path(), &json!({ "install": "hang" }));
    let started = Instant::now();
    let mut job = start_install(
        &fake_cli(),
        home_hang.path(),
        TranslatePair::IdEn,
        Duration::from_millis(500),
    )
    .expect("start install hang");
    let pid = wait_for_pid(home_hang.path());
    let (_, result) = collect_install(&mut job, Duration::from_secs(5));
    assert_eq!(result, Err(TranslateFailure::Download));
    assert!(started.elapsed() < Duration::from_secs(5));
    assert!(
        !is_pid_alive(pid),
        "hung install child {pid} should be gone"
    );
}

#[test]
fn dropping_a_job_kills_the_child() {
    // RunJob
    let home_run = TempDir::new().expect("temp home run");
    configure(home_run.path(), &json!({ "hang": true }));
    let requests = vec![req("k1", QuoteLang::En, "halo")];
    let job =
        start_run(&fake_cli(), home_run.path(), &requests, RUN_TIMEOUT).expect("start hanging run");
    let run_pid = wait_for_pid(home_run.path());
    assert!(is_pid_alive(run_pid), "run child should be running");

    let dropped = Instant::now();
    drop(job);
    assert!(
        dropped.elapsed() < Duration::from_secs(5),
        "dropping RunJob took too long"
    );
    assert!(
        !is_pid_alive(run_pid),
        "dropped RunJob child {run_pid} should be gone"
    );

    // InstallJob
    let home_install = TempDir::new().expect("temp home install");
    configure(home_install.path(), &json!({ "install": "hang" }));
    let install_job = start_install(
        &fake_cli(),
        home_install.path(),
        TranslatePair::IdEn,
        INSTALL_TIMEOUT,
    )
    .expect("start hanging install");
    let install_pid = wait_for_pid(home_install.path());
    assert!(is_pid_alive(install_pid), "install child should be running");

    let dropped_install = Instant::now();
    drop(install_job);
    assert!(
        dropped_install.elapsed() < Duration::from_secs(5),
        "dropping InstallJob took too long"
    );
    assert!(
        !is_pid_alive(install_pid),
        "dropped InstallJob child {install_pid} should be gone"
    );
}

#[test]
fn start_run_rejects_requests_past_max() {
    let home = TempDir::new().expect("temp home");
    let requests: Vec<RunRequest> = (0..=MAX_RUN_QUOTES)
        .map(|i| req(&format!("k{i}"), QuoteLang::En, "text"))
        .collect();
    let result = start_run(&fake_cli(), home.path(), &requests, RUN_TIMEOUT);
    assert!(result.is_err());
}
