//! Integration tests for `rockyd::translate::child` against the fake Node CLI.
//! Each test uses a temporary Rocky home and requires `node` on `PATH`.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use rocky_proto::translate::{QuoteLang, TranslateFailure, TranslatePair};
use rockyd::guard::records::CliRecord;
use rockyd::translate::child::{
    INSTALL_TIMEOUT, InstallEvent, InstallJob, MAX_RUN_QUOTES, RUN_TIMEOUT, RunEvent, RunJob,
    RunReply, RunRequest, start_install, start_run,
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

struct GuardedJob<T: Send + 'static> {
    inner: Option<T>,
    name: &'static str,
}

impl<T: Send + 'static> GuardedJob<T> {
    fn new(job: T, name: &'static str) -> Self {
        Self {
            inner: Some(job),
            name,
        }
    }

    fn into_inner(mut self) -> T {
        self.inner.take().expect("job already taken")
    }
}

impl<T: Send + 'static> Drop for GuardedJob<T> {
    fn drop(&mut self) {
        if let Some(job) = self.inner.take() {
            let (tx, rx) = std::sync::mpsc::channel();
            thread::spawn(move || {
                drop(job);
                let _ = tx.send(());
            });
            if rx.recv_timeout(GUARD).is_err() {
                if thread::panicking() {
                    eprintln!(
                        "timed out waiting for {} drop within {GUARD:?} during unwind",
                        self.name
                    );
                } else {
                    panic!("timed out waiting for {} drop within {GUARD:?}", self.name);
                }
            }
        }
    }
}

fn collect_run(job: GuardedJob<RunJob>, limit: Duration) -> Vec<RunReply> {
    let mut job = job.into_inner();
    let stop = Arc::new(AtomicBool::new(false));
    let stop_worker = Arc::clone(&stop);
    let (tx, rx) = std::sync::mpsc::channel();
    let handle = thread::spawn(move || {
        let mut replies = Vec::new();
        while !stop_worker.load(Ordering::Acquire) {
            if let Some(event) = job.try_next() {
                match event {
                    RunEvent::Reply(reply) => replies.push(reply),
                    RunEvent::Done => {
                        let trailing = job.try_next();
                        drop(job);
                        let _ = tx.send((replies, trailing));
                        return;
                    }
                }
                continue;
            }
            thread::sleep(Duration::from_millis(10));
        }
        drop(job);
    });
    match rx.recv_timeout(limit) {
        Ok((replies, trailing)) => {
            let _ = handle.join();
            assert_eq!(trailing, None, "unexpected event after RunEvent::Done");
            replies
        }
        Err(_) => {
            stop.store(true, Ordering::Release);
            panic!("timed out after {limit:?} waiting for RunEvent::Done");
        }
    }
}

fn collect_install(
    job: GuardedJob<InstallJob>,
    limit: Duration,
) -> (Vec<(u64, u64)>, Result<(), TranslateFailure>) {
    let mut job = job.into_inner();
    let stop = Arc::new(AtomicBool::new(false));
    let stop_worker = Arc::clone(&stop);
    let (tx, rx) = std::sync::mpsc::channel();
    let handle = thread::spawn(move || {
        let mut progress = Vec::new();
        while !stop_worker.load(Ordering::Acquire) {
            if let Some(event) = job.try_next() {
                match event {
                    InstallEvent::Progress {
                        done_bytes,
                        total_bytes,
                    } => progress.push((done_bytes, total_bytes)),
                    InstallEvent::Finished(result) => {
                        let trailing = job.try_next();
                        drop(job);
                        let _ = tx.send((progress, result, trailing));
                        return;
                    }
                }
                continue;
            }
            thread::sleep(Duration::from_millis(10));
        }
        drop(job);
    });
    match rx.recv_timeout(limit) {
        Ok((progress, result, trailing)) => {
            let _ = handle.join();
            assert_eq!(
                trailing, None,
                "unexpected event after InstallEvent::Finished"
            );
            (progress, result)
        }
        Err(_) => {
            stop.store(true, Ordering::Release);
            panic!("timed out after {limit:?} waiting for InstallEvent::Finished");
        }
    }
}

fn drop_within<T: Send + 'static>(value: GuardedJob<T>, limit: Duration, what: &str) {
    let inner = value.into_inner();
    let (tx, rx) = std::sync::mpsc::channel();
    thread::spawn(move || {
        drop(inner);
        let _ = tx.send(());
    });
    rx.recv_timeout(limit)
        .unwrap_or_else(|_| panic!("timed out waiting for {what} drop within {limit:?}"));
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

fn begin_run(
    home: &Path,
    requests: &[RunRequest],
    timeout: Duration,
) -> std::io::Result<GuardedJob<RunJob>> {
    start_run(&fake_cli(), home, requests, timeout).map(|job| GuardedJob::new(job, "RunJob"))
}

fn begin_install(
    home: &Path,
    pair: TranslatePair,
    timeout: Duration,
) -> std::io::Result<GuardedJob<InstallJob>> {
    start_install(&fake_cli(), home, pair, timeout).map(|job| GuardedJob::new(job, "InstallJob"))
}

#[test]
fn run_replies_in_order_then_done() {
    let home = TempDir::new().expect("temp home");
    let requests = vec![
        req("k1", QuoteLang::En, "satu"),
        req("k2", QuoteLang::Id, "two"),
        req("k3", QuoteLang::En, "tiga"),
    ];

    let job = begin_run(home.path(), &requests, RUN_TIMEOUT).expect("start run");
    let replies = collect_run(job, GUARD);

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

    let job = begin_run(home.path(), &requests, RUN_TIMEOUT).expect("start run");
    let replies = collect_run(job, GUARD);

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

    let job = begin_run(home.path(), &requests, RUN_TIMEOUT).expect("start run");
    let replies = collect_run(job, GUARD);
    assert_eq!(
        replies,
        vec![RunReply::Original {
            key: "k1".to_string(),
        }]
    );

    let home2 = TempDir::new().expect("temp home 2");
    configure(home2.path(), &json!({ "fail": true }));
    let job2 = begin_run(home2.path(), &requests, RUN_TIMEOUT).expect("start run 2");
    let replies2 = collect_run(job2, GUARD);
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

    let job = begin_run(home.path(), &requests, RUN_TIMEOUT).expect("start run");
    let replies = collect_run(job, GUARD);

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
    let job = begin_run(home.path(), &requests, Duration::from_millis(500)).expect("start run");
    let pid = wait_for_pid(home.path());
    let replies = collect_run(job, Duration::from_secs(5));

    assert!(replies.is_empty());
    assert!(started.elapsed() < Duration::from_secs(5));
    assert!(!is_pid_alive(pid), "hung child {pid} should be gone");
}

#[test]
fn hang_after_keeps_pre_deadline_replies_then_ends_with_done() {
    let home = TempDir::new().expect("temp home");
    configure(home.path(), &json!({ "hang_after": 1 }));
    let requests = vec![
        req("k1", QuoteLang::En, "satu"),
        req("k2", QuoteLang::En, "dua"),
        req("k3", QuoteLang::En, "tiga"),
    ];

    let started = Instant::now();
    let job = begin_run(home.path(), &requests, Duration::from_millis(500)).expect("start run");
    let pid = wait_for_pid(home.path());
    let replies = collect_run(job, Duration::from_secs(5));

    assert_eq!(
        replies,
        vec![RunReply::Translated {
            key: "k1".to_string(),
            from: QuoteLang::Id,
            text: "T:satu".to_string(),
        }]
    );
    assert!(started.elapsed() < Duration::from_secs(5));
    assert!(!is_pid_alive(pid), "hung child {pid} should be gone");
}

#[test]
fn install_reports_progress_and_writes_markers() {
    let home = TempDir::new().expect("temp home");

    let job =
        begin_install(home.path(), TranslatePair::IdEn, INSTALL_TIMEOUT).expect("start install");
    let (progress, result) = collect_install(job, GUARD);

    assert_eq!(progress, vec![(50, 100), (100, 100)]);
    assert_eq!(result, Ok(()));
    assert_eq!(marker::ready_pairs(home.path()), vec![TranslatePair::IdEn]);

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
    let job = begin_install(home_checksum.path(), TranslatePair::IdEn, INSTALL_TIMEOUT)
        .expect("start install checksum");
    let (_, result) = collect_install(job, GUARD);
    assert_eq!(result, Err(TranslateFailure::Checksum));

    // crash
    let home_crash = TempDir::new().expect("temp home crash");
    configure(home_crash.path(), &json!({ "install": "crash" }));
    let job = begin_install(home_crash.path(), TranslatePair::EnId, INSTALL_TIMEOUT)
        .expect("start install crash");
    let (_, result) = collect_install(job, GUARD);
    assert_eq!(result, Err(TranslateFailure::Engine));

    // hang
    let home_hang = TempDir::new().expect("temp home hang");
    configure(home_hang.path(), &json!({ "install": "hang" }));
    let started = Instant::now();
    let job = begin_install(
        home_hang.path(),
        TranslatePair::IdEn,
        Duration::from_millis(500),
    )
    .expect("start install hang");
    let pid = wait_for_pid(home_hang.path());
    let (_, result) = collect_install(job, Duration::from_secs(5));
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
    let job = begin_run(home_run.path(), &requests, RUN_TIMEOUT).expect("start hanging run");
    let run_pid = wait_for_pid(home_run.path());
    assert!(is_pid_alive(run_pid), "run child should be running");

    drop_within(job, GUARD, "RunJob");
    assert!(
        !is_pid_alive(run_pid),
        "dropped RunJob child {run_pid} should be gone"
    );

    // InstallJob
    let home_install = TempDir::new().expect("temp home install");
    configure(home_install.path(), &json!({ "install": "hang" }));
    let install_job = begin_install(home_install.path(), TranslatePair::IdEn, INSTALL_TIMEOUT)
        .expect("start hanging install");
    let install_pid = wait_for_pid(home_install.path());
    assert!(is_pid_alive(install_pid), "install child should be running");

    drop_within(install_job, GUARD, "InstallJob");
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
    let result = begin_run(home.path(), &requests, RUN_TIMEOUT);
    assert!(result.is_err());
}
