//! OS notifications behind one desk type: Windows toasts and freedesktop
//! notifications on the session bus.

use std::io;
use std::path::{Path, PathBuf};

#[cfg(windows)]
use std::collections::BTreeMap;
#[cfg(target_os = "linux")]
use std::collections::HashMap;
#[cfg(target_os = "linux")]
use std::sync::mpsc::{self, Receiver, Sender};

#[cfg(windows)]
use crate::toast::ToastHandle;
#[cfg(target_os = "linux")]
use zbus::Connection;
#[cfg(target_os = "linux")]
use zbus::Variant;

/// Desk notifications, one backend per platform.
pub struct OsNotices {
    rocky_home: PathBuf,
    #[cfg(windows)]
    toasts: BTreeMap<String, ToastHandle>,
    #[cfg(target_os = "linux")]
    notifier: FreedesktopNotifier,
    #[cfg(target_os = "linux")]
    errors: Receiver<io::Error>,
}

impl OsNotices {
    pub fn new(rocky_home: &Path) -> OsNotices {
        #[cfg(target_os = "linux")]
        let (notifier, errors) = {
            let (tx, errors) = mpsc::channel();
            (
                FreedesktopNotifier::spawn(png_icon_path(rocky_home), tx),
                errors,
            )
        };
        OsNotices {
            rocky_home: rocky_home.to_path_buf(),
            #[cfg(windows)]
            toasts: BTreeMap::new(),
            #[cfg(target_os = "linux")]
            notifier,
            #[cfg(target_os = "linux")]
            errors,
        }
    }

    /// Register the platform identity the notifications need. Safe to call
    /// more than once.
    pub fn prepare(&mut self) -> io::Result<()> {
        #[cfg(windows)]
        {
            let icon = crate::toast::ensure_icon_file(&self.rocky_home)?;
            crate::toast::register_aumid("rocky", Some(&icon))
        }
        #[cfg(target_os = "linux")]
        {
            ensure_png_icon(&self.rocky_home).map(|_| ())
        }
        #[cfg(not(any(windows, target_os = "linux")))]
        {
            let _ = &self.rocky_home;
            Err(unsupported())
        }
    }

    /// Queue one notice. Windows keeps the latest toast per session tag so a
    /// late click still reaches its handler; the freedesktop worker replaces
    /// the previous notice from the same session.
    pub fn show(
        &mut self,
        session_id: &str,
        title: &str,
        body: &str,
        on_click: Box<dyn Fn() + Send + Sync>,
    ) -> io::Result<()> {
        #[cfg(windows)]
        {
            let tag = crate::notify::toast_tag(session_id);
            let toast =
                crate::toast::show_toast(title, body, &tag, on_click).map_err(io::Error::other)?;
            self.toasts.insert(tag, toast);
            Ok(())
        }
        #[cfg(target_os = "linux")]
        {
            // The freedesktop notice has no click action.
            let _ = on_click;
            self.notifier.notify(session_id, title, body)
        }
        #[cfg(not(any(windows, target_os = "linux")))]
        {
            let _ = (session_id, title, body, on_click);
            Err(unsupported())
        }
    }

    /// Errors the platform backend hit since the last call. Windows reports a
    /// failed toast from `show` instead.
    pub fn drain_errors(&mut self) -> Vec<io::Error> {
        #[cfg(windows)]
        {
            Vec::new()
        }
        #[cfg(target_os = "linux")]
        {
            self.errors.try_iter().collect()
        }
        #[cfg(not(any(windows, target_os = "linux")))]
        {
            Vec::new()
        }
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
fn unsupported() -> io::Error {
    io::Error::new(
        io::ErrorKind::Unsupported,
        "notifications are not implemented on this platform",
    )
}

/// Escape `&`, `<`, and `>` so repo and branch names show literally in a
/// freedesktop notification body.
pub fn escape_markup(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            _ => escaped.push(ch),
        }
    }
    escaped
}

/// Write `<rocky_home>/desk/rocky.png` from the embedded mark unless the file
/// on disk already holds exactly those bytes. Returns the path either way; the
/// bytes are the same whenever it returns `Ok`.
#[cfg(target_os = "linux")]
pub fn ensure_png_icon(rocky_home: &Path) -> io::Result<PathBuf> {
    const PNG: &[u8] = include_bytes!("../assets/rocky-mark.png");
    let path = png_icon_path(rocky_home);
    if std::fs::read(&path).is_ok_and(|found| found == PNG) {
        return Ok(path);
    }
    std::fs::create_dir_all(rocky_proto::paths::desk_dir(rocky_home))?;
    std::fs::write(&path, PNG)?;
    Ok(path)
}

#[cfg(target_os = "linux")]
fn png_icon_path(rocky_home: &Path) -> PathBuf {
    rocky_proto::paths::desk_dir(rocky_home).join("rocky.png")
}

/// Handle to the thread that owns the freedesktop connection.
#[cfg(target_os = "linux")]
struct FreedesktopNotifier {
    tx: Sender<Notice>,
}

/// One desk notice, queued for the worker thread.
#[cfg(target_os = "linux")]
struct Notice {
    session_id: String,
    title: String,
    body: String,
}

#[cfg(target_os = "linux")]
impl FreedesktopNotifier {
    fn spawn(icon: PathBuf, errors: Sender<io::Error>) -> Self {
        Self::spawn_with_address(icon, errors, None)
    }

    /// `address` picks the bus; `None` is the session bus. Tests point it at a
    /// dead socket so they never touch the process environment.
    fn spawn_with_address(
        icon: PathBuf,
        errors: Sender<io::Error>,
        address: Option<String>,
    ) -> Self {
        let (tx, notices) = mpsc::channel();
        std::thread::Builder::new()
            .name("rocky-notify".into())
            .spawn(move || run(notices, icon, errors, address))
            .expect("spawn the notification worker");
        Self { tx }
    }

    fn notify(&self, session_id: &str, title: &str, body: &str) -> io::Result<()> {
        self.tx
            .send(Notice {
                session_id: session_id.to_string(),
                title: title.to_string(),
                body: body.to_string(),
            })
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "notification worker stopped"))
    }
}

/// The worker lazily opens the bus on the first notice, sends every notice on
/// that connection, and reconnects after a failure without exiting.
#[cfg(target_os = "linux")]
fn run(
    notices: Receiver<Notice>,
    icon: PathBuf,
    errors: Sender<io::Error>,
    address: Option<String>,
) {
    let icon = icon.to_string_lossy().into_owned();
    let mut connection: Option<Connection> = None;
    let mut replaces: HashMap<String, u32> = HashMap::new();
    for notice in notices {
        if connection.is_none() {
            match connect(address.as_deref()) {
                Ok(open) => connection = Some(open),
                Err(error) => {
                    if errors.send(error).is_err() {
                        return;
                    }
                    continue;
                }
            }
        }
        let sent = match connection.as_ref() {
            Some(open) => post(open, &icon, &replaces, &notice),
            None => continue,
        };
        match sent {
            Ok(id) => {
                replaces.insert(notice.session_id, id);
            }
            Err(error) => {
                // Dropping the connection makes the next notice reconnect.
                connection = None;
                if errors.send(error).is_err() {
                    return;
                }
            }
        }
    }
}

#[cfg(target_os = "linux")]
fn connect(address: Option<&str>) -> io::Result<Connection> {
    let connected = match address {
        Some(address) => {
            zbus::block_on(async { zbus::connection::Builder::address(address).build().await })
        }
        None => zbus::block_on(Connection::session()),
    };
    connected.map_err(io::Error::other)
}

#[cfg(target_os = "linux")]
fn post(
    connection: &Connection,
    icon: &str,
    replaces: &HashMap<String, u32>,
    notice: &Notice,
) -> io::Result<u32> {
    let body = escape_markup(&notice.body);
    let replaces_id = replaces.get(&notice.session_id).copied().unwrap_or(0);
    zbus::block_on(async {
        let notifications = NotificationsProxy::new(connection).await?;
        notifications
            .notify(
                "rocky",
                replaces_id,
                icon,
                &notice.title,
                &body,
                &[],
                HashMap::new(),
                -1,
            )
            .await
    })
    .map_err(io::Error::other)
}

#[cfg(target_os = "linux")]
#[zbus::proxy(
    interface = "org.freedesktop.Notifications",
    default_service = "org.freedesktop.Notifications",
    default_path = "/org/freedesktop/Notifications"
)]
trait Notifications {
    #[allow(clippy::too_many_arguments)]
    fn notify(
        &self,
        app_name: &str,
        replaces_id: u32,
        app_icon: &str,
        summary: &str,
        body: &str,
        actions: &[&str],
        hints: HashMap<&str, Variant<'_>>,
        expire_timeout: i32,
    ) -> zbus::Result<u32>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn body_markup_is_escaped() {
        assert_eq!(escape_markup("a <b> & c"), "a &lt;b&gt; &amp; c");
    }

    /// No session bus at the address: each notice reports the failure and the
    /// worker stays alive to try the next one.
    #[cfg(target_os = "linux")]
    #[test]
    fn worker_survives_a_missing_session_bus() {
        use std::sync::mpsc;
        use std::time::{Duration, Instant};

        fn wait_for_error(errors: &mpsc::Receiver<std::io::Error>) -> std::io::Error {
            let deadline = Instant::now() + Duration::from_secs(2);
            while Instant::now() < deadline {
                if let Ok(error) = errors.try_recv() {
                    return error;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            panic!("no notification error within 2 s");
        }

        let (tx, errors) = mpsc::channel();
        let notifier = FreedesktopNotifier::spawn_with_address(
            std::path::PathBuf::from("/nonexistent/rocky-test.png"),
            tx,
            Some("unix:path=/nonexistent/rocky-test-bus".into()),
        );

        notifier.notify("s1", "repo", "body").unwrap();
        wait_for_error(&errors);

        notifier.notify("s1", "repo", "body").unwrap();
        wait_for_error(&errors);
    }
}
