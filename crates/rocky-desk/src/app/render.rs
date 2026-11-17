//! Main GPUI render tree for `DeskView`.
//!
//! Three layers, top to bottom: the title bar, the current page, and when a
//! card is open, the card modal over that page.

use gpui::prelude::*;
use gpui::{
    AnyElement, Context, IntoElement, KeyDownEvent, Render, SharedString, Window, div, rgb,
};

use super::DeskView;
use crate::clock;
use crate::flow_model;
use crate::i18n::{Msg, tr};
use crate::settings_view::View;
use crate::ui::block_diff::block_diff_view;
use crate::ui::card_detail::card_detail_view;
use crate::ui::consent::consent_screen;
use crate::ui::flow_view::flow_section;
use crate::ui::modal::card_modal;
use crate::ui::notices::notices_card;
use crate::ui::setup_settings::removed_screen;
use crate::ui::title_bar::{Tab, title_bar};
use crate::ui::tooltip::{SURFACE_SUBTLE, TEXT_DARK};
use rocky_proto::pipe::Status;

impl Render for DeskView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let lang = self.ctl.ui_lang;
        let tabs = match self.ctl.view {
            View::Consent | View::Removed => None,
            _ => Some(self.active_tab()),
        };
        let bar = title_bar(lang, tabs, window, cx, Self::select_tab);
        let page = self.page(window, cx);
        // With nothing focused, gpui sends keys to the window root only, past
        // this view's handler; holding page focus keeps Tab and Escape working.
        if window.focused(cx).is_none() {
            self.root_focus.focus(window);
        }

        // Opaque background: without one, gpui on Windows shows the desktop through.
        let mut root = div()
            .relative()
            .flex()
            .flex_col()
            .size_full()
            .bg(rgb(SURFACE_SUBTLE))
            .text_color(rgb(TEXT_DARK))
            .on_key_down(cx.listener(|this, ev: &KeyDownEvent, window, cx| {
                this.on_root_key(ev, window, cx);
            }))
            .child(bar)
            // The focus target is the page, never an ancestor of the title bar:
            // a focusable element claims mouse-down, and on Windows that would
            // swallow the caption buttons and the drag area.
            .child(
                div()
                    .id(SharedString::from("desk-page"))
                    .track_focus(&self.root_focus)
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_h_0()
                    .child(page),
            );

        if matches!(self.ctl.view, View::CardDetail | View::BlockDiff) {
            let key = self
                .card_detail
                .as_ref()
                .map(|d| d.card_id().to_string())
                .unwrap_or_default();
            let body = if self.ctl.view == View::BlockDiff {
                block_diff_view(
                    lang,
                    self.card_detail.as_ref(),
                    self.block_diff.as_ref(),
                    cx,
                    Self::on_card_action,
                )
                .into_any_element()
            } else {
                card_detail_view(lang, self.card_detail.as_ref(), cx, Self::on_card_action)
                    .into_any_element()
            };
            root = root.child(card_modal(
                lang,
                &key,
                body,
                &self.modal_focus,
                cx,
                Self::close_modal,
            ));
        }
        root
    }
}

impl DeskView {
    /// Tab moves keyboard focus through the controls in paint order; Escape
    /// closes an open card even when focus sits outside the modal.
    fn on_root_key(&mut self, ev: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        match ev.keystroke.key.as_str() {
            "tab" => {
                if ev.keystroke.modifiers.shift {
                    window.focus_prev();
                } else {
                    window.focus_next();
                }
                cx.notify();
            }
            "escape" if matches!(self.ctl.view, View::CardDetail | View::BlockDiff) => {
                self.close_modal(window, cx);
            }
            _ => {
                if self.on_atlas_key(ev, window, cx) {
                    cx.stop_propagation();
                }
            }
        }
    }

    /// The page under the title bar for the current view.
    fn page(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let lang = self.ctl.ui_lang;
        if self.ctl.view == View::Consent {
            return consent_screen(
                &self.consent,
                lang,
                cx.listener(|this, _, _, cx| {
                    this.consent.autostart = !this.consent.autostart;
                    cx.notify();
                }),
                cx.listener(|this, _, _, cx| this.agree_consent(cx)),
                cx.listener(|this, _, _, cx| this.later_consent(cx)),
                cx.listener(|this, _, _, cx| this.toggle_view(cx)),
            )
            .into_any_element();
        }
        if self.ctl.view == View::Removed {
            let home = self.ctl.rocky_home.display().to_string();
            return removed_screen(
                lang,
                &home,
                self.setup.removed_cleanup_errors(),
                Self::finish_removed,
                cx,
            )
            .into_any_element();
        }

        let warnings = self.ctl.model.warnings(&clock::local_hhmm);
        let mut page = div().flex().flex_col().gap_2().w_full();
        if let Some(banner) = self.banner(cx) {
            page = page.child(banner);
        }
        if !warnings.is_empty() {
            page = page.child(notices_card(
                lang,
                &warnings,
                self.notices_open,
                cx,
                Self::on_toggle_notices,
            ));
        }

        if self.ctl.view == View::Settings {
            // Outside the panel, which returns early while settings are
            // unknown: Quit must stay reachable when the daemon is down.
            let page = page
                .child(self.settings_panel(cx))
                .child(self.setup_panel(cx))
                .child(
                    div()
                        .id(SharedString::from("quit"))
                        .text_sm()
                        .cursor_pointer()
                        .child(tr(lang, &Msg::MenuQuit))
                        .on_click(cx.listener(|this, _, _, cx| this.quit(cx))),
                );
            return scroll_page("settings", page);
        }

        let (top_banners, _) = self.repo_banners(&[], cx);
        for banner in top_banners {
            page = page.child(banner);
        }

        if self.main_tab == Tab::Flow {
            let working: Vec<flow_model::LaneKey> = self
                .ctl
                .model
                .agents()
                .values()
                .filter(|a| a.status == Status::Working)
                .map(|a| flow_model::LaneKey {
                    session_id: a.key.session_id.clone(),
                    agent_id: a.key.agent_id.clone(),
                })
                .collect();
            let graph = flow_model::build(self.cards.items(), &working);
            let no_cards = self
                .cards
                .items()
                .is_empty()
                .then(|| self.cards.empty_msg());
            page = page.child(flow_section(
                lang,
                &graph,
                self.cards.loading(),
                no_cards,
                self.flow_hover,
                cx,
                Self::on_card_action,
                Self::on_flow_hover,
            ));
            return scroll_page("flow", page);
        }

        self.atlas_page(page, window, cx)
    }
}

/// Widest the content column grows. Past it, lines of a card run so long
/// that the time, title, and files at either end stop reading as one row.
const MAX_CONTENT_W: f32 = 880.0;

/// A scrolling page whose content column stays centered and capped.
fn scroll_page(id: &'static str, content: gpui::Div) -> AnyElement {
    div()
        .id(SharedString::from(id))
        .size_full()
        .overflow_y_scroll()
        .p_3()
        .child(content.max_w(gpui::px(MAX_CONTENT_W)).mx_auto())
        .into_any_element()
}
