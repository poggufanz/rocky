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
    let mut out = vec![cards.request_first_page(next_id())];
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
        ServerMsg::Cards { id, items, next } => {
            cards.on_cards(*id, items.clone(), next.clone());
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
            reads: Vec::new(),
            reads_more: 0,
            sequence: None,
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
        let msgs = on_reconnect(&mut cards, None, None, None, &mut alloc);
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
        let (mut detail, _) = DetailModel::open("c1".to_string(), alloc(), None);
        detail.on_detail(
            13,
            sample_card("c1"),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            UiLang::En,
        );
        assert!(matches!(detail.state(), DetailState::Ready(_)));

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
        diff.on_diff(
            15,
            vec![DiffLine {
                kind: DiffLineKind::Added,
                text: "+p2".to_string(),
            }],
            2,
            3,
            false,
        );
        assert!(matches!(diff.state(), DiffState::Page { page: 2, .. }));

        let msgs = on_reconnect(
            &mut cards,
            Some(&mut detail),
            Some(&mut diff),
            None,
            &mut alloc,
        );
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
                    translate_to: None,
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
        assert_eq!(detail.state(), &DetailState::Loading);
        assert_eq!(diff.state(), &DiffState::Loading);

        let mut view = View::BlockDiff;
        let mut opt_detail = Some(detail);
        let mut opt_diff = Some(diff);
        assert!(route_card_msg(
            &ServerMsg::CardDetail {
                id: 17,
                card: sample_card("c1"),
                snippets: Vec::new(),
                translations: Vec::new(),
                pending: Vec::new(),
            },
            &mut view,
            &mut cards,
            &mut opt_detail,
            &mut opt_diff,
            UiLang::En,
        ));
        assert!(matches!(
            opt_detail.as_ref().unwrap().state(),
            DetailState::Ready(_)
        ));
        assert!(route_card_msg(
            &ServerMsg::BlockDiff {
                id: 18,
                lines: vec![DiffLine {
                    kind: DiffLineKind::Added,
                    text: "+refreshed".to_string(),
                }],
                page: 2,
                pages: 3,
                missing: false,
            },
            &mut view,
            &mut cards,
            &mut opt_detail,
            &mut opt_diff,
            UiLang::En,
        ));
        assert!(matches!(
            opt_diff.as_ref().unwrap().state(),
            DiffState::Page {
                page: 2,
                pages: 3,
                ..
            }
        ));
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
        let _ = open_detail(&mut view, &mut detail, &mut diff, "c1".to_string(), 2, None);
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
                translations: Vec::new(),
                pending: Vec::new(),
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
        let _ = on_reconnect(&mut cards, detail.as_mut(), diff.as_mut(), None, || {
            seq_id += 1;
            seq_id
        });
        assert_eq!(detail.as_ref().unwrap().pending_id(), Some(5));
        assert_eq!(diff.as_ref().unwrap().pending_id(), Some(6));
        assert_eq!(detail.as_ref().unwrap().state(), &DetailState::Loading);
        assert_eq!(diff.as_ref().unwrap().state(), &DiffState::Loading);

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

        let msg = open_detail(&mut view, &mut detail, &mut diff, "c1".to_string(), 1, None);
        assert_eq!(
            msg,
            ClientMsg::CardDetail {
                id: 1,
                card_id: "c1".to_string(),
                translate_to: None,
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

        let _ = open_detail(&mut view, &mut detail, &mut diff, "c1".to_string(), 1, None);
        let _ = open_diff(&mut view, detail.as_ref(), &mut diff, 7, 2);

        let mut next = 2_u64;
        let _ = on_reconnect(&mut cards, detail.as_mut(), diff.as_mut(), None, || {
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
    fn reopened_detail_retargeted_not_found_returns_to_list() {
        let mut cards = CardsModel::new();
        let mut view = View::Agents;
        let mut detail = None;
        let mut diff = None;

        let _ = open_detail(&mut view, &mut detail, &mut diff, "c1".to_string(), 1, None);
        let _ = open_diff(&mut view, detail.as_ref(), &mut diff, 7, 2);

        let mut next = 2_u64;
        let _ = on_reconnect(&mut cards, detail.as_mut(), diff.as_mut(), None, || {
            next += 1;
            next
        });
        assert_eq!(detail.as_ref().unwrap().pending_id(), Some(4));

        // Retargeting while the reopen is still in-flight replaces the request id
        // without clearing the reconnect flag until the replacement request resolves.
        let req = detail.as_mut().unwrap().retarget(5, Some(QuoteLang::En));
        assert_eq!(
            req,
            Some(ClientMsg::CardDetail {
                id: 5,
                card_id: "c1".to_string(),
                translate_to: Some(QuoteLang::En),
            })
        );
        assert_eq!(detail.as_ref().unwrap().pending_id(), Some(5));

        let changed = route_card_msg(
            &ServerMsg::Ack {
                id: 5,
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

        let _ = open_detail(
            &mut view,
            &mut detail,
            &mut diff,
            "missing".to_string(),
            1,
            None,
        );
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

    #[test]
    fn route_card_msg_handles_failed_cards_ack_first() {
        let mut view = View::Agents;
        let mut cards = CardsModel::new();
        let mut detail = None;
        let mut diff = None;

        let _ = cards.request_first_page(10);
        let _ = open_detail(
            &mut view,
            &mut detail,
            &mut diff,
            "c1".to_string(),
            11,
            None,
        );

        // Unrelated Ack leaves cards loading and detail untouched.
        assert!(!route_card_msg(
            &ServerMsg::Ack {
                id: 999,
                ok: false,
                error: Some("internal".to_string()),
                cleanup_errors: 0,
            },
            &mut view,
            &mut cards,
            &mut detail,
            &mut diff,
            UiLang::En,
        ));
        assert!(cards.loading());

        // Failed Ack for pending cards id clears loading without touching detail.
        assert!(route_card_msg(
            &ServerMsg::Ack {
                id: 10,
                ok: false,
                error: Some("too_large".to_string()),
                cleanup_errors: 0,
            },
            &mut view,
            &mut cards,
            &mut detail,
            &mut diff,
            UiLang::En,
        ));
        assert!(!cards.loading());
        assert_eq!(detail.as_ref().unwrap().state(), &DetailState::Loading);

        // Populate page 1 with cursor, fail load-more via route_card_msg, then retry.
        let _ = cards.request_first_page(12);
        assert!(route_card_msg(
            &ServerMsg::Cards {
                id: 12,
                items: vec![sample_card("c1")],
                next: Some("cur1".to_string()),
            },
            &mut view,
            &mut cards,
            &mut detail,
            &mut diff,
            UiLang::En,
        ));
        assert!(cards.request_more(13).is_some());
        assert!(cards.loading());
        assert!(route_card_msg(
            &ServerMsg::Ack {
                id: 13,
                ok: false,
                error: Some("internal".to_string()),
                cleanup_errors: 0,
            },
            &mut view,
            &mut cards,
            &mut detail,
            &mut diff,
            UiLang::En,
        ));
        assert!(!cards.loading());
        assert_eq!(
            cards.request_more(14),
            Some(ClientMsg::Cards {
                id: 14,
                query: None,
                before: Some("cur1".to_string()),
                limit: PAGE_LIMIT,
            })
        );
    }

    #[test]
    fn route_card_msg_routes_quote_translations_and_settled() {
        use rocky_proto::cards::Quote;
        use rocky_proto::translate::{QuoteTranslation, quote_key};

        let mut view = View::Agents;
        let mut cards = CardsModel::new();
        let mut detail = None;
        let mut diff = None;

        let raw1 = "Pertama";
        let raw2 = "Kedua";
        let k1 = quote_key(raw1);
        let k2 = quote_key(raw2);

        let req = open_detail(
            &mut view,
            &mut detail,
            &mut diff,
            "c1".to_string(),
            1,
            Some(QuoteLang::En),
        );
        assert_eq!(
            req,
            ClientMsg::CardDetail {
                id: 1,
                card_id: "c1".to_string(),
                translate_to: Some(QuoteLang::En),
            }
        );

        // Early push while Loading applies to open detail.
        assert!(route_card_msg(
            &ServerMsg::QuoteSettled {
                card_id: "c1".to_string(),
                quote_key: k2.clone(),
                to: QuoteLang::En,
            },
            &mut view,
            &mut cards,
            &mut detail,
            &mut diff,
            UiLang::En,
        ));
        // Push for a different card is ignored.
        assert!(!route_card_msg(
            &ServerMsg::QuoteTranslated {
                card_id: "other".to_string(),
                item: QuoteTranslation {
                    quote_key: k1.clone(),
                    from: QuoteLang::Id,
                    text: "Ignored".to_string(),
                },
            },
            &mut view,
            &mut cards,
            &mut detail,
            &mut diff,
            UiLang::En,
        ));

        let mut card = sample_card("c1");
        let mut b1 = card.blocks[0].clone();
        b1.seq = 1;
        b1.quote = Some(Quote {
            text: raw1.to_string(),
            shared: false,
        });
        let mut b2 = card.blocks[0].clone();
        b2.seq = 2;
        b2.quote = Some(Quote {
            text: raw2.to_string(),
            shared: false,
        });
        card.blocks = vec![b1, b2];

        assert!(route_card_msg(
            &ServerMsg::CardDetail {
                id: 1,
                card,
                snippets: Vec::new(),
                translations: Vec::new(),
                pending: vec![k1.clone(), k2.clone()],
            },
            &mut view,
            &mut cards,
            &mut detail,
            &mut diff,
            UiLang::En,
        ));

        // Ready state still receives QuoteTranslated.
        assert!(route_card_msg(
            &ServerMsg::QuoteTranslated {
                card_id: "c1".to_string(),
                item: QuoteTranslation {
                    quote_key: k1.clone(),
                    from: QuoteLang::Id,
                    text: "First".to_string(),
                },
            },
            &mut view,
            &mut cards,
            &mut detail,
            &mut diff,
            UiLang::En,
        ));

        let d = detail.as_ref().unwrap();
        let DetailState::Ready(ready) = d.state() else {
            panic!("expected Ready state");
        };
        assert_eq!(d.quote_display(&ready.groups[0], UiLang::En).text, "First");
        assert!(!d.quote_display(&ready.groups[1], UiLang::En).translating);
    }

    #[test]
    fn open_detail_sends_target() {
        use rocky_proto::translate::QuoteTranslation;

        let mut view = View::Agents;
        let mut cards = CardsModel::new();
        let mut detail = None;
        let mut diff = None;

        let req = open_detail(
            &mut view,
            &mut detail,
            &mut diff,
            "c1".to_string(),
            1,
            Some(QuoteLang::En),
        );
        assert_eq!(
            req,
            ClientMsg::CardDetail {
                id: 1,
                card_id: "c1".to_string(),
                translate_to: Some(QuoteLang::En),
            }
        );

        let handled = route_card_msg(
            &ServerMsg::QuoteTranslated {
                card_id: "c1".to_string(),
                item: QuoteTranslation {
                    quote_key: "k1".to_string(),
                    from: QuoteLang::Id,
                    text: "Hello".to_string(),
                },
            },
            &mut view,
            &mut cards,
            &mut detail,
            &mut diff,
            UiLang::En,
        );
        assert!(handled);
    }

    struct ReconnectHarness {
        view: View,
        cards: CardsModel,
        detail: Option<DetailModel>,
        diff: Option<DiffModel>,
        model: crate::view::Model,
        detected: UiLang,
        ui_lang: UiLang,
        last_target: Option<QuoteLang>,
        next_id: u64,
    }

    impl ReconnectHarness {
        fn with_open_en_detail() -> Self {
            use rocky_proto::cards::Quote;
            use rocky_proto::translate::{QuoteTranslation, quote_key};

            let mut view = View::Agents;
            let mut cards = CardsModel::new();
            let mut detail = None;
            let mut diff = None;

            let raw = "Saya periksa parser dulu.";
            let open_id = 1_u64;
            let _ = open_detail(
                &mut view,
                &mut detail,
                &mut diff,
                "c1".to_string(),
                open_id,
                Some(QuoteLang::En),
            );
            let mut card = sample_card("c1");
            card.blocks[0].quote = Some(Quote {
                text: raw.to_string(),
                shared: false,
            });
            assert!(route_card_msg(
                &ServerMsg::CardDetail {
                    id: open_id,
                    card,
                    snippets: Vec::new(),
                    translations: vec![QuoteTranslation {
                        quote_key: quote_key(raw),
                        from: QuoteLang::Id,
                        text: "I checked the parser first.".to_string(),
                    }],
                    pending: Vec::new(),
                },
                &mut view,
                &mut cards,
                &mut detail,
                &mut diff,
                UiLang::En,
            ));

            Self {
                view,
                cards,
                detail,
                diff,
                model: crate::view::Model::new(),
                detected: UiLang::En,
                ui_lang: UiLang::En,
                last_target: Some(QuoteLang::En),
                next_id: 1,
            }
        }

        fn alloc(&mut self) -> u64 {
            self.next_id += 1;
            self.next_id
        }

        fn reconnect(
            &mut self,
            settings: rocky_proto::settings::Settings,
            translate: rocky_proto::translate::TranslateStatus,
        ) -> Vec<ClientMsg> {
            use rocky_proto::pipe::{Health, Status};

            let lang_setting = settings.lang;
            let _ = self.model.apply(ServerMsg::Snapshot {
                agents: Vec::new(),
                aggregate: Status::Idle,
                health: Health::default(),
                settings,
                repo_pending: Vec::new(),
                translate,
            });
            self.ui_lang = crate::i18n::resolve_lang(lang_setting, self.detected);
            let target = crate::translate_model::translate_target(
                self.model.settings(),
                self.model.translate_status(),
                self.ui_lang,
            );
            self.last_target = target;
            let mut next = self.next_id;
            let msgs = on_reconnect(
                &mut self.cards,
                self.detail.as_mut(),
                self.diff.as_mut(),
                target,
                || {
                    next += 1;
                    next
                },
            );
            self.next_id = next;
            msgs
        }
    }

    #[test]
    fn reconnect_enabled_to_off_emits_single_none_detail_request() {
        use rocky_proto::settings::{Lang, Settings};
        use rocky_proto::translate::{TranslatePair, TranslateStatus};

        let mut h = ReconnectHarness::with_open_en_detail();
        let settings = Settings {
            lang: Lang::En,
            translate_quotes: false,
            ..Settings::default()
        };
        let translate = TranslateStatus {
            ready: vec![TranslatePair::to(QuoteLang::En)],
            ..TranslateStatus::default()
        };
        let emitted = h.reconnect(settings, translate);

        let detail_reqs: Vec<_> = emitted
            .into_iter()
            .filter(|m| matches!(m, ClientMsg::CardDetail { .. }))
            .collect();
        assert_eq!(
            detail_reqs,
            vec![ClientMsg::CardDetail {
                id: 3,
                card_id: "c1".to_string(),
                translate_to: None,
            }]
        );
        assert_eq!(h.last_target, None);
        let id = h.alloc();
        assert_eq!(h.detail.as_mut().unwrap().retarget(id, h.last_target), None);
        assert_eq!(h.view, View::CardDetail);
    }

    #[test]
    fn reconnect_english_to_indonesian_emits_single_indonesian_detail_request() {
        use rocky_proto::settings::{Lang, Settings};
        use rocky_proto::translate::{TranslatePair, TranslateStatus};

        let mut h = ReconnectHarness::with_open_en_detail();
        let settings = Settings {
            lang: Lang::Id,
            translate_quotes: true,
            ..Settings::default()
        };
        let translate = TranslateStatus {
            ready: vec![
                TranslatePair::to(QuoteLang::En),
                TranslatePair::to(QuoteLang::Id),
            ],
            ..TranslateStatus::default()
        };
        let emitted = h.reconnect(settings, translate);

        assert_eq!(h.ui_lang, UiLang::Id);
        let detail_reqs: Vec<_> = emitted
            .into_iter()
            .filter(|m| matches!(m, ClientMsg::CardDetail { .. }))
            .collect();
        assert_eq!(
            detail_reqs,
            vec![ClientMsg::CardDetail {
                id: 3,
                card_id: "c1".to_string(),
                translate_to: Some(QuoteLang::Id),
            }]
        );
        assert_eq!(h.last_target, Some(QuoteLang::Id));
        let id = h.alloc();
        assert_eq!(h.detail.as_mut().unwrap().retarget(id, h.last_target), None);
        assert_eq!(h.view, View::CardDetail);
    }
}
