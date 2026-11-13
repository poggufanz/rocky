use std::collections::BTreeSet;

use tree_sitter::Node;

use crate::model::{Symbol, SymbolKind};
use crate::syntax::{
    Extracted, ExtractedSymbol, Param, SkelKind, SkelNode, TestMode, is_comment_kind, node_lines,
    node_text, normalized_code_text,
};
use crate::text::cut;

const MAX_MODULE_CHARS: usize = 80;
const MAX_NAME_CHARS: usize = 80;

enum Visit<'a> {
    Node {
        node: Node<'a>,
        program_level: bool,
        in_fn: bool,
    },
    ClassBody {
        node: Node<'a>,
        container: String,
        class_exported: bool,
    },
    PopContainer,
}

struct TestCall<'a> {
    name: String,
    mode: TestMode,
    callback_body: Option<Node<'a>>,
}

fn is_function_like(kind: &str) -> bool {
    matches!(
        kind,
        "function_declaration"
            | "generator_function_declaration"
            | "method_definition"
            | "arrow_function"
            | "function_expression"
            | "generator_function"
    )
}

fn is_declaration_kind(kind: &str) -> bool {
    matches!(
        kind,
        "function_declaration"
            | "generator_function_declaration"
            | "class_declaration"
            | "abstract_class_declaration"
            | "interface_declaration"
            | "type_alias_declaration"
            | "enum_declaration"
            | "lexical_declaration"
    )
}

fn is_const_lexical(node: Node<'_>) -> bool {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if !is_comment_kind(child.kind()) {
            return child.kind() == "const";
        }
    }
    false
}

fn has_private_modifier(method: Node<'_>, src: &str) -> bool {
    let mut cursor = method.walk();
    method
        .named_children(&mut cursor)
        .any(|child| child.kind() == "accessibility_modifier" && node_text(child, src) == "private")
}

fn param_pattern_node(param: Node<'_>) -> Node<'_> {
    if let Some(pattern) = param.child_by_field_name("pattern") {
        return pattern;
    }
    if param.kind() == "assignment_pattern"
        && let Some(left) = param.child_by_field_name("left")
    {
        return left;
    }
    param
}

fn extract_params(fn_node: Node<'_>, src: &str) -> Vec<Param> {
    if let Some(params_node) = fn_node.child_by_field_name("parameters") {
        let mut params = Vec::new();
        let mut cursor = params_node.walk();
        for child in params_node.named_children(&mut cursor) {
            if is_comment_kind(child.kind()) {
                continue;
            }
            let pattern = param_pattern_node(child);
            params.push(Param {
                name: normalized_code_text(pattern, src),
                text: normalized_code_text(child, src),
            });
        }
        return params;
    }

    // Unparenthesized single-identifier arrow functions expose `parameter` instead of `parameters`.
    if let Some(param_node) = fn_node.child_by_field_name("parameter") {
        let text = normalized_code_text(param_node, src);
        return vec![Param {
            name: text.clone(),
            text,
        }];
    }

    Vec::new()
}

fn extract_return_type(fn_node: Node<'_>, src: &str) -> Option<String> {
    fn_node
        .child_by_field_name("return_type")
        .map(|rt| normalized_code_text(rt, src))
        .filter(|s| !s.is_empty())
}

fn has_template_substitution(node: Node<'_>) -> bool {
    let mut cursor = node.walk();
    node.named_children(&mut cursor)
        .any(|child| child.kind() == "template_substitution")
}

fn unquote_string_literal(raw: &str) -> &str {
    raw.strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .or_else(|| raw.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')))
        .unwrap_or(raw)
}

fn extract_plain_string(node: Node<'_>, src: &str) -> Option<String> {
    match node.kind() {
        "string" => Some(unquote_string_literal(node_text(node, src)).to_string()),
        "template_string" if !has_template_substitution(node) => {
            let raw = node_text(node, src);
            Some(
                raw.strip_prefix('`')
                    .and_then(|s| s.strip_suffix('`'))
                    .unwrap_or(raw)
                    .to_string(),
            )
        }
        _ => None,
    }
}

fn extract_literal(value: Node<'_>, src: &str) -> Option<String> {
    match value.kind() {
        "string" | "number" | "true" | "false" | "null" => Some(node_text(value, src).to_string()),
        "template_string" => {
            (!has_template_substitution(value)).then(|| node_text(value, src).to_string())
        }
        "unary_expression" => {
            let op = value.child_by_field_name("operator").or_else(|| {
                let mut cursor = value.walk();
                cursor.goto_first_child().then(|| cursor.node())
            })?;
            let arg = value.child_by_field_name("argument")?;
            if node_text(op, src) == "-" && arg.kind() == "number" {
                Some(node_text(value, src).to_string())
            } else {
                None
            }
        }
        _ => None,
    }
}

fn extract_import_module(import_node: Node<'_>, src: &str) -> Option<String> {
    let source = import_node.child_by_field_name("source")?;
    let inner = unquote_string_literal(node_text(source, src));
    Some(cut(inner, MAX_MODULE_CHARS))
}

fn symbol_name_or_default(node: Node<'_>, src: &str) -> (String, Option<(usize, usize)>) {
    let name_node = node.child_by_field_name("name");
    let name = name_node
        .map(|n| node_text(n, src).to_string())
        .unwrap_or_else(|| "default".to_string());
    let name_span = name_node.map(|n| (n.start_byte(), n.end_byte()));
    (name, name_span)
}

fn new_symbol(kind: SymbolKind, name: String, container: Option<String>, exported: bool) -> Symbol {
    Symbol {
        kind,
        name,
        container,
        exported,
        nth: 0,
    }
}

fn first_non_comment_named_child(node: Node<'_>) -> Option<Node<'_>> {
    let mut cursor = node.walk();
    node.named_children(&mut cursor)
        .find(|child| !is_comment_kind(child.kind()))
}

fn single_non_comment_named_child(node: Node<'_>) -> Option<Node<'_>> {
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

fn strip_outer_parens(node: Node<'_>) -> Node<'_> {
    if node.kind() == "parenthesized_expression" {
        single_non_comment_named_child(node).unwrap_or(node)
    } else {
        node
    }
}

fn unwrap_callee(mut node: Node<'_>) -> Node<'_> {
    while matches!(
        node.kind(),
        "parenthesized_expression" | "non_null_expression"
    ) {
        let Some(inner) = single_non_comment_named_child(node) else {
            break;
        };
        node = inner;
    }
    node
}

fn extract_callee_name(callee: Node<'_>, src: &str) -> String {
    let mut segments: Vec<&str> = Vec::new();
    let mut cur = unwrap_callee(callee);
    loop {
        match cur.kind() {
            "member_expression" => {
                if let Some(prop) = cur.child_by_field_name("property") {
                    segments.push(node_text(prop, src));
                }
                let Some(obj) = cur.child_by_field_name("object") else {
                    break;
                };
                cur = unwrap_callee(obj);
            }
            "identifier" | "this" | "super" | "private_property_identifier" | "import" => {
                segments.push(node_text(cur, src));
                break;
            }
            _ => {
                if segments.is_empty() {
                    return cut(&normalized_code_text(cur, src), MAX_NAME_CHARS);
                }
                break;
            }
        }
    }
    segments.reverse();
    if segments.len() > 1 && segments.first().copied() == Some("this") {
        segments.remove(0);
    }
    if segments.len() > 2 {
        let start = segments.len() - 2;
        segments.drain(..start);
    }
    cut(&segments.join("."), MAX_NAME_CHARS)
}

fn is_exit_statement(kind: &str) -> bool {
    matches!(
        kind,
        "return_statement" | "throw_statement" | "continue_statement" | "break_statement"
    )
}

fn is_if_guard(if_node: Node<'_>, parent_is_else: bool) -> bool {
    if parent_is_else || if_node.child_by_field_name("alternative").is_some() {
        return false;
    }
    let Some(consequence) = if_node.child_by_field_name("consequence") else {
        return false;
    };
    if is_exit_statement(consequence.kind()) {
        return true;
    }
    if consequence.kind() != "statement_block" {
        return false;
    }
    let mut cursor = consequence.walk();
    let mut count = 0usize;
    let mut last_kind = None;
    for child in consequence.named_children(&mut cursor) {
        if is_comment_kind(child.kind()) {
            continue;
        }
        count += 1;
        if count > 3 {
            return false;
        }
        last_kind = Some(child.kind());
    }
    last_kind.is_some_and(is_exit_statement)
}

fn callee_parts<'a>(callee: Node<'a>, src: &'a str) -> Option<(&'a str, Option<&'a str>)> {
    match callee.kind() {
        "identifier" => Some((node_text(callee, src), None)),
        "member_expression" => {
            if callee.child_by_field_name("optional_chain").is_some() {
                return None;
            }
            let obj = callee.child_by_field_name("object")?;
            let prop = callee.child_by_field_name("property")?;
            if obj.kind() == "identifier" && prop.kind() == "property_identifier" {
                Some((node_text(obj, src), Some(node_text(prop, src))))
            } else {
                None
            }
        }
        _ => None,
    }
}

fn classify_test_callee(callee: Node<'_>, src: &str) -> Option<TestMode> {
    match callee_parts(callee, src)? {
        ("it" | "test", None) => Some(TestMode::Normal),
        ("xit" | "xtest", None) => Some(TestMode::Skip),
        ("fit" | "ftest", None) => Some(TestMode::Only),
        ("it" | "test", Some("skip")) => Some(TestMode::Skip),
        ("it" | "test", Some("only")) => Some(TestMode::Only),
        _ => None,
    }
}

fn is_container_callee(callee: Node<'_>, src: &str) -> bool {
    matches!(
        callee_parts(callee, src),
        Some((
            "describe" | "context" | "suite",
            None | Some("skip") | Some("only")
        ))
    )
}

fn extract_call_first_string_and_callback<'a>(
    call: Node<'a>,
    src: &str,
) -> Option<(String, Option<Node<'a>>)> {
    let args = call.child_by_field_name("arguments")?;
    if args.kind() != "arguments" {
        return None;
    }
    let mut cursor = args.walk();
    let mut first_arg = None;
    let mut callback_body = None;
    for child in args.named_children(&mut cursor) {
        if is_comment_kind(child.kind()) {
            continue;
        }
        if first_arg.is_none() {
            first_arg = extract_plain_string(child, src);
            first_arg.as_ref()?;
            continue;
        }
        if callback_body.is_none()
            && matches!(
                child.kind(),
                "arrow_function" | "function_expression" | "generator_function"
            )
        {
            callback_body = child.child_by_field_name("body");
            break;
        }
    }
    first_arg.map(|name| (name, callback_body))
}

fn extract_test_call<'a>(call: Node<'a>, src: &str) -> Option<TestCall<'a>> {
    if call.kind() != "call_expression" {
        return None;
    }
    let callee = call.child_by_field_name("function")?;
    let mode = classify_test_callee(callee, src)?;
    let (name, callback_body) = extract_call_first_string_and_callback(call, src)?;
    Some(TestCall {
        name,
        mode,
        callback_body,
    })
}

fn extract_container_name(call: Node<'_>, src: &str) -> Option<String> {
    if call.kind() != "call_expression" {
        return None;
    }
    let callee = call.child_by_field_name("function")?;
    if !is_container_callee(callee, src) {
        return None;
    }
    let (name, _) = extract_call_first_string_and_callback(call, src)?;
    Some(name)
}

fn extract_test_statement<'a>(stmt: Node<'a>, src: &str) -> Option<TestCall<'a>> {
    if stmt.kind() != "expression_statement" {
        return None;
    }
    let expr = single_non_comment_named_child(stmt)?;
    match expr.kind() {
        "call_expression" => extract_test_call(expr, src),
        "await_expression" => {
            let inner = single_non_comment_named_child(expr)?;
            extract_test_call(inner, src)
        }
        _ => None,
    }
}

fn is_nested_test_boundary(node: Node<'_>, src: &str) -> bool {
    extract_test_statement(node, src).is_some() || extract_test_call(node, src).is_some()
}

fn skel_node_for(node: Node<'_>, src: &str, parent_is_else: bool) -> Option<SkelNode> {
    let line = node.start_position().row as u32 + 1;
    let simple = |kind: SkelKind| SkelNode {
        kind,
        key: kind.kind_name().to_string(),
        text: String::new(),
        guard: false,
        line,
    };

    match node.kind() {
        "if_statement" => {
            let guard = is_if_guard(node, parent_is_else);
            let key = if guard {
                "if:guard".to_string()
            } else {
                SkelKind::If.kind_name().to_string()
            };
            let text = node
                .child_by_field_name("condition")
                .map(|c| normalized_code_text(strip_outer_parens(c), src))
                .unwrap_or_default();
            Some(SkelNode {
                kind: SkelKind::If,
                key,
                text,
                guard,
                line,
            })
        }
        "else_clause" => Some(simple(SkelKind::Else)),
        "switch_statement" => {
            let text = node
                .child_by_field_name("value")
                .map(|v| normalized_code_text(strip_outer_parens(v), src))
                .unwrap_or_default();
            Some(SkelNode {
                kind: SkelKind::Match,
                key: SkelKind::Match.kind_name().to_string(),
                text,
                guard: false,
                line,
            })
        }
        "switch_case" | "switch_default" => Some(simple(SkelKind::Arm)),
        "for_statement" | "for_in_statement" | "do_statement" => Some(simple(SkelKind::Loop)),
        "while_statement" => {
            let text = node
                .child_by_field_name("condition")
                .map(|c| normalized_code_text(strip_outer_parens(c), src))
                .unwrap_or_default();
            Some(SkelNode {
                kind: SkelKind::While,
                key: SkelKind::While.kind_name().to_string(),
                text,
                guard: false,
                line,
            })
        }
        "return_statement" => {
            let text = first_non_comment_named_child(node)
                .map(|arg| normalized_code_text(arg, src))
                .unwrap_or_default();
            Some(SkelNode {
                kind: SkelKind::Return,
                key: SkelKind::Return.kind_name().to_string(),
                text,
                guard: false,
                line,
            })
        }
        "throw_statement" => Some(simple(SkelKind::Throw)),
        "try_statement" => Some(simple(SkelKind::Try)),
        "catch_clause" => Some(simple(SkelKind::Catch)),
        "await_expression" => Some(simple(SkelKind::Await)),
        "call_expression" => {
            let name = node
                .child_by_field_name("function")
                .map(|callee| extract_callee_name(callee, src))
                .unwrap_or_default();
            Some(SkelNode {
                kind: SkelKind::Call,
                key: format!("call:{name}"),
                text: String::new(),
                guard: false,
                line,
            })
        }
        _ => None,
    }
}

fn build_skeleton(root: Node<'_>, src: &str) -> Vec<SkelNode> {
    let mut out = Vec::new();
    let mut stack = vec![(root, false)];
    while let Some((node, parent_is_else)) = stack.pop() {
        let kind = node.kind();
        if is_comment_kind(kind) || is_nested_test_boundary(node, src) {
            continue;
        }
        if let Some(skel) = skel_node_for(node, src, parent_is_else) {
            out.push(skel);
        }
        let child_parent_is_else = kind == "else_clause";
        let start = stack.len();
        let mut cursor = node.walk();
        for child in node.named_children(&mut cursor) {
            stack.push((child, child_parent_is_else));
        }
        stack[start..].reverse();
    }
    out
}

struct Extractor<'a> {
    src: &'a str,
    symbols: Vec<ExtractedSymbol>,
    imports: BTreeSet<String>,
    excluded_outside_spans: Vec<(usize, usize)>,
    containers: Vec<String>,
    stack: Vec<Visit<'a>>,
}

impl<'a> Extractor<'a> {
    fn push_children_rev(&mut self, node: Node<'a>, program_level: bool, in_fn: bool) {
        let start = self.stack.len();
        let mut cursor = node.walk();
        for child in node.named_children(&mut cursor) {
            self.stack.push(Visit::Node {
                node: child,
                program_level,
                in_fn,
            });
        }
        self.stack[start..].reverse();
    }

    fn current_container(&self) -> Option<String> {
        (!self.containers.is_empty()).then(|| self.containers.join(" > "))
    }

    fn push_callable(
        &mut self,
        symbol: Symbol,
        outer: Node<'a>,
        fn_node: Node<'a>,
        name_span: Option<(usize, usize)>,
    ) {
        let body = fn_node.child_by_field_name("body");
        let skeleton = body
            .map(|b| build_skeleton(b, self.src))
            .unwrap_or_default();
        self.symbols.push(ExtractedSymbol {
            symbol,
            lines: node_lines(outer),
            span: (outer.start_byte(), outer.end_byte()),
            name_span,
            params: extract_params(fn_node, self.src),
            return_type: extract_return_type(fn_node, self.src),
            literal: None,
            test_mode: TestMode::Normal,
            skeleton,
        });
        if let Some(b) = body {
            self.stack.push(Visit::Node {
                node: b,
                program_level: false,
                in_fn: true,
            });
        }
    }

    fn push_test(&mut self, outer: Node<'a>, test: TestCall<'a>) {
        let skeleton = test
            .callback_body
            .map(|b| build_skeleton(b, self.src))
            .unwrap_or_default();
        self.symbols.push(ExtractedSymbol {
            symbol: new_symbol(SymbolKind::Test, test.name, self.current_container(), false),
            lines: node_lines(outer),
            span: (outer.start_byte(), outer.end_byte()),
            name_span: None,
            params: Vec::new(),
            return_type: None,
            literal: None,
            test_mode: test.mode,
            skeleton,
        });
        if let Some(b) = test.callback_body {
            self.stack.push(Visit::Node {
                node: b,
                program_level: false,
                in_fn: true,
            });
        }
    }

    fn push_class(&mut self, class_node: Node<'a>, outer: Node<'a>, exported: bool) {
        let (name, name_span) = symbol_name_or_default(class_node, self.src);
        self.symbols.push(ExtractedSymbol {
            symbol: new_symbol(SymbolKind::Class, name.clone(), None, exported),
            lines: node_lines(outer),
            span: (outer.start_byte(), outer.end_byte()),
            name_span,
            params: Vec::new(),
            return_type: None,
            literal: None,
            test_mode: TestMode::Normal,
            skeleton: Vec::new(),
        });
        if let Some(body) = class_node.child_by_field_name("body") {
            self.stack.push(Visit::ClassBody {
                node: body,
                container: name,
                class_exported: exported,
            });
        }
    }

    fn push_named_type(
        &mut self,
        kind: SymbolKind,
        decl: Node<'a>,
        outer: Node<'a>,
        exported: bool,
    ) {
        let Some(name_node) = decl.child_by_field_name("name") else {
            return;
        };
        self.symbols.push(ExtractedSymbol {
            symbol: new_symbol(
                kind,
                node_text(name_node, self.src).to_string(),
                None,
                exported,
            ),
            lines: node_lines(outer),
            span: (outer.start_byte(), outer.end_byte()),
            name_span: Some((name_node.start_byte(), name_node.end_byte())),
            params: Vec::new(),
            return_type: None,
            literal: None,
            test_mode: TestMode::Normal,
            skeleton: Vec::new(),
        });
    }

    fn handle_const_decl(&mut self, decl: Node<'a>, outer: Node<'a>, exported: bool) {
        let mut cursor = decl.walk();
        let declarators: Vec<Node<'a>> = decl
            .named_children(&mut cursor)
            .filter(|child| child.kind() == "variable_declarator")
            .collect();
        let single = declarators.len() == 1;
        if declarators.len() > 1 {
            self.excluded_outside_spans
                .push((outer.start_byte(), outer.end_byte()));
        }
        let stack_start = self.stack.len();
        for declarator in declarators {
            let Some(name_node) = declarator.child_by_field_name("name") else {
                continue;
            };
            if name_node.kind() != "identifier" {
                continue;
            }
            let sym_node = if single { outer } else { declarator };
            let name = node_text(name_node, self.src).to_string();
            let name_span = Some((name_node.start_byte(), name_node.end_byte()));
            let value = declarator.child_by_field_name("value");

            if let Some(val) = value
                && matches!(
                    val.kind(),
                    "arrow_function" | "function_expression" | "generator_function"
                )
            {
                self.push_callable(
                    new_symbol(SymbolKind::Function, name, None, exported),
                    sym_node,
                    val,
                    name_span,
                );
            } else {
                let skeleton = value
                    .map(|v| build_skeleton(v, self.src))
                    .unwrap_or_default();
                self.symbols.push(ExtractedSymbol {
                    symbol: new_symbol(SymbolKind::Const, name, None, exported),
                    lines: node_lines(sym_node),
                    span: (sym_node.start_byte(), sym_node.end_byte()),
                    name_span,
                    params: Vec::new(),
                    return_type: None,
                    literal: value.and_then(|v| extract_literal(v, self.src)),
                    test_mode: TestMode::Normal,
                    skeleton,
                });
                if let Some(val) = value {
                    self.stack.push(Visit::Node {
                        node: val,
                        program_level: false,
                        in_fn: true,
                    });
                }
            }
        }
        self.stack[stack_start..].reverse();
    }

    fn handle_declaration(
        &mut self,
        decl: Node<'a>,
        outer: Node<'a>,
        exported: bool,
        program_level: bool,
    ) {
        match decl.kind() {
            "function_declaration" | "generator_function_declaration" => {
                let (name, name_span) = symbol_name_or_default(decl, self.src);
                self.push_callable(
                    new_symbol(SymbolKind::Function, name, None, exported),
                    outer,
                    decl,
                    name_span,
                );
            }
            "class_declaration" | "abstract_class_declaration" => {
                self.push_class(decl, outer, exported);
            }
            "interface_declaration" => {
                self.push_named_type(SymbolKind::Interface, decl, outer, exported);
            }
            "type_alias_declaration" => {
                self.push_named_type(SymbolKind::Type, decl, outer, exported);
            }
            "enum_declaration" => {
                self.push_named_type(SymbolKind::Enum, decl, outer, exported);
            }
            "lexical_declaration" if program_level && is_const_lexical(decl) => {
                self.handle_const_decl(decl, outer, exported);
            }
            "lexical_declaration" => {
                self.push_children_rev(decl, false, true);
            }
            _ => {}
        }
    }

    fn handle_export(&mut self, export_node: Node<'a>, program_level: bool) {
        if let Some(decl) = export_node.child_by_field_name("declaration") {
            self.handle_declaration(decl, export_node, true, program_level);
            return;
        }

        let Some(val) = export_node.child_by_field_name("value") else {
            return;
        };

        match val.kind() {
            "function_expression" | "generator_function" | "arrow_function" => {
                let (name, name_span) = symbol_name_or_default(val, self.src);
                self.push_callable(
                    new_symbol(SymbolKind::Function, name, None, true),
                    export_node,
                    val,
                    name_span,
                );
            }
            "class" => {
                self.push_class(val, export_node, true);
            }
            _ => {}
        }
    }

    fn handle_class_body(&mut self, node: Node<'a>, container: &str, class_exported: bool) {
        let stack_start = self.stack.len();
        let mut cursor = node.walk();
        for child in node.named_children(&mut cursor) {
            if child.kind() != "method_definition" {
                continue;
            }
            let Some(name_node) = child.child_by_field_name("name") else {
                continue;
            };
            let name = node_text(name_node, self.src).to_string();
            let exported =
                class_exported && !has_private_modifier(child, self.src) && !name.starts_with('#');
            self.push_callable(
                new_symbol(
                    SymbolKind::Method,
                    name,
                    Some(container.to_string()),
                    exported,
                ),
                child,
                child,
                Some((name_node.start_byte(), name_node.end_byte())),
            );
        }
        self.stack[stack_start..].reverse();
    }
}

/// Extracts TypeScript, TSX, and JavaScript symbols, control skeletons, tests, and imports iteratively without recursion.
pub(crate) fn extract(root: Node<'_>, src: &str) -> Extracted {
    let mut extractor = Extractor {
        src,
        symbols: Vec::new(),
        imports: BTreeSet::new(),
        excluded_outside_spans: Vec::new(),
        containers: Vec::new(),
        stack: vec![Visit::Node {
            node: root,
            program_level: false,
            in_fn: false,
        }],
    };

    while let Some(item) = extractor.stack.pop() {
        match item {
            Visit::PopContainer => {
                extractor.containers.pop();
            }
            Visit::ClassBody {
                node,
                container,
                class_exported,
            } => extractor.handle_class_body(node, &container, class_exported),
            Visit::Node {
                node,
                program_level,
                in_fn,
            } => {
                let kind = node.kind();
                if is_comment_kind(kind) {
                    continue;
                }
                if kind == "program" {
                    extractor.push_children_rev(node, true, false);
                } else if !in_fn && kind == "import_statement" {
                    if let Some(module) = extract_import_module(node, src) {
                        extractor.imports.insert(module);
                    }
                    extractor
                        .excluded_outside_spans
                        .push((node.start_byte(), node.end_byte()));
                } else if !in_fn && kind == "export_statement" {
                    extractor.handle_export(node, program_level);
                } else if !in_fn && is_declaration_kind(kind) {
                    extractor.handle_declaration(node, node, false, program_level);
                } else if kind == "expression_statement" {
                    if let Some(test) = extract_test_statement(node, src) {
                        extractor.push_test(node, test);
                    } else {
                        extractor.push_children_rev(node, false, in_fn);
                    }
                } else if kind == "call_expression" {
                    if let Some(test) = extract_test_call(node, src) {
                        extractor.push_test(node, test);
                    } else if let Some(container_name) = extract_container_name(node, src) {
                        extractor.containers.push(container_name);
                        extractor.stack.push(Visit::PopContainer);
                        extractor.push_children_rev(node, false, in_fn);
                    } else {
                        extractor.push_children_rev(node, false, in_fn);
                    }
                } else if is_function_like(kind) {
                    extractor.push_children_rev(node, false, true);
                } else {
                    extractor.push_children_rev(node, false, in_fn);
                }
            }
        }
    }

    Extracted {
        symbols: extractor.symbols,
        imports: extractor.imports,
        excluded_outside_spans: extractor.excluded_outside_spans,
    }
}
