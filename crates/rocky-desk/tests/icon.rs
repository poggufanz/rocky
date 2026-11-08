//! The desk's icon resource and the shipped `.ico` the toast reuses.

/// ICONDIR: reserved 0, type 1 (icon), count 4, then the entry widths.
#[test]
fn ico_header_lists_four_sizes() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/assets/rocky.ico");
    let b = std::fs::read(path).unwrap();
    assert_eq!(&b[0..6], &[0, 0, 1, 0, 4, 0]);
    let widths: Vec<u8> = (0..4).map(|i| b[6 + i * 16]).collect();
    assert_eq!(widths, vec![16, 32, 48, 0]); // 0 means 256
}

/// Windows shows the exe's resource 1 in Explorer and in the taskbar button.
#[cfg(windows)]
#[test]
fn exe_carries_an_icon() {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    let exe = env!("CARGO_BIN_EXE_rocky-desk");
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
