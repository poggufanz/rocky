//! The desk settings file: load, save, `set` validation, and the tool-text
//! marker the hook side reads.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use rocky_proto::paths::tool_text_off_marker;
use rocky_proto::settings::{Lang, SETTINGS_VERSION, Settings};
use serde_json::Value;

/// What `load` found: settings to use, and whether the file was there but
/// unusable. An unreadable file is left byte-identical for a later `set`.
#[derive(Debug)]
pub struct Loaded {
    pub settings: Settings,
    pub unreadable: bool,
}

/// Reads the settings file. A missing file means defaults; any other read
/// error, parse error, wrong type, or unknown version means defaults with
/// `unreadable` set. Never writes.
pub fn load(path: &Path) -> Loaded {
    let broken = Loaded {
        settings: Settings::default(),
        unreadable: true,
    };
    match fs::read(path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Loaded {
            settings: Settings::default(),
            unreadable: false,
        },
        Err(_) => broken,
        Ok(bytes) => match serde_json::from_slice::<Settings>(&bytes) {
            Ok(s) if s.v == SETTINGS_VERSION => Loaded {
                settings: s,
                unreadable: false,
            },
            _ => broken,
        },
    }
}

/// Writes the settings file via a sibling `.tmp` and a rename, creating the
/// parent directory on first use.
pub fn save(path: &Path, s: &Settings) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut tmp = path.as_os_str().to_os_string();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    fs::write(&tmp, serde_json::to_vec(s).map_err(io::Error::other)?)?;
    fs::rename(&tmp, path)
}

/// Applies one `set` request, returning the new settings or the wire error
/// string. `v` is not settable.
pub fn apply_set(s: &Settings, name: &str, value: &Value) -> Result<Settings, &'static str> {
    let mut next = s.clone();
    let b = |v: &Value| v.as_bool().ok_or("invalid value");
    match name {
        "subagent_tree" => next.subagent_tree = b(value)?,
        "history" => next.history = b(value)?,
        "tool_text" => next.tool_text = b(value)?,
        "notify_needs_you" => next.notify_needs_you = b(value)?,
        "notify_failed" => next.notify_failed = b(value)?,
        "notify_done" => next.notify_done = b(value)?,
        "autostart_asked" => next.autostart_asked = b(value)?,
        "lang" => {
            next.lang =
                serde_json::from_value::<Lang>(value.clone()).map_err(|_| "invalid value")?
        }
        _ => return Err("unknown setting"),
    }
    Ok(next)
}

/// Keeps `<home>/desk/tool-text-off` in step with the setting: present while
/// tool text is off, absent otherwise. Removing a missing marker is fine.
pub fn sync_marker(home: &Path, tool_text: bool) -> io::Result<()> {
    let marker = tool_text_off_marker(home);
    if tool_text {
        match fs::remove_file(&marker) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        }
    } else {
        if let Some(parent) = marker.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&marker, [])
    }
}
