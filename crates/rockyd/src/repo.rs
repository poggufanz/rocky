//! Repo resolution: map a session cwd to a git root/branch or a plain folder name.

use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use rocky_proto::pipe::RepoInfo;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Bound for `git rev-parse`: `resolve_repo` runs under the daemon state
/// lock, so a hung git would stall ingest and snapshots. On timeout the
/// child is killed and the caller gets the plain-folder fallback.
const GIT_TIMEOUT: Duration = Duration::from_secs(2);

pub fn resolve_repo(cwd: &str) -> RepoInfo {
    let fallback = || RepoInfo {
        root: None,
        name: basename(cwd),
        branch: None,
    };
    let mut cmd = Command::new("git");
    cmd.args([
        "-C",
        cwd,
        "rev-parse",
        "--show-toplevel",
        "--abbrev-ref",
        "HEAD",
    ]);
    #[cfg(windows)]
    cmd.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
    let out = match run_git(cmd) {
        Some(out) if out.status.success() => out,
        _ => return fallback(),
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut lines = text.lines();
    let (Some(root), Some(branch)) = (lines.next(), lines.next()) else {
        return fallback();
    };
    if root.is_empty() || branch.is_empty() {
        return fallback();
    }
    RepoInfo {
        root: Some(root.to_string()),
        name: basename(root),
        branch: Some(branch.to_string()),
    }
}

/// Run a git command to completion, bounded by [`GIT_TIMEOUT`]. Returns the
/// output on success; on timeout (or spawn/wait failure) kills the child and
/// returns `None`. Stdout is piped (parsed above); stderr goes nowhere.
fn run_git(mut cmd: Command) -> Option<std::process::Output> {
    run_bounded(&mut cmd, GIT_TIMEOUT)
}

/// Spawn `cmd` with piped stdout, poll `try_wait` against `deadline`, kill on
/// timeout. Split out so tests can inject a short deadline deterministically.
fn run_bounded(cmd: &mut Command, timeout: Duration) -> Option<std::process::Output> {
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let stdout = child.stdout.take();
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                // Exited: drain whatever stdout holds.
                let mut out = Vec::new();
                if let Some(mut pipe) = stdout {
                    use std::io::Read as _;
                    let _ = pipe.read_to_end(&mut out);
                }
                return Some(std::process::Output {
                    status,
                    stdout: out,
                    stderr: Vec::new(),
                });
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

fn basename(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_repo_falls_back_outside_git() {
        let dir = tempfile::tempdir().unwrap();
        let info = resolve_repo(dir.path().to_str().unwrap());
        assert_eq!(info.root, None);
        assert_eq!(info.branch, None);
        assert_eq!(info.name, dir.path().file_name().unwrap().to_str().unwrap());
    }

    // Deterministic timeout proof: sleep 30 s, deadline zero — no timing
    // assert, the child cannot exit before the first poll wakes. On Windows
    // `timeout /t 30` plays the sleeper; elsewhere `sleep 30`.
    #[test]
    fn bounded_run_kills_slow_child() {
        let mut cmd = slow_child();
        assert!(run_bounded(&mut cmd, Duration::ZERO).is_none());
    }

    #[test]
    fn bounded_run_collects_fast_child() {
        let mut cmd = fast_child();
        let out = run_bounded(&mut cmd, Duration::from_secs(10)).expect("fast child");
        assert!(out.status.success());
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "ok");
    }

    #[cfg(windows)]
    fn slow_child() -> Command {
        let mut c = Command::new("cmd");
        c.args(["/C", "timeout", "/t", "30", "/nobreak"]);
        c
    }

    #[cfg(not(windows))]
    fn slow_child() -> Command {
        let mut c = Command::new("sleep");
        c.arg("30");
        c
    }

    #[cfg(windows)]
    fn fast_child() -> Command {
        let mut c = Command::new("cmd");
        c.args(["/C", "echo", "ok"]);
        c
    }

    #[cfg(not(windows))]
    fn fast_child() -> Command {
        let mut c = Command::new("echo");
        c.arg("ok");
        c
    }
}
