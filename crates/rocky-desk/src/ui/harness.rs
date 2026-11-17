//! Harness identity: which agent tool a session runs in, and its icon.

use gpui::prelude::*;
use gpui::{AnyElement, Div, FontWeight, Pixels, div, px, rgb, svg};
use rocky_proto::pipe::Status;

use crate::ui::status::{dot_el, status_dot_color};
use crate::ui::tooltip::{BORDER_LIGHT, TEXT_DARK, TEXT_MUTED};

const CLAUDE_COLOR: u32 = 0xD97757;
const BADGE_BOX: f32 = 22.0;
const BADGE_DOT: f32 = 9.0;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HarnessKind {
    ClaudeCode,
    Codex,
    Other(String),
}

impl HarnessKind {
    pub fn from_id(id: Option<&str>) -> HarnessKind {
        match id {
            Some("claude-code") => HarnessKind::ClaudeCode,
            Some("codex") => HarnessKind::Codex,
            other => HarnessKind::Other(other.unwrap_or_default().to_string()),
        }
    }

    pub fn display_name(&self) -> String {
        match self {
            HarnessKind::ClaudeCode => "Claude Code".to_string(),
            HarnessKind::Codex => "Codex".to_string(),
            HarnessKind::Other(id) if id.is_empty() => "Agent".to_string(),
            HarnessKind::Other(id) => id.clone(),
        }
    }
}

/// The harness mark at `size`. Known harnesses draw an SVG mask; others a letter circle.
pub fn harness_icon(kind: &HarnessKind, size: Pixels) -> AnyElement {
    match kind {
        HarnessKind::ClaudeCode => svg()
            .path("icons/claude.svg")
            .size(size)
            .flex_shrink_0()
            .text_color(rgb(CLAUDE_COLOR))
            .into_any_element(),
        HarnessKind::Codex => svg()
            .path("icons/codex.svg")
            .size(size)
            .flex_shrink_0()
            .text_color(rgb(TEXT_DARK))
            .into_any_element(),
        HarnessKind::Other(id) => {
            let letter = id
                .chars()
                .next()
                .map(|c| c.to_uppercase().to_string())
                .unwrap_or_else(|| "A".to_string());
            div()
                .size(size)
                .flex_shrink_0()
                .flex()
                .items_center()
                .justify_center()
                .rounded_full()
                .border_1()
                .border_color(rgb(BORDER_LIGHT))
                .text_color(rgb(TEXT_MUTED))
                .text_size(size * 0.55)
                .font_weight(FontWeight::SEMIBOLD)
                .child(letter)
                .into_any_element()
        }
    }
}

/// A 22 px box holding the harness icon with a status dot at its corner.
pub fn session_badge(kind: &HarnessKind, status: Status, size: Pixels) -> Div {
    div()
        .relative()
        .size(px(BADGE_BOX))
        .flex_shrink_0()
        .flex()
        .items_center()
        .justify_center()
        .child(harness_icon(kind, size))
        .child(
            dot_el(status_dot_color(status))
                .absolute()
                .bottom_0()
                .right_0()
                .size(px(BADGE_DOT)),
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn harness_kind_maps_ids_and_names() {
        assert_eq!(
            HarnessKind::from_id(Some("claude-code")),
            HarnessKind::ClaudeCode
        );
        assert_eq!(HarnessKind::from_id(Some("codex")), HarnessKind::Codex);
        assert_eq!(
            HarnessKind::from_id(Some("opencode")),
            HarnessKind::Other("opencode".into())
        );
        assert_eq!(HarnessKind::from_id(None).display_name(), "Agent");
        assert_eq!(HarnessKind::ClaudeCode.display_name(), "Claude Code");
        assert_eq!(HarnessKind::Codex.display_name(), "Codex");
        assert_eq!(
            HarnessKind::from_id(Some("opencode")).display_name(),
            "opencode"
        );
    }
}
