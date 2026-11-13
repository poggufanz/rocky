use serde::Serialize;

/// Maximum input size in bytes for a single side before emitting `TooLarge`.
pub const MAX_BYTES: usize = 1_048_576;
/// Maximum item count per side for Myers diffing before falling back to multiset comparison.
pub const MAX_DIFF_ITEMS: usize = 10_000;
/// Maximum number of labels kept on a single `Change` after sorting.
pub const MAX_LABELS_PER_CHANGE: usize = 12;

/// State of one side (`before` or `after`) of an analyzed file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side<'a> {
    Unknown,
    Absent,
    Text(&'a str),
}

/// Input passed to `analyze` describing a file path and its before/after contents.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileInput<'a> {
    pub path: &'a str,
    pub before: Side<'a>,
    pub after: Side<'a>,
}

/// Language or file classification derived from a file path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Lang {
    Typescript,
    Tsx,
    Javascript,
    Rust,
    PackageJson,
    CargoToml,
    Json,
    Toml,
    Lockfile,
    Plain,
}

/// Relative significance of a change or label.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Importance {
    None,
    Low,
    Medium,
    High,
}

/// Kind of symbol associated with a change.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SymbolKind {
    Function,
    Method,
    Class,
    Struct,
    Enum,
    Trait,
    Interface,
    Type,
    Const,
    Test,
    Key,
}

/// Identified symbol within a file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Symbol {
    pub kind: SymbolKind,
    pub name: String,
    pub container: Option<String>,
    pub exported: bool,
    #[serde(skip_serializing_if = "is_zero")]
    pub nth: u32,
}

fn is_zero(value: &u32) -> bool {
    *value == 0
}

/// Closed catalog of change fact labels.
///
/// Variant declaration order defines the tie-break order when two labels share the same importance.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(tag = "id", content = "args", rename_all = "snake_case")]
pub enum Label {
    ParamsChanged {
        added: u32,
        removed: u32,
        changed: u32,
    },
    ReturnTypeChanged {},
    SymbolRemoved {},
    SymbolAdded {},
    SymbolRenamed {
        from: String,
    },
    GuardAdded {},
    ConditionChanged {},
    BranchAdded {},
    BranchRemoved {},
    ErrorHandlingAdded {},
    ErrorHandlingRemoved {},
    LoopAdded {},
    LoopRemoved {},
    ReturnChanged {},
    CallAdded {
        name: String,
    },
    CallRemoved {
        name: String,
    },
    AwaitChanged {
        added: u32,
        removed: u32,
    },
    BodyChanged {},
    ValueChanged {
        name: String,
        before: String,
        after: String,
    },
    ConfigChanged {
        key: String,
        before: Option<String>,
        after: Option<String>,
    },
    DepAdded {
        name: String,
        version: String,
    },
    DepRemoved {
        name: String,
    },
    DepVersion {
        name: String,
        before: String,
        after: String,
    },
    ImportAdded {
        module: String,
    },
    ImportRemoved {
        module: String,
    },
    TestAdded {
        name: String,
    },
    TestRemoved {
        name: String,
    },
    TestSkipped {
        name: String,
    },
    TestOnly {
        name: String,
    },
    FileNew {},
    FileDeleted {},
    FileRenamed {
        from: String,
    },
    FormatOnly {},
    Rewrite {
        pct: u32,
    },
    LockfileChanged {},
    LinesChanged {
        added: u32,
        removed: u32,
    },
    TooLarge {},
    NotCaptured {},
}

impl Label {
    /// Returns the importance of this label, accounting for whether the owning symbol is exported.
    pub fn importance(&self, exported: bool) -> Importance {
        match self {
            Label::ParamsChanged { .. } | Label::ReturnTypeChanged {} | Label::SymbolRemoved {} => {
                if exported {
                    Importance::High
                } else {
                    Importance::Medium
                }
            }
            Label::ErrorHandlingRemoved {}
            | Label::DepAdded { .. }
            | Label::DepRemoved { .. }
            | Label::DepVersion { .. }
            | Label::TestRemoved { .. }
            | Label::TestSkipped { .. }
            | Label::TestOnly { .. } => Importance::High,
            Label::CallAdded { .. }
            | Label::CallRemoved { .. }
            | Label::AwaitChanged { .. }
            | Label::BodyChanged {}
            | Label::ImportAdded { .. }
            | Label::ImportRemoved { .. }
            | Label::TestAdded { .. }
            | Label::Rewrite { .. }
            | Label::LockfileChanged {}
            | Label::LinesChanged { .. }
            | Label::TooLarge {}
            | Label::NotCaptured {} => Importance::Low,
            Label::FormatOnly {} => Importance::None,
            Label::SymbolAdded {}
            | Label::SymbolRenamed { .. }
            | Label::GuardAdded {}
            | Label::ConditionChanged {}
            | Label::BranchAdded {}
            | Label::BranchRemoved {}
            | Label::ErrorHandlingAdded {}
            | Label::LoopAdded {}
            | Label::LoopRemoved {}
            | Label::ReturnChanged {}
            | Label::ValueChanged { .. }
            | Label::ConfigChanged { .. }
            | Label::FileNew {}
            | Label::FileDeleted {}
            | Label::FileRenamed { .. } => Importance::Medium,
        }
    }
}

/// One symbol-level or file-level change unit with ordered, capped labels.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Change {
    pub symbol: Option<Symbol>,
    pub labels: Vec<Label>,
    pub importance: Importance,
}

impl Change {
    /// Builds a `Change`, sorting labels by importance descending then catalog order, capped at `MAX_LABELS_PER_CHANGE`.
    pub fn new(symbol: Option<Symbol>, mut labels: Vec<Label>) -> Change {
        let exported = symbol.as_ref().is_some_and(|s| s.exported);
        labels.sort_by(|a, b| {
            b.importance(exported)
                .cmp(&a.importance(exported))
                .then_with(|| a.cmp(b))
        });
        labels.truncate(MAX_LABELS_PER_CHANGE);
        let importance = labels
            .first()
            .map_or(Importance::None, |l| l.importance(exported));
        Change {
            symbol,
            labels,
            importance,
        }
    }
}

/// Complete change facts produced for a single file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FileFacts {
    pub lang: Lang,
    pub changes: Vec<Change>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn private_fn() -> Symbol {
        Symbol {
            kind: SymbolKind::Function,
            name: "work".to_string(),
            container: None,
            exported: false,
            nth: 0,
        }
    }

    #[test]
    fn label_json_shape() {
        assert_eq!(
            serde_json::to_string(&Label::GuardAdded {}).unwrap(),
            r#"{"id":"guard_added","args":{}}"#
        );
        assert_eq!(
            serde_json::to_string(&Label::CallAdded {
                name: "save".to_string()
            })
            .unwrap(),
            r#"{"id":"call_added","args":{"name":"save"}}"#
        );
    }

    #[test]
    fn symbol_nth_serialization() {
        let mut sym = private_fn();
        assert_eq!(
            serde_json::to_string(&sym).unwrap(),
            r#"{"kind":"function","name":"work","container":null,"exported":false}"#
        );
        sym.nth = 2;
        assert_eq!(
            serde_json::to_string(&sym).unwrap(),
            r#"{"kind":"function","name":"work","container":null,"exported":false,"nth":2}"#
        );
    }

    #[test]
    fn importance_table() {
        let cases = [
            (
                Label::ParamsChanged {
                    added: 1,
                    removed: 0,
                    changed: 0,
                },
                Importance::Medium,
                Importance::High,
            ),
            (
                Label::ReturnTypeChanged {},
                Importance::Medium,
                Importance::High,
            ),
            (
                Label::SymbolRemoved {},
                Importance::Medium,
                Importance::High,
            ),
            (
                Label::SymbolAdded {},
                Importance::Medium,
                Importance::Medium,
            ),
            (
                Label::SymbolRenamed {
                    from: "old".to_string(),
                },
                Importance::Medium,
                Importance::Medium,
            ),
            (Label::GuardAdded {}, Importance::Medium, Importance::Medium),
            (
                Label::ConditionChanged {},
                Importance::Medium,
                Importance::Medium,
            ),
            (
                Label::BranchAdded {},
                Importance::Medium,
                Importance::Medium,
            ),
            (
                Label::BranchRemoved {},
                Importance::Medium,
                Importance::Medium,
            ),
            (
                Label::ErrorHandlingAdded {},
                Importance::Medium,
                Importance::Medium,
            ),
            (
                Label::ErrorHandlingRemoved {},
                Importance::High,
                Importance::High,
            ),
            (Label::LoopAdded {}, Importance::Medium, Importance::Medium),
            (
                Label::LoopRemoved {},
                Importance::Medium,
                Importance::Medium,
            ),
            (
                Label::ReturnChanged {},
                Importance::Medium,
                Importance::Medium,
            ),
            (
                Label::CallAdded {
                    name: "f".to_string(),
                },
                Importance::Low,
                Importance::Low,
            ),
            (
                Label::CallRemoved {
                    name: "f".to_string(),
                },
                Importance::Low,
                Importance::Low,
            ),
            (
                Label::AwaitChanged {
                    added: 1,
                    removed: 0,
                },
                Importance::Low,
                Importance::Low,
            ),
            (Label::BodyChanged {}, Importance::Low, Importance::Low),
            (
                Label::ValueChanged {
                    name: "X".to_string(),
                    before: "1".to_string(),
                    after: "2".to_string(),
                },
                Importance::Medium,
                Importance::Medium,
            ),
            (
                Label::ConfigChanged {
                    key: "k".to_string(),
                    before: None,
                    after: Some("v".to_string()),
                },
                Importance::Medium,
                Importance::Medium,
            ),
            (
                Label::DepAdded {
                    name: "a".to_string(),
                    version: "1".to_string(),
                },
                Importance::High,
                Importance::High,
            ),
            (
                Label::DepRemoved {
                    name: "a".to_string(),
                },
                Importance::High,
                Importance::High,
            ),
            (
                Label::DepVersion {
                    name: "a".to_string(),
                    before: "1".to_string(),
                    after: "2".to_string(),
                },
                Importance::High,
                Importance::High,
            ),
            (
                Label::ImportAdded {
                    module: "m".to_string(),
                },
                Importance::Low,
                Importance::Low,
            ),
            (
                Label::ImportRemoved {
                    module: "m".to_string(),
                },
                Importance::Low,
                Importance::Low,
            ),
            (
                Label::TestAdded {
                    name: "t".to_string(),
                },
                Importance::Low,
                Importance::Low,
            ),
            (
                Label::TestRemoved {
                    name: "t".to_string(),
                },
                Importance::High,
                Importance::High,
            ),
            (
                Label::TestSkipped {
                    name: "t".to_string(),
                },
                Importance::High,
                Importance::High,
            ),
            (
                Label::TestOnly {
                    name: "t".to_string(),
                },
                Importance::High,
                Importance::High,
            ),
            (Label::FileNew {}, Importance::Medium, Importance::Medium),
            (
                Label::FileDeleted {},
                Importance::Medium,
                Importance::Medium,
            ),
            (
                Label::FileRenamed {
                    from: "a".to_string(),
                },
                Importance::Medium,
                Importance::Medium,
            ),
            (Label::FormatOnly {}, Importance::None, Importance::None),
            (Label::Rewrite { pct: 80 }, Importance::Low, Importance::Low),
            (Label::LockfileChanged {}, Importance::Low, Importance::Low),
            (
                Label::LinesChanged {
                    added: 1,
                    removed: 1,
                },
                Importance::Low,
                Importance::Low,
            ),
            (Label::TooLarge {}, Importance::Low, Importance::Low),
            (Label::NotCaptured {}, Importance::Low, Importance::Low),
        ];

        for (label, private_expected, exported_expected) in cases {
            assert_eq!(
                label.importance(false),
                private_expected,
                "private importance mismatch for {label:?}"
            );
            assert_eq!(
                label.importance(true),
                exported_expected,
                "exported importance mismatch for {label:?}"
            );
        }
    }

    #[test]
    fn change_orders_labels() {
        let change = Change::new(
            Some(private_fn()),
            vec![
                Label::CallAdded {
                    name: "b".to_string(),
                },
                Label::GuardAdded {},
                Label::CallAdded {
                    name: "a".to_string(),
                },
                Label::ErrorHandlingRemoved {},
            ],
        );

        assert_eq!(change.importance, Importance::High);
        assert_eq!(
            change.labels,
            vec![
                Label::ErrorHandlingRemoved {},
                Label::GuardAdded {},
                Label::CallAdded {
                    name: "a".to_string(),
                },
                Label::CallAdded {
                    name: "b".to_string(),
                },
            ]
        );
    }

    #[test]
    fn change_caps_labels() {
        let labels = (0..20)
            .rev()
            .map(|i| Label::CallAdded {
                name: format!("call_{i:02}"),
            })
            .collect();
        let change = Change::new(Some(private_fn()), labels);
        assert_eq!(change.labels.len(), MAX_LABELS_PER_CHANGE);
        assert_eq!(
            change.labels[0],
            Label::CallAdded {
                name: "call_00".to_string()
            }
        );
        assert_eq!(
            change.labels[11],
            Label::CallAdded {
                name: "call_11".to_string()
            }
        );
    }
}
