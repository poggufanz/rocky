//! Card detail assembly, list capping, and paged unified block diffing.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};

use rocky_facts::{
    FileInput, Side, SnippetLine as FactSnippetLine, Symbol as FactSymbol,
    SymbolKind as FactSymbolKind, snippets,
};
use rocky_proto::cards::{
    Block, BlockSymbol, Card, CoverageReason, CoverageState, Label, SymbolKind as ProtoSymbolKind,
};
use rocky_proto::paths::{listening_store_dir, repo_id};
use rocky_proto::pipe::{
    BlockSnippet, DiffLine, DiffLineKind, LINE_CAP, ServerMsg, SnippetLine, encode,
};
use similar::{ChangeTag, TextDiff};

use crate::cards::store::{ObjectRead, read_object};

/// Maximum number of cards returned in a single `Cards` page reply.
pub const MAX_CARD_LIST_LIMIT: usize = 20;

/// Maximum Unicode scalar characters kept in a block's quote inside list replies.
pub const LIST_QUOTE_MAX_CHARS: usize = 200;

/// Maximum number of blocks in a `CardDetail` reply that carry code snippets.
pub const MAX_DETAIL_CODE_BLOCKS: usize = 20;

/// Maximum serialized JSON bytes of `DiffLine` entries per `BlockDiff` page.
pub const DIFF_PAGE_BYTES: usize = 48 * 1024;

/// Maximum serialized JSON bytes kept in a single emitted `DiffLine` before wrapping onto the next line.
const MAX_SINGLE_LINE_BYTES: usize = 16 * 1024;

/// Formats the opaque pagination cursor `<key_ms>:<card_id>` for `card`.
pub fn card_cursor(card: &Card) -> String {
    let key_ms = card.ended_ms.unwrap_or(card.started_ms);
    format!("{key_ms}:{}", card.card_id)
}

/// Truncates list-view fields on a card (block `quote.text` capped to 200 chars).
pub fn prepare_list_card(card: &mut Card) {
    for block in &mut card.blocks {
        if let Some(quote) = &mut block.quote {
            truncate_chars_in_place(&mut quote.text, LIST_QUOTE_MAX_CHARS);
        }
    }
}

/// Builds a `ServerMsg::Cards` reply that fits within `LINE_CAP`.
pub fn build_cards_reply(id: u64, mut items: Vec<Card>, mut next: Option<String>) -> ServerMsg {
    if items.len() > MAX_CARD_LIST_LIMIT {
        items.truncate(MAX_CARD_LIST_LIMIT);
        next = items.last().map(card_cursor);
    }
    for card in &mut items {
        prepare_list_card(card);
    }

    let mut msg = ServerMsg::Cards { id, items, next };
    if encode(&msg).len() <= LINE_CAP {
        return msg;
    }

    // Step 1: Trim flow steps proportionally before touching blocks or dropping cards.
    shrink_cards_vec_field(&mut msg, CardTrimField::Flow);
    if encode(&msg).len() <= LINE_CAP {
        return msg;
    }

    // Step 2: Trim blocks proportionally before dropping whole cards from the page.
    shrink_cards_vec_field(&mut msg, CardTrimField::Blocks);
    if encode(&msg).len() <= LINE_CAP {
        return msg;
    }

    // Step 3: Truncate or clear prompts before dropping trailing cards.
    if let ServerMsg::Cards { ref mut items, .. } = msg {
        for card in items.iter_mut() {
            if truncate_chars_in_place(&mut card.prompt, LIST_QUOTE_MAX_CHARS) {
                card.prompt_truncated = true;
            }
        }
    }
    if encode(&msg).len() <= LINE_CAP {
        return msg;
    }
    if let ServerMsg::Cards { ref mut items, .. } = msg {
        for card in items.iter_mut() {
            if !card.prompt.is_empty() {
                card.prompt.clear();
                card.prompt_truncated = true;
            }
        }
    }
    if encode(&msg).len() <= LINE_CAP {
        return msg;
    }

    // Step 4: Drop trailing cards only while more than one card remains on the page.
    while let ServerMsg::Cards {
        items: ref mut list,
        next: ref mut cursor,
        ..
    } = msg
    {
        if list.len() <= 1 || encode_len_cards(id, list, cursor.as_deref()) <= LINE_CAP {
            break;
        }
        list.pop();
        *cursor = list.last().map(card_cursor);
    }
    if encode(&msg).len() <= LINE_CAP {
        return msg;
    }

    // Step 5: Never silently drop the last remaining card; collapse oversized metadata fields.
    if let ServerMsg::Cards { ref mut items, .. } = msg
        && let Some(card) = items.first_mut()
    {
        card.main_root = None;
        card.branch = None;
        card.parent_card_id = None;
    }
    if encode(&msg).len() > LINE_CAP
        && let ServerMsg::Cards { ref mut items, .. } = msg
        && let Some(card) = items.first_mut()
    {
        truncate_chars_in_place(&mut card.root, LIST_QUOTE_MAX_CHARS);
        truncate_chars_in_place(&mut card.session_id, LIST_QUOTE_MAX_CHARS);
        truncate_chars_in_place(&mut card.agent_id, LIST_QUOTE_MAX_CHARS);
        truncate_chars_in_place(&mut card.agent_type, LIST_QUOTE_MAX_CHARS);
    }
    if encode(&msg).len() > LINE_CAP
        && let ServerMsg::Cards { ref mut items, .. } = msg
        && let Some(card) = items.first_mut()
    {
        card.root.clear();
        card.coverage.reasons.clear();
        truncate_chars_in_place(&mut card.card_id, LIST_QUOTE_MAX_CHARS);
        truncate_chars_in_place(&mut card.repo_id, LIST_QUOTE_MAX_CHARS);
    }
    msg
}

#[derive(Clone, Copy)]
enum CardTrimField {
    Flow,
    Blocks,
}

fn encode_len_cards(id: u64, items: &[Card], next: Option<&str>) -> usize {
    let probe = ServerMsg::Cards {
        id,
        items: items.to_vec(),
        next: next.map(str::to_string),
    };
    encode(&probe).len()
}

fn shrink_cards_vec_field(msg: &mut ServerMsg, field: CardTrimField) {
    let ServerMsg::Cards { id, items, next } = msg else {
        unreachable!();
    };
    enum Saved {
        Flow(Vec<Vec<rocky_proto::cards::FlowStep>>, Vec<u32>),
        Blocks(Vec<Vec<Block>>, Vec<u32>),
    }
    let (max_len, saved) = match field {
        CardTrimField::Flow => {
            let max_len = items.iter().map(|c| c.flow.len()).max().unwrap_or(0);
            if max_len == 0 {
                return;
            }
            let flows: Vec<_> = items.iter_mut().map(|c| std::mem::take(&mut c.flow)).collect();
            let base_more: Vec<u32> = items.iter().map(|c| c.flow_more).collect();
            for (c, orig) in items.iter_mut().zip(&flows) {
                c.flow_more = c.flow_more.saturating_add(u32::try_from(orig.len()).unwrap_or(u32::MAX));
            }
            (max_len, Saved::Flow(flows, base_more))
        }
        CardTrimField::Blocks => {
            let max_len = items.iter().map(|c| c.blocks.len()).max().unwrap_or(0);
            if max_len == 0 {
                return;
            }
            let blks: Vec<_> = items.iter_mut().map(|c| std::mem::take(&mut c.blocks)).collect();
            let base_more: Vec<u32> = items.iter().map(|c| c.more_count).collect();
            for (c, orig) in items.iter_mut().zip(&blks) {
                c.more_count = c.more_count.saturating_add(u32::try_from(orig.len()).unwrap_or(u32::MAX));
            }
            (max_len, Saved::Blocks(blks, base_more))
        }
    };

    if encode_len_cards(*id, items, next.as_deref()) > LINE_CAP {
        return;
    }

    let apply_cap = |cards: &mut [Card], saved: &Saved, cap: usize| match saved {
        Saved::Flow(flows, base_more) => {
            for ((card, orig), &base) in cards.iter_mut().zip(flows).zip(base_more) {
                let keep = orig.len().min(cap);
                card.flow = orig[..keep].to_vec();
                card.flow_more =
                    base.saturating_add(u32::try_from(orig.len() - keep).unwrap_or(u32::MAX));
            }
        }
        Saved::Blocks(blks, base_more) => {
            for ((card, orig), &base) in cards.iter_mut().zip(blks).zip(base_more) {
                let keep = orig.len().min(cap);
                card.blocks = orig[..keep].to_vec();
                card.more_count =
                    base.saturating_add(u32::try_from(orig.len() - keep).unwrap_or(u32::MAX));
            }
        }
    };

    let mut lo = 0usize;
    let mut hi = max_len;
    while lo < hi {
        let mid = lo + (hi - lo).div_ceil(2);
        apply_cap(items, &saved, mid);
        if encode_len_cards(*id, items, next.as_deref()) <= LINE_CAP {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    apply_cap(items, &saved, lo);
}

/// Builds a live `ServerMsg::Card` broadcast message that fits within `LINE_CAP`,
/// or `None` when the remaining metadata still exceeds `LINE_CAP`.
pub fn build_card_broadcast(mut item: Card) -> Option<ServerMsg> {
    prepare_list_card(&mut item);
    let mut msg = ServerMsg::Card { item };
    shrink_card_msg(&mut msg).then_some(msg)
}

/// Builds a `ServerMsg::CardDetail` reply reading Listening objects from `home`.
pub fn build_card_detail(id: u64, card: &Card, home: &Path) -> ServerMsg {
    let store_dir = card_store_dir(card, home);
    build_card_detail_with(id, card, |sha| match store_dir.as_deref() {
        Some(dir) => read_object(dir, sha),
        None => ObjectRead::Missing,
    })
}

/// Testable core of [`build_card_detail`] taking an explicit object reader.
pub fn build_card_detail_with<F>(id: u64, card: &Card, mut read_obj: F) -> ServerMsg
where
    F: FnMut(&str) -> ObjectRead,
{
    let selected: Vec<usize> = card
        .blocks
        .iter()
        .enumerate()
        .filter(|(_, b)| block_is_codable(b))
        .take(MAX_DETAIL_CODE_BLOCKS)
        .map(|(idx, _)| idx)
        .collect();

    // Cache every object read by SHA so files edited across multiple blocks are read once.
    let mut objects: HashMap<String, ObjectRead> = HashMap::new();
    for &idx in &selected {
        let b = &card.blocks[idx];
        for sha in [&b.before, &b.after].into_iter().flatten() {
            if !objects.contains_key(sha) {
                objects.insert(sha.clone(), read_obj(sha));
            }
        }
    }

    // Group valid selected blocks by (path, before, after, absent flags) so `rocky_facts::snippets`
    // runs once per distinct file version pair while failed reads suppress snippets and update coverage.
    type GroupKey<'a> = (&'a str, Option<&'a str>, Option<&'a str>, bool, bool);
    let mut group_order: Vec<(GroupKey<'_>, Vec<usize>)> = Vec::new();
    let mut group_index: HashMap<GroupKey<'_>, usize> = HashMap::new();
    let mut extra_reasons: BTreeSet<CoverageReason> = BTreeSet::new();

    for &idx in &selected {
        let b = &card.blocks[idx];
        let is_new = b.labels.iter().any(|l| matches!(l, Label::FileNew {}));
        let is_deleted = b.labels.iter().any(|l| matches!(l, Label::FileDeleted {}));
        let before_res = resolve_checked_side(b.before.as_deref(), is_new, &objects);
        let after_res = resolve_checked_side(b.after.as_deref(), is_deleted, &objects);

        let mut failed = false;
        for res in [&before_res, &after_res] {
            match res {
                SideResolution::Side(_) => {}
                SideResolution::MissingOrInvalid => {
                    extra_reasons.insert(CoverageReason::CaptureOff);
                    failed = true;
                }
                SideResolution::TooLarge => {
                    extra_reasons.insert(CoverageReason::TooLarge);
                    failed = true;
                }
            }
        }
        if failed {
            continue;
        }

        let (SideResolution::Side(before_side), SideResolution::Side(after_side)) =
            (before_res, after_res)
        else {
            unreachable!();
        };
        if !matches!(before_side, Side::Text(_)) && !matches!(after_side, Side::Text(_)) {
            continue;
        }

        let key: GroupKey<'_> = (
            b.path.as_str(),
            b.before.as_deref(),
            b.after.as_deref(),
            b.before.is_none() && is_new,
            b.after.is_none() && is_deleted,
        );
        if let Some(&pos) = group_index.get(&key) {
            group_order[pos].1.push(idx);
        } else {
            let pos = group_order.len();
            group_index.insert(key, pos);
            group_order.push((key, vec![idx]));
        }
    }

    let mut per_block: Vec<Option<BlockSnippet>> = vec![None; card.blocks.len()];
    for ((path, before_sha, after_sha, before_absent, after_absent), block_indices) in group_order {
        let SideResolution::Side(before_side) =
            resolve_checked_side(before_sha, before_absent, &objects)
        else {
            unreachable!();
        };
        let SideResolution::Side(after_side) =
            resolve_checked_side(after_sha, after_absent, &objects)
        else {
            unreachable!();
        };

        let converted_syms: Vec<Option<FactSymbol>> = block_indices
            .iter()
            .map(|&i| card.blocks[i].symbol.as_ref().map(to_fact_symbol))
            .collect();
        let sym_refs: Vec<Option<&FactSymbol>> =
            converted_syms.iter().map(|s| s.as_ref()).collect();

        let rendered = snippets(
            &FileInput {
                path,
                before: before_side,
                after: after_side,
            },
            &sym_refs,
        );

        for (block_idx, lines) in block_indices.into_iter().zip(rendered) {
            if lines.is_empty() {
                continue;
            }
            per_block[block_idx] = Some(BlockSnippet {
                seq: card.blocks[block_idx].seq,
                lines: lines.into_iter().map(to_wire_snippet_line).collect(),
            });
        }
    }

    let mut reply_card = card.clone();
    if !extra_reasons.is_empty() {
        let mut all_reasons: BTreeSet<CoverageReason> =
            reply_card.coverage.reasons.iter().copied().collect();
        all_reasons.extend(extra_reasons);
        reply_card.coverage.reasons = all_reasons.into_iter().collect();
        reply_card.coverage.state = CoverageState::Partial;
    }

    let snippets: Vec<BlockSnippet> = per_block.into_iter().flatten().collect();
    let mut msg = ServerMsg::CardDetail {
        id,
        card: reply_card,
        snippets,
    };
    if shrink_card_msg(&mut msg) {
        msg
    } else {
        error_ack(id, "too_large")
    }
}

/// Builds a paged `ServerMsg::BlockDiff` reply reading Listening objects from `home`.
pub fn build_block_diff(id: u64, card: &Card, seq: u32, page: u32, home: &Path) -> ServerMsg {
    let store_dir = card_store_dir(card, home);
    build_block_diff_with(id, card, seq, page, |sha| match store_dir.as_deref() {
        Some(dir) => read_object(dir, sha),
        None => ObjectRead::Missing,
    })
}

/// Testable core of [`build_block_diff`] taking an explicit object reader.
pub fn build_block_diff_with<F>(
    id: u64,
    card: &Card,
    seq: u32,
    page: u32,
    mut read_obj: F,
) -> ServerMsg
where
    F: FnMut(&str) -> ObjectRead,
{
    let Some(block) = card.blocks.iter().find(|b| b.seq == seq) else {
        return missing_diff(id);
    };
    if !block.recorded {
        return missing_diff(id);
    }

    let is_new = block.labels.iter().any(|l| matches!(l, Label::FileNew {}));
    let is_deleted = block
        .labels
        .iter()
        .any(|l| matches!(l, Label::FileDeleted {}));

    let Some(before_text) = resolve_diff_text(block.before.as_deref(), is_new, &mut read_obj)
    else {
        return missing_diff(id);
    };
    let Some(after_text) = resolve_diff_text(block.after.as_deref(), is_deleted, &mut read_obj)
    else {
        return missing_diff(id);
    };

    let before_norm = before_text.replace("\r\n", "\n");
    let after_norm = after_text.replace("\r\n", "\n");
    let diff = TextDiff::from_lines(&before_norm, &after_norm);

    let mut all_lines = Vec::new();
    for change in diff.iter_all_changes() {
        let kind = match change.tag() {
            ChangeTag::Equal => DiffLineKind::Context,
            ChangeTag::Insert => DiffLineKind::Added,
            ChangeTag::Delete => DiffLineKind::Removed,
        };
        let raw = change.as_str().unwrap_or_default();
        let line_text = raw.strip_suffix('\n').unwrap_or(raw);
        push_chunked_diff_lines(&mut all_lines, kind, line_text);
    }

    let pages_vec = paginate_diff_lines(all_lines);
    let total_pages = u32::try_from(pages_vec.len()).unwrap_or(u32::MAX);
    let lines = pages_vec.into_iter().nth(page as usize).unwrap_or_default();

    let msg = ServerMsg::BlockDiff {
        id,
        lines,
        page,
        pages: total_pages,
        missing: false,
    };
    if encode(&msg).len() > LINE_CAP {
        return error_ack(id, "too_large");
    }
    msg
}

fn error_ack(id: u64, code: &str) -> ServerMsg {
    ServerMsg::Ack {
        id,
        ok: false,
        error: Some(code.to_string()),
        cleanup_errors: 0,
    }
}

fn missing_diff(id: u64) -> ServerMsg {
    ServerMsg::BlockDiff {
        id,
        lines: Vec::new(),
        page: 0,
        pages: 0,
        missing: true,
    }
}

fn card_store_dir(card: &Card, home: &Path) -> Option<PathBuf> {
    if card.root.is_empty() {
        return None;
    }
    let rid = repo_id(&card.root, cfg!(windows));
    Some(listening_store_dir(home, &rid))
}

fn block_is_codable(block: &Block) -> bool {
    block.recorded && (block.before.is_some() || block.after.is_some())
}

fn msg_card_mut(msg: &mut ServerMsg) -> &mut Card {
    match msg {
        ServerMsg::Card { item } => item,
        ServerMsg::CardDetail { card, .. } => card,
        _ => unreachable!(),
    }
}

fn shrink_card_msg(msg: &mut ServerMsg) -> bool {
    if encode(msg).len() <= LINE_CAP {
        return true;
    }

    // Step 1: Trim flow steps first (preserving blocks and code snippets when flow causes overflow).
    let (saved_flow, base_flow_more) = {
        let card = msg_card_mut(msg);
        (std::mem::take(&mut card.flow), card.flow_more)
    };
    if !saved_flow.is_empty() {
        let orig_len = saved_flow.len();
        msg_card_mut(msg).flow_more =
            base_flow_more.saturating_add(u32::try_from(orig_len).unwrap_or(u32::MAX));
        if encode(msg).len() <= LINE_CAP {
            let mut lo = 0usize;
            let mut hi = orig_len;
            while lo < hi {
                let mid = lo + (hi - lo).div_ceil(2);
                let card = msg_card_mut(msg);
                card.flow = saved_flow[..mid].to_vec();
                card.flow_more = base_flow_more
                    .saturating_add(u32::try_from(orig_len - mid).unwrap_or(u32::MAX));
                if encode(msg).len() <= LINE_CAP {
                    lo = mid;
                } else {
                    hi = mid - 1;
                }
            }
            let card = msg_card_mut(msg);
            card.flow = saved_flow[..lo].to_vec();
            card.flow_more = base_flow_more
                .saturating_add(u32::try_from(orig_len - lo).unwrap_or(u32::MAX));
            return true;
        }
    }

    // Step 2: Trim detail snippets before dropping block summaries.
    if matches!(msg, ServerMsg::CardDetail { .. }) {
        loop {
            let popped = {
                let ServerMsg::CardDetail { snippets, .. } = msg else {
                    unreachable!();
                };
                snippets.pop()
            };
            if popped.is_none() {
                break;
            }
            if encode(msg).len() <= LINE_CAP {
                return true;
            }
        }
    }

    // Step 3: Trim blocks, tracking dropped items in `more_count`.
    loop {
        let popped = msg_card_mut(msg).blocks.pop();
        if popped.is_none() {
            break;
        }
        let card = msg_card_mut(msg);
        card.more_count = card.more_count.saturating_add(1);
        if encode(msg).len() <= LINE_CAP {
            return true;
        }
    }

    // Step 4: Truncate prompt to list-quote bound as last resort.
    {
        let card = msg_card_mut(msg);
        if truncate_chars_in_place(&mut card.prompt, LIST_QUOTE_MAX_CHARS) {
            card.prompt_truncated = true;
        }
    }
    encode(msg).len() <= LINE_CAP
}

enum SideResolution<'a> {
    Side(Side<'a>),
    MissingOrInvalid,
    TooLarge,
}

fn resolve_checked_side<'a>(
    sha: Option<&str>,
    absent_allowed: bool,
    objects: &'a HashMap<String, ObjectRead>,
) -> SideResolution<'a> {
    match sha {
        Some(hash) => match objects.get(hash) {
            Some(ObjectRead::Text(text)) => SideResolution::Side(Side::Text(text.as_str())),
            Some(ObjectRead::TooLarge) => SideResolution::TooLarge,
            Some(ObjectRead::Missing | ObjectRead::Invalid) | None => {
                SideResolution::MissingOrInvalid
            }
        },
        None => {
            if absent_allowed {
                SideResolution::Side(Side::Absent)
            } else {
                SideResolution::Side(Side::Unknown)
            }
        }
    }
}

fn resolve_diff_text<F>(sha: Option<&str>, absent_allowed: bool, read_obj: &mut F) -> Option<String>
where
    F: FnMut(&str) -> ObjectRead,
{
    match sha {
        Some(hash) => match read_obj(hash) {
            ObjectRead::Text(text) => Some(text),
            ObjectRead::Missing | ObjectRead::TooLarge | ObjectRead::Invalid => None,
        },
        None => absent_allowed.then(String::new),
    }
}

fn to_fact_symbol(sym: &BlockSymbol) -> FactSymbol {
    FactSymbol {
        kind: match sym.kind {
            ProtoSymbolKind::Function => FactSymbolKind::Function,
            ProtoSymbolKind::Method => FactSymbolKind::Method,
            ProtoSymbolKind::Class => FactSymbolKind::Class,
            ProtoSymbolKind::Struct => FactSymbolKind::Struct,
            ProtoSymbolKind::Enum => FactSymbolKind::Enum,
            ProtoSymbolKind::Trait => FactSymbolKind::Trait,
            ProtoSymbolKind::Interface => FactSymbolKind::Interface,
            ProtoSymbolKind::Type => FactSymbolKind::Type,
            ProtoSymbolKind::Const => FactSymbolKind::Const,
            ProtoSymbolKind::Test => FactSymbolKind::Test,
            ProtoSymbolKind::Key => FactSymbolKind::Key,
        },
        name: sym.name.clone(),
        container: sym.container.clone(),
        exported: sym.exported,
        nth: sym.nth,
    }
}

fn to_wire_snippet_line(line: FactSnippetLine) -> SnippetLine {
    match line {
        FactSnippetLine::Context { text } => SnippetLine::Context { text },
        FactSnippetLine::Added { text } => SnippetLine::Added { text },
        FactSnippetLine::Removed { text } => SnippetLine::Removed { text },
        FactSnippetLine::Fold { lines } => SnippetLine::Fold { lines },
        FactSnippetLine::More { lines } => SnippetLine::More { lines },
    }
}

fn truncate_chars_in_place(text: &mut String, max_chars: usize) -> bool {
    if let Some((byte_idx, _)) = text.char_indices().nth(max_chars) {
        text.truncate(byte_idx);
        true
    } else {
        false
    }
}

fn json_escaped_char_len(ch: char) -> usize {
    match ch {
        '"' | '\\' | '\x08' | '\x0c' | '\n' | '\r' | '\t' => 2,
        c if (c as u32) < 0x20 => 6,
        c => c.len_utf8(),
    }
}

fn diff_line_wrapper_bytes(kind: DiffLineKind) -> usize {
    match kind {
        DiffLineKind::Context => r#"{"kind":"context","text":""}"#.len(),
        DiffLineKind::Added => r#"{"kind":"added","text":""}"#.len(),
        DiffLineKind::Removed => r#"{"kind":"removed","text":""}"#.len(),
    }
}

fn push_chunked_diff_lines(out: &mut Vec<DiffLine>, kind: DiffLineKind, text: &str) {
    let limit = MAX_SINGLE_LINE_BYTES.min(DIFF_PAGE_BYTES - 2);
    push_chunked_diff_lines_with_limit(out, kind, text, limit);
}

fn push_chunked_diff_lines_with_limit(
    out: &mut Vec<DiffLine>,
    kind: DiffLineKind,
    mut text: &str,
    max_elem_bytes: usize,
) {
    let wrapper = diff_line_wrapper_bytes(kind);
    let est_total = wrapper + text.chars().map(json_escaped_char_len).sum::<usize>();
    if est_total <= max_elem_bytes {
        let candidate = DiffLine {
            kind,
            text: text.to_string(),
        };
        let exact = serde_json::to_string(&candidate)
            .map(|s| s.len())
            .unwrap_or(usize::MAX);
        if exact <= max_elem_bytes {
            out.push(candidate);
            return;
        }
    }

    while !text.is_empty() {
        let mut acc = wrapper;
        let mut split_at = 0usize;
        for (idx, ch) in text.char_indices() {
            let next = acc + json_escaped_char_len(ch);
            if next > max_elem_bytes && split_at > 0 {
                break;
            }
            acc = next;
            split_at = idx + ch.len_utf8();
        }
        if split_at == 0 {
            split_at = text.chars().next().map(char::len_utf8).unwrap_or(0);
        }

        let mut end = split_at;
        loop {
            let candidate = DiffLine {
                kind,
                text: text[..end].to_string(),
            };
            let exact = serde_json::to_string(&candidate)
                .map(|s| s.len())
                .unwrap_or(usize::MAX);
            if exact <= max_elem_bytes {
                out.push(candidate);
                text = &text[end..];
                break;
            }
            let Some((prev_idx, _)) = text[..end].char_indices().next_back() else {
                out.push(candidate);
                text = &text[end..];
                break;
            };
            if prev_idx == 0 {
                out.push(candidate);
                text = &text[end..];
                break;
            }
            end = prev_idx;
        }
    }
}

fn paginate_diff_lines(all_lines: Vec<DiffLine>) -> Vec<Vec<DiffLine>> {
    if all_lines.is_empty() {
        return vec![Vec::new()];
    }
    let max_elem_bytes = DIFF_PAGE_BYTES - 2;
    let mut bounded = Vec::with_capacity(all_lines.len());
    for line in all_lines {
        let elem_bytes = serde_json::to_string(&line)
            .map(|s| s.len())
            .unwrap_or(usize::MAX);
        if elem_bytes <= max_elem_bytes {
            bounded.push(line);
        } else {
            push_chunked_diff_lines_with_limit(&mut bounded, line.kind, &line.text, max_elem_bytes);
        }
    }

    let mut pages = Vec::new();
    let mut cur: Vec<DiffLine> = Vec::new();
    let mut cur_bytes = 2usize; // JSON array `[` + `]`

    for line in bounded {
        let elem_bytes = serde_json::to_string(&line).map(|s| s.len()).unwrap_or(0);
        let sep = usize::from(!cur.is_empty());
        if !cur.is_empty() && cur_bytes + sep + elem_bytes > DIFF_PAGE_BYTES {
            pages.push(std::mem::take(&mut cur));
            cur_bytes = 2 + elem_bytes;
            cur.push(line);
        } else {
            cur_bytes += sep + elem_bytes;
            cur.push(line);
        }
    }
    if !cur.is_empty() {
        pages.push(cur);
    }
    pages
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use rocky_proto::cards::{
        Block, BlockSymbol, BlockVia, CARD_VERSION, Card, CardStatus, Coverage, CoverageReason,
        CoverageState, FlowKind, FlowStep, Importance, Label, Quote, SymbolKind,
    };
    use rocky_proto::pipe::{LINE_CAP, ServerMsg, encode};

    use super::*;

    fn test_block(
        seq: u32,
        path: &str,
        symbol: Option<&str>,
        before: Option<&str>,
        after: Option<&str>,
        recorded: bool,
    ) -> Block {
        Block {
            seq,
            path: path.to_string(),
            symbol: symbol.map(|name| BlockSymbol {
                kind: SymbolKind::Function,
                name: name.to_string(),
                container: None,
                exported: true,
                nth: 0,
            }),
            labels: Vec::new(),
            importance: Importance::Medium,
            via: BlockVia::Edit,
            tool_use_ids: vec!["tu-1".to_string()],
            bash: None,
            before: before.map(str::to_string),
            after: after.map(str::to_string),
            recorded,
            line: Some(1),
            added: Some(1),
            removed: Some(1),
            quote: None,
        }
    }

    fn quoted_block(mut block: Block, text: &str) -> Block {
        block.quote = Some(Quote {
            text: text.to_string(),
            shared: false,
        });
        block
    }

    fn labeled_block(mut block: Block, labels: Vec<Label>) -> Block {
        block.labels = labels;
        block
    }

    fn test_card(card_id: &str, blocks: Vec<Block>) -> Card {
        Card {
            v: CARD_VERSION,
            card_id: card_id.to_string(),
            rev: 1,
            repo_id: "r1".to_string(),
            root: "C:/repo".to_string(),
            main_root: None,
            branch: Some("main".to_string()),
            session_id: "s1".to_string(),
            agent_id: "a1".to_string(),
            agent_type: "claude".to_string(),
            parent_card_id: None,
            started_ms: 1_000,
            ended_ms: Some(2_000),
            status: CardStatus::Done,
            prompt: "fix bug".to_string(),
            prompt_truncated: false,
            importance: Importance::Medium,
            blocks,
            more_count: 0,
            flow: Vec::new(),
            flow_more: 0,
            outside_count: 0,
            coverage: Coverage {
                state: CoverageState::Full,
                reasons: Vec::new(),
            },
        }
    }

    #[test]
    fn cards_reply_fits_line_cap_with_20_large_cards() {
        let long_quote = "q".repeat(350);
        let big_blocks: Vec<Block> = (1..=16)
            .map(|seq| {
                quoted_block(
                    test_block(
                        seq,
                        &format!(
                            "src/very/deep/nested/module_{seq:02}/component_implementation.rs"
                        ),
                        Some("process_request_payload"),
                        Some(&"a".repeat(64)),
                        Some(&"b".repeat(64)),
                        true,
                    ),
                    &long_quote,
                )
            })
            .collect();
        let cards: Vec<Card> = (0..20)
            .map(|i| {
                let mut c = test_card(&format!("card-{i:02}"), big_blocks.clone());
                c.ended_ms = Some(10_000 - i as u64);
                c
            })
            .collect();
        let expected_items = cards.clone();

        let reply = build_cards_reply(7, cards, Some("initial-next".into()));
        let wire = encode(&reply);
        assert!(
            wire.len() <= LINE_CAP,
            "reply exceeded LINE_CAP: {}",
            wire.len()
        );

        let ServerMsg::Cards { id, items, next } = reply else {
            panic!("expected ServerMsg::Cards");
        };
        assert_eq!(id, 7);
        assert_eq!(items.len(), expected_items.len());
        assert!(items.iter().all(|c| c.more_count > 0));
        for item in &items {
            for block in &item.blocks {
                if let Some(q) = &block.quote {
                    assert!(
                        q.text.chars().count() <= LIST_QUOTE_MAX_CHARS,
                        "quote not truncated: {}",
                        q.text.chars().count()
                    );
                }
            }
        }
        assert_eq!(next, Some("initial-next".into()));
    }

    #[test]
    fn cards_reply_shrinks_single_oversized_card_to_metadata_instead_of_dropping() {
        let mut card = test_card(
            "card-huge",
            vec![test_block(
                1,
                "src/lib.rs",
                Some("work"),
                Some("sha-a"),
                Some("sha-b"),
                true,
            )],
        );
        card.root = "r".repeat(LINE_CAP + 2048);
        card.prompt = "p".repeat(5_000);
        card.flow = flow_steps(100);

        let reply = build_cards_reply(8, vec![card], None);
        let wire = encode(&reply);
        assert!(wire.len() <= LINE_CAP, "reply exceeded LINE_CAP: {}", wire.len());
        let ServerMsg::Cards { id, items, next } = reply else {
            panic!("expected ServerMsg::Cards");
        };
        assert_eq!(id, 8);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].card_id, "card-huge");
        assert!(items[0].blocks.is_empty());
        assert!(items[0].flow.is_empty());
        assert_eq!(items[0].more_count, 1);
        assert_eq!(items[0].flow_more, 100);
        assert_eq!(next, None);
    }

    #[test]
    fn cards_reply_trims_flow_before_blocks() {
        let mut c0 = test_card(
            "c0",
            vec![test_block(
                1,
                "src/a.rs",
                Some("alpha"),
                Some("sha-a"),
                Some("sha-b"),
                true,
            )],
        );
        c0.flow = flow_steps(1_500);
        let c1 = test_card(
            "c1",
            vec![test_block(
                1,
                "src/b.rs",
                Some("beta"),
                Some("sha-c"),
                Some("sha-d"),
                true,
            )],
        );

        let reply = build_cards_reply(9, vec![c0, c1], None);
        assert!(encode(&reply).len() <= LINE_CAP);
        let ServerMsg::Cards { items, next, .. } = reply else {
            panic!("expected ServerMsg::Cards");
        };
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].blocks.len(), 1);
        assert_eq!(items[1].blocks.len(), 1);
        assert_eq!(items[0].more_count, 0);
        assert!(items[0].flow_more > 0);
        assert_eq!(items[0].flow.len() + items[0].flow_more as usize, 1_500);
        assert_eq!(next, None);
    }

    #[test]
    fn card_detail_reads_each_file_once() {
        let card = test_card(
            "c-reads",
            vec![
                test_block(
                    1,
                    "src/a.rs",
                    Some("alpha"),
                    Some("sha-a-old"),
                    Some("sha-a-new"),
                    true,
                ),
                test_block(
                    2,
                    "src/a.rs",
                    Some("beta"),
                    Some("sha-a-old"),
                    Some("sha-a-new"),
                    true,
                ),
                labeled_block(
                    test_block(3, "src/unrecorded.rs", None, Some("sha-unrec"), None, false),
                    vec![Label::NotCaptured {}],
                ),
                test_block(4, "src/path_only.rs", None, None, None, true),
                labeled_block(
                    test_block(5, "src/b.rs", Some("gamma"), None, Some("sha-b-new"), true),
                    vec![Label::FileNew {}],
                ),
            ],
        );

        let a_old = "fn alpha() {\n    let x = 1;\n}\n\nfn beta() {\n    let y = 2;\n}\n";
        let a_new = "fn alpha() {\n    let x = 2;\n}\n\nfn beta() {\n    let y = 3;\n}\n";
        let b_new = "fn gamma() {\n    println!(\"hi\");\n}\n";

        let mut reads: BTreeMap<String, usize> = BTreeMap::new();
        let reply = build_card_detail_with(11, &card, |sha| {
            *reads.entry(sha.to_string()).or_insert(0) += 1;
            match sha {
                "sha-a-old" => ObjectRead::Text(a_old.to_string()),
                "sha-a-new" => ObjectRead::Text(a_new.to_string()),
                "sha-b-new" => ObjectRead::Text(b_new.to_string()),
                _ => ObjectRead::Missing,
            }
        });

        let ServerMsg::CardDetail { id, snippets, .. } = &reply else {
            panic!("expected CardDetail");
        };
        assert_eq!(*id, 11);
        assert_eq!(reads.get("sha-a-old").copied(), Some(1));
        assert_eq!(reads.get("sha-a-new").copied(), Some(1));
        assert_eq!(reads.get("sha-b-new").copied(), Some(1));
        assert!(!reads.contains_key("sha-unrec"));

        let seqs: Vec<u32> = snippets.iter().map(|s| s.seq).collect();
        assert_eq!(seqs, vec![1, 2, 5]);
        assert!(snippets.iter().all(|s| !s.lines.is_empty()));
        assert!(encode(&reply).len() <= LINE_CAP);
    }

    #[test]
    fn card_detail_caps_20_code_blocks() {
        let mut blocks = vec![labeled_block(
            test_block(1, "src/unrecorded.rs", None, Some("sha-u"), None, false),
            vec![Label::NotCaptured {}],
        )];
        for seq in 2..=26 {
            blocks.push(test_block(
                seq,
                &format!("src/f{seq}.rs"),
                Some("work"),
                Some("sha-before"),
                Some("sha-after"),
                true,
            ));
        }
        let card = test_card("c-cap", blocks);

        let reply = build_card_detail_with(22, &card, |sha| match sha {
            "sha-before" => ObjectRead::Text("fn work() {\n    1\n}\n".to_string()),
            "sha-after" => ObjectRead::Text("fn work() {\n    2\n}\n".to_string()),
            _ => ObjectRead::Missing,
        });

        let ServerMsg::CardDetail { snippets, .. } = &reply else {
            panic!("expected CardDetail");
        };
        assert_eq!(snippets.len(), MAX_DETAIL_CODE_BLOCKS);
        let seqs: Vec<u32> = snippets.iter().map(|s| s.seq).collect();
        let expected: Vec<u32> = (2..=21).collect();
        assert_eq!(seqs, expected);
        assert!(encode(&reply).len() <= LINE_CAP);
    }

    #[test]
    fn block_diff_pages_under_48_kib() {
        let mut before = String::new();
        let mut after = String::new();
        for i in 0..1_200 {
            let suffix = "x".repeat(80);
            before.push_str(&format!("line {i:04} old {suffix}\n"));
            after.push_str(&format!("line {i:04} new {suffix}\n"));
        }

        let card = test_card(
            "c-diff",
            vec![test_block(
                1,
                "src/big.txt",
                None,
                Some("sha-before"),
                Some("sha-after"),
                true,
            )],
        );

        let read = |sha: &str| match sha {
            "sha-before" => ObjectRead::Text(before.clone()),
            "sha-after" => ObjectRead::Text(after.clone()),
            _ => ObjectRead::Missing,
        };

        let first = build_block_diff_with(31, &card, 1, 0, read);
        let ServerMsg::BlockDiff {
            lines,
            page,
            pages,
            missing,
            ..
        } = &first
        else {
            panic!("expected BlockDiff");
        };
        assert!(!missing);
        assert_eq!(*page, 0);
        assert!(*pages >= 3, "expected multiple pages, got {pages}");
        assert!(!lines.is_empty());

        let mut total_lines = 0usize;
        for p in 0..*pages {
            let reply = build_block_diff_with(31, &card, 1, p, read);
            assert!(encode(&reply).len() <= LINE_CAP);
            let ServerMsg::BlockDiff {
                lines,
                page: got_page,
                pages: got_pages,
                missing,
                ..
            } = reply
            else {
                panic!("expected BlockDiff");
            };
            assert!(!missing);
            assert_eq!(got_page, p);
            assert_eq!(got_pages, *pages);
            assert!(!lines.is_empty());
            let page_bytes = serde_json::to_vec(&lines).unwrap().len();
            assert!(
                page_bytes <= DIFF_PAGE_BYTES,
                "page {p} too large: {page_bytes} > {DIFF_PAGE_BYTES}"
            );
            total_lines += lines.len();
        }
        assert_eq!(total_lines, 2_400);
    }

    #[test]
    fn block_diff_missing_object() {
        let card = test_card(
            "c-miss",
            vec![
                test_block(
                    1,
                    "src/a.rs",
                    None,
                    Some("sha-missing"),
                    Some("sha-after"),
                    true,
                ),
                test_block(2, "src/b.rs", None, Some("sha-a"), Some("sha-b"), false),
            ],
        );

        let reply_missing_obj = build_block_diff_with(41, &card, 1, 0, |sha| match sha {
            "sha-after" => ObjectRead::Text("hello\n".to_string()),
            _ => ObjectRead::Missing,
        });
        assert_eq!(
            reply_missing_obj,
            ServerMsg::BlockDiff {
                id: 41,
                lines: Vec::new(),
                page: 0,
                pages: 0,
                missing: true,
            }
        );

        let reply_unrecorded = build_block_diff_with(42, &card, 2, 0, |_| {
            ObjectRead::Text("should not matter".to_string())
        });
        assert_eq!(
            reply_unrecorded,
            ServerMsg::BlockDiff {
                id: 42,
                lines: Vec::new(),
                page: 0,
                pages: 0,
                missing: true,
            }
        );

        let reply_unknown_seq = build_block_diff_with(43, &card, 99, 0, |_| ObjectRead::Missing);
        assert_eq!(
            reply_unknown_seq,
            ServerMsg::BlockDiff {
                id: 43,
                lines: Vec::new(),
                page: 0,
                pages: 0,
                missing: true,
            }
        );
    }

    fn flow_steps(count: usize) -> Vec<FlowStep> {
        (0..count)
            .map(|_| FlowStep {
                kind: FlowKind::Cmd,
                text: "cargo test".to_string(),
                ok: true,
                dur_ms: 10,
                seqs: Vec::new(),
            })
            .collect()
    }

    #[test]
    fn block_diff_splits_escape_heavy_first_line_within_limits() {
        let escaped_line: String = "\u{0001}".repeat(16_384);
        let after = format!("{escaped_line}\n");
        let card = test_card(
            "c-esc",
            vec![test_block(
                1,
                "src/ctrl.txt",
                None,
                Some("sha-before"),
                Some("sha-after"),
                true,
            )],
        );

        let read = |sha: &str| match sha {
            "sha-before" => ObjectRead::Text("ok\n".to_string()),
            "sha-after" => ObjectRead::Text(after.clone()),
            _ => ObjectRead::Missing,
        };

        let first = build_block_diff_with(51, &card, 1, 0, read);
        let ServerMsg::BlockDiff { pages, missing, .. } = first else {
            panic!("expected BlockDiff");
        };
        assert!(!missing);
        assert!(pages > 1, "expected multi-page diff, got {pages}");

        let mut reassembled = String::new();
        for p in 0..pages {
            let reply = build_block_diff_with(51, &card, 1, p, read);
            let wire = encode(&reply);
            assert!(
                wire.len() <= LINE_CAP,
                "page {p} frame exceeded LINE_CAP: {}",
                wire.len()
            );
            let ServerMsg::BlockDiff {
                lines,
                page: got_page,
                pages: got_pages,
                missing,
                ..
            } = reply
            else {
                panic!("expected BlockDiff");
            };
            assert!(!missing);
            assert_eq!(got_page, p);
            assert_eq!(got_pages, pages);
            assert!(!lines.is_empty());
            let page_bytes = serde_json::to_vec(&lines).unwrap().len();
            assert!(
                page_bytes <= DIFF_PAGE_BYTES,
                "page {p} serialized bytes exceeded DIFF_PAGE_BYTES: {page_bytes}"
            );
            for line in lines {
                if line.kind == DiffLineKind::Added {
                    reassembled.push_str(&line.text);
                }
            }
        }
        assert_eq!(reassembled, escaped_line);
    }

    #[test]
    fn card_broadcast_drops_flow_steps_to_fit_line_cap() {
        let mut card = test_card(
            "c-flow-bcast",
            vec![quoted_block(
                test_block(
                    1,
                    "src/lib.rs",
                    Some("work"),
                    Some("sha-a"),
                    Some("sha-b"),
                    true,
                ),
                &"q".repeat(300),
            )],
        );
        card.prompt = "p".repeat(900);
        card.flow = flow_steps(1_000);

        let msg = build_card_broadcast(card).expect("trimmed broadcast should fit LINE_CAP");
        let wire = encode(&msg);
        assert!(
            wire.len() <= LINE_CAP,
            "broadcast exceeded LINE_CAP: {}",
            wire.len()
        );
        let ServerMsg::Card { item } = msg else {
            panic!("expected ServerMsg::Card");
        };
        assert_eq!(item.blocks.len(), 1);
        assert!(item.flow.len() < 1_000);
        assert!(item.flow_more > 0);
        assert_eq!(item.flow.len() + item.flow_more as usize, 1_000);
    }

    #[test]
    fn card_broadcast_returns_none_when_metadata_exceeds_line_cap() {
        let mut card = test_card("c-huge-bcast", Vec::new());
        card.root = "r".repeat(LINE_CAP + 1024);
        assert!(build_card_broadcast(card).is_none());
    }

    #[test]
    fn card_detail_drops_flow_steps_to_fit_line_cap() {
        let mut card = test_card(
            "c-flow-detail",
            vec![test_block(
                1,
                "src/lib.rs",
                Some("work"),
                Some("sha-before"),
                Some("sha-after"),
                true,
            )],
        );
        card.prompt = "p".repeat(900);
        card.flow = flow_steps(1_000);

        let msg = build_card_detail_with(61, &card, |sha| match sha {
            "sha-before" => ObjectRead::Text("fn work() {\n    1\n}\n".to_string()),
            "sha-after" => ObjectRead::Text("fn work() {\n    2\n}\n".to_string()),
            _ => ObjectRead::Missing,
        });
        let wire = encode(&msg);
        assert!(
            wire.len() <= LINE_CAP,
            "card_detail exceeded LINE_CAP: {}",
            wire.len()
        );
        let ServerMsg::CardDetail {
            id,
            card: out_card,
            snippets,
        } = msg
        else {
            panic!("expected ServerMsg::CardDetail");
        };
        assert_eq!(id, 61);
        assert_eq!(snippets.len(), 1);
        assert_eq!(out_card.blocks.len(), 1);
        assert!(out_card.flow.len() < 1_000);
        assert!(out_card.flow_more > 0);
        assert_eq!(out_card.flow.len() + out_card.flow_more as usize, 1_000);
    }

    #[test]
    fn card_detail_returns_too_large_when_metadata_exceeds_line_cap() {
        let mut card = test_card("c-huge-meta", Vec::new());
        card.root = "r".repeat(LINE_CAP + 1024);

        let msg = build_card_detail_with(62, &card, |_| ObjectRead::Missing);
        assert_eq!(
            msg,
            ServerMsg::Ack {
                id: 62,
                ok: false,
                error: Some("too_large".to_string()),
                cleanup_errors: 0,
            }
        );
    }

    #[test]
    fn card_detail_missing_before_produces_no_snippet_and_capture_off() {
        let card = test_card(
            "c-miss-before",
            vec![test_block(
                1,
                "src/lib.rs",
                Some("work"),
                Some("sha-missing"),
                Some("sha-after"),
                true,
            )],
        );
        let original = card.clone();

        let msg = build_card_detail_with(71, &card, |sha| match sha {
            "sha-after" => ObjectRead::Text("fn work() {\n    2\n}\n".to_string()),
            _ => ObjectRead::Missing,
        });
        let ServerMsg::CardDetail {
            card: out_card,
            snippets,
            ..
        } = msg
        else {
            panic!("expected CardDetail");
        };
        assert!(
            snippets.is_empty(),
            "expected no snippets, got {snippets:?}"
        );
        assert_eq!(out_card.coverage.state, CoverageState::Partial);
        assert_eq!(out_card.coverage.reasons, vec![CoverageReason::CaptureOff]);
        assert_eq!(card, original);
    }

    #[test]
    fn card_detail_missing_after_produces_no_snippet_and_capture_off() {
        let card = test_card(
            "c-miss-after",
            vec![test_block(
                1,
                "src/lib.rs",
                Some("work"),
                Some("sha-before"),
                Some("sha-missing"),
                true,
            )],
        );

        let msg = build_card_detail_with(72, &card, |sha| match sha {
            "sha-before" => ObjectRead::Text("fn work() {\n    1\n}\n".to_string()),
            _ => ObjectRead::Missing,
        });
        let ServerMsg::CardDetail {
            card: out_card,
            snippets,
            ..
        } = msg
        else {
            panic!("expected CardDetail");
        };
        assert!(snippets.is_empty());
        assert_eq!(out_card.coverage.state, CoverageState::Partial);
        assert_eq!(out_card.coverage.reasons, vec![CoverageReason::CaptureOff]);
    }

    #[test]
    fn card_detail_invalid_object_produces_no_snippet_and_capture_off() {
        let card = test_card(
            "c-invalid-obj",
            vec![test_block(
                1,
                "src/lib.rs",
                Some("work"),
                Some("sha-invalid"),
                Some("sha-after"),
                true,
            )],
        );

        let msg = build_card_detail_with(73, &card, |sha| match sha {
            "sha-after" => ObjectRead::Text("fn work() {\n    2\n}\n".to_string()),
            _ => ObjectRead::Invalid,
        });
        let ServerMsg::CardDetail {
            card: out_card,
            snippets,
            ..
        } = msg
        else {
            panic!("expected CardDetail");
        };
        assert!(snippets.is_empty());
        assert_eq!(out_card.coverage.state, CoverageState::Partial);
        assert_eq!(out_card.coverage.reasons, vec![CoverageReason::CaptureOff]);
    }

    #[test]
    fn card_detail_too_large_object_produces_no_snippet_and_too_large() {
        let card = test_card(
            "c-too-large-obj",
            vec![test_block(
                1,
                "src/lib.rs",
                Some("work"),
                Some("sha-big"),
                Some("sha-after"),
                true,
            )],
        );

        let msg = build_card_detail_with(74, &card, |sha| match sha {
            "sha-after" => ObjectRead::Text("fn work() {\n    2\n}\n".to_string()),
            _ => ObjectRead::TooLarge,
        });
        let ServerMsg::CardDetail {
            card: out_card,
            snippets,
            ..
        } = msg
        else {
            panic!("expected CardDetail");
        };
        assert!(snippets.is_empty());
        assert_eq!(out_card.coverage.state, CoverageState::Partial);
        assert_eq!(out_card.coverage.reasons, vec![CoverageReason::TooLarge]);
    }

    #[test]
    fn card_detail_preserves_originally_unknown_baseline_snippet() {
        let card = test_card(
            "c-orig-unknown",
            vec![test_block(
                1,
                "src/lib.rs",
                Some("work"),
                None,
                Some("sha-after"),
                true,
            )],
        );

        let msg = build_card_detail_with(75, &card, |sha| match sha {
            "sha-after" => ObjectRead::Text("fn work() {\n    2\n}\n".to_string()),
            _ => ObjectRead::Missing,
        });
        let ServerMsg::CardDetail {
            card: out_card,
            snippets,
            ..
        } = msg
        else {
            panic!("expected CardDetail");
        };
        assert_eq!(snippets.len(), 1);
        assert!(!snippets[0].lines.is_empty());
        assert_eq!(out_card.coverage.state, CoverageState::Full);
        assert!(out_card.coverage.reasons.is_empty());
    }
}
