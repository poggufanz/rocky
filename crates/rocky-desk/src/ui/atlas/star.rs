//! The star mark shared by the Sky chart and the Constellation, and the
//! legend swatches that explain it.

use gpui::prelude::*;
use gpui::{Div, FontWeight, div, px, rgb};

use crate::atlas_model::sky::StarKind;
use crate::i18n::{AtlasMsg, UiLang, atlas_text};
use crate::ui::tooltip::{
    CARD_BG, STATUS_FAILED, STATUS_NEEDS_YOU, STATUS_WORKING, TEXT_DARK, TEXT_MUTED,
};

/// Room around a star's disc for its halo and selection ring.
const STAR_MARGIN: f32 = 8.0;
const FAILED_RING_W: f32 = 1.7;
const LIVE_RING_W: f32 = 1.6;
/// How far outside the disc a live star's ring sits.
const LIVE_RING_GAP: f32 = 4.0;
/// How far outside the disc the selection ring sits.
const SELECT_RING_GAP: f32 = 6.0;
const SELECT_RING_W: f32 = 1.2;
const CROSS_BAR_H: f32 = 1.5;
const LEGEND_SMALL: f32 = 2.5;
const LEGEND_MEDIUM: f32 = 3.7;
const LEGEND_LARGE: f32 = 6.0;
const LEGEND_FAILED: f32 = 4.5;

/// Side of the square box a star of `radius` occupies, so every kind of star
/// has the same hit box logic.
pub(crate) fn star_box(radius: f32) -> f32 {
    2.0 * (radius + STAR_MARGIN)
}

/// A circle centered in a `side` box, `diameter` across.
fn centered(side: f32, diameter: f32) -> Div {
    let offset = (side - diameter) / 2.0;
    div()
        .absolute()
        .left(px(offset))
        .top(px(offset))
        .size(px(diameter))
        .rounded_full()
}

/// A ring of `diameter` with a `width` border and no fill.
fn ring(side: f32, diameter: f32, width: f32, color: u32) -> Div {
    centered(side, diameter)
        .border(px(width))
        .border_color(rgb(color))
}

/// The failed star's disc: white with a red ring.
pub(crate) fn failed_disc(side: f32, radius: f32) -> Div {
    centered(side, 2.0 * radius)
        .bg(rgb(CARD_BG))
        .border(px(FAILED_RING_W))
        .border_color(rgb(STATUS_FAILED))
}

/// A thin bar of the failed star's cross, centered in the `side` box.
fn cross_bar(side: f32, radius: f32, horizontal: bool) -> Div {
    let length = radius;
    let (w, h) = if horizontal {
        (length, CROSS_BAR_H)
    } else {
        (CROSS_BAR_H, length)
    };
    div()
        .absolute()
        .left(px((side - w) / 2.0))
        .top(px((side - h) / 2.0))
        .w(px(w))
        .h(px(h))
        .bg(rgb(STATUS_FAILED))
}

/// The dashed ring that marks the selected star.
pub(crate) fn selection_ring(side: f32, radius: f32) -> Div {
    centered(side, 2.0 * (radius + SELECT_RING_GAP))
        .border(px(SELECT_RING_W))
        .border_dashed()
        .border_color(rgb(TEXT_DARK))
}

/// A live star: a filled dot inside a ring.
fn live(el: Div, side: f32, radius: f32, color: u32) -> Div {
    el.child(centered(side, 2.0 * radius).bg(rgb(color)))
        .child(ring(
            side,
            2.0 * (radius + LIVE_RING_GAP),
            LIVE_RING_W,
            color,
        ))
}

/// One star's visual: a square box with the shape centered. Click handling
/// and placement belong to the caller.
pub(crate) fn star(kind: StarKind, radius: f32, selected: bool) -> Div {
    let side = star_box(radius);
    let mut el = div().relative().flex_none().size(px(side));
    el = match kind {
        StarKind::Plain => el.child(centered(side, 2.0 * radius).bg(rgb(TEXT_DARK))),
        StarKind::Failed => el
            .child(failed_disc(side, radius))
            .child(cross_bar(side, radius, true))
            .child(cross_bar(side, radius, false)),
        StarKind::Running => live(el, side, radius, STATUS_WORKING),
        StarKind::Waiting => live(el, side, radius, STATUS_NEEDS_YOU),
    };
    if selected {
        el = el.child(selection_ring(side, radius));
    }
    el
}

fn legend_item(swatch: Div, text: String) -> Div {
    div()
        .flex()
        .items_center()
        .gap(px(4.0))
        .child(swatch)
        .child(div().whitespace_nowrap().child(text))
}

fn size_swatches() -> Div {
    let dots = [LEGEND_SMALL, LEGEND_MEDIUM, LEGEND_LARGE]
        .into_iter()
        .map(|r| star(StarKind::Plain, r, false));
    div().flex().items_center().children(dots)
}

/// Legend for star size, failed, and running, as one wrapping row.
pub(crate) fn legend_swatches(lang: UiLang) -> Div {
    div()
        .flex()
        .flex_wrap()
        .items_center()
        .gap_x(px(14.0))
        .text_size(px(11.5))
        .text_color(rgb(TEXT_MUTED))
        .child(legend_item(
            size_swatches(),
            atlas_text(lang, &AtlasMsg::LegendSize),
        ))
        .child(legend_item(
            star(StarKind::Failed, LEGEND_FAILED, false),
            atlas_text(lang, &AtlasMsg::LegendFailed),
        ))
        .child(legend_item(
            star(StarKind::Running, LEGEND_FAILED, false),
            atlas_text(lang, &AtlasMsg::LegendRunning),
        ))
}

/// Bold mono text used beside a star: failed in red, live in blue.
pub(crate) fn star_caption(text: String, color: u32) -> Div {
    div()
        .whitespace_nowrap()
        .font_family(crate::ui::tooltip::mono_font())
        .text_size(px(11.0))
        .font_weight(FontWeight::BOLD)
        .text_color(rgb(color))
        .child(text)
}

#[cfg(test)]
mod tests {
    use gpui::{BorderStyle, Fill, Hsla, Styled, rgb};

    use super::{failed_disc, selection_ring, star, star_box};
    use crate::atlas_model::sky::StarKind;
    use crate::ui::tooltip::{CARD_BG, STATUS_FAILED, TEXT_DARK};

    #[test]
    fn failed_star_has_red_ring() {
        let mut disc = failed_disc(star_box(4.5), 4.5);
        let style = disc.style();
        assert_eq!(style.border_color, Some(Hsla::from(rgb(STATUS_FAILED))));
        assert_eq!(style.background, Some(Fill::from(Hsla::from(rgb(CARD_BG)))));
    }

    #[test]
    fn selected_star_gets_dashed_ring() {
        let mut ring = selection_ring(star_box(4.5), 4.5);
        let style = ring.style();
        assert_eq!(style.border_style, Some(BorderStyle::Dashed));
        assert_eq!(style.border_color, Some(Hsla::from(rgb(TEXT_DARK))));
    }

    #[test]
    fn every_kind_shares_one_square_box() {
        for kind in [
            StarKind::Plain,
            StarKind::Failed,
            StarKind::Running,
            StarKind::Waiting,
        ] {
            let mut el = star(kind, 3.7, true);
            let size = el.style().size.clone();
            assert_eq!(size.width, size.height, "{kind:?}");
        }
    }
}
