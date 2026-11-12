//! Copy for the setup guard and capture health lines, in English and Indonesian.
//!
//! `setup_en` and `setup_id` match exhaustively, so adding a variant fails the
//! build until both languages carry copy.

use super::{error_suffix, plural};

/// One setup or capture message, rendered through [`setup_en`] or [`setup_id`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SetupMsg {
    /// A newer Rocky was installed; the running command line must run once.
    NewVersion,
    /// The command line is gone (`Some` names the path) or was never learned.
    CliMissing {
        path: Option<String>,
    },
    Repairing {
        path: String,
    },
    /// `error` is data from the daemon or Node and is shown as received. It may be empty.
    RepairFailed {
        path: String,
        error: String,
    },
    Changed {
        path: String,
    },
    Foreign {
        harness: String,
        path: String,
    },
    /// `error` is data from the daemon or Node and is shown as received. It may be empty.
    Refused {
        path: String,
        error: String,
    },
    Fighting {
        path: String,
        n: u32,
    },
    /// Target lines cut from the strip.
    More {
        n: u64,
    },
    /// `error` is data from the daemon and is shown as received. It may be empty.
    Failed {
        root: String,
        error: String,
    },
    /// File watching failed, so the daemon checks the repo on a timer instead.
    Polling {
        root: String,
    },
    /// Repo lines cut from the strip.
    CaptureMore {
        n: usize,
    },
    /// A repo is waiting for the owner's capture decision.
    RepoConsent {
        name: String,
    },
    /// Rocky was installed into a harness after the first approval.
    HarnessInstalled {
        harness: String,
    },
    ConsentHeading,
    ConsentJsonNote,
    ConsentBackupNote,
    /// A plan row Rocky already wrote.
    ConsentInstalled,
    ConsentAutostart,
    ConsentAgree,
    ConsentLater,
    ConsentDone,
    ConsentLoading,
    ConsentApplying,
    /// Setup did not finish. `error` is data from the daemon or Node and may be empty.
    ConsentFailed {
        error: String,
    },
    /// The daemon never answered a setup request.
    RequestTimedOut,
    /// The desk has no connection to the daemon, so no plan can be read.
    ConsentNotConnected,
    /// Settings row that opens the consent screen.
    ConsentInstall,
    /// A Settings request could not be sent because the daemon is unreachable.
    NotConnected,
    SettingsAgentTools,
    HarnessOk,
    /// `time` is a local `HH:MM`.
    HarnessRestored {
        time: String,
    },
    HarnessForeign,
    /// `error` is data from the daemon or Node and may be empty.
    HarnessFailed {
        error: String,
    },
    HarnessOff,
    HarnessNotInstalled,
    /// A switch or button waits for the daemon's answer.
    SwitchWorking,
    SettingsShell,
    ReinstallAll,
    SettingsRepos,
    RepoAllowed,
    RepoDeclined,
    RepoNotAsked,
    RepoAllow,
    RepoRevoke,
    /// Banner question for a repo waiting for an answer; `name` is never translated.
    RepoBannerAsk {
        name: String,
    },
    /// Banner button that keeps the repo unrecorded.
    RepoBannerNo,
    CaptureOk,
    CaptureStarting,
    CapturePartial,
    CaptureElsewhere,
    DeleteHistory,
    /// `name` is a repo name and never translated.
    DeleteHistoryAsk {
        name: String,
    },
    DeleteConfirm,
    DeleteCancel,
    WorktreeMissing,
    RemoveRocky,
    RemoveAsk,
    RemoveConfirm,
    RemoveCancel,
    RemoveRetry,
    RemoveWorking,
    /// `error` is data from the daemon or Node and may be empty.
    RemoveFailed {
        error: String,
    },
    RemovedHeading,
    /// `path` is the Rocky home folder and never translated.
    RemovedKeptData {
        path: String,
    },
    RemovedUninstall,
    RemovedClose,
}

#[cfg(test)]
pub(super) fn setup_samples() -> Vec<SetupMsg> {
    vec![
        SetupMsg::NewVersion,
        SetupMsg::CliMissing {
            path: Some("C:/rocky/dist/index.js".into()),
        },
        SetupMsg::CliMissing { path: None },
        SetupMsg::Repairing {
            path: "C:/Users/me/.claude/settings.json".into(),
        },
        SetupMsg::RepairFailed {
            path: "C:/Users/me/.claude/settings.json".into(),
            error: "still missing after setup ran".into(),
        },
        SetupMsg::RepairFailed {
            path: "C:/Users/me/.claude/settings.json".into(),
            error: String::new(),
        },
        SetupMsg::Changed {
            path: "C:/Users/me/.claude/settings.json".into(),
        },
        SetupMsg::Foreign {
            harness: "gemini-cli".into(),
            path: "C:/Users/me/.gemini/settings.json".into(),
        },
        SetupMsg::Refused {
            path: "C:/Users/me/.claude/settings.json".into(),
            error: "path is outside the home folder".into(),
        },
        SetupMsg::Refused {
            path: "C:/Users/me/.claude/settings.json".into(),
            error: String::new(),
        },
        SetupMsg::Fighting {
            path: "C:/Users/me/.claude/settings.json".into(),
            n: 6,
        },
        SetupMsg::More { n: 3 },
        SetupMsg::More { n: 1 },
        SetupMsg::Failed {
            root: "C:/work/app".into(),
            error: "Node could not start.".into(),
        },
        SetupMsg::Failed {
            root: "C:/work/app".into(),
            error: String::new(),
        },
        SetupMsg::Polling {
            root: "C:/work/app".into(),
        },
        SetupMsg::CaptureMore { n: 2 },
        SetupMsg::CaptureMore { n: 1 },
        SetupMsg::RepoConsent { name: "app".into() },
        SetupMsg::HarnessInstalled {
            harness: "claude-code".into(),
        },
        SetupMsg::ConsentHeading,
        SetupMsg::ConsentJsonNote,
        SetupMsg::ConsentBackupNote,
        SetupMsg::ConsentInstalled,
        SetupMsg::ConsentAutostart,
        SetupMsg::ConsentAgree,
        SetupMsg::ConsentLater,
        SetupMsg::ConsentDone,
        SetupMsg::ConsentLoading,
        SetupMsg::ConsentApplying,
        SetupMsg::ConsentFailed {
            error: "Node could not start.".into(),
        },
        SetupMsg::ConsentFailed {
            error: String::new(),
        },
        SetupMsg::RequestTimedOut,
        SetupMsg::ConsentNotConnected,
        SetupMsg::ConsentInstall,
        SetupMsg::NotConnected,
        SetupMsg::SettingsAgentTools,
        SetupMsg::HarnessOk,
        SetupMsg::HarnessRestored {
            time: "09:41".into(),
        },
        SetupMsg::HarnessForeign,
        SetupMsg::HarnessFailed {
            error: "path is outside the home folder".into(),
        },
        SetupMsg::HarnessFailed {
            error: String::new(),
        },
        SetupMsg::HarnessOff,
        SetupMsg::HarnessNotInstalled,
        SetupMsg::SwitchWorking,
        SetupMsg::SettingsShell,
        SetupMsg::ReinstallAll,
        SetupMsg::SettingsRepos,
        SetupMsg::RepoAllowed,
        SetupMsg::RepoDeclined,
        SetupMsg::RepoNotAsked,
        SetupMsg::RepoAllow,
        SetupMsg::RepoRevoke,
        SetupMsg::RepoBannerAsk {
            name: "demo".to_string(),
        },
        SetupMsg::RepoBannerNo,
        SetupMsg::CaptureOk,
        SetupMsg::CaptureStarting,
        SetupMsg::CapturePartial,
        SetupMsg::CaptureElsewhere,
        SetupMsg::DeleteHistory,
        SetupMsg::DeleteHistoryAsk { name: "app".into() },
        SetupMsg::DeleteConfirm,
        SetupMsg::DeleteCancel,
        SetupMsg::WorktreeMissing,
        SetupMsg::RemoveRocky,
        SetupMsg::RemoveAsk,
        SetupMsg::RemoveConfirm,
        SetupMsg::RemoveCancel,
        SetupMsg::RemoveRetry,
        SetupMsg::RemoveWorking,
        SetupMsg::RemoveFailed {
            error: "Node could not start.".into(),
        },
        SetupMsg::RemoveFailed {
            error: String::new(),
        },
        SetupMsg::RemovedHeading,
        SetupMsg::RemovedKeptData {
            path: "C:/Users/me/.rocky".into(),
        },
        SetupMsg::RemovedUninstall,
        SetupMsg::RemovedClose,
    ]
}

/// English copy.
pub fn setup_en(m: &SetupMsg) -> String {
    match m {
        SetupMsg::NewVersion => "New version installed. Run rocky once to use it.".to_string(),
        SetupMsg::CliMissing { path: Some(path) } => {
            format!("{path} is gone. Run rocky once so Rocky can repair its entries.")
        }
        SetupMsg::CliMissing { path: None } => {
            "Rocky does not know where its command line is. Run rocky once.".to_string()
        }
        SetupMsg::Repairing { path } => format!("Restoring Rocky entries in {path}."),
        SetupMsg::RepairFailed { path, error } => {
            format!(
                "Cannot restore Rocky entries in {path}{}.",
                error_suffix(error)
            )
        }
        SetupMsg::Changed { path } => {
            format!("{path} changed while Rocky was writing it. Trying again.")
        }
        SetupMsg::Foreign { harness, path } => format!(
            "{path} has a rocky server Rocky did not write, so Rocky leaves {harness} alone."
        ),
        SetupMsg::Refused { path, error } => {
            format!("Rocky will not write {path}{}.", error_suffix(error))
        }
        SetupMsg::Fighting { path, n } => {
            format!("{path} keeps losing Rocky entries ({n} times in 10 minutes).")
        }
        SetupMsg::More { n } => format!("{n} more setup {}.", plural(*n, "problem", "problems")),
        SetupMsg::Failed { root, error } => {
            format!("Capture for {root} failed{}.", error_suffix(error))
        }
        SetupMsg::Polling { root } => {
            format!("Capture for {root} checks every 60 seconds; watching files failed.")
        }
        SetupMsg::CaptureMore { n } => {
            format!("And {n} more {}.", plural(*n as u64, "repo", "repos"))
        }
        SetupMsg::RepoConsent { name } => {
            format!("Rocky can record file history for {name}. Open Rocky to answer.")
        }
        SetupMsg::HarnessInstalled { harness } => format!("Rocky is installed in {harness}."),
        SetupMsg::ConsentHeading => "Rocky wants to set up these agent tools.".to_string(),
        SetupMsg::ConsentJsonNote => {
            "JSON files are saved again with 2-space indentation.".to_string()
        }
        SetupMsg::ConsentBackupNote => {
            "One copy of the previous version is kept beside each file for recovery.".to_string()
        }
        SetupMsg::ConsentInstalled => "already installed".to_string(),
        SetupMsg::ConsentAutostart => "Start Rocky at sign-in".to_string(),
        SetupMsg::ConsentAgree => "Agree".to_string(),
        SetupMsg::ConsentLater => "Later".to_string(),
        SetupMsg::ConsentDone => "Done".to_string(),
        SetupMsg::ConsentLoading => "Reading the setup plan.".to_string(),
        SetupMsg::ConsentApplying => "Setting up.".to_string(),
        SetupMsg::ConsentFailed { error } => {
            format!("Setup did not finish{}. Try again.", error_suffix(error))
        }
        SetupMsg::RequestTimedOut => "Rocky did not answer in time.".to_string(),
        SetupMsg::ConsentNotConnected => {
            "Rocky is not connected yet. The plan loads when it is.".to_string()
        }
        SetupMsg::ConsentInstall => "Install".to_string(),
        SetupMsg::NotConnected => "Rocky is not connected yet.".to_string(),
        SetupMsg::SettingsAgentTools => "Agent tools".to_string(),
        SetupMsg::HarnessOk => "ok".to_string(),
        SetupMsg::HarnessRestored { time } => format!("restored at {time}"),
        SetupMsg::HarnessForeign => "foreign".to_string(),
        SetupMsg::HarnessFailed { error } => format!("failed{}", error_suffix(error)),
        SetupMsg::HarnessOff => "off".to_string(),
        SetupMsg::HarnessNotInstalled => "not installed".to_string(),
        SetupMsg::SwitchWorking => "working".to_string(),
        SetupMsg::SettingsShell => "Shell hook (Bash and PowerShell)".to_string(),
        SetupMsg::ReinstallAll => "Reinstall all".to_string(),
        SetupMsg::SettingsRepos => "Repos".to_string(),
        SetupMsg::RepoAllowed => "recording allowed".to_string(),
        SetupMsg::RepoDeclined => "not recorded".to_string(),
        SetupMsg::RepoNotAsked => "not asked yet".to_string(),
        SetupMsg::RepoAllow => "Allow".to_string(),
        SetupMsg::RepoRevoke => "Revoke".to_string(),
        SetupMsg::RepoBannerAsk { name } => {
            format!("Allow Rocky to record file history for {name}?")
        }
        SetupMsg::RepoBannerNo => "No".to_string(),
        SetupMsg::CaptureOk => "capturing".to_string(),
        SetupMsg::CaptureStarting => "capture starting".to_string(),
        SetupMsg::CapturePartial => "capture is partial".to_string(),
        SetupMsg::CaptureElsewhere => "another process captures this repo".to_string(),
        SetupMsg::DeleteHistory => "Delete history".to_string(),
        SetupMsg::DeleteHistoryAsk { name } => {
            format!("Delete the recorded history for {name}? This cannot be undone.")
        }
        SetupMsg::DeleteConfirm => "Delete".to_string(),
        SetupMsg::DeleteCancel => "Cancel".to_string(),
        SetupMsg::WorktreeMissing => "folder is gone".to_string(),
        SetupMsg::RemoveRocky => "Remove Rocky".to_string(),
        SetupMsg::RemoveAsk => {
            "Remove Rocky from your agent tools and shell, and stop it? Your memory, journal and file history stay on disk."
                .to_string()
        }
        SetupMsg::RemoveConfirm => "Remove".to_string(),
        SetupMsg::RemoveCancel => "Cancel".to_string(),
        SetupMsg::RemoveRetry => "Retry".to_string(),
        SetupMsg::RemoveWorking => "Removing Rocky.".to_string(),
        SetupMsg::RemoveFailed { error } => {
            format!("Rocky was not removed{}. Try again.", error_suffix(error))
        }
        SetupMsg::RemovedHeading => "Rocky is removed from your tools.".to_string(),
        SetupMsg::RemovedKeptData { path } => format!("Your data stays in {path}."),
        SetupMsg::RemovedUninstall => "To remove the command line, run:".to_string(),
        SetupMsg::RemovedClose => "Close".to_string(),
    }
}

/// Indonesian copy.
pub fn setup_id(m: &SetupMsg) -> String {
    match m {
        SetupMsg::NewVersion => {
            "Versi baru terpasang. Jalankan rocky sekali untuk memakainya.".to_string()
        }
        SetupMsg::CliMissing { path: Some(path) } => {
            format!(
                "{path} sudah tidak ada. Jalankan rocky sekali supaya Rocky bisa memperbaiki entrinya."
            )
        }
        SetupMsg::CliMissing { path: None } => {
            "Rocky tidak tahu letak command line-nya. Jalankan rocky sekali.".to_string()
        }
        SetupMsg::Repairing { path } => format!("Memasang ulang entri Rocky di {path}."),
        SetupMsg::RepairFailed { path, error } => {
            format!(
                "Tidak bisa memasang ulang entri Rocky di {path}{}.",
                error_suffix(error)
            )
        }
        SetupMsg::Changed { path } => {
            format!("{path} berubah saat Rocky menulisnya. Mencoba lagi.")
        }
        SetupMsg::Foreign { harness, path } => format!(
            "{path} punya server rocky yang bukan tulisan Rocky, jadi Rocky tidak menyentuh {harness}."
        ),
        SetupMsg::Refused { path, error } => {
            format!("Rocky tidak mau menulis {path}{}.", error_suffix(error))
        }
        SetupMsg::Fighting { path, n } => {
            format!("{path} terus kehilangan entri Rocky ({n} kali dalam 10 menit).")
        }
        SetupMsg::More { n } => format!("{n} masalah setup lain."),
        SetupMsg::Failed { root, error } => {
            format!("Capture untuk {root} gagal{}.", error_suffix(error))
        }
        SetupMsg::Polling { root } => {
            format!("Capture untuk {root} dicek setiap 60 detik; pemantauan file gagal.")
        }
        SetupMsg::CaptureMore { n } => format!("Dan {n} repo lagi."),
        SetupMsg::RepoConsent { name } => {
            format!("Rocky bisa merekam riwayat file {name}. Buka Rocky untuk menjawab.")
        }
        SetupMsg::HarnessInstalled { harness } => format!("Rocky sudah terpasang di {harness}."),
        SetupMsg::ConsentHeading => "Rocky ingin memasang alat agen berikut.".to_string(),
        SetupMsg::ConsentJsonNote => {
            "File JSON disimpan ulang dengan indentasi 2 spasi.".to_string()
        }
        SetupMsg::ConsentBackupNote => {
            "Satu salinan versi sebelumnya disimpan di samping setiap file untuk pemulihan."
                .to_string()
        }
        SetupMsg::ConsentInstalled => "sudah terpasang".to_string(),
        SetupMsg::ConsentAutostart => "Jalankan Rocky saat masuk".to_string(),
        SetupMsg::ConsentAgree => "Setuju".to_string(),
        SetupMsg::ConsentLater => "Nanti".to_string(),
        SetupMsg::ConsentDone => "Selesai".to_string(),
        SetupMsg::ConsentLoading => "Membaca rencana setup.".to_string(),
        SetupMsg::ConsentApplying => "Sedang memasang.".to_string(),
        SetupMsg::ConsentFailed { error } => {
            format!("Setup belum selesai{}. Coba lagi.", error_suffix(error))
        }
        SetupMsg::RequestTimedOut => "Rocky tidak menjawab tepat waktu.".to_string(),
        SetupMsg::ConsentNotConnected => {
            "Rocky belum terhubung. Rencana dimuat setelah terhubung.".to_string()
        }
        SetupMsg::ConsentInstall => "Pasang".to_string(),
        SetupMsg::NotConnected => "Rocky belum terhubung.".to_string(),
        SetupMsg::SettingsAgentTools => "Alat agen".to_string(),
        SetupMsg::HarnessOk => "baik".to_string(),
        SetupMsg::HarnessRestored { time } => format!("dipulihkan pukul {time}"),
        SetupMsg::HarnessForeign => "asing".to_string(),
        SetupMsg::HarnessFailed { error } => format!("gagal{}", error_suffix(error)),
        SetupMsg::HarnessOff => "mati".to_string(),
        SetupMsg::HarnessNotInstalled => "belum terpasang".to_string(),
        SetupMsg::SwitchWorking => "memproses".to_string(),
        SetupMsg::SettingsShell => "Shell hook (Bash dan PowerShell)".to_string(),
        SetupMsg::ReinstallAll => "Pasang ulang semua".to_string(),
        SetupMsg::SettingsRepos => "Repo".to_string(),
        SetupMsg::RepoAllowed => "perekaman diizinkan".to_string(),
        SetupMsg::RepoDeclined => "tidak direkam".to_string(),
        SetupMsg::RepoNotAsked => "belum ditanya".to_string(),
        SetupMsg::RepoAllow => "Izinkan".to_string(),
        SetupMsg::RepoRevoke => "Cabut".to_string(),
        SetupMsg::RepoBannerAsk { name } => {
            format!("Izinkan Rocky merekam riwayat file {name}?")
        }
        SetupMsg::RepoBannerNo => "Tidak".to_string(),
        SetupMsg::CaptureOk => "merekam".to_string(),
        SetupMsg::CaptureStarting => "capture sedang mulai".to_string(),
        SetupMsg::CapturePartial => "capture sebagian".to_string(),
        SetupMsg::CaptureElsewhere => "proses lain merekam repo ini".to_string(),
        SetupMsg::DeleteHistory => "Hapus riwayat".to_string(),
        SetupMsg::DeleteHistoryAsk { name } => {
            format!("Hapus riwayat yang terekam untuk {name}? Ini tidak bisa dibatalkan.")
        }
        SetupMsg::DeleteConfirm => "Hapus".to_string(),
        SetupMsg::DeleteCancel => "Batal".to_string(),
        SetupMsg::WorktreeMissing => "foldernya sudah hilang".to_string(),
        SetupMsg::RemoveRocky => "Hapus Rocky".to_string(),
        SetupMsg::RemoveAsk => {
            "Hapus Rocky dari alat agen dan shell, lalu hentikan? Memory, journal, dan riwayat file tetap ada di disk."
                .to_string()
        }
        SetupMsg::RemoveConfirm => "Hapus".to_string(),
        SetupMsg::RemoveCancel => "Batal".to_string(),
        SetupMsg::RemoveRetry => "Coba lagi".to_string(),
        SetupMsg::RemoveWorking => "Menghapus Rocky.".to_string(),
        SetupMsg::RemoveFailed { error } => {
            format!("Rocky belum terhapus{}. Coba lagi.", error_suffix(error))
        }
        SetupMsg::RemovedHeading => "Rocky sudah dihapus dari alat Anda.".to_string(),
        SetupMsg::RemovedKeptData { path } => format!("Data Anda tetap ada di {path}."),
        SetupMsg::RemovedUninstall => "Untuk menghapus command line, jalankan:".to_string(),
        SetupMsg::RemovedClose => "Tutup".to_string(),
    }
}
