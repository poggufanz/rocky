//! Pure list view-model for change cards: paging, search, pushes, nesting, and row formatting.

use std::collections::{HashMap, HashSet};

use rocky_proto::cards::Card;
use rocky_proto::paths::canonical_path;
use rocky_proto::pipe::ClientMsg;
use rocky_proto::translate::{QuoteLang, QuoteTranslation};

use crate::atlas_model::ProjectId;
use crate::i18n::{CardMsg, UiLang};
pub(crate) use rows::{
    block_kind, block_status, cut_to_limit, first_non_empty_line, format_symbol, last_path_segment,
    prompt_display, repo_name, sanitize_single_line, status_chip,
};
use rows::{build_card_row, card_matches_query, card_sort_key};

mod rows;

/// Number of cards requested per page from the daemon.
pub const PAGE_LIMIT: u32 = 20;

/// Separate text and command parts for a Bash group row so the command renders in monospace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BashRow {
    pub before: String,
    pub cmd: String,
    pub after: String,
    pub uncertain: Option<String>,
}

/// One tooltip line with an optional trailing monospace code span (for `via Bash` commands).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TooltipLine {
    pub text: String,
    pub code: Option<String>,
}

impl TooltipLine {
    pub(crate) fn text(text: impl AsRef<str>) -> Self {
        Self {
            text: sanitize_single_line(text.as_ref()),
            code: None,
        }
    }

    fn with_code(text: impl AsRef<str>, code: impl AsRef<str>) -> Self {
        Self {
            text: sanitize_single_line(text.as_ref()),
            code: Some(sanitize_single_line(code.as_ref())),
        }
    }
}

/// Rendered edit row inside a [`CardRow`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditRow {
    pub seq: u32,
    pub file: String,
    pub symbol: Option<String>,
    pub chip: String,
    pub high: bool,
    pub matched: bool,
    pub bash: Option<BashRow>,
    pub tooltip: Vec<TooltipLine>,
}

/// Rendered card list entry produced by [`CardsModel::rows`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CardRow {
    pub card_id: String,
    pub indent: bool,
    pub title: String,
    pub time: String,
    pub meta: String,
    pub meta_high: Option<String>,
    pub edits: Vec<EditRow>,
    pub more: Option<String>,
    /// One chip per distinct file, in first-edit order, for the compact list.
    pub files: Vec<FileChip>,
    /// Distinct files beyond `files`.
    pub files_more: usize,
}

/// One changed file in the compact Done list: name, how many edits, and
/// whether any of them is important or matches the search.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileChip {
    pub name: String,
    pub edits: u32,
    pub high: bool,
    pub matched: bool,
    /// Full path first, then the labels and words of its edits.
    pub tooltip: Vec<TooltipLine>,
}

/// Pure state machine for the desk's paginated, searchable change-card list.
#[derive(Debug, Default)]
pub struct CardsModel {
    items: Vec<Card>,
    query: String,
    next: Option<String>,
    pending_id: Option<u64>,
    pending_replace: bool,
    pending_pushes: Vec<Card>,
    loading: bool,
    requested: bool,
    target: Option<QuoteLang>,
    translations: HashMap<String, QuoteTranslation>,
}

impl CardsModel {
    /// Creates an empty card list model with no active query or pending request.
    pub fn new() -> Self {
        Self::default()
    }

    /// True while a page request is awaiting its matching reply.
    pub fn loading(&self) -> bool {
        self.loading
    }

    /// Copy shown when the list has no visible rows.
    pub fn empty_msg(&self) -> CardMsg {
        if self.loading || !self.requested {
            CardMsg::Loading
        } else {
            CardMsg::Empty
        }
    }

    /// Copy for an empty list shown for one project: when other projects have
    /// cards, say this project has none instead of "No cards yet".
    pub fn empty_msg_for(&self, project: Option<&ProjectId>) -> CardMsg {
        match self.empty_msg() {
            CardMsg::Empty if project.is_some() && !self.items.is_empty() => {
                CardMsg::EmptyForProject
            }
            other => other,
        }
    }

    /// True when the daemon reported another page cursor after the loaded items.
    pub fn has_more(&self) -> bool {
        self.next.is_some()
    }

    /// Current search query string.
    pub fn query(&self) -> &str {
        &self.query
    }

    /// Loaded history cards stored in the model.
    pub(crate) fn items(&self) -> &[Card] {
        &self.items
    }

    /// Requests the first page under the current query.
    pub fn request_first_page(&mut self, id: u64) -> ClientMsg {
        self.pending_id = Some(id);
        self.pending_replace = true;
        self.pending_pushes.clear();
        self.loading = true;
        self.requested = true;
        self.next = None;
        self.build_request(id, None)
    }

    /// Requests the next page using the stored cursor, or returns `None` if exhausted or loading.
    pub fn request_more(&mut self, id: u64) -> Option<ClientMsg> {
        if self.loading {
            return None;
        }
        let before = self.next.clone()?;
        self.pending_id = Some(id);
        self.pending_replace = false;
        self.loading = true;
        Some(self.build_request(id, Some(before)))
    }

    /// Replaces the search query, clears loaded items, and requests page one.
    pub fn set_query(&mut self, q: String, id: u64) -> ClientMsg {
        self.query = q;
        self.items.clear();
        self.request_first_page(id)
    }

    /// Updates the translation target language, clearing cached translations and
    /// requesting page one only when the target changed.
    pub fn set_target(&mut self, target: Option<QuoteLang>, id: u64) -> Option<ClientMsg> {
        if self.target == target {
            return None;
        }
        self.target = target;
        self.translations.clear();
        Some(self.request_first_page(id))
    }

    /// Clears pending state when a card request fails without discarding existing items or cursors.
    pub fn on_ack(&mut self, id: u64, ok: bool) -> bool {
        if self.pending_id != Some(id) || ok {
            return false;
        }
        self.pending_id = None;
        self.loading = false;
        self.pending_replace = false;
        self.pending_pushes.clear();
        true
    }

    /// Applies a `ServerMsg::Cards` reply if its `id` matches the latest pending request.
    pub fn on_cards(
        &mut self,
        id: u64,
        items: Vec<Card>,
        next: Option<String>,
        translations: Vec<QuoteTranslation>,
    ) {
        if self.pending_id != Some(id) {
            return;
        }
        self.pending_id = None;
        self.loading = false;
        self.next = next;
        let pending_pushes = if self.pending_replace {
            self.pending_replace = false;
            self.items.clear();
            self.translations.clear();
            std::mem::take(&mut self.pending_pushes)
        } else {
            Vec::new()
        };
        for item in translations {
            if Some(item.from.other()) == self.target
                && !crate::plain_text::plain_quote(&item.text).trim().is_empty()
            {
                self.translations
                    .entry(item.quote_key.clone())
                    .or_insert(item);
            }
        }
        for card in items {
            upsert_by_rev(&mut self.items, card);
        }
        for pushed in pending_pushes {
            self.apply_push(pushed);
        }
    }

    /// Applies a pushed card: updates a known card in place on higher `rev`, or inserts matching new cards.
    pub fn on_push(&mut self, card: Card) {
        let pending_copy = self.pending_replace.then(|| card.clone());
        if self.apply_push(card)
            && let Some(pushed) = pending_copy
        {
            upsert_by_rev(&mut self.pending_pushes, pushed);
        }
    }

    /// Renders the current page into nested, single-line [`CardRow`] entries in `lang`.
    pub fn rows(&self, lang: UiLang) -> Vec<CardRow> {
        let query_lower = self.query.to_lowercase();
        let present_ids: HashSet<&str> = self.items.iter().map(|c| c.card_id.as_str()).collect();
        let mut visited = vec![false; self.items.len()];
        let mut out = Vec::with_capacity(self.items.len());

        for idx in 0..self.items.len() {
            let has_parent_on_page = self.items[idx]
                .parent_card_id
                .as_deref()
                .is_some_and(|pid| pid != self.items[idx].card_id && present_ids.contains(pid));
            if !has_parent_on_page {
                emit_subtree(
                    idx,
                    false,
                    &self.items,
                    &mut visited,
                    &query_lower,
                    lang,
                    &self.translations,
                    &mut out,
                );
            }
        }

        // Guard against malformed parent cycles so no loaded card is ever dropped.
        for idx in 0..self.items.len() {
            if !visited[idx] {
                emit_subtree(
                    idx,
                    false,
                    &self.items,
                    &mut visited,
                    &query_lower,
                    lang,
                    &self.translations,
                    &mut out,
                );
            }
        }

        out
    }

    /// Like [`Self::rows`], but only the cards that belong to `project`.
    pub fn rows_for(&self, lang: UiLang, project: &ProjectId) -> Vec<CardRow> {
        let mine: HashSet<&str> = self
            .items
            .iter()
            .filter(|c| in_project(c, &project.0, cfg!(windows)))
            .map(|c| c.card_id.as_str())
            .collect();
        self.rows(lang)
            .into_iter()
            .filter(|row| mine.contains(row.card_id.as_str()))
            .collect()
    }

    fn apply_push(&mut self, card: Card) -> bool {
        if let Some(existing) = self.items.iter_mut().find(|c| c.card_id == card.card_id) {
            if card.rev > existing.rev {
                *existing = card;
                return true;
            }
            return false;
        }
        if !self.query.is_empty() && !card_matches_query(&card, &self.query.to_lowercase()) {
            return false;
        }
        let new_key = (card_sort_key(&card), card.card_id.as_str());
        let pos = self
            .items
            .iter()
            .position(|c| (card_sort_key(c), c.card_id.as_str()) < new_key)
            .unwrap_or(self.items.len());
        self.items.insert(pos, card);
        true
    }

    fn build_request(&self, id: u64, before: Option<String>) -> ClientMsg {
        ClientMsg::Cards {
            id,
            query: (!self.query.is_empty()).then(|| self.query.clone()),
            before,
            limit: PAGE_LIMIT,
            translate_to: self.target,
        }
    }
}

fn upsert_by_rev(cards: &mut Vec<Card>, card: Card) {
    if let Some(existing) = cards.iter_mut().find(|c| c.card_id == card.card_id) {
        if card.rev > existing.rev {
            *existing = card;
        }
    } else {
        cards.push(card);
    }
}

/// True when the card's main checkout (else its root) is `project`. The daemon
/// stores card roots canonicalized (lowercase on Windows) while project ids keep
/// git's spelling, so both sides are canonicalized before comparing.
fn in_project(card: &Card, project: &str, win32: bool) -> bool {
    let root = card.main_root.as_deref().unwrap_or(&card.root);
    canonical_path(root, win32) == canonical_path(project, win32)
}

#[allow(clippy::too_many_arguments)]
fn emit_subtree(
    idx: usize,
    indent: bool,
    items: &[Card],
    visited: &mut [bool],
    query_lower: &str,
    lang: UiLang,
    translations: &HashMap<String, QuoteTranslation>,
    out: &mut Vec<CardRow>,
) {
    if visited[idx] {
        return;
    }
    visited[idx] = true;
    out.push(build_card_row(
        &items[idx],
        indent,
        query_lower,
        lang,
        translations,
    ));

    let parent_id = items[idx].card_id.as_str();
    for child_idx in 0..items.len() {
        if !visited[child_idx] && items[child_idx].parent_card_id.as_deref() == Some(parent_id) {
            emit_subtree(
                child_idx,
                true,
                items,
                visited,
                query_lower,
                lang,
                translations,
                out,
            );
        }
    }
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_edge_cases;
