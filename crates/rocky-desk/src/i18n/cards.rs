//! Copy for change cards, fact labels, and coverage reasons, in English and Indonesian.
//!
//! Each language has its own exhaustive match, so adding a variant fails the
//! build until both English and Indonesian copy exist.

use rocky_proto::cards::{CoverageReason, Label, SymbolKind};

use super::{UiLang, plural};

/// One user-visible change card UI string, rendered through [`card_text`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CardMsg {
    SectionNow,
    SectionDone,
    SearchPlaceholder,
    LoadMore,
    Empty,
    Loading,
    MetaEdits {
        n: usize,
    },
    MetaImportant {
        n: usize,
    },
    MoreEdits {
        n: usize,
    },
    YouAsked,
    AgentSaid,
    NoAgentWords,
    MainAgent,
    Duration {
        secs: u64,
    },
    CoverageFull,
    CoveragePartial {
        reasons: Vec<CoverageReason>,
    },
    OutsideFiles {
        n: u64,
    },
    ViewFullDiff,
    DiffNotStored,
    DiffPage {
        page: u32,
        total: u32,
    },
    CardNotFound,
    CodeFold {
        n: u32,
    },
    CodeFoldMore {
        n: u32,
    },
    UnrecordedChip,
    UnrecordedTooltip,
    OutsideRepo,
    OtherRepo,
    FormatCollapse {
        n: usize,
    },
    /// Prefix rendered before a Bash command span in tooltips.
    ViaBash,
    /// Prefix rendered before a Bash command span in a Bash group row.
    BashGroupBefore {
        n: usize,
    },
    /// Suffix rendered after a Bash command span in a Bash group row.
    BashGroupAfter,
    /// Appended after [`CardMsg::BashGroupAfter`] when attribution is uncertain.
    BashUncertain,
    ExportedTooltip,
    TimelineHeading,
    TimelineMoreSteps {
        n: usize,
    },
    BackDone,
    SettingCards,
    NoticeConsent,
    TaskNoticePrompt,
}

/// Every [`CardMsg`] variant with sample arguments for parity and text scans.
pub fn card_samples() -> Vec<CardMsg> {
    vec![
        CardMsg::SectionNow,
        CardMsg::SectionDone,
        CardMsg::SearchPlaceholder,
        CardMsg::LoadMore,
        CardMsg::Empty,
        CardMsg::Loading,
        CardMsg::MetaEdits { n: 1 },
        CardMsg::MetaEdits { n: 3 },
        CardMsg::MetaImportant { n: 2 },
        CardMsg::MoreEdits { n: 4 },
        CardMsg::YouAsked,
        CardMsg::AgentSaid,
        CardMsg::NoAgentWords,
        CardMsg::MainAgent,
        CardMsg::Duration { secs: 45 },
        CardMsg::Duration { secs: 125 },
        CardMsg::CoverageFull,
        CardMsg::CoveragePartial {
            reasons: vec![CoverageReason::DaemonGap, CoverageReason::CaptureLate],
        },
        CardMsg::OutsideFiles { n: 2 },
        CardMsg::ViewFullDiff,
        CardMsg::DiffNotStored,
        CardMsg::DiffPage { page: 1, total: 3 },
        CardMsg::CardNotFound,
        CardMsg::CodeFold { n: 12 },
        CardMsg::CodeFoldMore { n: 8 },
        CardMsg::UnrecordedChip,
        CardMsg::UnrecordedTooltip,
        CardMsg::OutsideRepo,
        CardMsg::OtherRepo,
        CardMsg::FormatCollapse { n: 3 },
        CardMsg::ViaBash,
        CardMsg::BashGroupBefore { n: 2 },
        CardMsg::BashGroupAfter,
        CardMsg::BashUncertain,
        CardMsg::ExportedTooltip,
        CardMsg::TimelineHeading,
        CardMsg::TimelineMoreSteps { n: 5 },
        CardMsg::BackDone,
        CardMsg::SettingCards,
        CardMsg::NoticeConsent,
        CardMsg::TaskNoticePrompt,
    ]
}

/// Render a [`CardMsg`] in the requested UI language.
pub fn card_text(lang: UiLang, msg: &CardMsg) -> String {
    match lang {
        UiLang::En => card_en(msg),
        UiLang::Id => card_id(msg),
    }
}

fn card_en(msg: &CardMsg) -> String {
    match msg {
        CardMsg::SectionNow => "Now".to_string(),
        CardMsg::SectionDone => "Done".to_string(),
        CardMsg::SearchPlaceholder => "Search file or repo".to_string(),
        CardMsg::LoadMore => "Load more".to_string(),
        CardMsg::Empty => "No cards yet".to_string(),
        CardMsg::Loading => "Loading\u{2026}".to_string(),
        CardMsg::MetaEdits { n } => format!("{n} {}", plural(*n as u64, "edit", "edits")),
        CardMsg::MetaImportant { n } => format!("{n} important"),
        CardMsg::MoreEdits { n } => format!("+{n} more edits"),
        CardMsg::YouAsked => "You asked".to_string(),
        CardMsg::AgentSaid => "Agent said".to_string(),
        CardMsg::NoAgentWords => "No agent words recorded for this edit".to_string(),
        CardMsg::MainAgent => "main".to_string(),
        CardMsg::Duration { secs } => {
            if *secs < 60 {
                format!("{secs} s")
            } else {
                format!("{} min", secs / 60)
            }
        }
        CardMsg::CoverageFull => "Full record".to_string(),
        CardMsg::CoveragePartial { reasons } => {
            coverage_partial("Partial", reasons, UiLang::En)
        }
        CardMsg::OutsideFiles { n } => format!("{n} files changed outside the agent"),
        CardMsg::ViewFullDiff => "View full diff".to_string(),
        CardMsg::DiffNotStored => "The code for this edit is no longer stored".to_string(),
        CardMsg::DiffPage { page, total } => format!("Page {page} of {total}"),
        CardMsg::CardNotFound => "This card no longer exists".to_string(),
        CardMsg::CodeFold { n } => format!("\u{2026} {n} lines"),
        CardMsg::CodeFoldMore { n } => format!("\u{2026} {n} more lines"),
        CardMsg::UnrecordedChip => "not recorded".to_string(),
        CardMsg::UnrecordedTooltip => {
            "Repo not allowed yet. Only the path is recorded.".to_string()
        }
        CardMsg::OutsideRepo => "outside repo".to_string(),
        CardMsg::OtherRepo => "other repo".to_string(),
        CardMsg::FormatCollapse { n } => format!("{n} files changed formatting only"),
        CardMsg::ViaBash => "via Bash".to_string(),
        CardMsg::BashGroupBefore { n } => format!("{n} files changed while"),
        CardMsg::BashGroupAfter => "ran".to_string(),
        CardMsg::BashUncertain => "\u{00b7} agent uncertain".to_string(),
        CardMsg::ExportedTooltip => "public (per code)".to_string(),
        CardMsg::TimelineHeading => "Sequence".to_string(),
        CardMsg::TimelineMoreSteps { n } => format!("+{n} more steps"),
        CardMsg::BackDone => "\u{2039} Done".to_string(),
        CardMsg::SettingCards => "Change cards".to_string(),
        CardMsg::NoticeConsent => {
            "Change cards keep your prompts and the agent's words on this machine. You can turn them off in Settings."
                .to_string()
        }
        CardMsg::TaskNoticePrompt => "Background task notice".to_string(),
    }
}

fn card_id(msg: &CardMsg) -> String {
    match msg {
        CardMsg::SectionNow => "Sekarang".to_string(),
        CardMsg::SectionDone => "Selesai".to_string(),
        CardMsg::SearchPlaceholder => "Cari file atau repo".to_string(),
        CardMsg::LoadMore => "Muat lagi".to_string(),
        CardMsg::Empty => "Belum ada kartu".to_string(),
        CardMsg::Loading => "Memuat\u{2026}".to_string(),
        CardMsg::MetaEdits { n } => format!("{n} edit"),
        CardMsg::MetaImportant { n } => format!("{n} penting"),
        CardMsg::MoreEdits { n } => format!("+{n} edit lagi"),
        CardMsg::YouAsked => "Kamu minta".to_string(),
        CardMsg::AgentSaid => "Kata agent".to_string(),
        CardMsg::NoAgentWords => "Kata agent tidak tercatat di edit ini".to_string(),
        CardMsg::MainAgent => "utama".to_string(),
        CardMsg::Duration { secs } => {
            if *secs < 60 {
                format!("{secs} dtk")
            } else {
                format!("{} mnt", secs / 60)
            }
        }
        CardMsg::CoverageFull => "Rekaman lengkap".to_string(),
        CardMsg::CoveragePartial { reasons } => {
            coverage_partial("Sebagian", reasons, UiLang::Id)
        }
        CardMsg::OutsideFiles { n } => format!("{n} file berubah di luar agent"),
        CardMsg::ViewFullDiff => "Lihat diff penuh".to_string(),
        CardMsg::DiffNotStored => "Kode edit ini sudah tidak tersimpan".to_string(),
        CardMsg::DiffPage { page, total } => format!("Halaman {page}/{total}"),
        CardMsg::CardNotFound => "Kartu ini sudah tidak ada".to_string(),
        CardMsg::CodeFold { n } => format!("\u{2026} {n} baris"),
        CardMsg::CodeFoldMore { n } => format!("\u{2026} {n} baris lagi"),
        CardMsg::UnrecordedChip => "tidak direkam".to_string(),
        CardMsg::UnrecordedTooltip => {
            "Repo belum diizinkan. Hanya path yang tercatat.".to_string()
        }
        CardMsg::OutsideRepo => "di luar repo".to_string(),
        CardMsg::OtherRepo => "repo lain".to_string(),
        CardMsg::FormatCollapse { n } => format!("{n} file hanya berubah format"),
        CardMsg::ViaBash => "lewat Bash".to_string(),
        CardMsg::BashGroupBefore { n } => format!("{n} file berubah saat"),
        CardMsg::BashGroupAfter => "berjalan".to_string(),
        CardMsg::BashUncertain => "\u{00b7} agent tidak pasti".to_string(),
        CardMsg::ExportedTooltip => "publik (menurut kode)".to_string(),
        CardMsg::TimelineHeading => "Urutan".to_string(),
        CardMsg::TimelineMoreSteps { n } => format!("+{n} langkah"),
        CardMsg::BackDone => "\u{2039} Selesai".to_string(),
        CardMsg::SettingCards => "Kartu perubahan".to_string(),
        CardMsg::NoticeConsent => {
            "Kartu perubahan menyimpan prompt dan kata agent di mesin ini. Bisa dimatikan di Settings."
                .to_string()
        }
        CardMsg::TaskNoticePrompt => "Notifikasi task latar".to_string(),
    }
}

fn coverage_partial(head: &str, reasons: &[CoverageReason], lang: UiLang) -> String {
    if reasons.is_empty() {
        return head.to_string();
    }
    let joined: Vec<String> = reasons.iter().map(|r| reason_text(lang, *r)).collect();
    format!("{head} \u{00b7} {}", joined.join(", "))
}

/// Short chip text for a fact [`Label`], using `kind` (`file` when `None`) for symbol labels.
pub fn label_chip(lang: UiLang, label: &Label, kind: Option<SymbolKind>) -> String {
    match lang {
        UiLang::En => label_chip_en(label, kind),
        UiLang::Id => label_chip_id(label, kind),
    }
}

/// Full tooltip/detail text for a fact [`Label`], omitting zero count parts and rendering null as `—`.
pub fn label_full(lang: UiLang, label: &Label, kind: Option<SymbolKind>) -> String {
    match lang {
        UiLang::En => label_full_en(label, kind),
        UiLang::Id => label_full_id(label, kind),
    }
}

/// Render a [`CoverageReason`] in the requested UI language.
pub fn reason_text(lang: UiLang, r: CoverageReason) -> String {
    match lang {
        UiLang::En => reason_en(r).to_string(),
        UiLang::Id => reason_id(r).to_string(),
    }
}

fn reason_en(r: CoverageReason) -> &'static str {
    match r {
        CoverageReason::DaemonGap => "daemon was down",
        CoverageReason::CaptureLate => "capture late",
        CoverageReason::CaptureOff => "capture off",
        CoverageReason::TooLarge => "file too large",
        CoverageReason::TranscriptUnreadable => "transcript unreadable",
        CoverageReason::TurnUnclosed => "turn not closed",
    }
}

fn reason_id(r: CoverageReason) -> &'static str {
    match r {
        CoverageReason::DaemonGap => "daemon sempat mati",
        CoverageReason::CaptureLate => "rekaman terlambat",
        CoverageReason::CaptureOff => "rekaman mati",
        CoverageReason::TooLarge => "file terlalu besar",
        CoverageReason::TranscriptUnreadable => "transcript tak terbaca",
        CoverageReason::TurnUnclosed => "turn tidak selesai",
    }
}

fn kind_word(lang: UiLang, kind: Option<SymbolKind>) -> &'static str {
    match kind {
        None => "file",
        Some(k) => match lang {
            UiLang::En => kind_en(k),
            UiLang::Id => kind_id(k),
        },
    }
}

fn kind_en(kind: SymbolKind) -> &'static str {
    match kind {
        SymbolKind::Function => "function",
        SymbolKind::Method => "method",
        SymbolKind::Class => "class",
        SymbolKind::Struct => "struct",
        SymbolKind::Enum => "enum",
        SymbolKind::Trait => "trait",
        SymbolKind::Interface => "interface",
        SymbolKind::Type => "type",
        SymbolKind::Const => "const",
        SymbolKind::Test => "test",
        SymbolKind::Key => "key",
    }
}

fn kind_id(kind: SymbolKind) -> &'static str {
    match kind {
        SymbolKind::Function => "fungsi",
        SymbolKind::Method => "method",
        SymbolKind::Class => "kelas",
        SymbolKind::Struct => "struct",
        SymbolKind::Enum => "enum",
        SymbolKind::Trait => "trait",
        SymbolKind::Interface => "interface",
        SymbolKind::Type => "tipe",
        SymbolKind::Const => "konstanta",
        SymbolKind::Test => "test",
        SymbolKind::Key => "kunci",
    }
}

fn label_chip_en(label: &Label, kind: Option<SymbolKind>) -> String {
    let k = kind_word(UiLang::En, kind);
    match label {
        Label::ParamsChanged { .. } => "parameters changed".to_string(),
        Label::ReturnTypeChanged {} => "return type changed".to_string(),
        Label::SymbolRemoved {} => format!("{k} removed"),
        Label::SymbolAdded {} => format!("new {k}"),
        Label::SymbolRenamed { .. } => format!("{k} renamed"),
        Label::GuardAdded {} => "new guard".to_string(),
        Label::ConditionChanged {} => "condition changed".to_string(),
        Label::BranchAdded {} => "new branch".to_string(),
        Label::BranchRemoved {} => "branch removed".to_string(),
        Label::ErrorHandlingAdded {} => "error handling added".to_string(),
        Label::ErrorHandlingRemoved {} => "error handling removed".to_string(),
        Label::LoopAdded {} => "new loop".to_string(),
        Label::LoopRemoved {} => "loop removed".to_string(),
        Label::ReturnChanged {} => "return changed".to_string(),
        Label::CallAdded { name } => format!("calls {name}"),
        Label::CallRemoved { name } => format!("no longer calls {name}"),
        Label::AwaitChanged { .. } => "await changed".to_string(),
        Label::BodyChanged {} => "body changed".to_string(),
        Label::ValueChanged { .. } => "value changed".to_string(),
        Label::ConfigChanged { .. } => "config changed".to_string(),
        Label::DepAdded { .. } => "new dependency".to_string(),
        Label::DepRemoved { .. } => "dependency removed".to_string(),
        Label::DepVersion { .. } => "dependency version".to_string(),
        Label::ImportAdded { .. } => "new import".to_string(),
        Label::ImportRemoved { .. } => "import removed".to_string(),
        Label::TestAdded { .. } => "new test".to_string(),
        Label::TestRemoved { .. } => "test removed".to_string(),
        Label::TestSkipped { .. } => "test skipped".to_string(),
        Label::TestOnly { .. } => "test .only".to_string(),
        Label::FileNew {} => "new file".to_string(),
        Label::FileDeleted {} => "file deleted".to_string(),
        Label::FileRenamed { .. } => "file renamed".to_string(),
        Label::FormatOnly {} => "format only".to_string(),
        Label::Rewrite { .. } => "rewritten".to_string(),
        Label::LockfileChanged {} => "lockfile changed".to_string(),
        Label::LinesChanged { .. } => "lines changed".to_string(),
        Label::TooLarge {} => "too large".to_string(),
        Label::NotCaptured {} => "not captured".to_string(),
    }
}

fn label_chip_id(label: &Label, kind: Option<SymbolKind>) -> String {
    let k = kind_word(UiLang::Id, kind);
    match label {
        Label::ParamsChanged { .. } => "parameter berubah".to_string(),
        Label::ReturnTypeChanged {} => "tipe return diubah".to_string(),
        Label::SymbolRemoved {} => format!("{k} dihapus"),
        Label::SymbolAdded {} => format!("{k} baru"),
        Label::SymbolRenamed { .. } => format!("{k} diganti nama"),
        Label::GuardAdded {} => "guard baru".to_string(),
        Label::ConditionChanged {} => "kondisi diubah".to_string(),
        Label::BranchAdded {} => "cabang baru".to_string(),
        Label::BranchRemoved {} => "cabang dihapus".to_string(),
        Label::ErrorHandlingAdded {} => "penanganan error baru".to_string(),
        Label::ErrorHandlingRemoved {} => "penanganan error dihapus".to_string(),
        Label::LoopAdded {} => "loop baru".to_string(),
        Label::LoopRemoved {} => "loop dihapus".to_string(),
        Label::ReturnChanged {} => "return diubah".to_string(),
        Label::CallAdded { name } => format!("panggil {name}"),
        Label::CallRemoved { name } => format!("berhenti panggil {name}"),
        Label::AwaitChanged { .. } => "await berubah".to_string(),
        Label::BodyChanged {} => "isi diubah".to_string(),
        Label::ValueChanged { .. } => "nilai berubah".to_string(),
        Label::ConfigChanged { .. } => "config berubah".to_string(),
        Label::DepAdded { .. } => "dependensi baru".to_string(),
        Label::DepRemoved { .. } => "dependensi dihapus".to_string(),
        Label::DepVersion { .. } => "versi dependensi".to_string(),
        Label::ImportAdded { .. } => "import baru".to_string(),
        Label::ImportRemoved { .. } => "import dihapus".to_string(),
        Label::TestAdded { .. } => "test baru".to_string(),
        Label::TestRemoved { .. } => "test dihapus".to_string(),
        Label::TestSkipped { .. } => "test di-skip".to_string(),
        Label::TestOnly { .. } => "test .only".to_string(),
        Label::FileNew {} => "file baru".to_string(),
        Label::FileDeleted {} => "file dihapus".to_string(),
        Label::FileRenamed { .. } => "file diganti nama".to_string(),
        Label::FormatOnly {} => "hanya format".to_string(),
        Label::Rewrite { .. } => "ditulis ulang".to_string(),
        Label::LockfileChanged {} => "lockfile berubah".to_string(),
        Label::LinesChanged { .. } => "baris berubah".to_string(),
        Label::TooLarge {} => "terlalu besar".to_string(),
        Label::NotCaptured {} => "tidak terekam".to_string(),
    }
}

fn label_full_en(label: &Label, kind: Option<SymbolKind>) -> String {
    let k = kind_word(UiLang::En, kind);
    match label {
        Label::ParamsChanged {
            added,
            removed,
            changed,
        } => params_full(
            "parameters",
            ["added", "removed", "changed"],
            [*added, *removed, *changed],
            label_chip_en(label, kind),
        ),
        Label::SymbolRenamed { from } => format!("{k} renamed from {from}"),
        Label::AwaitChanged { added, removed } => signed_pair(*added, *removed)
            .map(|p| format!("await {p}"))
            .unwrap_or_else(|| label_chip_en(label, kind)),
        Label::ValueChanged {
            name,
            before,
            after,
        } => arrow_pair(name, Some(before), Some(after)),
        Label::ConfigChanged { key, before, after } => {
            arrow_pair(key, before.as_deref(), after.as_deref())
        }
        Label::DepAdded { name, version } => dep_added_full(name, version),
        Label::DepRemoved { name } => name.clone(),
        Label::DepVersion {
            name,
            before,
            after,
        } => arrow_pair(name, Some(before), Some(after)),
        Label::ImportAdded { module } | Label::ImportRemoved { module } => module.clone(),
        Label::TestAdded { name }
        | Label::TestRemoved { name }
        | Label::TestSkipped { name }
        | Label::TestOnly { name } => name.clone(),
        Label::FileRenamed { from } => format!("from {from}"),
        Label::Rewrite { pct } => format!("{pct}% changed"),
        Label::LinesChanged { added, removed } => {
            signed_pair(*added, *removed).unwrap_or_else(|| label_chip_en(label, kind))
        }
        Label::ReturnTypeChanged {}
        | Label::SymbolRemoved {}
        | Label::SymbolAdded {}
        | Label::GuardAdded {}
        | Label::ConditionChanged {}
        | Label::BranchAdded {}
        | Label::BranchRemoved {}
        | Label::ErrorHandlingAdded {}
        | Label::ErrorHandlingRemoved {}
        | Label::LoopAdded {}
        | Label::LoopRemoved {}
        | Label::ReturnChanged {}
        | Label::CallAdded { .. }
        | Label::CallRemoved { .. }
        | Label::BodyChanged {}
        | Label::FileNew {}
        | Label::FileDeleted {}
        | Label::FormatOnly {}
        | Label::LockfileChanged {}
        | Label::TooLarge {}
        | Label::NotCaptured {} => label_chip_en(label, kind),
    }
}

fn label_full_id(label: &Label, kind: Option<SymbolKind>) -> String {
    let k = kind_word(UiLang::Id, kind);
    match label {
        Label::ParamsChanged {
            added,
            removed,
            changed,
        } => params_full(
            "parameter",
            ["baru", "hilang", "diubah"],
            [*added, *removed, *changed],
            label_chip_id(label, kind),
        ),
        Label::SymbolRenamed { from } => format!("{k} diganti nama dari {from}"),
        Label::AwaitChanged { added, removed } => signed_pair(*added, *removed)
            .map(|p| format!("await {p}"))
            .unwrap_or_else(|| label_chip_id(label, kind)),
        Label::ValueChanged {
            name,
            before,
            after,
        } => arrow_pair(name, Some(before), Some(after)),
        Label::ConfigChanged { key, before, after } => {
            arrow_pair(key, before.as_deref(), after.as_deref())
        }
        Label::DepAdded { name, version } => dep_added_full(name, version),
        Label::DepRemoved { name } => name.clone(),
        Label::DepVersion {
            name,
            before,
            after,
        } => arrow_pair(name, Some(before), Some(after)),
        Label::ImportAdded { module } | Label::ImportRemoved { module } => module.clone(),
        Label::TestAdded { name }
        | Label::TestRemoved { name }
        | Label::TestSkipped { name }
        | Label::TestOnly { name } => name.clone(),
        Label::FileRenamed { from } => format!("dari {from}"),
        Label::Rewrite { pct } => format!("{pct}% berubah"),
        Label::LinesChanged { added, removed } => {
            signed_pair(*added, *removed).unwrap_or_else(|| label_chip_id(label, kind))
        }
        Label::ReturnTypeChanged {}
        | Label::SymbolRemoved {}
        | Label::SymbolAdded {}
        | Label::GuardAdded {}
        | Label::ConditionChanged {}
        | Label::BranchAdded {}
        | Label::BranchRemoved {}
        | Label::ErrorHandlingAdded {}
        | Label::ErrorHandlingRemoved {}
        | Label::LoopAdded {}
        | Label::LoopRemoved {}
        | Label::ReturnChanged {}
        | Label::CallAdded { .. }
        | Label::CallRemoved { .. }
        | Label::BodyChanged {}
        | Label::FileNew {}
        | Label::FileDeleted {}
        | Label::FormatOnly {}
        | Label::LockfileChanged {}
        | Label::TooLarge {}
        | Label::NotCaptured {} => label_chip_id(label, kind),
    }
}

fn params_full(prefix: &str, words: [&str; 3], counts: [u32; 3], fallback: String) -> String {
    let parts: Vec<String> = counts
        .into_iter()
        .zip(words)
        .filter(|(c, _)| *c > 0)
        .map(|(c, w)| format!("{c} {w}"))
        .collect();
    if parts.is_empty() {
        fallback
    } else {
        format!("{prefix}: {}", parts.join(", "))
    }
}

fn signed_pair(added: u32, removed: u32) -> Option<String> {
    match (added, removed) {
        (0, 0) => None,
        (a, 0) => Some(format!("+{a}")),
        (0, r) => Some(format!("\u{2212}{r}")),
        (a, r) => Some(format!("+{a} \u{2212}{r}")),
    }
}

fn arrow_pair(label: &str, before: Option<&str>, after: Option<&str>) -> String {
    format!(
        "{label}: {} \u{2192} {}",
        before.unwrap_or("\u{2014}"),
        after.unwrap_or("\u{2014}"),
    )
}

fn dep_added_full(name: &str, version: &str) -> String {
    if version.is_empty() {
        name.to_string()
    } else {
        format!("{name} {version}")
    }
}
