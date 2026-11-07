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

pub fn tool_text_off_marker(rocky_home: &Path) -> PathBuf {
    desk_dir(rocky_home).join("tool-text-off")
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

#[cfg(test)]
mod tests {
    use std::ffi::OsStr;
    use std::path::{Path, PathBuf};

    use super::{
        absolutize, bad_dir, desk_mutex_name, home_hash, log_path, pipe_name, rocky_home_from,
        spool_dir, tool_text_off_marker,
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
            PathBuf::from(r"C:\Users\a\.rocky")
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
        assert_eq!(spool_dir(p), PathBuf::from(r"C:\h\desk\spool"));
        assert_eq!(bad_dir(p), PathBuf::from(r"C:\h\desk\spool\bad"));
        assert_eq!(log_path(p), PathBuf::from(r"C:\h\desk\rockyd.log"));
        assert_eq!(
            tool_text_off_marker(p),
            PathBuf::from(r"C:\h\desk\tool-text-off")
        );
    }
}
