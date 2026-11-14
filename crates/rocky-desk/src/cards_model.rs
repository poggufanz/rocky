//! Pure list view-model for change cards: paging, search, pushes, nesting, and row formatting.

use std::collections::HashSet;

use rocky_proto::cards::{Block, BlockSymbol, BlockVia, Card, Importance, Label, SymbolKind};
use rocky_proto::pipe::ClientMsg;

use crate::clock::local_hhmm;
use crate::i18n::{CardMsg, UiLang, card_text, label_chip, label_full};

/// Number of cards requested per page from the daemon.
pub const PAGE_LIMIT: u32 = 20;

const TITLE_MAX_CHARS: usize = 80;
const QUOTE_MAX_CHARS: usize = 200;
const CMD_MAX_CHARS: usize = 80;
const MAX_EDIT_ROWS: usize = 3;

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
    fn text(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            code: None,
        }
    }

    fn with_code(text: impl Into<String>, code: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            code: Some(code.into()),
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
    pub edits: Vec<EditRow>,
    pub more: Option<String>,
}

/// Pure state machine for the desk's paginated, searchable change-card list.
#[derive(Debug, Default)]
pub struct CardsModel {
    items: Vec<Card>,
    query: String,
    next: Option<String>,
    pending_id: Option<u64>,
    pending_replace: bool,
    loading: bool,
}

impl CardsModel {
    /// Creates an empty card list model with no active query or pending request.
    pub fn new() -> Self {
        Self::default()
    }

    /// True while a page request is awaiting its matching reply.
    // Used by the card list view to show the loading state.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn loading(&self) -> bool {
        self.loading
    }

    /// True when the daemon reported another page cursor after the loaded items.
    // Used by the card list view to show the "Load more" button.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn has_more(&self) -> bool {
        self.next.is_some()
    }

    /// Current search query string.
    // Used by the card list view and search wiring.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn query(&self) -> &str {
        &self.query
    }

    /// Requests the first page under the current query.
    pub fn request_first_page(&mut self, id: u64) -> ClientMsg {
        self.pending_id = Some(id);
        self.pending_replace = true;
        self.loading = true;
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

    /// Applies a `ServerMsg::Cards` reply if its `id` matches the latest pending request.
    pub fn on_cards(&mut self, id: u64, items: Vec<Card>, next: Option<String>) {
        if self.pending_id != Some(id) {
            return;
        }
        self.pending_id = None;
        self.loading = false;
        self.next = next;
        if self.pending_replace {
            self.items.clear();
            self.pending_replace = false;
        }
        for card in items {
            if let Some(existing) = self.items.iter_mut().find(|c| c.card_id == card.card_id) {
                if card.rev > existing.rev {
                    *existing = card;
                }
            } else {
                self.items.push(card);
            }
        }
    }

    /// Applies a pushed card: updates a known card in place on higher `rev`, or inserts matching new cards.
    pub fn on_push(&mut self, card: Card) {
        if let Some(existing) = self.items.iter_mut().find(|c| c.card_id == card.card_id) {
            if card.rev > existing.rev {
                *existing = card;
            }
            return;
        }
        if !self.query.is_empty() && !card_matches_query(&card, &self.query.to_lowercase()) {
            return;
        }
        let new_key = (card_sort_key(&card), card.card_id.as_str());
        let pos = self
            .items
            .iter()
            .position(|c| (card_sort_key(c), c.card_id.as_str()) < new_key)
            .unwrap_or(self.items.len());
        self.items.insert(pos, card);
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
                    &mut out,
                );
            }
        }

        out
    }

    fn build_request(&self, id: u64, before: Option<String>) -> ClientMsg {
        ClientMsg::Cards {
            id,
            query: (!self.query.is_empty()).then(|| self.query.clone()),
            before,
            limit: PAGE_LIMIT,
        }
    }
}

fn emit_subtree(
    idx: usize,
    indent: bool,
    items: &[Card],
    visited: &mut [bool],
    query_lower: &str,
    lang: UiLang,
    out: &mut Vec<CardRow>,
) {
    if visited[idx] {
        return;
    }
    visited[idx] = true;
    out.push(build_card_row(&items[idx], indent, query_lower, lang));

    let parent_id = items[idx].card_id.as_str();
    for child_idx in 0..items.len() {
        if !visited[child_idx] && items[child_idx].parent_card_id.as_deref() == Some(parent_id) {
            emit_subtree(child_idx, true, items, visited, query_lower, lang, out);
        }
    }
}

fn build_card_row(card: &Card, indent: bool, query_lower: &str, lang: UiLang) -> CardRow {
    let base_title = cut_with_ellipsis(first_non_empty_line(&card.prompt), TITLE_MAX_CHARS);
    let title = if !indent && !card.agent_type.is_empty() {
        format!(
            "{} \u{203a} {base_title}",
            sanitize_single_line(&card.agent_type)
        )
    } else {
        base_title
    };

    let time = local_hhmm(card_sort_key(card));
    let meta = build_meta(card, lang);
    let (edits, more) = build_edit_rows(card, query_lower, lang);

    CardRow {
        card_id: card.card_id.clone(),
        indent,
        title,
        time,
        meta,
        edits,
        more,
    }
}

fn build_meta(card: &Card, lang: UiLang) -> String {
    let mut parts = Vec::new();
    if let Some(name) = repo_name(card) {
        parts.push(name.to_string());
    }
    let total_edits = card.blocks.len().saturating_add(card.more_count as usize);
    parts.push(card_text(lang, &CardMsg::MetaEdits { n: total_edits }));

    let high_count = card
        .blocks
        .iter()
        .filter(|b| b.importance == Importance::High)
        .count();
    if high_count > 0 {
        parts.push(card_text(lang, &CardMsg::MetaImportant { n: high_count }));
    }
    parts.join(" \u{00b7} ")
}

fn build_edit_rows(card: &Card, query_lower: &str, lang: UiLang) -> (Vec<EditRow>, Option<String>) {
    let format_only_count = card
        .blocks
        .iter()
        .filter(|b| is_format_only_collapsible(b, &card.root))
        .count();
    let collapse_format_only = format_only_count >= 2;

    let mut used = vec![false; card.blocks.len()];
    let mut grouped: Vec<(usize, EditRow)> = Vec::new();

    for i in 0..card.blocks.len() {
        if used[i] {
            continue;
        }
        let block = &card.blocks[i];

        if collapse_format_only && is_format_only_collapsible(block, &card.root) {
            let group = collect_group(&card.blocks, &mut used, i, |b| {
                is_format_only_collapsible(b, &card.root)
            });
            let row = build_format_collapse_row(&group, query_lower, lang);
            grouped.push((group.len(), row));
        } else if block.via == BlockVia::Bash
            && let Some(info) = &block.bash
        {
            let target_cmd = info.cmd.as_str();
            let group = collect_group(&card.blocks, &mut used, i, |b| {
                b.via == BlockVia::Bash
                    && b.bash.as_ref().is_some_and(|other| other.cmd == target_cmd)
            });
            let row = build_bash_group_row(&group, target_cmd, query_lower, lang);
            grouped.push((group.len(), row));
        } else {
            used[i] = true;
            let row = build_normal_edit_row(block, &card.root, query_lower, lang);
            grouped.push((1, row));
        }
    }

    let mut edits = Vec::with_capacity(grouped.len().min(MAX_EDIT_ROWS));
    let mut shown_blocks = 0usize;
    for (count, row) in grouped.into_iter().take(MAX_EDIT_ROWS) {
        shown_blocks = shown_blocks.saturating_add(count);
        edits.push(row);
    }

    let remaining = card
        .blocks
        .len()
        .saturating_sub(shown_blocks)
        .saturating_add(card.more_count as usize);
    let more = (remaining > 0).then(|| card_text(lang, &CardMsg::MoreEdits { n: remaining }));
    (edits, more)
}

fn collect_group<'a, F>(
    blocks: &'a [Block],
    used: &mut [bool],
    start: usize,
    predicate: F,
) -> Vec<&'a Block>
where
    F: Fn(&Block) -> bool,
{
    let mut group = Vec::new();
    for j in start..blocks.len() {
        if !used[j] && predicate(&blocks[j]) {
            used[j] = true;
            group.push(&blocks[j]);
        }
    }
    group
}

fn build_normal_edit_row(
    block: &Block,
    card_root: &str,
    query_lower: &str,
    lang: UiLang,
) -> EditRow {
    let outside = is_outside_repo(&block.path, card_root);
    let chip = if outside {
        card_text(lang, &CardMsg::OutsideRepo)
    } else if !block.recorded {
        card_text(lang, &CardMsg::UnrecordedChip)
    } else {
        block
            .labels
            .first()
            .map(|lbl| label_chip(lang, lbl, block_kind(block)))
            .unwrap_or_default()
    };

    EditRow {
        seq: block.seq,
        file: last_path_segment(&block.path),
        symbol: format_symbol(block.symbol.as_ref()),
        chip,
        high: block.importance == Importance::High,
        matched: block_matches_query(block, query_lower),
        bash: None,
        tooltip: build_tooltip(std::slice::from_ref(&block), lang),
    }
}

fn build_format_collapse_row(group: &[&Block], query_lower: &str, lang: UiLang) -> EditRow {
    EditRow {
        seq: group[0].seq,
        file: String::new(),
        symbol: None,
        chip: card_text(lang, &CardMsg::FormatCollapse { n: group.len() }),
        high: group.iter().any(|b| b.importance == Importance::High),
        matched: group.iter().any(|b| block_matches_query(b, query_lower)),
        bash: None,
        tooltip: build_tooltip(group, lang),
    }
}

fn build_bash_group_row(
    group: &[&Block],
    raw_cmd: &str,
    query_lower: &str,
    lang: UiLang,
) -> EditRow {
    let uncertain = group
        .iter()
        .any(|b| b.bash.as_ref().is_some_and(|info| info.candidates > 1));
    let cmd = cut_to_limit(&sanitize_single_line(raw_cmd), CMD_MAX_CHARS);

    EditRow {
        seq: group[0].seq,
        file: String::new(),
        symbol: None,
        chip: String::new(),
        high: group.iter().any(|b| b.importance == Importance::High),
        matched: group.iter().any(|b| block_matches_query(b, query_lower)),
        bash: Some(BashRow {
            before: card_text(lang, &CardMsg::BashGroupBefore { n: group.len() }),
            cmd,
            after: card_text(lang, &CardMsg::BashGroupAfter),
            uncertain: uncertain.then(|| card_text(lang, &CardMsg::BashUncertain)),
        }),
        tooltip: build_tooltip(group, lang),
    }
}

fn build_tooltip(blocks: &[&Block], lang: UiLang) -> Vec<TooltipLine> {
    let mut lines = Vec::new();
    let push_unique = |out: &mut Vec<TooltipLine>, line: TooltipLine| {
        if !out.contains(&line) {
            out.push(line);
        }
    };

    for block in blocks {
        let kind = block_kind(block);
        for label in &block.labels {
            push_unique(&mut lines, TooltipLine::text(label_full(lang, label, kind)));
        }
    }

    for block in blocks {
        if let Some(quote) = &block.quote {
            let clean = sanitize_single_line(&quote.text);
            if !clean.is_empty() {
                push_unique(
                    &mut lines,
                    TooltipLine::text(cut_to_limit(&clean, QUOTE_MAX_CHARS)),
                );
            }
        }
    }

    for block in blocks {
        if block.via == BlockVia::Bash
            && let Some(bash) = &block.bash
        {
            let cmd = cut_to_limit(&sanitize_single_line(&bash.cmd), QUOTE_MAX_CHARS);
            push_unique(
                &mut lines,
                TooltipLine::with_code(card_text(lang, &CardMsg::ViaBash), cmd),
            );
        }
    }

    if blocks.iter().any(|b| !b.recorded) {
        push_unique(
            &mut lines,
            TooltipLine::text(card_text(lang, &CardMsg::UnrecordedTooltip)),
        );
    }

    if blocks
        .iter()
        .any(|b| b.symbol.as_ref().is_some_and(|s| s.exported))
    {
        push_unique(
            &mut lines,
            TooltipLine::text(card_text(lang, &CardMsg::ExportedTooltip)),
        );
    }

    lines
}

fn is_format_only_collapsible(block: &Block, card_root: &str) -> bool {
    block.recorded
        && block.via != BlockVia::Bash
        && !is_outside_repo(&block.path, card_root)
        && !block.labels.is_empty()
        && block
            .labels
            .iter()
            .all(|l| matches!(l, Label::FormatOnly {}))
}

fn block_kind(block: &Block) -> Option<SymbolKind> {
    block.symbol.as_ref().map(|s| s.kind)
}

fn format_symbol(symbol: Option<&BlockSymbol>) -> Option<String> {
    let sym = symbol?;
    let name = sanitize_single_line(&sym.name);
    if matches!(sym.kind, SymbolKind::Function | SymbolKind::Method) && !name.ends_with("()") {
        Some(format!("{name}()"))
    } else {
        Some(name)
    }
}

fn card_sort_key(card: &Card) -> u64 {
    card.ended_ms.unwrap_or(card.started_ms)
}

fn repo_name(card: &Card) -> Option<&str> {
    card.main_root
        .as_deref()
        .and_then(root_last_segment)
        .or_else(|| root_last_segment(&card.root))
}

fn root_last_segment(root: &str) -> Option<&str> {
    let seg = root.trim().split(['/', '\\']).rfind(|s| !s.is_empty())?;
    let bytes = seg.as_bytes();
    if bytes.len() == 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return None;
    }
    Some(seg)
}

fn last_path_segment(path: &str) -> String {
    let clean = sanitize_single_line(path);
    clean
        .split(['/', '\\'])
        .rfind(|s| !s.is_empty())
        .unwrap_or(&clean)
        .to_string()
}

fn card_matches_query(card: &Card, needle_lower: &str) -> bool {
    if repo_name(card).is_some_and(|name| name.to_lowercase().contains(needle_lower)) {
        return true;
    }
    card.blocks
        .iter()
        .any(|block| block_matches_query(block, needle_lower))
}

fn block_matches_query(block: &Block, needle_lower: &str) -> bool {
    !needle_lower.is_empty() && block.path.to_lowercase().contains(needle_lower)
}

fn first_non_empty_line(text: &str) -> &str {
    text.split('\n')
        .map(|l| l.trim_end_matches('\r').trim())
        .find(|l| !l.is_empty())
        .unwrap_or("")
}

fn sanitize_single_line(text: &str) -> String {
    text.replace("\r\n", " ").replace(['\r', '\n'], " ")
}

/// Keeps up to `max_chars` characters and appends `…` if truncated (up to `max_chars + 1` chars).
fn cut_with_ellipsis(text: &str, max_chars: usize) -> String {
    let mut chars = text.chars();
    let head: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        format!("{head}\u{2026}")
    } else {
        head
    }
}

/// Keeps the total output length at most `max_total` characters, using `…` when truncated.
fn cut_to_limit(text: &str, max_total: usize) -> String {
    if text.chars().count() <= max_total {
        return text.to_string();
    }
    let head: String = text.chars().take(max_total.saturating_sub(1)).collect();
    format!("{head}\u{2026}")
}

#[derive(Debug, PartialEq, Eq)]
enum PathRoot {
    Posix,
    Drive(char),
    Unc(String, String),
}

struct ParsedAbs {
    root: PathRoot,
    segments: Vec<String>,
}

impl ParsedAbs {
    fn parse(raw: &str) -> Option<Self> {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return None;
        }
        let slash = trimmed.replace('\\', "/");
        let unc_buf;
        let slash = if let Some(after_q) = slash.strip_prefix("//?/") {
            if after_q
                .as_bytes()
                .get(..4)
                .is_some_and(|b| b.eq_ignore_ascii_case(b"unc/"))
            {
                unc_buf = format!("//{}", &after_q[4..]);
                unc_buf.as_str()
            } else {
                after_q
            }
        } else {
            slash.as_str()
        };

        if let Some(rest) = slash.strip_prefix("//") {
            let mut parts = rest.split('/').filter(|s| !s.is_empty() && *s != ".");
            let server = parts.next()?.to_lowercase();
            let share = parts.next()?.to_lowercase();
            return Some(Self {
                root: PathRoot::Unc(server, share),
                segments: normalize_abs_segments(parts),
            });
        }
        let bytes = slash.as_bytes();
        if bytes.len() >= 2
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && slash[2..].starts_with('/')
        {
            let drive = bytes[0].to_ascii_uppercase() as char;
            let segments = normalize_abs_segments(slash[2..].split('/').filter(|s| !s.is_empty()));
            return Some(Self {
                root: PathRoot::Drive(drive),
                segments,
            });
        }
        if let Some(rest) = slash.strip_prefix('/') {
            return Some(Self {
                root: PathRoot::Posix,
                segments: normalize_abs_segments(rest.split('/').filter(|s| !s.is_empty())),
            });
        }
        None
    }

    fn starts_with(&self, base: &ParsedAbs) -> bool {
        if self.root != base.root || self.segments.len() < base.segments.len() {
            return false;
        }
        let ignore_case = !matches!(self.root, PathRoot::Posix);
        self.segments.iter().zip(&base.segments).all(|(a, b)| {
            if ignore_case {
                a.to_lowercase() == b.to_lowercase()
            } else {
                a == b
            }
        })
    }
}

fn normalize_abs_segments<'a>(parts: impl Iterator<Item = &'a str>) -> Vec<String> {
    let mut out = Vec::new();
    for part in parts {
        match part {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            seg => out.push(seg.to_string()),
        }
    }
    out
}

fn is_outside_repo(path: &str, card_root: &str) -> bool {
    let trimmed = path.trim();
    if trimmed.starts_with('~') {
        return true;
    }
    let Some(abs_path) = ParsedAbs::parse(trimmed) else {
        return escapes_relative_root(trimmed);
    };
    let Some(abs_root) = ParsedAbs::parse(card_root) else {
        return true;
    };
    !abs_path.starts_with(&abs_root)
}

fn escapes_relative_root(path: &str) -> bool {
    let mut depth: isize = 0;
    for part in path.split(['/', '\\']) {
        match part {
            "" | "." => {}
            ".." => {
                depth -= 1;
                if depth < 0 {
                    return true;
                }
            }
            _ => depth += 1,
        }
    }
    false
}

#[cfg(test)]
mod tests;
