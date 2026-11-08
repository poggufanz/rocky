//! Sign-in autostart through the per-user Run key, and the `--tray` flag.
//!
//! Windows runs the stored command at sign-in. The value names this exe
//! quoted, with `--tray`, so the desk starts hidden with only its tray icon.
//! The pure helpers stay cross-platform; only the registry access is Windows.

use std::path::Path;

pub const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
pub const RUN_VALUE: &str = "rocky-desk";

/// The command Windows runs at sign-in. Quoted: the install path may hold spaces.
pub fn run_command(exe: &Path) -> String {
    format!("\"{}\" --tray", exe.display())
}

/// Whether the registered value starts the exe at `exe`'s current location.
///
/// A moved or renamed exe reads as disabled, so the settings can offer to
/// re-enable it. Windows paths compare case-insensitively; surrounding
/// whitespace is ignored.
pub fn is_enabled(registered: Option<&str>, exe: &Path) -> bool {
    registered.is_some_and(|value| value.trim().eq_ignore_ascii_case(&run_command(exe)))
}

#[cfg(windows)]
pub fn state_at(subkey: &str, exe: &Path) -> std::io::Result<bool> {
    let registered = crate::winreg::get_string(subkey, RUN_VALUE)?;
    Ok(is_enabled(registered.as_deref(), exe))
}

#[cfg(windows)]
pub fn enable_at(subkey: &str, exe: &Path) -> std::io::Result<()> {
    crate::winreg::set_string(subkey, RUN_VALUE, &run_command(exe))
}

#[cfg(windows)]
pub fn disable_at(subkey: &str) -> std::io::Result<()> {
    crate::winreg::delete_value(subkey, RUN_VALUE)
}

/// Autostart state for the real Run key.
#[cfg(windows)]
pub fn state(exe: &Path) -> std::io::Result<bool> {
    state_at(RUN_KEY, exe)
}

/// Register this exe for sign-in in the real Run key.
#[cfg(windows)]
pub fn enable(exe: &Path) -> std::io::Result<()> {
    enable_at(RUN_KEY, exe)
}

/// Remove the sign-in registration from the real Run key.
#[cfg(windows)]
pub fn disable() -> std::io::Result<()> {
    disable_at(RUN_KEY)
}

/// Startup switches for the desk.
pub struct RunOptions {
    pub tray: bool,
}

/// `--tray` starts the desk with its window hidden. Unknown arguments are ignored.
pub fn parse_args(args: impl IntoIterator<Item = String>) -> RunOptions {
    let mut tray = false;
    for arg in args {
        if arg == "--tray" {
            tray = true;
        }
    }
    RunOptions { tray }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_command_quotes_paths_with_spaces() {
        assert_eq!(
            run_command(Path::new(r"C:\Program Files\rocky\rocky-desk.exe")),
            r#""C:\Program Files\rocky\rocky-desk.exe" --tray"#
        );
    }

    #[test]
    fn moved_exe_reads_as_disabled() {
        let exe = Path::new(r"C:\new\rocky-desk.exe");
        assert!(!is_enabled(Some(r#""C:\old\rocky-desk.exe" --tray"#), exe));
        assert!(is_enabled(Some(r#""c:\NEW\rocky-desk.exe" --tray"#), exe));
        assert!(!is_enabled(None, exe));
    }

    #[cfg(windows)]
    #[test]
    fn enable_disable_roundtrip_in_scratch_key() {
        // state_at false; enable_at(exe) → state_at true and the stored value == run_command(exe);
        // enable_at(other) rewrites the value; disable_at → false; disable_at twice is Ok
        let key = crate::winreg::scratch_key();
        let exe = Path::new(r"C:\Program Files\rocky\rocky-desk.exe");
        let other = Path::new(r"C:\other\rocky-desk.exe");

        assert!(!state_at(key.path(), exe).unwrap());

        enable_at(key.path(), exe).unwrap();
        assert!(state_at(key.path(), exe).unwrap());
        assert_eq!(
            crate::winreg::get_string(key.path(), RUN_VALUE)
                .unwrap()
                .as_deref(),
            Some(run_command(exe).as_str())
        );

        enable_at(key.path(), other).unwrap();
        assert!(state_at(key.path(), other).unwrap());
        assert!(!state_at(key.path(), exe).unwrap());
        assert_eq!(
            crate::winreg::get_string(key.path(), RUN_VALUE)
                .unwrap()
                .as_deref(),
            Some(run_command(other).as_str())
        );

        disable_at(key.path()).unwrap();
        assert!(!state_at(key.path(), other).unwrap());

        disable_at(key.path()).unwrap();
    }

    #[test]
    fn tray_flag_parses() {
        assert!(parse_args(["rocky-desk".into(), "--tray".into()]).tray);
        assert!(!parse_args(["rocky-desk".into()]).tray);
    }
}
