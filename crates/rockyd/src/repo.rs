//! Repo resolution: map a session cwd to a git root/branch or a plain folder name.

use std::path::Path;
use std::process::Command;

use rocky_proto::pipe::RepoInfo;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

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
    let out = match cmd.output() {
        Ok(out) if out.status.success() => out,
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
}
