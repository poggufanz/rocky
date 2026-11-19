//! Integration tests for `rockyd::translate::Translator` against the fake Node CLI.
//! Each test uses a temporary Rocky home and requires `node` on `PATH`.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};

use rocky_proto::paths::cli_record_path;
use rocky_proto::pipe::ServerMsg;
use rocky_proto::translate::{
    QuoteLang, QuoteTranslation, TranslateFailure, TranslatePair, TranslateStatus, quote_key,
};
use rockyd::guard::records::CliRecord;
use rockyd::translate::{Translator, marker};
use serde_json::{Value, json};
use tempfile::TempDir;

/// Longest any wait may take. A test that goes past it fails instead of hanging.
const GUARD: Duration = Duration::from_secs(20);

fn node_on_path() -> PathBuf {
    let names: &[&str] = if cfg!(windows) {
        &["node.exe", "node"]
    } else {
        &["node"]
    };
    let path = std::env::var_os("PATH").unwrap_or_default();
    std::env::split_paths(&path)
        .flat_map(|dir| names.iter().map(move |name| dir.join(name)))
        .find(|candidate| candidate.is_file())
        .unwrap_or_else(|| {
            panic!(
                "node is not on PATH; these tests run the fake CLI with Node.js and need it installed"
            )
        })
}

fn fake_cli() -> CliRecord {
    CliRecord {
        node: node_on_path(),
        entry: Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("fake-cli.cjs"),
        version: "0.0.0".to_string(),
    }
}

fn write_cli_record(home: &Path, cli: &CliRecord) {
    let path = cli_record_path(home);
    fs::create_dir_all(path.parent().expect("cli record parent")).expect("create bin dir");
    let body = json!({
        "v": 1,
        "node": cli.node.to_string_lossy(),
        "entry": cli.entry.to_string_lossy(),
        "version": cli.version,
    });
    fs::write(&path, body.to_string()).expect("write cli.json");
}

fn seed_cli(home: &Path) {
    write_cli_record(home, &fake_cli());
}

fn configure(home: &Path, config: &Value) {
    fs::write(home.join("fake-translate.json"), config.to_string())
        .expect("write fake translate config");
}

fn clear_config(home: &Path) {
    let _ = fs::remove_file(home.join("fake-translate.json"));
}

fn read_logged_argv(home: &Path) -> Vec<Vec<String>> {
    let Ok(text) = fs::read_to_string(home.join("fake-cli.log")) else {
        return Vec::new();
    };
    text.lines()
        .map(|line| {
            let entry: Value = serde_json::from_str(line).expect("argv log JSON");
            entry["argv"]
                .as_array()
                .expect("argv array")
                .iter()
                .map(|arg| arg.as_str().expect("argv str").to_string())
                .collect()
        })
        .collect()
}

fn wait_until(what: &str, mut condition: impl FnMut() -> bool) {
    let start = Instant::now();
    while !condition() {
        assert!(start.elapsed() < GUARD, "{what} never happened");
        thread::sleep(Duration::from_millis(15));
    }
}

fn wait_for_pid(home: &Path) -> u32 {
    let path = home.join("fake-translate.pid");
    let mut pid = None;
    wait_until("fake-translate.pid to be written", || {
        let Ok(raw) = fs::read_to_string(&path) else {
            return false;
        };
        if let Ok(parsed) = raw.trim().parse::<u32>() {
            pid = Some(parsed);
            true
        } else {
            false
        }
    });
    pid.expect("pid")
}

#[cfg(windows)]
fn is_pid_alive(pid: u32) -> bool {
    let filter = format!("PID eq {pid}");
    let Ok(output) = Command::new("tasklist")
        .args(["/FI", &filter, "/NH", "/FO", "CSV"])
        .output()
    else {
        return false;
    };
    let pid_str = pid.to_string();
    String::from_utf8_lossy(&output.stdout).lines().any(|line| {
        line.split(',')
            .nth(1)
            .is_some_and(|col| col.trim().trim_matches('"') == pid_str)
    })
}

#[cfg(unix)]
fn is_pid_alive(pid: u32) -> bool {
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .status()
        .is_ok_and(|status| status.success())
}

fn service_until(
    translator: &mut Translator,
    enabled: bool,
    what: &str,
    mut done: impl FnMut(&[ServerMsg]) -> bool,
) -> Vec<ServerMsg> {
    let start = Instant::now();
    let mut all = Vec::new();
    loop {
        all.extend(translator.service(enabled));
        if done(&all) {
            return all;
        }
        assert!(start.elapsed() < GUARD, "timed out waiting for {what}");
        thread::sleep(Duration::from_millis(15));
    }
}

fn run_install(translator: &mut Translator, pair: TranslatePair) -> Vec<TranslateStatus> {
    translator.install(true, pair).expect("start install");
    let msgs = service_until(translator, true, "install finish", |msgs| {
        msgs.iter().any(|msg| {
            matches!(
                msg,
                ServerMsg::Translate { status } if status.installing.is_none()
            )
        })
    });
    msgs.into_iter()
        .filter_map(|msg| match msg {
            ServerMsg::Translate { status } => Some(status),
            _ => None,
        })
        .collect()
}

fn quote_translated_items(msgs: &[ServerMsg]) -> Vec<(&str, &QuoteTranslation)> {
    msgs.iter()
        .filter_map(|msg| match msg {
            ServerMsg::QuoteTranslated { card_id, item } => Some((card_id.as_str(), item)),
            _ => None,
        })
        .collect()
}

#[test]
fn off_spawns_nothing_and_attaches_nothing() {
    let home = TempDir::new().expect("temp home");
    seed_cli(home.path());
    let mut translator = Translator::new(home.path().to_path_buf());
    run_install(&mut translator, TranslatePair::IdEn);
    let logged_before = read_logged_argv(home.path()).len();

    let attached = translator.on_detail(false, "c1", QuoteLang::En, &["Merah.".to_string()]);
    assert!(attached.is_empty());

    for _ in 0..20 {
        let msgs = translator.service(false);
        assert!(msgs.is_empty());
    }

    let logged_after = read_logged_argv(home.path());
    assert_eq!(logged_after.len(), logged_before);
    assert!(
        !logged_after
            .iter()
            .skip(logged_before)
            .any(|argv| argv.iter().any(|a| a == "translate"))
    );
}

#[test]
fn miss_then_push_then_hit() {
    let home = TempDir::new().expect("temp home");
    seed_cli(home.path());
    let mut translator = Translator::new(home.path().to_path_buf());
    run_install(&mut translator, TranslatePair::IdEn);

    let quotes = vec!["Merah.".to_string()];
    assert!(
        translator
            .on_detail(true, "c1", QuoteLang::En, &quotes)
            .is_empty()
    );

    let msgs = service_until(&mut translator, true, "QuoteTranslated", |msgs| {
        !quote_translated_items(msgs).is_empty()
    });
    let pushed = quote_translated_items(&msgs);
    assert_eq!(pushed.len(), 1);
    assert_eq!(pushed[0].0, "c1");
    assert_eq!(
        pushed[0].1,
        &QuoteTranslation {
            quote_key: quote_key("Merah."),
            from: QuoteLang::Id,
            text: "T:Merah.".to_string(),
        }
    );
    wait_until("run log line", || {
        let _ = translator.service(true);
        let logs = translator.drain_log();
        if logs.is_empty() {
            false
        } else {
            assert_eq!(
                logs,
                vec!["translate run: 1 ok, 0 original, 0 failed, 0 dropped"]
            );
            true
        }
    });

    let hit = translator.on_detail(true, "c1", QuoteLang::En, &quotes);
    assert_eq!(hit, vec![pushed[0].1.clone()]);
}

#[test]
fn same_language_is_cached_as_original() {
    let home = TempDir::new().expect("temp home");
    seed_cli(home.path());
    configure(home.path(), &json!({ "same": true }));
    let mut translator = Translator::new(home.path().to_path_buf());
    run_install(&mut translator, TranslatePair::IdEn);
    let runs_before = read_logged_argv(home.path()).len();

    let quotes = vec!["Already English.".to_string()];
    assert!(
        translator
            .on_detail(true, "c1", QuoteLang::En, &quotes)
            .is_empty()
    );

    wait_until("first run log line", || {
        let _ = translator.service(true);
        let logs = translator.drain_log();
        if logs.is_empty() {
            false
        } else {
            assert_eq!(
                logs,
                vec!["translate run: 0 ok, 1 original, 0 failed, 0 dropped"]
            );
            true
        }
    });
    assert_eq!(read_logged_argv(home.path()).len(), runs_before + 1);

    // Second detail open finds Cached::Original: returns nothing and starts no second run.
    assert!(
        translator
            .on_detail(true, "c1", QuoteLang::En, &quotes)
            .is_empty()
    );
    for _ in 0..10 {
        assert!(translator.service(true).is_empty());
    }
    assert_eq!(read_logged_argv(home.path()).len(), runs_before + 1);
    assert!(translator.drain_log().is_empty());
}

#[test]
fn two_cards_waiting_on_one_quote_both_get_it() {
    let home = TempDir::new().expect("temp home");
    seed_cli(home.path());
    let mut translator = Translator::new(home.path().to_path_buf());
    run_install(&mut translator, TranslatePair::IdEn);

    let quotes = vec!["Satu pesan.".to_string()];
    assert!(
        translator
            .on_detail(true, "c1", QuoteLang::En, &quotes)
            .is_empty()
    );
    assert!(
        translator
            .on_detail(true, "c2", QuoteLang::En, &quotes)
            .is_empty()
    );

    let msgs = service_until(&mut translator, true, "both cards notified", |msgs| {
        quote_translated_items(msgs).len() >= 2
    });
    let items = quote_translated_items(&msgs);
    let expected = QuoteTranslation {
        quote_key: quote_key("Satu pesan."),
        from: QuoteLang::Id,
        text: "T:Satu pesan.".to_string(),
    };
    assert_eq!(items.len(), 2);
    assert!(items.contains(&("c1", &expected)));
    assert!(items.contains(&("c2", &expected)));
    wait_until("run log line", || {
        let _ = translator.service(true);
        let logs = translator.drain_log();
        if logs.is_empty() {
            false
        } else {
            assert_eq!(
                logs,
                vec!["translate run: 1 ok, 0 original, 0 failed, 0 dropped"]
            );
            true
        }
    });
}

#[test]
fn turning_off_mid_run_kills_it() {
    let home = TempDir::new().expect("temp home");
    seed_cli(home.path());
    let mut translator = Translator::new(home.path().to_path_buf());
    run_install(&mut translator, TranslatePair::IdEn);

    let _ = fs::remove_file(home.path().join("fake-translate.pid"));
    configure(home.path(), &json!({ "hang": true }));
    assert!(
        translator
            .on_detail(true, "c1", QuoteLang::En, &["Merah.".to_string()])
            .is_empty()
    );

    let first_msgs = translator.service(true);
    assert!(quote_translated_items(&first_msgs).is_empty());
    let pid = wait_for_pid(home.path());
    assert!(is_pid_alive(pid), "run child {pid} should be running");

    let off_msgs = translator.service(false);
    assert!(quote_translated_items(&off_msgs).is_empty());
    assert!(!is_pid_alive(pid), "killed run child {pid} should be gone");

    for _ in 0..10 {
        let msgs = translator.service(false);
        assert!(quote_translated_items(&msgs).is_empty());
    }
    for _ in 0..10 {
        let msgs = translator.service(true);
        assert!(quote_translated_items(&msgs).is_empty());
    }
    assert!(translator.drain_log().is_empty());
}

#[test]
fn crash_mid_run_requeues_on_next_detail() {
    let home = TempDir::new().expect("temp home");
    seed_cli(home.path());
    let mut translator = Translator::new(home.path().to_path_buf());
    run_install(&mut translator, TranslatePair::IdEn);

    configure(home.path(), &json!({ "crash_after": 1 }));
    let quotes = vec!["Pertama.".to_string(), "Kedua.".to_string()];
    assert!(
        translator
            .on_detail(true, "c1", QuoteLang::En, &quotes)
            .is_empty()
    );

    let start = Instant::now();
    let mut first_msgs = Vec::new();
    let mut logs = Vec::new();
    loop {
        first_msgs.extend(translator.service(true));
        logs.extend(translator.drain_log());
        if !logs.is_empty() && !quote_translated_items(&first_msgs).is_empty() {
            break;
        }
        assert!(
            start.elapsed() < GUARD,
            "timed out waiting for first run finishes"
        );
        thread::sleep(Duration::from_millis(15));
    }
    let first_items = quote_translated_items(&first_msgs);
    assert_eq!(first_items.len(), 1);
    assert_eq!(first_items[0].1.text, "T:Pertama.");
    assert_eq!(
        logs,
        vec!["translate run: 1 ok, 0 original, 0 failed, 1 dropped"]
    );

    clear_config(home.path());
    let hits = translator.on_detail(true, "c1", QuoteLang::En, &quotes);
    assert_eq!(
        hits,
        vec![QuoteTranslation {
            quote_key: quote_key("Pertama."),
            from: QuoteLang::Id,
            text: "T:Pertama.".to_string(),
        }]
    );

    let second_msgs = service_until(&mut translator, true, "second quote pushed", |msgs| {
        !quote_translated_items(msgs).is_empty()
    });
    let second_items = quote_translated_items(&second_msgs);
    assert_eq!(second_items.len(), 1);
    assert_eq!(second_items[0].0, "c1");
    assert_eq!(second_items[0].1.text, "T:Kedua.");
    wait_until("second run log line", || {
        let _ = translator.service(true);
        let logs = translator.drain_log();
        if logs.is_empty() {
            false
        } else {
            assert_eq!(
                logs,
                vec!["translate run: 1 ok, 0 original, 0 failed, 0 dropped"]
            );
            true
        }
    });
}

#[test]
fn not_ready_pair_attaches_and_queues_nothing() {
    let home = TempDir::new().expect("temp home");
    seed_cli(home.path());
    let mut translator = Translator::new(home.path().to_path_buf());
    run_install(&mut translator, TranslatePair::IdEn);
    let logged_before = read_logged_argv(home.path()).len();

    // EnId (target QuoteLang::Id) is not installed.
    let attached = translator.on_detail(true, "c1", QuoteLang::Id, &["Hello.".to_string()]);
    assert!(attached.is_empty());

    for _ in 0..20 {
        assert!(translator.service(true).is_empty());
    }
    assert_eq!(read_logged_argv(home.path()).len(), logged_before);
}

#[test]
fn install_flow_updates_status() {
    let home = TempDir::new().expect("temp home");
    seed_cli(home.path());
    let mut translator = Translator::new(home.path().to_path_buf());
    assert_eq!(translator.status().ready, Vec::<TranslatePair>::new());
    assert_eq!(translator.status().failed, None);

    let statuses = run_install(&mut translator, TranslatePair::IdEn);
    assert!(
        statuses.iter().any(|s| s.installing.is_some()),
        "expected installing status, got {statuses:?}"
    );
    let last = statuses.last().expect("final status");
    assert_eq!(last.installing, None);
    assert_eq!(last.failed, None);
    assert!(last.ready.contains(&TranslatePair::IdEn));
    assert_eq!(translator.status(), last);

    // Checksum failure variant
    configure(home.path(), &json!({ "install": "checksum" }));
    let fail_statuses = run_install(&mut translator, TranslatePair::EnId);
    let fail_last = fail_statuses.last().expect("final checksum status");
    assert_eq!(fail_last.installing, None);
    assert_eq!(fail_last.failed, Some(TranslateFailure::Checksum));
    // Install failure persists across check().
    assert_eq!(translator.check(), None);
    assert_eq!(translator.status().failed, Some(TranslateFailure::Checksum));
}

#[test]
fn missing_cli_is_engine_failure() {
    let home = TempDir::new().expect("temp home");
    let mut translator = Translator::new(home.path().to_path_buf());
    assert_eq!(translator.status().failed, Some(TranslateFailure::Engine));
    assert_eq!(translator.install(true, TranslatePair::IdEn), Err("engine"));
    assert_eq!(translator.status().failed, Some(TranslateFailure::Engine));

    // Also when cli.json exists but its node path does not exist on disk.
    write_cli_record(
        home.path(),
        &CliRecord {
            node: home.path().join("missing-node"),
            entry: fake_cli().entry,
            version: "0.0.0".to_string(),
        },
    );
    assert_eq!(translator.check(), None);
    assert_eq!(translator.status().failed, Some(TranslateFailure::Engine));
    assert_eq!(translator.install(true, TranslatePair::IdEn), Err("engine"));

    // Restoring valid cli.json clears Engine on check().
    seed_cli(home.path());
    let updated = translator.check().expect("status should clear Engine");
    assert_eq!(updated.failed, None);
}

#[test]
fn remove_clears_files_cache_and_status() {
    let home = TempDir::new().expect("temp home");
    seed_cli(home.path());
    let mut translator = Translator::new(home.path().to_path_buf());
    run_install(&mut translator, TranslatePair::IdEn);

    // Populate cache.
    assert!(
        translator
            .on_detail(true, "c1", QuoteLang::En, &["Merah.".to_string()])
            .is_empty()
    );
    service_until(&mut translator, true, "cache populated", |msgs| {
        !quote_translated_items(msgs).is_empty()
    });
    wait_until("first run finishes", || {
        let _ = translator.service(true);
        !translator.drain_log().is_empty()
    });
    assert!(marker::translate_dir(home.path()).exists());

    // Busy remove returns Err("busy").
    let _ = fs::remove_file(home.path().join("fake-translate.pid"));
    configure(home.path(), &json!({ "hang": true }));
    assert!(
        translator
            .on_detail(true, "c2", QuoteLang::En, &["Biru.".to_string()])
            .is_empty()
    );
    let _ = translator.service(true);
    let _pid = wait_for_pid(home.path());
    assert_eq!(translator.remove(), Err("busy"));

    // Stop the hanging run, then remove succeeds.
    let _ = translator.service(false);
    clear_config(home.path());
    assert_eq!(translator.remove(), Ok(()));
    assert!(!marker::translate_dir(home.path()).exists());
    assert_eq!(translator.status().ready, Vec::<TranslatePair>::new());
    assert_eq!(translator.check(), None);

    // Re-installing does not revive the old cached translation.
    run_install(&mut translator, TranslatePair::IdEn);
    assert!(
        translator
            .on_detail(true, "c1", QuoteLang::En, &["Merah.".to_string()])
            .is_empty()
    );
}

#[test]
fn install_checks_disabled_and_busy_and_turning_off_kills_install() {
    let home = TempDir::new().expect("temp home");
    seed_cli(home.path());
    let mut translator = Translator::new(home.path().to_path_buf());

    assert_eq!(
        translator.install(false, TranslatePair::IdEn),
        Err("disabled")
    );

    configure(home.path(), &json!({ "install": "hang" }));
    assert_eq!(translator.install(true, TranslatePair::IdEn), Ok(()));
    assert_eq!(translator.install(true, TranslatePair::EnId), Err("busy"));
    let start_msgs = translator.service(true);
    assert!(start_msgs.iter().any(|m| matches!(
        m,
        ServerMsg::Translate { status } if status.installing.is_some()
    )));
    let pid = wait_for_pid(home.path());
    assert!(is_pid_alive(pid));

    let msgs = translator.service(false);
    assert!(!is_pid_alive(pid), "install child {pid} should be gone");
    assert_eq!(translator.status().installing, None);
    assert!(msgs.iter().any(|m| matches!(
        m,
        ServerMsg::Translate { status } if status.installing.is_none()
    )));
}

#[test]
fn push_later_emits_on_true_and_clears_on_false() {
    let home = TempDir::new().expect("temp home");
    let mut translator = Translator::new(home.path().to_path_buf());
    let item = QuoteTranslation {
        quote_key: quote_key("Satu."),
        from: QuoteLang::Id,
        text: "One.".to_string(),
    };
    translator.push_later("c1", vec![item.clone()]);
    let msgs = translator.service(true);
    assert_eq!(
        msgs,
        vec![ServerMsg::QuoteTranslated {
            card_id: "c1".to_string(),
            item: item.clone(),
        }]
    );

    translator.push_later("c2", vec![item]);
    let off_msgs = translator.service(false);
    assert!(off_msgs.is_empty());
    assert!(translator.service(true).is_empty());
}

#[test]
fn failed_reply_is_dropped_and_not_cached() {
    let home = TempDir::new().expect("temp home");
    seed_cli(home.path());
    let mut translator = Translator::new(home.path().to_path_buf());
    run_install(&mut translator, TranslatePair::IdEn);

    configure(home.path(), &json!({ "fail": true }));
    let quotes = vec!["Gagal.".to_string()];
    assert!(
        translator
            .on_detail(true, "c1", QuoteLang::En, &quotes)
            .is_empty()
    );

    wait_until("failed run log line", || {
        let msgs = translator.service(true);
        assert!(quote_translated_items(&msgs).is_empty());
        let logs = translator.drain_log();
        if logs.is_empty() {
            false
        } else {
            assert_eq!(
                logs,
                vec!["translate run: 0 ok, 0 original, 1 failed, 0 dropped"]
            );
            true
        }
    });

    // Not cached: clearing fail allows the next detail open to queue and translate it.
    clear_config(home.path());
    assert!(
        translator
            .on_detail(true, "c1", QuoteLang::En, &quotes)
            .is_empty()
    );
    let msgs = service_until(&mut translator, true, "recovered translation", |msgs| {
        !quote_translated_items(msgs).is_empty()
    });
    let items = quote_translated_items(&msgs);
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].1.text, "T:Gagal.");
}
