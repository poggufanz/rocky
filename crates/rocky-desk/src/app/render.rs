//! Main GPUI render tree for `DeskView`.

use gpui::prelude::*;
use gpui::{Context, IntoElement, Render, SharedString, Window, div, rgb};

use super::{DeskView, now_ms};
use crate::clock;
use crate::i18n::{Msg, tr};
use crate::now_model::now_view;
use crate::settings_view::View;
use crate::ui::block_diff::block_diff_view;
use crate::ui::card_detail::card_detail_view;
use crate::ui::cards_view::cards_section;
use crate::ui::consent::consent_screen;
use crate::ui::now_view::{notices_card, now_section};
use crate::ui::setup_settings::removed_screen;

impl Render for DeskView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let warnings = self.ctl.model.warnings(&clock::local_hhmm);
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
        // Opaque background: without one, gpui on Windows shows the desktop through.
        let mut root = div()
            .flex()
            .flex_col()
            .gap_2()
            .p_3()
            .size_full()
            .bg(rgb(0xF5F5F4))
            .text_color(rgb(0x1C1C1C));
        if let Some(banner) = self.banner(cx) {
            root = root.child(banner);
        }
        let other = match self.ctl.view {
            View::Agents | View::Consent | View::Removed | View::CardDetail | View::BlockDiff => {
                Msg::ViewSettings
            }
            View::Settings => Msg::ViewAgents,
        };
        root = root.child(
            div()
                .id(SharedString::from("view-toggle"))
                .text_sm()
                .cursor_pointer()
                .child(tr(lang, &other))
                .on_click(cx.listener(|this, _, _, cx| this.toggle_view(cx))),
        );
        if !warnings.is_empty() {
            root = root.child(notices_card(
                lang,
                &warnings,
                self.notices_open,
                cx,
                Self::on_now_action,
            ));
        }
        if self.ctl.view == View::Settings {
            // Outside the panel, which returns early while settings are
            // unknown: Quit must stay reachable when the daemon is down.
            return root
                .id(SharedString::from("settings"))
                .overflow_y_scroll()
                .child(self.settings_panel(cx))
                .child(self.setup_panel(cx))
                .child(
                    div()
                        .id(SharedString::from("quit"))
                        .text_sm()
                        .cursor_pointer()
                        .child(tr(lang, &Msg::MenuQuit))
                        .on_click(cx.listener(|this, _, _, cx| this.quit(cx))),
                )
                .into_any_element();
        }
        if self.ctl.view == View::CardDetail {
            return root
                .id(SharedString::from("card-detail"))
                .overflow_y_scroll()
                .child(card_detail_view(
                    lang,
                    self.card_detail.as_ref(),
                    cx,
                    Self::on_card_action,
                ))
                .into_any_element();
        }
        if self.ctl.view == View::BlockDiff {
            return root
                .id(SharedString::from("block-diff"))
                .overflow_y_scroll()
                .child(block_diff_view(
                    lang,
                    self.card_detail.as_ref(),
                    self.block_diff.as_ref(),
                    cx,
                    Self::on_card_action,
                ))
                .into_any_element();
        }
        let (top_banners, _) = self.repo_banners(&[], cx);
        for banner in top_banners {
            root = root.child(banner);
        }
        let view = now_view(&self.ctl.model, &self.cards, now_ms(), lang);
        root = root.child(now_section(
            lang,
            &view,
            self.idle_open,
            cx,
            Self::on_now_action,
        ));
        root = root.child(cards_section(
            lang,
            &self.cards,
            &self.search,
            &self.search_focus,
            window,
            cx,
            Self::on_card_action,
            Self::on_search_key,
        ));
        root.id(SharedString::from("agents"))
            .overflow_y_scroll()
            .into_any_element()
    }
}
