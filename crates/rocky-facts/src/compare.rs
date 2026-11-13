use std::collections::{BTreeMap, BTreeSet};

use similar::{Algorithm, DiffOp, capture_diff_slices};

use crate::model::{Change, Label, MAX_DIFF_ITEMS, SymbolKind};
use crate::syntax::{FileSyntax, Param, SkelKind, SkelNode, SymbolInfo, TestMode};
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

#[derive(Default)]
struct SkelSummary<'a> {
    branches: usize,
    loops: usize,
    awaits: usize,
    errors: BTreeMap<&'a str, usize>,
    calls: BTreeMap<&'a str, usize>,
}

impl<'a> SkelSummary<'a> {
    fn from_nodes(nodes: &'a [SkelNode]) -> Self {
        let mut summary = Self::default();
        for node in nodes {
            match node.kind {
                SkelKind::Else | SkelKind::Arm => summary.branches += 1,
                SkelKind::Loop | SkelKind::While => summary.loops += 1,
                SkelKind::Await => summary.awaits += 1,
                SkelKind::Try | SkelKind::Throw | SkelKind::ErrorOp => {
                    *summary.errors.entry(node.key.as_str()).or_insert(0) += 1;
                }
                SkelKind::Call => {
                    let name = node.key.strip_prefix("call:").unwrap_or(&node.key);
                    *summary.calls.entry(name).or_insert(0) += 1;
                }
                SkelKind::If | SkelKind::Match | SkelKind::Return | SkelKind::Catch => {}
            }
        }
        summary
    }
}

fn saturating_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

fn diff_skeleton(before: &[SkelNode], after: &[SkelNode], labels: &mut Vec<Label>) {
    if before.len() <= MAX_DIFF_ITEMS && after.len() <= MAX_DIFF_ITEMS {
        let before_keys: Vec<&str> = before.iter().map(|n| n.key.as_str()).collect();
        let after_keys: Vec<&str> = after.iter().map(|n| n.key.as_str()).collect();
        let ops = capture_diff_slices(Algorithm::Myers, &before_keys, &after_keys);

        let mut guard_added = false;
        let mut condition_changed = false;
        let mut return_changed = false;

        for op in ops {
            match op {
                DiffOp::Equal {
                    old_index,
                    new_index,
                    len,
                } => {
                    for offset in 0..len {
                        let b = &before[old_index + offset];
                        let a = &after[new_index + offset];
                        match (b.kind, a.kind) {
                            (
                                SkelKind::If | SkelKind::While | SkelKind::Match,
                                SkelKind::If | SkelKind::While | SkelKind::Match,
                            ) if b.text != a.text => condition_changed = true,
                            (SkelKind::Return, SkelKind::Return) if b.text != a.text => {
                                return_changed = true;
                            }
                            _ => {}
                        }
                    }
                }
                DiffOp::Insert {
                    new_index, new_len, ..
                }
                | DiffOp::Replace {
                    new_index, new_len, ..
                } => {
                    for a in &after[new_index..new_index + new_len] {
                        if a.kind == SkelKind::If && a.guard {
                            guard_added = true;
                        }
                    }
                }
                DiffOp::Delete { .. } => {}
            }
        }

        if guard_added {
            labels.push(Label::GuardAdded {});
        }
        if condition_changed {
            labels.push(Label::ConditionChanged {});
        }
        if return_changed {
            labels.push(Label::ReturnChanged {});
        }
    }

    let before_sum = SkelSummary::from_nodes(before);
    let after_sum = SkelSummary::from_nodes(after);

    if after_sum.branches > before_sum.branches {
        labels.push(Label::BranchAdded {});
    } else if after_sum.branches < before_sum.branches {
        labels.push(Label::BranchRemoved {});
    }

    if after_sum.loops > before_sum.loops {
        labels.push(Label::LoopAdded {});
    } else if after_sum.loops < before_sum.loops {
        labels.push(Label::LoopRemoved {});
    }

    if after_sum.awaits != before_sum.awaits {
        labels.push(Label::AwaitChanged {
            added: saturating_u32(after_sum.awaits.saturating_sub(before_sum.awaits)),
            removed: saturating_u32(before_sum.awaits.saturating_sub(after_sum.awaits)),
        });
    }

    let err_keys: BTreeSet<&str> = before_sum
        .errors
        .keys()
        .chain(after_sum.errors.keys())
        .copied()
        .collect();
    let mut err_added = false;
    let mut err_removed = false;
    for key in err_keys {
        let b_cnt = before_sum.errors.get(key).copied().unwrap_or(0);
        let a_cnt = after_sum.errors.get(key).copied().unwrap_or(0);
        if a_cnt > b_cnt {
            err_added = true;
        } else if b_cnt > a_cnt {
            err_removed = true;
        }
    }
    if err_added {
        labels.push(Label::ErrorHandlingAdded {});
    }
    if err_removed {
        labels.push(Label::ErrorHandlingRemoved {});
    }

    let call_names: BTreeSet<&str> = before_sum
        .calls
        .keys()
        .chain(after_sum.calls.keys())
        .copied()
        .collect();
    for name in call_names {
        let b_cnt = before_sum.calls.get(name).copied().unwrap_or(0);
        let a_cnt = after_sum.calls.get(name).copied().unwrap_or(0);
        if a_cnt > b_cnt {
            labels.push(Label::CallAdded {
                name: cut(name, MAX_NAME_CHARS),
            });
        } else if b_cnt > a_cnt {
            labels.push(Label::CallRemoved {
                name: cut(name, MAX_NAME_CHARS),
            });
        }
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

    match (before.test_mode, after.test_mode) {
        (TestMode::Normal, TestMode::Skip) => labels.push(Label::TestSkipped {
            name: cut(&after.symbol.name, MAX_NAME_CHARS),
        }),
        (TestMode::Normal, TestMode::Only) => labels.push(Label::TestOnly {
            name: cut(&after.symbol.name, MAX_NAME_CHARS),
        }),
        _ => {}
    }

    diff_skeleton(&before.skeleton, &after.skeleton, &mut labels);

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
            let label = if a_sym.symbol.kind == SymbolKind::Test {
                Label::TestAdded {
                    name: cut(&a_sym.symbol.name, MAX_NAME_CHARS),
                }
            } else {
                Label::SymbolAdded {}
            };
            after_changes.push((a_idx, Change::new(Some(a_sym.symbol.clone()), vec![label])));
        }
    }

    for (b_idx, b_sym) in before.symbols.iter().enumerate() {
        if !before_paired[b_idx] {
            let label = if b_sym.symbol.kind == SymbolKind::Test {
                Label::TestRemoved {
                    name: cut(&b_sym.symbol.name, MAX_NAME_CHARS),
                }
            } else {
                Label::SymbolRemoved {}
            };
            removed_changes.push((b_idx, Change::new(Some(b_sym.symbol.clone()), vec![label])));
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

    #[test]
    fn skeleton_while_switch_replace_guard_and_both_error_labels() {
        let while_facts = analyze(&FileInput {
            path: "src/w.ts",
            before: Side::Text("function f(a: number) { while (a > 1) { a--; } }\n"),
            after: Side::Text("function f(a: number) { while (a >= 1) { a--; } }\n"),
        });
        assert_eq!(
            while_facts.changes[0].labels,
            vec![Label::ConditionChanged {}]
        );

        let switch_facts = analyze(&FileInput {
            path: "src/s.ts",
            before: Side::Text(
                "function f(x: number, y: number) { switch (x) { default: return 1; } }\n",
            ),
            after: Side::Text(
                "function f(x: number, y: number) { switch (y) { default: return 1; } }\n",
            ),
        });
        assert_eq!(
            switch_facts.changes[0].labels,
            vec![Label::ConditionChanged {}]
        );

        let err_both = analyze(&FileInput {
            path: "src/e.ts",
            before: Side::Text(
                "function f(x: string) {\n  if (!x) throw new Error(\"bad\");\n  return work(x);\n}\n",
            ),
            after: Side::Text(
                "function f(x: string) {\n  try {\n    return work(x);\n  } catch (e) {\n    return fallback(e);\n  }\n}\n",
            ),
        });
        assert!(
            err_both.changes[0]
                .labels
                .contains(&Label::ErrorHandlingRemoved {})
        );
        assert!(
            err_both.changes[0]
                .labels
                .contains(&Label::ErrorHandlingAdded {})
        );

        let replace_guard = analyze(&FileInput {
            path: "src/g.ts",
            before: Side::Text(
                "function f(x: number) {\n  const a = 1;\n  const b = 2;\n  save(x);\n  return a + b + x;\n}\n",
            ),
            after: Side::Text(
                "function f(x: number) {\n  const a = 1;\n  const b = 2;\n  if (x <= 0) return 0;\n  return a + b + x;\n}\n",
            ),
        });
        assert_eq!(
            replace_guard.changes[0].labels,
            vec![
                Label::GuardAdded {},
                Label::CallRemoved {
                    name: "save".to_string()
                },
            ]
        );
    }

    #[test]
    fn test_mode_and_body_change_plus_rename_stays_removed_and_added() {
        let skipped_with_body = analyze(&FileInput {
            path: "src/a.test.ts",
            before: Side::Text("it(\"runs\", () => {\n  save(1);\n  check(1);\n});\n"),
            after: Side::Text(
                "it.skip(\"runs\", () => {\n  save(1);\n  check(1);\n  notify(1);\n});\n",
            ),
        });
        assert_eq!(skipped_with_body.changes.len(), 1);
        assert_eq!(skipped_with_body.changes[0].importance, Importance::High);
        assert_eq!(
            skipped_with_body.changes[0].labels,
            vec![
                Label::TestSkipped {
                    name: "runs".to_string()
                },
                Label::CallAdded {
                    name: "notify".to_string()
                },
            ]
        );

        let renamed_test = analyze(&FileInput {
            path: "src/b.test.ts",
            before: Side::Text("it(\"old\", () => { save(1); });\n"),
            after: Side::Text("it(\"new\", () => { save(1); });\n"),
        });
        assert_eq!(renamed_test.changes.len(), 2);
        assert_eq!(
            renamed_test.changes[0].labels,
            vec![Label::TestAdded {
                name: "new".to_string()
            }]
        );
        assert_eq!(
            renamed_test.changes[1].labels,
            vec![Label::TestRemoved {
                name: "old".to_string()
            }]
        );
    }

    #[test]
    fn large_skeleton_uses_multiset_and_counts() {
        use std::fmt::Write;

        let mut before = String::from("function many() {\n");
        for i in 0..10_500 {
            let _ = writeln!(before, "  save({i});");
        }
        before.push_str("}\n");
        let after = before.replacen("save(5000);", "notify(5000);", 1);

        let facts = analyze(&FileInput {
            path: "src/many.ts",
            before: Side::Text(&before),
            after: Side::Text(&after),
        });
        assert_eq!(facts.changes.len(), 1);
        assert_eq!(
            facts.changes[0].labels,
            vec![
                Label::CallAdded {
                    name: "notify".to_string()
                },
                Label::CallRemoved {
                    name: "save".to_string()
                },
            ]
        );
    }

    #[test]
    fn else_if_return_is_not_a_guard() {
        let before = "\
function pick(a: boolean, c: boolean, x: number) {
  let y = 0;
  if (a) {
    y = 2;
  }
  return y;
}
";
        let after = "\
function pick(a: boolean, c: boolean, x: number) {
  let y = 0;
  if (a) {
    y = 2;
  } else if (c) return x;
  return y;
}
";
        let facts = analyze(&FileInput {
            path: "src/pick.ts",
            before: Side::Text(before),
            after: Side::Text(after),
        });
        assert_eq!(facts.changes.len(), 1);
        assert_eq!(facts.changes[0].labels, vec![Label::BranchAdded {}]);
    }

    #[test]
    fn guard_condition_change_emits_condition_changed() {
        let facts = analyze(&FileInput {
            path: "src/guard.ts",
            before: Side::Text("function f(a: number) {\n  if (a < 0) return 0;\n  return a;\n}\n"),
            after: Side::Text("function f(a: number) {\n  if (a <= 0) return 0;\n  return a;\n}\n"),
        });
        assert_eq!(facts.changes.len(), 1);
        assert_eq!(facts.changes[0].labels, vec![Label::ConditionChanged {}]);
    }

    #[test]
    fn rust_else_if_return_is_not_a_guard_and_guard_before_if() {
        let else_if_facts = analyze(&FileInput {
            path: "src/pick.rs",
            before: Side::Text(
                "fn pick(a: bool, c: bool, x: i32) -> i32 {\n    let mut y = 0;\n    if a {\n        y = 2;\n    }\n    y\n}\n",
            ),
            after: Side::Text(
                "fn pick(a: bool, c: bool, x: i32) -> i32 {\n    let mut y = 0;\n    if a {\n        y = 2;\n    } else if c {\n        return x;\n    }\n    y\n}\n",
            ),
        });
        assert_eq!(else_if_facts.changes.len(), 1);
        assert_eq!(else_if_facts.changes[0].labels, vec![Label::BranchAdded {}]);

        let guard_before_if = analyze(&FileInput {
            path: "src/guard_if.rs",
            before: Side::Text(
                "fn apply(ok: bool, x: bool) {\n    let mut y = 0;\n    if x {\n        y = 1;\n    }\n    save(y);\n}\n",
            ),
            after: Side::Text(
                "fn apply(ok: bool, x: bool) {\n    let mut y = 0;\n    if !ok {\n        return;\n    }\n    if x {\n        y = 1;\n    }\n    save(y);\n}\n",
            ),
        });
        assert_eq!(guard_before_if.changes.len(), 1);
        assert_eq!(
            guard_before_if.changes[0].labels,
            vec![Label::GuardAdded {}]
        );
    }

    #[test]
    fn rust_renamed_test_stays_removed_and_added() {
        let facts = analyze(&FileInput {
            path: "src/lib.rs",
            before: Side::Text("#[test]\nfn old_name() {\n    check(1);\n}\n"),
            after: Side::Text("#[test]\nfn new_name() {\n    check(1);\n}\n"),
        });
        assert_eq!(facts.changes.len(), 2);
        assert_eq!(
            facts.changes[0].labels,
            vec![Label::TestAdded {
                name: "new_name".to_string()
            }]
        );
        assert_eq!(
            facts.changes[1].labels,
            vec![Label::TestRemoved {
                name: "old_name".to_string()
            }]
        );
    }
}
