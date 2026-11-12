//! The capture child against the fake Node CLI: how it is started, what it is sent, which of
//! its lines the daemon keeps, and that stopping it always reaps the process. Each test uses a
//! temp Rocky home and needs `node` on PATH.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

use rockyd::capture::child::CaptureChild;
use rockyd::capture::{CaptureLine, Coverage, RootOwner};
use rockyd::guard::records::CliRecord;
use serde_json::{Value, json};
use tempfile::TempDir;

/// Longest any wait may take. A test that goes past it fails instead of hanging.
const GUARD: Duration = Duration::from_secs(20);

/// A root with a space and the characters a shell would act on.
const AWKWARD_ROOT: &str = "C:/a b/&|;x";

/// The first `node` on PATH. Panics when Node is not installed.
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
            panic!("node is not on PATH; these tests run the fake CLI with Node.js and need it installed")
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

/// Writes the fake capture command's behavior into the Rocky home.
fn configure(home: &Path, config: &Value) {
    fs::write(home.join("fake-capture.json"), config.to_string()).expect("write fake config");
}

/// Starts the capture child. Dropping the child kills and reaps it, so a failing assert never
/// leaves a Node process behind.
fn spawn(home: &Path) -> CaptureChild {
    CaptureChild::spawn(&fake_cli(), home).expect("spawn the capture child")
}

fn next_line(child: &CaptureChild) -> CaptureLine {
    child
        .lines()
        .recv_timeout(GUARD)
        .unwrap_or_else(|error| panic!("the capture child sent no line: {error}"))
}

/// Polls `condition` until it holds. Panics with `what` at the anti-hang guard.
fn wait_until(what: &str, mut condition: impl FnMut() -> bool) {
    let start = Instant::now();
    while !condition() {
        assert!(start.elapsed() < GUARD, "{what} never happened");
        thread::sleep(Duration::from_millis(25));
    }
}

fn read_lines(path: &Path) -> Vec<String> {
    fs::read_to_string(path)
        .expect("read log")
        .lines()
        .map(str::to_owned)
        .collect()
}

#[test]
fn child_runs_listen_collect_without_a_shell() {
    // Arrange
    let home = TempDir::new().expect("temp home");
    configure(home.path(), &json!({ "mode": "echo", "roots": [] }));

    // Act
    let child = spawn(home.path());
    // The roots line comes after the fake CLI logged its argv.
    next_line(&child);
    child.stop(GUARD);

    // Assert
    let log = read_lines(&home.path().join("fake-cli.log"));
    assert_eq!(log.len(), 1, "one start is logged");
    let logged: Value = serde_json::from_str(&log[0]).expect("argv log line");
    let argv: Vec<&str> = logged["argv"]
        .as_array()
        .expect("argv array")
        .iter()
        .map(|arg| arg.as_str().expect("argv strings"))
        .collect();
    assert!(
        argv[0].ends_with("fake-cli.cjs"),
        "the entry script comes first: {argv:?}"
    );
    assert_eq!(argv[1..], ["listen", "collect", "--stdio"]);
}

#[test]
fn child_sends_roots_and_reads_reports() {
    // Arrange
    let home = TempDir::new().expect("temp home");
    configure(
        home.path(),
        &json!({ "mode": "echo", "roots": [AWKWARD_ROOT] }),
    );
    let mut child = spawn(home.path());

    // Act and assert: the child lists its roots first.
    assert_eq!(
        next_line(&child),
        CaptureLine::Roots(vec![RootOwner {
            root: AWKWARD_ROOT.to_string(),
            owner: true,
        }])
    );

    // Each request comes back as a report for the exact root, quotes and backslashes included.
    for root in [AWKWARD_ROOT, r#"D:\he said "hi""#] {
        child.send(root).expect("send a root");
        match next_line(&child) {
            CaptureLine::Result(report) => {
                assert_eq!(report.root, root);
                assert_eq!(report.coverage, Coverage::Complete);
                assert_eq!(report.gaps, 0);
                assert_eq!(report.reason, None);
            }
            other => panic!("expected a result, got {other:?}"),
        }
    }
    child.stop(GUARD);

    // The fake CLI read one request per line, escaped so the roots survive intact.
    let received: Vec<Value> = read_lines(&home.path().join("fake-capture.log"))
        .iter()
        .filter(|line| line.as_str() != "eof")
        .map(|line| serde_json::from_str(line).expect("request line"))
        .collect();
    assert_eq!(
        received,
        [
            json!({ "v": 1, "root": AWKWARD_ROOT }),
            json!({ "v": 1, "root": r#"D:\he said "hi""# }),
        ]
    );
}

#[test]
fn child_stop_closes_stdin_first() {
    // Arrange
    let home = TempDir::new().expect("temp home");
    configure(home.path(), &json!({ "mode": "echo", "roots": [] }));
    let child = spawn(home.path());
    // The fake CLI is listening on stdin once it has listed its roots.
    next_line(&child);

    // Act: a grace this long is never the reason stop returns.
    child.stop(GUARD);

    // Assert
    let log = read_lines(&home.path().join("fake-capture.log"));
    assert_eq!(log.last().map(String::as_str), Some("eof"));
}

#[test]
fn child_stop_kills_a_child_that_ignores_eof() {
    // Arrange
    let home = TempDir::new().expect("temp home");
    configure(home.path(), &json!({ "mode": "deaf" }));
    let child = spawn(home.path());
    wait_until("the fake CLI to start", || {
        home.path().join("fake-cli.log").is_file()
    });

    // Act: the fake CLI sleeps far longer than the guard, so only a kill ends it.
    let (done_sender, done_receiver) = mpsc::channel();
    let stopper = thread::spawn(move || {
        child.stop(Duration::from_millis(500));
        let _ = done_sender.send(());
    });

    // Assert
    assert_eq!(
        done_receiver.recv_timeout(GUARD),
        Ok(()),
        "stop did not return inside the guard"
    );
    stopper.join().expect("stop thread");
}

#[test]
fn child_drops_garbage_and_oversized_lines() {
    // Arrange
    let home = TempDir::new().expect("temp home");
    configure(home.path(), &json!({ "mode": "noise" }));
    let child = spawn(home.path());

    // Act and assert: of the garbage line, the oversized but well-formed line, and the one
    // valid line, only the valid one arrives.
    assert_eq!(
        next_line(&child),
        CaptureLine::Roots(vec![RootOwner {
            root: "kept".to_string(),
            owner: true,
        }])
    );
    // The reader ends with the child's stdout, so the channel closes with nothing else in it.
    assert_eq!(
        child.lines().recv_timeout(GUARD),
        Err(RecvTimeoutError::Disconnected)
    );
    child.stop(GUARD);
}

#[test]
fn child_try_exit_reports_a_child_that_exited() {
    // Arrange
    let home = TempDir::new().expect("temp home");
    configure(home.path(), &json!({ "mode": "exit" }));
    let mut child = spawn(home.path());

    // Act
    let mut status = None;
    wait_until("the child to exit", || {
        status = child.try_exit();
        status.is_some()
    });

    // Assert
    assert_eq!(status.and_then(|status| status.code()), Some(1));
    child.stop(GUARD);
}
