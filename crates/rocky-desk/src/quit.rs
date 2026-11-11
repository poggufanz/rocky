//! `--quit`: close the running desk and daemon, or report that they stayed.
//!
//! Node swaps the desk binaries before a launch, so it asks any running desk
//! to close first. The daemon broadcasts the quit and exits; this module waits
//! until both are gone and reports the outcome as an exit code.

use std::path::Path;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use rocky_proto::pipe::CmdName;

use crate::client::{self, ConnectError};
use crate::relay;

/// Longest wait a launch gives a running desk and daemon to disappear.
pub const QUIT_WAIT: Duration = Duration::from_secs(10);

/// Gap between two liveness probes.
pub const POLL: Duration = Duration::from_millis(100);

/// Longest single daemon probe, so a wedged daemon does not stretch the wait.
const PROBE_TIMEOUT: Duration = Duration::from_secs(1);

/// Ask the daemon to close every desk and exit, then wait for both to go.
///
/// Returns 0 when no desk holds the instance lock and no daemon answers, and
/// 2 when `wait` runs out first. A relay failure is ignored: the desk may
/// already be closing, and the probes alone decide the outcome.
pub fn quit_running(rocky_home: &Path, wait: Duration) -> i32 {
    let deadline = Instant::now() + wait;
    let _ = relay::send_cmd(rocky_home, CmdName::Quit, relay::RELAY_TIMEOUT.min(wait));
    loop {
        if !desk_holds_lock(rocky_home) && !daemon_answers(rocky_home) {
            return 0;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return 2;
        }
        std::thread::sleep(POLL.min(remaining));
    }
}

/// Whether the daemon still accepts a client. Never spawns one.
fn daemon_answers(rocky_home: &Path) -> bool {
    let (tx, _rx) = mpsc::channel();
    match client::connect_and_subscribe(rocky_home, tx, PROBE_TIMEOUT) {
        Ok(_) => true,
        // A transport failure is the only answer that means the daemon is
        // gone; a foreign, wrong-version, or silent server is still a server.
        Err(ConnectError::Io(_)) => false,
        Err(_) => true,
    }
}

/// Create the instance mutex, note whether it already existed, and close it at
/// once. The desk's lock is the mutex object's existence, not its ownership.
#[cfg(windows)]
fn desk_holds_lock(rocky_home: &Path) -> bool {
    use std::os::windows::ffi::OsStrExt;

    use windows_sys::Win32::Foundation::{CloseHandle, ERROR_ALREADY_EXISTS, GetLastError};
    use windows_sys::Win32::System::Threading::CreateMutexW;

    let wide: Vec<u16> = std::ffi::OsStr::new(&rocky_proto::paths::desk_mutex_name(rocky_home))
        .encode_wide()
        .chain([0])
        .collect();
    // SAFETY: the name is NUL-terminated and outlives the call.
    let handle = unsafe { CreateMutexW(std::ptr::null(), 0, wide.as_ptr()) };
    if handle.is_null() {
        // No mutex can be created here, so none can be held away from us.
        return false;
    }
    let existed = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
    // SAFETY: the handle came from CreateMutexW and is closed once.
    unsafe { CloseHandle(handle) };
    existed
}

/// Try the instance file lock and release it at once. `flock` on a separately
/// opened descriptor conflicts with the desk's, even inside one process.
#[cfg(unix)]
fn desk_holds_lock(rocky_home: &Path) -> bool {
    use std::os::fd::AsRawFd;

    let Ok(lock) = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(rocky_proto::paths::desk_lock_path(rocky_home))
    else {
        // No lock file: no desk ever ran here.
        return false;
    };
    // SAFETY: `lock` owns a live descriptor; flock touches only that
    // descriptor and the process lock table.
    if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
        // Taken and released at once: the desk is gone.
        unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_UN) };
        return false;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EWOULDBLOCK)
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::time::Duration;

    #[cfg(windows)]
    use std::sync::mpsc;

    use tempfile::TempDir;

    use super::*;

    #[test]
    fn quit_running_returns_0_when_nothing_runs() {
        let home = TempDir::new().unwrap();
        assert_eq!(quit_running(home.path(), Duration::from_secs(1)), 0);
    }

    #[test]
    fn quit_running_returns_2_while_a_desk_holds_the_lock() {
        let home = TempDir::new().unwrap();
        let _held = Held::acquire(home.path());
        assert_eq!(quit_running(home.path(), Duration::from_millis(300)), 2);
    }

    /// A running desk kept alive until this value drops.
    #[cfg(windows)]
    struct Held {
        release: mpsc::Sender<()>,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    #[cfg(windows)]
    impl Held {
        /// Hold the instance mutex from another thread. A named mutex is
        /// recursive for its owning thread, so holding it here is what makes
        /// the probe in the test thread see real contention.
        fn acquire(home: &Path) -> Held {
            let name = rocky_proto::paths::desk_mutex_name(home);
            let (ready_tx, ready_rx) = mpsc::channel();
            let (release, release_rx) = mpsc::channel::<()>();
            let thread = std::thread::spawn(move || {
                use std::os::windows::ffi::OsStrExt;

                use windows_sys::Win32::Foundation::CloseHandle;
                use windows_sys::Win32::System::Threading::CreateMutexW;

                let wide: Vec<u16> = std::ffi::OsStr::new(&name)
                    .encode_wide()
                    .chain([0])
                    .collect();
                // SAFETY: the name is NUL-terminated and outlives the call.
                let handle = unsafe { CreateMutexW(std::ptr::null(), 0, wide.as_ptr()) };
                assert!(!handle.is_null(), "cannot create the instance mutex");
                ready_tx.send(()).unwrap();
                let _ = release_rx.recv();
                // SAFETY: the handle came from CreateMutexW and is closed once.
                unsafe { CloseHandle(handle) };
            });
            ready_rx.recv().expect("holder thread starts");
            Held {
                release,
                thread: Some(thread),
            }
        }
    }

    #[cfg(windows)]
    impl Drop for Held {
        fn drop(&mut self) {
            let _ = self.release.send(());
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }

    /// A running desk kept alive until this value drops.
    #[cfg(unix)]
    struct Held {
        file: std::fs::File,
    }

    #[cfg(unix)]
    impl Held {
        fn acquire(home: &Path) -> Held {
            use std::os::fd::AsRawFd;

            let path = rocky_proto::paths::desk_lock_path(home);
            std::fs::create_dir_all(path.parent().expect("lock has a parent")).unwrap();
            let file = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(&path)
                .unwrap();
            // SAFETY: `file` owns a live descriptor; flock touches only that
            // descriptor and the process lock table. A separate descriptor
            // conflicts with the probe's even inside one process.
            assert_eq!(
                unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
                0
            );
            Held { file }
        }
    }

    #[cfg(unix)]
    impl Drop for Held {
        fn drop(&mut self) {
            use std::os::fd::AsRawFd;

            // SAFETY: the descriptor is still open.
            unsafe { libc::flock(self.file.as_raw_fd(), libc::LOCK_UN) };
        }
    }
}
