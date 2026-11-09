//! Windows toast notifications and the XML body they carry.

use std::io;
use std::path::Path;

/// Application User Model ID under which Windows files desk notifications.
pub const AUMID: &str = "Rocky.Desk";

/// HKCU key holding the AUMID's display name and icon.
pub const AUMID_KEY: &str = r"Software\Classes\AppUserModelId\Rocky.Desk";

/// Toasts within one group replace each other instead of stacking.
#[cfg(windows)]
const GROUP: &str = "rocky";

/// Icon the AUMID points at, compiled into the exe.
const ICON: &[u8] = include_bytes!("../assets/rocky.ico");

/// Write `bytes` to `path` unless the file already holds exactly those bytes,
/// creating the parent directory when a write is needed. Returns the path
/// either way; the bytes are the same whenever it returns `Ok`.
pub(crate) fn write_if_different(
    path: std::path::PathBuf,
    bytes: &[u8],
) -> io::Result<std::path::PathBuf> {
    if std::fs::read(&path).is_ok_and(|found| found == bytes) {
        return Ok(path);
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, bytes)?;
    Ok(path)
}

/// Write `<rocky_home>/desk/rocky.ico` from the embedded asset unless the
/// file on disk already holds exactly those bytes. Returns the path either
/// way; the bytes are the same whenever it returns `Ok`.
pub fn ensure_icon_file(rocky_home: &Path) -> io::Result<std::path::PathBuf> {
    write_if_different(
        rocky_proto::paths::desk_dir(rocky_home).join("rocky.ico"),
        ICON,
    )
}

/// Keeps a shown toast and its `Activated` registration alive. Windows stops
/// delivering activation once the notification object is released, so the
/// desk holds the latest one per tag and drops older ones as they replace it.
#[cfg(windows)]
pub struct ToastHandle {
    _toast: windows::UI::Notifications::ToastNotification,
}

/// Build the toast XML for one event. Titles and bodies come from repo data,
/// so every XML metacharacter is escaped.
pub fn toast_xml(title: &str, body: &str) -> String {
    format!(
        "<toast><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual></toast>",
        escape(title),
        escape(body)
    )
}

fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(c),
        }
    }
    out
}

#[cfg(windows)]
pub fn register_aumid(display_name: &str, icon: Option<&Path>) -> io::Result<()> {
    crate::winreg::set_string(AUMID_KEY, "DisplayName", display_name)?;
    if let Some(icon) = icon {
        crate::winreg::set_string(AUMID_KEY, "IconUri", &icon.to_string_lossy())?;
    }
    Ok(())
}

#[cfg(windows)]
pub fn set_process_aumid() -> io::Result<()> {
    use windows_sys::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;

    let id = crate::winreg::wide(AUMID);
    let hr = unsafe { SetCurrentProcessExplicitAppUserModelID(id.as_ptr()) };
    if hr < 0 {
        // Not a Win32 code; keep the HRESULT visible.
        return Err(io::Error::other(format!(
            "SetCurrentProcessExplicitAppUserModelID failed: 0x{hr:08X}"
        )));
    }
    Ok(())
}

#[cfg(windows)]
pub fn notifier_setting() -> windows::core::Result<windows::UI::Notifications::NotificationSetting>
{
    use windows::UI::Notifications::ToastNotificationManager;
    use windows::core::HSTRING;

    ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(AUMID))?.Setting()
}

#[cfg(windows)]
pub fn show_toast(
    title: &str,
    body: &str,
    tag: &str,
    on_click: Box<dyn Fn() + Send>,
) -> windows::core::Result<ToastHandle> {
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::Foundation::TypedEventHandler;
    use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};
    use windows::core::{HSTRING, IInspectable};

    let xml = XmlDocument::new()?;
    xml.LoadXml(&HSTRING::from(toast_xml(title, body)))?;
    let toast = ToastNotification::CreateToastNotification(&xml)?;
    toast.SetTag(&HSTRING::from(tag))?;
    toast.SetGroup(&HSTRING::from(GROUP))?;
    toast.Activated(&TypedEventHandler::<ToastNotification, IInspectable>::new(
        move |_sender, _args| {
            on_click();
            Ok(())
        },
    ))?;
    // Not gated on `notifier_setting()`: it can read back stale or fail right
    // after registration, and `Show` reports the real error.
    ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(AUMID))?.Show(&toast)?;
    Ok(ToastHandle { _toast: toast })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn ensure_icon_file_writes_missing_replaces_stale_and_keeps_same() {
        let home = TempDir::new().unwrap();
        let expected = rocky_proto::paths::desk_dir(home.path()).join("rocky.ico");

        // Missing: written from the embedded asset.
        let path = ensure_icon_file(home.path()).unwrap();
        assert_eq!(path, expected);
        assert_eq!(
            std::fs::read(&path).unwrap(),
            include_bytes!("../assets/rocky.ico").as_slice()
        );

        // Different: replaced.
        std::fs::write(&path, b"stale").unwrap();
        assert_eq!(ensure_icon_file(home.path()).unwrap(), path);
        assert_eq!(
            std::fs::read(&path).unwrap(),
            include_bytes!("../assets/rocky.ico").as_slice()
        );

        // Same: left untouched. A read-only file would fail any rewrite, so a
        // successful call proves no write was attempted.
        let original = std::fs::metadata(&path).unwrap().permissions();
        let mut readonly = original.clone();
        readonly.set_readonly(true);
        std::fs::set_permissions(&path, readonly).unwrap();
        assert_eq!(ensure_icon_file(home.path()).unwrap(), path);
        std::fs::set_permissions(&path, original).unwrap();
    }

    #[test]
    fn toast_xml_escapes_markup() {
        let x = toast_xml("repo <a&b>", "Bash \"rm\" 'x'");
        assert!(x.starts_with("<toast>"));
        assert!(x.contains(r#"template="ToastGeneric""#));
        assert!(x.contains("repo &lt;a&amp;b&gt;"));
        assert!(x.contains("Bash &quot;rm&quot; &apos;x&apos;"));
    }
}
