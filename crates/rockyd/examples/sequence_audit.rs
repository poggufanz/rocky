//! Owner-run audit tool that reads persisted change cards and prints Markdown
//! for manual labelling of `match_sequence` precision and recall.
//!
//! Usage:
//! `cargo run -p rockyd --example sequence_audit [-- <rocky_home>]`

use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::fs::{self, File};
use std::io::{self, BufRead, BufReader, Write as _};
use std::path::{Path, PathBuf};

use rocky_proto::cards::{Block, BlockSymbol, Card, FlowKind, FlowStep, Sequence, SymbolKind};
use rocky_proto::paths::{cards_dir, rocky_home};
use rockyd::cards::sequence::match_sequence;

const MAX_CARDS: usize = 60;
const TITLE_MAX_CHARS: usize = 80;
const SEQUENCE_CMD_MAX_CHARS: usize = 80;

fn main() -> io::Result<()> {
    let home = resolve_rocky_home();
    let dir = cards_dir(&home);
    let mut cards = load_latest_cards(&dir)?;

    cards.retain(|card| {
        card.flow
            .iter()
            .any(|step| step.kind == FlowKind::Cmd && step.exit_code.is_some())
    });

    cards.sort_by(|a, b| {
        (card_sort_key(b), b.card_id.as_str()).cmp(&(card_sort_key(a), a.card_id.as_str()))
    });
    cards.truncate(MAX_CARDS);

    let mut out = io::BufWriter::new(io::stdout().lock());
    writeln!(out, "# Sequence Audit\n")?;

    let mut matched = 0usize;
    let mut matched_without_sentence = 0usize;
    let mut unmatched = 0usize;

    for card in &cards {
        let seq = match_sequence(&card.flow, &card.blocks);
        let sentence = seq.as_ref().and_then(|s| render_sequence_en(card, s));
        match (&seq, &sentence) {
            (Some(_), Some(_)) => matched += 1,
            (Some(_), None) => matched_without_sentence += 1,
            (None, _) => unmatched += 1,
        }

        write_card(&mut out, card, seq.as_ref(), sentence.as_deref())?;
    }

    writeln!(out, "## Summary\n")?;
    writeln!(out, "- cards: {}", cards.len())?;
    writeln!(out, "- matched: {matched}")?;
    writeln!(
        out,
        "- matched without sentence: {matched_without_sentence}"
    )?;
    writeln!(out, "- unmatched: {unmatched}")?;
    out.flush()
}

fn resolve_rocky_home() -> PathBuf {
    match std::env::args_os().nth(1) {
        Some(arg) if !arg.is_empty() => PathBuf::from(arg),
        _ => rocky_home(),
    }
}

fn load_latest_cards(dir: &Path) -> io::Result<Vec<Card>> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(err),
    };

    let mut by_id: HashMap<String, Card> = HashMap::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension() != Some(OsStr::new("jsonl")) {
            continue;
        }
        let Ok(meta) = fs::metadata(&path) else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        read_cards_file(&path, &mut by_id)?;
    }

    Ok(by_id.into_values().collect())
}

fn read_cards_file(path: &Path, by_id: &mut HashMap<String, Card>) -> io::Result<()> {
    let file = File::open(path)?;
    let mut reader = BufReader::new(file);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        let n = reader.read_until(b'\n', &mut buf)?;
        if n == 0 {
            break;
        }
        let trimmed = buf.trim_ascii();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(card) = serde_json::from_slice::<Card>(trimmed) else {
            continue;
        };
        match by_id.get_mut(&card.card_id) {
            Some(existing) => {
                if is_newer_revision(&card, existing) {
                    *existing = card;
                }
            }
            None => {
                by_id.insert(card.card_id.clone(), card);
            }
        }
    }
    Ok(())
}

fn is_newer_revision(candidate: &Card, current: &Card) -> bool {
    candidate.rev > current.rev
        || (candidate.rev == current.rev && candidate.ended_ms > current.ended_ms)
}

fn card_sort_key(card: &Card) -> u64 {
    card.ended_ms.unwrap_or(card.started_ms)
}

fn write_card(
    out: &mut impl io::Write,
    card: &Card,
    seq: Option<&Sequence>,
    sentence: Option<&str>,
) -> io::Result<()> {
    let clean_id = sanitize_single_line(&card.card_id);
    let card_id = if clean_id.is_empty() {
        "(empty)".to_string()
    } else {
        markdown_code_span(&clean_id)
    };
    let date = format_utc_date(card_sort_key(card));
    let title = prompt_title(&card.prompt);

    writeln!(out, "## {card_id} — {date}\n")?;
    if title.is_empty() {
        writeln!(out, "Prompt:\n")?;
    } else {
        writeln!(out, "Prompt: {title}\n")?;
    }
    writeln!(out, "Steps:")?;
    for step in &card.flow {
        writeln!(out, "- {}", format_step(step))?;
    }
    writeln!(out)?;

    match (seq, sentence) {
        (_, Some(text)) => writeln!(out, "Sentence: {text}\n")?,
        (Some(_), None) => writeln!(out, "Sentence: (matched; edit block missing)\n")?,
        (None, None) => writeln!(out, "Sentence: (no pattern)\n")?,
    }

    writeln!(
        out,
        "- [ ] sentence correct  - [ ] sentence wrong  - [ ] pattern happened but missed\n"
    )?;
    writeln!(out, "---\n")
}

fn format_step(step: &FlowStep) -> String {
    let icon = match step.kind {
        FlowKind::Cmd => {
            if step.ok {
                "✓"
            } else {
                "✗"
            }
        }
        FlowKind::Edit => "✎",
    };

    let text = sanitize_single_line(&step.text);
    let text = text.trim();
    let mut line = if text.is_empty() {
        icon.to_string()
    } else {
        format!("{icon} {}", escape_markdown(text))
    };

    if step.kind == FlowKind::Edit && !step.ok {
        line.push_str(" [failed]");
    }
    if let Some(code) = step.exit_code {
        line.push_str(&format!(" [exit {code}]"));
    }
    if let Some(err) = step.error.as_deref() {
        let clean_err = sanitize_single_line(err);
        let clean_err = clean_err.trim();
        if !clean_err.is_empty() {
            line.push_str(&format!(" [{}]", escape_markdown(clean_err)));
        }
    }

    line
}

// ponytail: copy of the desk EN template (crates/rocky-desk/src/i18n/cards.rs,
// SequenceFixAfterFail / SequenceEditsMore) and edit-head / sanitize helpers
// (crates/rocky-desk/src/card_detail_model.rs, crates/rocky-desk/src/cards_model/rows.rs)
// for an owner-run tool; must follow desk wording and rendering changes.
fn render_sequence_en(card: &Card, seq: &Sequence) -> Option<String> {
    let block_by_seq: HashMap<u32, &Block> = card.blocks.iter().map(|b| (b.seq, b)).collect();
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
            let mut seen = HashSet::new();
            let mut resolved = edit_seqs
                .iter()
                .copied()
                .filter(|s| seen.insert(*s))
                .filter_map(|s| block_by_seq.get(&s).copied());
            let first_block = resolved.next()?;
            let first_head = block_head(first_block);
            if first_head.is_empty() {
                return None;
            }
            let first = escape_markdown(&first_head);
            let more = resolved.count();
            let edits = if more == 0 {
                first
            } else {
                format!("{first} and {more} more")
            };
            let err = error_names
                .as_deref()
                .map(|name| sanitize_single_line(name).trim().to_string())
                .filter(|name| !name.is_empty())
                .map(|name| format!(" The error names {}.", escape_markdown(&name)))
                .unwrap_or_default();
            let cmd_span = markdown_code_span(&cmd);
            Some(format!(
                "{cmd_span} failed (exit {exit_code}).{err} Edited {edits}. {cmd_span} passed."
            ))
        }
    }
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

fn block_head(block: &Block) -> String {
    let path = sanitize_single_line(&block.path);
    let symbol = format_symbol(block.symbol.as_ref()).filter(|s| !s.is_empty());
    match symbol {
        Some(sym) => format!("{path} \u{203a} {sym}"),
        None => path,
    }
}

fn normalize_and_cut_command(command: &str) -> String {
    let clean = sanitize_single_line(command);
    let normalized = clean.split_whitespace().collect::<Vec<_>>().join(" ");
    cut_to_limit(&normalized, SEQUENCE_CMD_MAX_CHARS)
}

fn prompt_title(prompt: &str) -> String {
    let first_line = prompt
        .split(['\r', '\n', '\u{2028}', '\u{2029}'])
        .next()
        .unwrap_or("");
    let clean = sanitize_single_line(first_line);
    let cut = cut_to_limit(clean.trim(), TITLE_MAX_CHARS);
    escape_markdown(&cut)
}

fn markdown_code_span(text: &str) -> String {
    let mut max_run = 0usize;
    let mut current_run = 0usize;
    for ch in text.chars() {
        if ch == '`' {
            current_run += 1;
            max_run = max_run.max(current_run);
        } else {
            current_run = 0;
        }
    }
    let fence = "`".repeat(max_run + 1);
    let pad = if text.starts_with('`') || text.ends_with('`') {
        " "
    } else {
        ""
    };
    format!("{fence}{pad}{text}{pad}{fence}")
}

fn escape_markdown(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        if ch == '&' {
            out.push_str("&amp;");
            continue;
        }
        if matches!(
            ch,
            '\\' | '`' | '*' | '_' | '{' | '}' | '[' | ']' | '<' | '>' | '#' | '!' | '|' | '~'
        ) {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

fn sanitize_single_line(text: &str) -> String {
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

fn cut_to_limit(text: &str, max_total: usize) -> String {
    if text.chars().count() <= max_total {
        return text.to_string();
    }
    let head: String = text.chars().take(max_total.saturating_sub(1)).collect();
    format!("{head}\u{2026}")
}

fn format_utc_date(ms: u64) -> String {
    let secs = ms / 1000;
    let days = (secs / 86_400) as i64;
    let day_secs = secs % 86_400;
    let hour = day_secs / 3600;
    let min = (day_secs % 3600) / 60;

    // Civil date from days since 1970-01-01 (Howard Hinnant's civil_from_days).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02} {hour:02}:{min:02} UTC")
}

#[cfg(test)]
mod tests {
    use rocky_proto::cards::{CardStatus, Coverage, CoverageState, Importance};

    use super::*;

    fn sample_card(blocks: Vec<Block>, sequence: Sequence) -> Card {
        Card {
            v: 1,
            card_id: "c-audit".to_string(),
            rev: 1,
            repo_id: "repo-1".to_string(),
            root: "/work/repo".to_string(),
            main_root: None,
            branch: None,
            session_id: "s-1".to_string(),
            agent_id: "a-1".to_string(),
            agent_type: String::new(),
            parent_card_id: None,
            started_ms: 1_000,
            ended_ms: Some(2_000),
            status: CardStatus::Done,
            prompt: "test".to_string(),
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
            reads: Vec::new(),
            reads_more: 0,
            sequence: Some(sequence),
        }
    }

    fn sample_block(seq: u32, path: &str, symbol: Option<BlockSymbol>) -> Block {
        Block {
            seq,
            path: path.to_string(),
            symbol,
            labels: Vec::new(),
            importance: Importance::Medium,
            via: rocky_proto::cards::BlockVia::Edit,
            tool_use_ids: Vec::new(),
            bash: None,
            before: None,
            after: None,
            recorded: true,
            line: Some(1),
            added: Some(1),
            removed: Some(0),
            quote: None,
        }
    }

    #[test]
    fn renders_edit_head_like_desk_with_symbol_and_parens() {
        let card = sample_card(
            vec![sample_block(
                1,
                "src/auth.ts",
                Some(BlockSymbol {
                    kind: SymbolKind::Function,
                    name: "verifyToken".to_string(),
                    container: None,
                    exported: false,
                    nth: 0,
                }),
            )],
            Sequence::FixAfterFail {
                command: "npm test".to_string(),
                exit_code: 1,
                edit_seqs: vec![1],
                error_names: None,
            },
        );
        assert_eq!(
            render_sequence_en(&card, card.sequence.as_ref().unwrap()).as_deref(),
            Some(
                "`npm test` failed (exit 1). Edited src/auth.ts \u{203a} verifyToken(). `npm test` passed."
            )
        );

        let empty_fn_card = sample_card(
            vec![sample_block(
                1,
                "src/auth.ts",
                Some(BlockSymbol {
                    kind: SymbolKind::Method,
                    name: String::new(),
                    container: None,
                    exported: false,
                    nth: 0,
                }),
            )],
            Sequence::FixAfterFail {
                command: "npm test".to_string(),
                exit_code: 1,
                edit_seqs: vec![1],
                error_names: None,
            },
        );
        assert_eq!(
            render_sequence_en(&empty_fn_card, empty_fn_card.sequence.as_ref().unwrap()).as_deref(),
            Some("`npm test` failed (exit 1). Edited src/auth.ts \u{203a} (). `npm test` passed.")
        );
    }

    #[test]
    fn turns_control_chars_into_spaces_and_returns_none_when_first_head_empty() {
        let ctrl_card = sample_card(
            vec![sample_block(1, "src/auth.ts", None)],
            Sequence::FixAfterFail {
                command: "npm\u{7}test".to_string(),
                exit_code: 1,
                edit_seqs: vec![1],
                error_names: None,
            },
        );
        assert_eq!(
            render_sequence_en(&ctrl_card, ctrl_card.sequence.as_ref().unwrap()).as_deref(),
            Some("`npm test` failed (exit 1). Edited src/auth.ts. `npm test` passed.")
        );

        let empty_first_card = sample_card(
            vec![
                sample_block(1, "", None),
                sample_block(2, "src/auth.ts", None),
            ],
            Sequence::FixAfterFail {
                command: "npm test".to_string(),
                exit_code: 1,
                edit_seqs: vec![1, 2],
                error_names: None,
            },
        );
        assert_eq!(
            render_sequence_en(
                &empty_first_card,
                empty_first_card.sequence.as_ref().unwrap()
            ),
            None
        );
    }
}
