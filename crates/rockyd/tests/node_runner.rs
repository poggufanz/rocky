//! Runs `guard::node::run_setup` against the fake CLI fixture. The tests that
//! start the fixture need `node` on PATH.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use rockyd::guard::node::{NODE_TIMEOUT, RunError, run_setup};
use rockyd::guard::records::CliRecord;
use serde_json::{Value, json};

/// A run that does not return within this long fails the test instead of hanging it.
const ANTI_HANG: Duration = Duration::from_secs(20);

fn fixture_entry() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("fake-cli.cjs")
}

/// The first `node` executable found on PATH. Panics when Node is not installed.
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

fn cli_record(node: PathBuf) -> CliRecord {
    CliRecord {
        node,
        entry: fixture_entry(),
        version: "0.0.0-test".to_string(),
    }
}

fn write_config(home: &Path, config: &Value) {
    fs::write(home.join("fake-cli.json"), config.to_string()).expect("write fake CLI config");
}

/// The argv of each logged run, without the node binary itself.
fn logged_argv(home: &Path) -> Vec<Vec<String>> {
    let text = fs::read_to_string(home.join("fake-cli.log")).expect("read fake CLI log");
    text.lines()
        .map(|line| {
            let entry: Value = serde_json::from_str(line).expect("log line is JSON");
            entry["argv"]
                .as_array()
                .expect("argv is an array")
                .iter()
                .map(|arg| arg.as_str().expect("argv entries are strings").to_string())
                .collect()
        })
        .collect()
}

#[test]
fn run_setup_passes_args_without_a_shell() {
    let home = tempfile::tempdir().expect("temp home");
    write_config(home.path(), &json!({ "mode": "print" }));
    let args = ["repo", "allow", "C:/a b/&|;x"].map(str::to_string);

    let result = run_setup(
        &cli_record(node_on_path()),
        home.path(),
        &args,
        NODE_TIMEOUT,
    );

    assert!(result.is_ok(), "run failed: {result:?}");
    let runs = logged_argv(home.path());
    assert_eq!(runs.len(), 1, "one run should be logged");
    assert!(
        runs[0][0].ends_with("fake-cli.cjs"),
        "argv starts with the entry script"
    );
    assert_eq!(
        runs[0][1..],
        ["setup", "--auto", "repo", "allow", "C:/a b/&|;x", "--json"]
    );
}

#[test]
fn run_setup_sets_rocky_home() {
    let home = tempfile::tempdir().expect("temp home");
    write_config(home.path(), &json!({ "mode": "print" }));

    let result = run_setup(&cli_record(node_on_path()), home.path(), &[], NODE_TIMEOUT);

    assert!(result.is_ok(), "run failed: {result:?}");
    assert!(
        home.path().join("fake-cli.log").is_file(),
        "the fixture wrote its log somewhere other than the given home"
    );
}

#[test]
fn run_setup_reads_large_output() {
    let home = tempfile::tempdir().expect("temp home");
    write_config(home.path(), &json!({ "mode": "big", "bytes": 300_000 }));

    let result = run_setup(&cli_record(node_on_path()), home.path(), &[], NODE_TIMEOUT);

    let result = result.unwrap_or_else(|error| panic!("large output should parse: {error}"));
    let total: usize = result.notes.iter().map(String::len).sum();
    assert_eq!(total, 300_000);
}

#[test]
fn run_setup_drains_output_past_the_cap() {
    let home = tempfile::tempdir().expect("temp home");
    write_config(home.path(), &json!({ "mode": "big", "bytes": 2_000_000 }));

    let result = run_setup(&cli_record(node_on_path()), home.path(), &[], ANTI_HANG);

    assert!(
        matches!(result, Err(RunError::BadOutput(_))),
        "output past the cap should read as bad output after the child finishes, got {result:?}"
    );
}

#[test]
fn run_setup_kills_a_hung_node_at_timeout() {
    let home = tempfile::tempdir().expect("temp home");
    write_config(home.path(), &json!({ "mode": "sleep" }));
    let started = Instant::now();

    let result = run_setup(
        &cli_record(node_on_path()),
        home.path(),
        &[],
        Duration::from_millis(500),
    );

    assert_eq!(result, Err(RunError::Timeout));
    assert!(
        started.elapsed() < ANTI_HANG,
        "the run did not return inside the anti-hang guard"
    );
}

#[test]
fn run_setup_maps_a_nonzero_exit() {
    let home = tempfile::tempdir().expect("temp home");
    write_config(
        home.path(),
        &json!({ "mode": "exit", "result": { "code": 2 } }),
    );

    let result = run_setup(&cli_record(node_on_path()), home.path(), &[], NODE_TIMEOUT);

    assert_eq!(result, Err(RunError::Exit(Some(2))));
}

#[test]
fn run_setup_reports_spawn_failure() {
    let home = tempfile::tempdir().expect("temp home");
    let missing = home.path().join("no-such-node");

    let result = run_setup(&cli_record(missing), home.path(), &[], NODE_TIMEOUT);

    assert!(
        matches!(result, Err(RunError::Spawn(_))),
        "a missing node binary should be a spawn failure, got {result:?}"
    );
}
