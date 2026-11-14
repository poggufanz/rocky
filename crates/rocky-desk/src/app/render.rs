//! Main GPUI render tree for `DeskView`.

use gpui::prelude::*;
use gpui::{Context, Div, FontWeight, IntoElement, Render, SharedString, Window, div, rgb};
use rocky_proto::pipe::{Outcome, Status};

use super::{DeskView, now_ms};
use crate::clock;
use crate::i18n::{CardMsg, Msg, UiLang, card_text, tr};
use crate::settings_view::View;
use crate::ui::block_diff::block_diff_view;
use crate::ui::card_detail::card_detail_view;
use crate::ui::cards_view::cards_section;
use crate::ui::consent::consent_screen;
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
            let mut strip = div().flex_col().gap_1();
            for w in &warnings {
                strip = strip.child(div().text_sm().child(tr(lang, w)));
            }
            root = root.child(strip);
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
        let groups = self.ctl.model.groups(now_ms());
        let (top_banners, group_banners) = self.repo_banners(&groups, cx);
        for banner in top_banners {
            root = root.child(banner);
        }
        root = root.child(
            div()
                .text_xs()
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(rgb(0x6B6B6B))
                .child(card_text(lang, &CardMsg::SectionNow)),
        );
        if groups.is_empty() {
            root = root.child(div().text_sm().child(tr(lang, &Msg::NoAgents)));
        }
        for (g, banners) in groups.iter().zip(group_banners) {
            let mut gdiv = div().flex_col().gap_1();
            gdiv = gdiv.child(div().text_sm().child(g.label(lang)));
            for banner in banners {
                gdiv = gdiv.child(banner);
            }
            for s in &g.sessions {
                let mut sdiv = div().flex_col().pl_2();
                sdiv = sdiv.child(div().text_xs().child(tr(
                    lang,
                    &Msg::Session {
                        short: s.session_short.clone(),
                    },
                )));
                for a in &s.rows {
                    let mut row = div()
                        .id(SharedString::from(format!(
                            "agent:{}:{}",
                            a.key.session_id, a.key.agent_id
                        )))
                        .flex()
                        .gap_2()
                        .text_sm()
                        .cursor_pointer()
                        .on_click(cx.listener({
                            let key = a.key.clone();
                            move |this, _event, _window, cx| {
                                if let Some(key) = this.ctl.model.toggle_open(&key) {
                                    this.ctl.request_timeline(key);
                                }
                                cx.notify();
                            }
                        }));
                    if a.child {
                        row = row.pl_3();
                    }
                    let mut label = div().flex_col();
                    label = label.child(div().child(tr(lang, &a.label)));
                    if let Some(desc) = &a.description {
                        label = label.child(div().text_xs().child(desc.clone()));
                    }
                    row = row
                        .child(chip(a.status, lang))
                        .child(label)
                        .child(div().child(tr(lang, &a.age)));
                    if a.failures > 0 {
                        row = row.child(div().child(tr(lang, &Msg::Failures { n: a.failures })));
                    }
                    if let Some(act) = &a.action_text {
                        row = row.child(div().text_xs().child(act.clone()));
                    }
                    if let Some(note) = &a.note {
                        row = row.child(div().text_xs().child(tr(lang, note)));
                    }
                    sdiv = sdiv.child(row);
                    if self.ctl.model.is_open(&a.key) {
                        let mut entries = div().flex_col().pl_6().text_xs();
                        for e in self.ctl.model.timeline_rows(&a.key, &clock::local_hhmm) {
                            let mut line = div()
                                .flex()
                                .gap_2()
                                .child(div().text_color(rgb(0x8A8A8A)).child(e.time))
                                .child(div().child(tr(lang, &e.text)));
                            if let Some(outcome) = e.outcome {
                                let color = match outcome {
                                    Outcome::Failed => rgb(0xD92B2B),
                                    Outcome::Ok => rgb(0x2BA044),
                                    Outcome::Pending => rgb(0x8A8A8A),
                                };
                                line = line.child(
                                    div()
                                        .text_color(color)
                                        .child(tr(lang, &Msg::Outcome(outcome))),
                                );
                            }
                            entries = entries.child(line);
                        }
                        sdiv = sdiv.child(entries);
                    }
                }
                if let Some(hidden) = &s.hidden_children {
                    sdiv = sdiv.child(div().text_xs().pl_3().child(tr(lang, hidden)));
                }
                gdiv = gdiv.child(sdiv);
            }
            root = root.child(gdiv);
        }
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

fn chip(s: Status, lang: UiLang) -> Div {
    let bg = match s {
        Status::NeedsYou => rgb(0xE8B800),
        Status::Failed => rgb(0xD92B2B),
        Status::Working => rgb(0x2B7DD9),
        Status::Done => rgb(0x2BA044),
        Status::Idle | Status::Ended => rgb(0x8A8A8A),
    };
    div()
        .px_2()
        .rounded_sm()
        .bg(bg)
        .text_xs()
        .child(tr(lang, &Msg::Status(s)))
}
