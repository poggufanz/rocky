//! Settings view: wire helpers and controls for the desk settings panel.
//!
//! Changes travel to the daemon as `set` messages named exactly like the
//! settings file keys. The panel itself only reflects what the daemon
//! broadcasts back, so a rejected value never looks applied.

use gpui::prelude::*;
use gpui::{App, ClickEvent, IntoElement, SharedString, Window, div, px, rgb};
use rocky_proto::pipe::ClientMsg;
use rocky_proto::settings::{Lang, Settings};

use crate::i18n::Msg;

/// One boolean setting the panel can toggle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SettingId {
    SubagentTree,
    History,
    ToolText,
    NotifyNeedsYou,
    NotifyFailed,
    NotifyDone,
}

impl SettingId {
    pub const ALL: [SettingId; 6] = [
        SettingId::SubagentTree,
        SettingId::History,
        SettingId::ToolText,
        SettingId::NotifyNeedsYou,
        SettingId::NotifyFailed,
        SettingId::NotifyDone,
    ];

    /// Key in the settings file and the `set` message name.
    pub fn wire_name(self) -> &'static str {
        match self {
            SettingId::SubagentTree => "subagent_tree",
            SettingId::History => "history",
            SettingId::ToolText => "tool_text",
            SettingId::NotifyNeedsYou => "notify_needs_you",
            SettingId::NotifyFailed => "notify_failed",
            SettingId::NotifyDone => "notify_done",
        }
    }

    /// Current value in a settings snapshot.
    pub fn get(self, s: &Settings) -> bool {
        match self {
            SettingId::SubagentTree => s.subagent_tree,
            SettingId::History => s.history,
            SettingId::ToolText => s.tool_text,
            SettingId::NotifyNeedsYou => s.notify_needs_you,
            SettingId::NotifyFailed => s.notify_failed,
            SettingId::NotifyDone => s.notify_done,
        }
    }

    /// Row label in the settings catalog.
    pub fn label(self) -> Msg {
        match self {
            SettingId::SubagentTree => Msg::SettingSubagentTree,
            SettingId::History => Msg::SettingHistory,
            SettingId::ToolText => Msg::SettingToolText,
            SettingId::NotifyNeedsYou => Msg::SettingNotifyNeedsYou,
            SettingId::NotifyFailed => Msg::SettingNotifyFailed,
            SettingId::NotifyDone => Msg::SettingNotifyDone,
        }
    }
}

/// `set` message for one boolean setting.
pub fn set_bool(id: u64, setting: SettingId, value: bool) -> ClientMsg {
    ClientMsg::Set {
        id,
        name: setting.wire_name().to_string(),
        value: serde_json::json!(value),
    }
}

/// `set` message for the UI language.
pub fn set_lang(id: u64, lang: Lang) -> ClientMsg {
    let value = match lang {
        Lang::Auto => "auto",
        Lang::En => "en",
        Lang::Id => "id",
    };
    ClientMsg::Set {
        id,
        name: "lang".to_string(),
        value: serde_json::json!(value),
    }
}

/// `set` message marking the sign-in question answered.
pub fn set_autostart_asked(id: u64) -> ClientMsg {
    ClientMsg::Set {
        id,
        name: "autostart_asked".to_string(),
        value: serde_json::json!(true),
    }
}

/// The panels the window shows. The header button switches Agents and
/// Settings; the consent screen replaces the whole window until answered.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum View {
    #[default]
    Agents,
    Settings,
    Consent,
    /// Shown after Remove Rocky finished; closing it quits the desk.
    Removed,
}

/// The sign-in question shows on a window start until it has been answered.
/// A `--tray` start never shows it, and neither does a desk without settings.
pub fn show_autostart_banner(tray_start: bool, settings: Option<&Settings>) -> bool {
    !tray_start && settings.is_some_and(|s| !s.autostart_asked)
}

/// One boolean row: label and an on/off square, clickable while enabled.
pub fn toggle_row(
    id: SharedString,
    label: String,
    on: bool,
    enabled: bool,
    handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> impl IntoElement {
    let mut row = div()
        .id(id)
        .flex()
        .items_center()
        .gap_2()
        .text_sm()
        .child(div().w(px(12.)).h(px(12.)).rounded_sm().bg(if on {
            rgb(0x2BA044)
        } else {
            rgb(0xC4C4C4)
        }))
        .child(label);
    if enabled {
        row = row.cursor_pointer().on_click(handler);
    }
    row
}

/// One choice chip, highlighted while selected.
pub fn choice(
    id: SharedString,
    label: String,
    selected: bool,
    enabled: bool,
    handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> impl IntoElement {
    let mut chip = div()
        .id(id)
        .px_2()
        .rounded_sm()
        .text_sm()
        .bg(if selected {
            rgb(0xD4D4D4)
        } else {
            rgb(0xEDEDEC)
        })
        .child(label);
    if enabled {
        chip = chip.cursor_pointer().on_click(handler);
    }
    chip
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::view::{Conn, Model};
    use rocky_proto::pipe::{ClientMsg, Health, ServerMsg, Status};
    use rocky_proto::settings::{Lang, Settings};

    fn snapshot(settings: Settings) -> ServerMsg {
        ServerMsg::Snapshot {
            agents: Vec::new(),
            aggregate: Status::Idle,
            health: Health::default(),
            settings,
            repo_pending: Vec::new(),
        }
    }

    #[test]
    fn wire_names_match_settings_keys() {
        let v = serde_json::to_value(Settings::default()).unwrap();
        for s in SettingId::ALL {
            assert!(v.get(s.wire_name()).is_some(), "{}", s.wire_name());
        }
        assert!(v.get("lang").is_some() && v.get("autostart_asked").is_some());
    }

    #[test]
    fn set_messages_carry_wire_values() {
        assert_eq!(
            set_bool(3, SettingId::ToolText, false),
            ClientMsg::Set {
                id: 3,
                name: "tool_text".into(),
                value: serde_json::json!(false)
            }
        );
        assert_eq!(
            set_lang(4, Lang::Id),
            ClientMsg::Set {
                id: 4,
                name: "lang".into(),
                value: serde_json::json!("id")
            }
        );
    }

    #[test]
    fn failed_set_shows_error_until_next_settings() {
        let mut m = Model::new();
        m.set_sent(5);
        m.apply(ServerMsg::Ack {
            id: 5,
            ok: false,
            error: Some("invalid value".into()),
        });
        assert_eq!(m.set_error(), Some("invalid value"));
        m.apply(ServerMsg::Settings {
            settings: Settings::default(),
        });
        assert_eq!(m.set_error(), None);
    }

    #[test]
    fn ack_for_unsent_id_is_ignored() {
        let mut m = Model::new();
        m.apply(ServerMsg::Ack {
            id: 9,
            ok: false,
            error: Some("boom".into()),
        });
        assert_eq!(m.set_error(), None);
    }

    #[test]
    fn not_editable_until_connected_with_settings() {
        let mut m = Model::new();
        assert!(!m.editable());
        m.set_conn(Conn::Connected);
        assert!(!m.editable());
        m.apply(snapshot(Settings::default()));
        assert!(m.editable());
    }

    #[test]
    fn banner_only_on_window_start_until_answered() {
        let unanswered = Settings {
            autostart_asked: false,
            ..Settings::default()
        };
        let answered = Settings {
            autostart_asked: true,
            ..Settings::default()
        };
        assert!(show_autostart_banner(false, Some(&unanswered)));
        assert!(!show_autostart_banner(true, Some(&unanswered)));
        assert!(!show_autostart_banner(false, Some(&answered)));
        assert!(!show_autostart_banner(false, None));
    }
}
