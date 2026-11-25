use super::*;

#[test]
fn every_variant_renders_in_both_languages() {
    for m in samples() {
        assert!(!en(&m).trim().is_empty(), "{m:?}");
        assert!(!id(&m).trim().is_empty(), "{m:?}");
    }
}

#[test]
fn setup_catalog_renders_every_sample_in_both_languages() {
    for m in setup_samples() {
        assert!(!setup_en(&m).trim().is_empty(), "{m:?}");
        assert!(!setup_id(&m).trim().is_empty(), "{m:?}");
    }
}

#[test]
fn setting_overrides_detection() {
    assert_eq!(resolve_lang(Lang::En, UiLang::Id), UiLang::En);
    assert_eq!(resolve_lang(Lang::Id, UiLang::En), UiLang::Id);
    assert_eq!(resolve_lang(Lang::Auto, UiLang::Id), UiLang::Id);
}

#[test]
fn indonesian_is_detected_from_langid_and_env() {
    assert!(primary_is_indonesian(0x0421));
    assert!(!primary_is_indonesian(0x0409));
    assert_eq!(
        lang_from_env(None, Some("id_ID.UTF-8"), Some("en_US")),
        UiLang::Id
    );
    assert_eq!(
        lang_from_env(Some("en_US"), Some("id_ID"), None),
        UiLang::En
    );
    assert_eq!(lang_from_env(Some(""), None, None), UiLang::En);
}

#[test]
fn m0_english_copy_is_unchanged() {
    assert_eq!(
        en(&Msg::Tooltip {
            working: 2,
            needs_you: 1,
            failed: 0,
            done: 0,
            idle: 0
        }),
        "rocky: 2 working, 1 needs you"
    );
    assert_eq!(
        en(&Msg::Tooltip {
            working: 0,
            needs_you: 0,
            failed: 0,
            done: 0,
            idle: 0
        }),
        "rocky: idle"
    );
    assert_eq!(en(&Msg::Age { secs: 130 }), "2m");
    assert_eq!(en(&Msg::NoAgents), "No agents recorded yet.");
}

#[test]
fn spool_pending_counts_files() {
    assert_eq!(en(&Msg::SpoolPending { n: 3 }), "3 spool files pending.");
    assert_eq!(id(&Msg::SpoolPending { n: 3 }), "3 berkas spool tertunda.");
}

#[test]
fn english_counts_of_one_are_singular() {
    assert_eq!(
        en(&Msg::SubagentsStillWorking { n: 1 }),
        "1 subagent still working"
    );
    assert_eq!(
        en(&Msg::SubagentsStillWorking { n: 2 }),
        "2 subagents still working"
    );
    assert_eq!(en(&Msg::EarlierGaps { n: 1 }), "1 earlier gap");
    assert_eq!(en(&Msg::SpoolPending { n: 1 }), "1 spool file pending.");
    assert_eq!(
        id(&Msg::SubagentsStillWorking { n: 1 }),
        "1 subagen masih bekerja"
    );
}

#[test]
fn translations_follow_the_ui_language() {
    assert_eq!(tr(UiLang::En, &Msg::MenuQuit), "Quit");
    assert_eq!(tr(UiLang::Id, &Msg::MenuQuit), "Keluar");
}

#[test]
fn hooks_restored_gap_ends_at_the_restore_time() {
    let gap = Msg::Gap {
        count: 0,
        from: "14:00".into(),
        to: "14:02".into(),
        reason: GapReason::HooksRestored,
    };
    assert_eq!(
        en(&gap),
        "Events before 14:02 may be missing: Rocky hooks were restored then."
    );
    assert_eq!(
        id(&gap),
        "Event sebelum 14:02 mungkin hilang: hook Rocky baru dipasang ulang saat itu."
    );
}

#[test]
fn delete_history_ask_says_recording_stops_in_both_languages() {
    let m = SetupMsg::DeleteHistoryAsk { name: "app".into() };
    assert!(setup_en(&m).contains("stop recording"), "{}", setup_en(&m));
    assert!(
        setup_id(&m).contains("berhenti merekam"),
        "{}",
        setup_id(&m)
    );
}

fn sample_labels() -> Vec<rocky_proto::cards::Label> {
    use rocky_proto::cards::Label;

    vec![
        Label::ParamsChanged {
            added: 1,
            removed: 2,
            changed: 3,
        },
        Label::ReturnTypeChanged {},
        Label::SymbolRemoved {},
        Label::SymbolAdded {},
        Label::SymbolRenamed {
            from: "oldFn".into(),
        },
        Label::GuardAdded {},
        Label::ConditionChanged {},
        Label::BranchAdded {},
        Label::BranchRemoved {},
        Label::ErrorHandlingAdded {},
        Label::ErrorHandlingRemoved {},
        Label::LoopAdded {},
        Label::LoopRemoved {},
        Label::ReturnChanged {},
        Label::CallAdded {
            name: "validate".into(),
        },
        Label::CallRemoved {
            name: "legacyCheck".into(),
        },
        Label::AwaitChanged {
            added: 1,
            removed: 1,
        },
        Label::BodyChanged {},
        Label::ValueChanged {
            name: "MAX_RETRY".into(),
            before: "3".into(),
            after: "5".into(),
        },
        Label::ConfigChanged {
            key: "timeout".into(),
            before: None,
            after: Some("30s".into()),
        },
        Label::DepAdded {
            name: "serde".into(),
            version: "1.0".into(),
        },
        Label::DepRemoved {
            name: "old_pkg".into(),
        },
        Label::DepVersion {
            name: "tokio".into(),
            before: "1.37".into(),
            after: "1.40".into(),
        },
        Label::ImportAdded {
            module: "std::path::Path".into(),
        },
        Label::ImportRemoved {
            module: "std::env".into(),
        },
        Label::TestAdded {
            name: "parses_empty".into(),
        },
        Label::TestRemoved {
            name: "old_smoke".into(),
        },
        Label::TestSkipped {
            name: "slow_sync".into(),
        },
        Label::TestOnly {
            name: "focus_case".into(),
        },
        Label::FileNew {},
        Label::FileDeleted {},
        Label::FileRenamed {
            from: "src/old.rs".into(),
        },
        Label::FormatOnly {},
        Label::Rewrite { pct: 80 },
        Label::LockfileChanged {},
        Label::LinesChanged {
            added: 12,
            removed: 4,
        },
        Label::TooLarge {},
        Label::NotCaptured {},
    ]
}

fn all_coverage_reasons() -> [rocky_proto::cards::CoverageReason; 6] {
    use rocky_proto::cards::CoverageReason;

    [
        CoverageReason::DaemonGap,
        CoverageReason::CaptureLate,
        CoverageReason::CaptureOff,
        CoverageReason::TooLarge,
        CoverageReason::TranscriptUnreadable,
        CoverageReason::TurnUnclosed,
    ]
}

fn all_symbol_kinds() -> [rocky_proto::cards::SymbolKind; 11] {
    use rocky_proto::cards::SymbolKind;

    [
        SymbolKind::Function,
        SymbolKind::Method,
        SymbolKind::Class,
        SymbolKind::Struct,
        SymbolKind::Enum,
        SymbolKind::Trait,
        SymbolKind::Interface,
        SymbolKind::Type,
        SymbolKind::Const,
        SymbolKind::Test,
        SymbolKind::Key,
    ]
}

#[test]
fn card_catalog_renders_every_sample_in_both_languages() {
    for m in card_samples() {
        assert!(!card_text(UiLang::En, &m).trim().is_empty(), "{m:?}");
        assert!(!card_text(UiLang::Id, &m).trim().is_empty(), "{m:?}");
    }
    let labels = sample_labels();
    assert_eq!(labels.len(), 38);
    for label in &labels {
        for kind in [None, Some(rocky_proto::cards::SymbolKind::Function)] {
            assert!(
                !label_chip(UiLang::En, label, kind).trim().is_empty(),
                "{label:?}"
            );
            assert!(
                !label_chip(UiLang::Id, label, kind).trim().is_empty(),
                "{label:?}"
            );
            assert!(
                !label_full(UiLang::En, label, kind).trim().is_empty(),
                "{label:?}"
            );
            assert!(
                !label_full(UiLang::Id, label, kind).trim().is_empty(),
                "{label:?}"
            );
        }
    }
    for r in all_coverage_reasons() {
        assert!(!reason_text(UiLang::En, r).trim().is_empty(), "{r:?}");
        assert!(!reason_text(UiLang::Id, r).trim().is_empty(), "{r:?}");
    }
}

#[test]
fn card_templates_have_no_causal_words() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../../../fixtures/causal-words.json"))
            .expect("valid causal-words.json");
    let id_banned: Vec<&str> = fixture["id_words"]
        .as_array()
        .expect("id_words array")
        .iter()
        .map(|v| v.as_str().expect("id_words string"))
        .collect();
    let en_banned: Vec<&str> = fixture["en_phrases"]
        .as_array()
        .expect("en_phrases array")
        .iter()
        .map(|v| v.as_str().expect("en_phrases string"))
        .collect();

    let mut rendered = Vec::new();
    for lang in [UiLang::En, UiLang::Id] {
        for m in card_samples() {
            rendered.push(card_text(lang, &m));
        }
        for label in sample_labels() {
            rendered.push(label_chip(lang, &label, None));
            rendered.push(label_full(lang, &label, None));
            for kind in all_symbol_kinds() {
                rendered.push(label_chip(lang, &label, Some(kind)));
                rendered.push(label_full(lang, &label, Some(kind)));
            }
        }
        for r in all_coverage_reasons() {
            rendered.push(reason_text(lang, r));
        }
    }

    for text in rendered {
        let lower = text.to_lowercase();
        for word in lower.split(|c: char| !c.is_alphanumeric()) {
            assert!(
                !id_banned.contains(&word),
                "banned ID word `{word}` in `{text}`"
            );
        }
        for phrase in &en_banned {
            assert!(
                !lower.contains(phrase),
                "banned EN phrase `{phrase}` in `{text}`"
            );
        }
    }
}

#[test]
fn chip_uses_kind_word() {
    use rocky_proto::cards::{Label, SymbolKind};

    assert_eq!(
        label_chip(
            UiLang::Id,
            &Label::SymbolAdded {},
            Some(SymbolKind::Function)
        ),
        "fungsi baru"
    );
    assert_eq!(
        label_chip(
            UiLang::En,
            &Label::SymbolAdded {},
            Some(SymbolKind::Function)
        ),
        "new function"
    );
    assert_eq!(
        label_chip(UiLang::Id, &Label::SymbolAdded {}, None),
        "file baru"
    );
    assert_eq!(
        label_chip(UiLang::En, &Label::SymbolAdded {}, None),
        "new file"
    );
    assert_eq!(
        label_chip(
            UiLang::Id,
            &Label::SymbolRemoved {},
            Some(SymbolKind::Class)
        ),
        "kelas dihapus"
    );
    assert_eq!(
        label_chip(
            UiLang::En,
            &Label::SymbolRemoved {},
            Some(SymbolKind::Class)
        ),
        "class removed"
    );
    assert_eq!(
        label_chip(UiLang::Id, &Label::SymbolAdded {}, Some(SymbolKind::Const)),
        "konstanta baru"
    );
    assert_eq!(
        label_chip(UiLang::Id, &Label::SymbolAdded {}, Some(SymbolKind::Type)),
        "tipe baru"
    );
    assert_eq!(
        label_chip(UiLang::Id, &Label::SymbolAdded {}, Some(SymbolKind::Key)),
        "kunci baru"
    );
}

#[test]
fn full_form_omits_zero_parts() {
    use rocky_proto::cards::{Label, SymbolKind};

    let one_added = Label::ParamsChanged {
        added: 1,
        removed: 0,
        changed: 0,
    };
    assert_eq!(
        label_full(UiLang::Id, &one_added, Some(SymbolKind::Function)),
        "parameter: 1 baru"
    );
    assert_eq!(
        label_full(UiLang::En, &one_added, Some(SymbolKind::Function)),
        "parameters: 1 added"
    );

    let two_parts = Label::ParamsChanged {
        added: 2,
        removed: 0,
        changed: 3,
    };
    assert_eq!(
        label_full(UiLang::Id, &two_parts, None),
        "parameter: 2 baru, 3 diubah"
    );
    assert_eq!(
        label_full(UiLang::En, &two_parts, None),
        "parameters: 2 added, 3 changed"
    );

    assert_eq!(
        label_full(
            UiLang::En,
            &Label::AwaitChanged {
                added: 2,
                removed: 0
            },
            None
        ),
        "await +2"
    );
    assert_eq!(
        label_full(
            UiLang::Id,
            &Label::AwaitChanged {
                added: 0,
                removed: 1
            },
            None
        ),
        "await \u{2212}1"
    );
    assert_eq!(
        label_full(
            UiLang::En,
            &Label::LinesChanged {
                added: 5,
                removed: 0
            },
            None
        ),
        "+5"
    );
    assert_eq!(
        label_full(
            UiLang::Id,
            &Label::LinesChanged {
                added: 0,
                removed: 4
            },
            None
        ),
        "\u{2212}4"
    );
    assert_eq!(
        label_full(
            UiLang::En,
            &Label::ConfigChanged {
                key: "port".into(),
                before: None,
                after: Some("8080".into())
            },
            None
        ),
        "port: \u{2014} \u{2192} 8080"
    );
}

#[test]
fn card_copy_matches_brief_details() {
    use rocky_proto::cards::CoverageReason;

    assert_eq!(
        card_text(UiLang::En, &CardMsg::MetaEdits { n: 1 }),
        "1 edit"
    );
    assert_eq!(
        card_text(UiLang::En, &CardMsg::MetaEdits { n: 3 }),
        "3 edits"
    );
    assert_eq!(
        card_text(UiLang::Id, &CardMsg::MetaEdits { n: 1 }),
        "1 edit"
    );
    assert_eq!(
        card_text(UiLang::Id, &CardMsg::MetaEdits { n: 3 }),
        "3 edit"
    );

    assert_eq!(
        card_text(UiLang::Id, &CardMsg::Duration { secs: 45 }),
        "45 dtk"
    );
    assert_eq!(
        card_text(UiLang::En, &CardMsg::Duration { secs: 45 }),
        "45 s"
    );
    assert_eq!(
        card_text(UiLang::Id, &CardMsg::Duration { secs: 125 }),
        "2 mnt"
    );
    assert_eq!(
        card_text(UiLang::En, &CardMsg::Duration { secs: 125 }),
        "2 min"
    );

    let partial = CardMsg::CoveragePartial {
        reasons: vec![CoverageReason::DaemonGap, CoverageReason::TurnUnclosed],
    };
    assert_eq!(
        card_text(UiLang::Id, &partial),
        "Sebagian \u{00b7} daemon sempat mati, turn tidak selesai"
    );
    assert_eq!(
        card_text(UiLang::En, &partial),
        "Partial \u{00b7} daemon was down, turn not closed"
    );

    assert_eq!(
        card_text(UiLang::Id, &CardMsg::BackDone),
        "\u{2039} Selesai"
    );
    assert_eq!(card_text(UiLang::En, &CardMsg::BackDone), "\u{2039} Done");
    assert_eq!(card_text(UiLang::Id, &CardMsg::Loading), "Memuat\u{2026}");
    assert_eq!(card_text(UiLang::En, &CardMsg::Loading), "Loading\u{2026}");
    assert_eq!(
        card_text(UiLang::Id, &CardMsg::CodeFold { n: 4 }),
        "\u{2026} 4 baris"
    );
    assert_eq!(
        card_text(UiLang::En, &CardMsg::CodeFold { n: 4 }),
        "\u{2026} 4 lines"
    );
    assert_eq!(
        card_text(UiLang::Id, &CardMsg::DiffPage { page: 2, total: 5 }),
        "Halaman 2/5"
    );
    assert_eq!(
        card_text(UiLang::En, &CardMsg::DiffPage { page: 2, total: 5 }),
        "Page 2 of 5"
    );
    assert_eq!(
        card_text(UiLang::Id, &CardMsg::BashGroupBefore { n: 2 }),
        "2 file berubah saat"
    );
    assert_eq!(
        card_text(UiLang::En, &CardMsg::BashGroupBefore { n: 2 }),
        "2 files changed while"
    );
    assert_eq!(card_text(UiLang::Id, &CardMsg::BashGroupAfter), "berjalan");
    assert_eq!(card_text(UiLang::En, &CardMsg::BashGroupAfter), "ran");
    assert_eq!(
        card_text(UiLang::Id, &CardMsg::BashUncertain),
        "\u{00b7} agent tidak pasti"
    );
    assert_eq!(
        card_text(UiLang::En, &CardMsg::BashUncertain),
        "\u{00b7} agent uncertain"
    );
    assert_eq!(
        card_text(UiLang::Id, &CardMsg::CoveragePartial { reasons: vec![] }),
        "Sebagian"
    );
    assert_eq!(
        card_text(UiLang::En, &CardMsg::CoveragePartial { reasons: vec![] }),
        "Partial"
    );
    assert_eq!(
        card_text(UiLang::En, &CardMsg::TaskNoticePrompt),
        "Background task notice"
    );
    assert_eq!(
        card_text(UiLang::Id, &CardMsg::TaskNoticePrompt),
        "Notifikasi task latar"
    );
}

#[test]
fn related_attempts_copy_matches_cli_and_spec() {
    use rocky_proto::pipe::AttemptOutcome as O;

    let cases = [
        (O::Passed, "passed", "lolos"),
        (O::PossiblePass, "possible pass", "mungkin lolos"),
        (O::SameFailure, "failed same way", "gagal sama"),
        (O::DifferentFailure, "other error", "gagal lain"),
        (O::NoLaterRun, "no later run", "belum dijalankan lagi"),
        (O::Unknown, "unknown", "tidak diketahui"),
    ];
    for (outcome, en, id) in cases {
        let message = CardMsg::AttemptOutcomeLabel { outcome };
        assert_eq!(card_text(UiLang::En, &message), en);
        assert_eq!(card_text(UiLang::Id, &message), id);
    }
    assert_eq!(
        card_text(UiLang::En, &CardMsg::RelatedHeading),
        "Earlier attempts"
    );
    assert_eq!(
        card_text(UiLang::Id, &CardMsg::RelatedHeading),
        "Percobaan sebelumnya"
    );
    assert_eq!(
        card_text(UiLang::En, &CardMsg::RelatedFooter),
        "Rocky records order, not cause."
    );
    assert_eq!(
        card_text(UiLang::Id, &CardMsg::RelatedFooter),
        "Rocky mencatat urutan, bukan sebab."
    );
    let more = CardMsg::RelatedMoreFiles { n: 2 };
    assert_eq!(card_text(UiLang::En, &more), "+2 more");
    assert_eq!(card_text(UiLang::Id, &more), "+2 lagi");
}

fn card_msg_variant_count() -> usize {
    // Exhaustive guard so adding a CardMsg variant forces updating this count and card_samples().
    let check = |m: &CardMsg| match m {
        CardMsg::SectionDone
        | CardMsg::SearchPlaceholder
        | CardMsg::LoadMore
        | CardMsg::Empty
        | CardMsg::EmptyForProject
        | CardMsg::Loading
        | CardMsg::MetaEdits { .. }
        | CardMsg::MetaImportant { .. }
        | CardMsg::MoreEdits { .. }
        | CardMsg::YouAsked
        | CardMsg::AgentSaid
        | CardMsg::NoAgentWords
        | CardMsg::MainAgent
        | CardMsg::Duration { .. }
        | CardMsg::CoverageFull
        | CardMsg::CoveragePartial { .. }
        | CardMsg::OutsideFiles { .. }
        | CardMsg::ViewFullDiff
        | CardMsg::DiffNotStored
        | CardMsg::DiffPage { .. }
        | CardMsg::CardNotFound
        | CardMsg::CodeFold { .. }
        | CardMsg::CodeFoldMore { .. }
        | CardMsg::UnrecordedChip
        | CardMsg::UnrecordedTooltip
        | CardMsg::OutsideRepo
        | CardMsg::OtherRepo
        | CardMsg::FormatCollapse { .. }
        | CardMsg::ViaBash
        | CardMsg::BashGroupBefore { .. }
        | CardMsg::BashGroupAfter
        | CardMsg::BashUncertain
        | CardMsg::ExportedTooltip
        | CardMsg::TimelineHeading
        | CardMsg::SequenceEditsMore { .. }
        | CardMsg::SequenceFixAfterFail { .. }
        | CardMsg::TimelineMoreSteps { .. }
        | CardMsg::RelatedHeading
        | CardMsg::RelatedFooter
        | CardMsg::AttemptOutcomeLabel { .. }
        | CardMsg::RelatedMoreFiles { .. }
        | CardMsg::BackDone
        | CardMsg::SettingCards
        | CardMsg::NoticeConsent
        | CardMsg::TaskNoticePrompt
        | CardMsg::CrossSessionPrompt
        | CardMsg::SetupNotes { .. }
        | CardMsg::Show
        | CardMsg::Hide
        | CardMsg::FailuresChip { .. }
        | CardMsg::FlowCaption { .. }
        | CardMsg::FlowLegendRead
        | CardMsg::FlowLegendChanged
        | CardMsg::FlowLegendWorking
        | CardMsg::FlowEmpty
        | CardMsg::FlowMoreAgents { .. }
        | CardMsg::FlowMoreFiles { .. }
        | CardMsg::FlowReadBy { .. }
        | CardMsg::FlowChangedBy { .. }
        | CardMsg::FlowOpenLatest
        | CardMsg::CloseCard
        | CardMsg::TranslatedFrom { .. }
        | CardMsg::ShowOriginal
        | CardMsg::ShowTranslation
        | CardMsg::Translating => {}
    };
    let _ = check;
    65
}

#[test]
fn card_samples_covers_every_variant_and_label_full_details() {
    use rocky_proto::cards::{CoverageReason, Label, SymbolKind};
    use std::collections::HashSet;

    let distinct: HashSet<_> = card_samples().iter().map(std::mem::discriminant).collect();
    assert_eq!(distinct.len(), card_msg_variant_count());

    let expected_kinds = [
        (SymbolKind::Function, "fungsi", "function"),
        (SymbolKind::Method, "method", "method"),
        (SymbolKind::Class, "kelas", "class"),
        (SymbolKind::Struct, "struct", "struct"),
        (SymbolKind::Enum, "enum", "enum"),
        (SymbolKind::Trait, "trait", "trait"),
        (SymbolKind::Interface, "interface", "interface"),
        (SymbolKind::Type, "tipe", "type"),
        (SymbolKind::Const, "konstanta", "const"),
        (SymbolKind::Test, "test", "test"),
        (SymbolKind::Key, "kunci", "key"),
    ];
    for (kind, id_word, en_word) in expected_kinds {
        assert_eq!(
            label_chip(UiLang::Id, &Label::SymbolAdded {}, Some(kind)),
            format!("{id_word} baru")
        );
        assert_eq!(
            label_chip(UiLang::En, &Label::SymbolAdded {}, Some(kind)),
            format!("new {en_word}")
        );
    }

    let expected_reasons = [
        (
            CoverageReason::DaemonGap,
            "daemon sempat mati",
            "daemon was down",
        ),
        (
            CoverageReason::CaptureLate,
            "rekaman terlambat",
            "capture late",
        ),
        (CoverageReason::CaptureOff, "rekaman mati", "capture off"),
        (
            CoverageReason::TooLarge,
            "file terlalu besar",
            "file too large",
        ),
        (
            CoverageReason::TranscriptUnreadable,
            "transcript tak terbaca",
            "transcript unreadable",
        ),
        (
            CoverageReason::TurnUnclosed,
            "turn tidak selesai",
            "turn not closed",
        ),
    ];
    for (reason, id_str, en_str) in expected_reasons {
        assert_eq!(reason_text(UiLang::Id, reason), id_str);
        assert_eq!(reason_text(UiLang::En, reason), en_str);
    }

    let renamed = Label::SymbolRenamed {
        from: "oldFn".into(),
    };
    assert_eq!(
        label_full(UiLang::Id, &renamed, Some(SymbolKind::Method)),
        "method diganti nama dari oldFn"
    );
    assert_eq!(
        label_full(UiLang::En, &renamed, Some(SymbolKind::Method)),
        "method renamed from oldFn"
    );
    assert_eq!(
        label_full(
            UiLang::Id,
            &Label::FileRenamed {
                from: "a.rs".into()
            },
            None
        ),
        "dari a.rs"
    );
    assert_eq!(
        label_full(
            UiLang::En,
            &Label::FileRenamed {
                from: "a.rs".into()
            },
            None
        ),
        "from a.rs"
    );
    assert_eq!(
        label_full(UiLang::Id, &Label::Rewrite { pct: 75 }, None),
        "75% berubah"
    );
    assert_eq!(
        label_full(UiLang::En, &Label::Rewrite { pct: 75 }, None),
        "75% changed"
    );
    assert_eq!(
        label_full(
            UiLang::En,
            &Label::ConfigChanged {
                key: "k".into(),
                before: None,
                after: None
            },
            None
        ),
        "k: \u{2014} \u{2192} \u{2014}"
    );
    assert_eq!(
        label_full(
            UiLang::Id,
            &Label::DepAdded {
                name: "serde".into(),
                version: "1.0".into()
            },
            None
        ),
        "serde 1.0"
    );
    assert_eq!(
        label_full(
            UiLang::En,
            &Label::ParamsChanged {
                added: 0,
                removed: 0,
                changed: 0
            },
            None
        ),
        "parameters changed"
    );
}

#[test]
fn label_chips_en_match_shared_vectors() {
    use rocky_proto::cards::{Label, SymbolKind};
    use std::collections::{HashMap, HashSet};

    let raw = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/cards/label-chips-en.json"
    ));
    let entries: Vec<serde_json::Value> =
        serde_json::from_str(raw).expect("parse shared label-chips-en vectors");
    assert!(
        !entries.is_empty(),
        "shared label-chips-en vectors are empty"
    );

    let mut covered_variants = HashSet::new();
    let mut symbol_kinds: HashMap<&'static str, HashSet<Option<SymbolKind>>> = HashMap::new();

    for (idx, entry) in entries.iter().enumerate() {
        let obj = entry
            .as_object()
            .unwrap_or_else(|| panic!("vector {idx} is not a JSON object"));
        let label_val = obj
            .get("label")
            .unwrap_or_else(|| panic!("vector {idx} missing label"))
            .clone();
        let kind_val = obj
            .get("kind")
            .unwrap_or_else(|| panic!("vector {idx} missing kind"))
            .clone();
        let expected_chip = obj
            .get("chip")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_else(|| panic!("vector {idx} missing string chip"));

        let label: Label = serde_json::from_value(label_val.clone())
            .unwrap_or_else(|err| panic!("vector {idx} invalid label: {err}"));
        let kind: Option<SymbolKind> = serde_json::from_value(kind_val.clone())
            .unwrap_or_else(|err| panic!("vector {idx} invalid kind: {err}"));

        assert_eq!(
            serde_json::to_value(&label).expect("serialize label"),
            label_val,
            "vector {idx}: label JSON does not match serde output"
        );
        assert_eq!(
            serde_json::to_value(kind).expect("serialize kind"),
            kind_val,
            "vector {idx}: kind JSON does not match serde output"
        );

        assert_eq!(
            label_chip(UiLang::En, &label, kind),
            expected_chip,
            "vector {idx}: label={label:?} kind={kind:?}"
        );

        covered_variants.insert(std::mem::discriminant(&label));
        match label {
            Label::SymbolAdded {} => {
                symbol_kinds.entry("symbol_added").or_default().insert(kind);
            }
            Label::SymbolRemoved {} => {
                symbol_kinds
                    .entry("symbol_removed")
                    .or_default()
                    .insert(kind);
            }
            Label::SymbolRenamed { .. } => {
                symbol_kinds
                    .entry("symbol_renamed")
                    .or_default()
                    .insert(kind);
            }
            _ => {}
        }
    }

    for sample in sample_labels() {
        assert!(
            covered_variants.contains(&std::mem::discriminant(&sample)),
            "shared label-chips-en vectors missing variant {sample:?}"
        );
    }

    for id in ["symbol_added", "symbol_removed", "symbol_renamed"] {
        let kinds = symbol_kinds
            .get(id)
            .unwrap_or_else(|| panic!("missing symbol vectors for {id}"));
        assert!(kinds.contains(&None), "{id} missing null kind");
        let named_count = kinds.iter().filter(|k| k.is_some()).count();
        assert!(
            named_count >= 2,
            "{id} needs at least two distinct SymbolKind vectors, got {named_count}"
        );
    }
}

#[test]
fn translate_settings_copy_in_both_languages() {
    use rocky_proto::translate::TranslateFailure;

    assert_eq!(
        setup_en(&SetupMsg::TranslateQuotesToggle),
        "Translate agent words to the display language"
    );
    assert_eq!(
        setup_id(&SetupMsg::TranslateQuotesToggle),
        "Terjemahkan kata agent ke bahasa tampilan"
    );

    assert_eq!(setup_en(&SetupMsg::TranslateOff), "Off");
    assert_eq!(setup_id(&SetupMsg::TranslateOff), "Mati");

    assert_eq!(
        setup_en(&SetupMsg::TranslateNeedsDownload),
        "Needs download (≈20 MB)"
    );
    assert_eq!(
        setup_id(&SetupMsg::TranslateNeedsDownload),
        "Perlu unduhan (≈20 MB)"
    );

    assert_eq!(
        setup_en(&SetupMsg::TranslateDownloading { percent: Some(40) }),
        "Downloading… 40%"
    );
    assert_eq!(
        setup_id(&SetupMsg::TranslateDownloading { percent: Some(40) }),
        "Mengunduh… 40%"
    );
    assert_eq!(
        setup_en(&SetupMsg::TranslateDownloading { percent: None }),
        "Downloading…"
    );
    assert_eq!(
        setup_id(&SetupMsg::TranslateDownloading { percent: None }),
        "Mengunduh…"
    );

    assert_eq!(setup_en(&SetupMsg::TranslateReady), "Ready");
    assert_eq!(setup_id(&SetupMsg::TranslateReady), "Siap");

    for (failure, en_str, id_str) in [
        (
            TranslateFailure::Download,
            "Failed: download",
            "Gagal: unduhan",
        ),
        (
            TranslateFailure::Checksum,
            "Failed: checksum",
            "Gagal: checksum",
        ),
        (TranslateFailure::Write, "Failed: write", "Gagal: tulis"),
        (TranslateFailure::Engine, "Failed: engine", "Gagal: engine"),
    ] {
        assert_eq!(setup_en(&SetupMsg::TranslateFailed { failure }), en_str);
        assert_eq!(setup_id(&SetupMsg::TranslateFailed { failure }), id_str);
    }

    assert_eq!(setup_en(&SetupMsg::TranslateDownload), "Download");
    assert_eq!(setup_id(&SetupMsg::TranslateDownload), "Unduh");
    assert_eq!(setup_en(&SetupMsg::TranslateRetry), "Retry");
    assert_eq!(setup_id(&SetupMsg::TranslateRetry), "Coba lagi");
    assert_eq!(
        setup_en(&SetupMsg::TranslateRemove),
        "Remove downloaded files"
    );
    assert_eq!(setup_id(&SetupMsg::TranslateRemove), "Hapus file unduhan");
    assert_eq!(setup_en(&SetupMsg::TranslateCancel), "Cancel");
    assert_eq!(setup_id(&SetupMsg::TranslateCancel), "Batal");

    assert_eq!(
        setup_en(&SetupMsg::TranslateConsentAsk),
        "Download about 20 MB from registry.npmjs.org and storage.googleapis.com? Your text never leaves this machine."
    );
    assert_eq!(
        setup_id(&SetupMsg::TranslateConsentAsk),
        "Unduh sekitar 20 MB dari registry.npmjs.org dan storage.googleapis.com? Teksmu tidak pernah keluar dari mesin ini."
    );

    assert_eq!(
        setup_en(&SetupMsg::TranslateBusy),
        "Busy finishing a translation. Try again in a moment."
    );
    assert_eq!(
        setup_id(&SetupMsg::TranslateBusy),
        "Masih menyelesaikan terjemahan. Coba lagi sebentar lagi."
    );

    // Daemon codes never reach the screen raw.
    for msg in [
        SetupMsg::TranslateDisabledError,
        SetupMsg::TranslateEngineError,
        SetupMsg::TranslateRemoveError,
        SetupMsg::TranslateUnknownError,
    ] {
        for text in [setup_en(&msg), setup_id(&msg)] {
            assert!(text.ends_with('.'), "{text}");
            assert!(!text.contains(": "), "{text}");
        }
    }
    assert_eq!(
        setup_en(&SetupMsg::TranslateUnknownError),
        "Request failed."
    );
    assert_eq!(
        setup_id(&SetupMsg::TranslateUnknownError),
        "Permintaan gagal."
    );

    assert_eq!(
        setup_en(&SetupMsg::TranslateRequestFailed {
            reason: "disk full".into()
        }),
        "Request failed: disk full"
    );
    assert_eq!(
        setup_id(&SetupMsg::TranslateRequestFailed {
            reason: "disk full".into()
        }),
        "Permintaan gagal: disk full"
    );
}

#[test]
fn translated_from_names_the_source_language() {
    use rocky_proto::translate::QuoteLang;

    assert_eq!(
        card_text(
            UiLang::En,
            &CardMsg::TranslatedFrom {
                from: QuoteLang::Id
            }
        ),
        "translated from Indonesian"
    );
    assert_eq!(
        card_text(
            UiLang::En,
            &CardMsg::TranslatedFrom {
                from: QuoteLang::En
            }
        ),
        "translated from English"
    );
    assert_eq!(
        card_text(
            UiLang::Id,
            &CardMsg::TranslatedFrom {
                from: QuoteLang::En
            }
        ),
        "diterjemahkan dari bahasa Inggris"
    );
    assert_eq!(
        card_text(
            UiLang::Id,
            &CardMsg::TranslatedFrom {
                from: QuoteLang::Id
            }
        ),
        "diterjemahkan dari bahasa Indonesia"
    );
    assert_eq!(
        card_text(UiLang::En, &CardMsg::ShowOriginal),
        "Show original"
    );
    assert_eq!(card_text(UiLang::Id, &CardMsg::ShowOriginal), "Lihat asli");
    assert_eq!(
        card_text(UiLang::En, &CardMsg::ShowTranslation),
        "Show translation"
    );
    assert_eq!(
        card_text(UiLang::Id, &CardMsg::ShowTranslation),
        "Lihat terjemahan"
    );
    assert_eq!(
        card_text(UiLang::En, &CardMsg::Translating),
        "Translating\u{2026}"
    );
    assert_eq!(
        card_text(UiLang::Id, &CardMsg::Translating),
        "Menerjemahkan\u{2026}"
    );
}
