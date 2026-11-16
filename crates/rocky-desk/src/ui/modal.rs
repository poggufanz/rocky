//! A layer over the current page for one change card: a dimmed backdrop
//! that closes on click, and a panel that closes on Escape or its button.
//! The page underneath stays in place, so closing returns to the same scroll.

use gpui::prelude::*;
use gpui::{
    Context, FocusHandle, FontWeight, KeyDownEvent, SharedString, Stateful, Window, div, px,
    relative, rgb, rgba,
};

use crate::i18n::{CardMsg, UiLang, card_text};
use crate::ui::motion;
use crate::ui::title_bar::TITLE_BAR_H;
use crate::ui::tooltip::{
    BORDER_LIGHT, BORDER_SUBTLE, LINK, SURFACE_SUBTLE, TEXT_DARK, TEXT_SUBTLE,
};

/// Stone-900 at 35%: dims the page enough to read the panel as the top layer.
const SCRIM: u32 = 0x1C191759;
const CLOSE_HOVER_BG: u32 = 0xE7E5E4;

/// Called to close the modal.
pub type OnClose<T> = fn(&mut T, &mut Window, &mut Context<T>);

/// Wraps `body` in the backdrop and panel. `key` is the card id, so a new
/// card replays the entrance and the same card does not.
#[allow(clippy::too_many_arguments)]
pub fn card_modal<T: 'static>(
    lang: UiLang,
    key: &str,
    body: impl IntoElement,
    focus: &FocusHandle,
    cx: &mut Context<T>,
    on_close: OnClose<T>,
) -> Stateful<gpui::Div> {
    let backdrop = div()
        .id(SharedString::from("modal-backdrop"))
        .absolute()
        .top_0()
        .left_0()
        .size_full()
        .bg(rgba(SCRIM))
        .on_click(cx.listener(move |this, _, window, cx| on_close(this, window, cx)));

    let close = div()
        .id(SharedString::from("modal-close"))
        .tab_index(0)
        .flex_none()
        .px(px(10.0))
        .py(px(4.0))
        .rounded(px(6.0))
        .border_1()
        .border_color(gpui::transparent_black())
        .text_size(px(12.5))
        .font_weight(FontWeight::MEDIUM)
        .text_color(rgb(TEXT_SUBTLE))
        .cursor_pointer()
        .hover(|s| s.bg(rgb(CLOSE_HOVER_BG)).text_color(rgb(TEXT_DARK)))
        .focus(|s| s.border_color(rgb(LINK)))
        .on_click(cx.listener(move |this, _, window, cx| on_close(this, window, cx)))
        .child(card_text(lang, &CardMsg::CloseCard));

    let panel = div()
        .id(SharedString::from("modal-panel"))
        .track_focus(focus)
        .occlude()
        .relative()
        .flex()
        .flex_col()
        .w_full()
        .max_w(px(760.0))
        .max_h(relative(1.0))
        .bg(rgb(SURFACE_SUBTLE))
        .border_1()
        .border_color(rgb(BORDER_LIGHT))
        .rounded(px(10.0))
        // Elevation marks the one layer above the page; nothing else casts it.
        .shadow_lg()
        .overflow_hidden()
        .on_key_down(cx.listener(move |this, ev: &KeyDownEvent, window, cx| {
            if ev.keystroke.key == "escape" {
                on_close(this, window, cx);
                cx.stop_propagation();
            }
        }))
        .child(
            div()
                .flex()
                .flex_none()
                .justify_end()
                .px(px(10.0))
                .py(px(8.0))
                .border_b_1()
                .border_color(rgb(BORDER_SUBTLE))
                .child(close),
        )
        .child(
            div()
                .id(SharedString::from("modal-body"))
                .flex_1()
                .min_h_0()
                .overflow_y_scroll()
                .p_3()
                .child(body),
        );

    div()
        .id(SharedString::from("modal-layer"))
        // Starts under the title bar: the caption buttons and drag area stay
        // live while a card is open.
        .absolute()
        .top(px(TITLE_BAR_H))
        .left_0()
        .right_0()
        .bottom_0()
        .occlude()
        .flex()
        .justify_center()
        .items_center()
        .p(px(16.0))
        .child(backdrop)
        .child(motion::enter(
            panel,
            SharedString::from(format!("modal-enter:{key}")),
            0,
        ))
}
