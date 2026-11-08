#![windows_subsystem = "windows"]

use rocky_proto::paths::{desk_mutex_name, rocky_home};

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

/// A second launch owns the foreground right; hand it to the running desk
/// before asking it to come forward. Every failure stays silent: the desk may
/// be starting up or already exiting, and this launch still exits 0.
#[cfg(windows)]
fn focus_running_desk(home: &std::path::Path) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{ASFW_ANY, AllowSetForegroundWindow};

    // SAFETY: no pointers cross the boundary; ASFW_ANY grants the right to any
    // process, which is exactly the running desk.
    unsafe { AllowSetForegroundWindow(ASFW_ANY) };
    let _ = rocky_desk::relay::send_show(home, rocky_desk::relay::RELAY_TIMEOUT);
}

/// The desk has no console, and a panic inside a Win32 callback aborts with
/// 0xc0000409 and no message. Append each panic to `desk/rocky-desk.log`.
#[cfg(windows)]
fn install_panic_log(home: &std::path::Path) {
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

#[cfg(not(windows))]
fn main() {
    eprintln!("rocky-desk is Windows-only for now.");
    std::process::exit(1);
}

#[cfg(windows)]
enum InstanceError {
    AlreadyRunning,
    Failed,
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
