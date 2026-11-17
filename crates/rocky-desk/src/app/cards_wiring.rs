//! Desk wiring for change card navigation, search input keystrokes, and debounce.

use gpui::{Context, KeyDownEvent, Window};
use rocky_proto::pipe::ClientMsg;

use super::{DeskView, now_ms};
use crate::cards_nav::{self, SearchKeyAction};
use crate::search_input::Key;
use crate::ui::cards_view::CardAction;

impl DeskView {
    pub(super) fn send_card_msg(&self, msg: ClientMsg) {
        if let Some(outbox) = self.ctl.outbox.as_ref() {
            let _ = outbox.send(msg);
        }
    }

    pub(super) fn cards_refresh_msgs(&mut self) -> Vec<ClientMsg> {
        let mut cmd_id = self.ctl.cmd_id;
        let msgs = cards_nav::on_reconnect(
            &mut self.cards,
            self.card_detail.as_mut(),
            self.block_diff.as_mut(),
            || {
                cmd_id += 1;
                cmd_id
            },
        );
        self.ctl.cmd_id = cmd_id;
        msgs
    }

    pub(super) fn on_card_action(
        &mut self,
        action: CardAction,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match action {
            CardAction::FocusSearch => {
                self.search_focus.focus(window);
                cx.notify();
            }
            CardAction::OpenDetail(card_id) => {
                let id = self.next_id();
                let msg = cards_nav::open_detail(
                    &mut self.ctl.view,
                    &mut self.card_detail,
                    &mut self.block_diff,
                    card_id,
                    id,
                );
                self.send_card_msg(msg);
                // The card opens as a modal; focus it so Escape closes it.
                self.modal_focus.focus(window);
                cx.notify();
            }
            CardAction::LoadMore => {
                let id = self.next_id();
                if let Some(msg) = self.cards.request_more(id) {
                    self.send_card_msg(msg);
                    cx.notify();
                }
            }
            CardAction::BackFromDetail => {
                cards_nav::back_from_detail(
                    &mut self.ctl.view,
                    &mut self.card_detail,
                    &mut self.block_diff,
                );
                cx.notify();
            }
            CardAction::OpenDiff(seq) => {
                let id = self.next_id();
                if let Some(msg) = cards_nav::open_diff(
                    &mut self.ctl.view,
                    self.card_detail.as_ref(),
                    &mut self.block_diff,
                    seq,
                    id,
                ) {
                    self.send_card_msg(msg);
                    cx.notify();
                }
            }
            CardAction::BackFromDiff => {
                cards_nav::back_from_diff(&mut self.ctl.view, &mut self.block_diff);
                cx.notify();
            }
            CardAction::DiffPage(page) => {
                let id = self.next_id();
                if let Some(diff) = self.block_diff.as_mut()
                    && let Some(msg) = diff.go(page, id)
                {
                    self.send_card_msg(msg);
                    cx.notify();
                }
            }
        }
    }

    pub(super) fn on_search_key(&mut self, ev: &KeyDownEvent, cx: &mut Context<Self>) {
        let m = ev.keystroke.modifiers;
        let other_mod = m.alt
            || (!cfg!(target_os = "macos") && m.platform)
            || (cfg!(target_os = "macos") && m.control);
        let next = match cards_nav::map_search_key(
            &self.search,
            &ev.keystroke.key,
            ev.keystroke.key_char.as_deref(),
            m.secondary(),
            other_mod,
        ) {
            SearchKeyAction::Updated(next) => next,
            SearchKeyAction::RequestPaste => {
                let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) else {
                    return;
                };
                let pasted = self.search.apply(Key::Paste(&text));
                if pasted == self.search {
                    return;
                }
                pasted
            }
            SearchKeyAction::Ignored => return,
        };
        self.search = next;
        self.search_debounce.edited(now_ms());
        cx.notify();
    }

    pub(super) fn poll_search_debounce(&mut self, cx: &mut Context<Self>) {
        if self.search_debounce.take(now_ms()) && self.search.text != self.cards.query() {
            let id = self.next_id();
            let msg = self.cards.set_query(self.search.text.clone(), id);
            self.send_card_msg(msg);
            cx.notify();
        }
    }
}
