//! Pure navigation, reconnect refresh, and inbox routing helpers for change card views.

use rocky_proto::pipe::{ClientMsg, ServerMsg};
use rocky_proto::translate::QuoteLang;

use crate::card_detail_model::{DetailModel, DiffModel};
use crate::cards_model::CardsModel;
use crate::i18n::UiLang;
use crate::search_input::{Key, SearchInput};
use crate::settings_view::View;

/// Pure result of handling one keydown on the card search box.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SearchKeyAction {
    Updated(SearchInput),
    RequestPaste,
    Ignored,
}

/// Maps GPUI keystroke fields to a pure search input update or paste request.
pub fn map_search_key(
    current: &SearchInput,
    key: &str,
    key_char: Option<&str>,
    secondary_mod: bool,
    other_mod: bool,
) -> SearchKeyAction {
    if secondary_mod && !other_mod && key.eq_ignore_ascii_case("v") {
        return SearchKeyAction::RequestPaste;
    }
    if secondary_mod || other_mod {
        return SearchKeyAction::Ignored;
    }
    let next = match key {
        "backspace" => current.apply(Key::Backspace),
        "escape" => current.apply(Key::Escape),
        "space" => current.apply(Key::Char(" ")),
        _ => match key_char {
            Some(s) => current.apply(Key::Char(s)),
            None => return SearchKeyAction::Ignored,
        },
    };
    if next == *current {
        SearchKeyAction::Ignored
    } else {
        SearchKeyAction::Updated(next)
    }
}

/// Builds outgoing refresh requests when a `Snapshot` marks a (re)connection.
pub fn on_reconnect(
    cards: &mut CardsModel,
    detail: Option<&mut DetailModel>,
    diff: Option<&mut DiffModel>,
    target: Option<QuoteLang>,
    mut next_id: impl FnMut() -> u64,
) -> Vec<ClientMsg> {
    let cards_id = next_id();
    let cards_msg = cards
        .set_target(target, cards_id)
        .unwrap_or_else(|| cards.request_first_page(cards_id));
    let mut out = vec![cards_msg];
    if let Some(d) = detail {
        out.push(d.reopen(next_id(), target));
    }
    if let Some(df) = diff {
        out.push(df.reopen(next_id()));
    }
    out
}

/// Routes card-related server messages into the list, detail, and diff models.
pub fn route_card_msg(
    msg: &ServerMsg,
    view: &mut View,
    cards: &mut CardsModel,
    detail: &mut Option<DetailModel>,
    diff: &mut Option<DiffModel>,
    lang: UiLang,
) -> bool {
    match msg {
        ServerMsg::Cards {
            id,
            items,
            next,
            translations,
        } => {
            cards.on_cards(*id, items.clone(), next.clone(), translations.clone());
            true
        }
        ServerMsg::Card { item } => {
            cards.on_push(item.clone());
            true
        }
        ServerMsg::CardDetail {
            id,
            card,
            snippets,
            translations,
            pending,
        } => {
            if let Some(d) = detail.as_mut()
                && d.pending_id() == Some(*id)
            {
                d.on_detail(
                    *id,
                    card.clone(),
                    snippets.clone(),
                    translations.clone(),
                    pending.clone(),
                    lang,
                );
                return true;
            }
            false
        }
        ServerMsg::QuoteTranslated { card_id, item } => detail
            .as_mut()
            .is_some_and(|d| d.on_translated(card_id, item)),
        ServerMsg::QuoteSettled {
            card_id,
            quote_key,
            to,
        } => detail
            .as_mut()
            .is_some_and(|d| d.on_settled(card_id, quote_key, *to)),
        ServerMsg::BlockDiff {
            id,
            lines,
            page,
            pages,
            missing,
        } => {
            if let Some(df) = diff.as_mut()
                && df.pending_id() == Some(*id)
            {
                df.on_diff(*id, lines.clone(), *page, *pages, *missing);
                return true;
            }
            false
        }
        ServerMsg::Ack { id, ok, .. } => {
            if cards.on_ack(*id, *ok) {
                return true;
            }
            if let Some(d) = detail.as_mut()
                && d.pending_id() == Some(*id)
            {
                d.on_ack(*id, *ok);
                if d.reopened_not_found() {
                    close_to_list(view, detail, diff);
                }
                return true;
            }
            if let Some(df) = diff.as_mut()
                && df.pending_id() == Some(*id)
            {
                df.on_ack(*id, *ok);
                if df.reopened_not_found() {
                    close_to_list(view, detail, diff);
                }
                return true;
            }
            false
        }
        _ => false,
    }
}

fn close_to_list(view: &mut View, detail: &mut Option<DetailModel>, diff: &mut Option<DiffModel>) {
    *diff = None;
    *detail = None;
    if matches!(*view, View::CardDetail | View::BlockDiff) {
        *view = View::Agents;
    }
}

/// Opens a change card detail view and clears any prior diff view state.
pub fn open_detail(
    view: &mut View,
    detail: &mut Option<DetailModel>,
    diff: &mut Option<DiffModel>,
    card_id: String,
    id: u64,
    target: Option<QuoteLang>,
) -> ClientMsg {
    *diff = None;
    let (m, msg) = DetailModel::open(card_id, id, target);
    *detail = Some(m);
    *view = View::CardDetail;
    msg
}

/// Opens the paged diff view for block `seq` from the currently open detail card.
pub fn open_diff(
    view: &mut View,
    detail: Option<&DetailModel>,
    diff: &mut Option<DiffModel>,
    seq: u32,
    id: u64,
) -> Option<ClientMsg> {
    let card_id = detail?.card_id().to_string();
    let (m, msg) = DiffModel::open(card_id, seq, id);
    *diff = Some(m);
    *view = View::BlockDiff;
    Some(msg)
}

/// Navigates from the block diff view back to the open card detail view.
pub fn back_from_diff(view: &mut View, diff: &mut Option<DiffModel>) {
    *diff = None;
    *view = View::CardDetail;
}

/// Navigates from card detail back to the card list view.
pub fn back_from_detail(
    view: &mut View,
    detail: &mut Option<DetailModel>,
    diff: &mut Option<DiffModel>,
) {
    *diff = None;
    *detail = None;
    *view = View::Agents;
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_translate;
