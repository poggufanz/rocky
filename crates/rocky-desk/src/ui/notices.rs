//! Collapsible Notices card that summarizes setup warnings above the Agents tab.

use gpui::prelude::*;
use gpui::{Context, Div, FontWeight, SharedString, Window, div, px, rgb};

use crate::i18n::{CardMsg, Msg, UiLang, card_text, tr};
use crate::ui::status::dot_el;
use crate::ui::tooltip::{
    BORDER_SUBTLE, NOTICE_DOT, ROW_HOVER_BG, TEXT_DARK, TEXT_MUTED, TEXT_SUBTLE, card_container,
};

/// Callback invoked when the Notices header is clicked.
pub type OnToggle<T> = fn(&mut T, &mut Window, &mut Context<T>);

/// Renders the collapsible Notices card replacing the top warnings strip.
pub fn notices_card<T: 'static>(
    lang: UiLang,
    warnings: &[Msg],
    open: bool,
    cx: &mut Context<T>,
    on_toggle: OnToggle<T>,
) -> Div {
    let title = card_text(lang, &CardMsg::SetupNotes { n: warnings.len() });
    let summary = warnings.first().map(|w| tr(lang, w)).unwrap_or_default();
    let toggle_label = card_text(lang, if open { &CardMsg::Hide } else { &CardMsg::Show });

    let head = div()
        .id(SharedString::from("notices-toggle"))
        .flex()
        .items_center()
        .gap(px(8.0))
        .py(px(8.0))
        .px(px(12.0))
        .cursor_pointer()
        .hover(|s| s.bg(rgb(ROW_HOVER_BG)))
        .on_click(cx.listener(move |this, _, window, cx| {
            on_toggle(this, window, cx);
        }))
        .child(dot_el(NOTICE_DOT))
        .child(
            div()
                .text_size(px(12.5))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(rgb(TEXT_DARK))
                .whitespace_nowrap()
                .flex_shrink_0()
                .child(title),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .text_size(px(12.0))
                .text_color(rgb(TEXT_MUTED))
                .child(summary),
        )
        .child(
            div()
                .text_size(px(12.0))
                .text_color(rgb(TEXT_MUTED))
                .whitespace_nowrap()
                .flex_shrink_0()
                .child(toggle_label),
        );

    let mut card = card_container().child(head);
    if open {
        let mut body = div()
            .flex()
            .flex_col()
            .gap(px(4.0))
            .border_t_1()
            .border_color(rgb(BORDER_SUBTLE))
            .pt(px(8.0))
            .pr(px(12.0))
            .pb(px(10.0))
            .pl(px(28.0))
            .text_size(px(12.0))
            .text_color(rgb(TEXT_SUBTLE));
        for w in warnings {
            body = body.child(div().child(tr(lang, w)));
        }
        card = card.child(body);
    }
    card
}
