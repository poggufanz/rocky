//! Typed catalog for the desk's user-visible copy, in English and Indonesian.
//!
//! `en` and `id` match exhaustively, so adding a variant fails the build until
//! both languages carry copy.

use rocky_proto::pipe::{GapReason, Outcome, Status, TimelineKind};
use rocky_proto::settings::Lang;

/// Language the desk renders its own text in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UiLang {
    En,
    Id,
}

/// One user-visible string, rendered through [`en`], [`id`], or [`tr`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Msg {
    Status(Status),
    NoAgents,
    UnknownRepo,
    /// The main agent's row and notice label.
    MainAgent,
    /// A subagent label, which is a system name and never translated.
    AgentName {
        label: String,
    },
    Session {
        short: String,
    },
    Age {
        secs: u64,
    },
    Failures {
        n: u32,
    },
    Tooltip {
        working: u64,
        needs_you: u64,
        failed: u64,
        done: u64,
        idle: u64,
    },
    MenuOpen,
    MenuStop,
    MenuQuit,
    BadFiles {
        n: u64,
    },
    DroppedEvents {
        n: u64,
    },
    SpoolPending {
        n: u64,
    },
    SpoolDropped {
        n: u64,
    },
    LateEvents {
        n: u64,
    },
    HookNewer,
    SettingsUnreadable,
    Gap {
        count: u64,
        from: String,
        to: String,
        reason: GapReason,
    },
    EarlierGaps {
        n: u64,
    },
    SubagentsStillWorking {
        n: u64,
    },
    SubagentsHidden {
        n: u64,
        working: u64,
    },
    TimelineEntry {
        kind: TimelineKind,
        tool: Option<String>,
        text: Option<String>,
    },
    Outcome(Outcome),
    ConnVersionMismatch,
    ConnUnverified,
    ConnDisconnected,
    ConnTiedToJob,
    ConnKeepsCrashing,
    ConnUnresponsive,
    SettingSubagentTree,
    SettingHistory,
    SettingToolText,
    SettingNotifyNeedsYou,
    SettingNotifyFailed,
    SettingNotifyDone,
    LangAuto,
    LangEn,
    LangId,
    Autostart,
    ViewAgents,
    ViewSettings,
    SettingsReadOnly,
    ToolTextHistoryNote,
    SetFailed {
        reason: String,
    },
    AutostartFailed,
    AutostartQuestion,
    Yes,
    No,
    NoticeNeedsYou {
        agent: String,
        summary: Option<String>,
    },
    NoticeFailed {
        agent: String,
    },
    NoticeDone,
}

#[cfg(test)]
fn samples() -> Vec<Msg> {
    vec![
        Msg::Status(Status::Idle),
        Msg::Status(Status::Working),
        Msg::Status(Status::NeedsYou),
        Msg::Status(Status::Done),
        Msg::Status(Status::Failed),
        Msg::Status(Status::Ended),
        Msg::NoAgents,
        Msg::UnknownRepo,
        Msg::MainAgent,
        Msg::AgentName {
            label: "Explore aaaaaaaa".into(),
        },
        Msg::Session {
            short: "abc12345".into(),
        },
        Msg::Age { secs: 130 },
        Msg::Failures { n: 2 },
        Msg::Tooltip {
            working: 2,
            needs_you: 1,
            failed: 1,
            done: 1,
            idle: 1,
        },
        Msg::Tooltip {
            working: 0,
            needs_you: 0,
            failed: 0,
            done: 0,
            idle: 0,
        },
        Msg::MenuOpen,
        Msg::MenuStop,
        Msg::MenuQuit,
        Msg::BadFiles { n: 3 },
        Msg::DroppedEvents { n: 3 },
        Msg::SpoolPending { n: 3 },
        Msg::SpoolDropped { n: 3 },
        Msg::LateEvents { n: 3 },
        Msg::HookNewer,
        Msg::SettingsUnreadable,
        Msg::Gap {
            count: 3,
            from: "14:02".into(),
            to: "14:05".into(),
            reason: GapReason::SpoolFull,
        },
        Msg::Gap {
            count: 1,
            from: "14:02".into(),
            to: "14:02".into(),
            reason: GapReason::BadFile,
        },
        Msg::EarlierGaps { n: 2 },
        Msg::SubagentsStillWorking { n: 2 },
        Msg::SubagentsHidden { n: 3, working: 1 },
        Msg::TimelineEntry {
            kind: TimelineKind::Tool,
            tool: Some("Bash".into()),
            text: Some("npm test".into()),
        },
        Msg::TimelineEntry {
            kind: TimelineKind::SubagentStart,
            tool: None,
            text: Some("Review the diff".into()),
        },
        Msg::TimelineEntry {
            kind: TimelineKind::SessionStart,
            tool: None,
            text: None,
        },
        Msg::Outcome(Outcome::Pending),
        Msg::Outcome(Outcome::Ok),
        Msg::Outcome(Outcome::Failed),
        Msg::ConnVersionMismatch,
        Msg::ConnUnverified,
        Msg::ConnDisconnected,
        Msg::ConnTiedToJob,
        Msg::ConnKeepsCrashing,
        Msg::ConnUnresponsive,
        Msg::SettingSubagentTree,
        Msg::SettingHistory,
        Msg::SettingToolText,
        Msg::SettingNotifyNeedsYou,
        Msg::SettingNotifyFailed,
        Msg::SettingNotifyDone,
        Msg::LangAuto,
        Msg::LangEn,
        Msg::LangId,
        Msg::Autostart,
        Msg::ViewAgents,
        Msg::ViewSettings,
        Msg::SettingsReadOnly,
        Msg::ToolTextHistoryNote,
        Msg::SetFailed {
            reason: "invalid value".into(),
        },
        Msg::AutostartFailed,
        Msg::AutostartQuestion,
        Msg::Yes,
        Msg::No,
        Msg::NoticeNeedsYou {
            agent: "Explore aaaaaaaa".into(),
            summary: Some("Bash".into()),
        },
        Msg::NoticeNeedsYou {
            agent: "main".into(),
            summary: None,
        },
        Msg::NoticeFailed {
            agent: "main".into(),
        },
        Msg::NoticeDone,
    ]
}

/// English copy.
pub fn en(m: &Msg) -> String {
    match m {
        Msg::Status(s) => match s {
            Status::Idle => "idle",
            Status::Working => "working",
            Status::NeedsYou => "needs you",
            Status::Done => "done",
            Status::Failed => "failed",
            Status::Ended => "ended",
        }
        .to_string(),
        Msg::NoAgents => "No agents recorded yet.".to_string(),
        Msg::UnknownRepo => "unknown repo".to_string(),
        Msg::MainAgent => "main".to_string(),
        Msg::AgentName { label } => label.clone(),
        Msg::Session { short } => format!("session {short}"),
        Msg::Age { secs } => age_en(*secs),
        Msg::Failures { n } => format!("{n} failures"),
        Msg::Tooltip {
            working,
            needs_you,
            failed,
            done,
            idle,
        } => tooltip(
            [*working, *needs_you, *failed, *done, *idle],
            ["working", "needs you", "failed", "done", "idle"],
            "idle",
        ),
        Msg::MenuOpen => "Open rocky".to_string(),
        Msg::MenuStop => "Stop recording".to_string(),
        Msg::MenuQuit => "Quit".to_string(),
        Msg::BadFiles { n } => format!("{n} bad spool files."),
        Msg::DroppedEvents { n } => format!("{n} dropped events."),
        Msg::SpoolPending { n } => format!("{n} spool {} pending.", plural(*n, "file", "files")),
        Msg::SpoolDropped { n } => format!("{n} spool files dropped."),
        Msg::LateEvents { n } => format!("{n} late events."),
        Msg::HookNewer => "hook is newer than daemon, needs update.".to_string(),
        Msg::SettingsUnreadable => "settings unreadable, defaults in use".to_string(),
        Msg::Gap {
            count,
            from,
            to,
            reason,
        } => gap_en(*count, from, to, *reason),
        Msg::EarlierGaps { n } => format!("{n} earlier {}", plural(*n, "gap", "gaps")),
        Msg::SubagentsStillWorking { n } => {
            format!("{n} {} still working", plural(*n, "subagent", "subagents"))
        }
        Msg::SubagentsHidden { n, working } => {
            format!("+{n} {} ({working} working)", plural(*n, "subagent", "subagents"))
        }
        Msg::TimelineEntry { kind, tool, text } => {
            timeline_entry_en(*kind, tool.as_deref(), text.as_deref())
        }
        Msg::Outcome(o) => outcome_en(*o).to_string(),
        Msg::ConnVersionMismatch => "daemon version mismatch, needs update.".to_string(),
        Msg::ConnUnverified => "daemon could not be verified.".to_string(),
        Msg::ConnDisconnected => "daemon disconnected.".to_string(),
        Msg::ConnTiedToJob => "daemon tied to launcher job.".to_string(),
        Msg::ConnKeepsCrashing => "daemon keeps crashing.".to_string(),
        Msg::ConnUnresponsive => "rockyd is not responding.".to_string(),
        Msg::SettingSubagentTree => "Show subagent rows".to_string(),
        Msg::SettingHistory => "Keep 24-hour history".to_string(),
        Msg::SettingToolText => "Record tool text".to_string(),
        Msg::SettingNotifyNeedsYou => "Notify when an agent needs you".to_string(),
        Msg::SettingNotifyFailed => "Notify when an agent fails".to_string(),
        Msg::SettingNotifyDone => "Notify when an agent finishes".to_string(),
        Msg::LangAuto => "Auto".to_string(),
        Msg::LangEn => "English".to_string(),
        Msg::LangId => "Indonesia".to_string(),
        Msg::Autostart => "Start rocky when you sign in".to_string(),
        Msg::ViewAgents => "Agents".to_string(),
        Msg::ViewSettings => "Settings".to_string(),
        Msg::SettingsReadOnly => "Settings are read-only while rockyd is not connected.".to_string(),
        Msg::ToolTextHistoryNote => {
            "Old history keeps tool text until it ages out after 24 hours. Turn off history to delete it now."
                .to_string()
        }
        Msg::SetFailed { reason } => format!("Could not save setting: {reason}"),
        Msg::AutostartFailed => "Could not change the sign-in setting.".to_string(),
        Msg::AutostartQuestion => "Start rocky when you sign in?".to_string(),
        Msg::Yes => "Yes".to_string(),
        Msg::No => "No".to_string(),
        Msg::NoticeNeedsYou { agent, summary } => needs_you_en(agent, summary.as_deref()),
        Msg::NoticeFailed { agent } => format!("{agent} failed"),
        Msg::NoticeDone => "Finished".to_string(),
    }
}

fn needs_you_en(agent: &str, summary: Option<&str>) -> String {
    match summary {
        Some(summary) => format!("{agent} needs you: {summary}"),
        None => format!("{agent} needs you"),
    }
}

/// Indonesian copy.
pub fn id(m: &Msg) -> String {
    match m {
        Msg::Status(s) => match s {
            Status::Idle => "tidak aktif",
            Status::Working => "bekerja",
            Status::NeedsYou => "perlu Anda",
            Status::Done => "selesai",
            Status::Failed => "gagal",
            Status::Ended => "berakhir",
        }
        .to_string(),
        Msg::NoAgents => "Belum ada agen yang tercatat.".to_string(),
        Msg::UnknownRepo => "repo tidak dikenal".to_string(),
        Msg::MainAgent => "utama".to_string(),
        Msg::AgentName { label } => label.clone(),
        Msg::Session { short } => format!("sesi {short}"),
        Msg::Age { secs } => age_id(*secs),
        Msg::Failures { n } => format!("{n} kegagalan"),
        Msg::Tooltip {
            working,
            needs_you,
            failed,
            done,
            idle,
        } => tooltip(
            [*working, *needs_you, *failed, *done, *idle],
            ["bekerja", "perlu Anda", "gagal", "selesai", "tidak aktif"],
            "tidak aktif",
        ),
        Msg::MenuOpen => "Buka rocky".to_string(),
        Msg::MenuStop => "Hentikan perekaman".to_string(),
        Msg::MenuQuit => "Keluar".to_string(),
        Msg::BadFiles { n } => format!("{n} berkas spool rusak."),
        Msg::DroppedEvents { n } => format!("{n} peristiwa dibuang."),
        Msg::SpoolPending { n } => format!("{n} berkas spool tertunda."),
        Msg::SpoolDropped { n } => format!("{n} berkas spool dibuang."),
        Msg::LateEvents { n } => format!("{n} peristiwa terlambat."),
        Msg::HookNewer => "hook lebih baru daripada daemon, perlu pembaruan.".to_string(),
        Msg::SettingsUnreadable => "pengaturan tidak terbaca, memakai nilai bawaan".to_string(),
        Msg::Gap {
            count,
            from,
            to,
            reason,
        } => gap_id(*count, from, to, *reason),
        Msg::EarlierGaps { n } => format!("{n} celah sebelumnya"),
        Msg::SubagentsStillWorking { n } => format!("{n} subagen masih bekerja"),
        Msg::SubagentsHidden { n, working } => format!("+{n} subagen ({working} bekerja)"),
        Msg::TimelineEntry { kind, tool, text } => {
            timeline_entry_id(*kind, tool.as_deref(), text.as_deref())
        }
        Msg::Outcome(o) => outcome_id(*o).to_string(),
        Msg::ConnVersionMismatch => "versi daemon tidak cocok, perlu pembaruan.".to_string(),
        Msg::ConnUnverified => "daemon tidak dapat diverifikasi.".to_string(),
        Msg::ConnDisconnected => "daemon terputus.".to_string(),
        Msg::ConnTiedToJob => "daemon terikat ke proses peluncur.".to_string(),
        Msg::ConnKeepsCrashing => "daemon terus crash.".to_string(),
        Msg::ConnUnresponsive => "rockyd tidak merespons.".to_string(),
        Msg::SettingSubagentTree => "Tampilkan baris subagen".to_string(),
        Msg::SettingHistory => "Simpan riwayat 24 jam".to_string(),
        Msg::SettingToolText => "Catat teks tool".to_string(),
        Msg::SettingNotifyNeedsYou => "Beri tahu saat agen perlu Anda".to_string(),
        Msg::SettingNotifyFailed => "Beri tahu saat agen gagal".to_string(),
        Msg::SettingNotifyDone => "Beri tahu saat agen selesai".to_string(),
        Msg::LangAuto => "Otomatis".to_string(),
        Msg::LangEn => "English".to_string(),
        Msg::LangId => "Indonesia".to_string(),
        Msg::Autostart => "Jalankan rocky saat Anda masuk".to_string(),
        Msg::ViewAgents => "Agen".to_string(),
        Msg::ViewSettings => "Pengaturan".to_string(),
        Msg::SettingsReadOnly => {
            "Pengaturan hanya-baca selama rockyd tidak terhubung.".to_string()
        }
        Msg::ToolTextHistoryNote => {
            "Riwayat lama tetap menyimpan teks tool sampai hilang setelah 24 jam. Matikan riwayat untuk menghapusnya sekarang."
                .to_string()
        }
        Msg::SetFailed { reason } => format!("Tidak dapat menyimpan pengaturan: {reason}"),
        Msg::AutostartFailed => "Tidak dapat mengubah pengaturan masuk otomatis.".to_string(),
        Msg::AutostartQuestion => "Jalankan rocky saat Anda masuk?".to_string(),
        Msg::Yes => "Ya".to_string(),
        Msg::No => "Tidak".to_string(),
        Msg::NoticeNeedsYou { agent, summary } => needs_you_id(agent, summary.as_deref()),
        Msg::NoticeFailed { agent } => format!("{agent} gagal"),
        Msg::NoticeDone => "Selesai".to_string(),
    }
}

fn needs_you_id(agent: &str, summary: Option<&str>) -> String {
    match summary {
        Some(summary) => format!("{agent} perlu Anda: {summary}"),
        None => format!("{agent} perlu Anda"),
    }
}

/// Render `m` in the requested UI language.
pub fn tr(lang: UiLang, m: &Msg) -> String {
    match lang {
        UiLang::En => en(m),
        UiLang::Id => id(m),
    }
}

/// Pick the language the desk should render: an explicit setting wins,
/// `Auto` follows detection.
pub fn resolve_lang(setting: Lang, detected: UiLang) -> UiLang {
    match setting {
        Lang::En => UiLang::En,
        Lang::Id => UiLang::Id,
        Lang::Auto => detected,
    }
}

/// True when the Windows LANGID's primary language is Indonesian (0x21).
pub fn primary_is_indonesian(langid: u16) -> bool {
    langid & 0x3ff == 0x21
}

/// Resolve a language from POSIX locale variables, first non-empty wins.
pub fn lang_from_env(
    lc_all: Option<&str>,
    lc_messages: Option<&str>,
    lang: Option<&str>,
) -> UiLang {
    let first = [lc_all, lc_messages, lang]
        .into_iter()
        .flatten()
        .find(|v| !v.is_empty());
    match first {
        Some(v)
            if v.as_bytes()
                .get(..2)
                .is_some_and(|p| p.eq_ignore_ascii_case(b"id")) =>
        {
            UiLang::Id
        }
        _ => UiLang::En,
    }
}

/// Detect the language of the current user interface.
pub fn detect_ui_lang() -> UiLang {
    #[cfg(windows)]
    {
        // SAFETY: no preconditions; returns the current user's UI LANGID.
        let langid = unsafe { windows_sys::Win32::Globalization::GetUserDefaultUILanguage() };
        if primary_is_indonesian(langid) {
            UiLang::Id
        } else {
            UiLang::En
        }
    }
    #[cfg(not(windows))]
    {
        lang_from_env(
            std::env::var("LC_ALL").ok().as_deref(),
            std::env::var("LC_MESSAGES").ok().as_deref(),
            std::env::var("LANG").ok().as_deref(),
        )
    }
}

/// Age text in English: `now`, `30s`, `2m`, `3h`, `4d`.
fn age_en(secs: u64) -> String {
    if secs < 10 {
        "now".to_string()
    } else if secs < 60 {
        format!("{secs}s")
    } else if secs < 3600 {
        format!("{}m", secs / 60)
    } else if secs < 86400 {
        format!("{}h", secs / 3600)
    } else {
        format!("{}d", secs / 86400)
    }
}

/// Age text in Indonesian: `baru saja`, `30 dtk`, `2 mnt`, `3 j`, `4 hr`.
fn age_id(secs: u64) -> String {
    if secs < 10 {
        "baru saja".to_string()
    } else if secs < 60 {
        format!("{secs} dtk")
    } else if secs < 3600 {
        format!("{} mnt", secs / 60)
    } else if secs < 86400 {
        format!("{} j", secs / 3600)
    } else {
        format!("{} hr", secs / 86400)
    }
}

/// Tooltip text: non-zero counts joined with commas, `empty` when all are zero.
fn tooltip(counts: [u64; 5], names: [&str; 5], empty: &str) -> String {
    let segs: Vec<String> = counts
        .into_iter()
        .zip(names)
        .filter(|(c, _)| *c > 0)
        .map(|(c, name)| format!("{c} {name}"))
        .collect();
    if segs.is_empty() {
        format!("rocky: {empty}")
    } else {
        format!("rocky: {}", segs.join(", "))
    }
}

/// Timeline line: a tool entry composes from the tool name and its text;
/// other kinds read as a sentence with any recorded detail appended.
fn timeline_entry_en(kind: TimelineKind, tool: Option<&str>, text: Option<&str>) -> String {
    match kind_en(kind) {
        Some(base) => append_detail(base, text.or(tool)),
        None => tool_line(tool, text, "tool use"),
    }
}

/// Indonesian mirror of [`timeline_entry_en`].
fn timeline_entry_id(kind: TimelineKind, tool: Option<&str>, text: Option<&str>) -> String {
    match kind_id(kind) {
        Some(base) => append_detail(base, text.or(tool)),
        None => tool_line(tool, text, "pemakaian tool"),
    }
}

fn kind_en(kind: TimelineKind) -> Option<&'static str> {
    Some(match kind {
        TimelineKind::SessionStart => "session started",
        TimelineKind::TurnStart => "turn started",
        TimelineKind::NeedsYou => "needs you",
        TimelineKind::SubagentStart => "subagent started",
        TimelineKind::SubagentStop => "subagent stopped",
        TimelineKind::TurnDone => "turn done",
        TimelineKind::TurnFailed => "turn failed",
        TimelineKind::SessionEnd => "session ended",
        TimelineKind::Gap => "events missed",
        TimelineKind::Tool => return None,
    })
}

fn kind_id(kind: TimelineKind) -> Option<&'static str> {
    Some(match kind {
        TimelineKind::SessionStart => "sesi dimulai",
        TimelineKind::TurnStart => "giliran dimulai",
        TimelineKind::NeedsYou => "perlu Anda",
        TimelineKind::SubagentStart => "subagen dimulai",
        TimelineKind::SubagentStop => "subagen berhenti",
        TimelineKind::TurnDone => "giliran selesai",
        TimelineKind::TurnFailed => "giliran gagal",
        TimelineKind::SessionEnd => "sesi berakhir",
        TimelineKind::Gap => "peristiwa terlewat",
        TimelineKind::Tool => return None,
    })
}

fn tool_line(tool: Option<&str>, text: Option<&str>, bare: &str) -> String {
    match (tool, text) {
        (Some(tool), Some(text)) => format!("{tool} {text}"),
        (Some(tool), None) => tool.to_string(),
        (None, Some(text)) => text.to_string(),
        (None, None) => bare.to_string(),
    }
}

fn append_detail(base: &str, detail: Option<&str>) -> String {
    match detail {
        Some(detail) => format!("{base}: {detail}"),
        None => base.to_string(),
    }
}

fn outcome_en(o: Outcome) -> &'static str {
    match o {
        Outcome::Pending => "pending",
        Outcome::Ok => "ok",
        Outcome::Failed => "failed",
    }
}

fn outcome_id(o: Outcome) -> &'static str {
    match o {
        Outcome::Pending => "tertunda",
        Outcome::Ok => "ok",
        Outcome::Failed => "gagal",
    }
}

/// English noun for a count: singular for exactly one. Indonesian nouns do not
/// change with the count, so only the English catalog uses this.
fn plural<'a>(n: u64, one: &'a str, many: &'a str) -> &'a str {
    if n == 1 { one } else { many }
}

/// Missed-events line for a gap: one event is singular, and an empty range
/// reads "at" instead of "between".
fn gap_en(count: u64, from: &str, to: &str, reason: GapReason) -> String {
    let events = if count == 1 { "event" } else { "events" };
    let reason = match reason {
        GapReason::SpoolFull => "spool full",
        GapReason::HistoryFull => "history full",
        GapReason::HookDropped => "hook dropped",
        GapReason::BadFile => "bad file",
    };
    if from == to {
        format!("Missed {count} {events} at {from} ({reason})")
    } else {
        format!("Missed {count} {events} between {from} and {to} ({reason})")
    }
}

/// Indonesian mirror of [`gap_en`].
fn gap_id(count: u64, from: &str, to: &str, reason: GapReason) -> String {
    let reason = match reason {
        GapReason::SpoolFull => "spool penuh",
        GapReason::HistoryFull => "riwayat penuh",
        GapReason::HookDropped => "hook terlewat",
        GapReason::BadFile => "berkas rusak",
    };
    if from == to {
        format!("Kehilangan {count} peristiwa di {from} ({reason})")
    } else {
        format!("Kehilangan {count} peristiwa antara {from} dan {to} ({reason})")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_variant_renders_in_both_languages() {
        for m in samples() {
            assert!(!en(&m).trim().is_empty(), "{m:?}");
            assert!(!id(&m).trim().is_empty(), "{m:?}");
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
}
