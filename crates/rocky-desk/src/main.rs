#![windows_subsystem = "windows"]

#[cfg(any(windows, unix))]
use std::path::Path;

#[cfg(windows)]
use rocky_proto::paths::desk_mutex_name;
#[cfg(any(windows, unix))]
use rocky_proto::paths::rocky_home;
#[cfg(unix)]
use rocky_proto::paths::{desk_dir, desk_lock_path};

#[cfg(windows)]
fn main() {
    let home = rocky_home();
    install_panic_log(&home);
    // Single instance: if the mutex already exists, another desk owns it.
    let _mutex = match single_instance(&desk_mutex_name(&home)) {
        Ok(m) => m,
        Err(InstanceError::AlreadyRunning) => {
            focus_running_desk(&home);
            return;
        }
        Err(InstanceError::Failed) => std::process::exit(1),
    };
    let opts = rocky_desk::autostart::parse_args(std::env::args());
    rocky_desk::app::run(home, opts);
    // `_mutex` drops here, releasing the instance lock.
}

#[cfg(unix)]
fn main() {
    let home = rocky_home();
    install_panic_log(&home);
    // Single instance: if the lock is already held, another desk owns it and
    // gets asked to come forward instead.
    let _lock = match single_instance(&home) {
        Ok(lock) => lock,
        Err(InstanceError::AlreadyRunning) => {
            let _ = rocky_desk::relay::send_show(&home, rocky_desk::relay::RELAY_TIMEOUT);
            return;
        }
        Err(InstanceError::Failed) => std::process::exit(1),
    };
    let opts = rocky_desk::autostart::parse_args(std::env::args());
    rocky_desk::app::run(home, opts);
    // `_lock` drops here, releasing the instance lock.
}

/// A second launch owns the foreground right; hand it to the running desk
/// before asking it to come forward. Every failure stays silent: the desk may
/// be starting up or already exiting, and this launch still exits 0.
#[cfg(windows)]
fn focus_running_desk(home: &Path) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{ASFW_ANY, AllowSetForegroundWindow};

    // SAFETY: no pointers cross the boundary; ASFW_ANY grants the right to any
    // process, which is exactly the running desk.
    unsafe { AllowSetForegroundWindow(ASFW_ANY) };
    let _ = rocky_desk::relay::send_show(home, rocky_desk::relay::RELAY_TIMEOUT);
}

/// The desk has no console on Windows, and a panic inside a Win32 callback
/// aborts with 0xc0000409 and no message. Append each panic to
/// `desk/rocky-desk.log`.
#[cfg(any(windows, unix))]
fn install_panic_log(home: &Path) {
    let path = rocky_proto::paths::desk_dir(home).join("rocky-desk.log");
    std::panic::set_hook(Box::new(move |info| {
        use std::io::Write;
        let bt = std::backtrace::Backtrace::force_capture();
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            let _ = writeln!(f, "panic: {info}\n{bt}");
        }
    }));
}

#[cfg(not(any(windows, unix)))]
fn main() {
    eprintln!("rocky-desk is not implemented on this platform.");
    std::process::exit(1);
}

#[cfg(any(windows, unix))]
enum InstanceError {
    AlreadyRunning,
    Failed,
}

/// Lock the desk's instance file, created owner-only. The handle must stay
/// alive for the process lifetime; the kernel drops the lock with it.
#[cfg(unix)]
fn single_instance(home: &Path) -> Result<std::fs::File, InstanceError> {
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

    let path = desk_lock_path(home);
    let Some(parent) = path.parent() else {
        eprintln!("rocky-desk: {} has no parent directory", path.display());
        return Err(InstanceError::Failed);
    };
    // The desk writes its log here before the daemon starts, so make the desk
    // dir owner-only up front whether or not the lock lives in it. The lock's
    // parent is the runtime dir, which may not exist yet.
    let desk = desk_dir(home);
    for dir in [desk.as_path(), parent] {
        std::fs::create_dir_all(dir).map_err(|e| {
            eprintln!("rocky-desk: cannot create {}: {e}", dir.display());
            InstanceError::Failed
        })?;
    }
    let _ = std::fs::set_permissions(&desk, std::fs::Permissions::from_mode(0o700));
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(&path)
        .map_err(|e| {
            eprintln!("rocky-desk: cannot open {}: {e}", path.display());
            InstanceError::Failed
        })?;
    // SAFETY: `lock` owns a live file descriptor; flock only touches that
    // descriptor and the process lock table.
    if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        let err = std::io::Error::last_os_error();
        if err.raw_os_error() == Some(libc::EWOULDBLOCK) {
            return Err(InstanceError::AlreadyRunning);
        }
        eprintln!("rocky-desk: cannot lock {}: {err}", path.display());
        return Err(InstanceError::Failed);
    }
    Ok(lock)
}

/// Create the named mutex. The handle must stay alive for the process lifetime.
#[cfg(windows)]
fn single_instance(name: &str) -> Result<SingleMutex, InstanceError> {
    use std::os::windows::ffi::OsStrExt;

    use windows_sys::Win32::Foundation::{CloseHandle, ERROR_ALREADY_EXISTS, GetLastError};

    let wide: Vec<u16> = std::ffi::OsStr::new(name)
        .encode_wide()
        .chain([0])
        .collect();
    unsafe {
        let handle =
            windows_sys::Win32::System::Threading::CreateMutexW(std::ptr::null(), 0, wide.as_ptr());
        if handle.is_null() {
            return Err(InstanceError::Failed);
        }
        if GetLastError() == ERROR_ALREADY_EXISTS {
            CloseHandle(handle);
            return Err(InstanceError::AlreadyRunning);
        }
        Ok(SingleMutex(handle))
    }
}

#[cfg(windows)]
struct SingleMutex(*mut core::ffi::c_void);

// Never leaves the main thread, so no Send/Sync impls.

#[cfg(windows)]
impl Drop for SingleMutex {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}
