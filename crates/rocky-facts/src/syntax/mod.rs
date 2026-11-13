mod ecma;

use std::cmp::Reverse;
use std::collections::{BTreeMap, BTreeSet};

use tree_sitter::{Node, Parser};

use crate::model::{Lang, Symbol, SymbolKind};

/// Parsed parameter name and normalized parameter signature text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Param {
    pub name: String,
    pub text: String,
}

/// Test modifier status for test symbols.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TestMode {
    Normal,
    #[allow(dead_code)] // Constructed by the upcoming test extractor.
    Skip,
    #[allow(dead_code)] // Constructed by the upcoming test extractor.
    Only,
}

/// Extracted symbol metadata and token streams for a single syntax item.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SymbolInfo {
    pub symbol: Symbol,
    pub lines: (u32, u32),
    pub code: Vec<String>,
    pub all: Vec<String>,
    pub code_without_name: Vec<String>,
    pub params: Vec<Param>,
    pub return_type: Option<String>,
    pub literal: Option<String>,
    #[allow(dead_code)] // Read by the upcoming test comparator.
    pub test_mode: TestMode,
}

/// Language-neutral syntax representation used to compare two versions of a source file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FileSyntax {
    pub has_error: bool,
    pub all: Vec<String>,
    pub symbols: Vec<SymbolInfo>,
    pub imports: BTreeSet<String>,
    pub outside: Vec<String>,
}

pub(crate) struct ExtractedSymbol {
    pub symbol: Symbol,
    pub lines: (u32, u32),
    pub span: (usize, usize),
    pub name_span: Option<(usize, usize)>,
    pub params: Vec<Param>,
    pub return_type: Option<String>,
    pub literal: Option<String>,
    pub test_mode: TestMode,
}

pub(crate) struct Extracted {
    pub symbols: Vec<ExtractedSymbol>,
    pub imports: BTreeSet<String>,
    pub excluded_outside_spans: Vec<(usize, usize)>,
}

pub(crate) fn is_comment_kind(kind: &str) -> bool {
    matches!(kind, "comment" | "line_comment" | "block_comment")
}

pub(crate) fn node_text<'a>(node: Node<'a>, src: &'a str) -> &'a str {
    node.utf8_text(src.as_bytes()).unwrap_or("")
}

pub(crate) fn node_lines(node: Node<'_>) -> (u32, u32) {
    let start = node.start_position();
    let end = node.end_position();
    let start_line = start.row as u32 + 1;
    let end_line = if end.column == 0 && end.row > start.row {
        end.row as u32
    } else {
        end.row as u32 + 1
    };
    (start_line, end_line)
}

/// Walks leaf tokens under `root` in source order using an iterative `TreeCursor`.
pub(crate) fn walk_leaves(
    root: Node<'_>,
    src: &str,
    mut on_leaf: impl FnMut(usize, usize, &str, bool),
) {
    let mut cursor = root.walk();
    let mut comment_depth = 0usize;
    loop {
        let node = cursor.node();
        if is_comment_kind(node.kind()) {
            comment_depth += 1;
        }
        if node.child_count() == 0 {
            let start = node.start_byte();
            let end = node.end_byte();
            if start < end {
                let text = node_text(node, src);
                if !text.is_empty() {
                    on_leaf(start, end, text, comment_depth > 0);
                }
            }
        } else if cursor.goto_first_child() {
            continue;
        }

        loop {
            if is_comment_kind(cursor.node().kind()) {
                comment_depth -= 1;
            }
            if cursor.goto_next_sibling() {
                break;
            }
            if !cursor.goto_parent() {
                return;
            }
        }
    }
}

/// Joins non-comment leaf tokens under `node` with single spaces.
pub(crate) fn normalized_code_text(node: Node<'_>, src: &str) -> String {
    let mut tokens = Vec::new();
    walk_leaves(node, src, |_, _, text, is_comment| {
        if !is_comment {
            tokens.push(text.to_string());
        }
    });
    tokens.join(" ")
}

fn ts_language_for(lang: Lang) -> Option<tree_sitter::Language> {
    match lang {
        Lang::Typescript => Some(tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()),
        Lang::Tsx => Some(tree_sitter_typescript::LANGUAGE_TSX.into()),
        Lang::Javascript => Some(tree_sitter_javascript::LANGUAGE.into()),
        _ => None,
    }
}

/// Parses `src` with the grammar for `lang` into a language-neutral `FileSyntax`.
pub(crate) fn parse(lang: Lang, src: &str) -> FileSyntax {
    let Some(ts_lang) = ts_language_for(lang) else {
        return FileSyntax {
            has_error: true,
            all: Vec::new(),
            symbols: Vec::new(),
            imports: BTreeSet::new(),
            outside: Vec::new(),
        };
    };

    let mut parser = Parser::new();
    if parser.set_language(&ts_lang).is_err() {
        return FileSyntax {
            has_error: true,
            all: Vec::new(),
            symbols: Vec::new(),
            imports: BTreeSet::new(),
            outside: Vec::new(),
        };
    }

    let Some(tree) = parser.parse(src, None) else {
        return FileSyntax {
            has_error: true,
            all: Vec::new(),
            symbols: Vec::new(),
            imports: BTreeSet::new(),
            outside: Vec::new(),
        };
    };

    let root = tree.root_node();
    let has_error = root.has_error();
    let mut extracted = ecma::extract(root, src);

    // Order outer before inner when spans share a start byte so nested exclusions remain exact.
    extracted
        .symbols
        .sort_by_key(|sym| (sym.span.0, Reverse(sym.span.1)));
    extracted.excluded_outside_spans.sort_unstable();

    let mut seen: BTreeMap<(SymbolKind, Option<String>, String), u32> = BTreeMap::new();
    for raw in &mut extracted.symbols {
        let key = (
            raw.symbol.kind,
            raw.symbol.container.clone(),
            raw.symbol.name.clone(),
        );
        let nth = seen.entry(key).or_insert(0);
        raw.symbol.nth = *nth;
        *nth += 1;
    }

    let sym_count = extracted.symbols.len();
    let mut sym_code: Vec<Vec<String>> = vec![Vec::new(); sym_count];
    let mut sym_all: Vec<Vec<String>> = vec![Vec::new(); sym_count];
    let mut sym_code_without_name: Vec<Vec<String>> = vec![Vec::new(); sym_count];

    let mut file_all = Vec::new();
    let mut outside = Vec::new();

    let mut next_sym_idx = 0usize;
    let mut sym_stack: Vec<usize> = Vec::new();
    let mut next_excl_idx = 0usize;
    let mut excl_end = 0usize;

    walk_leaves(root, src, |start, end, text, is_comment| {
        let token = text.to_string();
        file_all.push(token.clone());

        while let Some(&top) = sym_stack.last() {
            if extracted.symbols[top].span.1 <= start {
                sym_stack.pop();
            } else {
                break;
            }
        }
        while next_sym_idx < sym_count && extracted.symbols[next_sym_idx].span.0 <= start {
            if extracted.symbols[next_sym_idx].span.1 > start {
                sym_stack.push(next_sym_idx);
            }
            next_sym_idx += 1;
        }
        while next_excl_idx < extracted.excluded_outside_spans.len()
            && extracted.excluded_outside_spans[next_excl_idx].0 <= start
        {
            excl_end = excl_end.max(extracted.excluded_outside_spans[next_excl_idx].1);
            next_excl_idx += 1;
        }

        if let Some(&owner_idx) = sym_stack.last() {
            sym_all[owner_idx].push(token.clone());
            if !is_comment {
                let in_name = extracted.symbols[owner_idx]
                    .name_span
                    .is_some_and(|(ns, ne)| start >= ns && end <= ne);
                if !in_name {
                    sym_code_without_name[owner_idx].push(token.clone());
                }
                sym_code[owner_idx].push(token);
            }
        } else if !is_comment && start >= excl_end {
            outside.push(token);
        }
    });

    let symbols = extracted
        .symbols
        .into_iter()
        .zip(sym_code)
        .zip(sym_all)
        .zip(sym_code_without_name)
        .map(|(((raw, code), all), code_without_name)| SymbolInfo {
            symbol: raw.symbol,
            lines: raw.lines,
            code,
            all,
            code_without_name,
            params: raw.params,
            return_type: raw.return_type,
            literal: raw.literal,
            test_mode: raw.test_mode,
        })
        .collect();

    FileSyntax {
        has_error,
        all: file_all,
        symbols,
        imports: extracted.imports,
        outside,
    }
}

#[cfg(test)]
mod tests {
    use crate::analyze;
    use crate::model::{FileInput, Label, Side};

    #[test]
    fn grammars_load() {
        let languages: Vec<(&str, tree_sitter::Language)> = vec![
            (
                "typescript",
                tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            ),
            ("tsx", tree_sitter_typescript::LANGUAGE_TSX.into()),
            ("javascript", tree_sitter_javascript::LANGUAGE.into()),
        ];

        for (name, lang) in languages {
            let mut parser = tree_sitter::Parser::new();
            parser
                .set_language(&lang)
                .unwrap_or_else(|err| panic!("failed to load {name} grammar: {err}"));
        }
    }

    #[test]
    fn deep_nesting_does_not_overflow() {
        let open = "[".repeat(50_000);
        let close = "]".repeat(50_000);
        let before = format!("const deep = {open}1{close};\nconst flag = 1;\n");
        let after = format!("const deep = {open}1{close};\nconst flag = 2;\n");

        let handle = std::thread::Builder::new()
            .stack_size(1 << 20)
            .spawn(move || {
                analyze(&FileInput {
                    path: "src/deep.ts",
                    before: Side::Text(&before),
                    after: Side::Text(&after),
                })
            })
            .expect("spawn 1 MiB stack thread");

        let facts = handle.join().expect("thread should not overflow stack");
        assert!(!facts.changes.is_empty());
    }

    #[test]
    fn wide_inputs_do_not_go_quadratic() {
        use std::fmt::Write;

        use crate::model::{MAX_BYTES, SymbolKind};

        let mut stmts_before = String::with_capacity(1_000_000);
        for i in 0..100_000 {
            let _ = writeln!(stmts_before, "x{i}=0;");
        }
        assert!(stmts_before.len() <= MAX_BYTES);
        let stmts_after = stmts_before.replacen("x50000=0;", "x50000=1;", 1);

        let stmts_facts = analyze(&FileInput {
            path: "src/wide_stmts.ts",
            before: Side::Text(&stmts_before),
            after: Side::Text(&stmts_after),
        });
        assert_eq!(stmts_facts.changes.len(), 1);
        assert_eq!(stmts_facts.changes[0].symbol, None);
        assert_eq!(stmts_facts.changes[0].labels, vec![Label::BodyChanged {}]);

        let mut array_before = String::with_capacity(700_000);
        array_before.push_str("export const big = [");
        for i in 0..100_000 {
            if i > 0 {
                array_before.push_str(", ");
            }
            let _ = write!(array_before, "{i}");
        }
        array_before.push_str("];\n");
        assert!(array_before.len() <= MAX_BYTES);
        let array_after = array_before.replacen(", 50000,", ", 100000,", 1);

        let array_facts = analyze(&FileInput {
            path: "src/wide_array.ts",
            before: Side::Text(&array_before),
            after: Side::Text(&array_after),
        });
        assert_eq!(array_facts.changes.len(), 1);
        assert_eq!(
            array_facts.changes[0]
                .symbol
                .as_ref()
                .map(|s| (s.kind, s.name.as_str(), s.exported)),
            Some((SymbolKind::Const, "big", true))
        );
        assert_eq!(array_facts.changes[0].labels, vec![Label::BodyChanged {}]);
    }

    #[test]
    fn large_symbol_uses_multiset_pct() {
        let before_body: String = (0..30_000)
            .map(|i| format!("a{i}"))
            .collect::<Vec<_>>()
            .join(" + ");
        let after_body: String = (0..30_000)
            .map(|i| format!("b{i}"))
            .collect::<Vec<_>>()
            .join(" - ");

        let before = format!("function big() {{\n  return {before_body};\n}}\n");
        let after = format!("function big() {{\n  return {after_body};\n}}\n");

        let facts = analyze(&FileInput {
            path: "src/big.ts",
            before: Side::Text(&before),
            after: Side::Text(&after),
        });
        assert_eq!(facts.changes.len(), 1);
        assert_eq!(facts.changes[0].labels, vec![Label::Rewrite { pct: 100 }]);
    }

    #[test]
    fn ecma_extracts_all_symbol_kinds_and_nesting() {
        use crate::model::SymbolKind;

        let src = r#"
import fs from "node:fs";

export function* genFn(a: number): Generator<number> {
  function nestedInsideFn() {}
  const localConst = 1;
  yield a;
}

export abstract class Service {
  protected run(x: number): void {}
  private secret(): void {}
  #hidden(): void {}
}

interface Spec { id: string }
type Id = string | number;
enum Mode { Fast, Safe }

const litStr = "ok";
const litNeg = -42;
const litTpl = `plain`;
const nonLitTpl = `hi ${litStr}`;
const arrowSingle = x => x;
const fnExpr = function named(p: number) { return p; };
let mutableVar = 1;

export default function () {}
"#;

        let parsed = super::parse(crate::model::Lang::Typescript, src);
        assert!(!parsed.has_error);
        assert!(parsed.imports.contains("node:fs"));

        let summary: Vec<(SymbolKind, &str, Option<&str>, bool)> = parsed
            .symbols
            .iter()
            .map(|s| {
                (
                    s.symbol.kind,
                    s.symbol.name.as_str(),
                    s.symbol.container.as_deref(),
                    s.symbol.exported,
                )
            })
            .collect();

        assert_eq!(
            summary,
            vec![
                (SymbolKind::Function, "genFn", None, true),
                (SymbolKind::Class, "Service", None, true),
                (SymbolKind::Method, "run", Some("Service"), true),
                (SymbolKind::Method, "secret", Some("Service"), false),
                (SymbolKind::Method, "#hidden", Some("Service"), false),
                (SymbolKind::Interface, "Spec", None, false),
                (SymbolKind::Type, "Id", None, false),
                (SymbolKind::Enum, "Mode", None, false),
                (SymbolKind::Const, "litStr", None, false),
                (SymbolKind::Const, "litNeg", None, false),
                (SymbolKind::Const, "litTpl", None, false),
                (SymbolKind::Const, "nonLitTpl", None, false),
                (SymbolKind::Function, "arrowSingle", None, false),
                (SymbolKind::Function, "fnExpr", None, false),
                (SymbolKind::Function, "default", None, true),
            ]
        );

        let by_name = |name: &str| {
            parsed
                .symbols
                .iter()
                .find(|s| s.symbol.name == name)
                .unwrap()
        };
        assert_eq!(by_name("litStr").literal.as_deref(), Some("\"ok\""));
        assert_eq!(by_name("litNeg").literal.as_deref(), Some("-42"));
        assert_eq!(by_name("litTpl").literal.as_deref(), Some("`plain`"));
        assert_eq!(by_name("nonLitTpl").literal, None);
        assert_eq!(by_name("arrowSingle").params.len(), 1);
        assert_eq!(by_name("arrowSingle").params[0].name, "x");
        assert!(
            parsed.outside.contains(&"mutableVar".to_string()),
            "let declaration should stay in outside"
        );
        assert!(
            !by_name("Service")
                .all
                .iter()
                .any(|t| t == "run" || t == "secret"),
            "class own tokens must exclude nested methods"
        );
    }

    #[test]
    fn anonymous_export_default_class_and_methods() {
        use crate::model::SymbolKind;

        let src = "export default class {\n  ping() {}\n  #priv() {}\n}\n";
        let parsed = super::parse(crate::model::Lang::Javascript, src);
        assert!(!parsed.has_error);
        let summary: Vec<(SymbolKind, &str, Option<&str>, bool)> = parsed
            .symbols
            .iter()
            .map(|s| {
                (
                    s.symbol.kind,
                    s.symbol.name.as_str(),
                    s.symbol.container.as_deref(),
                    s.symbol.exported,
                )
            })
            .collect();
        assert_eq!(
            summary,
            vec![
                (SymbolKind::Class, "default", None, true),
                (SymbolKind::Method, "ping", Some("default"), true),
                (SymbolKind::Method, "#priv", Some("default"), false),
            ]
        );
    }
}
