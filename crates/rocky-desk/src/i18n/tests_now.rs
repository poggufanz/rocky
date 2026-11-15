use super::*;

#[test]
fn now_card_copy_renders_en_and_id_with_plurals() {
    assert_eq!(
        card_text(UiLang::En, &CardMsg::SetupNotes { n: 1 }),
        "1 setup note"
    );
    assert_eq!(
        card_text(UiLang::En, &CardMsg::SetupNotes { n: 3 }),
        "3 setup notes"
    );
    assert_eq!(
        card_text(UiLang::Id, &CardMsg::SetupNotes { n: 3 }),
        "3 catatan setup"
    );

    assert_eq!(card_text(UiLang::En, &CardMsg::Show), "Show");
    assert_eq!(card_text(UiLang::Id, &CardMsg::Show), "Lihat");
    assert_eq!(card_text(UiLang::En, &CardMsg::Hide), "Hide");
    assert_eq!(card_text(UiLang::Id, &CardMsg::Hide), "Tutup");

    assert_eq!(
        card_text(UiLang::En, &CardMsg::ActiveCount { n: 3 }),
        "3 active"
    );
    assert_eq!(
        card_text(UiLang::Id, &CardMsg::ActiveCount { n: 3 }),
        "3 aktif"
    );
    assert_eq!(
        card_text(UiLang::En, &CardMsg::NeedYouCount { n: 1 }),
        "1 needs you"
    );
    assert_eq!(
        card_text(UiLang::En, &CardMsg::NeedYouCount { n: 2 }),
        "2 need you"
    );
    assert_eq!(
        card_text(UiLang::Id, &CardMsg::NeedYouCount { n: 1 }),
        "1 butuh kamu"
    );

    assert_eq!(
        card_text(UiLang::En, &CardMsg::EarlierSteps { n: 1 }),
        "+1 earlier step"
    );
    assert_eq!(
        card_text(UiLang::En, &CardMsg::EarlierSteps { n: 4 }),
        "+4 earlier steps"
    );
    assert_eq!(
        card_text(UiLang::Id, &CardMsg::EarlierSteps { n: 4 }),
        "+4 langkah sebelumnya"
    );

    assert_eq!(card_text(UiLang::En, &CardMsg::Collapse), "Collapse");
    assert_eq!(card_text(UiLang::Id, &CardMsg::Collapse), "Ringkas");

    assert_eq!(
        card_text(
            UiLang::En,
            &CardMsg::DoneAge {
                age: "46s".to_string()
            }
        ),
        "done 46s"
    );
    assert_eq!(
        card_text(
            UiLang::Id,
            &CardMsg::DoneAge {
                age: "46 dtk".to_string()
            }
        ),
        "selesai 46 dtk"
    );

    assert_eq!(
        card_text(UiLang::En, &CardMsg::ViewCard),
        "View card \u{203a}"
    );
    assert_eq!(
        card_text(UiLang::Id, &CardMsg::ViewCard),
        "Lihat kartu \u{203a}"
    );

    assert_eq!(
        card_text(UiLang::En, &CardMsg::IdleSessions { n: 1 }),
        "1 idle session"
    );
    assert_eq!(
        card_text(UiLang::En, &CardMsg::IdleSessions { n: 2 }),
        "2 idle sessions"
    );
    assert_eq!(
        card_text(UiLang::Id, &CardMsg::IdleSessions { n: 2 }),
        "2 sesi idle"
    );

    assert_eq!(
        card_text(UiLang::En, &CardMsg::FailuresChip { n: 1 }),
        "1 failed"
    );
    assert_eq!(
        card_text(UiLang::Id, &CardMsg::FailuresChip { n: 3 }),
        "3 gagal"
    );
}
