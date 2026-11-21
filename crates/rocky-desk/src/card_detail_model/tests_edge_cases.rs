use rocky_proto::cards::{BlockSymbol, FlowKind, FlowStep, Label, Quote, SymbolKind};
use rocky_proto::pipe::{DiffLine, DiffLineKind};

use super::tests::{sample_block, sample_card};
use super::*;
use crate::i18n::UiLang;

fn assert_no_control_chars(label: &str, value: &str) {
    assert!(
        !value
            .chars()
            .any(|c| c.is_control() || matches!(c, '\u{2028}' | '\u{2029}')),
        "{label} contained control char: {value:?}"
    );
}

#[test]
fn edit_step_titles_and_single_sided_line_facts() {
    let (mut model, _) = DetailModel::open("c1".to_string(), 1, None);
    let mut card = sample_card("c1", 1_000, Some(2_000));

    let mut b1 = sample_block(1, "src/added.rs", vec![Label::FileNew {}]);
    b1.symbol = Some(BlockSymbol {
        kind: SymbolKind::Function,
        name: "init".to_string(),
        container: None,
        exported: false,
        nth: 0,
    });
    b1.line = None;
    b1.added = Some(5);
    b1.removed = Some(0);

    let mut b2 = sample_block(2, "src/deleted.rs", vec![Label::FileDeleted {}]);
    b2.line = None;
    b2.added = Some(0);
    b2.removed = Some(4);

    let mut b3 = sample_block(3, "src/zero.rs", vec![Label::FormatOnly {}]);
    b3.line = None;
    b3.added = Some(0);
    b3.removed = Some(0);

    let mut b4 = sample_block(4, "~/outside.txt", Vec::new());
    b4.recorded = false;
    b4.line = None;
    b4.added = None;
    b4.removed = None;

    card.blocks = vec![b1, b2, b3, b4];
    card.flow = vec![
        FlowStep {
            kind: FlowKind::Edit,
            text: "src/added.rs".to_string(),
            ok: true,
            dur_ms: 1_500,
            seqs: vec![1],
            exit_code: None,
            error: None,
            start_ms: None,
            end_ms: None,
            cwd: None,
            tool_use_id: None,
            desc: None,
        },
        FlowStep {
            kind: FlowKind::Edit,
            text: "src/deleted.rs".to_string(),
            ok: true,
            dur_ms: 500,
            seqs: vec![2],
            exit_code: None,
            error: None,
            start_ms: None,
            end_ms: None,
            cwd: None,
            tool_use_id: None,
            desc: None,
        },
        FlowStep {
            kind: FlowKind::Edit,
            text: String::new(),
            ok: true,
            dur_ms: 0,
            seqs: vec![3, 4],
            exit_code: None,
            error: None,
            start_ms: None,
            end_ms: None,
            cwd: None,
            tool_use_id: None,
            desc: None,
        },
    ];
    card.flow_more = 2;

    model.on_detail(1, card, Vec::new(), Vec::new(), Vec::new(), UiLang::Id);
    let DetailState::Ready(view) = model.state() else {
        panic!("expected Ready state");
    };

    assert_eq!(view.timeline[0].title, "src/added.rs \u{203a} init()");
    assert_eq!(view.timeline[0].dur, "1s");
    assert_eq!(
        view.timeline[0].subs,
        vec![("file baru".to_string(), "+5".to_string())]
    );

    assert_eq!(view.timeline[1].title, "src/deleted.rs");
    assert_eq!(view.timeline[1].dur, "0s");
    assert_eq!(
        view.timeline[1].subs,
        vec![("file dihapus".to_string(), "\u{2212}4".to_string())]
    );

    assert_eq!(view.timeline[2].title, "src/zero.rs");
    assert_eq!(
        view.timeline[2].subs,
        vec![
            ("hanya format".to_string(), String::new()),
            ("di luar repo".to_string(), String::new()),
        ]
    );
    assert_eq!(view.timeline_more.as_deref(), Some("+2 langkah"));
}

#[test]
fn single_line_fields_sanitize_controls_while_detail_keeps_prompt_and_quote() {
    let (mut model, _) = DetailModel::open("c1".to_string(), 1, None);
    let mut card = sample_card("c1", 1_000, Some(10_000));
    card.main_root = Some("/work/my\nrepo".to_string());
    card.root = "/work/my\nrepo".to_string();
    card.branch = Some("feat\tcards\r\n".to_string());
    card.agent_type = "Ex\tplore\n".to_string();
    card.prompt = "Line 1\nLine 2".to_string();

    let mut blk = sample_block(
        1,
        "src/my\nfile.rs",
        vec![Label::CallAdded {
            name: "foo\nbar\t\x07".to_string(),
        }],
    );
    blk.symbol = Some(BlockSymbol {
        kind: SymbolKind::Function,
        name: "run\tcmd\x00".to_string(),
        container: None,
        exported: false,
        nth: 0,
    });
    blk.line = Some(10);
    blk.quote = Some(Quote {
        text: "Para 1\nPara 2".to_string(),
        shared: false,
    });
    card.blocks = vec![blk];
    card.flow = vec![FlowStep {
        kind: FlowKind::Cmd,
        text: "  echo hi\r\nls\t-la  \n".to_string(),
        ok: true,
        dur_ms: 2_000,
        seqs: vec![1],
        exit_code: None,
        error: None,
        start_ms: None,
        end_ms: None,
        cwd: None,
        tool_use_id: None,
        desc: None,
    }];

    model.on_detail(1, card, Vec::new(), Vec::new(), Vec::new(), UiLang::En);
    let DetailState::Ready(view) = model.state() else {
        panic!("expected Ready state");
    };

    assert_eq!(view.prompt, "Line 1\nLine 2");
    assert_eq!(view.groups[0].quote.as_deref(), Some("Para 1\nPara 2"));
    assert_eq!(
        view.meta,
        "my repo \u{00b7} feat cards \u{00b7} 9 s \u{00b7} Ex plore"
    );
    assert_no_control_chars("meta", &view.meta);
    assert_eq!(view.groups[0].blocks[0].path, "src/my file.rs");
    assert_eq!(
        view.groups[0].blocks[0].symbol.as_deref(),
        Some("run cmd ()")
    );
    assert_no_control_chars("path", &view.groups[0].blocks[0].path);
    if let Some(sym) = &view.groups[0].blocks[0].symbol {
        assert_no_control_chars("symbol", sym);
    }
    assert_no_control_chars("head", &view.groups[0].blocks[0].head);
    for (chip, _) in &view.groups[0].blocks[0].chips {
        assert_no_control_chars("chip", chip);
    }
    assert_eq!(view.timeline[0].title, "echo hi ls -la");
    assert_no_control_chars("step.title", &view.timeline[0].title);
    assert_eq!(
        view.timeline[0].subs[0].1,
        "my file.rs:10 \u{00b7} +3 \u{2212}1"
    );
    for (chip, fact) in &view.timeline[0].subs {
        assert_no_control_chars("step.sub.chip", chip);
        assert_no_control_chars("step.sub.fact", fact);
    }
}

#[test]
fn diff_zero_pages_blocks_navigation() {
    let (mut diff, _) = DiffModel::open("c1".to_string(), 1, 1);
    diff.on_diff(
        1,
        vec![DiffLine {
            kind: DiffLineKind::Context,
            text: String::new(),
        }],
        0,
        0,
        false,
    );
    assert!(diff.go(0, 2).is_none());
}

#[test]
fn reopen_resets_detail_and_diff_to_loading_until_reply() {
    let (mut detail, _) = DetailModel::open("c1".to_string(), 1, None);
    detail.on_detail(
        1,
        sample_card("c1", 1_000, Some(2_000)),
        Vec::new(),
        Vec::new(),
        Vec::new(),
        UiLang::Id,
    );
    assert!(matches!(detail.state(), DetailState::Ready(_)));

    let req = detail.reopen(2, None);
    assert_eq!(
        req,
        ClientMsg::CardDetail {
            id: 2,
            card_id: "c1".to_string(),
            translate_to: None,
        }
    );
    assert_eq!(detail.state(), &DetailState::Loading);
    assert_eq!(detail.pending_id(), Some(2));
    assert!(!detail.reopened_not_found());

    // Stale reply leaves detail in Loading until the matching reply arrives.
    detail.on_detail(
        1,
        sample_card("c1", 1_000, Some(3_000)),
        Vec::new(),
        Vec::new(),
        Vec::new(),
        UiLang::Id,
    );
    assert_eq!(detail.state(), &DetailState::Loading);

    let mut refreshed = sample_card("c1", 1_000, Some(4_000));
    refreshed.prompt = "Updated prompt".to_string();
    detail.on_detail(2, refreshed, Vec::new(), Vec::new(), Vec::new(), UiLang::Id);
    let DetailState::Ready(view) = detail.state() else {
        panic!("expected Ready state after reopen reply");
    };
    assert_eq!(view.prompt, "Updated prompt");
    assert_eq!(detail.pending_id(), None);

    // Reopen followed by NotFound Ack transitions Loading -> NotFound with reopened_not_found set.
    let _ = detail.reopen(3, None);
    assert_eq!(detail.state(), &DetailState::Loading);
    detail.on_ack(3, false);
    assert_eq!(detail.state(), &DetailState::NotFound);
    assert!(detail.reopened_not_found());

    let (mut diff, _) = DiffModel::open("c1".to_string(), 5, 10);
    diff.on_diff(
        10,
        vec![DiffLine {
            kind: DiffLineKind::Context,
            text: "page 0".to_string(),
        }],
        0,
        3,
        false,
    );
    let _ = diff.go(1, 11);
    diff.on_diff(
        11,
        vec![DiffLine {
            kind: DiffLineKind::Added,
            text: "+page 1".to_string(),
        }],
        1,
        3,
        false,
    );
    assert!(matches!(
        diff.state(),
        DiffState::Page {
            page: 1,
            pages: 3,
            ..
        }
    ));

    let diff_req = diff.reopen(12);
    assert_eq!(
        diff_req,
        ClientMsg::BlockDiff {
            id: 12,
            card_id: "c1".to_string(),
            seq: 5,
            page: 1,
        }
    );
    assert_eq!(diff.state(), &DiffState::Loading);
    assert_eq!(diff.pending_id(), Some(12));
    assert!(!diff.reopened_not_found());

    // Stale reply leaves diff in Loading until the matching reply arrives.
    diff.on_diff(
        11,
        vec![DiffLine {
            kind: DiffLineKind::Context,
            text: "stale".to_string(),
        }],
        1,
        3,
        false,
    );
    assert_eq!(diff.state(), &DiffState::Loading);

    let refreshed_lines = vec![DiffLine {
        kind: DiffLineKind::Added,
        text: "+refreshed page 1".to_string(),
    }];
    diff.on_diff(12, refreshed_lines.clone(), 1, 3, false);
    assert_eq!(
        diff.state(),
        &DiffState::Page {
            lines: refreshed_lines,
            page: 1,
            pages: 3,
        }
    );
    assert_eq!(diff.pending_id(), None);

    // Reopen followed by NotFound Ack transitions Loading -> NotFound with reopened_not_found set.
    let _ = diff.reopen(13);
    assert_eq!(diff.state(), &DiffState::Loading);
    diff.on_ack(13, false);
    assert_eq!(diff.state(), &DiffState::NotFound);
    assert!(diff.reopened_not_found());
}

#[test]
fn detail_treats_cross_session_prompt_as_notice_in_both_languages() {
    let open_prompt = |id: &str, prompt: &str, lang: UiLang| -> DetailView {
        let (mut model, _) = DetailModel::open(id.to_string(), 1, None);
        let mut card = sample_card(id, 1_000, Some(2_000));
        card.prompt = prompt.to_string();
        model.on_detail(1, card, Vec::new(), Vec::new(), Vec::new(), lang);
        match model.state() {
            DetailState::Ready(view) => view.clone(),
            other => panic!("expected Ready state, got {other:?}"),
        }
    };

    let cross_prompt = " \n<cross-session-message from=\"s0\" sender=\"lead\">\ncheck tests\n</cross-session-message>";
    let en = open_prompt("c-cross-en", cross_prompt, UiLang::En);
    assert_eq!(en.prompt, "Message from another session");
    assert!(en.prompt_is_notice);

    let id = open_prompt("c-cross-id", cross_prompt, UiLang::Id);
    assert_eq!(id.prompt, "Pesan dari sesi lain");
    assert!(id.prompt_is_notice);

    let mid = open_prompt(
        "c-cross-mid",
        "docs mention <cross-session-message from=\"s0\"> here",
        UiLang::En,
    );
    assert_eq!(
        mid.prompt,
        "docs mention <cross-session-message from=\"s0\"> here"
    );
    assert!(!mid.prompt_is_notice);
}
