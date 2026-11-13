mod ecma;
mod rust;

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
    Skip,
    Only,
}

/// Control-flow and call classification within a symbol's skeleton.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum SkelKind {
    If,
    Else,
    Match,
    Arm,
    Loop,
    While,
    Return,
    Throw,
    Try,
    Catch,
    ErrorOp,
    Await,
    Call,
}

impl SkelKind {
    pub(crate) fn kind_name(self) -> &'static str {
        match self {
            Self::If => "if",
            Self::Else => "else",
            Self::Match => "match",
            Self::Arm => "arm",
            Self::Loop => "loop",
            Self::While => "while",
            Self::Return => "return",
            Self::Throw => "throw",
            Self::Try => "try",
            Self::Catch => "catch",
            Self::ErrorOp => "error_op",
            Self::Await => "await",
            Self::Call => "call",
        }
    }
}

/// Single entry in a symbol's pre-order control-flow and call skeleton.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SkelNode {
    pub kind: SkelKind,
    /// Alignment key (`"if:guard"` for guard `If`, `"call:<name>"` for `Call`, `"err:<op>"` for `ErrorOp`, else kind name).
    pub key: String,
    pub text: String,
    pub guard: bool,
    #[allow(dead_code)] // Read by snippet extraction.
    pub line: u32,
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
    pub test_mode: TestMode,
    pub skeleton: Vec<SkelNode>,
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
    pub skeleton: Vec<SkelNode>,
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

pub(crate) fn new_symbol(
    kind: SymbolKind,
    name: String,
    container: Option<String>,
    exported: bool,
) -> Symbol {
    Symbol {
        kind,
        name,
        container,
        exported,
        nth: 0,
    }
}

pub(crate) fn first_non_comment_named_child(node: Node<'_>) -> Option<Node<'_>> {
    let mut cursor = node.walk();
    node.named_children(&mut cursor)
        .find(|child| !is_comment_kind(child.kind()))
}

pub(crate) fn single_non_comment_named_child(node: Node<'_>) -> Option<Node<'_>> {
    let mut cursor = node.walk();
    let mut found = None;
    for child in node.named_children(&mut cursor) {
        if is_comment_kind(child.kind()) {
            continue;
        }
        if found.is_some() {
            return None;
        }
        found = Some(child);
    }
    found
}

pub(crate) fn strip_outer_parens(node: Node<'_>) -> Node<'_> {
    if node.kind() == "parenthesized_expression" {
        single_non_comment_named_child(node).unwrap_or(node)
    } else {
        node
    }
}

pub(crate) fn extract_return_type(fn_node: Node<'_>, src: &str) -> Option<String> {
    fn_node
        .child_by_field_name("return_type")
        .map(|rt| normalized_code_text(rt, src))
        .filter(|s| !s.is_empty())
}

fn empty_error_syntax() -> FileSyntax {
    FileSyntax {
        has_error: true,
        all: Vec::new(),
        symbols: Vec::new(),
        imports: BTreeSet::new(),
        outside: Vec::new(),
    }
}

fn language_for(lang: Lang) -> Option<tree_sitter::Language> {
    match lang {
        Lang::Typescript => Some(tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()),
        Lang::Tsx => Some(tree_sitter_typescript::LANGUAGE_TSX.into()),
        Lang::Javascript => Some(tree_sitter_javascript::LANGUAGE.into()),
        Lang::Rust => Some(tree_sitter_rust::LANGUAGE.into()),
        _ => None,
    }
}

/// Parses `src` with the grammar for `lang` into a language-neutral `FileSyntax`.
pub(crate) fn parse(lang: Lang, src: &str) -> FileSyntax {
    let Some(ts_lang) = language_for(lang) else {
        return empty_error_syntax();
    };

    let mut parser = Parser::new();
    if parser.set_language(&ts_lang).is_err() {
        return empty_error_syntax();
    }

    let Some(tree) = parser.parse(src, None) else {
        return empty_error_syntax();
    };

    let root = tree.root_node();
    let has_error = root.has_error();
    let mut extracted = match lang {
        Lang::Typescript | Lang::Tsx | Lang::Javascript => ecma::extract(root, src),
        Lang::Rust => rust::extract(root, src),
        _ => return empty_error_syntax(),
    };

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
            skeleton: raw.skeleton,
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
            ("rust", tree_sitter_rust::LANGUAGE.into()),
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
    fn wide_inputs_produce_expected_labels() {
        use std::fmt::Write;

        use crate::model::{MAX_BYTES, SymbolKind};

        let mut stmts_before = String::with_capacity(128_000);
        for i in 0..12_000 {
            let _ = writeln!(stmts_before, "x{i}=0;");
        }
        assert!(stmts_before.len() <= MAX_BYTES);
        let stmts_after = stmts_before.replacen("x6000=0;", "x6000=1;", 1);

        let stmts_facts = analyze(&FileInput {
            path: "src/wide_stmts.ts",
            before: Side::Text(&stmts_before),
            after: Side::Text(&stmts_after),
        });
        assert_eq!(stmts_facts.changes.len(), 1);
        assert_eq!(stmts_facts.changes[0].symbol, None);
        assert_eq!(stmts_facts.changes[0].labels, vec![Label::BodyChanged {}]);

        let mut array_before = String::with_capacity(96_000);
        array_before.push_str("export const big = [");
        for i in 0..12_000 {
            if i > 0 {
                array_before.push_str(", ");
            }
            let _ = write!(array_before, "{i}");
        }
        array_before.push_str("];\n");
        assert!(array_before.len() <= MAX_BYTES);
        let array_after = array_before.replacen(", 6000,", ", 12000,", 1);

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

    #[test]
    fn ecma_skeleton_nodes_guards_and_callees() {
        use super::SkelKind;
        use crate::model::Lang;

        let long_name = "f".repeat(100);
        let src = format!(
            r#"async function demo(a: number, xs: number[]) {{
  if (!a) {{
    log(a);
    return;
  }}
  if (a > 10) {{
    s1();
    s2();
    s3();
    return;
  }}
  if (a === 1) return 1; else return 2;
  while (a > 0) {{ a--; }}
  do {{ a++; }} while (a < 2);
  for (const x of xs) {{}}
  switch (a) {{
    case 1: break;
    default: break;
  }}
  try {{
    await this.repo.save(a);
    this?.client?.fetch(a);
    a.b.c.d(a);
    items.filter(x => x.ok).map(y => y);
    new Error("x");
    {long_name}();
  }} catch (e) {{
    throw e;
  }}
  return a;
}}"#
        );

        let parsed = super::parse(Lang::Typescript, &src);
        assert!(!parsed.has_error);
        let skel = &parsed.symbols[0].skeleton;

        let summary: Vec<(SkelKind, &str, &str, bool, u32)> = skel
            .iter()
            .map(|n| (n.kind, n.key.as_str(), n.text.as_str(), n.guard, n.line))
            .collect();

        let cut_long = format!("call:{}…", "f".repeat(79));
        assert_eq!(
            summary,
            vec![
                (SkelKind::If, "if:guard", "! a", true, 2),
                (SkelKind::Call, "call:log", "", false, 3),
                (SkelKind::Return, "return", "", false, 4),
                (SkelKind::If, "if", "a > 10", false, 6),
                (SkelKind::Call, "call:s1", "", false, 7),
                (SkelKind::Call, "call:s2", "", false, 8),
                (SkelKind::Call, "call:s3", "", false, 9),
                (SkelKind::Return, "return", "", false, 10),
                (SkelKind::If, "if", "a === 1", false, 12),
                (SkelKind::Return, "return", "1", false, 12),
                (SkelKind::Else, "else", "", false, 12),
                (SkelKind::Return, "return", "2", false, 12),
                (SkelKind::While, "while", "a > 0", false, 13),
                (SkelKind::Loop, "loop", "", false, 14),
                (SkelKind::Loop, "loop", "", false, 15),
                (SkelKind::Match, "match", "a", false, 16),
                (SkelKind::Arm, "arm", "", false, 17),
                (SkelKind::Arm, "arm", "", false, 18),
                (SkelKind::Try, "try", "", false, 20),
                (SkelKind::Await, "await", "", false, 21),
                (SkelKind::Call, "call:repo.save", "", false, 21),
                (SkelKind::Call, "call:client.fetch", "", false, 22),
                (SkelKind::Call, "call:c.d", "", false, 23),
                (SkelKind::Call, "call:map", "", false, 24),
                (SkelKind::Call, "call:items.filter", "", false, 24),
                (SkelKind::Call, cut_long.as_str(), "", false, 26),
                (SkelKind::Catch, "catch", "", false, 27),
                (SkelKind::Throw, "throw", "", false, 28),
                (SkelKind::Return, "return", "a", false, 30),
            ]
        );
    }

    #[test]
    fn ecma_extracts_tests_containers_and_modes() {
        use super::{SkelKind, TestMode};
        use crate::model::{Lang, SymbolKind};

        let src = r#"
describe("outer", () => {
  context.skip("mid", () => {
    suite.only("inner", () => {
      it("normal", () => { save(); });
      it.skip("skipped", () => {});
      test.only("only", () => {});
      xtest("xskipped", () => {});
      fit("fonly", () => {});
      ftest("ftonly", () => {});
      it(`plain template`, () => {});
      it(`dynamic ${1}`, () => {});
    });
  });
});
function helper() {
  it("nested in fn", () => { ping(); });
}
"#;
        let parsed = super::parse(Lang::Typescript, src);
        assert!(!parsed.has_error);

        let tests: Vec<(&str, Option<&str>, TestMode)> = parsed
            .symbols
            .iter()
            .filter(|s| s.symbol.kind == SymbolKind::Test)
            .map(|s| {
                (
                    s.symbol.name.as_str(),
                    s.symbol.container.as_deref(),
                    s.test_mode,
                )
            })
            .collect();
        assert_eq!(
            tests,
            vec![
                ("normal", Some("outer > mid > inner"), TestMode::Normal),
                ("skipped", Some("outer > mid > inner"), TestMode::Skip),
                ("only", Some("outer > mid > inner"), TestMode::Only),
                ("xskipped", Some("outer > mid > inner"), TestMode::Skip),
                ("fonly", Some("outer > mid > inner"), TestMode::Only),
                ("ftonly", Some("outer > mid > inner"), TestMode::Only),
                (
                    "plain template",
                    Some("outer > mid > inner"),
                    TestMode::Normal
                ),
                ("nested in fn", None, TestMode::Normal),
            ]
        );

        let normal_test = parsed
            .symbols
            .iter()
            .find(|s| s.symbol.name == "normal")
            .unwrap();
        assert_eq!(normal_test.skeleton.len(), 1);
        assert_eq!(normal_test.skeleton[0].kind, SkelKind::Call);
        assert_eq!(normal_test.skeleton[0].key, "call:save");

        let helper = parsed
            .symbols
            .iter()
            .find(|s| s.symbol.name == "helper")
            .unwrap();
        assert!(
            helper.skeleton.is_empty(),
            "nested test call should not leak into enclosing function skeleton"
        );
    }

    #[test]
    fn deeply_nested_control_flow_does_not_overflow() {
        let mut before = String::from("function deep(x: boolean) {\n");
        for _ in 0..10_000 {
            before.push_str("if (x) { ");
        }
        before.push_str("a();");
        for _ in 0..10_000 {
            before.push_str(" }");
        }
        before.push_str("\n}\n");
        let after = before.replacen("a();", "b();", 1);

        let handle = std::thread::Builder::new()
            .stack_size(1 << 20)
            .spawn(move || {
                analyze(&FileInput {
                    path: "src/deep_cf.ts",
                    before: Side::Text(&before),
                    after: Side::Text(&after),
                })
            })
            .expect("spawn 1 MiB stack thread");

        let facts = handle.join().expect("should not overflow stack");
        assert_eq!(facts.changes.len(), 1);
        assert_eq!(
            facts.changes[0].labels,
            vec![
                Label::CallAdded {
                    name: "b".to_string()
                },
                Label::CallRemoved {
                    name: "a".to_string()
                },
            ]
        );
    }

    #[test]
    fn rust_extracts_all_symbol_kinds_containers_and_nesting() {
        use super::TestMode;
        use crate::model::{Lang, SymbolKind};

        let src = r###"
use std::collections::{BTreeMap, HashSet};
use crate::util::helper;

pub(crate) fn pub_crate(mut x: i32, _: u8, (a, b): (i32, i32)) -> i32 {
    fn local_inner() {}
    const LOCAL_K: i32 = 1;
    x + a + b
}

#[derive(Debug)]
struct Boxed<T> {
    inner: T,
}

pub(super) enum Mode {
    Fast,
    Safe,
}

pub trait Priced {
    fn total(&self) -> u32;
    fn discounted(&mut self, pct: u32) -> u32 {
        pct
    }
    const BASE: u32;
}

trait InternalTrait {
    fn ping(self);
}

pub type Alias<T> = Vec<T>;

const INT_C: i32 = 10;
const NEG_INT_C: i32 = -42;
const FLOAT_C: f64 = 1.5;
const NEG_FLOAT_C: f64 = -2.25;
const STR_C: &str = "hi";
const RAW_C: &str = r#"raw"#;
const CHAR_C: char = 'x';
const BOOL_C: bool = true;

impl<T> Boxed<T> {
    pub fn make(val: T) -> Self {
        Boxed { inner: val }
    }
}

mod outer {
    pub mod inner {
        pub fn helper() -> u32 {
            1
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    /// doc comment between attribute and fn
    fn unit_ok() {}

    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "slow"]
    async fn async_skipped() {}
}
"###;

        let parsed = super::parse(Lang::Rust, src);
        assert!(!parsed.has_error);
        assert!(
            parsed
                .imports
                .contains("std::collections::{BTreeMap,HashSet}")
        );
        assert!(parsed.imports.contains("crate::util::helper"));

        let summary: Vec<(SymbolKind, &str, Option<&str>, bool, TestMode)> = parsed
            .symbols
            .iter()
            .map(|s| {
                (
                    s.symbol.kind,
                    s.symbol.name.as_str(),
                    s.symbol.container.as_deref(),
                    s.symbol.exported,
                    s.test_mode,
                )
            })
            .collect();

        assert_eq!(
            summary,
            vec![
                (
                    SymbolKind::Function,
                    "pub_crate",
                    None,
                    true,
                    TestMode::Normal
                ),
                (SymbolKind::Struct, "Boxed", None, false, TestMode::Normal),
                (SymbolKind::Enum, "Mode", None, true, TestMode::Normal),
                (SymbolKind::Trait, "Priced", None, true, TestMode::Normal),
                (
                    SymbolKind::Method,
                    "total",
                    Some("Priced"),
                    true,
                    TestMode::Normal
                ),
                (
                    SymbolKind::Method,
                    "discounted",
                    Some("Priced"),
                    true,
                    TestMode::Normal
                ),
                (
                    SymbolKind::Const,
                    "BASE",
                    Some("Priced"),
                    true,
                    TestMode::Normal
                ),
                (
                    SymbolKind::Trait,
                    "InternalTrait",
                    None,
                    false,
                    TestMode::Normal
                ),
                (
                    SymbolKind::Method,
                    "ping",
                    Some("InternalTrait"),
                    false,
                    TestMode::Normal
                ),
                (SymbolKind::Type, "Alias", None, true, TestMode::Normal),
                (SymbolKind::Const, "INT_C", None, false, TestMode::Normal),
                (
                    SymbolKind::Const,
                    "NEG_INT_C",
                    None,
                    false,
                    TestMode::Normal
                ),
                (SymbolKind::Const, "FLOAT_C", None, false, TestMode::Normal),
                (
                    SymbolKind::Const,
                    "NEG_FLOAT_C",
                    None,
                    false,
                    TestMode::Normal
                ),
                (SymbolKind::Const, "STR_C", None, false, TestMode::Normal),
                (SymbolKind::Const, "RAW_C", None, false, TestMode::Normal),
                (SymbolKind::Const, "CHAR_C", None, false, TestMode::Normal),
                (SymbolKind::Const, "BOOL_C", None, false, TestMode::Normal),
                (
                    SymbolKind::Method,
                    "make",
                    Some("Boxed"),
                    true,
                    TestMode::Normal
                ),
                (
                    SymbolKind::Function,
                    "helper",
                    Some("outer::inner"),
                    true,
                    TestMode::Normal
                ),
                (
                    SymbolKind::Test,
                    "unit_ok",
                    Some("tests"),
                    false,
                    TestMode::Normal
                ),
                (
                    SymbolKind::Test,
                    "async_skipped",
                    Some("tests"),
                    false,
                    TestMode::Skip
                ),
            ]
        );

        let by_name = |name: &str| {
            parsed
                .symbols
                .iter()
                .find(|s| s.symbol.name == name)
                .unwrap()
        };

        assert_eq!(by_name("INT_C").literal.as_deref(), Some("10"));
        assert_eq!(by_name("NEG_INT_C").literal.as_deref(), Some("-42"));
        assert_eq!(by_name("FLOAT_C").literal.as_deref(), Some("1.5"));
        assert_eq!(by_name("NEG_FLOAT_C").literal.as_deref(), Some("-2.25"));
        assert_eq!(by_name("STR_C").literal.as_deref(), Some("\"hi\""));
        assert_eq!(by_name("RAW_C").literal.as_deref(), Some("r#\"raw\"#"));
        assert_eq!(by_name("CHAR_C").literal.as_deref(), Some("'x'"));
        assert_eq!(by_name("BOOL_C").literal.as_deref(), Some("true"));

        let pub_crate_params: Vec<(&str, &str)> = by_name("pub_crate")
            .params
            .iter()
            .map(|p| (p.name.as_str(), p.text.as_str()))
            .collect();
        assert_eq!(
            pub_crate_params,
            vec![
                ("x", "mut x : i32"),
                ("_", "_ : u8"),
                ("( a , b )", "( a , b ) : ( i32 , i32 )"),
            ]
        );
        assert_eq!(by_name("pub_crate").return_type.as_deref(), Some("i32"));
        assert_eq!(by_name("total").params[0].name, "self");
        assert_eq!(by_name("total").params[0].text, "& self");
        assert_eq!(by_name("discounted").params[0].name, "self");
        assert_eq!(by_name("discounted").params[0].text, "& mut self");
        assert!(
            !by_name("Priced").all.iter().any(|t| t == "total"),
            "trait own tokens must exclude trait methods"
        );
    }

    #[test]
    fn rust_skeleton_nodes_guards_errors_and_callees() {
        use super::SkelKind;
        use crate::model::Lang;

        let long_fn = "f".repeat(100);
        let src = format!(
            r#"impl Repo {{
async fn demo(&self, ok: bool, a: i32, opt: Option<i32>, xs: Vec<i32>) -> Result<i32, i32> {{
    if !ok {{
        return Err(1);
    }}
    if a > 10 {{
        s1();
        s2();
        s3();
        return Ok(a);
    }}
    if a == 1 {{
        return Ok(1);
    }} else if a == 2 {{
        return Ok(2);
    }} else {{
        let _ = 3;
    }}
    while a > 0 {{
        break;
    }}
    for x in xs {{
        if x < 0 {{ continue }}
    }}
    loop {{
        break
    }}
    match opt {{
        Some(v) if v > 0 => v,
        _ => 0,
    }};
    let q = opt?;
    let u = opt.unwrap();
    let e = opt.expect("bad");
    std::panic!("boom");
    println!("ignored");
    self.save(a);
    self.repo.persist(a);
    a.b.c.d(a);
    Foo::<i32>::new();
    crate::x::y::z();
    opt.map(|v| v);
    fetch(u).await;
    {long_fn}();
    Ok(q + e)
}}
}}"#
        );

        let parsed = super::parse(Lang::Rust, &src);
        assert!(!parsed.has_error);
        let skel = &parsed.symbols[0].skeleton;

        let summary: Vec<(SkelKind, &str, &str, bool, u32)> = skel
            .iter()
            .map(|n| (n.kind, n.key.as_str(), n.text.as_str(), n.guard, n.line))
            .collect();

        let cut_long = format!("call:{}…", "f".repeat(79));
        assert_eq!(
            summary,
            vec![
                (SkelKind::If, "if:guard", "! ok", true, 3),
                (SkelKind::Return, "return", "Err ( 1 )", false, 4),
                (SkelKind::ErrorOp, "err:return_err", "", false, 4),
                (SkelKind::If, "if", "a > 10", false, 6),
                (SkelKind::Call, "call:s1", "", false, 7),
                (SkelKind::Call, "call:s2", "", false, 8),
                (SkelKind::Call, "call:s3", "", false, 9),
                (SkelKind::Return, "return", "Ok ( a )", false, 10),
                (SkelKind::If, "if", "a == 1", false, 12),
                (SkelKind::Return, "return", "Ok ( 1 )", false, 13),
                (SkelKind::Else, "else", "", false, 14),
                (SkelKind::If, "if", "a == 2", false, 14),
                (SkelKind::Return, "return", "Ok ( 2 )", false, 15),
                (SkelKind::Else, "else", "", false, 16),
                (SkelKind::While, "while", "a > 0", false, 19),
                (SkelKind::Loop, "loop", "", false, 22),
                (SkelKind::If, "if:guard", "x < 0", true, 23),
                (SkelKind::Loop, "loop", "", false, 25),
                (SkelKind::Match, "match", "opt", false, 28),
                (SkelKind::Arm, "arm", "", false, 29),
                (SkelKind::Arm, "arm", "", false, 30),
                (SkelKind::ErrorOp, "err:?", "", false, 32),
                (SkelKind::ErrorOp, "err:unwrap", "", false, 33),
                (SkelKind::ErrorOp, "err:expect", "", false, 34),
                (SkelKind::ErrorOp, "err:panic", "", false, 35),
                (SkelKind::Call, "call:save", "", false, 37),
                (SkelKind::Call, "call:repo.persist", "", false, 38),
                (SkelKind::Call, "call:c.d", "", false, 39),
                (SkelKind::Call, "call:Foo::new", "", false, 40),
                (SkelKind::Call, "call:y::z", "", false, 41),
                (SkelKind::Call, "call:opt.map", "", false, 42),
                (SkelKind::Await, "await", "", false, 43),
                (SkelKind::Call, "call:fetch", "", false, 43),
                (SkelKind::Call, cut_long.as_str(), "", false, 44),
            ]
        );
    }

    #[test]
    fn rust_deep_nesting_does_not_overflow() {
        let mut before = String::from("fn deep(x: bool) {\n");
        for _ in 0..10_000 {
            before.push_str("if x { ");
        }
        before.push_str("a();");
        for _ in 0..10_000 {
            before.push_str(" }");
        }
        before.push_str("\n}\n");
        let after = before.replacen("a();", "b();", 1);

        let handle = std::thread::Builder::new()
            .stack_size(1 << 20)
            .spawn(move || {
                analyze(&FileInput {
                    path: "src/deep_cf.rs",
                    before: Side::Text(&before),
                    after: Side::Text(&after),
                })
            })
            .expect("spawn 1 MiB stack thread");

        let facts = handle.join().expect("should not overflow stack");
        assert_eq!(facts.changes.len(), 1);
        assert_eq!(
            facts.changes[0].labels,
            vec![
                Label::CallAdded {
                    name: "b".to_string()
                },
                Label::CallRemoved {
                    name: "a".to_string()
                },
            ]
        );
    }

    #[test]
    fn rust_and_ecma_preserve_full_long_container_names() {
        use crate::model::{Lang, SymbolKind};

        let summarize = |parsed: &super::FileSyntax| -> Vec<(SymbolKind, String, Option<String>)> {
            parsed
                .symbols
                .iter()
                .map(|s| {
                    (
                        s.symbol.kind,
                        s.symbol.name.clone(),
                        s.symbol.container.clone(),
                    )
                })
                .collect()
        };

        let prefix = "A".repeat(80);
        let type_x = format!("{prefix}X");
        let trait_x = format!("{prefix}Trait");
        let mod_a = format!("{prefix}ModA");
        let mod_b = format!("{prefix}ModB");
        let rust_src = format!(
            "impl<T> {type_x}<T> {{ fn m(&self) {{}} }}\n\
             impl<T> Show for &{type_x}<T> {{ fn r(&self) {{}} }}\n\
             trait {trait_x} {{ fn t(&self); }}\n\
             mod {mod_a} {{ mod {mod_b} {{ fn f() {{}} }} }}\n"
        );
        let rust_parsed = super::parse(Lang::Rust, &rust_src);
        assert!(!rust_parsed.has_error);
        let ref_container = format!("& {type_x}");
        let mod_container = format!("{mod_a}::{mod_b}");
        assert_eq!(
            summarize(&rust_parsed),
            vec![
                (SymbolKind::Method, "m".to_string(), Some(type_x)),
                (SymbolKind::Method, "r".to_string(), Some(ref_container)),
                (SymbolKind::Trait, trait_x.clone(), None),
                (SymbolKind::Method, "t".to_string(), Some(trait_x)),
                (SymbolKind::Function, "f".to_string(), Some(mod_container)),
            ]
        );

        let class_x = format!("{prefix}ClassX");
        let ecma_src = format!("export class {class_x} {{\n  work() {{}}\n}}\n");
        let ecma_parsed = super::parse(Lang::Typescript, &ecma_src);
        assert!(!ecma_parsed.has_error);
        assert_eq!(
            summarize(&ecma_parsed),
            vec![
                (SymbolKind::Class, class_x.clone(), None),
                (SymbolKind::Method, "work".to_string(), Some(class_x)),
            ]
        );
    }
}
