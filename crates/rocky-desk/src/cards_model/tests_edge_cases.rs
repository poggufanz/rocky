use rocky_proto::cards::{BashInfo, BlockSymbol, BlockVia, Importance, Label, Quote, SymbolKind};
use rocky_proto::pipe::ClientMsg;

use super::tests::{sample_block, sample_card};
use super::*;
use crate::i18n::{CardMsg, UiLang};

fn assert_no_control_chars(label: &str, value: &str) {
    assert!(
        !value
            .chars()
            .any(|c| c.is_control() || matches!(c, '\u{2028}' | '\u{2029}')),
        "{label} contained control char: {value:?}"
    );
}

#[test]
fn pending_first_page_keeps_newer_pushed_revision() {
    let mut model = CardsModel::new();
    let _ = model.request_first_page(1);

    let mut rev2 = sample_card("c1", 1_000, Some(2_000));
    rev2.rev = 2;
    rev2.prompt = "Pushed rev 2".to_string();
    model.on_push(rev2);

    let mut rev1 = sample_card("c1", 1_000, Some(2_000));
    rev1.rev = 1;
    rev1.prompt = "Page rev 1".to_string();
    model.on_cards(1, vec![rev1], None);

    let rows = model.rows(UiLang::En);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].card_id, "c1");
    assert_eq!(rows[0].title, "Pushed rev 2");

    // An even newer revision returned on a subsequent refresh still wins over an older push.
    let _ = model.request_first_page(2);
    let mut rev3_push = sample_card("c1", 1_000, Some(2_000));
    rev3_push.rev = 3;
    rev3_push.prompt = "Pushed rev 3".to_string();
    model.on_push(rev3_push);

    let mut rev4_page = sample_card("c1", 1_000, Some(2_000));
    rev4_page.rev = 4;
    rev4_page.prompt = "Page rev 4".to_string();
    model.on_cards(2, vec![rev4_page], None);

    let rows = model.rows(UiLang::En);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].title, "Page rev 4");
}

#[test]
fn pending_first_page_keeps_pushed_card_missing_from_reply() {
    let mut model = CardsModel::new();
    let _ = model.request_first_page(1);

    let mut pushed_old = sample_card("pushed-old", 1_000, Some(1_500));
    pushed_old.prompt = "Older pushed card".to_string();
    model.on_push(pushed_old);

    let mut pushed_new = sample_card("pushed-new", 2_000, Some(2_500));
    pushed_new.prompt = "Newer pushed card".to_string();
    model.on_push(pushed_new);

    model.on_cards(1, Vec::new(), None);
    let ids: Vec<String> = model
        .rows(UiLang::En)
        .into_iter()
        .map(|r| r.card_id)
        .collect();
    assert_eq!(ids, vec!["pushed-new", "pushed-old"]);

    // When a non-empty page omits a pushed card, it is merged in descending timestamp order.
    let _ = model.request_first_page(2);
    let mid_pushed = sample_card("mid", 1_800, Some(2_000));
    model.on_push(mid_pushed);
    model.on_cards(
        2,
        vec![
            sample_card("top", 2_500, Some(3_000)),
            sample_card("bottom", 500, Some(1_000)),
        ],
        None,
    );
    let ids: Vec<String> = model
        .rows(UiLang::En)
        .into_iter()
        .map(|r| r.card_id)
        .collect();
    assert_eq!(ids, vec!["top", "mid", "bottom"]);

    // Active query filtering still applies to pushes preserved across an empty reply.
    let _ = model.set_query("auth".to_string(), 3);
    let mut non_matching = sample_card("no-match", 3_000, Some(4_000));
    non_matching.blocks.push(sample_block(
        1,
        "src/billing.rs",
        vec![Label::BodyChanged {}],
    ));
    model.on_push(non_matching);

    let mut matching = sample_card("match", 3_100, Some(4_100));
    matching.blocks.push(sample_block(
        1,
        "src/auth/session.rs",
        vec![Label::BodyChanged {}],
    ));
    model.on_push(matching);

    model.on_cards(3, Vec::new(), None);
    let ids: Vec<String> = model
        .rows(UiLang::En)
        .into_iter()
        .map(|r| r.card_id)
        .collect();
    assert_eq!(ids, vec!["match"]);
}

#[test]
fn bash_group_rows_preserve_unrecorded_and_outside_repo_chips() {
    let mut model = CardsModel::new();
    let _ = model.request_first_page(1);

    let mut unrec_card = sample_card("c-unrec", 1_000, Some(3_000));
    let mut unrec_bash = sample_block(1, "src/lib.rs", vec![Label::BodyChanged {}]);
    unrec_bash.via = BlockVia::Bash;
    unrec_bash.recorded = false;
    unrec_bash.bash = Some(BashInfo {
        cmd: "sed -i s/a/b/ src/lib.rs".to_string(),
        candidates: 1,
    });
    unrec_card.blocks = vec![unrec_bash];

    let mut outside_card = sample_card("c-out", 1_000, Some(2_000));
    let mut tilde_bash = sample_block(1, "~/notes/todo.md", Vec::new());
    tilde_bash.via = BlockVia::Bash;
    tilde_bash.recorded = false;
    tilde_bash.bash = Some(BashInfo {
        cmd: "cp a b".to_string(),
        candidates: 1,
    });
    let mut abs_outside_bash = sample_block(2, "/work/other/out.txt", Vec::new());
    abs_outside_bash.via = BlockVia::Bash;
    abs_outside_bash.recorded = false;
    abs_outside_bash.bash = Some(BashInfo {
        cmd: "cp a b".to_string(),
        candidates: 1,
    });
    outside_card.blocks = vec![tilde_bash, abs_outside_bash];

    let mut mixed_card = sample_card("c-mixed", 1_000, Some(1_500));
    let make_bash = |seq: u32, path: &str, recorded: bool| {
        let mut blk = sample_block(seq, path, vec![Label::BodyChanged {}]);
        blk.via = BlockVia::Bash;
        blk.recorded = recorded;
        blk.bash = Some(BashInfo {
            cmd: "npm run gen".to_string(),
            candidates: 1,
        });
        blk
    };
    mixed_card.blocks = vec![
        make_bash(1, "src/a.rs", true),
        make_bash(2, "src/b.rs", false),
        make_bash(3, "~/outside.txt", false),
        make_bash(4, "src/d.rs", true),
    ];

    model.on_cards(1, vec![unrec_card, outside_card, mixed_card], None);

    let id_rows = model.rows(UiLang::Id);
    assert!(id_rows[0].edits[0].bash.is_some());
    assert_eq!(id_rows[0].edits[0].chip, "tidak direkam");

    assert_eq!(id_rows[1].edits.len(), 1);
    assert_eq!(
        id_rows[1].edits[0].bash.as_ref().unwrap().before,
        "2 file berubah saat"
    );
    assert_eq!(id_rows[1].edits[0].chip, "di luar repo");

    assert_eq!(id_rows[2].edits.len(), 3);
    assert_eq!(
        id_rows[2].edits[0].bash.as_ref().unwrap().before,
        "2 file berubah saat"
    );
    assert_eq!(id_rows[2].edits[0].chip, "");
    assert_eq!(
        id_rows[2].edits[1].bash.as_ref().unwrap().before,
        "1 file berubah saat"
    );
    assert_eq!(id_rows[2].edits[1].chip, "tidak direkam");
    assert_eq!(
        id_rows[2].edits[2].bash.as_ref().unwrap().before,
        "1 file berubah saat"
    );
    assert_eq!(id_rows[2].edits[2].chip, "di luar repo");

    let en_rows = model.rows(UiLang::En);
    assert_eq!(en_rows[0].edits[0].chip, "not recorded");
    assert_eq!(en_rows[1].edits[0].chip, "outside repo");
    assert_eq!(en_rows[2].edits[0].chip, "");
    assert_eq!(en_rows[2].edits[1].chip, "not recorded");
    assert_eq!(en_rows[2].edits[2].chip, "outside repo");
}

#[test]
fn subagent_title_bounds_include_prefix() {
    let mut model = CardsModel::new();
    let _ = model.request_first_page(1);

    let mut sub = sample_card("sub", 1_000, Some(3_000));
    sub.agent_id = "sub-1".to_string();
    sub.agent_type = "Explore".to_string();
    sub.prompt = format!("{}\nsecond line", "x".repeat(1_000));

    let mut exact = sample_card("exact", 1_000, Some(2_000));
    exact.agent_id = "sub-2".to_string();
    exact.agent_type = "Explore".to_string();
    // "Explore › " is 10 chars + 70 chars = 80 chars total (no ellipsis).
    exact.prompt = "a".repeat(70);

    model.on_cards(1, vec![sub, exact], None);
    let rows = model.rows(UiLang::En);
    assert_eq!(rows.len(), 2);

    assert!(rows[0].title.starts_with("Explore \u{203a} "));
    assert_eq!(rows[0].title.chars().count(), 81);
    assert!(rows[0].title.ends_with('\u{2026}'));

    assert_eq!(rows[1].title.chars().count(), 80);
    assert!(!rows[1].title.ends_with('\u{2026}'));
}

#[test]
fn single_line_fields_split_cr_and_replace_control_chars() {
    let mut model = CardsModel::new();
    let _ = model.request_first_page(1);

    let mut card = sample_card("c1", 1_000, Some(2_000));
    card.main_root = Some("/work/my\nrepo".to_string());
    card.root = "/work/my\nrepo".to_string();
    card.agent_type = "Ex\tplore\n".to_string();
    card.prompt = "left\rright".to_string();

    let mut blk1 = sample_block(
        1,
        "src/my\nfile.rs",
        vec![Label::CallAdded {
            name: "foo\nbar\r\nbaz\tqux\x07".to_string(),
        }],
    );
    blk1.symbol = Some(BlockSymbol {
        kind: SymbolKind::Function,
        name: "fn\tname\x00".to_string(),
        container: None,
        exported: false,
        nth: 0,
    });
    blk1.quote = Some(Quote {
        text: "q1\r\nq2\rq3\tq4\x1b".to_string(),
        shared: false,
    });

    let mut blk2 = sample_block(
        2,
        &format!("src/{}.rs", "long_file_".repeat(12)),
        vec![Label::ValueChanged {
            name: "k\nv".to_string(),
            before: "a\rb".to_string(),
            after: "c\x1bd".to_string(),
        }],
    );
    blk2.via = BlockVia::Bash;
    blk2.importance = Importance::High;
    blk2.bash = Some(BashInfo {
        cmd: "echo\thi\r\nls\x08".to_string(),
        candidates: 2,
    });
    blk2.symbol = Some(BlockSymbol {
        kind: SymbolKind::Struct,
        name: "LongSymbol".repeat(12),
        container: None,
        exported: false,
        nth: 0,
    });

    card.blocks = vec![blk1, blk2];

    // Leading blank lines with CRLF/CR still pick the first non-empty line.
    let mut blank_lead = sample_card("c2", 500, Some(1_000));
    blank_lead.prompt = "\r\n \t \r\n  first\tline\x07here\rsecond".to_string();

    model.on_cards(1, vec![card, blank_lead], None);
    let rows = model.rows(UiLang::En);
    assert_eq!(rows.len(), 2);

    let r1 = &rows[0];
    assert_eq!(r1.title, "Ex plore  \u{203a} left");
    assert_eq!(r1.meta, "my repo \u{00b7} 2 edits");
    assert_eq!(r1.meta_high.as_deref(), Some("1 important"));
    assert_eq!(r1.edits[0].file, "my file.rs");
    assert_eq!(r1.edits[0].symbol.as_deref(), Some("fn name ()"));
    assert_eq!(r1.edits[0].chip, "calls foo bar baz qux ");

    let bash = r1.edits[1].bash.as_ref().expect("bash row");
    assert_eq!(bash.cmd, "echo hi ls ");
    assert_eq!(r1.edits[0].tooltip[1].text, "q1 q2 q3 q4 ");
    assert_eq!(r1.edits[1].tooltip[0].text, "k v: a b \u{2192} c d");

    // File and symbol are intentionally not truncated in the model.
    assert!(long_file_and_symbol_len() > 100);

    for row in &rows {
        assert_no_control_chars("title", &row.title);
        assert_no_control_chars("time", &row.time);
        assert_no_control_chars("meta", &row.meta);
        if let Some(meta_high) = &row.meta_high {
            assert_no_control_chars("meta_high", meta_high);
        }
        if let Some(more) = &row.more {
            assert_no_control_chars("more", more);
        }
        for edit in &row.edits {
            assert_no_control_chars("file", &edit.file);
            if let Some(sym) = &edit.symbol {
                assert_no_control_chars("symbol", sym);
            }
            assert_no_control_chars("chip", &edit.chip);
            if let Some(bash) = &edit.bash {
                assert_no_control_chars("bash.before", &bash.before);
                assert_no_control_chars("bash.cmd", &bash.cmd);
                assert_no_control_chars("bash.after", &bash.after);
                if let Some(uncertain) = &bash.uncertain {
                    assert_no_control_chars("bash.uncertain", uncertain);
                }
            }
            for tip in &edit.tooltip {
                assert_no_control_chars("tooltip.text", &tip.text);
                if let Some(code) = &tip.code {
                    assert_no_control_chars("tooltip.code", code);
                }
            }
        }
    }

    assert_eq!(rows[1].title, "first line here");
}

fn long_file_and_symbol_len() -> usize {
    let mut model = CardsModel::new();
    let _ = model.request_first_page(1);
    let mut card = sample_card("len-check", 1_000, Some(2_000));
    let mut blk = sample_block(
        1,
        &format!("src/{}.rs", "long_file_".repeat(12)),
        vec![Label::BodyChanged {}],
    );
    blk.symbol = Some(BlockSymbol {
        kind: SymbolKind::Struct,
        name: "LongSymbol".repeat(12),
        container: None,
        exported: false,
        nth: 0,
    });
    card.blocks = vec![blk];
    model.on_cards(1, vec![card], None);
    let rendered = &model.rows(UiLang::En)[0].edits[0];
    assert!(rendered.symbol.as_ref().unwrap().chars().count() > 100);
    rendered.file.chars().count()
}

#[test]
fn single_format_only_block_collapses() {
    let mut model = CardsModel::new();
    let _ = model.request_first_page(1);

    let mut card = sample_card("c1", 1_000, Some(2_000));
    card.blocks = vec![sample_block(1, "src/lib.rs", vec![Label::FormatOnly {}])];
    model.on_cards(1, vec![card], None);

    let id_rows = model.rows(UiLang::Id);
    assert_eq!(id_rows[0].edits.len(), 1);
    assert_eq!(id_rows[0].edits[0].file, "");
    assert_eq!(id_rows[0].edits[0].symbol, None);
    assert_eq!(id_rows[0].edits[0].chip, "1 file hanya berubah format");
    assert_eq!(id_rows[0].more, None);

    let en_rows = model.rows(UiLang::En);
    assert_eq!(en_rows[0].edits[0].chip, "1 files changed formatting only");
}

#[test]
fn not_yet_requested_renders_loading_until_page_reply() {
    let mut model = CardsModel::new();
    assert!(!model.loading());
    assert_eq!(model.empty_msg(), CardMsg::Loading);

    // Unsolicited empty page does not exit the initial unrequested state.
    model.on_cards(99, Vec::new(), None);
    assert_eq!(model.empty_msg(), CardMsg::Loading);

    let _ = model.request_first_page(1);
    assert!(model.loading());
    assert_eq!(model.empty_msg(), CardMsg::Loading);

    model.on_cards(1, Vec::new(), None);
    assert!(!model.loading());
    assert_eq!(model.empty_msg(), CardMsg::Empty);

    let _ = model.set_query("auth".to_string(), 2);
    assert!(model.loading());
    assert_eq!(model.empty_msg(), CardMsg::Loading);

    model.on_cards(2, Vec::new(), None);
    assert!(!model.loading());
    assert_eq!(model.empty_msg(), CardMsg::Empty);
}

#[test]
fn failed_ack_ends_first_page_loading_and_preserves_items() {
    let mut model = CardsModel::new();
    let _ = model.request_first_page(1);
    assert!(model.loading());

    // Ack for another id or ok=true changes nothing.
    assert!(!model.on_ack(99, false));
    assert!(model.loading());
    assert!(!model.on_ack(1, true));
    assert!(model.loading());

    // Failed Ack on initial request ends loading without staying stuck.
    assert!(model.on_ack(1, false));
    assert!(!model.loading());
    assert!(!model.has_more());
    assert!(model.rows(UiLang::En).is_empty());
    assert_eq!(model.empty_msg(), CardMsg::Empty);

    // Populate first page, then fail a refresh: keep current items and clear pending replace.
    let _ = model.request_first_page(2);
    model.on_cards(
        2,
        vec![sample_card("c1", 1_000, Some(2_000))],
        Some("cursor-1".to_string()),
    );

    let _ = model.request_first_page(3);
    assert!(model.loading());
    let pushed = sample_card("c2", 2_000, Some(3_000));
    model.on_push(pushed);
    assert!(model.on_ack(3, false));
    assert!(!model.loading());

    let ids: Vec<String> = model
        .rows(UiLang::En)
        .into_iter()
        .map(|r| r.card_id)
        .collect();
    assert_eq!(ids, vec!["c2", "c1"]);

    // Stale Cards reply for the aborted id 3 must be ignored.
    model.on_cards(3, vec![sample_card("stale", 100, Some(200))], None);
    let ids: Vec<String> = model
        .rows(UiLang::En)
        .into_iter()
        .map(|r| r.card_id)
        .collect();
    assert_eq!(ids, vec!["c2", "c1"]);
}

#[test]
fn failed_ack_re_enables_load_more_with_same_cursor() {
    let mut model = CardsModel::new();
    let _ = model.request_first_page(1);
    model.on_cards(
        1,
        vec![sample_card("c2", 2_000, Some(3_000))],
        Some("3000:c2".to_string()),
    );

    let req = model.request_more(2);
    assert_eq!(
        req,
        Some(ClientMsg::Cards {
            id: 2,
            query: None,
            before: Some("3000:c2".to_string()),
            limit: PAGE_LIMIT,
        })
    );
    assert!(model.loading());
    assert!(model.request_more(3).is_none());

    // Ack for another id changes nothing.
    assert!(!model.on_ack(999, false));
    assert!(model.loading());
    assert!(model.request_more(3).is_none());

    // Failed Ack for load-more clears loading and preserves the cursor.
    assert!(model.on_ack(2, false));
    assert!(!model.loading());
    assert!(model.has_more());

    let retry = model.request_more(4);
    assert_eq!(
        retry,
        Some(ClientMsg::Cards {
            id: 4,
            query: None,
            before: Some("3000:c2".to_string()),
            limit: PAGE_LIMIT,
        })
    );
    assert!(model.loading());

    model.on_cards(4, vec![sample_card("c1", 1_000, Some(2_000))], None);
    assert!(!model.loading());
    assert!(!model.has_more());
    let ids: Vec<String> = model
        .rows(UiLang::En)
        .into_iter()
        .map(|r| r.card_id)
        .collect();
    assert_eq!(ids, vec!["c2", "c1"]);
}

#[test]
fn row_titles_format_cross_session_prompts_in_both_languages() {
    let mut model = CardsModel::new();
    let _ = model.request_first_page(1);

    let mut main_cross = sample_card("c-cross", 3_000, Some(4_000));
    main_cross.prompt =
        "<cross-session-message from=\"sess-0\" sender=\"coord\">hi</cross-session-message>"
            .to_string();

    let mut sub_cross = sample_card("c-sub-cross", 2_000, Some(3_000));
    sub_cross.agent_id = "sub-1".to_string();
    sub_cross.agent_type = "Explore".to_string();
    sub_cross.prompt = "  \n<cross-session-message from=\"sess-0\">hi".to_string();

    let mut mid_mention = sample_card("c-mid-cross", 1_000, Some(2_000));
    mid_mention.prompt = "Explain <cross-session-message from=\"x\"> tag".to_string();

    model.on_cards(1, vec![main_cross, sub_cross, mid_mention], None);

    let en_rows = model.rows(UiLang::En);
    assert_eq!(en_rows[0].title, "Message from another session");
    assert_eq!(
        en_rows[1].title,
        "Explore \u{203a} Message from another session"
    );
    assert_eq!(
        en_rows[2].title,
        "Explain <cross-session-message from=\"x\"> tag"
    );

    let id_rows = model.rows(UiLang::Id);
    assert_eq!(id_rows[0].title, "Pesan dari sesi lain");
    assert_eq!(id_rows[1].title, "Explore \u{203a} Pesan dari sesi lain");
    assert_eq!(
        id_rows[2].title,
        "Explain <cross-session-message from=\"x\"> tag"
    );
}
