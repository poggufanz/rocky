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
        card_text(UiLang::En, &CardMsg::FailuresChip { n: 1 }),
        "1 failed"
    );
    assert_eq!(
        card_text(UiLang::Id, &CardMsg::FailuresChip { n: 3 }),
        "3 gagal"
    );
    assert_eq!(
        card_text(UiLang::En, &CardMsg::CrossSessionPrompt),
        "Message from another session"
    );
    assert_eq!(
        card_text(UiLang::Id, &CardMsg::CrossSessionPrompt),
        "Pesan dari sesi lain"
    );
}
