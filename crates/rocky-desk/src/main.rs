#![windows_subsystem = "windows"]

use rocky_proto::paths::{desk_mutex_name, rocky_home};

#[cfg(windows)]
fn main() {
    let home = rocky_home();
    // Single instance: if the mutex already exists, another desk owns it.
    let _mutex = match single_instance(&desk_mutex_name(&home)) {
        Some(m) => m,
        None => return,
    };
    rocky_desk::app::run(home);
    // `_mutex` drops here, releasing the instance lock.
}

#[cfg(not(windows))]
fn main() {
    eprintln!("rocky-desk is Windows-only in M0.");
    std::process::exit(1);
}

/// Create the named mutex; returns `None` when it already exists. The handle
/// must stay alive for the process lifetime.
#[cfg(windows)]
fn single_instance(name: &str) -> Option<SingleMutex> {
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
            return None;
        }
        if GetLastError() == ERROR_ALREADY_EXISTS {
            CloseHandle(handle);
            return None;
        }
        Some(SingleMutex(handle))
    }
}

#[cfg(windows)]
struct SingleMutex(*mut core::ffi::c_void);

// The handle is only closed on drop, on the main thread.
#[cfg(windows)]
unsafe impl Send for SingleMutex {}
#[cfg(windows)]
unsafe impl Sync for SingleMutex {}

#[cfg(windows)]
impl Drop for SingleMutex {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}
