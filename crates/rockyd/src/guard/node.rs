//! Runs Rocky's Node CLI for one prompt-free setup action and reads its result.
//!
//! The daemon never parses or writes an agent config. It starts Node with
//! separate arguments and no shell, hides the console window on Windows, keeps
//! a bounded amount of stdout, and reads the one JSON object the CLI prints.

use std::fmt;
use std::io::{self, Read};
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use rocky_proto::pipe::{ConsentState, SetupTarget, TargetState};
use serde::Deserialize;

use super::records::CliRecord;

/// Longest a Node setup run may take before the daemon kills it.
pub const NODE_TIMEOUT: Duration = Duration::from_secs(120);

/// Most stdout bytes kept from one run. Bytes past the cap are drained and dropped.
pub const STDOUT_CAP: usize = 1 << 20;

/// How often the runner checks whether the child has exited.
const POLL_INTERVAL: Duration = Duration::from_millis(20);

/// How long the runner waits for stdout to close after the child exits. A
/// grandchild that inherited the pipe can keep it open; the reader is then
/// left to finish on its own.
const READER_GRACE: Duration = Duration::from_secs(5);

/// The only result version this runner reads.
const RESULT_VERSION: u32 = 1;

const NO_RESULT: &str = "no result object on the last line";
const OUTPUT_OVER_CAP: &str = "stdout passed the size cap";
const STDOUT_NOT_CLOSED: &str = "stdout stayed open after the process exited";

/// The repo capture decision Node reports for the repo it was asked about.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RepoDecisionState {
    Allowed,
    Declined,
    Undecided,
}

/// One repo's capture decision, as Node reports it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct RepoVerdict {
    pub key: String,
    pub main: String,
    pub decision: RepoDecisionState,
}

/// The result object of one `setup --auto` run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutoResult {
    pub consent: ConsentState,
    pub targets: Vec<SetupTarget>,
    pub notes: Vec<String>,
    pub repo: Option<RepoVerdict>,
}

/// Why a setup run produced no usable result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunError {
    /// No Node CLI has been recorded yet.
    NoCli,
    /// Node could not be started. The payload is the OS error text.
    Spawn(String),
    /// Node did not exit within the timeout and was killed.
    Timeout,
    /// Node reported an internal error. The payload is its first note.
    Internal(String),
    /// Node exited with a code this runner does not read as a result.
    Exit(Option<i32>),
    /// Node exited cleanly but its output was not one valid result.
    BadOutput(String),
}

impl fmt::Display for RunError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NoCli => write!(f, "Rocky CLI was not found"),
            Self::Spawn(_) => write!(f, "Node could not start"),
            Self::Timeout => write!(
                f,
                "Node did not finish within {} seconds",
                NODE_TIMEOUT.as_secs()
            ),
            // Node's notes can name paths or echo file text, so they stay out of health text.
            Self::Internal(_) => write!(f, "Node hit an internal error"),
            Self::Exit(Some(code)) => write!(f, "Node exited with code {code}"),
            Self::Exit(None) => write!(f, "Node stopped without an exit code"),
            Self::BadOutput(_) => write!(f, "Node output could not be read"),
        }
    }
}

impl std::error::Error for RunError {}

/// The wire shape of the result object. Fields the daemon does not use are ignored.
#[derive(Deserialize)]
struct RawResult {
    v: u32,
    consent: ConsentState,
    targets: Vec<RawTarget>,
    notes: Vec<String>,
    repo: Option<RepoVerdict>,
}

/// One target as Node wrote it. `state` stays a string so an unknown value is
/// reported on that target instead of failing the whole result.
#[derive(Deserialize)]
struct RawTarget {
    harness: String,
    kind: String,
    path: String,
    state: String,
    detail: Option<String>,
}

impl RawResult {
    fn into_result(self) -> AutoResult {
        AutoResult {
            consent: self.consent,
            targets: self
                .targets
                .into_iter()
                .map(RawTarget::into_target)
                .collect(),
            notes: self.notes,
            repo: self.repo,
        }
    }
}

impl RawTarget {
    fn into_target(self) -> SetupTarget {
        let RawTarget {
            harness,
            kind,
            path,
            state,
            detail,
        } = self;
        match serde_json::from_value::<TargetState>(serde_json::Value::String(state.clone())) {
            Ok(known) => SetupTarget {
                harness,
                kind,
                path,
                state: known,
                detail,
            },
            Err(_) => SetupTarget {
                harness,
                kind,
                path,
                state: TargetState::Error,
                detail: Some(format!("unknown state {state}")),
            },
        }
    }
}

/// Reads the result from the last non-empty line of `stdout`.
///
/// Exit 0 needs a valid result. Exit 1 with a valid result is an internal
/// error that carries Node's first note. Any other code, or exit 1 without a
/// result, is reported as the exit code.
pub fn parse_output(stdout: &str, code: Option<i32>) -> Result<AutoResult, RunError> {
    match code {
        Some(0) => read_result(stdout).ok_or_else(|| RunError::BadOutput(NO_RESULT.to_string())),
        Some(1) => match read_result(stdout) {
            Some(result) => Err(RunError::Internal(first_note(&result))),
            None => Err(RunError::Exit(Some(1))),
        },
        other => Err(RunError::Exit(other)),
    }
}

fn read_result(stdout: &str) -> Option<AutoResult> {
    let line = stdout.lines().rev().find(|line| !line.trim().is_empty())?;
    let raw: RawResult = serde_json::from_str(line.trim()).ok()?;
    (raw.v == RESULT_VERSION).then(|| raw.into_result())
}

fn first_note(result: &AutoResult) -> String {
    result
        .notes
        .first()
        .cloned()
        .unwrap_or_else(|| "internal error".to_string())
}

/// Runs `setup --auto <args> --json` through the recorded Node binary.
///
/// The arguments go to Node as separate argv entries with no shell. The child
/// is killed and reaped on timeout. Its stdout is read on a detached thread,
/// so a grandchild that holds the pipe cannot stall this call.
pub fn run_setup(
    cli: &CliRecord,
    rocky_home: &Path,
    args: &[String],
    timeout: Duration,
) -> Result<AutoResult, RunError> {
    let mut command = Command::new(&cli.node);
    command
        .arg(&cli.entry)
        .arg("setup")
        .arg("--auto")
        .args(args)
        .arg("--json")
        .env("ROCKY_HOME", rocky_home)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);

    let mut child = command
        .spawn()
        .map_err(|error| RunError::Spawn(error.to_string()))?;
    let Some(stdout) = child.stdout.take() else {
        stop(&mut child);
        return Err(RunError::Spawn("stdout pipe was not set up".to_string()));
    };
    let (sender, receiver) = mpsc::channel();
    // Not joined. A grandchild can keep the pipe open after the child is gone,
    // so the reader is left to finish on its own.
    thread::spawn(move || {
        // A failed send means the runner already returned, so nothing is lost.
        let _ = sender.send(drain_capped(stdout));
    });

    let status = wait_for_exit(&mut child, timeout)?;
    let captured = receiver
        .recv_timeout(READER_GRACE)
        .map_err(|_| RunError::BadOutput(STDOUT_NOT_CLOSED.to_string()))?;
    if captured.truncated {
        return Err(RunError::BadOutput(OUTPUT_OVER_CAP.to_string()));
    }
    parse_output(&String::from_utf8_lossy(&captured.bytes), status.code())
}

/// The stdout kept from one run.
struct Captured {
    bytes: Vec<u8>,
    truncated: bool,
}

/// Reads `stdout` to the end and keeps at most `STDOUT_CAP` bytes. Reading
/// continues past the cap, so the child never blocks on a full pipe.
fn drain_capped(mut stdout: impl Read) -> Captured {
    let mut bytes = Vec::new();
    let mut truncated = false;
    let mut chunk = [0_u8; 8192];
    loop {
        match stdout.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => {
                let room = STDOUT_CAP - bytes.len();
                bytes.extend_from_slice(&chunk[..read.min(room)]);
                truncated |= read > room;
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(_) => break,
        }
    }
    Captured { bytes, truncated }
}

/// Polls until the child exits. On timeout, or if the poll itself fails, the
/// child is killed and reaped before the error is returned.
fn wait_for_exit(child: &mut Child, timeout: Duration) -> Result<ExitStatus, RunError> {
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) if started.elapsed() < timeout => thread::sleep(POLL_INTERVAL),
            Ok(None) => {
                stop(child);
                return Err(RunError::Timeout);
            }
            Err(error) => {
                stop(child);
                return Err(RunError::Internal(format!(
                    "could not check the Node process: {error}"
                )));
            }
        }
    }
}

/// Kills the child and reaps it. The child may already have exited, so both
/// results are ignored; `wait` reaps it either way.
fn stop(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;
    use rocky_proto::pipe::TargetState;

    const VALID: &str =
        r#"{"v":1,"action":"status","consent":"approved","targets":[],"notes":[],"extra":true}"#;
    const NOTED: &str = r#"{"v":1,"action":"apply","consent":"none","targets":[],"notes":["internal error: disk full"]}"#;

    #[test]
    fn parse_output_maps_exit_codes() {
        assert!(parse_output(VALID, Some(0)).is_ok());
        assert_eq!(
            parse_output(NOTED, Some(1)),
            Err(RunError::Internal("internal error: disk full".to_string()))
        );
        assert_eq!(parse_output(VALID, Some(2)), Err(RunError::Exit(Some(2))));
        assert_eq!(
            parse_output("not json", Some(1)),
            Err(RunError::Exit(Some(1)))
        );
        assert_eq!(parse_output(VALID, None), Err(RunError::Exit(None)));
        assert!(matches!(
            parse_output("not json", Some(0)),
            Err(RunError::BadOutput(_))
        ));
    }

    #[test]
    fn parse_output_unknown_state_is_error() {
        let text = r#"{"v":1,"action":"status","consent":"approved","targets":[{"harness":"codex","kind":"mcp","path":"/x.toml","state":"bogus"}],"notes":[]}"#;

        let result = parse_output(text, Some(0)).expect("unknown state still parses");

        assert_eq!(result.targets.len(), 1);
        assert_eq!(result.targets[0].state, TargetState::Error);
        assert_eq!(
            result.targets[0].detail.as_deref(),
            Some("unknown state bogus")
        );
    }

    #[test]
    fn parse_output_reads_last_non_empty_line() {
        let text = format!("warning: something\n{VALID}\n\n");

        assert!(parse_output(&text, Some(0)).is_ok());
    }

    #[test]
    fn parse_output_rejects_unknown_version() {
        let text = VALID.replace("\"v\":1", "\"v\":2");

        assert!(matches!(
            parse_output(&text, Some(0)),
            Err(RunError::BadOutput(_))
        ));
    }

    #[test]
    fn run_error_text_is_plain_and_hides_node_notes() {
        assert_eq!(
            RunError::Timeout.to_string(),
            "Node did not finish within 120 seconds"
        );
        let text =
            RunError::Internal("could not write /home/secret/config".to_string()).to_string();
        assert!(
            !text.contains("secret"),
            "node notes must not reach health text: {text}"
        );
    }
}
