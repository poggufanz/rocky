//! Pure view-model for change card detail and execution timeline. The paged
//! block diff lives in [`diff`], and earlier attempt rows live in [`related`].

use std::collections::{HashMap, HashSet};

use rocky_proto::cards::{Block, Card, CoverageState, FlowKind, FlowStep, Importance, Sequence};
use rocky_proto::pipe::{BlockSnippet, ClientMsg, RelatedAttempt, SnippetLine};
use rocky_proto::translate::{QuoteLang, QuoteTranslation, quote_key};

use crate::cards_model::{
    block_kind, block_status, cut_to_limit, format_symbol, last_path_segment, prompt_display,
    repo_name, sanitize_single_line, status_chip,
};
use crate::i18n::{CardMsg, UiLang, card_text, label_chip};

mod diff;
mod related;

pub use diff::{DiffModel, DiffState};
pub use related::RelatedRow;

const MAX_TIMELINE_STEPS: usize = 12;
const MAX_STEP_SUBS: usize = 3;
const SEQUENCE_CMD_MAX_CHARS: usize = 80;

/// Load state of an opened change card detail view.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DetailState {
    Loading,
    Ready(DetailView),
    NotFound,
}

/// Pure request/reply state machine for one opened change card detail view.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DetailModel {
    card_id: String,
    pending_id: Option<u64>,
    reopened: bool,
    state: DetailState,
    rev: Option<u32>,
    related: Vec<RelatedAttempt>,
    related_early: Option<(u32, Vec<RelatedAttempt>)>,
    target: Option<QuoteLang>,
    translations: HashMap<String, QuoteTranslation>,
    pending: HashSet<String>,
    settled_early: HashSet<String>,
    shown_original: HashSet<String>,
}

impl DetailModel {
    /// Starts loading `card_id` and returns the model alongside the outgoing `CardDetail` request.
    pub fn open(card_id: String, id: u64, target: Option<QuoteLang>) -> (DetailModel, ClientMsg) {
        let msg = ClientMsg::CardDetail {
            id,
            card_id: card_id.clone(),
            translate_to: target,
        };
        let model = Self {
            card_id,
            pending_id: Some(id),
            reopened: false,
            state: DetailState::Loading,
            rev: None,
            related: Vec::new(),
            related_early: None,
            target,
            translations: HashMap::new(),
            pending: HashSet::new(),
            settled_early: HashSet::new(),
            shown_original: HashSet::new(),
        };
        (model, msg)
    }

    /// Resets to `Loading`, re-requests the open card after reconnect with `target`, and marks `NotFound` to close the view.
    pub fn reopen(&mut self, id: u64, target: Option<QuoteLang>) -> ClientMsg {
        self.pending_id = Some(id);
        self.reopened = true;
        self.state = DetailState::Loading;
        self.related.clear();
        self.related_early = None;
        self.pending.clear();
        self.settled_early.clear();
        if self.target != target {
            self.target = target;
            self.translations.clear();
            self.shown_original.clear();
        }
        ClientMsg::CardDetail {
            id,
            card_id: self.card_id.clone(),
            translate_to: target,
        }
    }

    /// Switches the translation target language, keeping the current view state until the reply arrives.
    pub fn retarget(&mut self, id: u64, target: Option<QuoteLang>) -> Option<ClientMsg> {
        if self.target == target {
            return None;
        }
        self.target = target;
        self.translations.clear();
        self.pending.clear();
        self.settled_early.clear();
        self.shown_original.clear();
        match target {
            None => {
                if !matches!(self.state, DetailState::Loading) {
                    self.pending_id = None;
                }
                None
            }
            Some(_) => {
                self.pending_id = Some(id);
                Some(ClientMsg::CardDetail {
                    id,
                    card_id: self.card_id.clone(),
                    translate_to: target,
                })
            }
        }
    }

    /// Pending request id awaiting a `CardDetail` or `Ack` reply.
    pub fn pending_id(&self) -> Option<u64> {
        self.pending_id
    }

    /// True if a reconnect re-open ended with `DetailState::NotFound`.
    pub fn reopened_not_found(&self) -> bool {
        self.reopened && self.state == DetailState::NotFound
    }

    /// Applies a `ServerMsg::CardDetail` reply if `id` matches the active pending request.
    pub fn on_detail(
        &mut self,
        id: u64,
        card: Card,
        snippets: Vec<BlockSnippet>,
        translations: Vec<QuoteTranslation>,
        pending: Vec<String>,
        lang: UiLang,
    ) {
        if self.pending_id != Some(id) {
            return;
        }
        if self.rev != Some(card.rev) {
            self.related.clear();
        }
        self.rev = Some(card.rev);
        if let Some((rev, items)) = self.related_early.take()
            && rev == card.rev
        {
            self.related = items;
        }
        self.pending_id = None;
        self.reopened = false;
        self.state = DetailState::Ready(build_detail_view(&card, &snippets, lang));
        if self.target.is_some() {
            for item in translations {
                if Some(item.from.other()) == self.target {
                    self.translations
                        .entry(item.quote_key.clone())
                        .or_insert(item);
                }
            }
            self.pending = pending
                .into_iter()
                .filter(|k| !self.settled_early.contains(k) && !self.translations.contains_key(k))
                .collect();
        } else {
            self.translations.clear();
            self.pending.clear();
        }
        self.settled_early.clear();
    }

    /// Applies a pushed quote translation if `card_id` and active target language match.
    pub fn on_translated(&mut self, card_id: &str, item: &QuoteTranslation) -> bool {
        if self.card_id != card_id || Some(item.from.other()) != self.target {
            return false;
        }
        self.pending.remove(&item.quote_key);
        self.translations
            .insert(item.quote_key.clone(), item.clone());
        true
    }

    /// Clears pending state for `quote_key` when settled for the active target language.
    pub fn on_settled(&mut self, card_id: &str, quote_key: &str, to: QuoteLang) -> bool {
        if self.card_id != card_id || Some(to) != self.target {
            return false;
        }
        self.pending.remove(quote_key);
        if self.pending_id.is_some() {
            self.settled_early.insert(quote_key.to_string());
        }
        true
    }

    /// Toggles whether `quote_key` shows its original text instead of its translation.
    pub fn toggle_original(&mut self, quote_key: &str) {
        if !self.shown_original.remove(quote_key) {
            self.shown_original.insert(quote_key.to_string());
        }
    }

    /// Resolves display text and translation flags for `group` in `lang`.
    pub fn quote_display(&self, group: &QuoteGroup, lang: UiLang) -> QuoteDisplay {
        let Some(key) = group.quote_key() else {
            return QuoteDisplay {
                text: card_text(lang, &CardMsg::NoAgentWords),
                is_dim: true,
                key: None,
                translated_from: None,
                showing_original: false,
                translating: false,
            };
        };
        let original = || match &group.quote {
            Some(text) if !text.is_empty() => (text.clone(), false),
            _ => (card_text(lang, &CardMsg::NoAgentWords), true),
        };
        if let Some(tr) = self.translations.get(&key) {
            let cleaned = crate::plain_text::plain_quote(&tr.text);
            if !cleaned.is_empty() {
                let showing_original = self.shown_original.contains(&key);
                let (text, is_dim) = if showing_original {
                    original()
                } else {
                    (cleaned, false)
                };
                return QuoteDisplay {
                    text,
                    is_dim,
                    key: Some(key),
                    translated_from: Some(tr.from),
                    showing_original,
                    translating: false,
                };
            }
        }
        let translating = self.pending.contains(&key);
        let (text, is_dim) = original();
        QuoteDisplay {
            text,
            is_dim,
            key: Some(key),
            translated_from: None,
            showing_original: false,
            translating,
        }
    }

    /// Applies an `Ack` reply for the pending detail request; failures transition to `NotFound`.
    pub fn on_ack(&mut self, id: u64, ok: bool) {
        if handle_ack(&mut self.pending_id, id, ok) {
            self.state = DetailState::NotFound;
        }
    }

    /// Current detail load state.
    pub fn state(&self) -> &DetailState {
        &self.state
    }

    /// Identifier of the card requested by this detail model.
    pub fn card_id(&self) -> &str {
        &self.card_id
    }
}

/// Resolved display state for one quote group, accounting for translation and toggle state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuoteDisplay {
    pub text: String,
    pub is_dim: bool,
    pub key: Option<String>,
    pub translated_from: Option<QuoteLang>,
    pub showing_original: bool,
    pub translating: bool,
}

/// Rendered data for a loaded change card detail view.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DetailView {
    pub prompt: String,
    pub prompt_is_notice: bool,
    pub meta: String,
    pub groups: Vec<QuoteGroup>,
    pub sequence_line: Option<String>,
    pub timeline: Vec<Step>,
    pub timeline_more: Option<String>,
    pub coverage: String,
    pub outside: Option<String>,
}

/// Consecutive change blocks sharing one agent explanation quote (or missing quote).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuoteGroup {
    pub quote: Option<String>,
    pub raw_quote: Option<String>,
    pub blocks: Vec<BlockView>,
}

impl QuoteGroup {
    /// Returns the SHA-256 key of the group's raw quote text, if present.
    pub fn quote_key(&self) -> Option<String> {
        self.raw_quote.as_deref().map(quote_key)
    }
}

/// Rendered change block within a [`QuoteGroup`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockView {
    pub seq: u32,
    pub path: String,
    pub symbol: Option<String>,
    pub head: String,
    pub chips: Vec<(String, bool)>,
    pub code: Vec<CodeLine>,
    pub diffable: bool,
}

/// Single line in a block's inline code snippet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CodeLine {
    Context(String),
    Added(String),
    Removed(String),
    Fold(String),
}

/// Rendered entry in the card's chronological execution timeline.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Step {
    pub ok: bool,
    pub kind: FlowKind,
    pub title: String,
    pub dur: String,
    pub exit: Option<String>,
    pub error: Option<String>,
    pub subs: Vec<(String, String)>,
}

fn handle_ack(pending_id: &mut Option<u64>, id: u64, ok: bool) -> bool {
    if *pending_id != Some(id) || ok {
        return false;
    }
    *pending_id = None;
    true
}

fn build_detail_view(card: &Card, snippets: &[BlockSnippet], lang: UiLang) -> DetailView {
    let snippet_by_seq: HashMap<u32, &[SnippetLine]> = snippets
        .iter()
        .map(|s| (s.seq, s.lines.as_slice()))
        .collect();
    let block_by_seq: HashMap<u32, &Block> = card.blocks.iter().map(|b| (b.seq, b)).collect();

    let groups = build_quote_groups(card, &snippet_by_seq, lang);
    let timeline = card
        .flow
        .iter()
        .take(MAX_TIMELINE_STEPS)
        .map(|step| build_step(step, &card.root, &block_by_seq, lang))
        .collect();
    let overflow = card
        .flow
        .len()
        .saturating_sub(MAX_TIMELINE_STEPS)
        .saturating_add(card.flow_more as usize);
    let timeline_more =
        (overflow > 0).then(|| card_text(lang, &CardMsg::TimelineMoreSteps { n: overflow }));

    let coverage = match card.coverage.state {
        CoverageState::Full => card_text(lang, &CardMsg::CoverageFull),
        CoverageState::Partial => card_text(
            lang,
            &CardMsg::CoveragePartial {
                reasons: card.coverage.reasons.clone(),
            },
        ),
    };
    let outside = (card.outside_count > 0).then(|| {
        card_text(
            lang,
            &CardMsg::OutsideFiles {
                n: card.outside_count,
            },
        )
    });

    let (prompt, prompt_is_notice) = prompt_display(&card.prompt, lang);
    let sequence_line = build_sequence_line(card, &block_by_seq, lang);

    DetailView {
        prompt,
        prompt_is_notice,
        meta: build_meta(card, lang),
        groups,
        sequence_line,
        timeline,
        timeline_more,
        coverage,
        outside,
    }
}

fn build_sequence_line(
    card: &Card,
    block_by_seq: &HashMap<u32, &Block>,
    lang: UiLang,
) -> Option<String> {
    let seq = card.sequence.as_ref()?;
    match seq {
        Sequence::FixAfterFail {
            command,
            exit_code,
            edit_seqs,
            error_names,
        } => {
            let cmd = normalize_and_cut_command(command);
            if cmd.is_empty() {
                return None;
            }
            let mut seen_seqs = HashSet::new();
            let mut entries: Vec<(String, String)> = Vec::new();
            let mut file_level_paths = HashSet::new();
            for &edit_seq in edit_seqs {
                if !seen_seqs.insert(edit_seq) {
                    continue;
                }
                let Some(block) = block_by_seq.get(&edit_seq).copied() else {
                    continue;
                };
                let (path, symbol, head) = block_head_parts(block);
                if entries.is_empty() && head.is_empty() {
                    return None;
                }
                if symbol.is_none() {
                    file_level_paths.insert(path.clone());
                }
                entries.push((path, head));
            }
            if entries.is_empty() {
                return None;
            }
            let mut seen_labels = HashSet::new();
            let mut first_label: Option<String> = None;
            for (path, head) in entries {
                let label = if file_level_paths.contains(&path) {
                    path
                } else {
                    head
                };
                if first_label.is_none() {
                    if label.is_empty() {
                        return None;
                    }
                    first_label = Some(label.clone());
                }
                seen_labels.insert(label);
            }
            let first_label = first_label?;
            let more = seen_labels.len().saturating_sub(1);
            let edits = if more > 0 {
                card_text(
                    lang,
                    &CardMsg::SequenceEditsMore {
                        first: first_label,
                        more,
                    },
                )
            } else {
                first_label
            };
            let error_names = error_names
                .as_deref()
                .map(|s| sanitize_single_line(s).trim().to_string())
                .filter(|s| !s.is_empty());
            Some(card_text(
                lang,
                &CardMsg::SequenceFixAfterFail {
                    command: cmd,
                    exit_code: *exit_code,
                    edits,
                    error_names,
                },
            ))
        }
    }
}

fn normalize_and_cut_command(command: &str) -> String {
    let clean = sanitize_single_line(command);
    let normalized = clean.split_whitespace().collect::<Vec<_>>().join(" ");
    cut_to_limit(&normalized, SEQUENCE_CMD_MAX_CHARS)
}

fn build_meta(card: &Card, lang: UiLang) -> String {
    let mut parts = Vec::new();
    if let Some(repo) = repo_name(card) {
        parts.push(repo);
    }
    if let Some(branch) = card.branch.as_deref() {
        let clean = sanitize_single_line(branch).trim().to_string();
        if !clean.is_empty() {
            parts.push(clean);
        }
    }
    if let Some(ended_ms) = card.ended_ms {
        let secs = ended_ms.saturating_sub(card.started_ms) / 1000;
        parts.push(sanitize_single_line(&card_text(
            lang,
            &CardMsg::Duration { secs },
        )));
    }
    let clean_agent = sanitize_single_line(&card.agent_type).trim().to_string();
    let agent = if clean_agent.is_empty() {
        card_text(lang, &CardMsg::MainAgent)
    } else {
        clean_agent
    };
    parts.push(agent);
    parts.join(" \u{00b7} ")
}

fn build_quote_groups(
    card: &Card,
    snippet_by_seq: &HashMap<u32, &[SnippetLine]>,
    lang: UiLang,
) -> Vec<QuoteGroup> {
    let mut groups: Vec<QuoteGroup> = Vec::new();
    for block in &card.blocks {
        let raw_quote = block.quote.as_ref().map(|q| q.text.clone());
        let quote = raw_quote
            .as_deref()
            .map(crate::plain_text::plain_quote)
            .filter(|t| !t.is_empty());
        let view = build_block_view(block, &card.root, snippet_by_seq, lang);
        if let Some(last) = groups.last_mut()
            && last.quote == quote
        {
            last.blocks.push(view);
        } else {
            groups.push(QuoteGroup {
                quote,
                raw_quote,
                blocks: vec![view],
            });
        }
    }
    groups
}

fn build_block_view(
    block: &Block,
    card_root: &str,
    snippet_by_seq: &HashMap<u32, &[SnippetLine]>,
    lang: UiLang,
) -> BlockView {
    let code = snippet_by_seq
        .get(&block.seq)
        .map(|lines| {
            lines
                .iter()
                .map(|line| map_snippet_line(line, lang))
                .collect()
        })
        .unwrap_or_default();

    let (path, symbol, head) = block_head_parts(block);
    BlockView {
        seq: block.seq,
        path,
        symbol,
        head,
        chips: build_block_chips(block, card_root, lang),
        code,
        diffable: block.recorded && (block.before.is_some() || block.after.is_some()),
    }
}

fn block_head_parts(block: &Block) -> (String, Option<String>, String) {
    let path = sanitize_single_line(&block.path);
    let symbol = format_symbol(block.symbol.as_ref()).filter(|s| !s.is_empty());
    let head = match &symbol {
        Some(sym) => format!("{path} \u{203a} {sym}"),
        None => path.clone(),
    };
    (path, symbol, head)
}

fn block_head(block: &Block) -> String {
    block_head_parts(block).2
}

fn build_block_chips(block: &Block, card_root: &str, lang: UiLang) -> Vec<(String, bool)> {
    let high = block.importance == Importance::High;
    let kind = block_kind(block);
    let mut chips = Vec::new();
    if let Some(status) = status_chip(block_status(block, card_root), lang) {
        chips.push((sanitize_single_line(&status), high));
    }
    for label in &block.labels {
        chips.push((sanitize_single_line(&label_chip(lang, label, kind)), high));
    }
    chips
}

fn map_snippet_line(line: &SnippetLine, lang: UiLang) -> CodeLine {
    match line {
        SnippetLine::Context { text } => CodeLine::Context(text.clone()),
        SnippetLine::Added { text } => CodeLine::Added(text.clone()),
        SnippetLine::Removed { text } => CodeLine::Removed(text.clone()),
        SnippetLine::Fold { lines } => {
            CodeLine::Fold(card_text(lang, &CardMsg::CodeFold { n: *lines }))
        }
        SnippetLine::More { lines } => {
            CodeLine::Fold(card_text(lang, &CardMsg::CodeFoldMore { n: *lines }))
        }
    }
}

fn build_step(
    step: &FlowStep,
    card_root: &str,
    block_by_seq: &HashMap<u32, &Block>,
    lang: UiLang,
) -> Step {
    let failed_cmd = !step.ok && step.kind == FlowKind::Cmd;
    let exit = failed_cmd
        .then_some(step.exit_code)
        .flatten()
        .map(|code| format!("exit {code}"));
    let error = failed_cmd
        .then_some(step.error.as_deref())
        .flatten()
        .map(|s| sanitize_single_line(s).trim().to_string())
        .filter(|s| !s.is_empty());
    Step {
        ok: step.ok,
        kind: step.kind,
        title: build_step_title(step, block_by_seq),
        dur: format_step_dur(step.dur_ms),
        exit,
        error,
        subs: build_step_subs(step, card_root, block_by_seq, lang),
    }
}

fn build_step_title(step: &FlowStep, block_by_seq: &HashMap<u32, &Block>) -> String {
    let clean = sanitize_single_line(&step.text).trim().to_string();
    match step.kind {
        FlowKind::Cmd => clean,
        FlowKind::Edit => {
            if clean.is_empty() {
                if let Some(block) = step.seqs.iter().find_map(|seq| block_by_seq.get(seq)) {
                    return block_head(block);
                }
            } else if !clean.contains('\u{203a}')
                && let Some(sym) = step.seqs.iter().find_map(|seq| {
                    block_by_seq
                        .get(seq)
                        .and_then(|b| format_symbol(b.symbol.as_ref()))
                })
            {
                return format!("{clean} \u{203a} {sym}");
            }
            clean
        }
    }
}

fn build_step_subs(
    step: &FlowStep,
    card_root: &str,
    block_by_seq: &HashMap<u32, &Block>,
    lang: UiLang,
) -> Vec<(String, String)> {
    step.seqs
        .iter()
        .filter_map(|seq| block_by_seq.get(seq))
        .take(MAX_STEP_SUBS)
        .map(|block| {
            let chip = status_chip(block_status(block, card_root), lang)
                .or_else(|| {
                    let kind = block_kind(block);
                    block.labels.first().map(|lbl| label_chip(lang, lbl, kind))
                })
                .map(|c| sanitize_single_line(&c))
                .unwrap_or_default();
            (chip, block_fact(block))
        })
        .collect()
}

fn block_fact(block: &Block) -> String {
    let location = block.line.and_then(|line| {
        let file = last_path_segment(&block.path);
        (!file.is_empty()).then(|| format!("{file}:{line}"))
    });
    let counts = match (block.added.unwrap_or(0), block.removed.unwrap_or(0)) {
        (0, 0) => None,
        (a, 0) => Some(format!("+{a}")),
        (0, r) => Some(format!("\u{2212}{r}")),
        (a, r) => Some(format!("+{a} \u{2212}{r}")),
    };
    match (location, counts) {
        (Some(loc), Some(cnt)) => format!("{loc} \u{00b7} {cnt}"),
        (Some(loc), None) => loc,
        (None, Some(cnt)) => cnt,
        (None, None) => String::new(),
    }
}

pub(crate) fn format_step_dur(dur_ms: u64) -> String {
    let secs = dur_ms / 1000;
    if secs < 60 {
        return format!("{secs}s");
    }
    let mins = secs / 60;
    let rem = secs % 60;
    if rem == 0 {
        format!("{mins}m")
    } else {
        format!("{mins}m {rem}s")
    }
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_edge_cases;
