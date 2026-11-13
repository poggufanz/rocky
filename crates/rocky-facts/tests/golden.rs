use std::fs;
use std::path::{Path, PathBuf};

use rocky_facts::{FileInput, Side, analyze};
use serde::Deserialize;

#[derive(Deserialize)]
struct Meta {
    path: String,
    #[serde(default = "default_file")]
    before: String,
    #[serde(default = "default_file")]
    after: String,
}

fn default_file() -> String {
    "file".to_string()
}

fn sorted_subdirs(dir: &Path) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = fs::read_dir(dir)
        .unwrap_or_else(|err| panic!("failed to read {}: {err}", dir.display()))
        .filter_map(|entry| {
            let path = entry.ok()?.path();
            path.is_dir().then_some(path)
        })
        .collect();
    dirs.sort_by(|a, b| a.file_name().cmp(&b.file_name()));
    dirs
}

fn load_side(
    case_dir: &Path,
    file_name: &str,
    flag: &str,
    allow_unknown: bool,
) -> Result<Option<String>, String> {
    match flag {
        "file" => {
            let text = fs::read_to_string(case_dir.join(file_name))
                .map_err(|err| format!("failed to read {file_name}: {err}"))?;
            Ok(Some(text))
        }
        "absent" => Ok(None),
        "unknown" if allow_unknown => Ok(None),
        other => Err(format!("unsupported {file_name} flag {other:?}")),
    }
}

fn to_side<'a>(flag: &str, loaded: &'a Option<String>) -> Side<'a> {
    match flag {
        "file" => Side::Text(loaded.as_deref().expect("loaded text for file side")),
        "absent" => Side::Absent,
        "unknown" => Side::Unknown,
        _ => unreachable!(),
    }
}

#[test]
fn golden_fixtures() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/facts");
    let mut case_count = 0usize;
    let mut failures = Vec::new();

    for lang_dir in sorted_subdirs(&root) {
        let lang_name = lang_dir
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("<non-utf8>");

        for case_dir in sorted_subdirs(&lang_dir) {
            case_count += 1;
            let case_name = format!(
                "{lang_name}/{}",
                case_dir
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("<non-utf8>")
            );

            let meta_raw = match fs::read_to_string(case_dir.join("meta.json")) {
                Ok(raw) => raw,
                Err(err) => {
                    failures.push(format!("{case_name}: failed to read meta.json: {err}"));
                    continue;
                }
            };
            let meta: Meta = match serde_json::from_str(&meta_raw) {
                Ok(meta) => meta,
                Err(err) => {
                    failures.push(format!("{case_name}: invalid meta.json: {err}"));
                    continue;
                }
            };

            let before_text = match load_side(&case_dir, "before", &meta.before, true) {
                Ok(text) => text,
                Err(err) => {
                    failures.push(format!("{case_name}: {err}"));
                    continue;
                }
            };
            let after_text = match load_side(&case_dir, "after", &meta.after, false) {
                Ok(text) => text,
                Err(err) => {
                    failures.push(format!("{case_name}: {err}"));
                    continue;
                }
            };

            let input = FileInput {
                path: &meta.path,
                before: to_side(&meta.before, &before_text),
                after: to_side(&meta.after, &after_text),
            };

            let first = format!(
                "{}\n",
                serde_json::to_string_pretty(&analyze(&input)).expect("serialize facts")
            );
            let second = format!(
                "{}\n",
                serde_json::to_string_pretty(&analyze(&input)).expect("serialize facts")
            );
            if first != second {
                failures.push(format!(
                    "{case_name}: non-deterministic output\nfirst:\n{first}\nsecond:\n{second}"
                ));
                continue;
            }

            match fs::read(case_dir.join("expected.json")) {
                Ok(expected_bytes) => {
                    if first.as_bytes() != expected_bytes.as_slice() {
                        let expected_str = String::from_utf8_lossy(&expected_bytes);
                        failures.push(format!(
                            "{case_name}: output mismatch\nexpected:\n{expected_str}\nactual:\n{first}"
                        ));
                    }
                }
                Err(err) => {
                    failures.push(format!(
                        "{case_name}: missing or unreadable expected.json ({err})\nactual:\n{first}"
                    ));
                }
            }
        }
    }

    assert!(
        case_count > 0,
        "no golden fixtures found under {}",
        root.display()
    );
    assert!(
        failures.is_empty(),
        "{} of {case_count} golden fixture(s) failed:\n\n{}",
        failures.len(),
        failures.join("\n---\n")
    );
}
