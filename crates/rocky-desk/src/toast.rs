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
    on_click: Box<dyn Fn() + Send + Sync>,
) -> windows::core::Result<()> {
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
    ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(AUMID))?.Show(&toast)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn toast_xml_escapes_markup() {
        let x = toast_xml("repo <a&b>", "Bash \"rm\" 'x'");
        assert!(x.starts_with("<toast>"));
        assert!(x.contains(r#"template="ToastGeneric""#));
        assert!(x.contains("repo &lt;a&amp;b&gt;"));
        assert!(x.contains("Bash &quot;rm&quot; &apos;x&apos;"));
    }
}
