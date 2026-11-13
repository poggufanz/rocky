//! Repo resolution: map a session cwd to a git root/branch or a plain folder name.

use std::ffi::OsStr;
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
        main_root: None,
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
        "--path-format=absolute",
        "--git-common-dir",
    ]);
    #[cfg(windows)]
    cmd.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
    let Some(out) = run_git(cmd) else {
        return fallback();
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut lines = text.lines();
    let (Some(root), Some(branch)) = (lines.next(), lines.next()) else {
        return fallback();
    };
    if root.is_empty() || branch.is_empty() {
        return fallback();
    }
    let main_root = if out.status.success() {
        main_root_from_common_dir(root, lines.next())
    } else if out.status.code() == Some(129) {
        // Older git rejecting --path-format=absolute after printing root/branch falls back to root.
        root.to_string()
    } else {
        return fallback();
    };
    RepoInfo {
        root: Some(root.to_string()),
        main_root: Some(main_root),
        name: basename(root),
        branch: Some(branch.to_string()),
    }
}

fn main_root_from_common_dir(root: &str, common_dir: Option<&str>) -> String {
    let Some(dir) = common_dir.filter(|s| !s.is_empty() && *s != "--path-format=absolute") else {
        return root.to_string();
    };
    let path = Path::new(dir);
    if path.is_absolute()
        && path.file_name() == Some(OsStr::new(".git"))
        && let Some(parent) = path
            .parent()
            .and_then(|p| p.to_str())
            .filter(|s| !s.is_empty())
    {
        return parent.to_string();
    }
    root.to_string()
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
        assert_eq!(info.main_root, None);
        assert_eq!(info.branch, None);
        assert_eq!(info.name, dir.path().file_name().unwrap().to_str().unwrap());
    }

    fn run_git_checked(cwd: &Path, args: &[&str]) {
        let mut cmd = Command::new("git");
        cmd.arg("-C").arg(cwd).args(args);
        #[cfg(windows)]
        cmd.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
        let out = cmd.output().expect("spawn git");
        assert!(
            out.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
    }

    #[test]
    fn resolve_repo_reports_main_root_for_worktree() {
        let dir = tempfile::tempdir().unwrap();
        let non_repo = dir.path().join("outside");
        std::fs::create_dir(&non_repo).unwrap();
        let outside = resolve_repo(non_repo.to_str().unwrap());
        assert_eq!(outside.root, None);
        assert_eq!(outside.main_root, None);

        let main = dir.path().join("main");
        std::fs::create_dir(&main).unwrap();
        run_git_checked(&main, &["init", "-b", "main"]);
        std::fs::write(main.join("README.md"), "hi\n").unwrap();
        run_git_checked(&main, &["add", "README.md"]);
        run_git_checked(
            &main,
            &[
                "-c",
                "user.name=Rocky",
                "-c",
                "user.email=rocky@example.com",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-m",
                "init",
            ],
        );

        let plain_info = resolve_repo(main.to_str().unwrap());
        assert!(plain_info.root.is_some());
        assert_eq!(plain_info.main_root, plain_info.root);
        assert_eq!(plain_info.branch.as_deref(), Some("main"));

        let wt = dir.path().join("wt");
        run_git_checked(
            &main,
            &["worktree", "add", "-b", "topic", wt.to_str().unwrap()],
        );

        let wt_info = resolve_repo(wt.to_str().unwrap());
        assert!(wt_info.root.is_some());
        assert_eq!(wt_info.main_root, plain_info.root);
        assert_ne!(wt_info.root, wt_info.main_root);
        assert_eq!(wt_info.branch.as_deref(), Some("topic"));

        let sub = wt.join("nested");
        std::fs::create_dir(&sub).unwrap();
        let sub_info = resolve_repo(sub.to_str().unwrap());
        assert_eq!(sub_info.root, wt_info.root);
        assert_eq!(sub_info.main_root, plain_info.root);

        let canon = |p: &Path| {
            let real = std::fs::canonicalize(p).unwrap();
            let s = real.to_string_lossy();
            let stripped = s.strip_prefix(r"\\?\").unwrap_or(&s);
            rocky_proto::paths::canonical_path(stripped, cfg!(windows))
        };
        assert_eq!(
            rocky_proto::paths::canonical_path(wt_info.root.as_deref().unwrap(), cfg!(windows)),
            canon(&wt)
        );
        assert_eq!(
            rocky_proto::paths::canonical_path(
                wt_info.main_root.as_deref().unwrap(),
                cfg!(windows)
            ),
            canon(&main)
        );
    }

    #[test]
    fn main_root_from_common_dir_falls_back_when_flag_rejected_or_relative() {
        let wt = if cfg!(windows) {
            "C:/work/wt"
        } else {
            "/work/wt"
        };
        let main_git = if cfg!(windows) {
            "C:/work/main/.git"
        } else {
            "/work/main/.git"
        };
        let main = if cfg!(windows) {
            "C:/work/main"
        } else {
            "/work/main"
        };
        let bare_git = if cfg!(windows) {
            "C:/work/bare.git"
        } else {
            "/work/bare.git"
        };
        assert_eq!(main_root_from_common_dir(wt, Some(main_git)), main);
        assert_eq!(
            main_root_from_common_dir(wt, Some("--path-format=absolute")),
            wt
        );
        assert_eq!(main_root_from_common_dir(wt, Some(".git")), wt);
        assert_eq!(main_root_from_common_dir(wt, Some(bare_git)), wt);
        assert_eq!(main_root_from_common_dir(wt, None), wt);
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
