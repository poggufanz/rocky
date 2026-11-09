//! HKCU values: strings as wide REG_SZ data, and raw REG_BINARY reads.
//!
//! A missing key or value reads as `Ok(None)` / `Ok(())` so callers can treat
//! absence as the default. Win32 codes surface as `io::Error`.

use std::ffi::c_void;
use std::io;
use std::ptr::{null, null_mut};

use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_MORE_DATA, ERROR_SUCCESS};
use windows_sys::Win32::System::Registry::{
    HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE, REG_OPTION_NON_VOLATILE, REG_ROUTINE_FLAGS, REG_SZ,
    REG_VALUE_TYPE, RRF_RT_REG_BINARY, RRF_RT_REG_SZ, RegCloseKey, RegCreateKeyExW, RegDeleteTreeW,
    RegDeleteValueW, RegGetValueW, RegOpenKeyExW, RegSetValueExW,
};

/// UTF-16 with the terminating NUL Win32 expects.
pub(crate) fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

fn error(code: u32) -> io::Error {
    io::Error::from_raw_os_error(code as i32)
}

/// The value's bytes, restricted to the types in `flags`.
fn get_raw(subkey: &str, name: &str, flags: REG_ROUTINE_FLAGS) -> io::Result<Option<Vec<u8>>> {
    let subkey = wide(subkey);
    let name = wide(name);

    let mut size = 0u32;
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            subkey.as_ptr(),
            name.as_ptr(),
            flags,
            null_mut(),
            null_mut(),
            &mut size,
        )
    };
    if status == ERROR_FILE_NOT_FOUND {
        return Ok(None);
    }
    if status != ERROR_SUCCESS && status != ERROR_MORE_DATA {
        return Err(error(status));
    }

    let mut buf = vec![0u8; (size as usize).max(1)];
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            subkey.as_ptr(),
            name.as_ptr(),
            flags,
            null_mut(),
            buf.as_mut_ptr().cast::<c_void>(),
            &mut size,
        )
    };
    if status != ERROR_SUCCESS {
        return Err(error(status));
    }
    buf.truncate(size as usize);
    Ok(Some(buf))
}

pub fn get_string(subkey: &str, name: &str) -> io::Result<Option<String>> {
    Ok(get_raw(subkey, name, RRF_RT_REG_SZ)?.map(|bytes| {
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&units)
            .trim_end_matches('\0')
            .to_string()
    }))
}

pub fn get_binary(subkey: &str, name: &str) -> io::Result<Option<Vec<u8>>> {
    get_raw(subkey, name, RRF_RT_REG_BINARY)
}

pub fn set_string(subkey: &str, name: &str, value: &str) -> io::Result<()> {
    let data: Vec<u8> = wide(value).iter().flat_map(|u| u.to_le_bytes()).collect();
    set_raw(subkey, name, REG_SZ, &data)
}

/// Raw REG_BINARY write; only tests need it, to stand in for Task Manager.
#[cfg(test)]
pub(crate) fn set_binary(subkey: &str, name: &str, value: &[u8]) -> io::Result<()> {
    set_raw(
        subkey,
        name,
        windows_sys::Win32::System::Registry::REG_BINARY,
        value,
    )
}

fn set_raw(subkey: &str, name: &str, kind: REG_VALUE_TYPE, data: &[u8]) -> io::Result<()> {
    let subkey = wide(subkey);
    let name = wide(name);

    let mut key: HKEY = null_mut();
    let status = unsafe {
        RegCreateKeyExW(
            HKEY_CURRENT_USER,
            subkey.as_ptr(),
            0,
            null(),
            REG_OPTION_NON_VOLATILE,
            KEY_SET_VALUE,
            null(),
            &mut key,
            null_mut(),
        )
    };
    if status != ERROR_SUCCESS {
        return Err(error(status));
    }

    let status = unsafe {
        RegSetValueExW(
            key,
            name.as_ptr(),
            0,
            kind,
            data.as_ptr(),
            data.len() as u32,
        )
    };
    unsafe { RegCloseKey(key) };
    if status != ERROR_SUCCESS {
        return Err(error(status));
    }
    Ok(())
}

pub fn delete_value(subkey: &str, name: &str) -> io::Result<()> {
    let subkey = wide(subkey);
    let name = wide(name);

    let mut key: HKEY = null_mut();
    let status = unsafe {
        RegOpenKeyExW(
            HKEY_CURRENT_USER,
            subkey.as_ptr(),
            0,
            KEY_SET_VALUE,
            &mut key,
        )
    };
    if status == ERROR_FILE_NOT_FOUND {
        return Ok(());
    }
    if status != ERROR_SUCCESS {
        return Err(error(status));
    }

    let status = unsafe { RegDeleteValueW(key, name.as_ptr()) };
    unsafe { RegCloseKey(key) };
    if status == ERROR_FILE_NOT_FOUND {
        return Ok(());
    }
    if status != ERROR_SUCCESS {
        return Err(error(status));
    }
    Ok(())
}

pub fn delete_tree(subkey: &str) -> io::Result<()> {
    let subkey = wide(subkey);
    let status = unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, subkey.as_ptr()) };
    if status == ERROR_FILE_NOT_FOUND {
        return Ok(());
    }
    if status != ERROR_SUCCESS {
        return Err(error(status));
    }
    Ok(())
}

/// Per-process key that tests may write freely; removed on drop.
#[cfg(test)]
pub(crate) struct ScratchKey(String);

#[cfg(test)]
pub(crate) fn scratch_key() -> ScratchKey {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    // Parallel test threads can read the same clock tick; the counter keeps
    // every scratch key unique even when the clock is coarse.
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    ScratchKey(format!(
        r"Software\RockyDeskTest\{}-{}-{}",
        std::process::id(),
        nanos,
        seq
    ))
}

#[cfg(test)]
impl ScratchKey {
    pub(crate) fn path(&self) -> &str {
        &self.0
    }
}

#[cfg(test)]
impl Drop for ScratchKey {
    fn drop(&mut self) {
        let _ = delete_tree(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_string_roundtrip_in_scratch_key() {
        let key = scratch_key();
        assert_eq!(get_string(key.path(), "v").unwrap(), None);
        let v = r#""C:\a b\rocky-desk.exe" --tray"#;
        set_string(key.path(), "v", v).unwrap();
        assert_eq!(get_string(key.path(), "v").unwrap().as_deref(), Some(v));
        delete_value(key.path(), "v").unwrap();
        assert_eq!(get_string(key.path(), "v").unwrap(), None);
        delete_value(key.path(), "v").unwrap();
    }

    #[test]
    fn registry_binary_roundtrip_in_scratch_key() {
        let key = scratch_key();
        assert_eq!(get_binary(key.path(), "b").unwrap(), None);
        let v = [3u8, 0, 0, 0, 0xF7, 0xEE, 0x13, 0x42, 0x60, 0x6F, 0xDD, 0x01];
        set_binary(key.path(), "b", &v).unwrap();
        assert_eq!(
            get_binary(key.path(), "b").unwrap().as_deref(),
            Some(&v[..])
        );
    }
}
