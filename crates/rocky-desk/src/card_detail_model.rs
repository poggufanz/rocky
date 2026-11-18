//! Pure view-model for change card detail, execution timeline, and paged block diffs.

use std::collections::HashMap;

use rocky_proto::cards::{Block, Card, CoverageState, FlowKind, FlowStep, Importance};
use rocky_proto::pipe::{BlockSnippet, ClientMsg, DiffLine, SnippetLine};

use crate::cards_model::{
    block_kind, block_status, format_symbol, last_path_segment, prompt_display, repo_name,
    sanitize_single_line, status_chip,
};
use crate::i18n::{CardMsg, UiLang, card_text, label_chip};

const MAX_TIMELINE_STEPS: usize = 12;
const MAX_STEP_SUBS: usize = 3;

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
}

impl DetailModel {
    /// Starts loading `card_id` and returns the model alongside the outgoing `CardDetail` request.
    pub fn open(card_id: String, id: u64) -> (DetailModel, ClientMsg) {
        let msg = ClientMsg::CardDetail {
            id,
            card_id: card_id.clone(),
        };
        let model = Self {
            card_id,
            pending_id: Some(id),
            reopened: false,
            state: DetailState::Loading,
        };
        (model, msg)
    }

    /// Resets to `Loading`, re-requests the open card after reconnect, and marks `NotFound` to close the view.
    pub fn reopen(&mut self, id: u64) -> ClientMsg {
        self.pending_id = Some(id);
        self.reopened = true;
        self.state = DetailState::Loading;
        ClientMsg::CardDetail {
            id,
            card_id: self.card_id.clone(),
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
    pub fn on_detail(&mut self, id: u64, card: Card, snippets: Vec<BlockSnippet>, lang: UiLang) {
        if self.pending_id != Some(id) {
            return;
        }
        self.pending_id = None;
        self.reopened = false;
        self.state = DetailState::Ready(build_detail_view(&card, &snippets, lang));
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

/// Rendered data for a loaded change card detail view.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DetailView {
    pub prompt: String,
    pub prompt_is_notice: bool,
    pub meta: String,
    pub groups: Vec<QuoteGroup>,
    pub timeline: Vec<Step>,
    pub timeline_more: Option<String>,
    pub coverage: String,
    pub outside: Option<String>,
}

/// Consecutive change blocks sharing one agent explanation quote (or missing quote).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuoteGroup {
    pub quote: Option<String>,
    pub blocks: Vec<BlockView>,
}

impl QuoteGroup {
    /// Returns `(text, is_dim)` for rendering this group's quote line in `lang`.
    pub fn quote_line(&self, lang: UiLang) -> (String, bool) {
        match &self.quote {
            Some(text) => (text.clone(), false),
            None => (card_text(lang, &CardMsg::NoAgentWords), true),
        }
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

/// Load state of an opened paged block diff.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiffState {
    Loading,
    Page {
        lines: Vec<DiffLine>,
        page: u32,
        pages: u32,
    },
    Missing,
    NotFound,
}

/// Pure request/reply state machine for one block's paged unified diff.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffModel {
    card_id: String,
    seq: u32,
    page: u32,
    known_pages: Option<u32>,
    pending_id: Option<u64>,
    reopened: bool,
    state: DiffState,
}

impl DiffModel {
    /// Opens the diff at page `0` and returns the model with the outgoing `BlockDiff` request.
    pub fn open(card_id: String, seq: u32, id: u64) -> (DiffModel, ClientMsg) {
        let msg = ClientMsg::BlockDiff {
            id,
            card_id: card_id.clone(),
            seq,
            page: 0,
        };
        let model = Self {
            card_id,
            seq,
            page: 0,
            known_pages: None,
            pending_id: Some(id),
            reopened: false,
            state: DiffState::Loading,
        };
        (model, msg)
    }

    /// Resets to `Loading`, re-requests `seq` and `page` after reconnect, and marks `NotFound` to close views.
    pub fn reopen(&mut self, id: u64) -> ClientMsg {
        self.pending_id = Some(id);
        self.reopened = true;
        self.state = DiffState::Loading;
        ClientMsg::BlockDiff {
            id,
            card_id: self.card_id.clone(),
            seq: self.seq,
            page: self.page,
        }
    }

    /// Pending request id awaiting a `BlockDiff` or `Ack` reply.
    pub fn pending_id(&self) -> Option<u64> {
        self.pending_id
    }

    /// True if a reconnect re-open ended with `DiffState::NotFound`.
    pub fn reopened_not_found(&self) -> bool {
        self.reopened && self.state == DiffState::NotFound
    }

    /// Requests another `page` when total pages are known and `page < pages`.
    pub fn go(&mut self, page: u32, id: u64) -> Option<ClientMsg> {
        let pages = self.known_pages?;
        if page >= pages {
            return None;
        }
        self.page = page;
        self.pending_id = Some(id);
        self.reopened = false;
        self.state = DiffState::Loading;
        Some(ClientMsg::BlockDiff {
            id,
            card_id: self.card_id.clone(),
            seq: self.seq,
            page,
        })
    }

    /// Applies a `ServerMsg::BlockDiff` reply if `id` matches the active pending request.
    pub fn on_diff(&mut self, id: u64, lines: Vec<DiffLine>, page: u32, pages: u32, missing: bool) {
        if self.pending_id != Some(id) {
            return;
        }
        self.pending_id = None;
        self.reopened = false;
        if missing {
            self.known_pages = None;
            self.state = DiffState::Missing;
            return;
        }
        self.page = page;
        self.known_pages = Some(pages);
        self.state = DiffState::Page { lines, page, pages };
    }

    /// Applies an `Ack` reply for the pending diff request; failures transition to `NotFound`.
    pub fn on_ack(&mut self, id: u64, ok: bool) {
        if handle_ack(&mut self.pending_id, id, ok) {
            self.known_pages = None;
            self.state = DiffState::NotFound;
        }
    }

    /// Current diff load state.
    pub fn state(&self) -> &DiffState {
        &self.state
    }

    /// Identifier of the card targeted by this diff model.
    pub fn card_id(&self) -> &str {
        &self.card_id
    }

    /// Block sequence number targeted by this diff model.
    pub fn seq(&self) -> u32 {
        self.seq
    }

    /// Zero-based page index currently requested or displayed by this diff model.
    pub fn page(&self) -> u32 {
        self.page
    }
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

    DetailView {
        prompt,
        prompt_is_notice,
        meta: build_meta(card, lang),
        groups,
        timeline,
        timeline_more,
        coverage,
        outside,
    }
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
        let quote = block
            .quote
            .as_ref()
            .map(|q| q.text.as_str())
            .filter(|t| !t.trim().is_empty())
            .map(str::to_string);
        let view = build_block_view(block, &card.root, snippet_by_seq, lang);
        if let Some(last) = groups.last_mut()
            && last.quote == quote
        {
            last.blocks.push(view);
        } else {
            groups.push(QuoteGroup {
                quote,
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
