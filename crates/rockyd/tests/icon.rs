//! `rockyd.exe` carries the same icon resource as the desk.

#[cfg(windows)]
#[test]
fn exe_carries_an_icon() {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    let exe = env!("CARGO_BIN_EXE_rockyd");
    let wide: Vec<u16> = OsStr::new(exe).encode_wide().chain([0]).collect();
    let count = unsafe {
        windows_sys::Win32::UI::Shell::ExtractIconExW(
            wide.as_ptr(),
            -1,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            0,
        )
    };
    assert!(count >= 1, "{exe} carries no icon resource");
}
