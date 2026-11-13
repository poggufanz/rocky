use std::collections::BTreeSet;

use tree_sitter::Node;

use crate::model::{Symbol, SymbolKind};
use crate::syntax::{
    Extracted, ExtractedSymbol, Param, TestMode, is_comment_kind, node_lines, node_text,
    normalized_code_text,
};
use crate::text::cut;

const MAX_MODULE_CHARS: usize = 80;

enum Visit<'a> {
    Stmt {
        node: Node<'a>,
        program_level: bool,
    },
    ClassBody {
        node: Node<'a>,
        container: String,
        class_exported: bool,
    },
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

fn extract_literal(value: Node<'_>, src: &str) -> Option<String> {
    match value.kind() {
        "string" | "number" | "true" | "false" | "null" => Some(node_text(value, src).to_string()),
        "template_string" => {
            let mut cursor = value.walk();
            if value
                .named_children(&mut cursor)
                .any(|child| child.kind() == "template_substitution")
            {
                return None;
            }
            Some(node_text(value, src).to_string())
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
    let raw = node_text(source, src);
    let inner = raw
        .strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .or_else(|| raw.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')))
        .unwrap_or(raw);
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

struct Extractor<'a> {
    src: &'a str,
    symbols: Vec<ExtractedSymbol>,
    imports: BTreeSet<String>,
    excluded_outside_spans: Vec<(usize, usize)>,
    stack: Vec<Visit<'a>>,
}

impl<'a> Extractor<'a> {
    fn push_children_rev(&mut self, node: Node<'a>, program_level: bool) {
        let start = self.stack.len();
        let mut cursor = node.walk();
        for child in node.named_children(&mut cursor) {
            self.stack.push(Visit::Stmt {
                node: child,
                program_level,
            });
        }
        self.stack[start..].reverse();
    }

    fn push_callable(
        &mut self,
        symbol: Symbol,
        outer: Node<'a>,
        fn_node: Node<'a>,
        name_span: Option<(usize, usize)>,
    ) {
        self.symbols.push(ExtractedSymbol {
            symbol,
            lines: node_lines(outer),
            span: (outer.start_byte(), outer.end_byte()),
            name_span,
            params: extract_params(fn_node, self.src),
            return_type: extract_return_type(fn_node, self.src),
            literal: None,
            test_mode: TestMode::Normal,
        });
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
                self.symbols.push(ExtractedSymbol {
                    symbol: new_symbol(SymbolKind::Const, name, None, exported),
                    lines: node_lines(sym_node),
                    span: (sym_node.start_byte(), sym_node.end_byte()),
                    name_span,
                    params: Vec::new(),
                    return_type: None,
                    literal: value.and_then(|v| extract_literal(v, self.src)),
                    test_mode: TestMode::Normal,
                });
            }
        }
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
    }
}

/// Extracts TypeScript, TSX, and JavaScript symbols and imports iteratively without recursion.
pub(crate) fn extract(root: Node<'_>, src: &str) -> Extracted {
    let mut extractor = Extractor {
        src,
        symbols: Vec::new(),
        imports: BTreeSet::new(),
        excluded_outside_spans: Vec::new(),
        stack: vec![Visit::Stmt {
            node: root,
            program_level: false,
        }],
    };

    while let Some(item) = extractor.stack.pop() {
        match item {
            Visit::ClassBody {
                node,
                container,
                class_exported,
            } => extractor.handle_class_body(node, &container, class_exported),
            Visit::Stmt {
                node,
                program_level,
            } => {
                let kind = node.kind();
                if kind == "program" {
                    extractor.push_children_rev(node, true);
                } else if kind == "import_statement" {
                    if let Some(module) = extract_import_module(node, src) {
                        extractor.imports.insert(module);
                    }
                    extractor
                        .excluded_outside_spans
                        .push((node.start_byte(), node.end_byte()));
                } else if kind == "export_statement" {
                    extractor.handle_export(node, program_level);
                } else if is_declaration_kind(kind) {
                    extractor.handle_declaration(node, node, false, program_level);
                } else if !is_function_like(kind) && !is_comment_kind(kind) {
                    extractor.push_children_rev(node, false);
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
