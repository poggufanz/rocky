use std::collections::BTreeMap;

use crate::model::{Change, Label, SymbolKind};
use crate::syntax::{FileSyntax, Param, SymbolInfo};
use crate::text::{cut, token_change_pct};

const MAX_NAME_CHARS: usize = 80;
const MAX_VALUE_CHARS: usize = 60;
const REWRITE_PCT_THRESHOLD: u32 = 70;

type MatchKey<'a> = (SymbolKind, Option<&'a str>, &'a str, u32);

fn match_key(info: &SymbolInfo) -> MatchKey<'_> {
    (
        info.symbol.kind,
        info.symbol.container.as_deref(),
        info.symbol.name.as_str(),
        info.symbol.nth,
    )
}

fn diff_params(before: &[Param], after: &[Param]) -> Option<Label> {
    let mut before_map: BTreeMap<(&str, u32), &str> = BTreeMap::new();
    let mut before_seen: BTreeMap<&str, u32> = BTreeMap::new();
    for param in before {
        let nth = before_seen.entry(param.name.as_str()).or_insert(0);
        before_map.insert((param.name.as_str(), *nth), param.text.as_str());
        *nth += 1;
    }

    let mut after_map: BTreeMap<(&str, u32), &str> = BTreeMap::new();
    let mut after_seen: BTreeMap<&str, u32> = BTreeMap::new();
    for param in after {
        let nth = after_seen.entry(param.name.as_str()).or_insert(0);
        after_map.insert((param.name.as_str(), *nth), param.text.as_str());
        *nth += 1;
    }

    let mut added = 0u32;
    let mut removed = 0u32;
    let mut changed = 0u32;

    for (key, after_text) in &after_map {
        match before_map.get(key) {
            None => added += 1,
            Some(before_text) if before_text != after_text => changed += 1,
            Some(_) => {}
        }
    }
    for key in before_map.keys() {
        if !after_map.contains_key(key) {
            removed += 1;
        }
    }

    if added > 0 || removed > 0 || changed > 0 {
        Some(Label::ParamsChanged {
            added,
            removed,
            changed,
        })
    } else {
        None
    }
}

fn diff_paired_symbol(before: &SymbolInfo, after: &SymbolInfo) -> Change {
    let mut labels = Vec::new();

    if let Some(label) = diff_params(&before.params, &after.params) {
        labels.push(label);
    }

    if before.return_type != after.return_type {
        labels.push(Label::ReturnTypeChanged {});
    }

    if let (Some(b_lit), Some(a_lit)) = (&before.literal, &after.literal)
        && b_lit != a_lit
    {
        labels.push(Label::ValueChanged {
            name: cut(&after.symbol.name, MAX_NAME_CHARS),
            before: cut(b_lit, MAX_VALUE_CHARS),
            after: cut(a_lit, MAX_VALUE_CHARS),
        });
    }

    let pct = token_change_pct(&before.code, &after.code);
    if pct > REWRITE_PCT_THRESHOLD {
        labels.retain(|label| {
            matches!(
                label,
                Label::ParamsChanged { .. }
                    | Label::ReturnTypeChanged {}
                    | Label::TestAdded { .. }
                    | Label::TestRemoved { .. }
                    | Label::TestSkipped { .. }
                    | Label::TestOnly { .. }
            )
        });
        labels.push(Label::Rewrite { pct });
    }

    if labels.is_empty() {
        labels.push(Label::BodyChanged {});
    }

    Change::new(Some(after.symbol.clone()), labels)
}

/// Compares two parsed `FileSyntax` representations into ordered `Change` facts.
pub(crate) fn compare(before: &FileSyntax, after: &FileSyntax) -> Vec<Change> {
    if before.has_error || after.has_error {
        return vec![Change::new(
            None,
            vec![Label::LinesChanged {
                added: 0,
                removed: 0,
            }],
        )];
    }

    if before.all == after.all {
        return vec![Change::new(None, vec![Label::FormatOnly {}])];
    }

    let after_by_key: BTreeMap<MatchKey<'_>, usize> = after
        .symbols
        .iter()
        .enumerate()
        .map(|(idx, sym)| (match_key(sym), idx))
        .collect();

    let mut before_paired = vec![false; before.symbols.len()];
    let mut after_paired = vec![false; after.symbols.len()];
    let mut after_changes: Vec<(usize, Change)> = Vec::new();
    let mut removed_changes: Vec<(usize, Change)> = Vec::new();

    for (b_idx, b_sym) in before.symbols.iter().enumerate() {
        if let Some(&a_idx) = after_by_key.get(&match_key(b_sym)) {
            before_paired[b_idx] = true;
            after_paired[a_idx] = true;
            let a_sym = &after.symbols[a_idx];
            if b_sym.all != a_sym.all {
                after_changes.push((a_idx, diff_paired_symbol(b_sym, a_sym)));
            }
        }
    }

    for (b_idx, b_sym) in before.symbols.iter().enumerate() {
        if before_paired[b_idx] {
            continue;
        }
        if let Some((a_idx, a_sym)) = after.symbols.iter().enumerate().find(|(idx, cand)| {
            !after_paired[*idx]
                && cand.symbol.kind == b_sym.symbol.kind
                && cand.code_without_name == b_sym.code_without_name
        }) {
            before_paired[b_idx] = true;
            after_paired[a_idx] = true;
            after_changes.push((
                a_idx,
                Change::new(
                    Some(a_sym.symbol.clone()),
                    vec![Label::SymbolRenamed {
                        from: cut(&b_sym.symbol.name, MAX_NAME_CHARS),
                    }],
                ),
            ));
        }
    }

    for (a_idx, a_sym) in after.symbols.iter().enumerate() {
        if !after_paired[a_idx] {
            after_changes.push((
                a_idx,
                Change::new(Some(a_sym.symbol.clone()), vec![Label::SymbolAdded {}]),
            ));
        }
    }

    for (b_idx, b_sym) in before.symbols.iter().enumerate() {
        if !before_paired[b_idx] {
            removed_changes.push((
                b_idx,
                Change::new(Some(b_sym.symbol.clone()), vec![Label::SymbolRemoved {}]),
            ));
        }
    }

    let mut file_labels = Vec::new();
    for module in after.imports.difference(&before.imports) {
        file_labels.push(Label::ImportAdded {
            module: module.clone(),
        });
    }
    for module in before.imports.difference(&after.imports) {
        file_labels.push(Label::ImportRemoved {
            module: module.clone(),
        });
    }
    if before.outside != after.outside {
        let pct = token_change_pct(&before.outside, &after.outside);
        if pct > REWRITE_PCT_THRESHOLD {
            file_labels.push(Label::Rewrite { pct });
        } else {
            file_labels.push(Label::BodyChanged {});
        }
    }

    after_changes.sort_by_key(|(a_idx, _)| (after.symbols[*a_idx].lines.0, *a_idx));
    removed_changes.sort_by_key(|(b_idx, _)| (before.symbols[*b_idx].lines.0, *b_idx));

    let mut changes = Vec::new();
    if !file_labels.is_empty() {
        changes.push(Change::new(None, file_labels));
    }
    changes.extend(after_changes.into_iter().map(|(_, c)| c));
    changes.extend(removed_changes.into_iter().map(|(_, c)| c));

    if changes.is_empty() {
        changes.push(Change::new(None, vec![Label::BodyChanged {}]));
    }

    changes
}

#[cfg(test)]
mod tests {
    use crate::analyze;
    use crate::model::{FileInput, Importance, Label, Side};

    #[test]
    fn import_specifier_and_top_level_comment_hit_catchall() {
        let import_spec = analyze(&FileInput {
            path: "src/a.ts",
            before: Side::Text("import a from \"zod\";\n"),
            after: Side::Text("import { a } from \"zod\";\n"),
        });
        assert_eq!(import_spec.changes.len(), 1);
        assert_eq!(import_spec.changes[0].symbol, None);
        assert_eq!(import_spec.changes[0].labels, vec![Label::BodyChanged {}]);

        let comment = analyze(&FileInput {
            path: "src/a.ts",
            before: Side::Text("// before\nexport const X = 1;\n"),
            after: Side::Text("// after\nexport const X = 1;\n"),
        });
        assert_eq!(comment.changes.len(), 1);
        assert_eq!(comment.changes[0].symbol, None);
        assert_eq!(comment.changes[0].labels, vec![Label::BodyChanged {}]);
    }

    #[test]
    fn return_type_added_and_params_reordered() {
        let rt_added = analyze(&FileInput {
            path: "src/a.ts",
            before: Side::Text("export function f(x: number) { return x; }\n"),
            after: Side::Text("export function f(x: number): number { return x; }\n"),
        });
        assert_eq!(rt_added.changes[0].importance, Importance::High);
        assert_eq!(
            rt_added.changes[0].labels,
            vec![Label::ReturnTypeChanged {}]
        );

        let reordered = analyze(&FileInput {
            path: "src/a.ts",
            before: Side::Text("function g(a: number, b: string) {}\n"),
            after: Side::Text("function g(b: string, a: number) {}\n"),
        });
        assert_eq!(reordered.changes[0].labels, vec![Label::BodyChanged {}]);
    }

    #[test]
    fn ordering_file_then_after_lines_then_before_lines() {
        let before = "\
import a from \"a\";
function removedFirst() { const r = 1; }
function editedLast() { const x = 1; }
";
        let after = "\
import b from \"b\";
function addedTop() { const a = 2; }
function editedLast() { const x = 2; }
";
        let facts = analyze(&FileInput {
            path: "src/order.ts",
            before: Side::Text(before),
            after: Side::Text(after),
        });
        let names: Vec<Option<&str>> = facts
            .changes
            .iter()
            .map(|c| c.symbol.as_ref().map(|s| s.name.as_str()))
            .collect();
        assert_eq!(
            names,
            vec![
                None,
                Some("addedTop"),
                Some("editedLast"),
                Some("removedFirst")
            ]
        );
    }

    #[test]
    fn truncates_long_module_and_literal_args() {
        let long_mod = "é".repeat(100);
        let long_before = "😀".repeat(80);
        let long_after = "🦀".repeat(80);

        let before =
            format!("import m from \"{long_mod}\";\nexport const V = \"{long_before}\";\n");
        let after = format!("export const V = \"{long_after}\";\n");

        let facts = analyze(&FileInput {
            path: "src/cut.ts",
            before: Side::Text(&before),
            after: Side::Text(&after),
        });
        assert_eq!(facts.changes.len(), 2);
        let Label::ImportRemoved { module } = &facts.changes[0].labels[0] else {
            panic!("expected import_removed");
        };
        assert_eq!(module.chars().count(), 80);
        assert!(module.ends_with('…'));

        let Label::ValueChanged { before, after, .. } = &facts.changes[1].labels[0] else {
            panic!("expected value_changed");
        };
        assert_eq!(before.chars().count(), 60);
        assert!(before.ends_with('…'));
        assert_eq!(after.chars().count(), 60);
        assert!(after.ends_with('…'));
    }

    #[test]
    fn multi_declarator_const_leaves_no_stray_outside() {
        let facts = analyze(&FileInput {
            path: "src/multi.ts",
            before: Side::Text("const A = 1, B = 2;\n"),
            after: Side::Text("const A = 1, C = 3;\n"),
        });
        assert!(facts.changes.iter().all(|c| c.symbol.is_some()));
        let pairs: Vec<(&str, &Label)> = facts
            .changes
            .iter()
            .map(|c| (c.symbol.as_ref().unwrap().name.as_str(), &c.labels[0]))
            .collect();
        assert_eq!(
            pairs,
            vec![
                ("C", &Label::SymbolAdded {}),
                ("B", &Label::SymbolRemoved {})
            ]
        );
    }
}
