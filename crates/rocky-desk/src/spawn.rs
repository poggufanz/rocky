//! Daemon spawning: detached `rockyd`, tolerant of launcher jobs.

use std::io;
use std::path::Path;

pub struct SpawnInfo {
    /// True when the spawn only succeeded without `CREATE_BREAKAWAY_FROM_JOB`,
    /// so the daemon dies with the launcher's job.
    pub tied_to_job: bool,
}

/// Name of the daemon executable beside this one.
pub fn daemon_exe_name() -> String {
    format!("rockyd{}", std::env::consts::EXE_SUFFIX)
}

/// Spawn the daemon detached. If the launcher job forbids breakaway
/// (`ERROR_ACCESS_DENIED`), retry without `CREATE_BREAKAWAY_FROM_JOB` and
/// report `tied_to_job: true`.
#[cfg(windows)]
pub fn spawn_daemon(exe: &Path) -> io::Result<SpawnInfo> {
    use std::os::windows::ffi::OsStrExt;

    use windows_sys::Win32::Foundation::{CloseHandle, ERROR_ACCESS_DENIED};
    use windows_sys::Win32::System::Threading::{
        CREATE_BREAKAWAY_FROM_JOB, CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW, CreateProcessW,
        DETACHED_PROCESS, PROCESS_INFORMATION, STARTUPINFOW,
    };

    unsafe {
        let app: Vec<u16> = exe.as_os_str().encode_wide().chain([0]).collect();
        // Command line: quoted exe path, no arguments. CreateProcessW may
        // mutate this buffer, so it must be writable.
        let mut cmd: Vec<u16> = std::iter::once(b'"' as u16)
            .chain(exe.as_os_str().encode_wide())
            .chain([b'"' as u16, 0])
            .collect();
        let full = DETACHED_PROCESS
            | CREATE_NEW_PROCESS_GROUP
            | CREATE_BREAKAWAY_FROM_JOB
            | CREATE_NO_WINDOW;
        let plain = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW;

        let mut attempt = |flags: u32| -> io::Result<()> {
            let mut si: STARTUPINFOW = std::mem::zeroed();
            si.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
            let mut pi: PROCESS_INFORMATION = std::mem::zeroed();
            let ok = CreateProcessW(
                app.as_ptr(),
                cmd.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                flags,
                std::ptr::null(),
                std::ptr::null(),
                &si,
                &mut pi,
            );
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
            CloseHandle(pi.hProcess);
            CloseHandle(pi.hThread);
            Ok(())
        };

        match attempt(full) {
            Ok(()) => Ok(SpawnInfo { tied_to_job: false }),
            Err(e) if e.raw_os_error() == Some(ERROR_ACCESS_DENIED as i32) => {
                attempt(plain)?;
                Ok(SpawnInfo { tied_to_job: true })
            }
            Err(e) => Err(e),
        }
    }
}

/// Spawn the daemon in its own process group, with no inherited stdio, and
/// wait on it off-thread so a daemon that exits cannot become a zombie.
#[cfg(unix)]
pub fn spawn_daemon(exe: &Path) -> io::Result<SpawnInfo> {
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};

    let mut child = Command::new(exe)
        .process_group(0)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(SpawnInfo { tied_to_job: false })
}

#[cfg(not(any(windows, unix)))]
pub fn spawn_daemon(_exe: &Path) -> io::Result<SpawnInfo> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "daemon spawn is not implemented on this platform",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn daemon_exe_name_follows_the_platform() {
        assert_eq!(
            daemon_exe_name(),
            format!("rockyd{}", std::env::consts::EXE_SUFFIX)
        );
    }

    /// The spawned child must be waited on, or it lingers as a zombie owned by
    /// the test process. A live or zombie `/proc` entry keeps our pid as its
    /// parent, so that entry disappearing proves the reaper thread waited on
    /// it. Only `/bin/true` counts: another unit test in this binary may spawn
    /// a process of its own.
    #[cfg(target_os = "linux")]
    #[test]
    fn spawned_daemon_is_reaped() {
        spawn_daemon(Path::new("/bin/true")).expect("spawn /bin/true");

        let me = std::process::id();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            match child_state(me, "true") {
                None => return,
                Some(_) if std::time::Instant::now() < deadline => {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                Some(state) => panic!(
                    "child true was still present after 2 s (state {state}, zombie: {})",
                    state == 'Z'
                ),
            }
        }
    }

    /// `/proc` state of the child of `ppid` whose field 2 is `comm`, while it
    /// runs or waits to be reaped. The command name may hold spaces and
    /// parentheses, so field 2 is read from the first `(` to the last `)`.
    #[cfg(target_os = "linux")]
    fn child_state(ppid: u32, comm: &str) -> Option<char> {
        let field2 = format!("({comm})");
        for entry in std::fs::read_dir("/proc").ok()? {
            let Ok(entry) = entry else { continue };
            let Ok(stat) = std::fs::read_to_string(entry.path().join("stat")) else {
                continue;
            };
            let (Some(open), Some(close)) = (stat.find('('), stat.rfind(')')) else {
                continue;
            };
            if &stat[open..=close] != field2.as_str() {
                continue;
            }
            let mut fields = stat[close + 1..].split_whitespace();
            let (Some(state), Some(parent)) = (fields.next(), fields.next()) else {
                continue;
            };
            let Some(state) = state.chars().next() else {
                continue;
            };
            if parent.parse::<u32>() == Ok(ppid) {
                return Some(state);
            }
        }
        None
    }
}
