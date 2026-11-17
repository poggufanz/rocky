//! Embedded asset source: the harness icons the desk draws with `svg()`.

use std::borrow::Cow;

use gpui::{AssetSource, SharedString};

const CLAUDE_SVG: &[u8] = include_bytes!("../assets/icons/claude.svg");
const CODEX_SVG: &[u8] = include_bytes!("../assets/icons/codex.svg");

const ICON_PATHS: [&str; 2] = ["icons/claude.svg", "icons/codex.svg"];

/// Serves the SVG icons compiled into the desk binary.
pub struct DeskAssets;

impl AssetSource for DeskAssets {
    fn load(&self, path: &str) -> gpui::Result<Option<Cow<'static, [u8]>>> {
        Ok(match path {
            "icons/claude.svg" => Some(Cow::Borrowed(CLAUDE_SVG)),
            "icons/codex.svg" => Some(Cow::Borrowed(CODEX_SVG)),
            _ => None,
        })
    }

    fn list(&self, path: &str) -> gpui::Result<Vec<SharedString>> {
        let prefix = path.trim_end_matches('/');
        Ok(ICON_PATHS
            .iter()
            .filter(|icon| icon.starts_with(prefix))
            .map(|icon| SharedString::from(*icon))
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desk_assets_serve_both_harness_icons() {
        for path in ["icons/claude.svg", "icons/codex.svg"] {
            let bytes = DeskAssets.load(path).unwrap().expect(path);
            assert!(std::str::from_utf8(&bytes).unwrap().contains("<svg"));
        }
        assert!(DeskAssets.load("icons/missing.svg").unwrap().is_none());
        assert_eq!(DeskAssets.list("icons").unwrap().len(), 2);
    }
}
