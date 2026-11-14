//! Pure navigation, reconnect refresh, and inbox routing helpers for change card views.

use rocky_proto::pipe::{ClientMsg, ServerMsg};

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
    mut next_id: impl FnMut() -> u64,
) -> Vec<ClientMsg> {
    let mut out = vec![cards.request_first_page(next_id())];
    if let Some(d) = detail {
        out.push(d.reopen(next_id()));
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
        ServerMsg::Cards { id, items, next } => {
            cards.on_cards(*id, items.clone(), next.clone());
            true
        }
        ServerMsg::Card { item } => {
            cards.on_push(item.clone());
            true
        }
        ServerMsg::CardDetail { id, card, snippets } => {
            if let Some(d) = detail.as_mut()
                && d.pending_id() == Some(*id)
            {
                d.on_detail(*id, card.clone(), snippets.clone(), lang);
                return true;
            }
            false
        }
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
        ServerMsg::Ack { id, ok, error, .. } => {
            if let Some(d) = detail.as_mut()
                && d.pending_id() == Some(*id)
            {
                d.on_ack(*id, *ok, error.as_deref());
                if d.reopened_not_found() {
                    close_to_list(view, detail, diff);
                }
                return true;
            }
            if let Some(df) = diff.as_mut()
                && df.pending_id() == Some(*id)
            {
                df.on_ack(*id, *ok, error.as_deref());
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
) -> ClientMsg {
    *diff = None;
    let (m, msg) = DetailModel::open(card_id, id);
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
mod tests {
    use rocky_proto::cards::{
        Block, BlockVia, Card, CardStatus, Coverage, CoverageState, Importance,
    };
    use rocky_proto::pipe::{BlockSnippet, DiffLine, DiffLineKind, SnippetLine};

    use super::*;
    use crate::card_detail_model::{DetailState, DiffState};
    use crate::cards_model::PAGE_LIMIT;

    fn sample_card(id: &str) -> Card {
        Card {
            v: 1,
            card_id: id.to_string(),
            rev: 1,
            repo_id: "r1".to_string(),
            root: "C:/repo".to_string(),
            main_root: None,
            branch: Some("main".to_string()),
            session_id: "s1".to_string(),
            agent_id: "a1".to_string(),
            agent_type: "claude".to_string(),
            parent_card_id: None,
            started_ms: 1_000,
            ended_ms: Some(2_000),
            status: CardStatus::Done,
            prompt: "fix parser".to_string(),
            prompt_truncated: false,
            importance: Importance::Medium,
            blocks: vec![Block {
                seq: 7,
                path: "src/lib.rs".to_string(),
                symbol: None,
                labels: Vec::new(),
                importance: Importance::Medium,
                via: BlockVia::Edit,
                tool_use_ids: Vec::new(),
                bash: None,
                before: Some("a".to_string()),
                after: Some("b".to_string()),
                recorded: true,
                line: Some(10),
                added: Some(1),
                removed: Some(1),
                quote: None,
            }],
            more_count: 0,
            flow: Vec::new(),
            flow_more: 0,
            outside_count: 0,
            coverage: Coverage {
                state: CoverageState::Full,
                reasons: Vec::new(),
            },
        }
    }

    #[test]
    fn reconnect_refreshes_open_views() {
        let mut cards = CardsModel::new();
        let mut next = 10_u64;
        let mut alloc = || {
            next += 1;
            next
        };
        let _ = cards.set_query("auth".to_string(), alloc());

        // List only: requests page 1 keeping query "auth".
        let msgs = on_reconnect(&mut cards, None, None, &mut alloc);
        assert_eq!(
            msgs,
            vec![ClientMsg::Cards {
                id: 12,
                query: Some("auth".to_string()),
                before: None,
                limit: PAGE_LIMIT,
            }]
        );

        // Detail + diff open at page 2: requests page 1 + detail + same seq/page diff.
        let (mut detail, _) = DetailModel::open("c1".to_string(), alloc());
        let (mut diff, _) = DiffModel::open("c1".to_string(), 7, alloc());
        diff.on_diff(
            14,
            vec![DiffLine {
                kind: DiffLineKind::Added,
                text: "+ok".to_string(),
            }],
            0,
            3,
            false,
        );
        let _ = diff.go(2, alloc());

        let msgs = on_reconnect(&mut cards, Some(&mut detail), Some(&mut diff), &mut alloc);
        assert_eq!(
            msgs,
            vec![
                ClientMsg::Cards {
                    id: 16,
                    query: Some("auth".to_string()),
                    before: None,
                    limit: PAGE_LIMIT,
                },
                ClientMsg::CardDetail {
                    id: 17,
                    card_id: "c1".to_string(),
                },
                ClientMsg::BlockDiff {
                    id: 18,
                    card_id: "c1".to_string(),
                    seq: 7,
                    page: 2,
                },
            ]
        );
        assert_eq!(detail.pending_id(), Some(17));
        assert_eq!(diff.pending_id(), Some(18));
    }

    #[test]
    fn inbox_routes_card_messages() {
        let mut view = View::Agents;
        let mut cards = CardsModel::new();
        let mut detail = None;
        let mut diff = None;

        let req = cards.request_first_page(1);
        assert!(matches!(req, ClientMsg::Cards { id: 1, .. }));

        // Cards reply populates the list model.
        let changed = route_card_msg(
            &ServerMsg::Cards {
                id: 1,
                items: vec![sample_card("c1")],
                next: None,
            },
            &mut view,
            &mut cards,
            &mut detail,
            &mut diff,
            UiLang::En,
        );
        assert!(changed);
        assert_eq!(cards.rows(UiLang::En).len(), 1);

        // Card push updates/inserts into CardsModel.
        let mut updated = sample_card("c2");
        updated.started_ms = 2_000;
        let changed = route_card_msg(
            &ServerMsg::Card { item: updated },
            &mut view,
            &mut cards,
            &mut detail,
            &mut diff,
            UiLang::En,
        );
        assert!(changed);
        assert_eq!(cards.rows(UiLang::En).len(), 2);

        // Open detail (id 2), verify unrelated Ack (999) is ignored, then matching CardDetail updates it.
        let _ = open_detail(&mut view, &mut detail, &mut diff, "c1".to_string(), 2);
        let ignored = route_card_msg(
            &ServerMsg::Ack {
                id: 999,
                ok: false,
                error: Some("not_found".to_string()),
                cleanup_errors: 0,
            },
            &mut view,
            &mut cards,
            &mut detail,
            &mut diff,
            UiLang::En,
        );
        assert!(!ignored);
        assert_eq!(view, View::CardDetail);
        assert_eq!(detail.as_ref().unwrap().state(), &DetailState::Loading);

        let changed = route_card_msg(
            &ServerMsg::CardDetail {
                id: 2,
                card: sample_card("c1"),
                snippets: vec![BlockSnippet {
                    seq: 7,
                    lines: vec![SnippetLine::Added {
                        text: "+x".to_string(),
                    }],
                }],
            },
            &mut view,
            &mut cards,
            &mut detail,
            &mut diff,
            UiLang::En,
        );
        assert!(changed);
        assert!(matches!(
            detail.as_ref().unwrap().state(),
            DetailState::Ready(_)
        ));

        // Open diff (id 3), verify matching BlockDiff updates it.
        let _ = open_diff(&mut view, detail.as_ref(), &mut diff, 7, 3);
        let changed = route_card_msg(
            &ServerMsg::BlockDiff {
                id: 3,
                lines: vec![DiffLine {
                    kind: DiffLineKind::Added,
                    text: "+line".to_string(),
                }],
                page: 0,
                pages: 1,
                missing: false,
            },
            &mut view,
            &mut cards,
            &mut detail,
            &mut diff,
            UiLang::En,
        );
        assert!(changed);
        assert!(matches!(
            diff.as_ref().unwrap().state(),
            DiffState::Page { .. }
        ));

        // Reconnect re-opens diff (id 5) and ends NotFound -> clears both diff and detail, returns to list.
        let mut seq_id = 3_u64;
        let _ = on_reconnect(&mut cards, detail.as_mut(), diff.as_mut(), || {
            seq_id += 1;
            seq_id
        });
        assert_eq!(detail.as_ref().unwrap().pending_id(), Some(5));
        assert_eq!(diff.as_ref().unwrap().pending_id(), Some(6));

        let changed = route_card_msg(
            &ServerMsg::Ack {
                id: 6,
                ok: false,
                error: Some("not_found".to_string()),
                cleanup_errors: 0,
            },
            &mut view,
            &mut cards,
            &mut detail,
            &mut diff,
            UiLang::En,
        );
        assert!(changed);
        assert_eq!(view, View::Agents);
        assert!(detail.is_none());
        assert!(diff.is_none());
    }

    #[test]
    fn view_navigation_back_and_forth() {
        let mut view = View::Agents;
        let mut detail = None;
        let mut diff = None;

        let msg = open_detail(&mut view, &mut detail, &mut diff, "c1".to_string(), 1);
        assert_eq!(
            msg,
            ClientMsg::CardDetail {
                id: 1,
                card_id: "c1".to_string(),
            }
        );
        assert_eq!(view, View::CardDetail);
        assert!(detail.is_some());
        assert!(diff.is_none());

        let msg = open_diff(&mut view, detail.as_ref(), &mut diff, 9, 2);
        assert_eq!(
            msg,
            Some(ClientMsg::BlockDiff {
                id: 2,
                card_id: "c1".to_string(),
                seq: 9,
                page: 0,
            })
        );
        assert_eq!(view, View::BlockDiff);
        assert!(detail.is_some());
        assert!(diff.is_some());

        back_from_diff(&mut view, &mut diff);
        assert_eq!(view, View::CardDetail);
        assert!(detail.is_some());
        assert!(diff.is_none());

        back_from_detail(&mut view, &mut detail, &mut diff);
        assert_eq!(view, View::Agents);
        assert!(detail.is_none());
        assert!(diff.is_none());
    }

    #[test]
    fn reopened_detail_not_found_returns_to_list() {
        let mut cards = CardsModel::new();
        let mut view = View::Agents;
        let mut detail = None;
        let mut diff = None;

        let _ = open_detail(&mut view, &mut detail, &mut diff, "c1".to_string(), 1);
        let _ = open_diff(&mut view, detail.as_ref(), &mut diff, 7, 2);

        let mut next = 2_u64;
        let _ = on_reconnect(&mut cards, detail.as_mut(), diff.as_mut(), || {
            next += 1;
            next
        });
        assert_eq!(detail.as_ref().unwrap().pending_id(), Some(4));

        // Even while viewing diff, reopened detail NotFound closes both diff and detail.
        let changed = route_card_msg(
            &ServerMsg::Ack {
                id: 4,
                ok: false,
                error: Some("not_found".to_string()),
                cleanup_errors: 0,
            },
            &mut view,
            &mut cards,
            &mut detail,
            &mut diff,
            UiLang::En,
        );
        assert!(changed);
        assert_eq!(view, View::Agents);
        assert!(detail.is_none());
        assert!(diff.is_none());
    }

    #[test]
    fn direct_not_found_stays_on_view() {
        let mut cards = CardsModel::new();
        let mut view = View::Agents;
        let mut detail = None;
        let mut diff = None;

        let _ = open_detail(&mut view, &mut detail, &mut diff, "missing".to_string(), 1);
        let changed = route_card_msg(
            &ServerMsg::Ack {
                id: 1,
                ok: false,
                error: Some("not_found".to_string()),
                cleanup_errors: 0,
            },
            &mut view,
            &mut cards,
            &mut detail,
            &mut diff,
            UiLang::En,
        );
        assert!(changed);
        assert_eq!(view, View::CardDetail);
        assert_eq!(detail.as_ref().unwrap().state(), &DetailState::NotFound);

        let _ = open_diff(&mut view, detail.as_ref(), &mut diff, 3, 2);
        let changed = route_card_msg(
            &ServerMsg::Ack {
                id: 2,
                ok: false,
                error: Some("not_found".to_string()),
                cleanup_errors: 0,
            },
            &mut view,
            &mut cards,
            &mut detail,
            &mut diff,
            UiLang::En,
        );
        assert!(changed);
        assert_eq!(view, View::BlockDiff);
        assert_eq!(diff.as_ref().unwrap().state(), &DiffState::NotFound);
    }

    #[test]
    fn search_key_mapping() {
        let s = SearchInput::default();
        assert_eq!(
            map_search_key(&s, "a", Some("a"), false, false),
            SearchKeyAction::Updated(SearchInput {
                text: "a".to_string()
            })
        );
        let s = SearchInput {
            text: "foo".to_string(),
        };
        assert_eq!(
            map_search_key(&s, "space", None, false, false),
            SearchKeyAction::Updated(SearchInput {
                text: "foo ".to_string()
            })
        );
        assert_eq!(
            map_search_key(&s, "backspace", None, false, false),
            SearchKeyAction::Updated(SearchInput {
                text: "fo".to_string()
            })
        );
        assert_eq!(
            map_search_key(&s, "escape", None, false, false),
            SearchKeyAction::Updated(SearchInput {
                text: String::new()
            })
        );
        assert_eq!(
            map_search_key(&s, "v", None, true, false),
            SearchKeyAction::RequestPaste
        );
        assert_eq!(
            map_search_key(&s, "c", None, true, false),
            SearchKeyAction::Ignored
        );
        assert_eq!(
            map_search_key(&s, "enter", None, false, false),
            SearchKeyAction::Ignored
        );
    }
}
