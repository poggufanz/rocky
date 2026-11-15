//! GPUI tooltip view and shared monospace font / snippet line helpers.

use gpui::prelude::*;
use gpui::{AnyView, App, Context, Div, FontWeight, SharedString, Stateful, Window, div, px, rgb};

use crate::cards_model::TooltipLine;

pub(crate) const TEXT_DARK: u32 = 0x1C1917;
pub(crate) const TEXT_MUTED: u32 = 0x78716C;
pub(crate) const TEXT_DIM: u32 = 0xA8A29E;
pub(crate) const CARD_BG: u32 = 0xFFFFFF;
pub(crate) const SURFACE_SUBTLE: u32 = 0xF5F5F4;
pub(crate) const ROW_HOVER_BG: u32 = 0xFAFAF9;
pub(crate) const BORDER_LIGHT: u32 = 0xD6D3D1;
pub(crate) const BORDER_SUBTLE: u32 = 0xE7E5E4;
pub(crate) const CHIP_BG: u32 = 0xF0EFED;
pub(crate) const CHIP_FG: u32 = 0x44403C;
pub(crate) const CHIP_HIGH_BG: u32 = 0xFDE8E8;
pub(crate) const CHIP_HIGH_FG: u32 = 0xDC2626;
pub(crate) const DIFF_ADD_BG: u32 = 0xE8F6EC;
pub(crate) const DIFF_ADD_FG: u32 = 0x166534;
pub(crate) const DIFF_DEL_BG: u32 = 0xFDECEC;
pub(crate) const DIFF_DEL_FG: u32 = 0xB42318;
pub(crate) const LINK: u32 = 0x2563EB;
/// Success green token reserved for passed status indicators.
#[allow(dead_code)]
pub(crate) const OK: u32 = 0x16A34A;
pub(crate) const MATCH_BG: u32 = 0xEEF4FC;

/// Monospace family name for diffs, code snippets, symbols, and timeline numbers.
pub(crate) fn mono_font() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "Consolas"
    }
    #[cfg(target_os = "macos")]
    {
        "Menlo"
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        "DejaVu Sans Mono"
    }
}

/// Tooltip view rendering each [`TooltipLine`] on its own row with monospace commands.
pub struct CardTooltip {
    lines: Vec<TooltipLine>,
}

impl Render for CardTooltip {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        let mut out = div()
            .flex()
            .flex_col()
            .gap_1()
            .px_2()
            .py_1()
            .max_w(px(360.0))
            .rounded_sm()
            .bg(rgb(CARD_BG))
            .text_color(rgb(TEXT_DARK))
            .border_1()
            .border_color(rgb(BORDER_LIGHT))
            .shadow_sm();
        for line in &self.lines {
            let mut row = div().flex().flex_wrap().items_center().gap_1().text_xs();
            row = row.child(div().child(line.text.clone()));
            if let Some(code) = &line.code {
                row = row.child(
                    div()
                        .font_family(mono_font())
                        .bg(rgb(SURFACE_SUBTLE))
                        .px_1()
                        .rounded_sm()
                        .child(code.clone()),
                );
            }
            out = out.child(row);
        }
        out
    }
}

/// Builds a GPUI [`AnyView`] tooltip from [`TooltipLine`] entries.
pub fn tooltip_view(lines: Vec<TooltipLine>, _window: &mut Window, cx: &mut App) -> AnyView {
    cx.new(move |_| CardTooltip {
        lines: lines.clone(),
    })
    .into()
}

pub(crate) fn back_button<T: 'static>(
    id: &'static str,
    label: impl IntoElement,
    handler: impl Fn(&mut T, &mut Window, &mut Context<T>) + 'static,
    cx: &mut Context<T>,
) -> Stateful<Div> {
    div()
        .id(SharedString::from(id))
        .flex()
        .items_center()
        .min_w_0()
        .max_w_full()
        .text_xs()
        .font_weight(gpui::FontWeight::MEDIUM)
        .text_color(rgb(TEXT_MUTED))
        .hover(|s| s.text_color(rgb(TEXT_DARK)))
        .cursor_pointer()
        .child(label)
        .on_click(cx.listener(move |this, _, window, cx| handler(this, window, cx)))
}

pub(crate) fn chip_badge(text: String, high: bool) -> Div {
    let (bg, fg) = if high {
        (CHIP_HIGH_BG, CHIP_HIGH_FG)
    } else {
        (CHIP_BG, CHIP_FG)
    };
    let mut badge = div()
        .flex()
        .items_center()
        .gap(px(2.0))
        .text_size(px(10.5))
        .font_weight(FontWeight::SEMIBOLD)
        .py(px(2.0))
        .px(px(6.0))
        .rounded(px(4.0))
        .whitespace_nowrap()
        .flex_shrink_0()
        .bg(rgb(bg))
        .text_color(rgb(fg));
    if high {
        badge = badge.child(div().text_size(px(8.0)).child("\u{25b2}"));
    }
    badge.child(text)
}

/// Dim monospace sequence number shown at the start of edit rows and detail blocks.
pub(crate) fn seq_badge(seq: u32) -> Div {
    div()
        .text_xs()
        .font_family(mono_font())
        .text_color(rgb(TEXT_DIM))
        .whitespace_nowrap()
        .flex_shrink_0()
        .child(seq.to_string())
}
