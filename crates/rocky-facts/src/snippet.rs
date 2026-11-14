use std::collections::BTreeSet;

use serde::Serialize;
use similar::{Algorithm, DiffOp, capture_diff_slices};

use crate::lang::lang_for_path;
use crate::model::{FileInput, Lang, MAX_DIFF_ITEMS, Side, Symbol, SymbolKind};
use crate::syntax;
use crate::text::{cut, normalize};

const MAX_SNIPPET_ENTRIES: usize = 12;
const MAX_SNIPPET_LINE_CHARS: usize = 120;

/// Single entry in a trimmed code snippet produced by `snippet`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum SnippetLine {
    Context { text: String },
    Added { text: String },
    Removed { text: String },
    Fold { lines: u32 },
    More { lines: u32 },
}

fn saturating_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

fn is_grammar_lang(lang: Lang) -> bool {
    matches!(
        lang,
        Lang::Typescript | Lang::Tsx | Lang::Javascript | Lang::Rust
    )
}

fn slice_region<'a>(all_lines: &'a [&'a str], lines: (u32, u32)) -> (&'a [&'a str], u32) {
    let start_idx = lines.0.saturating_sub(1) as usize;
    let end_idx = (lines.1 as usize).min(all_lines.len());
    if start_idx >= end_idx {
        (&[], lines.0)
    } else {
        (&all_lines[start_idx..end_idx], lines.0)
    }
}

fn resolve_regions<'a>(
    lang: Lang,
    norm_text: Option<&str>,
    all_lines: &'a [&'a str],
    symbols: &[Option<&Symbol>],
    collect_heads: bool,
) -> Vec<(&'a [&'a str], u32, BTreeSet<u32>)> {
    let Some(text) = norm_text else {
        return vec![(&[], 1, BTreeSet::new()); symbols.len()];
    };
    if !is_grammar_lang(lang) {
        return symbols
            .iter()
            .map(|_| (all_lines, 1, BTreeSet::new()))
            .collect();
    }
    let regions = syntax::parse_symbol_regions(lang, text, symbols, collect_heads);
    symbols
        .iter()
        .zip(regions)
        .map(|(symbol, maybe_region)| {
            if symbol.is_none() {
                return (all_lines, 1, BTreeSet::new());
            }
            let Some(region) = maybe_region else {
                return (&[][..], 1, BTreeSet::new());
            };
            let (sliced, start_line) = slice_region(all_lines, region.lines);
            (sliced, start_line, region.head_lines)
        })
        .collect()
}

fn push_fold(entries: &mut Vec<SnippetLine>, count: u32) {
    if count == 0 {
        return;
    }
    if let Some(SnippetLine::Fold { lines }) = entries.last_mut() {
        *lines = lines.saturating_add(count);
    } else {
        entries.push(SnippetLine::Fold { lines: count });
    }
}

fn entry_line_count(entry: &SnippetLine) -> u32 {
    match entry {
        SnippetLine::Context { .. } | SnippetLine::Added { .. } | SnippetLine::Removed { .. } => 1,
        SnippetLine::Fold { lines } | SnippetLine::More { lines } => *lines,
    }
}

fn cap_entries(mut entries: Vec<SnippetLine>) -> Vec<SnippetLine> {
    if entries.len() <= MAX_SNIPPET_ENTRIES {
        return entries;
    }
    let dropped_lines: u32 = entries
        .drain(MAX_SNIPPET_ENTRIES - 1..)
        .map(|entry| entry_line_count(&entry))
        .fold(0u32, u32::saturating_add);
    entries.push(SnippetLine::More {
        lines: dropped_lines,
    });
    entries
}

fn single_side_entries(lines: &[&str], build: fn(String) -> SnippetLine) -> Vec<SnippetLine> {
    if lines.len() <= MAX_SNIPPET_ENTRIES {
        return lines
            .iter()
            .map(|line| build(cut(line, MAX_SNIPPET_LINE_CHARS)))
            .collect();
    }
    let keep = MAX_SNIPPET_ENTRIES - 1;
    let mut out: Vec<SnippetLine> = lines[..keep]
        .iter()
        .map(|line| build(cut(line, MAX_SNIPPET_LINE_CHARS)))
        .collect();
    out.push(SnippetLine::More {
        lines: saturating_u32(lines.len() - keep),
    });
    out
}

fn push_equal_run(
    entries: &mut Vec<SnippetLine>,
    lines: &[&str],
    start_line: u32,
    new_index: usize,
    len: usize,
    head_lines: &BTreeSet<u32>,
) {
    for offset in 0..len {
        let idx = new_index + offset;
        let line_num = start_line + idx as u32;
        if head_lines.contains(&line_num) {
            entries.push(SnippetLine::Context {
                text: cut(lines[idx], MAX_SNIPPET_LINE_CHARS),
            });
        } else {
            push_fold(entries, 1);
        }
    }
}

fn push_changed_run(
    entries: &mut Vec<SnippetLine>,
    lines: &[&str],
    build: fn(String) -> SnippetLine,
) {
    for line in lines {
        entries.push(build(cut(line, MAX_SNIPPET_LINE_CHARS)));
    }
}

fn build_snippet(
    before_side: Side<'_>,
    after_side: Side<'_>,
    before_region: &[&str],
    after_region: &[&str],
    after_start_line: u32,
    head_lines: &BTreeSet<u32>,
) -> Vec<SnippetLine> {
    if before_region.len() > MAX_DIFF_ITEMS || after_region.len() > MAX_DIFF_ITEMS {
        let omitted = if after_region.is_empty() {
            before_region.len()
        } else {
            after_region.len()
        };
        return vec![SnippetLine::More {
            lines: saturating_u32(omitted),
        }];
    }

    if matches!(after_side, Side::Absent) {
        return single_side_entries(before_region, |text| SnippetLine::Removed { text });
    }
    if matches!(before_side, Side::Absent) {
        return single_side_entries(after_region, |text| SnippetLine::Added { text });
    }
    if matches!(after_side, Side::Unknown) {
        return Vec::new();
    }
    if matches!(before_side, Side::Unknown) {
        let mut entries = Vec::new();
        push_equal_run(
            &mut entries,
            after_region,
            after_start_line,
            0,
            after_region.len(),
            head_lines,
        );
        return cap_entries(entries);
    }

    let ops = capture_diff_slices(Algorithm::Myers, before_region, after_region);
    let mut entries = Vec::new();
    for op in ops {
        match op {
            DiffOp::Equal { new_index, len, .. } => {
                push_equal_run(
                    &mut entries,
                    after_region,
                    after_start_line,
                    new_index,
                    len,
                    head_lines,
                );
            }
            DiffOp::Delete {
                old_index, old_len, ..
            } => {
                push_changed_run(
                    &mut entries,
                    &before_region[old_index..old_index + old_len],
                    |text| SnippetLine::Removed { text },
                );
            }
            DiffOp::Insert {
                new_index, new_len, ..
            } => {
                push_changed_run(
                    &mut entries,
                    &after_region[new_index..new_index + new_len],
                    |text| SnippetLine::Added { text },
                );
            }
            DiffOp::Replace {
                old_index,
                old_len,
                new_index,
                new_len,
            } => {
                push_changed_run(
                    &mut entries,
                    &before_region[old_index..old_index + old_len],
                    |text| SnippetLine::Removed { text },
                );
                push_changed_run(
                    &mut entries,
                    &after_region[new_index..new_index + new_len],
                    |text| SnippetLine::Added { text },
                );
            }
        }
    }
    cap_entries(entries)
}

/// Builds trimmed, skeleton-aware code snippets for many changes in one file, parsing each side at most once.
pub fn snippets(input: &FileInput<'_>, symbols: &[Option<&Symbol>]) -> Vec<Vec<SnippetLine>> {
    if symbols.is_empty() {
        return Vec::new();
    }

    let lang = lang_for_path(input.path);
    let before_norm = match input.before {
        Side::Text(s) => Some(normalize(s)),
        Side::Absent | Side::Unknown => None,
    };
    let after_norm = match input.after {
        Side::Text(s) => Some(normalize(s)),
        Side::Absent | Side::Unknown => None,
    };

    let before_lines: Vec<&str> = before_norm
        .as_deref()
        .map(|s| s.lines().collect())
        .unwrap_or_default();
    let after_lines: Vec<&str> = after_norm
        .as_deref()
        .map(|s| s.lines().collect())
        .unwrap_or_default();

    let before_regions =
        resolve_regions(lang, before_norm.as_deref(), &before_lines, symbols, false);
    let collect_after_heads = !matches!(input.before, Side::Absent)
        && !matches!(input.after, Side::Absent | Side::Unknown);
    let after_regions = resolve_regions(
        lang,
        after_norm.as_deref(),
        &after_lines,
        symbols,
        collect_after_heads,
    );

    before_regions
        .into_iter()
        .zip(after_regions)
        .map(
            |((before_region, _, _), (after_region, after_start_line, head_lines))| {
                build_snippet(
                    input.before,
                    input.after,
                    before_region,
                    after_region,
                    after_start_line,
                    &head_lines,
                )
            },
        )
        .collect()
}

/// Builds a trimmed, skeleton-aware code snippet for one file change or symbol.
pub fn snippet(input: &FileInput<'_>, symbol: Option<&Symbol>) -> Vec<SnippetLine> {
    snippets(input, &[symbol])
        .into_iter()
        .next()
        .unwrap_or_default()
}

fn kind_name(kind: SymbolKind) -> &'static str {
    match kind {
        SymbolKind::Function => "function",
        SymbolKind::Method => "method",
        SymbolKind::Class => "class",
        SymbolKind::Struct => "struct",
        SymbolKind::Enum => "enum",
        SymbolKind::Trait => "trait",
        SymbolKind::Interface => "interface",
        SymbolKind::Type => "type",
        SymbolKind::Const => "const",
        SymbolKind::Test => "test",
        SymbolKind::Key => "key",
    }
}

/// Human-readable snippet rendering used by golden tests and the `facts` example.
pub mod debug {
    use std::fmt::Write;

    use super::{SnippetLine, kind_name};
    use crate::model::Symbol;

    /// Formats a change header and its `SnippetLine` entries without a trailing newline.
    pub fn render(symbol: Option<&Symbol>, lines: &[SnippetLine]) -> String {
        let mut out = String::new();
        match symbol {
            None => out.push_str("## file"),
            Some(sym) => match &sym.container {
                Some(container) => {
                    let _ = write!(out, "## {} {container}::{}", kind_name(sym.kind), sym.name);
                }
                None => {
                    let _ = write!(out, "## {} {}", kind_name(sym.kind), sym.name);
                }
            },
        }
        for line in lines {
            out.push('\n');
            match line {
                SnippetLine::Context { text } => {
                    out.push_str("  ");
                    out.push_str(text);
                }
                SnippetLine::Added { text } => {
                    out.push_str("+ ");
                    out.push_str(text);
                }
                SnippetLine::Removed { text } => {
                    out.push_str("- ");
                    out.push_str(text);
                }
                SnippetLine::Fold { lines } => {
                    let _ = write!(out, "… {lines} lines");
                }
                SnippetLine::More { lines } => {
                    let _ = write!(out, "… {lines} more lines");
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use std::fmt::Write;

    use super::*;
    use crate::analyze;
    use crate::model::{FileInput, MAX_DIFF_ITEMS, Side, Symbol, SymbolKind};

    #[test]
    fn snippet_json_shape() {
        assert_eq!(
            serde_json::to_string(&SnippetLine::Context {
                text: "fn f() {".to_string()
            })
            .unwrap(),
            r#"{"t":"context","text":"fn f() {"}"#
        );
        assert_eq!(
            serde_json::to_string(&SnippetLine::Added {
                text: "x".to_string()
            })
            .unwrap(),
            r#"{"t":"added","text":"x"}"#
        );
        assert_eq!(
            serde_json::to_string(&SnippetLine::Removed {
                text: "y".to_string()
            })
            .unwrap(),
            r#"{"t":"removed","text":"y"}"#
        );
        assert_eq!(
            serde_json::to_string(&SnippetLine::Fold { lines: 4 }).unwrap(),
            r#"{"t":"fold","lines":4}"#
        );
        assert_eq!(
            serde_json::to_string(&SnippetLine::More { lines: 12 }).unwrap(),
            r#"{"t":"more","lines":12}"#
        );
    }

    #[test]
    fn unknown_before_shows_head_lines_and_folds_calls_and_awaits() {
        let after = "\
async function flow(a: number, xs: number[]) {
  const prep = a + 1;
  await fetchItem(prep);
  if (!a) {
    log(a);
    return 0;
  } else {
    log(a);
  }
  while (a > 0) {
    a--;
  }
  for (const x of xs) {
    work(x);
  }
  switch (a) {
    case 1:
      break;
  }
  try {
    await save(a);
  } catch (e) {
    throw e;
  }
  return a;
}";
        let sym = Symbol {
            kind: SymbolKind::Function,
            name: "flow".to_string(),
            container: None,
            exported: false,
            nth: 0,
        };
        let input = FileInput {
            path: "src/flow.ts",
            before: Side::Unknown,
            after: Side::Text(after),
        };
        let lines = snippet(&input, Some(&sym));
        assert_eq!(
            lines,
            vec![
                SnippetLine::Context {
                    text: "async function flow(a: number, xs: number[]) {".to_string()
                },
                SnippetLine::Fold { lines: 2 },
                SnippetLine::Context {
                    text: "  if (!a) {".to_string()
                },
                SnippetLine::Fold { lines: 1 },
                SnippetLine::Context {
                    text: "    return 0;".to_string()
                },
                SnippetLine::Context {
                    text: "  } else {".to_string()
                },
                SnippetLine::Fold { lines: 2 },
                SnippetLine::Context {
                    text: "  while (a > 0) {".to_string()
                },
                SnippetLine::Fold { lines: 2 },
                SnippetLine::Context {
                    text: "  for (const x of xs) {".to_string()
                },
                SnippetLine::Fold { lines: 2 },
                SnippetLine::More { lines: 11 },
            ]
        );
        assert!(
            !lines
                .iter()
                .any(|l| matches!(l, SnippetLine::Added { .. } | SnippetLine::Removed { .. }))
        );
    }

    #[test]
    fn absent_sides_and_removed_symbol() {
        let mut long_doc = String::new();
        for i in 1..=15 {
            let _ = writeln!(long_doc, "line {i}");
        }

        let added = snippet(
            &FileInput {
                path: "notes/a.txt",
                before: Side::Absent,
                after: Side::Text(&long_doc),
            },
            None,
        );
        assert_eq!(added.len(), 12);
        assert_eq!(
            added[0],
            SnippetLine::Added {
                text: "line 1".to_string()
            }
        );
        assert_eq!(
            added[10],
            SnippetLine::Added {
                text: "line 11".to_string()
            }
        );
        assert_eq!(added[11], SnippetLine::More { lines: 4 });

        let removed = snippet(
            &FileInput {
                path: "notes/a.txt",
                before: Side::Text(&long_doc),
                after: Side::Absent,
            },
            None,
        );
        assert_eq!(removed.len(), 12);
        assert_eq!(
            removed[0],
            SnippetLine::Removed {
                text: "line 1".to_string()
            }
        );
        assert_eq!(removed[11], SnippetLine::More { lines: 4 });

        let fn_removed = snippet(
            &FileInput {
                path: "src/a.ts",
                before: Side::Text("function gone() {\n  return 1;\n}\n"),
                after: Side::Text("function kept() {}\n"),
            },
            Some(&Symbol {
                kind: SymbolKind::Function,
                name: "gone".to_string(),
                container: None,
                exported: false,
                nth: 0,
            }),
        );
        assert_eq!(
            fn_removed,
            vec![
                SnippetLine::Removed {
                    text: "function gone() {".to_string()
                },
                SnippetLine::Removed {
                    text: "  return 1;".to_string()
                },
                SnippetLine::Removed {
                    text: "}".to_string()
                },
            ]
        );
    }

    #[test]
    fn cap_counts_dropped_fold_source_lines() {
        let mut before = String::from("function f() {\n");
        let mut after = String::from("function f() {\n");
        for i in 1..=11 {
            let _ = writeln!(before, "  const old_{i} = {i};");
            let _ = writeln!(after, "  const new_{i} = {i};");
        }
        for k in 1..=5 {
            let _ = writeln!(before, "  const same_{k} = {k};");
            let _ = writeln!(after, "  const same_{k} = {k};");
        }
        before.push_str("}\n");
        after.push_str("}\n");

        let sym = Symbol {
            kind: SymbolKind::Function,
            name: "f".to_string(),
            container: None,
            exported: false,
            nth: 0,
        };
        let lines = snippet(
            &FileInput {
                path: "src/cap.ts",
                before: Side::Text(&before),
                after: Side::Text(&after),
            },
            Some(&sym),
        );
        assert_eq!(lines.len(), 12);
        // 1 Context + 11 Removed + 11 Added + 1 Fold(5) + 1 Context = 29 source lines total;
        // first 11 entries keep 1 Context + 10 Removed (11 source lines), leaving 1 Removed + 11 Added + 5 folded + 1 Context = 18.
        assert_eq!(lines[11], SnippetLine::More { lines: 18 });
    }

    fn numbered_lines(prefix: &str, count: usize) -> String {
        let mut out = String::new();
        for i in 0..count {
            let _ = writeln!(out, "{prefix}{i}");
        }
        out
    }

    #[test]
    fn above_max_diff_items_returns_single_more() {
        let before = numbered_lines("b", MAX_DIFF_ITEMS + 1);
        let after = numbered_lines("a", MAX_DIFF_ITEMS + 2);

        let lines = snippet(
            &FileInput {
                path: "notes/huge.txt",
                before: Side::Text(&before),
                after: Side::Text(&after),
            },
            None,
        );
        assert_eq!(
            lines,
            vec![SnippetLine::More {
                lines: (MAX_DIFF_ITEMS + 2) as u32
            }]
        );
    }

    #[test]
    fn before_absent_above_max_diff_items_returns_single_more() {
        let after = numbered_lines("a", MAX_DIFF_ITEMS + 1);
        let lines = snippet(
            &FileInput {
                path: "notes/huge.txt",
                before: Side::Absent,
                after: Side::Text(&after),
            },
            None,
        );
        assert_eq!(
            lines,
            vec![SnippetLine::More {
                lines: (MAX_DIFF_ITEMS + 1) as u32
            }]
        );
    }

    #[test]
    fn before_unknown_above_max_diff_items_returns_single_more() {
        let after = numbered_lines("a", MAX_DIFF_ITEMS + 1);
        let lines = snippet(
            &FileInput {
                path: "notes/huge.txt",
                before: Side::Unknown,
                after: Side::Text(&after),
            },
            None,
        );
        assert_eq!(
            lines,
            vec![SnippetLine::More {
                lines: (MAX_DIFF_ITEMS + 1) as u32
            }]
        );
    }

    #[test]
    fn after_absent_above_max_diff_items_returns_before_count() {
        let before = numbered_lines("b", MAX_DIFF_ITEMS + 1);
        let lines = snippet(
            &FileInput {
                path: "notes/huge.txt",
                before: Side::Text(&before),
                after: Side::Absent,
            },
            None,
        );
        assert_eq!(
            lines,
            vec![SnippetLine::More {
                lines: (MAX_DIFF_ITEMS + 1) as u32
            }]
        );
    }

    #[test]
    fn removed_symbol_above_max_diff_items_returns_before_count() {
        let mut before = String::from("function gone() {\n");
        for i in 0..MAX_DIFF_ITEMS {
            let _ = writeln!(before, "  const x_{i} = {i};");
        }
        before.push_str("}\n");
        let sym = Symbol {
            kind: SymbolKind::Function,
            name: "gone".to_string(),
            container: None,
            exported: false,
            nth: 0,
        };
        let lines = snippet(
            &FileInput {
                path: "src/huge.ts",
                before: Side::Text(&before),
                after: Side::Text("function kept() {}\n"),
            },
            Some(&sym),
        );
        assert_eq!(
            lines,
            vec![SnippetLine::More {
                lines: (MAX_DIFF_ITEMS + 2) as u32
            }]
        );
    }

    #[test]
    fn exactly_max_diff_items_renders_normally() {
        let lines_exact = numbered_lines("line_", MAX_DIFF_ITEMS);

        let added = snippet(
            &FileInput {
                path: "notes/exact.txt",
                before: Side::Absent,
                after: Side::Text(&lines_exact),
            },
            None,
        );
        assert_eq!(added.len(), MAX_SNIPPET_ENTRIES);
        assert_eq!(
            added[0],
            SnippetLine::Added {
                text: "line_0".to_string()
            }
        );
        assert_eq!(
            added[MAX_SNIPPET_ENTRIES - 1],
            SnippetLine::More {
                lines: (MAX_DIFF_ITEMS - (MAX_SNIPPET_ENTRIES - 1)) as u32
            }
        );

        let unknown = snippet(
            &FileInput {
                path: "notes/exact.txt",
                before: Side::Unknown,
                after: Side::Text(&lines_exact),
            },
            None,
        );
        assert_eq!(
            unknown,
            vec![SnippetLine::Fold {
                lines: MAX_DIFF_ITEMS as u32
            }]
        );

        let removed = snippet(
            &FileInput {
                path: "notes/exact.txt",
                before: Side::Text(&lines_exact),
                after: Side::Absent,
            },
            None,
        );
        assert_eq!(removed.len(), MAX_SNIPPET_ENTRIES);
        assert_eq!(
            removed[0],
            SnippetLine::Removed {
                text: "line_0".to_string()
            }
        );
        assert_eq!(
            removed[MAX_SNIPPET_ENTRIES - 1],
            SnippetLine::More {
                lines: (MAX_DIFF_ITEMS - (MAX_SNIPPET_ENTRIES - 1)) as u32
            }
        );

        let mut after_edited = String::from("edited_0\n");
        for i in 1..MAX_DIFF_ITEMS {
            let _ = writeln!(after_edited, "line_{i}");
        }
        let diffed = snippet(
            &FileInput {
                path: "notes/exact.txt",
                before: Side::Text(&lines_exact),
                after: Side::Text(&after_edited),
            },
            None,
        );
        assert_eq!(
            diffed,
            vec![
                SnippetLine::Removed {
                    text: "line_0".to_string()
                },
                SnippetLine::Added {
                    text: "edited_0".to_string()
                },
                SnippetLine::Fold {
                    lines: (MAX_DIFF_ITEMS - 1) as u32
                },
            ]
        );
    }

    #[test]
    fn non_grammar_with_symbol_and_duplicate_rust_nth() {
        let pkg_before = "{\n  \"name\": \"a\",\n  \"version\": \"1.0.0\"\n}\n";
        let pkg_after = "{\n  \"name\": \"a\",\n  \"version\": \"1.1.0\"\n}\n";
        let pkg_input = FileInput {
            path: "package.json",
            before: Side::Text(pkg_before),
            after: Side::Text(pkg_after),
        };
        let facts = analyze(&pkg_input);
        let pkg_lines = snippet(&pkg_input, facts.changes[0].symbol.as_ref());
        assert_eq!(
            pkg_lines,
            vec![
                SnippetLine::Fold { lines: 2 },
                SnippetLine::Removed {
                    text: "  \"version\": \"1.0.0\"".to_string()
                },
                SnippetLine::Added {
                    text: "  \"version\": \"1.1.0\"".to_string()
                },
                SnippetLine::Fold { lines: 1 },
            ]
        );

        let rs_before = "\
struct S;
impl S {
    fn work(&self) -> i32 {
        1
    }
    fn work(&self) -> i32 {
        2
    }
}
";
        let rs_after = "\
struct S;
impl S {
    fn work(&self) -> i32 {
        1
    }
    fn work(&self) -> i32 {
        20
    }
}
";
        let rs_input = FileInput {
            path: "src/lib.rs",
            before: Side::Text(rs_before),
            after: Side::Text(rs_after),
        };
        let rs_facts = analyze(&rs_input);
        assert_eq!(rs_facts.changes.len(), 1);
        let sym = rs_facts.changes[0].symbol.as_ref().unwrap();
        assert_eq!(sym.nth, 1);
        let rs_lines = snippet(&rs_input, Some(sym));
        assert_eq!(
            rs_lines,
            vec![
                SnippetLine::Context {
                    text: "    fn work(&self) -> i32 {".to_string()
                },
                SnippetLine::Removed {
                    text: "        2".to_string()
                },
                SnippetLine::Added {
                    text: "        20".to_string()
                },
                SnippetLine::Context {
                    text: "    }".to_string()
                },
            ]
        );
    }

    #[test]
    fn crlf_bom_and_debug_render_formatting() {
        let input = FileInput {
            path: "src/a.ts",
            before: Side::Text(
                "\u{FEFF}class Cart {\r\n  apply() {\r\n    return 1;\r\n  }\r\n}\r\n",
            ),
            after: Side::Text(
                "class Cart {\n  apply() {\n    if (true) return 0;\n    return 1;\n  }\n}\n",
            ),
        };
        let sym = Symbol {
            kind: SymbolKind::Method,
            name: "apply".to_string(),
            container: Some("Cart".to_string()),
            exported: false,
            nth: 0,
        };
        let lines = snippet(&input, Some(&sym));
        let rendered = debug::render(Some(&sym), &lines);
        assert_eq!(
            rendered,
            "## method Cart::apply\n    apply() {\n+     if (true) return 0;\n      return 1;\n    }"
        );
        assert!(!rendered.contains('\r'));
    }

    #[test]
    fn snippets_parse_once() {
        let before = "\
function f1(a: number) {
  return a + 1;
}
function f2(a: number) {
  return a + 2;
}
function f3(a: number) {
  return a + 3;
}
function f4(a: number) {
  return a + 4;
}
function f5(a: number) {
  return a + 5;
}
";
        let after = "\
function f1(a: number) {
  return a + 10;
}
function f2(a: number) {
  return a + 20;
}
function f3(a: number) {
  return a + 30;
}
function f4(a: number) {
  return a + 40;
}
function f5(a: number) {
  return a + 50;
}
";
        let input = FileInput {
            path: "src/five.ts",
            before: Side::Text(before),
            after: Side::Text(after),
        };
        let facts = analyze(&input);
        let symbols: Vec<Option<&Symbol>> =
            facts.changes.iter().map(|c| c.symbol.as_ref()).collect();
        assert_eq!(symbols.len(), 5);
        assert!(symbols.iter().all(Option::is_some));

        syntax::reset_parse_count();
        let batched = snippets(&input, &symbols);
        assert_eq!(syntax::parse_count(), 2);

        let expected: Vec<Vec<SnippetLine>> =
            symbols.iter().map(|&sym| snippet(&input, sym)).collect();
        assert_eq!(batched, expected);
    }

    #[test]
    fn snippets_edge_cases_and_order() {
        let ts_before = "\
import { x } from './x';
export function alpha(a: number) {
  return a + x;
}
export function beta(b: number) {
  return b + 1;
}
";
        let ts_after = "\
import { y } from './y';
export function alpha(a: number) {
  if (a < 0) return 0;
  return a + y;
}
export function beta(b: number) {
  return b + 2;
}
";
        let input = FileInput {
            path: "src/mix.ts",
            before: Side::Text(ts_before),
            after: Side::Text(ts_after),
        };
        let facts = analyze(&input);
        assert_eq!(facts.changes.len(), 3);

        syntax::reset_parse_count();
        assert!(snippets(&input, &[]).is_empty());
        assert_eq!(syntax::parse_count(), 0);

        syntax::reset_parse_count();
        let file_only = snippets(&input, &[None]);
        assert_eq!(syntax::parse_count(), 0);
        assert_eq!(file_only, vec![snippet(&input, None)]);

        let missing = Symbol {
            kind: SymbolKind::Function,
            name: "missing".to_string(),
            container: None,
            exported: false,
            nth: 0,
        };
        let requested = vec![
            facts.changes[1].symbol.as_ref(),
            None,
            Some(&missing),
            facts.changes[2].symbol.as_ref(),
            facts.changes[1].symbol.as_ref(),
        ];

        syntax::reset_parse_count();
        let batched = snippets(&input, &requested);
        assert_eq!(syntax::parse_count(), 2);
        let expected: Vec<Vec<SnippetLine>> =
            requested.iter().map(|&sym| snippet(&input, sym)).collect();
        assert_eq!(batched, expected);

        let single_side_input = FileInput {
            path: "src/new.ts",
            before: Side::Absent,
            after: Side::Text(ts_after),
        };
        let two_syms = vec![
            facts.changes[1].symbol.as_ref(),
            facts.changes[2].symbol.as_ref(),
        ];
        syntax::reset_parse_count();
        let single_side_batched = snippets(&single_side_input, &two_syms);
        assert_eq!(syntax::parse_count(), 1);
        let single_side_expected: Vec<Vec<SnippetLine>> = two_syms
            .iter()
            .map(|&sym| snippet(&single_side_input, sym))
            .collect();
        assert_eq!(single_side_batched, single_side_expected);

        let rs_src_before =
            "struct S;\nimpl S {\n    fn w(&self) -> i32 { 1 }\n    fn w(&self) -> i32 { 2 }\n}\n";
        let rs_src_after = "struct S;\nimpl S {\n    fn w(&self) -> i32 { 10 }\n    fn w(&self) -> i32 { 20 }\n}\n";
        let rs_input = FileInput {
            path: "src/lib.rs",
            before: Side::Text(rs_src_before),
            after: Side::Text(rs_src_after),
        };
        let rs_facts = analyze(&rs_input);
        let rs_syms: Vec<Option<&Symbol>> =
            rs_facts.changes.iter().map(|c| c.symbol.as_ref()).collect();
        assert_eq!(rs_syms.len(), 2);
        syntax::reset_parse_count();
        let rs_batched = snippets(&rs_input, &rs_syms);
        assert_eq!(syntax::parse_count(), 2);
        let rs_expected: Vec<Vec<SnippetLine>> =
            rs_syms.iter().map(|&sym| snippet(&rs_input, sym)).collect();
        assert_eq!(rs_batched, rs_expected);
    }
}
