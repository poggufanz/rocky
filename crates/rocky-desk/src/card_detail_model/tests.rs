use rocky_proto::cards::{
    Block, BlockSymbol, BlockVia, CARD_VERSION, Card, CardStatus, Coverage, CoverageReason,
    CoverageState, FlowKind, FlowStep, Importance, Label, Quote, SymbolKind,
};
use rocky_proto::pipe::{BlockSnippet, ClientMsg, DiffLine, DiffLineKind, SnippetLine};

use super::*;
use crate::i18n::UiLang;

pub(super) fn sample_card(id: &str, started_ms: u64, ended_ms: Option<u64>) -> Card {
    Card {
        v: CARD_VERSION,
        card_id: id.to_string(),
        rev: 1,
        repo_id: "repo-1".to_string(),
        root: "/work/rocky".to_string(),
        main_root: Some("/work/rocky".to_string()),
        branch: Some("feat/cards".to_string()),
        session_id: "sess-1".to_string(),
        agent_id: String::new(),
        agent_type: String::new(),
        parent_card_id: None,
        started_ms,
        ended_ms,
        status: CardStatus::Done,
        prompt: "Fix discount calculation".to_string(),
        prompt_truncated: false,
        importance: Importance::Medium,
        blocks: Vec::new(),
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

pub(super) fn sample_block(seq: u32, path: &str, labels: Vec<Label>) -> Block {
    Block {
        seq,
        path: path.to_string(),
        symbol: None,
        labels,
        importance: Importance::Medium,
        via: BlockVia::Edit,
        tool_use_ids: vec![format!("tu-{seq}")],
        bash: None,
        before: Some("sha-before".to_string()),
        after: Some("sha-after".to_string()),
        recorded: true,
        line: Some(12),
        added: Some(3),
        removed: Some(1),
        quote: None,
    }
}

#[test]
fn detail_request_and_ready() {
    let (mut model, req) = DetailModel::open("card-42".to_string(), 7);
    assert_eq!(
        req,
        ClientMsg::CardDetail {
            id: 7,
            card_id: "card-42".to_string(),
        }
    );
    assert_eq!(model.card_id(), "card-42");
    assert_eq!(model.state(), &DetailState::Loading);

    let long_prompt = format!("{}\nSecond line\nThird line", "p".repeat(250));
    let mut card = sample_card("card-42", 10_000, Some(135_000));
    card.prompt = long_prompt.clone();
    card.main_root = Some("C:\\Work\\MyApp".to_string());
    card.root = "C:\\Work\\MyApp-wt".to_string();
    card.branch = Some("main".to_string());

    model.on_detail(7, card.clone(), Vec::new(), UiLang::Id);
    let DetailState::Ready(view) = model.state() else {
        panic!("expected Ready state");
    };
    assert_eq!(view.prompt, long_prompt);
    assert_eq!(
        view.meta,
        "MyApp \u{00b7} main \u{00b7} 2 mnt \u{00b7} utama"
    );

    // Re-open in English with sub-minute duration and subagent type.
    let (mut en_model, en_req) = DetailModel::open("card-43".to_string(), 8);
    assert_eq!(
        en_req,
        ClientMsg::CardDetail {
            id: 8,
            card_id: "card-43".to_string(),
        }
    );
    let mut sub = sample_card("card-43", 5_000, Some(50_000));
    sub.agent_id = "sub-1".to_string();
    sub.agent_type = "Explore".to_string();
    sub.branch = None;
    en_model.on_detail(8, sub, Vec::new(), UiLang::En);
    let DetailState::Ready(en_view) = en_model.state() else {
        panic!("expected Ready state");
    };
    assert_eq!(en_view.meta, "rocky \u{00b7} 45 s \u{00b7} Explore");

    // Open card (no ended_ms) omits duration without extra separators.
    let (mut open_model, _) = DetailModel::open("card-44".to_string(), 9);
    let open_card = sample_card("card-44", 5_000, None);
    open_model.on_detail(9, open_card, Vec::new(), UiLang::Id);
    let DetailState::Ready(open_view) = open_model.state() else {
        panic!("expected Ready state");
    };
    assert_eq!(open_view.meta, "rocky \u{00b7} feat/cards \u{00b7} utama");
}

#[test]
fn stale_reply_ignored() {
    let (mut detail, _) = DetailModel::open("c1".to_string(), 10);
    detail.on_detail(
        9,
        sample_card("stale", 1_000, Some(2_000)),
        Vec::new(),
        UiLang::Id,
    );
    assert_eq!(detail.state(), &DetailState::Loading);

    detail.on_ack(9, false, Some("not_found"));
    assert_eq!(detail.state(), &DetailState::Loading);

    detail.on_detail(
        10,
        sample_card("c1", 1_000, Some(2_000)),
        Vec::new(),
        UiLang::Id,
    );
    assert!(matches!(detail.state(), DetailState::Ready(_)));

    // Unsolicited reply after pending id cleared is also ignored.
    detail.on_ack(10, false, Some("not_found"));
    assert!(matches!(detail.state(), DetailState::Ready(_)));
    let mut replacement = sample_card("c1", 1_000, Some(2_000));
    replacement.prompt = "Should not overwrite".to_string();
    detail.on_detail(10, replacement, Vec::new(), UiLang::Id);
    let DetailState::Ready(view) = detail.state() else {
        panic!("expected Ready state");
    };
    assert_eq!(view.prompt, "Fix discount calculation");

    // DiffModel ignores stale diff and Ack replies, including superseded page requests.
    let (mut diff, _) = DiffModel::open("c1".to_string(), 1, 20);
    diff.on_diff(19, Vec::new(), 0, 3, true);
    assert_eq!(diff.state(), &DiffState::Loading);
    diff.on_ack(19, false, Some("not_found"));
    assert_eq!(diff.state(), &DiffState::Loading);

    diff.on_diff(
        20,
        vec![DiffLine {
            kind: DiffLineKind::Context,
            text: "fn a() {}".to_string(),
        }],
        0,
        3,
        false,
    );
    assert!(matches!(
        diff.state(),
        DiffState::Page {
            page: 0,
            pages: 3,
            ..
        }
    ));

    assert!(diff.go(1, 21).is_some());
    assert!(diff.go(2, 22).is_some());
    diff.on_diff(
        21,
        vec![DiffLine {
            kind: DiffLineKind::Added,
            text: "page 1 stale".to_string(),
        }],
        1,
        3,
        false,
    );
    assert_eq!(diff.state(), &DiffState::Loading);
    diff.on_ack(21, false, Some("not_found"));
    assert_eq!(diff.state(), &DiffState::Loading);

    diff.on_diff(
        22,
        vec![DiffLine {
            kind: DiffLineKind::Added,
            text: "page 2 fresh".to_string(),
        }],
        2,
        3,
        false,
    );
    assert_eq!(
        diff.state(),
        &DiffState::Page {
            lines: vec![DiffLine {
                kind: DiffLineKind::Added,
                text: "page 2 fresh".to_string(),
            }],
            page: 2,
            pages: 3,
        }
    );
}

#[test]
fn not_found_ack_ends_loading() {
    // ok == true leaves Loading state unchanged for both DetailModel and DiffModel.
    let (mut detail, _) = DetailModel::open("c1".to_string(), 1);
    detail.on_ack(1, true, None);
    assert_eq!(detail.state(), &DetailState::Loading);
    detail.on_ack(1, false, Some("not_found"));
    assert_eq!(detail.state(), &DetailState::NotFound);
    assert_eq!(detail.error_count(), 0);

    let (mut detail_err, _) = DetailModel::open("c2".to_string(), 2);
    detail_err.on_ack(2, false, Some("too_large"));
    assert_eq!(detail_err.state(), &DetailState::NotFound);
    assert_eq!(detail_err.error_count(), 1);

    let (mut diff, _) = DiffModel::open("c1".to_string(), 4, 3);
    diff.on_ack(3, true, None);
    assert_eq!(diff.state(), &DiffState::Loading);
    diff.on_ack(3, false, Some("not_found"));
    assert_eq!(diff.state(), &DiffState::NotFound);
    assert_eq!(diff.error_count(), 0);

    let (mut diff_err, _) = DiffModel::open("c1".to_string(), 4, 4);
    diff_err.on_ack(4, false, None);
    assert_eq!(diff_err.state(), &DiffState::NotFound);
    assert_eq!(diff_err.error_count(), 1);
}

#[test]
fn quote_groups_share_consecutive_quotes() {
    let (mut model, _) = DetailModel::open("c1".to_string(), 1);
    let mut card = sample_card("c1", 1_000, Some(5_000));

    let long_quote = format!("{}\nsecond paragraph", "q".repeat(260));
    let mut b1 = sample_block(
        1,
        "src/auth.rs",
        vec![Label::GuardAdded {}, Label::ReturnChanged {}],
    );
    b1.importance = Importance::High;
    b1.symbol = Some(BlockSymbol {
        kind: SymbolKind::Function,
        name: "verify".to_string(),
        container: None,
        exported: true,
        nth: 0,
    });
    b1.quote = Some(Quote {
        text: long_quote.clone(),
        shared: true,
    });

    let mut b2 = sample_block(2, "src/session.rs", vec![Label::BodyChanged {}]);
    b2.symbol = Some(BlockSymbol {
        kind: SymbolKind::Struct,
        name: "Session".to_string(),
        container: None,
        exported: false,
        nth: 0,
    });
    b2.quote = Some(Quote {
        text: long_quote.clone(),
        shared: true,
    });

    let mut b3 = sample_block(3, "src/token.rs", vec![Label::SymbolAdded {}]);
    b3.symbol = Some(BlockSymbol {
        kind: SymbolKind::Method,
        name: "issue".to_string(),
        container: Some("Signer".to_string()),
        exported: false,
        nth: 0,
    });
    b3.quote = Some(Quote {
        text: "Issue fresh tokens".to_string(),
        shared: false,
    });

    let mut b4 = sample_block(4, "src/extra.rs", vec![Label::BodyChanged {}]);
    b4.quote = Some(Quote {
        text: long_quote.clone(),
        shared: false,
    });

    card.blocks = vec![b1, b2, b3, b4];
    model.on_detail(1, card, Vec::new(), UiLang::Id);

    let DetailState::Ready(view) = model.state() else {
        panic!("expected Ready state");
    };
    assert_eq!(view.groups.len(), 3);

    assert_eq!(view.groups[0].quote.as_deref(), Some(long_quote.as_str()));
    assert_eq!(
        view.groups[0].quote_line(UiLang::Id),
        (long_quote.clone(), false)
    );
    assert_eq!(view.groups[0].blocks.len(), 2);
    assert_eq!(view.groups[0].blocks[0].seq, 1);
    assert_eq!(
        view.groups[0].blocks[0].head,
        "src/auth.rs \u{203a} verify()"
    );
    assert_eq!(
        view.groups[0].blocks[0].chips,
        vec![
            ("guard baru".to_string(), true),
            ("return diubah".to_string(), true),
        ]
    );
    assert_eq!(
        view.groups[0].blocks[1].head,
        "src/session.rs \u{203a} Session"
    );
    assert_eq!(
        view.groups[0].blocks[1].chips,
        vec![("isi diubah".to_string(), false)]
    );

    assert_eq!(view.groups[1].quote.as_deref(), Some("Issue fresh tokens"));
    assert_eq!(view.groups[1].blocks.len(), 1);
    assert_eq!(
        view.groups[1].blocks[0].head,
        "src/token.rs \u{203a} issue()"
    );
    assert_eq!(
        view.groups[1].blocks[0].chips,
        vec![("method baru".to_string(), false)]
    );

    // Non-consecutive block with the same quote stays a separate group.
    assert_eq!(view.groups[2].quote.as_deref(), Some(long_quote.as_str()));
    assert_eq!(view.groups[2].blocks.len(), 1);
    assert_eq!(view.groups[2].blocks[0].head, "src/extra.rs");
}

#[test]
fn missing_quote_shows_dim_line() {
    let (mut model, _) = DetailModel::open("c1".to_string(), 1);
    let mut card = sample_card("c1", 1_000, Some(2_000));

    let b1 = sample_block(1, "src/a.rs", vec![Label::BodyChanged {}]);
    let mut b2 = sample_block(2, "src/b.rs", vec![Label::BodyChanged {}]);
    b2.quote = Some(Quote {
        text: "   \n\t ".to_string(),
        shared: false,
    });
    let mut b3 = sample_block(3, "src/c.rs", vec![Label::BodyChanged {}]);
    b3.quote = Some(Quote {
        text: "Explained".to_string(),
        shared: false,
    });

    card.blocks = vec![b1, b2, b3];
    model.on_detail(1, card.clone(), Vec::new(), UiLang::Id);
    let DetailState::Ready(id_view) = model.state() else {
        panic!("expected Ready state");
    };
    assert_eq!(id_view.groups.len(), 2);
    assert_eq!(id_view.groups[0].quote, None);
    assert_eq!(id_view.groups[0].blocks.len(), 2);
    assert_eq!(
        id_view.groups[0].quote_line(UiLang::Id),
        ("Kata agent tidak tercatat di edit ini".to_string(), true)
    );
    assert_eq!(
        id_view.groups[0].quote_line(UiLang::En),
        ("No agent words recorded for this edit".to_string(), true)
    );

    assert_eq!(id_view.groups[1].quote.as_deref(), Some("Explained"));
    assert_eq!(
        id_view.groups[1].quote_line(UiLang::En),
        ("Explained".to_string(), false)
    );
}

#[test]
fn snippet_lines_map_and_fold_text() {
    let (mut model, _) = DetailModel::open("c1".to_string(), 1);
    let mut card = sample_card("c1", 1_000, Some(2_000));
    card.blocks = vec![
        sample_block(1, "src/a.rs", vec![Label::BodyChanged {}]),
        sample_block(2, "src/b.rs", vec![Label::BodyChanged {}]),
    ];
    let snippets = vec![BlockSnippet {
        seq: 1,
        lines: vec![
            SnippetLine::Context {
                text: "fn calc(x: i32) -> i32 {".to_string(),
            },
            SnippetLine::Fold { lines: 4 },
            SnippetLine::Removed {
                text: "    x".to_string(),
            },
            SnippetLine::Added {
                text: "    x * 2".to_string(),
            },
            SnippetLine::More { lines: 9 },
        ],
    }];

    model.on_detail(1, card.clone(), snippets.clone(), UiLang::Id);
    let DetailState::Ready(id_view) = model.state() else {
        panic!("expected Ready state");
    };
    assert_eq!(
        id_view.groups[0].blocks[0].code,
        vec![
            CodeLine::Context("fn calc(x: i32) -> i32 {".to_string()),
            CodeLine::Fold("\u{2026} 4 baris".to_string()),
            CodeLine::Removed("    x".to_string()),
            CodeLine::Added("    x * 2".to_string()),
            CodeLine::Fold("\u{2026} 9 baris lagi".to_string()),
        ]
    );
    assert!(id_view.groups[0].blocks[1].code.is_empty());

    let (mut en_model, _) = DetailModel::open("c1".to_string(), 2);
    en_model.on_detail(2, card, snippets, UiLang::En);
    let DetailState::Ready(en_view) = en_model.state() else {
        panic!("expected Ready state");
    };
    assert_eq!(
        en_view.groups[0].blocks[0].code[1],
        CodeLine::Fold("\u{2026} 4 lines".to_string())
    );
    assert_eq!(
        en_view.groups[0].blocks[0].code[4],
        CodeLine::Fold("\u{2026} 9 more lines".to_string())
    );
}

#[test]
fn timeline_steps_with_subs_and_facts() {
    let (mut model, _) = DetailModel::open("c1".to_string(), 1);
    let mut card = sample_card("c1", 1_000, Some(90_000));

    let mut b1 = sample_block(1, "src/auth.rs", vec![Label::GuardAdded {}]);
    b1.symbol = Some(BlockSymbol {
        kind: SymbolKind::Function,
        name: "login".to_string(),
        container: None,
        exported: false,
        nth: 0,
    });
    b1.line = Some(42);

    let mut b2 = sample_block(2, "src/auth.rs", vec![Label::ReturnChanged {}]);
    b2.line = None;
    b2.added = Some(3);
    b2.removed = Some(1);

    let mut b3 = sample_block(3, "src/auth.rs", vec![Label::BodyChanged {}]);
    b3.line = None;
    b3.added = None;
    b3.removed = None;

    let mut b4 = sample_block(4, "src/auth.rs", vec![Label::LoopAdded {}]);
    b4.line = Some(99);

    card.blocks = vec![b1, b2, b3, b4];
    card.flow = vec![
        FlowStep {
            kind: FlowKind::Cmd,
            text: "cargo test\n-p rocky-desk".to_string(),
            ok: true,
            dur_ms: 8_000,
            seqs: Vec::new(),
        },
        FlowStep {
            kind: FlowKind::Edit,
            text: "src/auth.rs \u{203a} login".to_string(),
            ok: false,
            dur_ms: 65_000,
            seqs: vec![1, 999, 2, 3, 4],
        },
    ];

    model.on_detail(1, card.clone(), Vec::new(), UiLang::Id);
    let DetailState::Ready(id_view) = model.state() else {
        panic!("expected Ready state");
    };
    assert_eq!(id_view.timeline.len(), 2);
    assert_eq!(
        id_view.timeline[0],
        Step {
            ok: true,
            kind: FlowKind::Cmd,
            title: "cargo test -p rocky-desk".to_string(),
            dur: "8s".to_string(),
            subs: Vec::new(),
        }
    );
    assert_eq!(
        id_view.timeline[1],
        Step {
            ok: false,
            kind: FlowKind::Edit,
            title: "src/auth.rs \u{203a} login".to_string(),
            dur: "1m 5s".to_string(),
            subs: vec![
                ("guard baru".to_string(), "src/auth.rs:42".to_string()),
                ("return diubah".to_string(), "+3 \u{2212}1".to_string()),
                ("isi diubah".to_string(), String::new()),
            ],
        }
    );

    let (mut en_model, _) = DetailModel::open("c1".to_string(), 2);
    en_model.on_detail(2, card, Vec::new(), UiLang::En);
    let DetailState::Ready(en_view) = en_model.state() else {
        panic!("expected Ready state");
    };
    assert_eq!(
        en_view.timeline[1].subs,
        vec![
            ("new guard".to_string(), "src/auth.rs:42".to_string()),
            ("return changed".to_string(), "+3 \u{2212}1".to_string()),
            ("body changed".to_string(), String::new()),
        ]
    );
}

#[test]
fn timeline_caps_12_and_counts_flow_more() {
    let make_step = |idx: usize| FlowStep {
        kind: FlowKind::Cmd,
        text: format!("cmd-{idx}"),
        ok: true,
        dur_ms: 60_000,
        seqs: Vec::new(),
    };

    // Exactly 12 with flow_more == 0 -> no overflow line.
    let (mut exact_model, _) = DetailModel::open("c1".to_string(), 1);
    let mut exact = sample_card("c1", 1_000, Some(2_000));
    exact.flow = (1..=12).map(make_step).collect();
    exact_model.on_detail(1, exact, Vec::new(), UiLang::Id);
    let DetailState::Ready(exact_view) = exact_model.state() else {
        panic!("expected Ready state");
    };
    assert_eq!(exact_view.timeline.len(), 12);
    assert_eq!(exact_view.timeline[0].dur, "1m");
    assert_eq!(exact_view.timeline_more, None);

    // 15 flow steps + flow_more 4 -> 12 displayed, +7 steps remaining.
    let (mut over_model, _) = DetailModel::open("c2".to_string(), 2);
    let mut over = sample_card("c2", 1_000, Some(2_000));
    over.flow = (1..=15).map(make_step).collect();
    over.flow_more = 4;
    over_model.on_detail(2, over.clone(), Vec::new(), UiLang::Id);
    let DetailState::Ready(over_id) = over_model.state() else {
        panic!("expected Ready state");
    };
    assert_eq!(over_id.timeline.len(), 12);
    assert_eq!(over_id.timeline[11].title, "cmd-12");
    assert_eq!(over_id.timeline_more.as_deref(), Some("+7 langkah"));

    let (mut en_model, _) = DetailModel::open("c2".to_string(), 3);
    en_model.on_detail(3, over, Vec::new(), UiLang::En);
    let DetailState::Ready(over_en) = en_model.state() else {
        panic!("expected Ready state");
    };
    assert_eq!(over_en.timeline_more.as_deref(), Some("+7 more steps"));
}

#[test]
fn coverage_and_outside_lines() {
    let (mut full_model, _) = DetailModel::open("c1".to_string(), 1);
    let full = sample_card("c1", 1_000, Some(2_000));
    full_model.on_detail(1, full.clone(), Vec::new(), UiLang::Id);
    let DetailState::Ready(full_id) = full_model.state() else {
        panic!("expected Ready state");
    };
    assert_eq!(full_id.coverage, "Rekaman lengkap");
    assert_eq!(full_id.outside, None);

    let (mut en_full, _) = DetailModel::open("c1".to_string(), 2);
    en_full.on_detail(2, full, Vec::new(), UiLang::En);
    let DetailState::Ready(full_en) = en_full.state() else {
        panic!("expected Ready state");
    };
    assert_eq!(full_en.coverage, "Full record");
    assert_eq!(full_en.outside, None);

    let (mut partial_model, _) = DetailModel::open("c2".to_string(), 3);
    let mut partial = sample_card("c2", 1_000, Some(2_000));
    partial.coverage = Coverage {
        state: CoverageState::Partial,
        reasons: vec![CoverageReason::DaemonGap, CoverageReason::CaptureLate],
    };
    partial.outside_count = 3;
    partial_model.on_detail(3, partial.clone(), Vec::new(), UiLang::Id);
    let DetailState::Ready(partial_id) = partial_model.state() else {
        panic!("expected Ready state");
    };
    assert_eq!(
        partial_id.coverage,
        "Sebagian \u{00b7} daemon sempat mati, rekaman terlambat"
    );
    assert_eq!(
        partial_id.outside.as_deref(),
        Some("3 file berubah di luar agent")
    );

    let (mut en_partial, _) = DetailModel::open("c2".to_string(), 4);
    en_partial.on_detail(4, partial, Vec::new(), UiLang::En);
    let DetailState::Ready(partial_en) = en_partial.state() else {
        panic!("expected Ready state");
    };
    assert_eq!(
        partial_en.coverage,
        "Partial \u{00b7} daemon was down, capture late"
    );
    assert_eq!(
        partial_en.outside.as_deref(),
        Some("3 files changed outside the agent")
    );
}

#[test]
fn diff_pages_navigate_and_missing() {
    let (mut model, open_msg) = DiffModel::open("card-1".to_string(), 3, 1);
    assert_eq!(
        open_msg,
        ClientMsg::BlockDiff {
            id: 1,
            card_id: "card-1".to_string(),
            seq: 3,
            page: 0,
        }
    );
    assert_eq!(model.card_id(), "card-1");
    assert_eq!(model.seq(), 3);
    assert_eq!(model.page(), 0);
    assert_eq!(model.state(), &DiffState::Loading);

    // Cannot navigate before page count is known.
    assert!(model.go(1, 2).is_none());

    let page0 = vec![DiffLine {
        kind: DiffLineKind::Context,
        text: "line 0".to_string(),
    }];
    model.on_diff(1, page0.clone(), 0, 2, false);
    assert_eq!(
        model.state(),
        &DiffState::Page {
            lines: page0,
            page: 0,
            pages: 2,
        }
    );

    // Out-of-bounds page returns None.
    assert!(model.go(2, 2).is_none());

    let page1_req = model.go(1, 2);
    assert_eq!(
        page1_req,
        Some(ClientMsg::BlockDiff {
            id: 2,
            card_id: "card-1".to_string(),
            seq: 3,
            page: 1,
        })
    );
    assert_eq!(model.state(), &DiffState::Loading);
    assert_eq!(model.page(), 1);

    let page1 = vec![DiffLine {
        kind: DiffLineKind::Added,
        text: "line 1".to_string(),
    }];
    model.on_diff(2, page1.clone(), 1, 2, false);
    assert_eq!(
        model.state(),
        &DiffState::Page {
            lines: page1,
            page: 1,
            pages: 2,
        }
    );

    // Missing response ends loading and blocks further navigation.
    assert!(model.go(0, 3).is_some());
    model.on_diff(3, Vec::new(), 0, 0, true);
    assert_eq!(model.state(), &DiffState::Missing);
    assert!(model.go(0, 4).is_none());
}

#[test]
fn unrecorded_block_not_diffable() {
    let (mut model, _) = DetailModel::open("c1".to_string(), 1);
    let mut card = sample_card("c1", 1_000, Some(2_000));
    card.root = "/work/rocky".to_string();

    let mut unrecorded = sample_block(1, "src/lib.rs", Vec::new());
    unrecorded.recorded = false;

    let mut outside = sample_block(2, "~/secret.txt", Vec::new());
    outside.recorded = false;
    outside.before = None;
    outside.after = None;

    let mut path_only = sample_block(3, "src/big.bin", vec![Label::TooLarge {}]);
    path_only.recorded = true;
    path_only.before = None;
    path_only.after = None;

    let mut new_file = sample_block(4, "src/new.rs", vec![Label::FileNew {}]);
    new_file.recorded = true;
    new_file.before = None;
    new_file.after = Some("sha-new".to_string());

    let mut deleted_file = sample_block(5, "src/old.rs", vec![Label::FileDeleted {}]);
    deleted_file.recorded = true;
    deleted_file.before = Some("sha-old".to_string());
    deleted_file.after = None;

    card.blocks = vec![unrecorded, outside, path_only, new_file, deleted_file];
    model.on_detail(1, card, Vec::new(), UiLang::Id);

    let DetailState::Ready(view) = model.state() else {
        panic!("expected Ready state");
    };
    assert_eq!(view.groups.len(), 1);
    let blocks = &view.groups[0].blocks;
    assert_eq!(blocks.len(), 5);

    assert!(!blocks[0].diffable);
    assert_eq!(blocks[0].chips, vec![("tidak direkam".to_string(), false)]);

    assert!(!blocks[1].diffable);
    assert_eq!(blocks[1].chips, vec![("di luar repo".to_string(), false)]);

    assert!(!blocks[2].diffable);
    assert_eq!(blocks[2].chips, vec![("terlalu besar".to_string(), false)]);

    assert!(blocks[3].diffable);
    assert!(blocks[4].diffable);
}
