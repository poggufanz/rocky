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
    }
}
