//! GPUI tooltip view and shared monospace font / snippet line helpers.

use gpui::prelude::*;
use gpui::{AnyView, App, Context, Div, SharedString, Stateful, Window, div, px, rgb};

use crate::cards_model::TooltipLine;

pub(crate) const TEXT_DARK: u32 = 0x1C1C1C;
pub(crate) const TEXT_MUTED: u32 = 0x6B6B6B;
pub(crate) const TEXT_DIM: u32 = 0x8A8A8A;
pub(crate) const CARD_BG: u32 = 0xFFFFFF;
pub(crate) const SURFACE_SUBTLE: u32 = 0xEDEDEC;
pub(crate) const BORDER_LIGHT: u32 = 0xD4D4D4;
pub(crate) const BORDER_SUBTLE: u32 = 0xE5E5E3;
pub(crate) const DIFF_ADD_BG: u32 = 0xEAF6ED;
pub(crate) const DIFF_ADD_FG: u32 = 0x166534;
pub(crate) const DIFF_DEL_BG: u32 = 0xFCEEEE;
pub(crate) const DIFF_DEL_FG: u32 = 0x991B1B;

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
        "monospace"
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
    label: String,
    handler: impl Fn(&mut T, &mut Window, &mut Context<T>) + 'static,
    cx: &mut Context<T>,
) -> Stateful<Div> {
    div()
        .id(SharedString::from(id))
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
        (DIFF_DEL_BG, DIFF_DEL_FG)
    } else {
        (SURFACE_SUBTLE, TEXT_MUTED)
    };
    div()
        .text_xs()
        .px_1()
        .rounded_sm()
        .whitespace_nowrap()
        .flex_shrink_0()
        .bg(rgb(bg))
        .text_color(rgb(fg))
        .child(text)
}
