//! Sign-in autostart through the per-user Run key, and the `--tray` flag.
//!
//! Windows runs the stored command at sign-in. The value names this exe
//! quoted, with `--tray`, so the desk starts hidden with only its tray icon.
//! Task Manager's Startup apps page can turn the entry off without touching
//! the Run value: it writes a binary flag under `StartupApproved\Run`, and an
//! odd first byte means disabled. The desk reads that flag too, and turning
//! autostart on or off from the desk removes it.
//! The pure helpers stay cross-platform; only the registry access is Windows.

use std::path::Path;

pub const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
pub const APPROVED_KEY: &str =
    r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
pub const RUN_VALUE: &str = "rocky-desk";

/// The command Windows runs at sign-in. Quoted: the install path may hold spaces.
pub fn run_command(exe: &Path) -> String {
    format!("\"{}\" --tray", exe.display())
}

/// Whether Windows will start the exe at `exe`'s current location.
///
/// A moved or renamed exe reads as disabled, so the settings can offer to
/// re-enable it. Windows paths compare case-insensitively; surrounding
/// whitespace is ignored. `approval` is the `StartupApproved\Run` flag:
/// absent or with an even first byte means allowed, an odd first byte means
/// the user turned the entry off in Task Manager.
pub fn is_enabled(registered: Option<&str>, approval: Option<&[u8]>, exe: &Path) -> bool {
    let allowed = approval
        .and_then(|bytes| bytes.first())
        .is_none_or(|flag| flag & 1 == 0);
    allowed && registered.is_some_and(|value| value.trim().eq_ignore_ascii_case(&run_command(exe)))
}

#[cfg(windows)]
pub fn state_at(run_key: &str, approved_key: &str, exe: &Path) -> std::io::Result<bool> {
    let registered = crate::winreg::get_string(run_key, RUN_VALUE)?;
    let approval = crate::winreg::get_binary(approved_key, RUN_VALUE)?;
    Ok(is_enabled(registered.as_deref(), approval.as_deref(), exe))
}

/// Write the Run value and drop any Task Manager "disabled" flag, so the
/// desk's switch wins over an older choice made there.
#[cfg(windows)]
pub fn enable_at(run_key: &str, approved_key: &str, exe: &Path) -> std::io::Result<()> {
    crate::winreg::set_string(run_key, RUN_VALUE, &run_command(exe))?;
    crate::winreg::delete_value(approved_key, RUN_VALUE)
}

#[cfg(windows)]
pub fn disable_at(run_key: &str, approved_key: &str) -> std::io::Result<()> {
    crate::winreg::delete_value(run_key, RUN_VALUE)?;
    crate::winreg::delete_value(approved_key, RUN_VALUE)
}

/// Autostart state for the real Run key.
#[cfg(windows)]
pub fn state(exe: &Path) -> std::io::Result<bool> {
    state_at(RUN_KEY, APPROVED_KEY, exe)
}

/// Register this exe for sign-in in the real Run key.
#[cfg(windows)]
pub fn enable(exe: &Path) -> std::io::Result<()> {
    enable_at(RUN_KEY, APPROVED_KEY, exe)
}

/// Remove the sign-in registration from the real Run key.
#[cfg(windows)]
pub fn disable() -> std::io::Result<()> {
    disable_at(RUN_KEY, APPROVED_KEY)
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
        assert!(!is_enabled(
            Some(r#""C:\old\rocky-desk.exe" --tray"#),
            None,
            exe
        ));
        assert!(is_enabled(
            Some(r#""c:\NEW\rocky-desk.exe" --tray"#),
            None,
            exe
        ));
        assert!(!is_enabled(None, None, exe));
    }

    #[test]
    fn task_manager_disable_reads_as_disabled() {
        let exe = Path::new(r"C:\rocky\rocky-desk.exe");
        let run = run_command(exe);
        let run = Some(run.as_str());
        assert!(!is_enabled(run, Some(&[3, 0, 0, 0]), exe));
        assert!(!is_enabled(run, Some(&[7]), exe));
        assert!(is_enabled(run, Some(&[2, 0, 0, 0]), exe));
        assert!(is_enabled(run, Some(&[6]), exe));
        assert!(is_enabled(run, Some(&[]), exe));
        assert!(!is_enabled(None, Some(&[2]), exe));
    }

    /// Separate Run and StartupApproved stand-ins under one scratch key, which
    /// removes both on drop. They must differ: both hold a `rocky-desk` value.
    #[cfg(windows)]
    fn scratch_pair(key: &crate::winreg::ScratchKey) -> (String, String) {
        (
            format!(r"{}\Run", key.path()),
            format!(r"{}\Approved", key.path()),
        )
    }

    #[cfg(windows)]
    #[test]
    fn enable_disable_roundtrip_in_scratch_key() {
        // state_at false; enable_at(exe) → state_at true and the stored value == run_command(exe);
        // enable_at(other) rewrites the value; disable_at → false; disable_at twice is Ok
        let key = crate::winreg::scratch_key();
        let (run, approved) = scratch_pair(&key);
        let (run, approved) = (run.as_str(), approved.as_str());
        let exe = Path::new(r"C:\Program Files\rocky\rocky-desk.exe");
        let other = Path::new(r"C:\other\rocky-desk.exe");

        assert!(!state_at(run, approved, exe).unwrap());

        enable_at(run, approved, exe).unwrap();
        assert!(state_at(run, approved, exe).unwrap());
        assert_eq!(
            crate::winreg::get_string(run, RUN_VALUE)
                .unwrap()
                .as_deref(),
            Some(run_command(exe).as_str())
        );

        enable_at(run, approved, other).unwrap();
        assert!(state_at(run, approved, other).unwrap());
        assert!(!state_at(run, approved, exe).unwrap());
        assert_eq!(
            crate::winreg::get_string(run, RUN_VALUE)
                .unwrap()
                .as_deref(),
            Some(run_command(other).as_str())
        );

        disable_at(run, approved).unwrap();
        assert!(!state_at(run, approved, other).unwrap());

        disable_at(run, approved).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn desk_switch_overrides_task_manager_disable_in_scratch_keys() {
        let key = crate::winreg::scratch_key();
        let (run, approved) = scratch_pair(&key);
        let (run, approved) = (run.as_str(), approved.as_str());
        let exe = Path::new(r"C:\rocky\rocky-desk.exe");
        let disabled = [3u8, 0, 0, 0, 0xF7, 0xEE, 0x13, 0x42, 0x60, 0x6F, 0xDD, 0x01];

        enable_at(run, approved, exe).unwrap();
        crate::winreg::set_binary(approved, RUN_VALUE, &disabled).unwrap();
        assert!(
            !state_at(run, approved, exe).unwrap(),
            "a Task Manager disable must show the switch off"
        );

        enable_at(run, approved, exe).unwrap();
        assert_eq!(
            crate::winreg::get_binary(approved, RUN_VALUE).unwrap(),
            None
        );
        assert!(state_at(run, approved, exe).unwrap());

        crate::winreg::set_binary(approved, RUN_VALUE, &disabled).unwrap();
        disable_at(run, approved).unwrap();
        assert_eq!(crate::winreg::get_string(run, RUN_VALUE).unwrap(), None);
        assert_eq!(
            crate::winreg::get_binary(approved, RUN_VALUE).unwrap(),
            None
        );
    }

    #[test]
    fn tray_flag_parses() {
        assert!(parse_args(["rocky-desk".into(), "--tray".into()]).tray);
        assert!(!parse_args(["rocky-desk".into()]).tray);
    }
}
