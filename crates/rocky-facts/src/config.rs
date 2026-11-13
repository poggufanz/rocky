use std::collections::{BTreeMap, BTreeSet};

use crate::model::{Change, Label, Lang, Symbol, SymbolKind};
use crate::text::cut;

const MAX_KEY_CHARS: usize = 80;
const MAX_VALUE_CHARS: usize = 60;

const PACKAGE_DEP_SECTIONS: &[&str] = &[
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
];

const CARGO_DEP_SECTIONS: &[&str] = &["dependencies", "dev-dependencies", "build-dependencies"];

/// Normalized configuration value backed by `BTreeMap` so object key order is always deterministic.
#[derive(Debug, Clone, PartialEq, Eq)]
enum ConfigValue {
    Null,
    Bool(bool),
    Number(String),
    String(String),
    Array(Vec<ConfigValue>),
    Object(BTreeMap<String, ConfigValue>),
}

enum RenderTask<'a> {
    Value(&'a ConfigValue),
    Raw(&'static str),
    Key(&'a str),
}

impl ConfigValue {
    /// Renders as compact JSON with object keys sorted lexicographically.
    fn render_compact(&self) -> String {
        let mut out = String::new();
        let mut stack = vec![RenderTask::Value(self)];
        while let Some(task) = stack.pop() {
            match task {
                RenderTask::Raw(s) => out.push_str(s),
                RenderTask::Key(k) => {
                    out.push_str(&serde_json::to_string(k).expect("string JSON serialization"));
                }
                RenderTask::Value(val) => match val {
                    ConfigValue::Null => out.push_str("null"),
                    ConfigValue::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
                    ConfigValue::Number(n) => out.push_str(n),
                    ConfigValue::String(s) => {
                        out.push_str(&serde_json::to_string(s).expect("string JSON serialization"));
                    }
                    ConfigValue::Array(items) => {
                        out.push('[');
                        stack.push(RenderTask::Raw("]"));
                        for (idx, item) in items.iter().enumerate().rev() {
                            stack.push(RenderTask::Value(item));
                            if idx > 0 {
                                stack.push(RenderTask::Raw(","));
                            }
                        }
                    }
                    ConfigValue::Object(map) => {
                        // BTreeMap ordering keeps nested JSON object keys independent of preserve_order.
                        out.push('{');
                        stack.push(RenderTask::Raw("}"));
                        for (idx, (k, v)) in map.iter().enumerate().rev() {
                            stack.push(RenderTask::Value(v));
                            stack.push(RenderTask::Raw(":"));
                            stack.push(RenderTask::Key(k));
                            if idx > 0 {
                                stack.push(RenderTask::Raw(","));
                            }
                        }
                    }
                },
            }
        }
        out
    }

    /// Renders a leaf or dependency entry: unquoted for strings, compact JSON otherwise.
    fn render_leaf(&self) -> String {
        match self {
            ConfigValue::String(s) => s.clone(),
            _ => self.render_compact(),
        }
    }
}

fn from_json(value: serde_json::Value) -> ConfigValue {
    match value {
        serde_json::Value::Null => ConfigValue::Null,
        serde_json::Value::Bool(b) => ConfigValue::Bool(b),
        serde_json::Value::Number(n) => ConfigValue::Number(n.to_string()),
        serde_json::Value::String(s) => ConfigValue::String(s),
        serde_json::Value::Array(items) => {
            ConfigValue::Array(items.into_iter().map(from_json).collect())
        }
        serde_json::Value::Object(map) => {
            let sorted = map.into_iter().map(|(k, v)| (k, from_json(v))).collect();
            ConfigValue::Object(sorted)
        }
    }
}

fn from_toml_table(table: toml::Table) -> BTreeMap<String, ConfigValue> {
    table
        .into_iter()
        .map(|(k, v)| (k, from_toml_value(v)))
        .collect()
}

fn from_toml_value(value: toml::Value) -> ConfigValue {
    match value {
        toml::Value::String(s) => ConfigValue::String(s),
        toml::Value::Integer(i) => ConfigValue::Number(i.to_string()),
        toml::Value::Float(f) => match serde_json::Number::from_f64(f) {
            Some(n) => ConfigValue::Number(n.to_string()),
            None => ConfigValue::String(f.to_string()),
        },
        toml::Value::Boolean(b) => ConfigValue::Bool(b),
        toml::Value::Datetime(dt) => ConfigValue::String(dt.to_string()),
        toml::Value::Array(items) => {
            ConfigValue::Array(items.into_iter().map(from_toml_value).collect())
        }
        toml::Value::Table(table) => ConfigValue::Object(from_toml_table(table)),
    }
}

fn parse_root(lang: Lang, text: &str) -> Option<BTreeMap<String, ConfigValue>> {
    match lang {
        Lang::Json | Lang::PackageJson => {
            let value: serde_json::Value = serde_json::from_str(text).ok()?;
            match from_json(value) {
                ConfigValue::Object(map) => Some(map),
                _ => None,
            }
        }
        Lang::Toml | Lang::CargoToml => {
            let table: toml::Table = toml::from_str(text).ok()?;
            Some(from_toml_table(table))
        }
        _ => None,
    }
}

fn get_at<'a>(map: &'a BTreeMap<String, ConfigValue>, path: &[String]) -> Option<&'a ConfigValue> {
    let (first, rest) = path.split_first()?;
    let mut current = map.get(first)?;
    for segment in rest {
        let ConfigValue::Object(child) = current else {
            return None;
        };
        current = child.get(segment)?;
    }
    Some(current)
}

fn is_dep_section_pair(
    before: &BTreeMap<String, ConfigValue>,
    after: &BTreeMap<String, ConfigValue>,
    path: &[String],
) -> bool {
    matches!(
        (get_at(before, path), get_at(after, path)),
        (Some(ConfigValue::Object(_)), Some(ConfigValue::Object(_)))
            | (Some(ConfigValue::Object(_)), None)
            | (None, Some(ConfigValue::Object(_)))
    )
}

fn collect_target_cfgs(root: &BTreeMap<String, ConfigValue>, out: &mut BTreeSet<String>) {
    if let Some(ConfigValue::Object(target_map)) = root.get("target") {
        for (cfg, val) in target_map {
            if matches!(val, ConfigValue::Object(_)) {
                out.insert(cfg.clone());
            }
        }
    }
}

fn dep_section_paths(
    lang: Lang,
    before: &BTreeMap<String, ConfigValue>,
    after: &BTreeMap<String, ConfigValue>,
) -> Vec<Vec<String>> {
    let mut candidates: Vec<Vec<String>> = match lang {
        Lang::PackageJson => PACKAGE_DEP_SECTIONS
            .iter()
            .map(|name| vec![(*name).to_string()])
            .collect(),
        Lang::CargoToml => {
            let mut paths: Vec<Vec<String>> = CARGO_DEP_SECTIONS
                .iter()
                .map(|name| vec![(*name).to_string()])
                .collect();
            paths.push(vec!["workspace".to_string(), "dependencies".to_string()]);

            let mut cfgs = BTreeSet::new();
            collect_target_cfgs(before, &mut cfgs);
            collect_target_cfgs(after, &mut cfgs);
            for cfg in cfgs {
                for section in CARGO_DEP_SECTIONS {
                    paths.push(vec![
                        "target".to_string(),
                        cfg.clone(),
                        (*section).to_string(),
                    ]);
                }
            }
            paths
        }
        _ => return Vec::new(),
    };

    candidates.retain(|path| is_dep_section_pair(before, after, path));
    candidates
}

fn take_object_at(
    map: &mut BTreeMap<String, ConfigValue>,
    path: &[String],
) -> BTreeMap<String, ConfigValue> {
    let Some((first, rest)) = path.split_first() else {
        return BTreeMap::new();
    };
    if rest.is_empty() {
        return match map.remove(first) {
            Some(ConfigValue::Object(obj)) => obj,
            _ => BTreeMap::new(),
        };
    }
    let Some(mut current) = map.get_mut(first) else {
        return BTreeMap::new();
    };
    for segment in &rest[..rest.len() - 1] {
        let ConfigValue::Object(child) = current else {
            return BTreeMap::new();
        };
        let Some(next) = child.get_mut(segment) else {
            return BTreeMap::new();
        };
        current = next;
    }
    let ConfigValue::Object(parent) = current else {
        return BTreeMap::new();
    };
    match parent.remove(&rest[rest.len() - 1]) {
        Some(ConfigValue::Object(obj)) => obj,
        _ => BTreeMap::new(),
    }
}

fn dep_version(val: &ConfigValue) -> Option<&str> {
    match val {
        ConfigValue::String(s) => Some(s.as_str()),
        ConfigValue::Object(map) => match map.get("version") {
            Some(ConfigValue::String(s)) => Some(s.as_str()),
            _ => None,
        },
        _ => None,
    }
}

fn diff_dep_section(
    section_path: &[String],
    before_deps: &BTreeMap<String, ConfigValue>,
    after_deps: &BTreeMap<String, ConfigValue>,
    groups: &mut BTreeMap<String, Vec<Label>>,
) {
    let top_key = &section_path[0];
    let section_name = section_path.join(".");
    let names: BTreeSet<&String> = before_deps.keys().chain(after_deps.keys()).collect();

    for name in names {
        let label = match (before_deps.get(name), after_deps.get(name)) {
            (None, Some(after_val)) => {
                let version = dep_version(after_val)
                    .map(str::to_string)
                    .unwrap_or_else(|| after_val.render_leaf());
                Label::DepAdded {
                    name: cut(name, MAX_KEY_CHARS),
                    version: cut(&version, MAX_VALUE_CHARS),
                }
            }
            (Some(_), None) => Label::DepRemoved {
                name: cut(name, MAX_KEY_CHARS),
            },
            (Some(before_val), Some(after_val)) => {
                if before_val == after_val {
                    continue;
                }
                match (dep_version(before_val), dep_version(after_val)) {
                    (Some(b_ver), Some(a_ver)) if b_ver != a_ver => Label::DepVersion {
                        name: cut(name, MAX_KEY_CHARS),
                        before: cut(b_ver, MAX_VALUE_CHARS),
                        after: cut(a_ver, MAX_VALUE_CHARS),
                    },
                    _ => Label::ConfigChanged {
                        key: cut(&format!("{section_name}.{name}"), MAX_KEY_CHARS),
                        before: Some(cut(&before_val.render_leaf(), MAX_VALUE_CHARS)),
                        after: Some(cut(&after_val.render_leaf(), MAX_VALUE_CHARS)),
                    },
                }
            }
            (None, None) => unreachable!(),
        };
        groups.entry(top_key.clone()).or_default().push(label);
    }
}

fn flatten_leaves(root: &BTreeMap<String, ConfigValue>) -> BTreeMap<Vec<String>, String> {
    let mut leaves = BTreeMap::new();
    let mut stack: Vec<(Vec<String>, &ConfigValue)> = Vec::new();
    for (k, v) in root.iter().rev() {
        stack.push((vec![k.clone()], v));
    }

    while let Some((path, val)) = stack.pop() {
        match val {
            ConfigValue::Object(map) => {
                for (k, v) in map.iter().rev() {
                    let mut child_path = path.clone();
                    child_path.push(k.clone());
                    stack.push((child_path, v));
                }
            }
            _ => {
                leaves.insert(path, val.render_leaf());
            }
        }
    }
    leaves
}

fn diff_leaves(
    before_leaves: &BTreeMap<Vec<String>, String>,
    after_leaves: &BTreeMap<Vec<String>, String>,
    groups: &mut BTreeMap<String, Vec<Label>>,
) {
    let paths: BTreeSet<&Vec<String>> = before_leaves.keys().chain(after_leaves.keys()).collect();
    for path in paths {
        let before_val = before_leaves.get(path);
        let after_val = after_leaves.get(path);
        if before_val == after_val {
            continue;
        }
        let top_key = &path[0];
        let full_key = path.join(".");
        let label = Label::ConfigChanged {
            key: cut(&full_key, MAX_KEY_CHARS),
            before: before_val.map(|v| cut(v, MAX_VALUE_CHARS)),
            after: after_val.map(|v| cut(v, MAX_VALUE_CHARS)),
        };
        groups.entry(top_key.clone()).or_default().push(label);
    }
}

/// Compares two JSON/TOML or manifest documents into grouped key and dependency `Change`s.
///
/// Returns `None` when either side fails to parse so the caller can fall back to `lines_changed`.
pub(crate) fn config_changes(lang: Lang, before: &str, after: &str) -> Option<Vec<Change>> {
    let mut before_map = parse_root(lang, before)?;
    let mut after_map = parse_root(lang, after)?;

    let mut groups: BTreeMap<String, Vec<Label>> = BTreeMap::new();

    // Compare dependency entries whole before flattening so table entries keep compact JSON values.
    for dep_path in dep_section_paths(lang, &before_map, &after_map) {
        let before_deps = take_object_at(&mut before_map, &dep_path);
        let after_deps = take_object_at(&mut after_map, &dep_path);
        diff_dep_section(&dep_path, &before_deps, &after_deps, &mut groups);
    }

    let before_leaves = flatten_leaves(&before_map);
    let after_leaves = flatten_leaves(&after_map);
    diff_leaves(&before_leaves, &after_leaves, &mut groups);

    if groups.is_empty() {
        return Some(vec![Change::new(None, vec![Label::FormatOnly {}])]);
    }

    let changes = groups
        .into_iter()
        .map(|(top_key, labels)| {
            let symbol = Symbol {
                kind: SymbolKind::Key,
                name: cut(&top_key, MAX_KEY_CHARS),
                container: None,
                exported: false,
                nth: 0,
            };
            Change::new(Some(symbol), labels)
        })
        .collect();
    Some(changes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Importance;

    #[test]
    fn toml_datetimes_and_scalars() {
        let before = "created = 2024-01-01T00:00:00Z\nratio = 1.5\nflag = true\n";
        let after = "created = 2025-06-15T12:30:00Z\nratio = 2.0\nflag = false\n";
        let changes = config_changes(Lang::Toml, before, after).expect("valid TOML");
        assert_eq!(changes.len(), 3);
        assert_eq!(
            changes[0].labels,
            vec![Label::ConfigChanged {
                key: "created".to_string(),
                before: Some("2024-01-01T00:00:00Z".to_string()),
                after: Some("2025-06-15T12:30:00Z".to_string()),
            }]
        );
        assert_eq!(
            changes[1].labels,
            vec![Label::ConfigChanged {
                key: "flag".to_string(),
                before: Some("true".to_string()),
                after: Some("false".to_string()),
            }]
        );
        assert_eq!(
            changes[2].labels,
            vec![Label::ConfigChanged {
                key: "ratio".to_string(),
                before: Some("1.5".to_string()),
                after: Some("2.0".to_string()),
            }]
        );
    }

    #[test]
    fn toml_format_and_comment_only() {
        let before = "# header\ncount = 1000\nname = 'app'\n";
        let after = "name = \"app\"\ncount = 1_000\n";
        let changes = config_changes(Lang::Toml, before, after).expect("valid TOML");
        assert_eq!(changes, vec![Change::new(None, vec![Label::FormatOnly {}])]);
    }

    #[test]
    fn json_non_object_root_and_invalid_fall_back() {
        assert!(config_changes(Lang::Json, "[1, 2]", "[1, 3]").is_none());
        assert!(config_changes(Lang::Json, "{invalid", "{}").is_none());
        assert!(config_changes(Lang::Toml, "a = [", "a = []").is_none());
    }

    #[test]
    fn long_keys_and_values_truncated_without_hiding_late_edits() {
        let long_key = "k".repeat(90);
        let prefix = "v".repeat(65);
        let before = format!(r#"{{"{long_key}":"{prefix}1"}}"#);
        let after = format!(r#"{{"{long_key}":"{prefix}2"}}"#);

        let changes = config_changes(Lang::Json, &before, &after).expect("valid JSON");
        assert_eq!(changes.len(), 1);
        let sym = changes[0].symbol.as_ref().expect("key symbol");
        assert_eq!(sym.name.chars().count(), MAX_KEY_CHARS);
        assert!(sym.name.ends_with('…'));

        match &changes[0].labels[0] {
            Label::ConfigChanged { key, before, after } => {
                assert_eq!(key.chars().count(), MAX_KEY_CHARS);
                assert!(key.ends_with('…'));
                let b = before.as_ref().expect("before value");
                let a = after.as_ref().expect("after value");
                assert_eq!(b.chars().count(), MAX_VALUE_CHARS);
                assert_eq!(a.chars().count(), MAX_VALUE_CHARS);
                assert!(b.ends_with('…'));
                assert!(a.ends_with('…'));
            }
            other => panic!("unexpected label: {other:?}"),
        }
    }

    #[test]
    fn package_json_all_dependency_sections() {
        let before = r#"{
            "dependencies": {"a": "^1.0.0"},
            "devDependencies": {"b": "^2.0.0"},
            "peerDependencies": {"c": "^3.0.0"},
            "optionalDependencies": {"d": "^4.0.0"}
        }"#;
        let after = r#"{
            "dependencies": {"a": "^1.1.0"},
            "devDependencies": {},
            "peerDependencies": {"c": "^3.0.0", "e": "^5.0.0"},
            "optionalDependencies": {"d": "^4.1.0"}
        }"#;
        let changes = config_changes(Lang::PackageJson, before, after).expect("valid package.json");
        let names: Vec<&str> = changes
            .iter()
            .map(|c| c.symbol.as_ref().unwrap().name.as_str())
            .collect();
        assert_eq!(
            names,
            vec![
                "dependencies",
                "devDependencies",
                "optionalDependencies",
                "peerDependencies"
            ]
        );
        assert!(changes.iter().all(|c| c.importance == Importance::High));
    }

    #[test]
    fn cargo_toml_workspace_target_and_path_deps() {
        let before = r#"
[workspace]
members = ["a"]

[workspace.dependencies]
serde = "1.0"
local = { path = "../a" }

[target.'cfg(target_os = "1.0")'.build-dependencies]
cc = "1.0"
"#;
        let after = r#"
[workspace]
members = ["a", "b"]

[workspace.dependencies]
serde = "1.1"
local = { path = "../b" }
added_ws = { workspace = true }

[target.'cfg(target_os = "1.0")'.build-dependencies]
cc = "1.1"
"#;
        let changes = config_changes(Lang::CargoToml, before, after).expect("valid Cargo.toml");
        assert_eq!(changes.len(), 2);

        let target_change = &changes[0];
        assert_eq!(target_change.symbol.as_ref().unwrap().name, "target");
        assert_eq!(
            target_change.labels,
            vec![Label::DepVersion {
                name: "cc".to_string(),
                before: "1.0".to_string(),
                after: "1.1".to_string(),
            }]
        );

        let ws_change = &changes[1];
        assert_eq!(ws_change.symbol.as_ref().unwrap().name, "workspace");
        assert_eq!(ws_change.importance, Importance::High);
        assert_eq!(
            ws_change.labels,
            vec![
                Label::DepAdded {
                    name: "added_ws".to_string(),
                    version: "{\"workspace\":true}".to_string(),
                },
                Label::DepVersion {
                    name: "serde".to_string(),
                    before: "1.0".to_string(),
                    after: "1.1".to_string(),
                },
                Label::ConfigChanged {
                    key: "workspace.dependencies.local".to_string(),
                    before: Some("{\"path\":\"../a\"}".to_string()),
                    after: Some("{\"path\":\"../b\"}".to_string()),
                },
                Label::ConfigChanged {
                    key: "workspace.members".to_string(),
                    before: Some("[\"a\"]".to_string()),
                    after: Some("[\"a\",\"b\"]".to_string()),
                },
            ]
        );
    }

    #[test]
    fn nested_array_objects_sort_keys_deterministically() {
        let before = r#"{"arr":[{"z":1,"a":{"d":4,"c":3}}]}"#;
        let after = r#"{"arr":[{"a":{"c":3,"d":4},"z":2}]}"#;
        let changes = config_changes(Lang::Json, before, after).expect("valid JSON");
        assert_eq!(
            changes[0].labels,
            vec![Label::ConfigChanged {
                key: "arr".to_string(),
                before: Some(r#"[{"a":{"c":3,"d":4},"z":1}]"#.to_string()),
                after: Some(r#"[{"a":{"c":3,"d":4},"z":2}]"#.to_string()),
            }]
        );
    }

    #[test]
    fn deeply_nested_inputs_do_not_overflow_stack() {
        let open = "[".repeat(5_000);
        let close = "]".repeat(5_000);
        let deep_json = format!(r#"{{"a":{open}1{close}}}"#);
        assert!(config_changes(Lang::Json, &deep_json, "{}").is_none());

        let deep_toml = format!("a = {open}1{close}");
        assert!(config_changes(Lang::Toml, &deep_toml, "").is_none());
    }
}
