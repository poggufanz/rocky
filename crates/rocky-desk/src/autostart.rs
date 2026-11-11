//! Sign-in autostart, and the `--tray` flag.
//!
//! Windows runs the stored command at sign-in. The value names this exe
//! quoted, with `--tray`, so the desk starts hidden with only its tray icon.
//! Task Manager's Startup apps page can turn the entry off without touching
//! the Run value: it writes a binary flag under `StartupApproved\Run`, and an
//! odd first byte means disabled. The desk reads that flag too, and turning
//! autostart on or off from the desk removes it.
//!
//! Linux uses the desktop's own autostart file,
//! `$XDG_CONFIG_HOME/autostart/rocky-desk.desktop` (or under `~/.config`),
//! which starts the same exe with `--tray`. Enabling rewrites the file whole,
//! so a `Hidden=true` left behind by a desktop environment is dropped. The
//! `Exec` line quotes the path and follows the Desktop Entry escaping, where a
//! backslash is escaped at both the quoting and the file level.
//!
//! The pure helpers stay cross-platform; the registry and file access do not.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

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

/// The `Exec` value that starts this exe with `--tray`.
///
/// The path is quoted because it may hold spaces. Inside the quotes `"`, `` ` ``
/// and `$` take one backslash, and `%` doubles as a field code. A backslash is
/// escaped at the quoting level and again at the string level, so it takes four.
pub fn desktop_exec(exe: &Path) -> String {
    let mut quoted = String::new();
    for ch in exe.to_string_lossy().chars() {
        match ch {
            '"' => quoted.push_str(r#"\""#),
            '`' => quoted.push_str(r"\`"),
            '$' => quoted.push_str(r"\$"),
            '\\' => quoted.push_str(r"\\\\"),
            '%' => quoted.push_str("%%"),
            _ => quoted.push(ch),
        }
    }
    format!("\"{quoted}\" --tray")
}

/// The whole autostart file, ending with a newline.
pub fn desktop_entry(exe: &Path) -> String {
    let exec = desktop_exec(exe);
    format!(
        "[Desktop Entry]\n\
         Type=Application\n\
         Name=rocky\n\
         Exec={exec}\n\
         X-GNOME-Autostart-enabled=true\n"
    )
}

/// Whether an autostart file's `[Desktop Entry]` group starts this exe.
///
/// A missing file reads as off. Keys and values compare case-sensitively, and
/// the group ends at the next `[group]` header, so another group cannot keep a
/// disabled entry alive.
pub fn desktop_enabled(content: Option<&str>, exe: &Path) -> bool {
    let Some(content) = content else {
        return false;
    };
    let want = desktop_exec(exe);
    let mut lines = content.lines().map(str::trim);
    if !lines.any(|line| line == "[Desktop Entry]") {
        return false;
    }
    let mut exec = None;
    let mut hidden = false;
    let mut switched_off = false;
    for line in lines {
        if line.starts_with('[') {
            break;
        }
        if let Some(value) = line.strip_prefix("Exec=") {
            exec = Some(value);
        } else if line == "Hidden=true" {
            hidden = true;
        } else if line == "X-GNOME-Autostart-enabled=false" {
            switched_off = true;
        }
    }
    exec == Some(want.as_str()) && !hidden && !switched_off
}

/// The autostart file for `home`: the XDG config home when that is a usable
/// path (non-empty and absolute), else `~/.config`.
pub fn autostart_file_from(xdg_config_home: Option<&OsStr>, home: &Path) -> PathBuf {
    match xdg_config_home.map(Path::new) {
        Some(dir) if dir.is_absolute() => dir.join("autostart/rocky-desk.desktop"),
        _ => home.join(".config/autostart/rocky-desk.desktop"),
    }
}

/// Autostart state from a `.desktop` file; a missing file reads as off.
#[cfg(target_os = "linux")]
pub fn state_in(file: &Path, exe: &Path) -> std::io::Result<bool> {
    match std::fs::read_to_string(file) {
        Ok(content) => Ok(desktop_enabled(Some(&content), exe)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

/// Write the autostart file whole, creating its directory.
#[cfg(target_os = "linux")]
pub fn enable_in(file: &Path, exe: &Path) -> std::io::Result<()> {
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(file, desktop_entry(exe))
}

/// Remove the autostart file; a missing file is not an error.
#[cfg(target_os = "linux")]
pub fn disable_in(file: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(file) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

/// The current user's autostart file.
#[cfg(target_os = "linux")]
fn autostart_file() -> std::io::Result<PathBuf> {
    let home = std::env::var_os("HOME")
        .filter(|home| !home.is_empty())
        .ok_or_else(|| std::io::Error::other("HOME is not set"))?;
    Ok(autostart_file_from(
        std::env::var_os("XDG_CONFIG_HOME").as_deref(),
        Path::new(&home),
    ))
}

/// Autostart state from the current user's autostart file.
#[cfg(target_os = "linux")]
pub fn state(exe: &Path) -> std::io::Result<bool> {
    state_in(&autostart_file()?, exe)
}

/// Write the current user's autostart file.
#[cfg(target_os = "linux")]
pub fn enable(exe: &Path) -> std::io::Result<()> {
    enable_in(&autostart_file()?, exe)
}

/// Remove the current user's autostart file.
#[cfg(target_os = "linux")]
pub fn disable() -> std::io::Result<()> {
    disable_in(&autostart_file()?)
}

#[cfg(all(unix, not(target_os = "linux")))]
fn unsupported<T>() -> std::io::Result<T> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "autostart is implemented for Windows and Linux only",
    ))
}

/// Autostart is not implemented on this platform.
#[cfg(all(unix, not(target_os = "linux")))]
pub fn state(_exe: &Path) -> std::io::Result<bool> {
    unsupported()
}

/// Autostart is not implemented on this platform.
#[cfg(all(unix, not(target_os = "linux")))]
pub fn enable(_exe: &Path) -> std::io::Result<()> {
    unsupported()
}

/// Autostart is not implemented on this platform.
#[cfg(all(unix, not(target_os = "linux")))]
pub fn disable() -> std::io::Result<()> {
    unsupported()
}

/// Startup switches for the desk.
pub struct RunOptions {
    pub tray: bool,
    /// Close a running desk and its daemon instead of starting one.
    pub quit: bool,
}

/// `--tray` starts the desk with its window hidden; `--quit` closes a running
/// desk and daemon. Unknown arguments are ignored.
pub fn parse_args(args: impl IntoIterator<Item = String>) -> RunOptions {
    let mut tray = false;
    let mut quit = false;
    for arg in args {
        match arg.as_str() {
            "--tray" => tray = true,
            "--quit" => quit = true,
            _ => {}
        }
    }
    RunOptions { tray, quit }
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

    #[test]
    fn parse_args_reads_quit() {
        let quit = parse_args(["rocky-desk".into(), "--quit".into()]);
        assert!(quit.quit);
        assert!(!quit.tray);
        let tray = parse_args(["rocky-desk".into(), "--tray".into()]);
        assert!(tray.tray);
        assert!(!tray.quit);
    }

    #[cfg(unix)]
    #[test]
    fn exec_line_escapes_reserved_characters() {
        assert_eq!(
            desktop_exec(Path::new("/opt/my apps/rocky-desk")),
            r#""/opt/my apps/rocky-desk" --tray"#
        );
        assert_eq!(
            desktop_exec(Path::new("/a$b/\"q\"/x%y")),
            r#""/a\$b/\"q\"/x%%y" --tray"#
        );
        assert_eq!(desktop_exec(Path::new(r"/a\b")), r#""/a\\\\b" --tray"#);
    }

    #[cfg(unix)]
    #[test]
    fn desktop_disable_marks_read_as_off() {
        let exe = Path::new("/opt/rocky/rocky-desk");
        let on = desktop_entry(exe);
        assert!(desktop_enabled(Some(&on), exe));
        assert!(!desktop_enabled(Some(&format!("{on}Hidden=true\n")), exe));
        assert!(!desktop_enabled(
            Some(&on.replace("enabled=true", "enabled=false")),
            exe
        ));
        assert!(!desktop_enabled(Some(&on), Path::new("/moved/rocky-desk")));
        assert!(!desktop_enabled(None, exe));
    }

    #[cfg(unix)]
    #[test]
    fn autostart_file_follows_xdg_config_home() {
        let home = Path::new("/home/u");
        assert_eq!(
            autostart_file_from(Some(OsStr::new("/cfg")), home),
            Path::new("/cfg/autostart/rocky-desk.desktop")
        );
        assert_eq!(
            autostart_file_from(None, home),
            home.join(".config/autostart/rocky-desk.desktop")
        );
        assert_eq!(
            autostart_file_from(Some(OsStr::new("rel")), home),
            home.join(".config/autostart/rocky-desk.desktop")
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn enable_overrides_a_hidden_entry_in_a_temp_dir() {
        let dir = tempfile::TempDir::new().unwrap();
        let file = dir.path().join("autostart/rocky-desk.desktop");
        let exe = Path::new("/opt/rocky/rocky-desk");

        enable_in(&file, exe).unwrap();
        assert!(state_in(&file, exe).unwrap());

        let mut content = std::fs::read_to_string(&file).unwrap();
        content.push_str("Hidden=true\n");
        std::fs::write(&file, content).unwrap();
        assert!(!state_in(&file, exe).unwrap());

        enable_in(&file, exe).unwrap();
        assert!(state_in(&file, exe).unwrap());

        disable_in(&file).unwrap();
        assert!(!file.exists());
    }
}
