//! Quote translation routing through card navigation.

use super::tests::sample_card;
use super::*;
use crate::card_detail_model::DetailState;

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
fn route_card_msg_applies_card_detail_translations_and_pending() {
    use rocky_proto::cards::Quote;
    use rocky_proto::translate::{QuoteTranslation, quote_key};

    let mut view = View::Agents;
    let mut cards = CardsModel::new();
    let mut detail = None;
    let mut diff = None;

    let raw0 = "Pertama";
    let raw1 = "Kedua";
    let k0 = quote_key(raw0);
    let k1 = quote_key(raw1);

    let _ = open_detail(
        &mut view,
        &mut detail,
        &mut diff,
        "c1".to_string(),
        1,
        Some(QuoteLang::En),
    );

    let mut card = sample_card("c1");
    let mut b0 = card.blocks[0].clone();
    b0.seq = 1;
    b0.quote = Some(Quote {
        text: raw0.to_string(),
        shared: false,
    });
    let mut b1 = card.blocks[0].clone();
    b1.seq = 2;
    b1.quote = Some(Quote {
        text: raw1.to_string(),
        shared: false,
    });
    card.blocks = vec![b0, b1];

    assert!(route_card_msg(
        &ServerMsg::CardDetail {
            id: 1,
            card,
            snippets: Vec::new(),
            translations: vec![QuoteTranslation {
                quote_key: k0,
                from: QuoteLang::Id,
                text: "First".to_string(),
            }],
            pending: vec![k1],
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
    let disp0 = d.quote_display(&ready.groups[0], UiLang::En);
    assert_eq!(disp0.text, "First");
    assert_eq!(disp0.translated_from, Some(QuoteLang::Id));
    assert!(!disp0.translating);

    let disp1 = d.quote_display(&ready.groups[1], UiLang::En);
    assert_eq!(disp1.text, raw1);
    assert_eq!(disp1.translated_from, None);
    assert!(disp1.translating);
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

    assert!(emitted.iter().any(|m| matches!(
        m,
        ClientMsg::Cards {
            translate_to: Some(QuoteLang::Id),
            ..
        }
    )));
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
    assert_eq!(h.cards.set_target(h.last_target, id), None);
    let id = h.alloc();
    assert_eq!(h.detail.as_mut().unwrap().retarget(id, h.last_target), None);
    assert_eq!(h.view, View::CardDetail);
}

#[test]
fn route_card_msg_routes_cards_translations() {
    use rocky_proto::cards::Quote;
    use rocky_proto::translate::{QuoteTranslation, quote_key};

    let mut view = View::Agents;
    let mut cards = CardsModel::new();
    let mut detail = None;
    let mut diff = None;

    let raw = "Merah.";
    let req = cards.set_target(Some(QuoteLang::En), 1).unwrap();
    assert!(matches!(
        req,
        ClientMsg::Cards {
            id: 1,
            translate_to: Some(QuoteLang::En),
            ..
        }
    ));

    let mut card = sample_card("c1");
    card.blocks[0].quote = Some(Quote {
        text: raw.to_string(),
        shared: false,
    });

    assert!(route_card_msg(
        &ServerMsg::Cards {
            id: 1,
            items: vec![card],
            next: None,
            translations: vec![QuoteTranslation {
                quote_key: quote_key(raw),
                from: QuoteLang::Id,
                text: "Red.".to_string(),
            }],
        },
        &mut view,
        &mut cards,
        &mut detail,
        &mut diff,
        UiLang::En,
    ));

    let rows = cards.rows(UiLang::En);
    assert!(rows[0].edits[0].tooltip.iter().any(|l| l.text == "Red."));
    assert!(
        rows[0].edits[0]
            .tooltip
            .iter()
            .any(|l| l.text == "translated from Indonesian")
    );
}
