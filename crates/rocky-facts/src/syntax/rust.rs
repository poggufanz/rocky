use std::collections::BTreeSet;

use tree_sitter::Node;

use crate::model::SymbolKind;
use crate::syntax::{
    Extracted, ExtractedSymbol, Param, SkelKind, SkelNode, TestMode, extract_return_type,
    first_non_comment_named_child, is_comment_kind, new_symbol, node_lines, node_text,
    normalized_code_text, single_non_comment_named_child, strip_outer_parens, walk_leaves,
};
use crate::text::cut;

const MAX_MODULE_CHARS: usize = 80;
const MAX_NAME_CHARS: usize = 80;

#[derive(Clone, Copy)]
enum BodyContext {
    Module,
    Impl,
    Trait { exported: bool },
}

enum Visit<'a> {
    Item {
        node: Node<'a>,
        attrs: Vec<Node<'a>>,
        context: BodyContext,
    },
    PopContainer,
}

fn has_visibility(node: Node<'_>) -> bool {
    let mut cursor = node.walk();
    node.named_children(&mut cursor)
        .any(|child| child.kind() == "visibility_modifier")
}

fn item_exported(node: Node<'_>, context: BodyContext) -> bool {
    match context {
        BodyContext::Trait { exported } => exported,
        BodyContext::Module | BodyContext::Impl => has_visibility(node),
    }
}

fn attribute_path_last_segment<'a>(attr_item: Node<'a>, src: &'a str) -> Option<&'a str> {
    if attr_item.kind() != "attribute_item" {
        return None;
    }
    let attr = first_non_comment_named_child(attr_item)?;
    if attr.kind() != "attribute" {
        return None;
    }
    let path = first_non_comment_named_child(attr)?;
    match path.kind() {
        "identifier" => Some(node_text(path, src)),
        "scoped_identifier" => path.child_by_field_name("name").map(|n| node_text(n, src)),
        _ => None,
    }
}

fn item_span_and_lines(attrs: &[Node<'_>], node: Node<'_>) -> ((usize, usize), (u32, u32)) {
    let first = attrs.first().copied().unwrap_or(node);
    let span = (first.start_byte(), node.end_byte());
    let (start_line, _) = node_lines(first);
    let (_, end_line) = node_lines(node);
    (span, (start_line, end_line))
}

fn extract_params(fn_node: Node<'_>, src: &str) -> Vec<Param> {
    let Some(params_node) = fn_node.child_by_field_name("parameters") else {
        return Vec::new();
    };
    let mut params = Vec::new();
    let mut cursor = params_node.walk();
    for child in params_node.named_children(&mut cursor) {
        if is_comment_kind(child.kind()) {
            continue;
        }
        match child.kind() {
            "self_parameter" => params.push(Param {
                name: "self".to_string(),
                text: normalized_code_text(child, src),
            }),
            "parameter" => {
                let name = child
                    .child_by_field_name("pattern")
                    .map(|p| normalized_code_text(p, src))
                    .unwrap_or_else(|| "_".to_string());
                params.push(Param {
                    name,
                    text: normalized_code_text(child, src),
                });
            }
            "variadic_parameter" => params.push(Param {
                name: "...".to_string(),
                text: normalized_code_text(child, src),
            }),
            _ => {
                let text = normalized_code_text(child, src);
                if !text.is_empty() {
                    params.push(Param {
                        name: text.clone(),
                        text,
                    });
                }
            }
        }
    }
    params
}

fn extract_literal(value: Node<'_>, src: &str) -> Option<String> {
    match value.kind() {
        "integer_literal" | "float_literal" | "string_literal" | "raw_string_literal"
        | "char_literal" | "boolean_literal" => Some(node_text(value, src).to_string()),
        "unary_expression" => {
            let mut cursor = value.walk();
            let mut op = None;
            let mut arg = None;
            for child in value.children(&mut cursor) {
                if is_comment_kind(child.kind()) {
                    continue;
                }
                if op.is_none() {
                    op = Some(child);
                } else if arg.is_none() {
                    arg = Some(child);
                } else {
                    return None;
                }
            }
            let op = op?;
            let arg = arg?;
            if node_text(op, src) == "-"
                && matches!(arg.kind(), "integer_literal" | "float_literal")
            {
                Some(format!("-{}", node_text(arg, src)))
            } else {
                None
            }
        }
        _ => None,
    }
}

fn extract_use_module(use_node: Node<'_>, src: &str) -> Option<String> {
    let arg = use_node.child_by_field_name("argument")?;
    let mut compact = String::new();
    walk_leaves(arg, src, |_, _, text, is_comment| {
        if !is_comment {
            compact.push_str(text);
        }
    });
    (!compact.is_empty()).then(|| cut(&compact, MAX_MODULE_CHARS))
}

fn extract_impl_type_name(mut ty: Node<'_>, src: &str) -> String {
    while ty.kind() == "generic_type" {
        let Some(inner) = ty.child_by_field_name("type") else {
            break;
        };
        ty = inner;
    }
    if matches!(
        ty.kind(),
        "type_identifier" | "scoped_type_identifier" | "primitive_type"
    ) {
        return node_text(ty, src).to_string();
    }

    let mut tokens = Vec::new();
    let mut stack = vec![ty];
    while let Some(node) = stack.pop() {
        let kind = node.kind();
        if is_comment_kind(kind) || kind == "type_arguments" {
            continue;
        }
        if node.child_count() == 0 {
            let text = node_text(node, src);
            if !text.is_empty() {
                tokens.push(text);
            }
        } else {
            let start = stack.len();
            let mut cursor = node.walk();
            for child in node.children(&mut cursor) {
                stack.push(child);
            }
            stack[start..].reverse();
        }
    }
    tokens.join(" ")
}

fn unwrap_callee(mut node: Node<'_>) -> Node<'_> {
    loop {
        match node.kind() {
            "parenthesized_expression" => {
                let Some(inner) = single_non_comment_named_child(node) else {
                    break;
                };
                node = inner;
            }
            "generic_function" => {
                let Some(inner) = node.child_by_field_name("function") else {
                    break;
                };
                node = inner;
            }
            "generic_type" => {
                let Some(inner) = node.child_by_field_name("type") else {
                    break;
                };
                node = inner;
            }
            _ => break,
        }
    }
    node
}

fn path_last_segment<'a>(node: Node<'a>, src: &'a str) -> Option<&'a str> {
    let cur = unwrap_callee(node);
    match cur.kind() {
        "identifier" => Some(node_text(cur, src)),
        "scoped_identifier" => cur.child_by_field_name("name").map(|n| node_text(n, src)),
        _ => None,
    }
}

fn method_error_op(callee: Node<'_>, src: &str) -> Option<&'static str> {
    let cur = unwrap_callee(callee);
    if cur.kind() != "field_expression" {
        return None;
    }
    let field = cur.child_by_field_name("field")?;
    match node_text(field, src) {
        "unwrap" => Some("err:unwrap"),
        "expect" => Some("err:expect"),
        _ => None,
    }
}

fn extract_callee_name(callee: Node<'_>, src: &str) -> String {
    let mut segments: Vec<(&str, &str)> = Vec::new();
    let mut cur = unwrap_callee(callee);
    loop {
        match cur.kind() {
            "field_expression" => {
                if let Some(field) = cur.child_by_field_name("field") {
                    segments.push((".", node_text(field, src)));
                }
                let Some(val) = cur.child_by_field_name("value") else {
                    break;
                };
                cur = unwrap_callee(val);
            }
            "scoped_identifier" | "scoped_type_identifier" => {
                if let Some(name) = cur.child_by_field_name("name") {
                    segments.push(("::", node_text(name, src)));
                }
                let Some(path) = cur.child_by_field_name("path") else {
                    break;
                };
                cur = unwrap_callee(path);
            }
            "identifier" | "type_identifier" | "field_identifier" | "self" | "super" | "crate"
            | "metavariable" => {
                segments.push(("", node_text(cur, src)));
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
    if segments.len() > 1 && segments[0].1 == "self" && segments[1].0 == "." {
        segments.remove(0);
    }
    if segments.len() > 2 {
        let start = segments.len() - 2;
        segments.drain(..start);
    }
    if let Some(first) = segments.first_mut() {
        first.0 = "";
    }

    let mut out = String::new();
    for (sep, seg) in segments {
        out.push_str(sep);
        out.push_str(seg);
    }
    cut(&out, MAX_NAME_CHARS)
}

fn is_exit_expr(node: Node<'_>) -> bool {
    let inner = if node.kind() == "expression_statement" {
        let Some(expr) = single_non_comment_named_child(node) else {
            return false;
        };
        expr
    } else {
        node
    };
    matches!(
        inner.kind(),
        "return_expression" | "continue_expression" | "break_expression"
    )
}

fn is_if_guard(if_node: Node<'_>, parent_is_else: bool) -> bool {
    if parent_is_else || if_node.child_by_field_name("alternative").is_some() {
        return false;
    }
    let Some(consequence) = if_node.child_by_field_name("consequence") else {
        return false;
    };
    if consequence.kind() != "block" {
        return false;
    }
    let mut cursor = consequence.walk();
    let mut count = 0usize;
    let mut last = None;
    for child in consequence.named_children(&mut cursor) {
        if is_comment_kind(child.kind()) {
            continue;
        }
        count += 1;
        if count > 3 {
            return false;
        }
        last = Some(child);
    }
    last.is_some_and(is_exit_expr)
}

fn push_skel_nodes(node: Node<'_>, src: &str, parent_is_else: bool, out: &mut Vec<SkelNode>) {
    let line = node.start_position().row as u32 + 1;
    let simple = |kind: SkelKind, key: &str| SkelNode {
        kind,
        key: key.to_string(),
        text: String::new(),
        guard: false,
        line,
    };

    match node.kind() {
        "if_expression" => {
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
            out.push(SkelNode {
                kind: SkelKind::If,
                key,
                text,
                guard,
                line,
            });
        }
        "else_clause" => out.push(simple(SkelKind::Else, SkelKind::Else.kind_name())),
        "match_expression" => {
            let text = node
                .child_by_field_name("value")
                .map(|v| normalized_code_text(strip_outer_parens(v), src))
                .unwrap_or_default();
            out.push(SkelNode {
                kind: SkelKind::Match,
                key: SkelKind::Match.kind_name().to_string(),
                text,
                guard: false,
                line,
            });
        }
        "match_arm" => out.push(simple(SkelKind::Arm, SkelKind::Arm.kind_name())),
        "for_expression" | "loop_expression" => {
            out.push(simple(SkelKind::Loop, SkelKind::Loop.kind_name()))
        }
        "while_expression" => {
            let text = node
                .child_by_field_name("condition")
                .map(|c| normalized_code_text(strip_outer_parens(c), src))
                .unwrap_or_default();
            out.push(SkelNode {
                kind: SkelKind::While,
                key: SkelKind::While.kind_name().to_string(),
                text,
                guard: false,
                line,
            });
        }
        "return_expression" => {
            let arg = first_non_comment_named_child(node);
            let text = arg
                .map(|expr| normalized_code_text(expr, src))
                .unwrap_or_default();
            out.push(SkelNode {
                kind: SkelKind::Return,
                key: SkelKind::Return.kind_name().to_string(),
                text,
                guard: false,
                line,
            });
            if let Some(expr) = arg.map(strip_outer_parens)
                && expr.kind() == "call_expression"
                && expr
                    .child_by_field_name("function")
                    .and_then(|f| path_last_segment(f, src))
                    == Some("Err")
            {
                out.push(simple(SkelKind::ErrorOp, "err:return_err"));
            }
        }
        "try_expression" => out.push(simple(SkelKind::ErrorOp, "err:?")),
        "await_expression" => out.push(simple(SkelKind::Await, SkelKind::Await.kind_name())),
        "macro_invocation" => {
            if node
                .child_by_field_name("macro")
                .and_then(|m| path_last_segment(m, src))
                == Some("panic")
            {
                out.push(simple(SkelKind::ErrorOp, "err:panic"));
            }
        }
        "call_expression" => {
            let Some(callee) = node.child_by_field_name("function") else {
                return;
            };
            if let Some(err_key) = method_error_op(callee, src) {
                out.push(simple(SkelKind::ErrorOp, err_key));
            } else if matches!(path_last_segment(callee, src), Some("Ok" | "Err" | "Some")) {
                // Variant constructors are not calls.
            } else {
                let name = extract_callee_name(callee, src);
                out.push(SkelNode {
                    kind: SkelKind::Call,
                    key: format!("call:{name}"),
                    text: String::new(),
                    guard: false,
                    line,
                });
            }
        }
        _ => {}
    }
}

fn build_skeleton(root: Node<'_>, src: &str) -> Vec<SkelNode> {
    let mut out = Vec::new();
    let mut stack = vec![(root, false)];
    while let Some((node, parent_is_else)) = stack.pop() {
        let kind = node.kind();
        if is_comment_kind(kind) {
            continue;
        }
        push_skel_nodes(node, src, parent_is_else, &mut out);
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
    fn current_container(&self) -> Option<String> {
        (!self.containers.is_empty()).then(|| self.containers.join("::"))
    }

    fn push_list_children(&mut self, list_node: Node<'a>, context: BodyContext) {
        let mut pending_attrs: Vec<Node<'a>> = Vec::new();
        let start = self.stack.len();
        let mut cursor = list_node.walk();
        for child in list_node.named_children(&mut cursor) {
            let kind = child.kind();
            if is_comment_kind(kind) {
                continue;
            }
            if kind == "attribute_item" {
                pending_attrs.push(child);
                continue;
            }
            let attrs = std::mem::take(&mut pending_attrs);
            self.stack.push(Visit::Item {
                node: child,
                attrs,
                context,
            });
        }
        self.stack[start..].reverse();
    }

    fn push_simple_symbol(
        &mut self,
        kind: SymbolKind,
        node: Node<'a>,
        attrs: &[Node<'a>],
        context: BodyContext,
    ) -> Option<(String, bool)> {
        let name_node = node.child_by_field_name("name")?;
        let name = node_text(name_node, self.src).to_string();
        let exported = item_exported(node, context);
        let (span, lines) = item_span_and_lines(attrs, node);
        self.symbols.push(ExtractedSymbol {
            symbol: new_symbol(kind, name.clone(), self.current_container(), exported),
            lines,
            span,
            name_span: Some((name_node.start_byte(), name_node.end_byte())),
            params: Vec::new(),
            return_type: None,
            literal: None,
            test_mode: TestMode::Normal,
            skeleton: Vec::new(),
        });
        Some((name, exported))
    }

    fn handle_function(&mut self, node: Node<'a>, attrs: &[Node<'a>], context: BodyContext) {
        let Some(name_node) = node.child_by_field_name("name") else {
            return;
        };
        let mut has_test = false;
        let mut has_ignore = false;
        for attr in attrs {
            match attribute_path_last_segment(*attr, self.src) {
                Some("test") => has_test = true,
                Some("ignore") => has_ignore = true,
                _ => {}
            }
        }
        let is_test = matches!(context, BodyContext::Module) && has_test;
        let kind = if is_test {
            SymbolKind::Test
        } else if matches!(context, BodyContext::Impl | BodyContext::Trait { .. }) {
            SymbolKind::Method
        } else {
            SymbolKind::Function
        };
        let test_mode = if is_test && has_ignore {
            TestMode::Skip
        } else {
            TestMode::Normal
        };
        let exported = item_exported(node, context);
        let name = node_text(name_node, self.src).to_string();
        let name_span = (!is_test).then_some((name_node.start_byte(), name_node.end_byte()));
        let (span, lines) = item_span_and_lines(attrs, node);
        let skeleton = node
            .child_by_field_name("body")
            .map(|body| build_skeleton(body, self.src))
            .unwrap_or_default();

        self.symbols.push(ExtractedSymbol {
            symbol: new_symbol(kind, name, self.current_container(), exported),
            lines,
            span,
            name_span,
            params: extract_params(node, self.src),
            return_type: extract_return_type(node, self.src),
            literal: None,
            test_mode,
            skeleton,
        });
    }

    fn handle_const(&mut self, node: Node<'a>, attrs: &[Node<'a>], context: BodyContext) {
        let Some(name_node) = node.child_by_field_name("name") else {
            return;
        };
        let value = node.child_by_field_name("value");
        let literal = value.and_then(|v| extract_literal(v, self.src));
        let skeleton = value
            .map(|v| build_skeleton(v, self.src))
            .unwrap_or_default();
        let (span, lines) = item_span_and_lines(attrs, node);
        self.symbols.push(ExtractedSymbol {
            symbol: new_symbol(
                SymbolKind::Const,
                node_text(name_node, self.src).to_string(),
                self.current_container(),
                item_exported(node, context),
            ),
            lines,
            span,
            name_span: Some((name_node.start_byte(), name_node.end_byte())),
            params: Vec::new(),
            return_type: None,
            literal,
            test_mode: TestMode::Normal,
            skeleton,
        });
    }
}

/// Extracts Rust symbols, control skeletons, tests, and `use` imports iteratively without recursion.
pub(crate) fn extract(root: Node<'_>, src: &str) -> Extracted {
    let mut extractor = Extractor {
        src,
        symbols: Vec::new(),
        imports: BTreeSet::new(),
        excluded_outside_spans: Vec::new(),
        containers: Vec::new(),
        stack: Vec::new(),
    };
    extractor.push_list_children(root, BodyContext::Module);

    while let Some(item) = extractor.stack.pop() {
        match item {
            Visit::PopContainer => {
                extractor.containers.pop();
            }
            Visit::Item {
                node,
                attrs,
                context,
            } => match node.kind() {
                "function_item" | "function_signature_item" => {
                    extractor.handle_function(node, &attrs, context);
                }
                "struct_item" => {
                    extractor.push_simple_symbol(SymbolKind::Struct, node, &attrs, context);
                }
                "enum_item" => {
                    extractor.push_simple_symbol(SymbolKind::Enum, node, &attrs, context);
                }
                "type_item" => {
                    extractor.push_simple_symbol(SymbolKind::Type, node, &attrs, context);
                }
                "trait_item" => {
                    if let Some((name, exported)) =
                        extractor.push_simple_symbol(SymbolKind::Trait, node, &attrs, context)
                        && let Some(body) = node.child_by_field_name("body")
                    {
                        extractor.containers.push(name);
                        extractor.stack.push(Visit::PopContainer);
                        extractor.push_list_children(body, BodyContext::Trait { exported });
                    }
                }
                "const_item" => {
                    extractor.handle_const(node, &attrs, context);
                }
                "impl_item" => {
                    if let Some(body) = node.child_by_field_name("body")
                        && let Some(ty) = node.child_by_field_name("type")
                    {
                        extractor
                            .containers
                            .push(extract_impl_type_name(ty, extractor.src));
                        extractor.stack.push(Visit::PopContainer);
                        extractor.push_list_children(body, BodyContext::Impl);
                    }
                }
                "mod_item" => {
                    if let Some(body) = node.child_by_field_name("body")
                        && let Some(name_node) = node.child_by_field_name("name")
                    {
                        extractor
                            .containers
                            .push(node_text(name_node, extractor.src).to_string());
                        extractor.stack.push(Visit::PopContainer);
                        extractor.push_list_children(body, BodyContext::Module);
                    }
                }
                "use_declaration" => {
                    if let Some(module) = extract_use_module(node, extractor.src) {
                        extractor.imports.insert(module);
                    }
                    let (span, _) = item_span_and_lines(&attrs, node);
                    extractor.excluded_outside_spans.push(span);
                }
                _ => {}
            },
        }
    }

    Extracted {
        symbols: extractor.symbols,
        imports: extractor.imports,
        excluded_outside_spans: extractor.excluded_outside_spans,
    }
}
