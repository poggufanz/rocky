use super::*;
use crate::atlas_model::SkyWindow;

fn s(v: &str) -> String {
    v.to_string()
}

fn check(msg: AtlasMsg, en: &str, id: &str) {
    assert_eq!(atlas_text(UiLang::En, &msg), en, "en {msg:?}");
    assert_eq!(atlas_text(UiLang::Id, &msg), id, "id {msg:?}");
}

#[test]
fn atlas_copy_renders_en_and_id() {
    check(AtlasMsg::Projects, "Projects", "Proyek");
    check(AtlasMsg::SkyChart, "Sky chart", "Peta langit");
    check(AtlasMsg::Constellation, "Constellation", "Rasi");
    check(
        AtlasMsg::SkySub { repo: s("rocky") },
        "every agent step in rocky, by time",
        "setiap langkah agent di rocky, menurut waktu",
    );
    check(AtlasMsg::Window(SkyWindow::Min10), "10 min", "10 mnt");
    check(AtlasMsg::Window(SkyWindow::Min30), "30 min", "30 mnt");
    check(AtlasMsg::Window(SkyWindow::Hours2), "2 hours", "2 jam");
    check(
        AtlasMsg::Quiet {
            last: s("4m ago"),
            action: Some(s("cargo test")),
        },
        "no steps in this window. Last step 4m ago, cargo test",
        "tidak ada langkah di rentang ini. Langkah terakhir 4m ago, cargo test",
    );
    check(
        AtlasMsg::Quiet {
            last: s("4m ago"),
            action: None,
        },
        "no steps in this window. Last step 4m ago",
        "tidak ada langkah di rentang ini. Langkah terakhir 4m ago",
    );
    check(
        AtlasMsg::Earlier {
            at: s("12:01"),
            edits: 1,
        },
        "earlier: turn 12:01, 1 edit",
        "sebelumnya: turn 12:01, 1 edit",
    );
    check(
        AtlasMsg::Earlier {
            at: s("12:01"),
            edits: 3,
        },
        "earlier: turn 12:01, 3 edits",
        "sebelumnya: turn 12:01, 3 edit",
    );
    check(
        AtlasMsg::LegendSize,
        "star size: step duration, under 1s, 1 to 10s, over 10s",
        "ukuran bintang: durasi langkah, di bawah 1 dtk, 1 sampai 10 dtk, di atas 10 dtk",
    );
    check(AtlasMsg::LegendFailed, "failed", "gagal");
    check(AtlasMsg::LegendRunning, "running now", "sedang berjalan");
    check(
        AtlasMsg::LegendLines,
        "Lines join one turn's steps in order. Blue: the turn running now.",
        "Garis menyambung langkah satu turn sesuai urutan. Biru: turn yang sedang berjalan.",
    );
    check(
        AtlasMsg::LegendScale { recent: s("3 min") },
        "The last 3 min are drawn wider; the shaded part and the // mark show where the scale changes.",
        "3 min terakhir digambar lebih lebar; bagian berarsir dan tanda // menunjukkan pergantian skala.",
    );
    check(
        AtlasMsg::LegendRows,
        "Rows: what kind of step. Line: the order the agent took them.",
        "Baris: jenis langkah. Garis: urutan yang diambil agent.",
    );
    check(
        AtlasMsg::ClickStar,
        "Click a star to inspect it.",
        "Klik bintang untuk melihat detailnya.",
    );
    check(
        AtlasMsg::OpenProject { name: s("rocky") },
        "Open rocky",
        "Buka rocky",
    );
    check(AtlasMsg::More { n: 4 }, "+4 more", "+4 lagi");
    check(
        AtlasMsg::SelectedStep { n: 2, of: 9 },
        "Selected step 2 of 9",
        "Langkah terpilih 2 dari 9",
    );
    check(AtlasMsg::RanAt, "ran at", "jalan");
    check(AtlasMsg::Session, "session", "sesi");
    check(AtlasMsg::Turn, "turn", "turn");
    check(AtlasMsg::Copy, "Copy", "Salin");
    check(
        AtlasMsg::FailedAfter { dur: s("2s") },
        "failed after 2s",
        "gagal setelah 2s",
    );
    check(
        AtlasMsg::RunningFor { dur: s("2s") },
        "running 2s",
        "berjalan 2s",
    );
    check(
        AtlasMsg::NeedsYouFor { dur: s("2s") },
        "needs you 2s",
        "perlu Anda 2s",
    );
    check(AtlasMsg::Took { dur: s("2s") }, "took 2s", "makan 2s");
    check(
        AtlasMsg::TurnSteps {
            at: s("12:01"),
            n: 1,
        },
        "turn 12:01, 1 step in order",
        "turn 12:01, 1 langkah berurutan",
    );
    check(
        AtlasMsg::TurnSteps {
            at: s("12:01"),
            n: 5,
        },
        "turn 12:01, 5 steps in order",
        "turn 12:01, 5 langkah berurutan",
    );
    check(
        AtlasMsg::PrevTurn { at: s("12:01") },
        "Previous turn, 12:01",
        "Turn sebelumnya, 12:01",
    );
    check(AtlasMsg::NextTurn, "Next turn", "Turn berikutnya");
    check(
        AtlasMsg::LastEvent { at: s("4m ago") },
        "last event 4m ago",
        "event terakhir 4m ago",
    );
    check(AtlasMsg::KeyStep, "step", "langkah");
    check(AtlasMsg::KeyLayout, "layout", "tata letak");
    check(AtlasMsg::KeyFind, "find file", "cari file");
}

#[test]
fn chart_row_names_and_scale_unit_render_en_and_id() {
    check(AtlasMsg::Now, "now", "kini");
    check(AtlasMsg::RowEdit, "edit", "edit");
    check(AtlasMsg::RowRead, "read", "baca");
    check(AtlasMsg::RowCmd, "cmd", "cmd");
    check(AtlasMsg::Minutes { n: 9 }, "9 min", "9 mnt");
}
