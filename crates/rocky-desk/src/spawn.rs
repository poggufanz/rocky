//! Daemon spawning: detached `rockyd.exe`, tolerant of launcher jobs.

use std::io;
use std::path::Path;

pub struct SpawnInfo {
    /// True when the spawn only succeeded without `CREATE_BREAKAWAY_FROM_JOB`,
    /// so the daemon dies with the launcher's job.
    pub tied_to_job: bool,
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

#[cfg(not(windows))]
pub fn spawn_daemon(_exe: &Path) -> io::Result<SpawnInfo> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "daemon spawn is Windows-only",
    ))
}
