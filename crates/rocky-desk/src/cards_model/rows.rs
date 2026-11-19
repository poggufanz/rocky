//! Single-line row shaping, grouping, tooltip formatting, and repo-root path checks.

use std::collections::HashMap;

use rocky_proto::cards::{
    Block, BlockSymbol, BlockVia, Card, Importance, Label, PromptKind, SymbolKind, classify_prompt,
};
use rocky_proto::translate::{QuoteLang, QuoteTranslation, quote_key};

use super::{BashRow, CardRow, EditRow, FileChip, TooltipLine};
use crate::clock::local_hhmm;
use crate::i18n::{CardMsg, UiLang, card_text, label_chip, label_full};

const TITLE_MAX_CHARS: usize = 80;
const QUOTE_MAX_CHARS: usize = 200;
const CMD_MAX_CHARS: usize = 80;
const MAX_EDIT_ROWS: usize = 3;
const MAX_FILE_CHIPS: usize = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BlockStatus {
    Normal,
    Unrecorded,
    OutsideRepo,
}

pub(super) fn build_card_row(
    card: &Card,
    indent: bool,
    query_lower: &str,
    lang: UiLang,
    translations: Option<&HashMap<String, QuoteTranslation>>,
) -> CardRow {
    let (display_prompt, _) = prompt_display(&card.prompt, lang);
    let first_line = sanitize_single_line(first_non_empty_line(&display_prompt));
    let raw_title = if !indent && !card.agent_type.is_empty() {
        format!(
            "{} \u{203a} {first_line}",
            sanitize_single_line(&card.agent_type)
        )
    } else {
        first_line
    };
    let title = cut_with_ellipsis(&raw_title, TITLE_MAX_CHARS);

    let time = sanitize_single_line(&local_hhmm(card_sort_key(card)));
    let (meta, meta_high) = build_meta(card, lang);
    let (mut edits, more) = build_edit_rows(card, query_lower, lang, translations);
    let meta = match hoist_shared_chip(&mut edits) {
        Some(chip) => format!("{meta} \u{00b7} {chip}"),
        None => meta,
    };
    let (files, files_more) = build_file_chips(card, query_lower, lang, translations);

    CardRow {
        card_id: card.card_id.clone(),
        indent,
        title,
        time,
        meta,
        meta_high,
        edits,
        more,
        files,
        files_more,
    }
}

/// Distinct files of a card in first-edit order, at most [`MAX_FILE_CHIPS`].
/// Two edits to one file make one chip that says ×2, not two rows.
fn build_file_chips(
    card: &Card,
    query_lower: &str,
    lang: UiLang,
    translations: Option<&HashMap<String, QuoteTranslation>>,
) -> (Vec<FileChip>, usize) {
    let mut order: Vec<&str> = Vec::new();
    for block in &card.blocks {
        if !order.contains(&block.path.as_str()) {
            order.push(block.path.as_str());
        }
    }
    let shown: Vec<&str> = order.iter().take(MAX_FILE_CHIPS).copied().collect();
    // Two different files with one name ("settings.json" twice) keep their
    // parent folder, so the chips do not read as a repeated edit.
    let name_of = |path: &str| {
        let name = last_path_segment(path);
        let clash = shown
            .iter()
            .filter(|p| **p != path && last_path_segment(p) == name)
            .count()
            > 0;
        if clash {
            let segs: Vec<&str> = path.split(['/', '\\']).filter(|s| !s.is_empty()).collect();
            segs[segs.len().saturating_sub(2)..].join("/")
        } else {
            name
        }
    };
    let chips = shown
        .iter()
        .map(|path| {
            let group: Vec<&Block> = card.blocks.iter().filter(|b| b.path == *path).collect();
            let mut tooltip = vec![TooltipLine::text(path)];
            tooltip.extend(build_tooltip(&group, lang, translations));
            FileChip {
                name: name_of(path),
                edits: u32::try_from(group.len()).unwrap_or(u32::MAX),
                high: group.iter().any(|b| b.importance == Importance::High),
                matched: !query_lower.is_empty()
                    && group.iter().any(|b| block_matches_query(b, query_lower)),
                tooltip,
            }
        })
        .collect();
    (chips, order.len().saturating_sub(MAX_FILE_CHIPS))
}

/// When every row carries the same plain chip ("outside repo" on each of
/// four edits), it says one thing about the card, not about each row: move
/// it to the meta line once. Important chips stay on their rows.
pub(super) fn hoist_shared_chip(edits: &mut [EditRow]) -> Option<String> {
    let first = edits.first()?.chip.clone();
    let shared =
        edits.len() >= 2 && !first.is_empty() && edits.iter().all(|e| e.chip == first && !e.high);
    if !shared {
        return None;
    }
    for e in edits.iter_mut() {
        e.chip.clear();
    }
    Some(first)
}

pub(super) fn card_sort_key(card: &Card) -> u64 {
    card.ended_ms.unwrap_or(card.started_ms)
}

pub(super) fn card_matches_query(card: &Card, needle_lower: &str) -> bool {
    if repo_name(card).is_some_and(|name| name.to_lowercase().contains(needle_lower)) {
        return true;
    }
    card.blocks
        .iter()
        .any(|block| block_matches_query(block, needle_lower))
}

/// Formats a card prompt for display and reports whether it is a background task notice.
pub(crate) fn prompt_display(prompt: &str, lang: UiLang) -> (String, bool) {
    match classify_prompt(prompt) {
        PromptKind::Plain => (prompt.to_string(), false),
        PromptKind::CrossSession => (card_text(lang, &CardMsg::CrossSessionPrompt), true),
        PromptKind::TaskNotification => (card_text(lang, &CardMsg::TaskNoticePrompt), true),
        PromptKind::SlashCommand { name, args } => {
            let text = if args.is_empty() {
                name
            } else {
                format!("{name} {args}")
            };
            (sanitize_single_line(&text), false)
        }
    }
}

pub(crate) fn sanitize_single_line(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\r' && chars.peek() == Some(&'\n') {
            chars.next();
            out.push(' ');
        } else if c.is_control() || matches!(c, '\u{2028}' | '\u{2029}') {
            out.push(' ');
        } else {
            out.push(c);
        }
    }
    out
}

fn build_meta(card: &Card, lang: UiLang) -> (String, Option<String>) {
    let mut parts = Vec::new();
    if let Some(name) = repo_name(card) {
        parts.push(name);
    }
    let total_edits = card.blocks.len().saturating_add(card.more_count as usize);
    parts.push(sanitize_single_line(&card_text(
        lang,
        &CardMsg::MetaEdits { n: total_edits },
    )));

    let high_count = card
        .blocks
        .iter()
        .filter(|b| b.importance == Importance::High)
        .count();
    let meta_high = (high_count > 0)
        .then(|| sanitize_single_line(&card_text(lang, &CardMsg::MetaImportant { n: high_count })));
    (parts.join(" \u{00b7} "), meta_high)
}

fn build_edit_rows(
    card: &Card,
    query_lower: &str,
    lang: UiLang,
    translations: Option<&HashMap<String, QuoteTranslation>>,
) -> (Vec<EditRow>, Option<String>) {
    let mut used = vec![false; card.blocks.len()];
    let mut grouped: Vec<(usize, EditRow)> = Vec::new();

    for i in 0..card.blocks.len() {
        if used[i] {
            continue;
        }
        let block = &card.blocks[i];

        if is_format_only_collapsible(block, &card.root) {
            let group = collect_group(&card.blocks, &mut used, i, |b| {
                is_format_only_collapsible(b, &card.root)
            });
            let row = build_format_collapse_row(&group, query_lower, lang, translations);
            grouped.push((group.len(), row));
        } else if block.via == BlockVia::Bash
            && let Some(info) = &block.bash
        {
            let target_cmd = info.cmd.as_str();
            let target_status = block_status(block, &card.root);
            let group = collect_group(&card.blocks, &mut used, i, |b| {
                b.via == BlockVia::Bash
                    && b.bash.as_ref().is_some_and(|other| other.cmd == target_cmd)
                    && block_status(b, &card.root) == target_status
            });
            let row = build_bash_group_row(
                &group,
                target_cmd,
                target_status,
                query_lower,
                lang,
                translations,
            );
            grouped.push((group.len(), row));
        } else {
            used[i] = true;
            let row = build_normal_edit_row(block, &card.root, query_lower, lang, translations);
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
    let more = (remaining > 0)
        .then(|| sanitize_single_line(&card_text(lang, &CardMsg::MoreEdits { n: remaining })));
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

pub(crate) fn block_status(block: &Block, card_root: &str) -> BlockStatus {
    if is_outside_repo(&block.path, card_root) {
        BlockStatus::OutsideRepo
    } else if !block.recorded {
        BlockStatus::Unrecorded
    } else {
        BlockStatus::Normal
    }
}

pub(crate) fn status_chip(status: BlockStatus, lang: UiLang) -> Option<String> {
    match status {
        BlockStatus::OutsideRepo => Some(card_text(lang, &CardMsg::OutsideRepo)),
        BlockStatus::Unrecorded => Some(card_text(lang, &CardMsg::UnrecordedChip)),
        BlockStatus::Normal => None,
    }
}

fn build_normal_edit_row(
    block: &Block,
    card_root: &str,
    query_lower: &str,
    lang: UiLang,
    translations: Option<&HashMap<String, QuoteTranslation>>,
) -> EditRow {
    let raw_chip = status_chip(block_status(block, card_root), lang).unwrap_or_else(|| {
        block
            .labels
            .first()
            .map(|lbl| label_chip(lang, lbl, block_kind(block)))
            .unwrap_or_default()
    });

    EditRow {
        seq: block.seq,
        file: last_path_segment(&block.path),
        symbol: format_symbol(block.symbol.as_ref()),
        chip: sanitize_single_line(&raw_chip),
        high: block.importance == Importance::High,
        matched: block_matches_query(block, query_lower),
        bash: None,
        tooltip: build_tooltip(std::slice::from_ref(&block), lang, translations),
    }
}

fn build_format_collapse_row(
    group: &[&Block],
    query_lower: &str,
    lang: UiLang,
    translations: Option<&HashMap<String, QuoteTranslation>>,
) -> EditRow {
    EditRow {
        seq: group[0].seq,
        file: String::new(),
        symbol: None,
        chip: sanitize_single_line(&card_text(
            lang,
            &CardMsg::FormatCollapse { n: group.len() },
        )),
        high: group.iter().any(|b| b.importance == Importance::High),
        matched: group.iter().any(|b| block_matches_query(b, query_lower)),
        bash: None,
        tooltip: build_tooltip(group, lang, translations),
    }
}

fn build_bash_group_row(
    group: &[&Block],
    raw_cmd: &str,
    status: BlockStatus,
    query_lower: &str,
    lang: UiLang,
    translations: Option<&HashMap<String, QuoteTranslation>>,
) -> EditRow {
    let uncertain = group
        .iter()
        .any(|b| b.bash.as_ref().is_some_and(|info| info.candidates > 1));
    let cmd = cut_to_limit(&sanitize_single_line(raw_cmd), CMD_MAX_CHARS);
    let chip = status_chip(status, lang)
        .map(|c| sanitize_single_line(&c))
        .unwrap_or_default();

    EditRow {
        seq: group[0].seq,
        file: String::new(),
        symbol: None,
        chip,
        high: group.iter().any(|b| b.importance == Importance::High),
        matched: group.iter().any(|b| block_matches_query(b, query_lower)),
        bash: Some(BashRow {
            before: sanitize_single_line(&card_text(
                lang,
                &CardMsg::BashGroupBefore { n: group.len() },
            )),
            cmd,
            after: sanitize_single_line(&card_text(lang, &CardMsg::BashGroupAfter)),
            uncertain: uncertain
                .then(|| sanitize_single_line(&card_text(lang, &CardMsg::BashUncertain))),
        }),
        tooltip: build_tooltip(group, lang, translations),
    }
}

fn build_tooltip(
    blocks: &[&Block],
    lang: UiLang,
    translations: Option<&HashMap<String, QuoteTranslation>>,
) -> Vec<TooltipLine> {
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

    let mut translated_quotes = Vec::new();
    let mut original_quotes = Vec::new();
    let mut translated_from: Option<QuoteLang> = None;
    for block in blocks {
        if let Some(quote) = &block.quote {
            let tr = translations
                .and_then(|map| map.get(&quote_key(&quote.text)))
                .and_then(|tr| {
                    let clean = sanitize_single_line(&crate::plain_text::plain_quote(&tr.text));
                    (!clean.trim().is_empty()).then_some((clean, tr.from))
                });
            match tr {
                Some((clean, from)) => {
                    translated_from = Some(from);
                    push_unique(
                        &mut translated_quotes,
                        TooltipLine::text(cut_to_limit(&clean, QUOTE_MAX_CHARS)),
                    );
                }
                None => {
                    let clean = sanitize_single_line(&crate::plain_text::plain_quote(&quote.text));
                    if !clean.is_empty() {
                        push_unique(
                            &mut original_quotes,
                            TooltipLine::text(cut_to_limit(&clean, QUOTE_MAX_CHARS)),
                        );
                    }
                }
            }
        }
    }
    for line in translated_quotes {
        push_unique(&mut lines, line);
    }
    if let Some(from) = translated_from {
        push_unique(
            &mut lines,
            TooltipLine::text(card_text(lang, &CardMsg::TranslatedFrom { from })),
        );
    }
    for line in original_quotes {
        push_unique(&mut lines, line);
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

pub(crate) fn block_kind(block: &Block) -> Option<SymbolKind> {
    block.symbol.as_ref().map(|s| s.kind)
}

pub(crate) fn format_symbol(symbol: Option<&BlockSymbol>) -> Option<String> {
    let sym = symbol?;
    let name = sanitize_single_line(&sym.name);
    if matches!(sym.kind, SymbolKind::Function | SymbolKind::Method) && !name.ends_with("()") {
        Some(format!("{name}()"))
    } else {
        Some(name)
    }
}

pub(crate) fn repo_name(card: &Card) -> Option<String> {
    card.main_root
        .as_deref()
        .and_then(root_last_segment)
        .or_else(|| root_last_segment(&card.root))
}

fn root_last_segment(root: &str) -> Option<String> {
    let seg = root.trim().split(['/', '\\']).rfind(|s| !s.is_empty())?;
    let bytes = seg.as_bytes();
    if bytes.len() == 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return None;
    }
    Some(sanitize_single_line(seg))
}

pub(crate) fn last_path_segment(path: &str) -> String {
    let clean = sanitize_single_line(path);
    clean
        .split(['/', '\\'])
        .rfind(|s| !s.is_empty())
        .unwrap_or(&clean)
        .to_string()
}

fn block_matches_query(block: &Block, needle_lower: &str) -> bool {
    !needle_lower.is_empty() && block.path.to_lowercase().contains(needle_lower)
}

pub(crate) fn first_non_empty_line(text: &str) -> &str {
    text.split(['\r', '\n'])
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("")
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
pub(crate) fn cut_to_limit(text: &str, max_total: usize) -> String {
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
