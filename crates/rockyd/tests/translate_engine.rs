//! Integration tests for `rockyd::translate::Translator` against the fake Node CLI.
//! Each test uses a temporary Rocky home and requires `node` on `PATH`.

use std::fs;
use std::ops::{Deref, DerefMut};
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
use rockyd::translate::cache::{Cached, QuoteCache, cache_key};
use rockyd::translate::{Translator, marker};
use serde_json::{Value, json};
use tempfile::TempDir;

/// Longest any wait may take. A test that goes past it fails instead of hanging.
const GUARD: Duration = Duration::from_secs(20);

/// Wraps `Translator` so `service(false)` and `Drop` run behind [`GUARD`] on a helper thread.
struct GuardedTranslator(Option<Translator>);

impl GuardedTranslator {
    fn new(home: PathBuf) -> Self {
        Self(Some(Translator::new(home)))
    }

    fn service_off(&mut self) -> Vec<ServerMsg> {
        let mut translator = self.0.take().expect("translator already taken");
        let (tx, rx) = std::sync::mpsc::channel();
        thread::spawn(move || {
            let msgs = translator.service(false);
            let _ = tx.send((translator, msgs));
        });
        match rx.recv_timeout(GUARD) {
            Ok((translator, msgs)) => {
                self.0 = Some(translator);
                msgs
            }
            Err(_) => panic!("timed out waiting for service(false) within {GUARD:?}"),
        }
    }
}

impl Deref for GuardedTranslator {
    type Target = Translator;

    fn deref(&self) -> &Self::Target {
        self.0.as_ref().expect("translator already taken")
    }
}

impl DerefMut for GuardedTranslator {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.0.as_mut().expect("translator already taken")
    }
}

impl Drop for GuardedTranslator {
    fn drop(&mut self) {
        if let Some(translator) = self.0.take() {
            let (tx, rx) = std::sync::mpsc::channel();
            thread::spawn(move || {
                drop(translator);
                let _ = tx.send(());
            });
            if rx.recv_timeout(GUARD).is_err() {
                if thread::panicking() {
                    eprintln!(
                        "timed out waiting for Translator drop within {GUARD:?} during unwind"
                    );
                } else {
                    panic!("timed out waiting for Translator drop within {GUARD:?}");
                }
            }
        }
    }
}

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
    let mut translator = GuardedTranslator::new(home.path().to_path_buf());
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

    let off_msgs = translator.service_off();
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
    let mut translator = GuardedTranslator::new(home.path().to_path_buf());
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
    let _ = translator.service_off();
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
    let mut translator = GuardedTranslator::new(home.path().to_path_buf());

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

    let msgs = translator.service_off();
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

fn write_ready_pair_with_sha(home: &Path, pair: TranslatePair, sha: &str) {
    let edir = marker::engine_dir(home);
    fs::create_dir_all(&edir).expect("create engine dir");
    let glue = b"console.log(1);";
    let wasm = b"wasm-bytes";
    fs::write(edir.join("bergamot.js"), glue).expect("write glue");
    fs::write(edir.join("bergamot.wasm"), wasm).expect("write wasm");
    fs::write(
        edir.join("installed.json"),
        json!({
            "v": 1,
            "files": [
                { "role": "glue", "name": "bergamot.js", "size": glue.len() },
                { "role": "wasm", "name": "bergamot.wasm", "size": wasm.len() },
            ]
        })
        .to_string(),
    )
    .expect("write engine marker");

    let mdir = marker::model_dir(home, pair);
    fs::create_dir_all(&mdir).expect("create model dir");
    let model = b"model-payload";
    let lex = b"lex";
    let vocab = b"vocab";
    fs::write(mdir.join("model.bin"), model).expect("write model");
    fs::write(mdir.join("lex.bin"), lex).expect("write lex");
    fs::write(mdir.join("vocab.spm"), vocab).expect("write vocab");
    fs::write(
        mdir.join("installed.json"),
        json!({
            "v": 1,
            "pair": pair.as_str(),
            "model_sha256": sha,
            "files": [
                { "role": "model", "name": "model.bin", "size": model.len() },
                { "role": "lex", "name": "lex.bin", "size": lex.len() },
                { "role": "vocab", "name": "vocab.spm", "size": vocab.len() },
            ]
        })
        .to_string(),
    )
    .expect("write pair marker");
}

#[test]
fn checksum_failure_survives_temporary_cli_loss() {
    let home = TempDir::new().expect("temp home");
    seed_cli(home.path());
    let mut translator = GuardedTranslator::new(home.path().to_path_buf());
    run_install(&mut translator, TranslatePair::IdEn);

    // Trigger an install checksum failure.
    configure(home.path(), &json!({ "install": "checksum" }));
    let fail_statuses = run_install(&mut translator, TranslatePair::EnId);
    assert_eq!(
        fail_statuses.last().expect("final status").failed,
        Some(TranslateFailure::Checksum)
    );

    // Starting a run does not erase the Checksum failure.
    clear_config(home.path());
    assert!(
        translator
            .on_detail(true, "c1", QuoteLang::En, &["Merah.".to_string()])
            .is_empty()
    );
    service_until(&mut translator, true, "run finishes", |msgs| {
        !quote_translated_items(msgs).is_empty()
    });
    wait_until("run log line", || {
        let _ = translator.service(true);
        !translator.drain_log().is_empty()
    });
    assert_eq!(translator.status().failed, Some(TranslateFailure::Checksum));

    // Removing CLI surfaces Engine, and restoring CLI brings Checksum back.
    fs::remove_file(cli_record_path(home.path())).expect("remove cli.json");
    let lost = translator.check().expect("status should change to Engine");
    assert_eq!(lost.failed, Some(TranslateFailure::Engine));
    assert_eq!(translator.install(true, TranslatePair::EnId), Err("engine"));
    assert_eq!(translator.status().failed, Some(TranslateFailure::Engine));

    seed_cli(home.path());
    let restored = translator.check().expect("status should restore Checksum");
    assert_eq!(restored.failed, Some(TranslateFailure::Checksum));

    // Starting a new install also leaves Checksum intact until it succeeds.
    let _ = fs::remove_file(home.path().join("fake-translate.pid"));
    configure(home.path(), &json!({ "install": "hang" }));
    assert_eq!(translator.install(true, TranslatePair::EnId), Ok(()));
    assert_eq!(translator.status().failed, Some(TranslateFailure::Checksum));
    let _ = translator.service(true);
    let _ = wait_for_pid(home.path());
    let _ = translator.service_off();
    assert_eq!(translator.status().failed, Some(TranslateFailure::Checksum));
}

#[test]
fn missing_cli_keeps_queue_and_resumes_when_restored() {
    let home = TempDir::new().expect("temp home");
    seed_cli(home.path());
    let mut translator = GuardedTranslator::new(home.path().to_path_buf());
    run_install(&mut translator, TranslatePair::IdEn);

    // Queue a miss while markers are ready, then lose cli.json.
    assert!(
        translator
            .on_detail(true, "c1", QuoteLang::En, &["Merah.".to_string()])
            .is_empty()
    );
    fs::remove_file(cli_record_path(home.path())).expect("remove cli.json");

    for _ in 0..5 {
        let msgs = translator.service(true);
        assert!(quote_translated_items(&msgs).is_empty());
    }
    assert_eq!(translator.status().failed, Some(TranslateFailure::Engine));

    // Restore cli.json without calling check(); the queued item starts and arrives.
    seed_cli(home.path());
    let msgs = service_until(&mut translator, true, "resumed QuoteTranslated", |msgs| {
        !quote_translated_items(msgs).is_empty()
    });
    let items = quote_translated_items(&msgs);
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].0, "c1");
    assert_eq!(items[0].1.text, "T:Merah.");
    assert_eq!(translator.status().failed, None);
}

#[test]
fn model_update_between_enqueue_and_launch_uses_new_digest() {
    const OLD_SHA: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    let home = TempDir::new().expect("temp home");
    seed_cli(home.path());
    write_ready_pair_with_sha(home.path(), TranslatePair::IdEn, OLD_SHA);
    let mut translator = GuardedTranslator::new(home.path().to_path_buf());

    // Queue a quote while OLD_SHA is installed, before service(true) launches a run.
    assert!(
        translator
            .on_detail(true, "c1", QuoteLang::En, &["Merah.".to_string()])
            .is_empty()
    );

    // Installing IdEn replaces the marker with the fake CLI's digest before the run launches.
    run_install(&mut translator, TranslatePair::IdEn);
    let new_sha = marker::model_sha(home.path(), TranslatePair::IdEn).expect("new sha");
    assert_ne!(new_sha, OLD_SHA);

    let msgs = service_until(&mut translator, true, "translated after update", |msgs| {
        !quote_translated_items(msgs).is_empty()
    });
    let items = quote_translated_items(&msgs);
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].0, "c1");
    assert_eq!(items[0].1.text, "T:Merah.");
    wait_until("run log line", || {
        let _ = translator.service(true);
        !translator.drain_log().is_empty()
    });

    let mut cache = QuoteCache::new(home.path().to_path_buf());
    assert_eq!(
        cache.get(QuoteLang::En, &cache_key(OLD_SHA, QuoteLang::En, "Merah.")),
        None
    );
    assert_eq!(
        cache.get(QuoteLang::En, &cache_key(&new_sha, QuoteLang::En, "Merah.")),
        Some(Cached::Translated {
            from: QuoteLang::Id,
            text: "T:Merah.".to_string(),
        })
    );
}

#[test]
fn model_change_mid_run_drops_reply_without_caching() {
    const NEW_SHA: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    let home = TempDir::new().expect("temp home");
    seed_cli(home.path());
    let mut translator = GuardedTranslator::new(home.path().to_path_buf());
    run_install(&mut translator, TranslatePair::IdEn);
    let old_sha = marker::model_sha(home.path(), TranslatePair::IdEn).expect("old sha");
    assert_ne!(old_sha, NEW_SHA);

    let release_file = home.path().join("release");
    let _ = fs::remove_file(home.path().join("fake-translate.pid"));
    configure(home.path(), &json!({ "wait_file": release_file }));

    let quotes = vec!["Merah.".to_string()];
    assert!(
        translator
            .on_detail(true, "c1", QuoteLang::En, &quotes)
            .is_empty()
    );
    let _ = translator.service(true);
    let _pid = wait_for_pid(home.path());

    // Change model_sha256 while the run is in flight, then let the child reply.
    write_ready_pair_with_sha(home.path(), TranslatePair::IdEn, NEW_SHA);
    fs::write(&release_file, b"go").expect("write release file");

    wait_until("stale run finishes and drops reply", || {
        let msgs = translator.service(true);
        assert!(quote_translated_items(&msgs).is_empty());
        let logs = translator.drain_log();
        if logs.is_empty() {
            false
        } else {
            assert_eq!(
                logs,
                vec!["translate run: 0 ok, 0 original, 0 failed, 1 dropped"]
            );
            true
        }
    });

    let mut cache = QuoteCache::new(home.path().to_path_buf());
    assert_eq!(
        cache.get(QuoteLang::En, &cache_key(&old_sha, QuoteLang::En, "Merah.")),
        None
    );
    assert_eq!(
        cache.get(QuoteLang::En, &cache_key(NEW_SHA, QuoteLang::En, "Merah.")),
        None
    );

    // Next detail open re-queues and caches under NEW_SHA.
    clear_config(home.path());
    assert!(
        translator
            .on_detail(true, "c1", QuoteLang::En, &quotes)
            .is_empty()
    );
    let msgs = service_until(&mut translator, true, "translated under new sha", |msgs| {
        !quote_translated_items(msgs).is_empty()
    });
    let items = quote_translated_items(&msgs);
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].1.text, "T:Merah.");

    wait_until("second run finishes", || {
        let _ = translator.service(true);
        !translator.drain_log().is_empty()
    });
    let mut cache = QuoteCache::new(home.path().to_path_buf());
    assert_eq!(
        cache.get(QuoteLang::En, &cache_key(&old_sha, QuoteLang::En, "Merah.")),
        None
    );
    assert!(
        cache
            .get(QuoteLang::En, &cache_key(NEW_SHA, QuoteLang::En, "Merah."))
            .is_some()
    );
}

fn write_unlaunchable_cli(home: &Path) {
    let bad_node = home.join("not-executable-node");
    fs::write(&bad_node, b"not executable").expect("write non-executable node placeholder");
    write_cli_record(
        home,
        &CliRecord {
            node: bad_node,
            entry: fake_cli().entry,
            version: "0.0.0".to_string(),
        },
    );
}

#[test]
fn launch_error_paces_retries_and_recovers_after_backoff() {
    const SHA: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

    let home = TempDir::new().expect("temp home");
    write_ready_pair_with_sha(home.path(), TranslatePair::IdEn, SHA);
    write_unlaunchable_cli(home.path());

    let mut translator =
        Translator::with_launch_retry(home.path().to_path_buf(), Duration::from_millis(300));
    assert_eq!(translator.status().failed, None);

    assert!(
        translator
            .on_detail(true, "c1", QuoteLang::En, &["Merah.".to_string()])
            .is_empty()
    );

    let mut launch_logs = Vec::new();
    for _ in 0..20 {
        let msgs = translator.service(true);
        assert!(quote_translated_items(&msgs).is_empty());
        launch_logs.extend(translator.drain_log());
    }
    assert_eq!(launch_logs.len(), 1);
    assert!(launch_logs[0].starts_with("translate run launch failed: 1 quotes, "));
    assert_eq!(translator.status().failed, Some(TranslateFailure::Engine));
    assert!(read_logged_argv(home.path()).is_empty());

    // Restoring cli.json without check() still waits for the backoff window to pass.
    seed_cli(home.path());
    for _ in 0..5 {
        let msgs = translator.service(true);
        assert!(quote_translated_items(&msgs).is_empty());
    }
    assert!(translator.drain_log().is_empty());
    assert!(read_logged_argv(home.path()).is_empty());

    // Once the backoff passes, the pending queue launches and translates.
    thread::sleep(Duration::from_millis(350));
    let msgs = service_until(&mut translator, true, "translated after backoff", |msgs| {
        !quote_translated_items(msgs).is_empty()
    });
    let items = quote_translated_items(&msgs);
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].0, "c1");
    assert_eq!(items[0].1.text, "T:Merah.");
    assert_eq!(translator.status().failed, None);
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
fn launch_error_backoff_clears_early_when_check_sees_changed_cli() {
    const SHA: &str = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

    let home = TempDir::new().expect("temp home");
    write_ready_pair_with_sha(home.path(), TranslatePair::IdEn, SHA);
    write_unlaunchable_cli(home.path());

    let mut translator = GuardedTranslator::new(home.path().to_path_buf());
    assert!(
        translator
            .on_detail(true, "c1", QuoteLang::En, &["Merah.".to_string()])
            .is_empty()
    );

    let mut launch_logs = Vec::new();
    for _ in 0..20 {
        let msgs = translator.service(true);
        assert!(quote_translated_items(&msgs).is_empty());
        launch_logs.extend(translator.drain_log());
    }
    assert_eq!(launch_logs.len(), 1);
    assert!(launch_logs[0].starts_with("translate run launch failed: 1 quotes, "));
    assert_eq!(translator.status().failed, Some(TranslateFailure::Engine));

    // Unchanged cli.json keeps the backoff active across check().
    assert_eq!(translator.check(), None);
    for _ in 0..5 {
        let msgs = translator.service(true);
        assert!(quote_translated_items(&msgs).is_empty());
    }
    assert!(translator.drain_log().is_empty());

    // Updating cli.json and running check() clears backoff early.
    seed_cli(home.path());
    let updated = translator
        .check()
        .expect("changed cli.json should clear Engine");
    assert_eq!(updated.failed, None);

    let msgs = service_until(&mut translator, true, "translated after check", |msgs| {
        !quote_translated_items(msgs).is_empty()
    });
    let items = quote_translated_items(&msgs);
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].0, "c1");
    assert_eq!(items[0].1.text, "T:Merah.");
    assert_eq!(translator.status().failed, None);
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
