use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use rocky_facts::{FileInput, Side, analyze, debug, snippet};
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

            let facts = analyze(&input);
            let first = format!(
                "{}\n",
                serde_json::to_string_pretty(&facts).expect("serialize facts")
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

            let snippet_path = case_dir.join("snippet.txt");
            if snippet_path.exists() {
                let render_all = || {
                    let blocks: Vec<String> = facts
                        .changes
                        .iter()
                        .map(|change| {
                            let lines = snippet(&input, change.symbol.as_ref());
                            debug::render(change.symbol.as_ref(), &lines)
                        })
                        .collect();
                    if blocks.is_empty() {
                        String::new()
                    } else {
                        format!("{}\n", blocks.join("\n\n"))
                    }
                };
                let first_snippet = render_all();
                let second_snippet = render_all();
                if first_snippet != second_snippet {
                    failures.push(format!(
                        "{case_name}: non-deterministic snippet output\nfirst:\n{first_snippet}\nsecond:\n{second_snippet}"
                    ));
                    continue;
                }
                match fs::read(&snippet_path) {
                    Ok(expected_bytes) => {
                        if first_snippet.as_bytes() != expected_bytes.as_slice() {
                            let expected_str = String::from_utf8_lossy(&expected_bytes);
                            failures.push(format!(
                                "{case_name}: snippet.txt mismatch\nexpected:\n{expected_str}\nactual:\n{first_snippet}"
                            ));
                        }
                    }
                    Err(err) => {
                        failures.push(format!(
                            "{case_name}: missing or unreadable snippet.txt ({err})\nactual:\n{first_snippet}"
                        ));
                    }
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

#[test]
fn catalog_coverage() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/facts");
    let mut actual = BTreeSet::new();

    for lang_dir in sorted_subdirs(&root) {
        for case_dir in sorted_subdirs(&lang_dir) {
            let raw = fs::read_to_string(case_dir.join("expected.json"))
                .unwrap_or_else(|err| panic!("failed to read {}: {err}", case_dir.display()));
            let doc: serde_json::Value = serde_json::from_str(&raw)
                .unwrap_or_else(|err| panic!("invalid JSON in {}: {err}", case_dir.display()));
            if let Some(changes) = doc.get("changes").and_then(|v| v.as_array()) {
                for change in changes {
                    if let Some(labels) = change.get("labels").and_then(|v| v.as_array()) {
                        for label in labels {
                            if let Some(id) = label.get("id").and_then(|v| v.as_str()) {
                                actual.insert(id.to_string());
                            }
                        }
                    }
                }
            }
        }
    }

    let expected: BTreeSet<String> = [
        "params_changed",
        "return_type_changed",
        "symbol_removed",
        "symbol_added",
        "symbol_renamed",
        "guard_added",
        "condition_changed",
        "branch_added",
        "branch_removed",
        "error_handling_added",
        "error_handling_removed",
        "loop_added",
        "loop_removed",
        "return_changed",
        "call_added",
        "call_removed",
        "await_changed",
        "body_changed",
        "value_changed",
        "config_changed",
        "dep_added",
        "dep_removed",
        "dep_version",
        "import_added",
        "import_removed",
        "test_added",
        "test_removed",
        "test_skipped",
        "test_only",
        "file_new",
        "file_deleted",
        "format_only",
        "rewrite",
        "lockfile_changed",
        "lines_changed",
        "not_captured",
    ]
    .into_iter()
    .map(str::to_string)
    .collect();

    let missing: Vec<&String> = expected.difference(&actual).collect();
    let extra: Vec<&String> = actual.difference(&expected).collect();
    assert!(
        missing.is_empty() && extra.is_empty(),
        "catalog coverage mismatch: missing={missing:?}, extra={extra:?}"
    );
}

fn build_perf_ts(file_idx: usize, modified: bool) -> String {
    use std::fmt::Write;
    let mut out = String::with_capacity(102_400);
    for fn_idx in 0..500 {
        let changed = modified && fn_idx % 100 == 10;
        let _ = writeln!(
            out,
            "export function worker_{file_idx}_{fn_idx}(a: number, b: number): number {{"
        );
        let _ = writeln!(out, "  let acc = a + b + {fn_idx};");
        if changed {
            let _ = writeln!(out, "  if (acc < 0) return 0;");
        }
        let _ = writeln!(out, "  for (let i = 0; i < 4; i++) {{");
        let _ = writeln!(out, "    acc += helper_{fn_idx}(i, acc);");
        let _ = writeln!(out, "  }}");
        let _ = writeln!(out, "  const res = acc * 2 - a;");
        let _ = writeln!(out, "  return res + b;");
        let _ = writeln!(out, "}}");
        let _ = writeln!(out);
    }
    out
}

#[test]
#[ignore]
fn perf_twenty_files() {
    const MAX_PERF_FILE_BYTES: usize = 102_400;
    let files: Vec<(String, String, String)> = (0..20)
        .map(|i| {
            let path = format!("src/perf_{i}.ts");
            let before = build_perf_ts(i, false);
            let after = build_perf_ts(i, true);
            assert!(
                before.len() <= MAX_PERF_FILE_BYTES && after.len() <= MAX_PERF_FILE_BYTES,
                "generated file exceeds 100 KiB: before={}, after={}",
                before.len(),
                after.len()
            );
            (path, before, after)
        })
        .collect();

    let warmup_input = FileInput {
        path: &files[0].0,
        before: Side::Text(&files[0].1),
        after: Side::Text(&files[0].2),
    };
    let _ = analyze(&warmup_input);

    let workers = std::thread::available_parallelism()
        .map(std::num::NonZeroUsize::get)
        .unwrap_or(1)
        .min(files.len());

    let files_slice = files.as_slice();
    let par_start = Instant::now();
    let par_changes: usize = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..workers)
            .map(|worker_idx| {
                scope.spawn(move || {
                    let mut count = 0usize;
                    for (path, before, after) in
                        files_slice.iter().skip(worker_idx).step_by(workers)
                    {
                        let input = FileInput {
                            path,
                            before: Side::Text(before),
                            after: Side::Text(after),
                        };
                        count += analyze(&input).changes.len();
                    }
                    count
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|handle| handle.join().expect("perf worker thread panicked"))
            .sum()
    });
    let parallel_analyze_time = par_start.elapsed();

    let seq_start = Instant::now();
    let mut seq_facts = Vec::with_capacity(files.len());
    let mut total_changes = 0usize;
    for (path, before, after) in &files {
        let input = FileInput {
            path,
            before: Side::Text(before),
            after: Side::Text(after),
        };
        let facts = analyze(&input);
        total_changes += facts.changes.len();
        seq_facts.push(facts);
    }
    let single_thread_analyze_time = seq_start.elapsed();

    let snippet_start = Instant::now();
    for ((path, before, after), facts) in files.iter().zip(&seq_facts) {
        let input = FileInput {
            path,
            before: Side::Text(before),
            after: Side::Text(after),
        };
        for change in &facts.changes {
            let lines = snippet(&input, change.symbol.as_ref());
            assert!(!lines.is_empty());
        }
    }
    let snippet_time = snippet_start.elapsed();

    println!(
        "perf_twenty_files: workers={workers}, parallel_analyze={parallel_analyze_time:?}, single_thread_analyze={single_thread_analyze_time:?}, snippet={snippet_time:?}, changes={total_changes}"
    );
    assert_eq!(par_changes, 100);
    assert_eq!(total_changes, 100);
    assert!(
        parallel_analyze_time <= Duration::from_millis(500),
        "parallel analyze took {parallel_analyze_time:?}, expected <= 500ms"
    );
}
