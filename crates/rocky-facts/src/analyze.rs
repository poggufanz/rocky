use similar::DiffOp;

use crate::compare::{self, LineRegion};
use crate::config;
use crate::lang::lang_for_path;
use crate::model::{Change, ChangeSpan, FileFacts, FileInput, Label, Lang, MAX_BYTES, Side};
use crate::syntax;
use crate::text;

type RegionPair = (Option<LineRegion>, Option<LineRegion>);

fn too_large(side: Side<'_>) -> bool {
    matches!(side, Side::Text(s) if s.len() > MAX_BYTES)
}

fn normalized_line_count(s: &str) -> u32 {
    text::saturating_u32(text::normalize(s).lines().count())
}

fn single_change(lang: Lang, label: Label, span: ChangeSpan) -> FileFacts {
    FileFacts {
        lang,
        changes: vec![Change::new(None, vec![label])],
        spans: vec![span],
    }
}

fn lines_changed_facts(lang: Lang, before: &str, after: &str) -> FileFacts {
    let (line, added, removed) = text::line_diff(before, after);
    single_change(
        lang,
        Label::LinesChanged { added, removed },
        ChangeSpan {
            line,
            added: Some(added),
            removed: Some(removed),
        },
    )
}

fn is_format_only(changes: &[Change]) -> bool {
    matches!(changes, [change] if change.labels.as_slice() == [Label::FormatOnly {}])
}

fn innermost_region(regions: &[(usize, LineRegion)], line: u32) -> Option<usize> {
    regions
        .iter()
        .filter(|&&(_, (start, end))| line >= start && line <= end)
        .min_by_key(|&&(idx, (start, end))| (end.saturating_sub(start), idx))
        .map(|&(idx, _)| idx)
}

fn region_spans(before: &str, after: &str, regions: &[RegionPair]) -> Vec<ChangeSpan> {
    let before_lines: Vec<&str> = before.lines().collect();
    let after_lines: Vec<&str> = after.lines().collect();
    let Some(ops) = text::diff_line_ops(&before_lines, &after_lines) else {
        return regions
            .iter()
            .map(|&(_, after_reg)| ChangeSpan {
                line: after_reg.map(|(start, _)| start),
                added: None,
                removed: None,
            })
            .collect();
    };

    let mut before_regs: Vec<(usize, LineRegion)> = Vec::new();
    let mut after_regs: Vec<(usize, LineRegion)> = Vec::new();
    let mut file_idx = None;
    for (idx, &(before_reg, after_reg)) in regions.iter().enumerate() {
        if let Some(reg) = before_reg {
            before_regs.push((idx, reg));
        }
        if let Some(reg) = after_reg {
            after_regs.push((idx, reg));
        }
        if before_reg.is_none() && after_reg.is_none() && file_idx.is_none() {
            file_idx = Some(idx);
        }
    }

    let mut added = vec![0u32; regions.len()];
    let mut removed = vec![0u32; regions.len()];
    let mut file_line = None;

    let mut record_removed = |old_index: usize, old_len: usize| {
        for offset in 0..old_len {
            let line = (old_index + offset + 1) as u32;
            if let Some(idx) = innermost_region(&before_regs, line).or(file_idx) {
                removed[idx] = removed[idx].saturating_add(1);
            }
        }
    };
    let mut record_added = |new_index: usize, new_len: usize| {
        for offset in 0..new_len {
            let line = (new_index + offset + 1) as u32;
            if let Some(idx) = innermost_region(&after_regs, line) {
                added[idx] = added[idx].saturating_add(1);
            } else if let Some(idx) = file_idx {
                added[idx] = added[idx].saturating_add(1);
                if file_line.is_none() {
                    file_line = Some(line);
                }
            }
        }
    };

    for op in ops {
        match op {
            DiffOp::Equal { .. } => {}
            DiffOp::Delete {
                old_index, old_len, ..
            } => record_removed(old_index, old_len),
            DiffOp::Insert {
                new_index, new_len, ..
            } => record_added(new_index, new_len),
            DiffOp::Replace {
                old_index,
                old_len,
                new_index,
                new_len,
            } => {
                record_removed(old_index, old_len);
                record_added(new_index, new_len);
            }
        }
    }

    regions
        .iter()
        .enumerate()
        .map(|(idx, &(before_reg, after_reg))| {
            let line = match (before_reg, after_reg) {
                (_, Some((start, _))) => Some(start),
                (Some(_), None) => None,
                (None, None) => file_line,
            };
            ChangeSpan {
                line,
                added: Some(added[idx]),
                removed: Some(removed[idx]),
            }
        })
        .collect()
}

/// Analyzes a file change from its path and before/after states into structured `FileFacts`.
pub fn analyze(input: &FileInput<'_>) -> FileFacts {
    let lang = lang_for_path(input.path);

    if too_large(input.before) || too_large(input.after) {
        return single_change(lang, Label::TooLarge {}, ChangeSpan::default());
    }

    if matches!(input.after, Side::Absent) {
        if matches!(input.before, Side::Absent) {
            return FileFacts {
                lang,
                changes: Vec::new(),
                spans: Vec::new(),
            };
        }
        let span = match input.before {
            Side::Text(before) => ChangeSpan {
                line: None,
                added: Some(0),
                removed: Some(normalized_line_count(before)),
            },
            Side::Unknown | Side::Absent => ChangeSpan::default(),
        };
        return single_change(lang, Label::FileDeleted {}, span);
    }

    if matches!(input.before, Side::Absent) {
        let span = match input.after {
            Side::Text(after) => {
                let count = normalized_line_count(after);
                ChangeSpan {
                    line: (count > 0).then_some(1),
                    added: Some(count),
                    removed: Some(0),
                }
            }
            Side::Unknown | Side::Absent => ChangeSpan::default(),
        };
        return single_change(lang, Label::FileNew {}, span);
    }

    let (Side::Text(before), Side::Text(after)) = (input.before, input.after) else {
        return single_change(lang, Label::NotCaptured {}, ChangeSpan::default());
    };

    if before == after {
        return FileFacts {
            lang,
            changes: Vec::new(),
            spans: Vec::new(),
        };
    }

    let norm_before = text::normalize(before);
    let norm_after = text::normalize(after);
    if norm_before == norm_after {
        return single_change(lang, Label::FormatOnly {}, ChangeSpan::default());
    }

    match lang {
        Lang::Lockfile => {
            let (line, added, removed) = text::line_diff(&norm_before, &norm_after);
            single_change(
                lang,
                Label::LockfileChanged {},
                ChangeSpan {
                    line,
                    added: Some(added),
                    removed: Some(removed),
                },
            )
        }
        Lang::Json | Lang::Toml | Lang::PackageJson | Lang::CargoToml => {
            if let Some(changes) = config::config_changes(lang, &norm_before, &norm_after) {
                let spans = if is_format_only(&changes) {
                    vec![ChangeSpan::default()]
                } else if changes.len() == 1 {
                    let (line, added, removed) = text::line_diff(&norm_before, &norm_after);
                    vec![ChangeSpan {
                        line,
                        added: Some(added),
                        removed: Some(removed),
                    }]
                } else {
                    vec![ChangeSpan::default(); changes.len()]
                };
                FileFacts {
                    lang,
                    changes,
                    spans,
                }
            } else {
                lines_changed_facts(lang, &norm_before, &norm_after)
            }
        }
        Lang::Typescript | Lang::Tsx | Lang::Javascript | Lang::Rust => {
            let before_syntax = syntax::parse(lang, &norm_before);
            let after_syntax = syntax::parse(lang, &norm_after);
            if before_syntax.has_error || after_syntax.has_error {
                lines_changed_facts(lang, &norm_before, &norm_after)
            } else {
                let entries = compare::compare_regions(&before_syntax, &after_syntax);
                let mut changes = Vec::with_capacity(entries.len());
                let mut regions = Vec::with_capacity(entries.len());
                for (change, before_reg, after_reg) in entries {
                    changes.push(change);
                    regions.push((before_reg, after_reg));
                }
                let spans = if is_format_only(&changes) {
                    vec![ChangeSpan::default()]
                } else {
                    region_spans(&norm_before, &norm_after, &regions)
                };
                FileFacts {
                    lang,
                    changes,
                    spans,
                }
            }
        }
        Lang::Plain => lines_changed_facts(lang, &norm_before, &norm_after),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Importance, MAX_BYTES, MAX_DIFF_ITEMS, SymbolKind};

    #[test]
    fn too_large_wins() {
        let big = "a".repeat(MAX_BYTES + 1);
        let expected = vec![Change::new(None, vec![Label::TooLarge {}])];
        assert_eq!(expected[0].importance, Importance::Low);

        let sides = [
            Side::Absent,
            Side::Unknown,
            Side::Text(""),
            Side::Text(&big),
        ];
        for other in sides {
            let left = analyze(&FileInput {
                path: "notes/big.md",
                before: Side::Text(&big),
                after: other,
            });
            assert_eq!(left.changes, expected);

            let right = analyze(&FileInput {
                path: "notes/big.md",
                before: other,
                after: Side::Text(&big),
            });
            assert_eq!(right.changes, expected);
        }
    }

    #[test]
    fn max_bytes_and_absent_sides() {
        let exact = "a".repeat(MAX_BYTES);
        let facts = analyze(&FileInput {
            path: "notes/exact.md",
            before: Side::Text(&exact),
            after: Side::Text(&exact),
        });
        assert!(facts.changes.is_empty());

        let both_absent = analyze(&FileInput {
            path: "notes/none.md",
            before: Side::Absent,
            after: Side::Absent,
        });
        assert!(both_absent.changes.is_empty());

        let unknown_deleted = analyze(&FileInput {
            path: "notes/gone.md",
            before: Side::Unknown,
            after: Side::Absent,
        });
        assert_eq!(
            unknown_deleted.changes,
            vec![Change::new(None, vec![Label::FileDeleted {}])]
        );
        assert_eq!(unknown_deleted.spans, vec![ChangeSpan::default()]);
    }

    #[test]
    fn ts_function_body_change_span() {
        let before = "// 1\n// 2\n// 3\n// 4\nfunction compute(x: number) {\n  return x + 1;\n}\n";
        let after = "// 1\n// 2\n// 3\n// 4\nfunction compute(x: number) {\n  return x + 2;\n}\n";

        syntax::reset_parse_count();
        let facts = analyze(&FileInput {
            path: "src/compute.ts",
            before: Side::Text(before),
            after: Side::Text(after),
        });
        assert_eq!(syntax::parse_count(), 2);
        assert_eq!(facts.changes.len(), 1);
        assert_eq!(
            facts.changes[0].symbol.as_ref().map(|s| s.name.as_str()),
            Some("compute")
        );
        assert_eq!(
            facts.spans,
            vec![ChangeSpan {
                line: Some(5),
                added: Some(1),
                removed: Some(1),
            }]
        );
    }

    #[test]
    fn new_exported_const_on_line_one_plus_changed_function() {
        let before = "function work(x: number) {\n  return x + 1;\n}\n";
        let after = "export const CONFIG = {\n  retries: 3,\n};\nfunction work(x: number) {\n  return x + 2;\n}\n";

        let facts = analyze(&FileInput {
            path: "src/work.ts",
            before: Side::Text(before),
            after: Side::Text(after),
        });
        assert_eq!(facts.changes.len(), 2);
        assert_eq!(
            facts.changes[0].symbol.as_ref().map(|s| s.name.as_str()),
            Some("CONFIG")
        );
        assert_eq!(
            facts.changes[1].symbol.as_ref().map(|s| s.name.as_str()),
            Some("work")
        );
        assert_eq!(
            facts.spans,
            vec![
                ChangeSpan {
                    line: Some(1),
                    added: Some(3),
                    removed: Some(0),
                },
                ChangeSpan {
                    line: Some(4),
                    added: Some(1),
                    removed: Some(1),
                },
            ]
        );
    }

    #[test]
    fn removed_function_span() {
        let before = "function kept() {\n  return 1;\n}\nfunction gone(a: number) {\n  const b = a + 1;\n  return b;\n}\n";
        let after = "function kept() {\n  return 1;\n}\n";

        let facts = analyze(&FileInput {
            path: "src/gone.ts",
            before: Side::Text(before),
            after: Side::Text(after),
        });
        assert_eq!(facts.changes.len(), 1);
        assert_eq!(
            facts.changes[0].symbol.as_ref().map(|s| s.name.as_str()),
            Some("gone")
        );
        assert_eq!(
            facts.spans,
            vec![ChangeSpan {
                line: None,
                added: Some(0),
                removed: Some(4),
            }]
        );
    }

    #[test]
    fn import_change_plus_function_change_span() {
        let before = "import { a } from \"./a\";\nfunction work(x: number) {\n  return x + 1;\n}\n";
        let after = "import { a } from \"./a\";\nimport { b } from \"./b\";\nfunction work(x: number) {\n  return x + 2;\n}\n";

        let added_import = analyze(&FileInput {
            path: "src/imp.ts",
            before: Side::Text(before),
            after: Side::Text(after),
        });
        assert_eq!(added_import.changes.len(), 2);
        assert_eq!(added_import.changes[0].symbol, None);
        assert_eq!(
            added_import.changes[1]
                .symbol
                .as_ref()
                .map(|s| s.name.as_str()),
            Some("work")
        );
        assert_eq!(
            added_import.spans,
            vec![
                ChangeSpan {
                    line: Some(2),
                    added: Some(1),
                    removed: Some(0),
                },
                ChangeSpan {
                    line: Some(3),
                    added: Some(1),
                    removed: Some(1),
                },
            ]
        );

        let removed_import = analyze(&FileInput {
            path: "src/imp.ts",
            before: Side::Text(before),
            after: Side::Text("function work(x: number) {\n  return x + 2;\n}\n"),
        });
        assert_eq!(removed_import.changes.len(), 2);
        assert_eq!(
            removed_import.spans,
            vec![
                ChangeSpan {
                    line: None,
                    added: Some(0),
                    removed: Some(1),
                },
                ChangeSpan {
                    line: Some(1),
                    added: Some(1),
                    removed: Some(1),
                },
            ]
        );
    }

    #[test]
    fn class_with_changed_method_span() {
        let method_only = analyze(&FileInput {
            path: "src/cart.ts",
            before: Side::Text("class Cart {\n  apply(x: number) {\n    return x + 1;\n  }\n}\n"),
            after: Side::Text("class Cart {\n  apply(x: number) {\n    return x + 2;\n  }\n}\n"),
        });
        assert_eq!(method_only.changes.len(), 1);
        assert_eq!(
            method_only.changes[0]
                .symbol
                .as_ref()
                .map(|s| (s.kind, s.name.as_str())),
            Some((SymbolKind::Method, "apply"))
        );
        assert_eq!(
            method_only.spans,
            vec![ChangeSpan {
                line: Some(2),
                added: Some(1),
                removed: Some(1),
            }]
        );

        let class_and_method = analyze(&FileInput {
            path: "src/cart.ts",
            before: Side::Text(
                "class Cart {\n  count = 1;\n  apply(x: number) {\n    return x + 1;\n  }\n}\n",
            ),
            after: Side::Text(
                "class Cart {\n  count = 2;\n  apply(x: number) {\n    return x + 2;\n  }\n}\n",
            ),
        });
        assert_eq!(class_and_method.changes.len(), 2);
        assert_eq!(
            class_and_method.changes[0]
                .symbol
                .as_ref()
                .map(|s| (s.kind, s.name.as_str())),
            Some((SymbolKind::Class, "Cart"))
        );
        assert_eq!(
            class_and_method.changes[1]
                .symbol
                .as_ref()
                .map(|s| (s.kind, s.name.as_str())),
            Some((SymbolKind::Method, "apply"))
        );
        assert_eq!(
            class_and_method.spans,
            vec![
                ChangeSpan {
                    line: Some(1),
                    added: Some(1),
                    removed: Some(1),
                },
                ChangeSpan {
                    line: Some(3),
                    added: Some(1),
                    removed: Some(1),
                },
            ]
        );
    }

    #[test]
    fn plain_lockfile_and_config_spans() {
        let plain_before = "alpha\nbeta\ngamma\n";
        let plain_after = "alpha\nbeta\ndelta\n";
        let (expected_added, expected_removed) = text::line_counts(plain_before, plain_after);
        let plain = analyze(&FileInput {
            path: "notes/readme.md",
            before: Side::Text(plain_before),
            after: Side::Text(plain_after),
        });
        assert_eq!(
            plain.spans,
            vec![ChangeSpan {
                line: Some(3),
                added: Some(expected_added),
                removed: Some(expected_removed),
            }]
        );

        let plain_del = analyze(&FileInput {
            path: "notes/readme.md",
            before: Side::Text(plain_before),
            after: Side::Text("alpha\ngamma\n"),
        });
        assert_eq!(
            plain_del.spans,
            vec![ChangeSpan {
                line: None,
                added: Some(0),
                removed: Some(1),
            }]
        );

        let lock = analyze(&FileInput {
            path: "Cargo.lock",
            before: Side::Text("name = \"a\"\nversion = \"1.0.0\"\n"),
            after: Side::Text("name = \"a\"\nversion = \"1.0.1\"\n"),
        });
        assert_eq!(
            lock.spans,
            vec![ChangeSpan {
                line: Some(2),
                added: Some(1),
                removed: Some(1),
            }]
        );

        let single_cfg = analyze(&FileInput {
            path: "package.json",
            before: Side::Text("{\n  \"name\": \"app\",\n  \"version\": \"1.0.0\"\n}\n"),
            after: Side::Text("{\n  \"name\": \"app\",\n  \"version\": \"1.1.0\"\n}\n"),
        });
        assert_eq!(single_cfg.changes.len(), 1);
        assert_eq!(
            single_cfg.spans,
            vec![ChangeSpan {
                line: Some(3),
                added: Some(1),
                removed: Some(1),
            }]
        );

        let multi_cfg = analyze(&FileInput {
            path: "package.json",
            before: Side::Text("{\n  \"name\": \"app\",\n  \"version\": \"1.0.0\"\n}\n"),
            after: Side::Text("{\n  \"name\": \"web\",\n  \"version\": \"1.1.0\"\n}\n"),
        });
        assert_eq!(multi_cfg.changes.len(), 2);
        assert_eq!(multi_cfg.spans, vec![ChangeSpan::default(); 2]);
    }

    #[test]
    fn special_row_spans() {
        let new_non_empty = analyze(&FileInput {
            path: "notes/new.md",
            before: Side::Absent,
            after: Side::Text("one\ntwo\n"),
        });
        assert_eq!(
            new_non_empty.spans,
            vec![ChangeSpan {
                line: Some(1),
                added: Some(2),
                removed: Some(0),
            }]
        );

        let new_empty = analyze(&FileInput {
            path: "notes/empty.md",
            before: Side::Absent,
            after: Side::Text(""),
        });
        assert_eq!(
            new_empty.spans,
            vec![ChangeSpan {
                line: None,
                added: Some(0),
                removed: Some(0),
            }]
        );

        let new_unknown = analyze(&FileInput {
            path: "notes/unknown.md",
            before: Side::Absent,
            after: Side::Unknown,
        });
        assert_eq!(new_unknown.spans, vec![ChangeSpan::default()]);

        let deleted = analyze(&FileInput {
            path: "notes/old.md",
            before: Side::Text("one\ntwo\nthree\n"),
            after: Side::Absent,
        });
        assert_eq!(
            deleted.spans,
            vec![ChangeSpan {
                line: None,
                added: Some(0),
                removed: Some(3),
            }]
        );

        let big = "a".repeat(MAX_BYTES + 1);
        let too_big = analyze(&FileInput {
            path: "notes/big.md",
            before: Side::Text(&big),
            after: Side::Text("ok"),
        });
        assert_eq!(too_big.spans, vec![ChangeSpan::default()]);

        let not_captured = analyze(&FileInput {
            path: "notes/nc.md",
            before: Side::Unknown,
            after: Side::Text("ok"),
        });
        assert_eq!(not_captured.spans, vec![ChangeSpan::default()]);

        let crlf_format = analyze(&FileInput {
            path: "notes/fmt.md",
            before: Side::Text("a\r\n"),
            after: Side::Text("a\n"),
        });
        assert_eq!(crlf_format.spans, vec![ChangeSpan::default()]);

        let ts_format = analyze(&FileInput {
            path: "src/fmt.ts",
            before: Side::Text("function f() { return 1; }\n"),
            after: Side::Text("function f() {\n  return 1;\n}\n"),
        });
        assert_eq!(ts_format.changes.len(), 1);
        assert_eq!(ts_format.changes[0].labels, vec![Label::FormatOnly {}]);
        assert_eq!(ts_format.spans, vec![ChangeSpan::default()]);

        let json_format = analyze(&FileInput {
            path: "cfg.json",
            before: Side::Text(r#"{"a":1,"b":2}"#),
            after: Side::Text(r#"{"b":2,"a":1}"#),
        });
        assert_eq!(json_format.changes.len(), 1);
        assert_eq!(json_format.changes[0].labels, vec![Label::FormatOnly {}]);
        assert_eq!(json_format.spans, vec![ChangeSpan::default()]);
    }

    #[test]
    fn grammar_large_file_and_dropped_outside_lines() {
        use std::fmt::Write;

        let mut before = String::from("function top() {\n  return 1;\n}\n");
        let mut after = String::from("function top() {\n  return 2;\n}\n");
        for i in 0..MAX_DIFF_ITEMS {
            let _ = writeln!(before, "const k_{i} = {i};");
            let _ = writeln!(after, "const k_{i} = {i};");
        }
        before.push_str("function gone() {\n  return 9;\n}\n");

        let large = analyze(&FileInput {
            path: "src/large.ts",
            before: Side::Text(&before),
            after: Side::Text(&after),
        });
        assert_eq!(large.changes.len(), 2);
        assert_eq!(
            large.spans,
            vec![
                ChangeSpan {
                    line: Some(1),
                    added: None,
                    removed: None,
                },
                ChangeSpan {
                    line: None,
                    added: None,
                    removed: None,
                },
            ]
        );

        let dropped_outside = analyze(&FileInput {
            path: "src/drop.ts",
            before: Side::Text("function work() {\n  return 1;\n}\n"),
            after: Side::Text("// added comment\nfunction work() {\n  return 2;\n}\n"),
        });
        assert_eq!(dropped_outside.changes.len(), 1);
        assert_eq!(
            dropped_outside.spans,
            vec![ChangeSpan {
                line: Some(2),
                added: Some(1),
                removed: Some(1),
            }]
        );

        let renamed = analyze(&FileInput {
            path: "src/rename.ts",
            before: Side::Text("function oldName(x: number) {\n  return x + 1;\n}\n"),
            after: Side::Text("function newName(x: number) {\n  return x + 1;\n}\n"),
        });
        assert_eq!(renamed.changes.len(), 1);
        assert_eq!(
            renamed.spans,
            vec![ChangeSpan {
                line: Some(1),
                added: Some(1),
                removed: Some(1),
            }]
        );

        let syntax_err = analyze(&FileInput {
            path: "src/broken.rs",
            before: Side::Text("fn ok() {\n    let x = 1;\n}\n"),
            after: Side::Text("fn ok() {\n    let x = ;\n}\n"),
        });
        assert_eq!(
            syntax_err.changes[0].labels,
            vec![Label::LinesChanged {
                added: 1,
                removed: 1
            }]
        );
        assert_eq!(
            syntax_err.spans,
            vec![ChangeSpan {
                line: Some(2),
                added: Some(1),
                removed: Some(1),
            }]
        );
    }

    #[test]
    fn plain_large_file_preserves_change_line() {
        use std::fmt::Write;

        let old_len = MAX_DIFF_ITEMS + 1;
        let mut before = String::new();
        for i in 0..old_len {
            let _ = writeln!(before, "line {i}");
        }
        assert!(before.len() < MAX_BYTES);

        let prepended_after = format!("prepended line\n{before}");
        let prepended = analyze(&FileInput {
            path: "notes/large.md",
            before: Side::Text(&before),
            after: Side::Text(&prepended_after),
        });
        assert_eq!(
            prepended.changes,
            vec![Change::new(
                None,
                vec![Label::LinesChanged {
                    added: 1,
                    removed: 0,
                }]
            )]
        );
        assert_eq!(
            prepended.spans,
            vec![ChangeSpan {
                line: Some(1),
                added: Some(1),
                removed: Some(0),
            }]
        );

        let appended_after = format!("{before}appended line\n");
        let appended = analyze(&FileInput {
            path: "notes/large.md",
            before: Side::Text(&before),
            after: Side::Text(&appended_after),
        });
        assert_eq!(
            appended.changes,
            vec![Change::new(
                None,
                vec![Label::LinesChanged {
                    added: 1,
                    removed: 0,
                }]
            )]
        );
        assert_eq!(
            appended.spans,
            vec![ChangeSpan {
                line: Some(text::saturating_u32(old_len + 1)),
                added: Some(1),
                removed: Some(0),
            }]
        );

        let trimmed_after = before
            .strip_suffix(&format!("line {}\n", old_len - 1))
            .unwrap();
        let prefix_deleted = analyze(&FileInput {
            path: "notes/large.md",
            before: Side::Text(&before),
            after: Side::Text(trimmed_after),
        });
        assert_eq!(
            prefix_deleted.spans,
            vec![ChangeSpan {
                line: None,
                added: Some(0),
                removed: Some(1),
            }]
        );
    }
}
