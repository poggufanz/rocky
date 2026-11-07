//! Desk settings store tests: missing, broken, newer, and roundtrip files.

use std::fs;
use std::path::Path;

use rocky_proto::paths::{settings_path, tool_text_off_marker};
use rocky_proto::settings::{Lang, Settings};
use rockyd::settings::{apply_set, load, save, sync_marker};
use serde_json::json;
use tempfile::TempDir;

fn home() -> TempDir {
    tempfile::tempdir().unwrap()
}

fn write(path: &Path, bytes: &[u8]) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}

#[test]
fn missing_file_gives_defaults() {
    let tmp = home();
    let l = load(&settings_path(tmp.path()));
    assert_eq!(l.settings, Settings::default());
    assert!(!l.unreadable);
}

#[test]
fn missing_key_gives_default_for_that_key() {
    let tmp = home();
    let path = settings_path(tmp.path());
    write(&path, br#"{"v":1,"tool_text":false}"#);
    let l = load(&path);
    assert!(!l.settings.tool_text);
    assert!(l.settings.history);
    assert!(!l.unreadable);
}

#[test]
fn broken_file_is_unreadable_and_untouched() {
    let tmp = home();
    let path = settings_path(tmp.path());
    write(&path, b"{not json");
    let l = load(&path);
    assert_eq!(l.settings, Settings::default());
    assert!(l.unreadable);
    assert_eq!(fs::read(&path).unwrap(), b"{not json");
}

#[test]
fn newer_or_mistyped_file_is_unreadable_and_untouched() {
    let tmp = home();
    let path = settings_path(tmp.path());
    let cases: [&[u8]; 2] = [b"{\"v\":2}", br#"{"v":1,"history":"yes"}"#];
    for bytes in cases {
        write(&path, bytes);
        let l = load(&path);
        assert_eq!(l.settings, Settings::default());
        assert!(l.unreadable);
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }
}

#[test]
fn save_then_load_roundtrips() {
    let tmp = home();
    let path = settings_path(tmp.path());
    let next = apply_set(&Settings::default(), "history", &json!(false)).unwrap();
    save(&path, &next).unwrap();
    let l = load(&path);
    assert_eq!(l.settings, next);
    assert!(!l.unreadable);
    let names: Vec<String> = fs::read_dir(path.parent().unwrap())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, vec!["settings.json"]);
}

#[test]
fn set_validates_name_and_value() {
    let d = Settings::default();
    assert_eq!(apply_set(&d, "nope", &json!(true)), Err("unknown setting"));
    assert_eq!(apply_set(&d, "v", &json!(2)), Err("unknown setting"));
    assert_eq!(apply_set(&d, "history", &json!("no")), Err("invalid value"));
    assert_eq!(apply_set(&d, "lang", &json!("fr")), Err("invalid value"));
    assert_eq!(apply_set(&d, "lang", &json!("id")).unwrap().lang, Lang::Id);
}

#[test]
fn every_bool_setting_is_settable() {
    let d = Settings::default();
    for name in [
        "subagent_tree",
        "history",
        "tool_text",
        "notify_needs_you",
        "notify_failed",
        "notify_done",
        "autostart_asked",
    ] {
        let next = apply_set(&d, name, &json!(false)).unwrap();
        let wire = serde_json::to_value(&next).unwrap();
        assert_eq!(wire[name], json!(false), "{name}");
    }
}

#[test]
fn marker_follows_tool_text() {
    let tmp = home();
    let marker = tool_text_off_marker(tmp.path());
    sync_marker(tmp.path(), false).unwrap();
    assert!(marker.exists());
    sync_marker(tmp.path(), true).unwrap();
    assert!(!marker.exists());
    sync_marker(tmp.path(), true).unwrap();
}
