//! Rocky home paths, desk layout, and pipe/mutex names.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

pub fn rocky_home_from(env_value: Option<&OsStr>, home: &Path) -> PathBuf {
    match env_value {
        Some(v) if !v.is_empty() => PathBuf::from(v),
        _ => home.join(".rocky"),
    }
}

pub fn rocky_home() -> PathBuf {
    let home = std::env::home_dir().unwrap_or_else(|| PathBuf::from("."));
    absolutize(rocky_home_from(
        std::env::var_os("ROCKY_HOME").as_deref(),
        &home,
    ))
}

fn absolutize(path: PathBuf) -> PathBuf {
    std::path::absolute(&path).unwrap_or(path)
}

pub fn desk_dir(rocky_home: &Path) -> PathBuf {
    rocky_home.join("desk")
}

pub fn spool_dir(rocky_home: &Path) -> PathBuf {
    desk_dir(rocky_home).join("spool")
}

pub fn bad_dir(rocky_home: &Path) -> PathBuf {
    spool_dir(rocky_home).join("bad")
}

pub fn log_path(rocky_home: &Path) -> PathBuf {
    desk_dir(rocky_home).join("rockyd.log")
}

pub fn settings_path(rocky_home: &Path) -> PathBuf {
    desk_dir(rocky_home).join("settings.json")
}

pub fn history_dir(rocky_home: &Path) -> PathBuf {
    desk_dir(rocky_home).join("history")
}

pub fn tool_text_off_marker(rocky_home: &Path) -> PathBuf {
    desk_dir(rocky_home).join("tool-text-off")
}

pub fn bin_dir(rocky_home: &Path) -> PathBuf {
    rocky_home.join("bin")
}

pub fn cli_record_path(rocky_home: &Path) -> PathBuf {
    bin_dir(rocky_home).join("cli.json")
}

pub fn binaries_record_path(rocky_home: &Path) -> PathBuf {
    bin_dir(rocky_home).join("binaries.json")
}

pub fn setup_dir(rocky_home: &Path) -> PathBuf {
    rocky_home.join("setup")
}

pub fn expected_path(rocky_home: &Path) -> PathBuf {
    setup_dir(rocky_home).join("expected.json")
}

pub fn consent_path(rocky_home: &Path) -> PathBuf {
    setup_dir(rocky_home).join("consent.json")
}

pub fn home_hash(rocky_home: &Path) -> String {
    let normalized = rocky_home
        .to_string_lossy()
        .replace('/', "\\")
        .to_lowercase();
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in normalized.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

pub fn pipe_name(rocky_home: &Path) -> String {
    format!(r"\\.\pipe\rocky-desk-{}", home_hash(rocky_home))
}

pub fn desk_mutex_name(rocky_home: &Path) -> String {
    format!(r"Local\rocky-desk-{}", home_hash(rocky_home))
}

/// Longest unix socket path the kernel accepts: `sun_path` is 108 bytes
/// including the NUL, so a path of up to 107 bytes fits.
#[cfg(unix)]
pub const SOCKET_PATH_MAX: usize = 107;

/// A usable `XDG_RUNTIME_DIR`: present, non-empty, and absolute.
#[cfg(unix)]
fn usable_runtime_dir(xdg_runtime_dir: Option<&OsStr>) -> Option<&Path> {
    xdg_runtime_dir
        .map(Path::new)
        .filter(|dir| dir.is_absolute())
}

/// Directory holding the socket and locks: the runtime dir, or the desk dir.
#[cfg(unix)]
pub fn runtime_dir_from(rocky_home: &Path, xdg_runtime_dir: Option<&OsStr>) -> PathBuf {
    match usable_runtime_dir(xdg_runtime_dir) {
        Some(dir) => dir.to_path_buf(),
        None => desk_dir(rocky_home),
    }
}

#[cfg(unix)]
pub fn socket_path_from(rocky_home: &Path, xdg_runtime_dir: Option<&OsStr>) -> PathBuf {
    match usable_runtime_dir(xdg_runtime_dir) {
        Some(dir) => dir.join(format!("rocky-desk-{}.sock", home_hash(rocky_home))),
        None => desk_dir(rocky_home).join("rockyd.sock"),
    }
}

#[cfg(unix)]
pub fn daemon_lock_path_from(rocky_home: &Path, xdg_runtime_dir: Option<&OsStr>) -> PathBuf {
    runtime_dir_from(rocky_home, xdg_runtime_dir)
        .join(format!("rockyd-{}.lock", home_hash(rocky_home)))
}

#[cfg(unix)]
pub fn desk_lock_path_from(rocky_home: &Path, xdg_runtime_dir: Option<&OsStr>) -> PathBuf {
    runtime_dir_from(rocky_home, xdg_runtime_dir)
        .join(format!("rocky-desk-{}.lock", home_hash(rocky_home)))
}

#[cfg(unix)]
pub fn socket_path(rocky_home: &Path) -> PathBuf {
    socket_path_from(rocky_home, std::env::var_os("XDG_RUNTIME_DIR").as_deref())
}

#[cfg(unix)]
pub fn daemon_lock_path(rocky_home: &Path) -> PathBuf {
    daemon_lock_path_from(rocky_home, std::env::var_os("XDG_RUNTIME_DIR").as_deref())
}

#[cfg(unix)]
pub fn desk_lock_path(rocky_home: &Path) -> PathBuf {
    desk_lock_path_from(rocky_home, std::env::var_os("XDG_RUNTIME_DIR").as_deref())
}

#[cfg(test)]
mod tests {
    use std::ffi::OsStr;
    use std::path::{Path, PathBuf};

    use super::{
        absolutize, bad_dir, bin_dir, binaries_record_path, cli_record_path, consent_path,
        desk_mutex_name, expected_path, history_dir, home_hash, log_path, pipe_name,
        rocky_home_from, settings_path, setup_dir, spool_dir, tool_text_off_marker,
    };

    #[test]
    fn env_wins_when_non_empty() {
        assert_eq!(
            rocky_home_from(Some(OsStr::new(r"D:\rh")), Path::new(r"C:\Users\a")),
            PathBuf::from(r"D:\rh")
        );
    }
    #[test]
    fn rocky_home_absolutizes_relative_input() {
        let rel = rocky_home_from(Some(OsStr::new("rel-home")), Path::new(r"C:\Users\a"));
        let abs = absolutize(rel);
        assert!(abs.is_absolute());
        assert_eq!(abs.file_name(), Some(OsStr::new("rel-home")));
        assert_eq!(abs, std::path::absolute("rel-home").unwrap());
    }
    #[test]
    fn empty_env_falls_back_to_home() {
        assert_eq!(
            rocky_home_from(Some(OsStr::new("")), Path::new(r"C:\Users\a")),
            Path::new(r"C:\Users\a").join(".rocky")
        );
    }
    #[test]
    fn hash_ignores_case_and_separator() {
        assert_eq!(
            home_hash(Path::new(r"C:\Users\A\.rocky")),
            home_hash(Path::new("c:/users/a/.rocky"))
        );
    }
    #[test]
    fn hash_is_16_lower_hex_and_stable_for_non_ascii() {
        let h = home_hash(Path::new(r"C:\Users\José Ñ\.rocky"));
        assert_eq!(h.len(), 16);
        assert!(
            h.chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        );
        assert_eq!(h, home_hash(Path::new(r"c:\users\josé ñ\.rocky")));
    }
    #[test]
    fn names_use_hash() {
        let p = Path::new(r"C:\Users\a\.rocky");
        assert_eq!(
            pipe_name(p),
            format!(r"\\.\pipe\rocky-desk-{}", home_hash(p))
        );
        assert_eq!(
            desk_mutex_name(p),
            format!(r"Local\rocky-desk-{}", home_hash(p))
        );
    }
    #[test]
    fn desk_layout() {
        let p = Path::new(r"C:\h");
        let desk = p.join("desk");
        assert_eq!(spool_dir(p), desk.join("spool"));
        assert_eq!(bad_dir(p), desk.join("spool").join("bad"));
        assert_eq!(log_path(p), desk.join("rockyd.log"));
        assert_eq!(tool_text_off_marker(p), desk.join("tool-text-off"));
        assert_eq!(settings_path(p), desk.join("settings.json"));
        assert_eq!(history_dir(p), desk.join("history"));
    }
    #[test]
    fn setup_layout() {
        let p = Path::new(r"C:\h");
        assert_eq!(bin_dir(p), p.join("bin"));
        assert_eq!(cli_record_path(p), p.join("bin").join("cli.json"));
        assert_eq!(binaries_record_path(p), p.join("bin").join("binaries.json"));
        assert_eq!(setup_dir(p), p.join("setup"));
        assert_eq!(expected_path(p), p.join("setup").join("expected.json"));
        assert_eq!(consent_path(p), p.join("setup").join("consent.json"));
    }
}

#[cfg(all(test, unix))]
mod unix_tests {
    use std::ffi::OsStr;
    use std::path::Path;

    use super::{daemon_lock_path_from, desk_lock_path_from, home_hash, socket_path_from};

    #[test]
    fn socket_uses_xdg_runtime_dir_with_home_hash() {
        let home = Path::new("/home/u/.rocky");
        let xdg = OsStr::new("/run/user/1000");
        let name = format!("rocky-desk-{}.sock", home_hash(home));
        assert_eq!(
            socket_path_from(home, Some(xdg)),
            Path::new("/run/user/1000").join(name)
        );
    }

    #[test]
    fn socket_falls_back_to_desk_dir_for_missing_empty_or_relative_xdg() {
        let home = Path::new("/home/u/.rocky");
        let want = home.join("desk").join("rockyd.sock");
        assert_eq!(socket_path_from(home, None), want);
        assert_eq!(socket_path_from(home, Some(OsStr::new(""))), want);
        assert_eq!(socket_path_from(home, Some(OsStr::new("run/user"))), want);
    }

    #[test]
    fn locks_sit_beside_the_socket_with_the_hash() {
        let home = Path::new("/home/u/.rocky");
        let xdg = Some(OsStr::new("/run/user/1000"));
        let h = home_hash(home);
        assert_eq!(
            daemon_lock_path_from(home, xdg),
            Path::new("/run/user/1000").join(format!("rockyd-{h}.lock"))
        );
        assert_eq!(
            desk_lock_path_from(home, None),
            home.join("desk").join(format!("rocky-desk-{h}.lock"))
        );
    }
}
