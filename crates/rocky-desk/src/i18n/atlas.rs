//! Copy for the agents atlas, in English and Indonesian.
//!
//! Each language has its own exhaustive match, so adding a variant fails the
//! build until both English and Indonesian copy exist.

use super::{UiLang, plural};
use crate::atlas_model::SkyWindow;

/// One user-visible atlas string, rendered through [`atlas_text`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AtlasMsg {
    Projects,
    SkyChart,
    Constellation,
    SkySub {
        repo: String,
    },
    Window(SkyWindow),
    Quiet {
        last: String,
        action: Option<String>,
    },
    Earlier {
        at: String,
        edits: usize,
    },
    LegendSize,
    LegendFailed,
    LegendRunning,
    LegendLines,
    LegendScale {
        recent: String,
    },
    LegendRows,
    ClickStar,
    OpenProject {
        name: String,
    },
    More {
        n: usize,
    },
    SelectedStep {
        n: usize,
        of: usize,
    },
    RanAt,
    Session,
    Turn,
    Copy,
    FailedAfter {
        dur: String,
    },
    RunningFor {
        dur: String,
    },
    NeedsYouFor {
        dur: String,
    },
    Took {
        dur: String,
    },
    TurnSteps {
        at: String,
        n: usize,
    },
    PrevTurn {
        at: String,
    },
    NextTurn,
    LastEvent {
        at: String,
    },
    KeyStep,
    KeyLayout,
    KeyFind,
    Now,
    RowEdit,
    RowRead,
    RowCmd,
    Minutes {
        n: u64,
    },
}

pub fn atlas_text(lang: UiLang, msg: &AtlasMsg) -> String {
    match lang {
        UiLang::En => atlas_en(msg),
        UiLang::Id => atlas_id(msg),
    }
}

fn atlas_en(msg: &AtlasMsg) -> String {
    match msg {
        AtlasMsg::Projects => "Projects".into(),
        AtlasMsg::SkyChart => "Timeline".into(),
        AtlasMsg::Constellation => "Turn steps".into(),
        AtlasMsg::SkySub { repo } => format!("every agent step in {repo}, by time"),
        AtlasMsg::Window(SkyWindow::Min10) => "10 min".into(),
        AtlasMsg::Window(SkyWindow::Min30) => "30 min".into(),
        AtlasMsg::Window(SkyWindow::Hours2) => "2 hours".into(),
        AtlasMsg::Quiet { last, action } => match action {
            Some(action) => format!("no steps in this window. Last step {last}, {action}"),
            None => format!("no steps in this window. Last step {last}"),
        },
        AtlasMsg::Earlier { at, edits } => format!(
            "earlier: turn {at}, {edits} {}",
            plural(*edits as u64, "edit", "edits")
        ),
        AtlasMsg::LegendSize => "dot size: step duration, under 1s, 1 to 10s, over 10s".into(),
        AtlasMsg::LegendFailed => "failed".into(),
        AtlasMsg::LegendRunning => "running now".into(),
        AtlasMsg::LegendLines => {
            "Lines join one turn's steps in order. Blue: the turn running now.".into()
        }
        AtlasMsg::LegendScale { recent } => format!(
            "The last {recent} are drawn wider; the shaded part and the // mark show where the scale changes."
        ),
        AtlasMsg::LegendRows => {
            "Rows: what kind of step. Line: the order the agent took them.".into()
        }
        AtlasMsg::ClickStar => "Click a step to inspect it.".into(),
        AtlasMsg::OpenProject { name } => format!("Open {name}"),
        AtlasMsg::More { n } => format!("+{n} more"),
        AtlasMsg::SelectedStep { n, of } => format!("Selected step {n} of {of}"),
        AtlasMsg::RanAt => "ran at".into(),
        AtlasMsg::Session => "session".into(),
        AtlasMsg::Turn => "turn".into(),
        AtlasMsg::Copy => "Copy".into(),
        AtlasMsg::FailedAfter { dur } => format!("failed after {dur}"),
        AtlasMsg::RunningFor { dur } => format!("running {dur}"),
        AtlasMsg::NeedsYouFor { dur } => format!("needs you {dur}"),
        AtlasMsg::Took { dur } => format!("took {dur}"),
        AtlasMsg::TurnSteps { at, n } => format!(
            "turn {at}, {n} {} in order",
            plural(*n as u64, "step", "steps")
        ),
        AtlasMsg::PrevTurn { at } => format!("Previous turn, {at}"),
        AtlasMsg::NextTurn => "Next turn".into(),
        AtlasMsg::LastEvent { at } => format!("last event {at}"),
        AtlasMsg::KeyStep => "step".into(),
        AtlasMsg::KeyLayout => "layout".into(),
        AtlasMsg::KeyFind => "find file".into(),
        AtlasMsg::Now => "now".into(),
        AtlasMsg::RowEdit => "edit".into(),
        AtlasMsg::RowRead => "read".into(),
        AtlasMsg::RowCmd => "cmd".into(),
        AtlasMsg::Minutes { n } => format!("{n} min"),
    }
}

fn atlas_id(msg: &AtlasMsg) -> String {
    match msg {
        AtlasMsg::Projects => "Proyek".into(),
        AtlasMsg::SkyChart => "Lini waktu".into(),
        AtlasMsg::Constellation => "Langkah turn".into(),
        AtlasMsg::SkySub { repo } => format!("setiap langkah agent di {repo}, menurut waktu"),
        AtlasMsg::Window(SkyWindow::Min10) => "10 mnt".into(),
        AtlasMsg::Window(SkyWindow::Min30) => "30 mnt".into(),
        AtlasMsg::Window(SkyWindow::Hours2) => "2 jam".into(),
        AtlasMsg::Quiet { last, action } => match action {
            Some(action) => {
                format!("tidak ada langkah di rentang ini. Langkah terakhir {last}, {action}")
            }
            None => format!("tidak ada langkah di rentang ini. Langkah terakhir {last}"),
        },
        AtlasMsg::Earlier { at, edits } => format!("sebelumnya: turn {at}, {edits} edit"),
        AtlasMsg::LegendSize => {
            "ukuran titik: durasi langkah, di bawah 1 dtk, 1 sampai 10 dtk, di atas 10 dtk".into()
        }
        AtlasMsg::LegendFailed => "gagal".into(),
        AtlasMsg::LegendRunning => "sedang berjalan".into(),
        AtlasMsg::LegendLines => {
            "Garis menyambung langkah satu turn sesuai urutan. Biru: turn yang sedang berjalan."
                .into()
        }
        AtlasMsg::LegendScale { recent } => format!(
            "{recent} terakhir digambar lebih lebar; bagian berarsir dan tanda // menunjukkan pergantian skala."
        ),
        AtlasMsg::LegendRows => "Baris: jenis langkah. Garis: urutan yang diambil agent.".into(),
        AtlasMsg::ClickStar => "Klik langkah untuk melihat detailnya.".into(),
        AtlasMsg::OpenProject { name } => format!("Buka {name}"),
        AtlasMsg::More { n } => format!("+{n} lagi"),
        AtlasMsg::SelectedStep { n, of } => format!("Langkah terpilih {n} dari {of}"),
        AtlasMsg::RanAt => "jalan".into(),
        AtlasMsg::Session => "sesi".into(),
        AtlasMsg::Turn => "turn".into(),
        AtlasMsg::Copy => "Salin".into(),
        AtlasMsg::FailedAfter { dur } => format!("gagal setelah {dur}"),
        AtlasMsg::RunningFor { dur } => format!("berjalan {dur}"),
        AtlasMsg::NeedsYouFor { dur } => format!("perlu Anda {dur}"),
        AtlasMsg::Took { dur } => format!("makan {dur}"),
        AtlasMsg::TurnSteps { at, n } => format!("turn {at}, {n} langkah berurutan"),
        AtlasMsg::PrevTurn { at } => format!("Turn sebelumnya, {at}"),
        AtlasMsg::NextTurn => "Turn berikutnya".into(),
        AtlasMsg::LastEvent { at } => format!("event terakhir {at}"),
        AtlasMsg::KeyStep => "langkah".into(),
        AtlasMsg::KeyLayout => "tata letak".into(),
        AtlasMsg::KeyFind => "cari file".into(),
        AtlasMsg::Now => "kini".into(),
        AtlasMsg::RowEdit => "edit".into(),
        AtlasMsg::RowRead => "baca".into(),
        AtlasMsg::RowCmd => "cmd".into(),
        AtlasMsg::Minutes { n } => format!("{n} mnt"),
    }
}
