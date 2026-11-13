//! Desk settings: defaults and wire shape.

use serde::{Deserialize, Serialize};

pub const SETTINGS_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Lang {
    #[default]
    Auto,
    En,
    Id,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub v: u32,
    pub subagent_tree: bool,
    pub history: bool,
    pub tool_text: bool,
    pub cards: bool,
    pub notify_needs_you: bool,
    pub notify_failed: bool,
    pub notify_done: bool,
    pub lang: Lang,
    pub autostart_asked: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            v: SETTINGS_VERSION,
            subagent_tree: true,
            history: true,
            tool_text: true,
            cards: true,
            notify_needs_you: true,
            notify_failed: true,
            notify_done: true,
            lang: Lang::Auto,
            autostart_asked: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_settings_wire_matches_spec() {
        assert_eq!(
            serde_json::to_string(&Settings::default()).unwrap(),
            r#"{"v":1,"subagent_tree":true,"history":true,"tool_text":true,"cards":true,"notify_needs_you":true,"notify_failed":true,"notify_done":true,"lang":"auto","autostart_asked":false}"#
        );
    }

    #[test]
    fn missing_keys_take_defaults() {
        let s: Settings = serde_json::from_str(r#"{"history":false}"#).unwrap();
        assert_eq!(
            s,
            Settings {
                history: false,
                ..Settings::default()
            }
        );
    }
}
