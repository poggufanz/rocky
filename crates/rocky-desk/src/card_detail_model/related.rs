//! Earlier attempts rows for change card detail.

use rocky_proto::pipe::RelatedAttempt;

use super::{DetailModel, DetailState};
use crate::cards_model::{cut_to_limit, sanitize_single_line};
use crate::i18n::{CardMsg, UiLang, card_text};

const MAX_ROWS: usize = 5;
const FILES_MAX_CHARS: usize = 120;

/// One rendered earlier attempt row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelatedRow {
    pub date: String,
    pub outcome: String,
    pub files: Option<String>,
}

impl DetailModel {
    /// Applies earlier attempts for the open card. Returns true for an update to the ready view.
    pub fn on_related(&mut self, card_id: &str, rev: u32, items: &[RelatedAttempt]) -> bool {
        if self.card_id != card_id {
            return false;
        }
        match (&self.state, self.rev) {
            (DetailState::Ready(_), Some(current)) if current == rev => {
                self.related = items.to_vec();
                true
            }
            (DetailState::Loading, _) => {
                self.related_early = Some((rev, items.to_vec()));
                false
            }
            _ => false,
        }
    }

    /// Builds localized rows for the earlier attempts section. An empty list hides the section.
    pub fn related_rows(&self, lang: UiLang) -> Vec<RelatedRow> {
        self.related
            .iter()
            .take(MAX_ROWS)
            .map(|item| {
                let mut files = item
                    .files
                    .iter()
                    .map(|file| sanitize_single_line(file))
                    .collect::<Vec<_>>()
                    .join(", ");
                if item.more > 0 {
                    if !files.is_empty() {
                        files.push(' ');
                    }
                    files.push_str(&card_text(
                        lang,
                        &CardMsg::RelatedMoreFiles { n: item.more },
                    ));
                }
                RelatedRow {
                    date: sanitize_single_line(&item.date),
                    outcome: card_text(
                        lang,
                        &CardMsg::AttemptOutcomeLabel {
                            outcome: item.outcome,
                        },
                    ),
                    files: (!files.is_empty()).then(|| cut_to_limit(&files, FILES_MAX_CHARS)),
                }
            })
            .collect()
    }
}
