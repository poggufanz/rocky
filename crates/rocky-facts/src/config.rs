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
#[derive(Debug, Eq)]
enum ConfigValue {
    Null,
    Bool(bool),
    Number(String),
    String(String),
    /// TOML datetime, kept apart from strings so a type change is not read as format-only.
    Datetime(String),
    /// TOML `nan`/`inf`, which JSON cannot hold; kept apart from strings for the same reason.
    NonFinite(String),
    Array(Vec<ConfigValue>),
    Object(BTreeMap<String, ConfigValue>),
}

impl PartialEq for ConfigValue {
    fn eq(&self, other: &Self) -> bool {
        let mut stack = vec![(self, other)];
        while let Some((a, b)) = stack.pop() {
            match (a, b) {
                (Self::Null, Self::Null) => {}
                (Self::Bool(x), Self::Bool(y)) if x == y => {}
                (Self::Number(x), Self::Number(y)) if x == y => {}
                (Self::String(x), Self::String(y)) if x == y => {}
                (Self::Datetime(x), Self::Datetime(y)) if x == y => {}
                (Self::NonFinite(x), Self::NonFinite(y)) if x == y => {}
                (Self::Array(xs), Self::Array(ys)) if xs.len() == ys.len() => {
                    stack.extend(xs.iter().zip(ys.iter()));
                }
                (Self::Object(xm), Self::Object(ym)) if xm.len() == ym.len() => {
                    for ((xk, xv), (yk, yv)) in xm.iter().zip(ym.iter()) {
                        if xk != yk {
                            return false;
                        }
                        stack.push((xv, yv));
                    }
                }
                _ => return false,
            }
        }
        true
    }
}

impl Drop for ConfigValue {
    fn drop(&mut self) {
        let mut stack = Vec::new();
        match self {
            Self::Array(items) => stack.append(items),
            Self::Object(map) => {
                let owned = std::mem::take(map);
                stack.extend(owned.into_values());
            }
            _ => return,
        }
        while let Some(mut val) = stack.pop() {
            match &mut val {
                Self::Array(items) => stack.append(items),
                Self::Object(map) => {
                    let owned = std::mem::take(map);
                    stack.extend(owned.into_values());
                }
                _ => {}
            }
        }
    }
}

enum RenderTask<'a> {
    Value(&'a ConfigValue),
    Raw(&'static str),
    Key(&'a str),
}

impl ConfigValue {
    fn into_object(mut self) -> Option<BTreeMap<String, ConfigValue>> {
        if let Self::Object(map) = &mut self {
            Some(std::mem::take(map))
        } else {
            None
        }
    }

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
                    ConfigValue::Number(n)
                    | ConfigValue::Datetime(n)
                    | ConfigValue::NonFinite(n) => {
                        out.push_str(n);
                    }
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

enum PendingContainer {
    Array { start: usize },
    Object { keys: Vec<String>, start: usize },
}

fn finish_container(values: &mut Vec<ConfigValue>, pending: PendingContainer) {
    match pending {
        PendingContainer::Array { start } => {
            let items = values.split_off(start);
            values.push(ConfigValue::Array(items));
        }
        PendingContainer::Object { keys, start } => {
            let vals = values.split_off(start);
            let map: BTreeMap<String, ConfigValue> = keys.into_iter().zip(vals).collect();
            values.push(ConfigValue::Object(map));
        }
    }
}

fn from_json(value: serde_json::Value) -> ConfigValue {
    enum Step {
        Value(serde_json::Value),
        Finish(PendingContainer),
    }

    let mut values: Vec<ConfigValue> = Vec::new();
    let mut work = vec![Step::Value(value)];

    while let Some(step) = work.pop() {
        match step {
            Step::Finish(pending) => finish_container(&mut values, pending),
            Step::Value(val) => match val {
                serde_json::Value::Null => values.push(ConfigValue::Null),
                serde_json::Value::Bool(b) => values.push(ConfigValue::Bool(b)),
                serde_json::Value::Number(n) => values.push(ConfigValue::Number(n.to_string())),
                serde_json::Value::String(s) => values.push(ConfigValue::String(s)),
                serde_json::Value::Array(items) => {
                    let start = values.len();
                    work.push(Step::Finish(PendingContainer::Array { start }));
                    for item in items.into_iter().rev() {
                        work.push(Step::Value(item));
                    }
                }
                serde_json::Value::Object(map) => {
                    let start = values.len();
                    let mut keys = Vec::with_capacity(map.len());
                    let mut vals = Vec::with_capacity(map.len());
                    for (k, v) in map {
                        keys.push(k);
                        vals.push(v);
                    }
                    work.push(Step::Finish(PendingContainer::Object { keys, start }));
                    for v in vals.into_iter().rev() {
                        work.push(Step::Value(v));
                    }
                }
            },
        }
    }

    values.pop().unwrap_or(ConfigValue::Null)
}

/// TOML spelling of a non-finite float (`nan`, `inf`, `-inf`).
fn non_finite_text(f: f64) -> &'static str {
    if f.is_nan() {
        "nan"
    } else if f.is_sign_negative() {
        "-inf"
    } else {
        "inf"
    }
}

fn from_toml_value(value: toml::Value) -> ConfigValue {
    enum Step {
        Value(toml::Value),
        Finish(PendingContainer),
    }

    let mut values: Vec<ConfigValue> = Vec::new();
    let mut work = vec![Step::Value(value)];

    while let Some(step) = work.pop() {
        match step {
            Step::Finish(pending) => finish_container(&mut values, pending),
            Step::Value(val) => match val {
                toml::Value::String(s) => values.push(ConfigValue::String(s)),
                toml::Value::Integer(i) => values.push(ConfigValue::Number(i.to_string())),
                toml::Value::Float(f) => match serde_json::Number::from_f64(f) {
                    Some(n) => values.push(ConfigValue::Number(n.to_string())),
                    None => values.push(ConfigValue::NonFinite(non_finite_text(f).to_string())),
                },
                toml::Value::Boolean(b) => values.push(ConfigValue::Bool(b)),
                toml::Value::Datetime(dt) => values.push(ConfigValue::Datetime(dt.to_string())),
                toml::Value::Array(items) => {
                    let start = values.len();
                    work.push(Step::Finish(PendingContainer::Array { start }));
                    for item in items.into_iter().rev() {
                        work.push(Step::Value(item));
                    }
                }
                toml::Value::Table(table) => {
                    let start = values.len();
                    let mut keys = Vec::with_capacity(table.len());
                    let mut vals = Vec::with_capacity(table.len());
                    for (k, v) in table {
                        keys.push(k);
                        vals.push(v);
                    }
                    work.push(Step::Finish(PendingContainer::Object { keys, start }));
                    for v in vals.into_iter().rev() {
                        work.push(Step::Value(v));
                    }
                }
            },
        }
    }

    values.pop().unwrap_or(ConfigValue::Null)
}

fn from_toml_table(table: toml::Table) -> BTreeMap<String, ConfigValue> {
    from_toml_value(toml::Value::Table(table))
        .into_object()
        .unwrap_or_default()
}

fn parse_root(lang: Lang, text: &str) -> Option<BTreeMap<String, ConfigValue>> {
    match lang {
        Lang::Json | Lang::PackageJson => {
            let value: serde_json::Value = serde_json::from_str(text).ok()?;
            from_json(value).into_object()
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

fn get_object_mut_at<'a>(
    map: &'a mut BTreeMap<String, ConfigValue>,
    path: &[String],
) -> Option<&'a mut BTreeMap<String, ConfigValue>> {
    let (first, rest) = match path.split_first() {
        Some(parts) => parts,
        None => return Some(map),
    };
    let mut current = map.get_mut(first)?;
    for segment in rest {
        let ConfigValue::Object(child) = current else {
            return None;
        };
        current = child.get_mut(segment)?;
    }
    match current {
        ConfigValue::Object(obj) => Some(obj),
        _ => None,
    }
}

fn take_object_at(
    map: &mut BTreeMap<String, ConfigValue>,
    path: &[String],
) -> BTreeMap<String, ConfigValue> {
    let Some((last, prefix)) = path.split_last() else {
        return BTreeMap::new();
    };
    let Some(parent) = get_object_mut_at(map, prefix) else {
        return BTreeMap::new();
    };
    let taken = parent
        .remove(last)
        .and_then(ConfigValue::into_object)
        .unwrap_or_default();
    // Extracting a nested dependency section (e.g. target.<cfg>.dependencies) can leave empty
    // implicit parent tables that should not be reported as separate empty-object config leaves.
    for depth in (1..path.len()).rev() {
        let ancestor_empty = matches!(
            get_at(map, &path[..depth]),
            Some(ConfigValue::Object(obj)) if obj.is_empty()
        );
        if ancestor_empty {
            if let Some(ancestor_parent) = get_object_mut_at(map, &path[..depth - 1]) {
                ancestor_parent.remove(&path[depth - 1]);
            }
        } else {
            break;
        }
    }
    taken
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

fn render_diff_pair(before: &ConfigValue, after: &ConfigValue) -> (String, String) {
    let b_disp = before.render_leaf();
    let a_disp = after.render_leaf();
    if b_disp == a_disp {
        (before.render_compact(), after.render_compact())
    } else {
        (b_disp, a_disp)
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
                    _ => {
                        let (b_str, a_str) = render_diff_pair(before_val, after_val);
                        Label::ConfigChanged {
                            key: cut(&format!("{section_name}.{name}"), MAX_KEY_CHARS),
                            before: Some(cut(&b_str, MAX_VALUE_CHARS)),
                            after: Some(cut(&a_str, MAX_VALUE_CHARS)),
                        }
                    }
                }
            }
            (None, None) => unreachable!(),
        };
        groups.entry(top_key.clone()).or_default().push(label);
    }
}

fn flatten_leaves(root: &BTreeMap<String, ConfigValue>) -> BTreeMap<Vec<String>, &ConfigValue> {
    let mut leaves = BTreeMap::new();
    let mut stack: Vec<(Vec<String>, &ConfigValue)> = Vec::new();
    for (k, v) in root.iter().rev() {
        stack.push((vec![k.clone()], v));
    }

    while let Some((path, val)) = stack.pop() {
        match val {
            ConfigValue::Object(map) if !map.is_empty() => {
                for (k, v) in map.iter().rev() {
                    let mut child_path = path.clone();
                    child_path.push(k.clone());
                    stack.push((child_path, v));
                }
            }
            _ => {
                leaves.insert(path, val);
            }
        }
    }
    leaves
}

fn diff_leaves(
    before_leaves: &BTreeMap<Vec<String>, &ConfigValue>,
    after_leaves: &BTreeMap<Vec<String>, &ConfigValue>,
    groups: &mut BTreeMap<String, Vec<Label>>,
) {
    let paths: BTreeSet<&Vec<String>> = before_leaves.keys().chain(after_leaves.keys()).collect();
    for path in paths {
        let before_val = before_leaves.get(path).copied();
        let after_val = after_leaves.get(path).copied();
        if before_val == after_val {
            continue;
        }
        let (before_str, after_str) = match (before_val, after_val) {
            (Some(b), Some(a)) => {
                let (b_str, a_str) = render_diff_pair(b, a);
                (Some(b_str), Some(a_str))
            }
            (Some(b), None) => (Some(b.render_leaf()), None),
            (None, Some(a)) => (None, Some(a.render_leaf())),
            (None, None) => unreachable!(),
        };
        let top_key = &path[0];
        let full_key = path.join(".");
        let label = Label::ConfigChanged {
            key: cut(&full_key, MAX_KEY_CHARS),
            before: before_str.map(|v| cut(&v, MAX_VALUE_CHARS)),
            after: after_str.map(|v| cut(&v, MAX_VALUE_CHARS)),
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
                name: top_key,
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
    fn toml_datetime_to_string_is_a_change() {
        let changes = config_changes(
            Lang::Toml,
            "stamp = 2024-01-01T00:00:00Z
",
            "stamp = \"2024-01-01T00:00:00Z\"
",
        )
        .expect("valid TOML");
        assert_eq!(changes.len(), 1);
        assert_eq!(
            changes[0].labels,
            vec![Label::ConfigChanged {
                key: "stamp".to_string(),
                before: Some("2024-01-01T00:00:00Z".to_string()),
                after: Some("\"2024-01-01T00:00:00Z\"".to_string()),
            }]
        );
    }

    #[test]
    fn toml_non_finite_float_to_string_is_a_change() {
        let changes = config_changes(
            Lang::Toml,
            "x = nan
",
            "x = \"nan\"
",
        )
        .expect("valid TOML");
        assert_eq!(changes.len(), 1);
        assert_eq!(
            changes[0].labels,
            vec![Label::ConfigChanged {
                key: "x".to_string(),
                before: Some("nan".to_string()),
                after: Some("\"nan\"".to_string()),
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
        assert_eq!(sym.name, long_key);
        assert_eq!(sym.nth, 0);

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

    #[test]
    fn json_empty_containers_and_scalar_type_changes() {
        let base = r#"{"a":{"b":1,"c":true},"d":"x"}"#;
        let with_empty = r#"{"a":{"b":1,"c":true},"d":"x","empty":{},"empty_arr":[]}"#;

        let added = config_changes(Lang::Json, base, with_empty).expect("valid JSON");
        assert_eq!(added.len(), 2);
        assert_eq!(added[0].symbol.as_ref().unwrap().name, "empty");
        assert_eq!(
            added[0].labels,
            vec![Label::ConfigChanged {
                key: "empty".to_string(),
                before: None,
                after: Some("{}".to_string()),
            }]
        );
        assert_eq!(added[1].symbol.as_ref().unwrap().name, "empty_arr");
        assert_eq!(
            added[1].labels,
            vec![Label::ConfigChanged {
                key: "empty_arr".to_string(),
                before: None,
                after: Some("[]".to_string()),
            }]
        );

        let removed = config_changes(Lang::Json, with_empty, base).expect("valid JSON");
        assert_eq!(removed.len(), 2);
        assert_eq!(
            removed[0].labels,
            vec![Label::ConfigChanged {
                key: "empty".to_string(),
                before: Some("{}".to_string()),
                after: None,
            }]
        );
        assert_eq!(
            removed[1].labels,
            vec![Label::ConfigChanged {
                key: "empty_arr".to_string(),
                before: Some("[]".to_string()),
                after: None,
            }]
        );

        let typed_before = r#"{"a":{"b":1,"c":true},"n":null,"e":{}}"#;
        let typed_after = r#"{"a":{"b":"1","c":"true"},"n":"null","e":"{}"}"#;
        let typed = config_changes(Lang::Json, typed_before, typed_after).expect("valid JSON");
        assert_eq!(typed.len(), 3);
        assert_eq!(
            typed[0].labels,
            vec![
                Label::ConfigChanged {
                    key: "a.b".to_string(),
                    before: Some("1".to_string()),
                    after: Some("\"1\"".to_string()),
                },
                Label::ConfigChanged {
                    key: "a.c".to_string(),
                    before: Some("true".to_string()),
                    after: Some("\"true\"".to_string()),
                },
            ]
        );
        assert_eq!(
            typed[1].labels,
            vec![Label::ConfigChanged {
                key: "e".to_string(),
                before: Some("{}".to_string()),
                after: Some("\"{}\"".to_string()),
            }]
        );
        assert_eq!(
            typed[2].labels,
            vec![Label::ConfigChanged {
                key: "n".to_string(),
                before: Some("null".to_string()),
                after: Some("\"null\"".to_string()),
            }]
        );
    }

    #[test]
    fn toml_empty_tables_and_scalar_type_changes() {
        let base = "count = 1\nflag = true\n";
        let with_empty = "count = 1\nflag = true\n\n[empty]\n";

        let added = config_changes(Lang::Toml, base, with_empty).expect("valid TOML");
        assert_eq!(added.len(), 1);
        assert_eq!(added[0].symbol.as_ref().unwrap().name, "empty");
        assert_eq!(
            added[0].labels,
            vec![Label::ConfigChanged {
                key: "empty".to_string(),
                before: None,
                after: Some("{}".to_string()),
            }]
        );

        let removed = config_changes(Lang::Toml, with_empty, base).expect("valid TOML");
        assert_eq!(removed.len(), 1);
        assert_eq!(
            removed[0].labels,
            vec![Label::ConfigChanged {
                key: "empty".to_string(),
                before: Some("{}".to_string()),
                after: None,
            }]
        );

        let typed_after = "count = \"1\"\nflag = \"true\"\n";
        let typed = config_changes(Lang::Toml, base, typed_after).expect("valid TOML");
        assert_eq!(typed.len(), 2);
        assert_eq!(
            typed[0].labels,
            vec![Label::ConfigChanged {
                key: "count".to_string(),
                before: Some("1".to_string()),
                after: Some("\"1\"".to_string()),
            }]
        );
        assert_eq!(
            typed[1].labels,
            vec![Label::ConfigChanged {
                key: "flag".to_string(),
                before: Some("true".to_string()),
                after: Some("\"true\"".to_string()),
            }]
        );
    }

    #[test]
    fn long_top_level_keys_with_shared_prefix_stay_distinct() {
        let prefix = "A".repeat(80);
        let key_x = format!("{prefix}X");
        let key_y = format!("{prefix}Y");
        let after = format!(r#"{{"{key_x}":1,"{key_y}":2}}"#);

        let changes = config_changes(Lang::Json, "{}", &after).expect("valid JSON");
        assert_eq!(changes.len(), 2);

        let sym_x = changes[0].symbol.as_ref().expect("key x symbol");
        let sym_y = changes[1].symbol.as_ref().expect("key y symbol");
        assert_eq!(sym_x.name, key_x);
        assert_eq!(sym_y.name, key_y);
        assert_eq!(sym_x.nth, 0);
        assert_eq!(sym_y.nth, 0);
        assert_ne!(sym_x, sym_y);

        for change in &changes {
            match &change.labels[0] {
                Label::ConfigChanged { key, .. } => {
                    assert_eq!(key.chars().count(), MAX_KEY_CHARS);
                    assert!(key.ends_with('…'));
                }
                other => panic!("unexpected label: {other:?}"),
            }
        }
    }

    #[test]
    fn accepted_deep_nesting_reaches_conversion() {
        let depth = 100;
        let json_before = format!(
            "{{\"k\":{}1{}}}",
            "{\"k\":".repeat(depth),
            "}".repeat(depth)
        );
        let json_after = format!(
            "{{\"k\":{}2{}}}",
            "{\"k\":".repeat(depth),
            "}".repeat(depth)
        );
        let json_changes =
            config_changes(Lang::Json, &json_before, &json_after).expect("accepted deep JSON");
        assert_eq!(json_changes.len(), 1);
        assert_eq!(json_changes[0].symbol.as_ref().unwrap().name, "k");

        let toml_depth = 50;
        let toml_before = format!("a = {}1{}", "[".repeat(toml_depth), "]".repeat(toml_depth));
        let toml_after = format!("a = {}2{}", "[".repeat(toml_depth), "]".repeat(toml_depth));
        let toml_changes =
            config_changes(Lang::Toml, &toml_before, &toml_after).expect("accepted deep TOML");
        assert_eq!(toml_changes.len(), 1);
        assert_eq!(toml_changes[0].symbol.as_ref().unwrap().name, "a");
    }

    #[test]
    fn iterative_config_conversion_and_drop_handle_extreme_depth() {
        let handle = std::thread::Builder::new()
            .stack_size(1 << 20)
            .spawn(|| {
                let mut json_a = serde_json::Value::Number(serde_json::Number::from(1));
                let mut json_b = serde_json::Value::Number(serde_json::Number::from(2));
                for _ in 0..10_000 {
                    let mut map_a = serde_json::Map::new();
                    map_a.insert("n".to_string(), json_a);
                    json_a = serde_json::Value::Object(map_a);

                    let mut map_b = serde_json::Map::new();
                    map_b.insert("n".to_string(), json_b);
                    json_b = serde_json::Value::Object(map_b);
                }
                let cfg_a = from_json(json_a);
                let cfg_b = from_json(json_b);
                assert_ne!(cfg_a, cfg_b);
                assert_eq!(cfg_a, cfg_a);

                let mut toml_a = toml::Value::Integer(1);
                for _ in 0..10_000 {
                    let mut tbl = toml::Table::new();
                    tbl.insert("t".to_string(), toml_a);
                    toml_a = toml::Value::Table(tbl);
                }
                let cfg_toml = from_toml_value(toml_a);
                let rendered = cfg_toml.render_compact();
                assert!(rendered.starts_with("{\"t\":"));
            })
            .expect("spawn 1 MiB stack thread");

        handle
            .join()
            .expect("iterative conversion and drop should not overflow stack");
    }
}
