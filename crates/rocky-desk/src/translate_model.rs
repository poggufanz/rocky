//! Pure view-model for quote translation settings, status line, and install flow.

use rocky_proto::settings::Settings;
use rocky_proto::translate::{QuoteLang, TranslateFailure, TranslatePair, TranslateStatus};

use crate::i18n::UiLang;
use crate::requests::Outcome;

/// Maps the desk UI language to the quote translation target language.
pub fn quote_lang(lang: UiLang) -> QuoteLang {
    match lang {
        UiLang::En => QuoteLang::En,
        UiLang::Id => QuoteLang::Id,
    }
}

/// Returns the active quote translation target when enabled, installed, and healthy.
pub fn translate_target(
    settings: Option<&Settings>,
    status: &TranslateStatus,
    lang: UiLang,
) -> Option<QuoteLang> {
    let target = quote_lang(lang);
    let enabled = settings.is_some_and(|s| s.translate_quotes);
    if enabled
        && status.ready.contains(&TranslatePair::to(target))
        && status.failed != Some(TranslateFailure::Engine)
    {
        Some(target)
    } else {
        None
    }
}

/// Display state for the quote translation settings row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatusLine {
    Off,
    NeedsDownload,
    Downloading(Option<u8>),
    Ready,
    Failed(TranslateFailure),
}

/// Computes the status line for `lang` according to precedence rules.
pub fn status_line(enabled: bool, status: &TranslateStatus, lang: UiLang) -> StatusLine {
    if !enabled {
        return StatusLine::Off;
    }
    if let Some(progress) = status.installing {
        let percent = if progress.total_bytes == 0 {
            None
        } else {
            let pct = (u128::from(progress.done_bytes) * 100) / u128::from(progress.total_bytes);
            Some(pct.min(100) as u8)
        };
        return StatusLine::Downloading(percent);
    }
    if status.failed == Some(TranslateFailure::Engine) {
        return StatusLine::Failed(TranslateFailure::Engine);
    }
    let pair = TranslatePair::to(quote_lang(lang));
    if status.ready.contains(&pair) {
        return StatusLine::Ready;
    }
    if let Some(failure) = status.failed {
        return StatusLine::Failed(failure);
    }
    StatusLine::NeedsDownload
}

/// User actions for the quote translation settings control.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TranslateAction {
    Toggle,
    Download,
    Retry,
    Confirm,
    Cancel,
    Remove,
}

/// Commands emitted by [`TranslateFlow`] for the caller to send over the pipe.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outgoing {
    SetEnabled(bool),
    Install(TranslatePair),
    Remove,
}

/// Error surfaced from the most recent translation action request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TranslateError {
    Busy,
    Other(String),
}

/// State machine for quote translation enablement, download confirmation, and request errors.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct TranslateFlow {
    asking: Option<(TranslatePair, bool /* turn_on */)>,
    error: Option<TranslateError>,
}

impl TranslateFlow {
    /// Applies a user action and returns the outgoing pipe commands to emit.
    pub fn act(
        &mut self,
        action: TranslateAction,
        enabled: bool,
        status: &TranslateStatus,
        lang: UiLang,
    ) -> Vec<Outgoing> {
        self.error = None;
        let pair = TranslatePair::to(quote_lang(lang));
        match action {
            TranslateAction::Toggle if enabled => {
                self.asking = None;
                vec![Outgoing::SetEnabled(false)]
            }
            TranslateAction::Toggle => {
                if status.ready.contains(&pair) {
                    self.asking = None;
                    vec![Outgoing::SetEnabled(true)]
                } else {
                    self.asking = Some((pair, true));
                    Vec::new()
                }
            }
            TranslateAction::Download | TranslateAction::Retry => {
                self.asking = Some((pair, !enabled));
                Vec::new()
            }
            TranslateAction::Confirm => match self.asking.take() {
                Some((asking_pair, true)) => {
                    vec![Outgoing::SetEnabled(true), Outgoing::Install(asking_pair)]
                }
                Some((asking_pair, false)) => vec![Outgoing::Install(asking_pair)],
                None => Vec::new(),
            },
            TranslateAction::Cancel => {
                self.asking = None;
                Vec::new()
            }
            TranslateAction::Remove => vec![Outgoing::Remove],
        }
    }

    /// Returns the pair awaiting user confirmation to download, if any.
    pub fn asking(&self) -> Option<TranslatePair> {
        self.asking.map(|(pair, _)| pair)
    }

    /// Records the request outcome of an install or remove command.
    pub fn on_result(&mut self, outcome: &Outcome, expired: &str) {
        self.error = match outcome {
            Outcome::Done { ok: true, .. } => None,
            Outcome::Done {
                ok: false, error, ..
            } => match error.as_deref() {
                Some("busy") => Some(TranslateError::Busy),
                other => Some(TranslateError::Other(other.unwrap_or_default().to_string())),
            },
            Outcome::Expired => Some(TranslateError::Other(expired.to_string())),
            Outcome::Plan { .. } | Outcome::Repos(_) => None,
        };
    }

    /// Returns the last request error, cleared on the next action.
    pub fn error(&self) -> Option<&TranslateError> {
        self.error.as_ref()
    }
}

#[cfg(test)]
mod tests {
    use rocky_proto::settings::Settings;
    use rocky_proto::translate::{
        InstallProgress, QuoteLang, TranslateFailure, TranslatePair, TranslateStatus,
    };

    use super::*;
    use crate::i18n::UiLang;
    use crate::requests::Outcome;

    fn status_with(
        ready: Vec<TranslatePair>,
        installing: Option<InstallProgress>,
        failed: Option<TranslateFailure>,
    ) -> TranslateStatus {
        TranslateStatus {
            ready,
            installing,
            failed,
        }
    }

    #[test]
    fn status_line_order() {
        let busy_status = status_with(
            vec![TranslatePair::IdEn],
            Some(InstallProgress {
                pair: TranslatePair::IdEn,
                done_bytes: 50,
                total_bytes: 200,
            }),
            Some(TranslateFailure::Engine),
        );
        // Rule 1: disabled -> Off (takes precedence over everything).
        assert_eq!(
            status_line(false, &busy_status, UiLang::En),
            StatusLine::Off
        );

        // Rule 2: installing with total_bytes == 0 -> Downloading(None).
        let zero_total = status_with(
            vec![],
            Some(InstallProgress {
                pair: TranslatePair::IdEn,
                done_bytes: 10,
                total_bytes: 0,
            }),
            None,
        );
        assert_eq!(
            status_line(true, &zero_total, UiLang::En),
            StatusLine::Downloading(None)
        );

        // Rule 2: installing together with failed: Some(Download) -> Downloading(..).
        let installing_with_failed = status_with(
            vec![],
            Some(InstallProgress {
                pair: TranslatePair::IdEn,
                done_bytes: 50,
                total_bytes: 200,
            }),
            Some(TranslateFailure::Download),
        );
        assert_eq!(
            status_line(true, &installing_with_failed, UiLang::En),
            StatusLine::Downloading(Some(25))
        );

        // Rule 2: percent capped at 100.
        let over_total = status_with(
            vec![],
            Some(InstallProgress {
                pair: TranslatePair::IdEn,
                done_bytes: 300,
                total_bytes: 200,
            }),
            None,
        );
        assert_eq!(
            status_line(true, &over_total, UiLang::En),
            StatusLine::Downloading(Some(100))
        );

        // Rule 3: failed == Engine beats ready.
        let engine_failed = status_with(
            vec![TranslatePair::IdEn],
            None,
            Some(TranslateFailure::Engine),
        );
        assert_eq!(
            status_line(true, &engine_failed, UiLang::En),
            StatusLine::Failed(TranslateFailure::Engine)
        );

        // Rule 4: ready id-en with failed: Download at UiLang::En -> Ready.
        let ready_with_download_fail = status_with(
            vec![TranslatePair::IdEn],
            None,
            Some(TranslateFailure::Download),
        );
        assert_eq!(
            status_line(true, &ready_with_download_fail, UiLang::En),
            StatusLine::Ready
        );

        // Rule 5: failed == Some(f) when pair is not ready -> Failed(f).
        let checksum_failed = status_with(vec![], None, Some(TranslateFailure::Checksum));
        assert_eq!(
            status_line(true, &checksum_failed, UiLang::En),
            StatusLine::Failed(TranslateFailure::Checksum)
        );

        // Rule 6: otherwise -> NeedsDownload.
        let empty = TranslateStatus::default();
        assert_eq!(
            status_line(true, &empty, UiLang::En),
            StatusLine::NeedsDownload
        );
    }

    #[test]
    fn target_needs_on_ready_and_engine() {
        let ready_en = status_with(vec![TranslatePair::IdEn], None, None);
        assert_eq!(translate_target(None, &ready_en, UiLang::En), None);

        let off = Settings {
            translate_quotes: false,
            ..Settings::default()
        };
        assert_eq!(translate_target(Some(&off), &ready_en, UiLang::En), None);

        let on = Settings {
            translate_quotes: true,
            ..Settings::default()
        };
        assert_eq!(
            translate_target(Some(&on), &TranslateStatus::default(), UiLang::En),
            None
        );

        let engine_failed = status_with(
            vec![TranslatePair::IdEn],
            None,
            Some(TranslateFailure::Engine),
        );
        assert_eq!(
            translate_target(Some(&on), &engine_failed, UiLang::En),
            None
        );

        let download_failed = status_with(
            vec![TranslatePair::IdEn],
            None,
            Some(TranslateFailure::Download),
        );
        assert_eq!(
            translate_target(Some(&on), &download_failed, UiLang::En),
            Some(QuoteLang::En)
        );

        assert_eq!(
            translate_target(Some(&on), &ready_en, UiLang::En),
            Some(QuoteLang::En)
        );
        assert_eq!(translate_target(Some(&on), &ready_en, UiLang::Id), None);

        let ready_id = status_with(vec![TranslatePair::EnId], None, None);
        assert_eq!(
            translate_target(Some(&on), &ready_id, UiLang::Id),
            Some(QuoteLang::Id)
        );
    }

    #[test]
    fn toggle_on_without_files_asks_first() {
        let mut flow = TranslateFlow::default();
        let status = TranslateStatus::default();

        let out = flow.act(TranslateAction::Toggle, false, &status, UiLang::En);
        assert_eq!(out, Vec::<Outgoing>::new());
        assert_eq!(flow.asking(), Some(TranslatePair::IdEn));

        let out = flow.act(TranslateAction::Confirm, false, &status, UiLang::En);
        assert_eq!(
            out,
            vec![
                Outgoing::SetEnabled(true),
                Outgoing::Install(TranslatePair::IdEn),
            ]
        );
        assert_eq!(flow.asking(), None);
    }

    #[test]
    fn cancel_sends_nothing() {
        let mut flow = TranslateFlow::default();
        let status = TranslateStatus::default();

        let out = flow.act(TranslateAction::Toggle, false, &status, UiLang::En);
        assert!(out.is_empty());
        assert_eq!(flow.asking(), Some(TranslatePair::IdEn));

        let out = flow.act(TranslateAction::Cancel, false, &status, UiLang::En);
        assert!(out.is_empty());
        assert_eq!(flow.asking(), None);
    }

    #[test]
    fn toggle_on_with_files_sets_only() {
        let mut flow = TranslateFlow::default();
        let status = status_with(vec![TranslatePair::IdEn], None, None);

        let out = flow.act(TranslateAction::Toggle, false, &status, UiLang::En);
        assert_eq!(out, vec![Outgoing::SetEnabled(true)]);
        assert_eq!(flow.asking(), None);

        let out = flow.act(TranslateAction::Toggle, true, &status, UiLang::En);
        assert_eq!(out, vec![Outgoing::SetEnabled(false)]);
        assert_eq!(flow.asking(), None);
    }

    #[test]
    fn download_when_on_installs_only() {
        let mut flow = TranslateFlow::default();
        let status = TranslateStatus::default();

        let out = flow.act(TranslateAction::Download, true, &status, UiLang::En);
        assert!(out.is_empty());
        assert_eq!(flow.asking(), Some(TranslatePair::IdEn));

        let out = flow.act(TranslateAction::Confirm, true, &status, UiLang::En);
        assert_eq!(out, vec![Outgoing::Install(TranslatePair::IdEn)]);
        assert_eq!(flow.asking(), None);

        let out = flow.act(TranslateAction::Retry, false, &status, UiLang::Id);
        assert!(out.is_empty());
        assert_eq!(flow.asking(), Some(TranslatePair::EnId));

        let out = flow.act(TranslateAction::Confirm, false, &status, UiLang::Id);
        assert_eq!(
            out,
            vec![
                Outgoing::SetEnabled(true),
                Outgoing::Install(TranslatePair::EnId),
            ]
        );
        assert_eq!(flow.asking(), None);

        let out = flow.act(TranslateAction::Confirm, true, &status, UiLang::En);
        assert!(out.is_empty());

        let out = flow.act(TranslateAction::Remove, true, &status, UiLang::En);
        assert_eq!(out, vec![Outgoing::Remove]);
    }

    #[test]
    fn busy_ack_maps_to_busy() {
        let mut flow = TranslateFlow::default();

        flow.on_result(
            &Outcome::Done {
                ok: false,
                error: Some("busy".into()),
                cleanup_errors: 0,
            },
            "expired",
        );
        assert_eq!(flow.error(), Some(&TranslateError::Busy));

        flow.on_result(
            &Outcome::Done {
                ok: false,
                error: Some("disk full".into()),
                cleanup_errors: 0,
            },
            "expired",
        );
        assert_eq!(
            flow.error(),
            Some(&TranslateError::Other("disk full".into()))
        );

        flow.on_result(
            &Outcome::Done {
                ok: false,
                error: None,
                cleanup_errors: 0,
            },
            "expired",
        );
        assert_eq!(flow.error(), Some(&TranslateError::Other(String::new())));

        flow.on_result(&Outcome::Expired, "timed out");
        assert_eq!(
            flow.error(),
            Some(&TranslateError::Other("timed out".into()))
        );

        flow.on_result(
            &Outcome::Done {
                ok: true,
                error: None,
                cleanup_errors: 0,
            },
            "expired",
        );
        assert_eq!(flow.error(), None);

        // Any action clears error.
        flow.on_result(&Outcome::Expired, "timed out");
        assert!(flow.error().is_some());
        flow.act(
            TranslateAction::Cancel,
            false,
            &TranslateStatus::default(),
            UiLang::En,
        );
        assert_eq!(flow.error(), None);
    }
}
