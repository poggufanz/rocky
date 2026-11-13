use crate::lang::lang_for_path;
use crate::model::{Change, FileFacts, FileInput, Label, Lang, MAX_BYTES, Side};
use crate::text;

fn too_large(side: Side<'_>) -> bool {
    matches!(side, Side::Text(s) if s.len() > MAX_BYTES)
}

fn single_change(lang: Lang, label: Label) -> FileFacts {
    FileFacts {
        lang,
        changes: vec![Change::new(None, vec![label])],
    }
}

/// Analyzes a file change from its path and before/after states into structured `FileFacts`.
pub fn analyze(input: &FileInput<'_>) -> FileFacts {
    let lang = lang_for_path(input.path);

    if too_large(input.before) || too_large(input.after) {
        return single_change(lang, Label::TooLarge {});
    }

    if matches!(input.after, Side::Absent) {
        let changes = if matches!(input.before, Side::Absent) {
            Vec::new()
        } else {
            vec![Change::new(None, vec![Label::FileDeleted {}])]
        };
        return FileFacts { lang, changes };
    }

    if matches!(input.before, Side::Absent) {
        return single_change(lang, Label::FileNew {});
    }

    let (Side::Text(before), Side::Text(after)) = (input.before, input.after) else {
        return single_change(lang, Label::NotCaptured {});
    };

    if before == after {
        return FileFacts {
            lang,
            changes: Vec::new(),
        };
    }

    let norm_before = text::normalize(before);
    let norm_after = text::normalize(after);
    if norm_before == norm_after {
        return single_change(lang, Label::FormatOnly {});
    }

    let label = match lang {
        Lang::Lockfile => Label::LockfileChanged {},
        Lang::Plain
        | Lang::Typescript
        | Lang::Tsx
        | Lang::Javascript
        | Lang::Rust
        | Lang::PackageJson
        | Lang::CargoToml
        | Lang::Json
        | Lang::Toml => {
            let (added, removed) = text::line_counts(&norm_before, &norm_after);
            Label::LinesChanged { added, removed }
        }
    };

    single_change(lang, label)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Importance, MAX_BYTES};

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
    }
}
