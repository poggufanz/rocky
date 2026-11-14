use rocky_proto::cards::{
    BashInfo, Block, BlockSymbol, BlockVia, CARD_VERSION, Card, CardStatus, Coverage,
    CoverageState, Importance, Label, Quote, SymbolKind,
};
use rocky_proto::pipe::ClientMsg;

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
        branch: Some("main".to_string()),
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
fn first_page_request_shape() {
    let mut model = CardsModel::new();
    assert!(!model.loading());
    assert!(!model.has_more());

    let msg = model.request_first_page(7);
    assert_eq!(
        msg,
        ClientMsg::Cards {
            id: 7,
            query: None,
            before: None,
            limit: 20,
        }
    );
    assert!(model.loading());

    let q_msg = model.set_query("auth".to_string(), 8);
    assert_eq!(
        q_msg,
        ClientMsg::Cards {
            id: 8,
            query: Some("auth".to_string()),
            before: None,
            limit: 20,
        }
    );
    assert_eq!(model.query(), "auth");
    assert!(model.loading());

    let refresh = model.request_first_page(9);
    assert_eq!(
        refresh,
        ClientMsg::Cards {
            id: 9,
            query: Some("auth".to_string()),
            before: None,
            limit: 20,
        }
    );
}

#[test]
fn more_uses_next_cursor_and_stops_at_none() {
    let mut model = CardsModel::new();
    assert!(model.request_more(1).is_none());

    let _ = model.request_first_page(1);
    assert!(model.request_more(2).is_none());

    model.on_cards(
        1,
        vec![sample_card("c2", 1_000, Some(2_000))],
        Some("2000:c2".to_string()),
    );
    assert!(!model.loading());
    assert!(model.has_more());

    let more = model.request_more(2);
    assert_eq!(
        more,
        Some(ClientMsg::Cards {
            id: 2,
            query: None,
            before: Some("2000:c2".to_string()),
            limit: 20,
        })
    );
    assert!(model.loading());
    assert!(model.request_more(3).is_none());

    model.on_cards(2, vec![sample_card("c1", 500, Some(1_000))], None);
    assert!(!model.loading());
    assert!(!model.has_more());
    assert!(model.request_more(3).is_none());

    let ids: Vec<String> = model
        .rows(UiLang::En)
        .into_iter()
        .map(|r| r.card_id)
        .collect();
    assert_eq!(ids, vec!["c2", "c1"]);
}

#[test]
fn stale_reply_ignored() {
    let mut model = CardsModel::new();
    // Unsolicited reply with no pending request is ignored.
    model.on_cards(99, vec![sample_card("ghost", 100, Some(200))], None);
    assert!(model.rows(UiLang::En).is_empty());

    let _ = model.request_first_page(10);
    let _ = model.set_query("discount".to_string(), 11);

    // Stale reply for id 10 must not clear loading or populate items.
    model.on_cards(
        10,
        vec![sample_card("stale", 100, Some(200))],
        Some("200:stale".to_string()),
    );
    assert!(model.loading());
    assert!(!model.has_more());
    assert!(model.rows(UiLang::En).is_empty());

    let mut fresh = sample_card("fresh", 300, Some(400));
    fresh.blocks.push(sample_block(
        1,
        "src/discount.rs",
        vec![Label::BodyChanged {}],
    ));
    model.on_cards(11, vec![fresh], None);
    assert!(!model.loading());
    let rows = model.rows(UiLang::En);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].card_id, "fresh");
}

#[test]
fn push_respects_query_and_replaces_revision() {
    let mut model = CardsModel::new();
    let _ = model.request_first_page(1);
    model.on_cards(
        1,
        vec![
            sample_card("c3", 2_000, Some(3_000)),
            sample_card("c1", 500, Some(1_000)),
        ],
        None,
    );

    // Insert new card between c3 (3000) and c1 (1000).
    model.on_push(sample_card("c2", 1_500, Some(2_000)));
    let ids: Vec<String> = model
        .rows(UiLang::En)
        .into_iter()
        .map(|r| r.card_id)
        .collect();
    assert_eq!(ids, vec!["c3", "c2", "c1"]);

    // Older or equal revision is ignored.
    let mut same_rev = sample_card("c2", 1_500, Some(9_000));
    same_rev.prompt = "Should not replace".to_string();
    model.on_push(same_rev);
    assert_eq!(model.rows(UiLang::En)[1].title, "Fix discount calculation");

    // Higher revision replaces in place, never twice.
    let mut rev2 = sample_card("c2", 1_500, Some(9_000));
    rev2.rev = 2;
    rev2.prompt = "Updated prompt".to_string();
    model.on_push(rev2);
    let rows = model.rows(UiLang::En);
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[1].card_id, "c2");
    assert_eq!(rows[1].title, "Updated prompt");

    // Active query filtering on push.
    let _ = model.set_query("auth".to_string(), 2);
    model.on_cards(2, Vec::new(), None);

    let mut non_matching = sample_card("no-match", 3_000, Some(4_000));
    non_matching.blocks.push(sample_block(
        1,
        "src/billing.rs",
        vec![Label::BodyChanged {}],
    ));
    model.on_push(non_matching);
    assert!(model.rows(UiLang::En).is_empty());

    let mut path_matching = sample_card("match-path", 3_100, Some(4_100));
    path_matching.blocks.push(sample_block(
        1,
        "src/AUTH/login.rs",
        vec![Label::BodyChanged {}],
    ));
    model.on_push(path_matching);

    let mut repo_matching = sample_card("match-repo", 2_500, Some(3_500));
    repo_matching.main_root = None;
    repo_matching.root = "C:\\work\\AuthService".to_string();
    model.on_push(repo_matching);

    let ids: Vec<String> = model
        .rows(UiLang::En)
        .into_iter()
        .map(|r| r.card_id)
        .collect();
    assert_eq!(ids, vec!["match-path", "match-repo"]);

    // Higher revision of matched card replaces in place while searching.
    let mut rev2_match = sample_card("match-path", 3_100, Some(4_200));
    rev2_match.rev = 2;
    rev2_match.prompt = "Auth v2".to_string();
    rev2_match.blocks.push(sample_block(
        1,
        "src/AUTH/login.rs",
        vec![Label::BodyChanged {}],
    ));
    model.on_push(rev2_match);
    let rows = model.rows(UiLang::En);
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].title, "Auth v2");
}

#[test]
fn subagent_nests_under_parent_on_page() {
    let mut model = CardsModel::new();
    let _ = model.request_first_page(1);

    let mut parent = sample_card("parent", 1_000, Some(5_000));
    parent.prompt = "Refactor parser".to_string();

    let mut other = sample_card("other", 2_000, Some(4_500));
    other.prompt = "Other task".to_string();

    let mut child = sample_card("child", 1_500, Some(3_000));
    child.agent_id = "sub-1".to_string();
    child.agent_type = "Explore".to_string();
    child.parent_card_id = Some("parent".to_string());
    child.prompt = "Inspect grammar files".to_string();

    model.on_cards(1, vec![parent, other, child], None);
    let rows = model.rows(UiLang::En);
    assert_eq!(rows.len(), 3);

    assert_eq!(rows[0].card_id, "parent");
    assert!(!rows[0].indent);
    assert_eq!(rows[0].title, "Refactor parser");

    assert_eq!(rows[1].card_id, "child");
    assert!(rows[1].indent);
    assert_eq!(rows[1].title, "Inspect grammar files");

    assert_eq!(rows[2].card_id, "other");
    assert!(!rows[2].indent);
}

#[test]
fn subagent_without_parent_shows_type_prefix() {
    let mut model = CardsModel::new();
    let _ = model.request_first_page(1);

    let mut orphan = sample_card("sub-orphan", 1_000, Some(2_000));
    orphan.agent_id = "sub-1".to_string();
    orphan.agent_type = "Explore".to_string();
    orphan.parent_card_id = Some("missing-parent".to_string());
    orphan.prompt = "Search error handlers".to_string();

    let mut no_parent = sample_card("sub-none", 900, Some(1_500));
    no_parent.agent_id = "sub-2".to_string();
    no_parent.agent_type = "Worker".to_string();
    no_parent.parent_card_id = None;
    no_parent.prompt = "Check tests".to_string();

    model.on_cards(1, vec![orphan, no_parent], None);
    let rows = model.rows(UiLang::En);
    assert_eq!(rows.len(), 2);
    assert!(!rows[0].indent);
    assert_eq!(rows[0].title, "Explore \u{203a} Search error handlers");
    assert!(!rows[1].indent);
    assert_eq!(rows[1].title, "Worker \u{203a} Check tests");
}

#[test]
fn three_edit_rows_then_more_counts_more_count() {
    let mut model = CardsModel::new();
    let _ = model.request_first_page(1);

    let mut card = sample_card("c1", 1_000, Some(2_000));
    card.main_root = None;
    card.root = "C:\\work\\desk\\".to_string();
    for i in 1..=5 {
        let mut blk = sample_block(
            i,
            &format!("src/dir/file_{i}.rs"),
            vec![Label::BodyChanged {}],
        );
        if i == 2 {
            blk.importance = Importance::High;
            blk.symbol = Some(BlockSymbol {
                kind: SymbolKind::Function,
                name: "compute".to_string(),
                container: None,
                exported: false,
                nth: 0,
            });
        }
        card.blocks.push(blk);
    }
    card.more_count = 3;

    model.on_cards(1, vec![card], None);

    let id_rows = model.rows(UiLang::Id);
    assert_eq!(id_rows[0].meta, "desk \u{00b7} 8 edit \u{00b7} 1 penting");
    assert_eq!(id_rows[0].edits.len(), 3);
    assert_eq!(id_rows[0].edits[0].file, "file_1.rs");
    assert_eq!(id_rows[0].edits[1].file, "file_2.rs");
    assert_eq!(id_rows[0].edits[1].symbol.as_deref(), Some("compute()"));
    assert!(id_rows[0].edits[1].high);
    assert!(!id_rows[0].edits[0].high);
    assert_eq!(id_rows[0].more.as_deref(), Some("+5 edit lagi"));

    let en_rows = model.rows(UiLang::En);
    assert_eq!(
        en_rows[0].meta,
        "desk \u{00b7} 8 edits \u{00b7} 1 important"
    );
    assert_eq!(en_rows[0].more.as_deref(), Some("+5 more edits"));
}

#[test]
fn format_only_blocks_collapse() {
    let mut model = CardsModel::new();
    let _ = model.request_first_page(1);

    let mut card = sample_card("c1", 1_000, Some(2_000));
    card.blocks = vec![
        sample_block(1, "src/a.rs", vec![Label::FormatOnly {}]),
        sample_block(2, "src/b.rs", vec![Label::BodyChanged {}]),
        sample_block(3, "src/c.rs", vec![Label::FormatOnly {}]),
        sample_block(4, "src/d.rs", vec![Label::FormatOnly {}]),
        sample_block(5, "src/e.rs", vec![Label::ReturnChanged {}]),
        sample_block(6, "src/f.rs", vec![Label::LoopAdded {}]),
    ];
    card.more_count = 1;

    model.on_cards(1, vec![card], None);

    let id_rows = model.rows(UiLang::Id);
    assert_eq!(id_rows[0].edits.len(), 3);
    assert_eq!(id_rows[0].edits[0].file, "");
    assert_eq!(id_rows[0].edits[0].chip, "3 file hanya berubah format");
    assert_eq!(id_rows[0].edits[1].file, "b.rs");
    assert_eq!(id_rows[0].edits[2].file, "e.rs");
    // 6 blocks total - (3 collapsed + 1 + 1 = 5 shown) + 1 more_count = 2 remaining
    assert_eq!(id_rows[0].more.as_deref(), Some("+2 edit lagi"));

    let en_rows = model.rows(UiLang::En);
    assert_eq!(en_rows[0].edits[0].chip, "3 files changed formatting only");
    assert_eq!(en_rows[0].more.as_deref(), Some("+2 more edits"));
}

#[test]
fn bash_group_row_and_uncertain_mark() {
    let mut model = CardsModel::new();
    let _ = model.request_first_page(1);

    let mut card = sample_card("c1", 1_000, Some(2_000));
    let mut b1 = sample_block(1, "src/gen/a.ts", vec![Label::BodyChanged {}]);
    b1.via = BlockVia::Bash;
    b1.bash = Some(BashInfo {
        cmd: "npm run gen".to_string(),
        candidates: 1,
    });

    let mut b2 = sample_block(2, "src/gen/b.ts", vec![Label::BodyChanged {}]);
    b2.via = BlockVia::Bash;
    b2.bash = Some(BashInfo {
        cmd: "npm run gen".to_string(),
        candidates: 1,
    });

    let mut b3 = sample_block(3, "src/out/c.ts", vec![Label::BodyChanged {}]);
    b3.via = BlockVia::Bash;
    b3.bash = Some(BashInfo {
        cmd: "prettier --write .".to_string(),
        candidates: 2,
    });

    card.blocks = vec![b1, b2, b3];
    model.on_cards(1, vec![card], None);

    let id_rows = model.rows(UiLang::Id);
    assert_eq!(id_rows[0].edits.len(), 2);
    assert_eq!(
        id_rows[0].edits[0].bash,
        Some(BashRow {
            before: "2 file berubah saat".to_string(),
            cmd: "npm run gen".to_string(),
            after: "berjalan".to_string(),
            uncertain: None,
        })
    );
    assert_eq!(
        id_rows[0].edits[1].bash,
        Some(BashRow {
            before: "1 file berubah saat".to_string(),
            cmd: "prettier --write .".to_string(),
            after: "berjalan".to_string(),
            uncertain: Some("\u{00b7} agent tidak pasti".to_string()),
        })
    );

    let en_rows = model.rows(UiLang::En);
    assert_eq!(
        en_rows[0].edits[0].bash,
        Some(BashRow {
            before: "2 files changed while".to_string(),
            cmd: "npm run gen".to_string(),
            after: "ran".to_string(),
            uncertain: None,
        })
    );
    assert_eq!(
        en_rows[0].edits[1].bash,
        Some(BashRow {
            before: "1 files changed while".to_string(),
            cmd: "prettier --write .".to_string(),
            after: "ran".to_string(),
            uncertain: Some("\u{00b7} agent uncertain".to_string()),
        })
    );
}

#[test]
fn unrecorded_and_outside_repo_chips() {
    let mut model = CardsModel::new();
    let _ = model.request_first_page(1);

    let mut card = sample_card("c1", 1_000, Some(2_000));
    card.root = "/work/rocky".to_string();

    let mut unrecorded = sample_block(1, "src/lib.rs", Vec::new());
    unrecorded.recorded = false;
    unrecorded.before = None;
    unrecorded.after = None;

    let mut tilde = sample_block(2, "~/notes/todo.md", Vec::new());
    tilde.recorded = false;
    tilde.before = None;
    tilde.after = None;

    let mut abs_outside = sample_block(3, "/work/rocky-other/file.rs", Vec::new());
    abs_outside.recorded = false;
    abs_outside.before = None;
    abs_outside.after = None;

    card.blocks = vec![unrecorded, tilde, abs_outside];
    model.on_cards(1, vec![card], None);

    let id_rows = model.rows(UiLang::Id);
    assert_eq!(id_rows[0].edits[0].chip, "tidak direkam");
    assert_eq!(id_rows[0].edits[1].chip, "di luar repo");
    assert_eq!(id_rows[0].edits[2].chip, "di luar repo");
    assert!(
        id_rows[0].edits[0]
            .tooltip
            .iter()
            .any(|l| l.text == "Repo belum diizinkan. Hanya path yang tercatat.")
    );

    let en_rows = model.rows(UiLang::En);
    assert_eq!(en_rows[0].edits[0].chip, "not recorded");
    assert_eq!(en_rows[0].edits[1].chip, "outside repo");
    assert_eq!(en_rows[0].edits[2].chip, "outside repo");
    assert!(
        en_rows[0].edits[0]
            .tooltip
            .iter()
            .any(|l| l.text == "Repo not allowed yet. Only the path is recorded.")
    );
}

#[test]
fn search_marks_matching_rows_only() {
    let mut model = CardsModel::new();
    let _ = model.set_query("BILLING".to_string(), 1);

    let mut card = sample_card("c1", 1_000, Some(2_000));
    card.main_root = Some("/work/rocky".to_string());
    card.blocks = vec![
        sample_block(1, "src/billing/tax.rs", vec![Label::BodyChanged {}]),
        sample_block(2, "src/main.rs", vec![Label::BodyChanged {}]),
    ];
    model.on_cards(1, vec![card.clone()], None);

    let rows = model.rows(UiLang::En);
    assert!(rows[0].edits[0].matched);
    assert!(!rows[0].edits[1].matched);

    // Query matching only the repo marks no edit row.
    let _ = model.set_query("rocky".to_string(), 2);
    model.on_cards(2, vec![card.clone()], None);
    let rows = model.rows(UiLang::En);
    assert!(!rows[0].edits[0].matched);
    assert!(!rows[0].edits[1].matched);

    // Empty query marks no edit row.
    let _ = model.set_query(String::new(), 3);
    model.on_cards(3, vec![card], None);
    let rows = model.rows(UiLang::En);
    assert!(!rows[0].edits[0].matched);
    assert!(!rows[0].edits[1].matched);
}

#[test]
fn list_rows_are_single_line() {
    let mut model = CardsModel::new();
    let _ = model.request_first_page(1);

    let mut card = sample_card("c1", 1_000, None);
    let long_first_line = "x".repeat(1_000);
    card.prompt = format!("{long_first_line}\nsecond line details");

    let mut blk = sample_block(1, "src/a.rs", vec![Label::BodyChanged {}]);
    blk.via = BlockVia::Bash;
    blk.bash = Some(BashInfo {
        cmd: format!("echo {}\n&& echo next", "y".repeat(200)),
        candidates: 1,
    });
    blk.quote = Some(Quote {
        text: format!("{}\nline2", "q".repeat(300)),
        shared: false,
    });
    card.blocks.push(blk);

    model.on_cards(1, vec![card], None);
    let rows = model.rows(UiLang::En);
    assert_eq!(rows.len(), 1);
    let row = &rows[0];

    assert!(!row.title.contains('\n'));
    assert!(!row.title.contains('\r'));
    assert!(row.title.chars().count() <= 81);
    assert!(row.title.ends_with('\u{2026}'));

    assert_eq!(row.time.len(), 5);
    assert_eq!(&row.time[2..3], ":");
    assert!(row.time.bytes().enumerate().all(|(i, b)| {
        if i == 2 {
            b == b':'
        } else {
            b.is_ascii_digit()
        }
    }));

    let bash = row.edits[0].bash.as_ref().expect("bash row");
    assert!(!bash.cmd.contains('\n'));
    assert!(!bash.cmd.contains('\r'));

    let quote_line = &row.edits[0].tooltip[1];
    assert!(!quote_line.text.contains('\n'));
    assert!(!quote_line.text.contains('\r'));
    assert!(quote_line.text.chars().count() <= 200);
}

#[test]
fn tooltip_lists_full_labels_quote_and_origin() {
    let mut model = CardsModel::new();
    let _ = model.request_first_page(1);

    let mut card = sample_card("c1", 1_000, Some(2_000));
    let mut blk = sample_block(
        1,
        "src/pricing.rs",
        vec![
            Label::ParamsChanged {
                added: 1,
                removed: 0,
                changed: 2,
            },
            Label::SymbolAdded {},
        ],
    );
    blk.symbol = Some(BlockSymbol {
        kind: SymbolKind::Function,
        name: "apply".to_string(),
        container: None,
        exported: true,
        nth: 0,
    });
    blk.quote = Some(Quote {
        text: "Added discount parameter.".to_string(),
        shared: false,
    });
    blk.via = BlockVia::Bash;
    blk.bash = Some(BashInfo {
        cmd: "cargo xtask gen".to_string(),
        candidates: 1,
    });
    blk.recorded = false;

    card.blocks.push(blk);
    model.on_cards(1, vec![card], None);

    let id_tip = &model.rows(UiLang::Id)[0].edits[0].tooltip;
    assert_eq!(
        id_tip,
        &vec![
            TooltipLine {
                text: "parameter: 1 baru, 2 diubah".to_string(),
                code: None,
            },
            TooltipLine {
                text: "fungsi baru".to_string(),
                code: None,
            },
            TooltipLine {
                text: "Added discount parameter.".to_string(),
                code: None,
            },
            TooltipLine {
                text: "lewat Bash".to_string(),
                code: Some("cargo xtask gen".to_string()),
            },
            TooltipLine {
                text: "Repo belum diizinkan. Hanya path yang tercatat.".to_string(),
                code: None,
            },
            TooltipLine {
                text: "publik (menurut kode)".to_string(),
                code: None,
            },
        ]
    );

    let en_tip = &model.rows(UiLang::En)[0].edits[0].tooltip;
    assert_eq!(
        en_tip,
        &vec![
            TooltipLine {
                text: "parameters: 1 added, 2 changed".to_string(),
                code: None,
            },
            TooltipLine {
                text: "new function".to_string(),
                code: None,
            },
            TooltipLine {
                text: "Added discount parameter.".to_string(),
                code: None,
            },
            TooltipLine {
                text: "via Bash".to_string(),
                code: Some("cargo xtask gen".to_string()),
            },
            TooltipLine {
                text: "Repo not allowed yet. Only the path is recorded.".to_string(),
                code: None,
            },
            TooltipLine {
                text: "public (per code)".to_string(),
                code: None,
            },
        ]
    );
}

#[test]
fn symbol_kinds_single_format_only_and_windows_paths() {
    let mut model = CardsModel::new();
    let _ = model.request_first_page(1);

    let mut card = sample_card("c1", 2_000, None);
    card.main_root = Some("C:\\Work\\MyApp".to_string());
    card.root = "C:\\Work\\MyApp-wt".to_string();

    let mut method_blk = sample_block(1, "src/lib.rs", vec![Label::FormatOnly {}]);
    method_blk.symbol = Some(BlockSymbol {
        kind: SymbolKind::Method,
        name: "save".to_string(),
        container: Some("Repo".to_string()),
        exported: false,
        nth: 0,
    });

    let mut struct_blk = sample_block(
        2,
        "C:/work/myapp-wt/src/types.rs",
        vec![Label::BodyChanged {}],
    );
    struct_blk.symbol = Some(BlockSymbol {
        kind: SymbolKind::Struct,
        name: "Config".to_string(),
        container: None,
        exported: false,
        nth: 0,
    });

    let mut win_outside = sample_block(3, "c:\\work\\other\\secret.rs", Vec::new());
    win_outside.recorded = false;

    let mut rel_escape = sample_block(4, "src/../../outside.rs", Vec::new());
    rel_escape.recorded = false;

    card.blocks = vec![method_blk, struct_blk, win_outside, rel_escape];
    model.on_cards(1, vec![card], Some("2000:c1".to_string()));

    let rows = model.rows(UiLang::En);
    assert_eq!(rows[0].meta, "MyApp \u{00b7} 4 edits");
    // A single format_only block collapses into the summary row.
    assert_eq!(rows[0].edits[0].symbol, None);
    assert_eq!(rows[0].edits[0].file, "");
    assert_eq!(rows[0].edits[0].chip, "1 files changed formatting only");
    assert_eq!(rows[0].edits[1].symbol.as_deref(), Some("Config"));
    assert_eq!(rows[0].edits[1].chip, "body changed");
    assert_eq!(rows[0].edits[2].chip, "outside repo");
    assert_eq!(rows[0].more.as_deref(), Some("+1 more edits"));

    // First-page refresh (e.g. reconnect) keeps current rows while loading, then replaces them.
    let _ = model.request_first_page(2);
    assert!(model.loading());
    assert_eq!(model.rows(UiLang::En).len(), 1);
    let mut c2 = sample_card("c2", 3_000, Some(4_000));
    let mut method_only = sample_block(1, "src/repo.rs", vec![Label::BodyChanged {}]);
    method_only.symbol = Some(BlockSymbol {
        kind: SymbolKind::Method,
        name: "save".to_string(),
        container: Some("Repo".to_string()),
        exported: false,
        nth: 0,
    });
    c2.blocks.push(method_only);
    model.on_cards(2, vec![c2], None);
    assert!(!model.loading());
    let refreshed = model.rows(UiLang::En);
    assert_eq!(refreshed.len(), 1);
    assert_eq!(refreshed[0].card_id, "c2");
    assert_eq!(refreshed[0].edits[0].symbol.as_deref(), Some("save()"));
}
