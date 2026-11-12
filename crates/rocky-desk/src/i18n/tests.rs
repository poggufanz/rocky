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
    assert_eq!(
        en(&Msg::SubagentsHidden { n: 1, working: 1 }),
        "+1 subagent (1 working)"
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
