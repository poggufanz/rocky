//! Earlier attempts for a change card, read from the Node CLI after the card detail is sent.
//!
//! The daemon starts `<node> <entry> attempts --card <id> --json` on a worker thread
//! and bounds the child runtime and the reply size. A failed read leaves the section hidden.

use std::collections::{HashMap, VecDeque};
use std::fmt;
use std::io::Read;
use std::marker::PhantomData;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use rocky_proto::pipe::{AttemptOutcome, RelatedAttempt, ServerMsg, encode};
use serde::de::{MapAccess, Visitor, value::MapAccessDeserializer};
use serde::{Deserialize, Deserializer};

use crate::guard::records::{CliRecord, read_cli};
use crate::history::civil_from_days;

/// Longest one `attempts --card` child may run.
pub const ATTEMPTS_TIMEOUT: Duration = Duration::from_secs(2);
/// Largest encoded `RelatedAttempts` line, including its newline.
pub const RELATED_ATTEMPTS_CAP: usize = 8 * 1024;
const STDOUT_CAP: usize = 1 << 20;
const MAX_ROWS: usize = 5;
const MAX_FILES: usize = 3;
const MAX_PATH_CHARS: usize = 160;
const CACHE_CAP: usize = 64;
const POLL: Duration = Duration::from_millis(20);
const DAY_MS: u64 = 86_400_000;

/// Runs the CLI for one card id and returns its stdout on success.
pub type AttemptsRunner = Arc<dyn Fn(&str) -> Option<Vec<u8>> + Send + Sync>;

type Key = (String, u32);
type Completion = (Key, Option<Vec<u8>>);

/// The CLI's card id rule is `^[A-Za-z0-9._:-]{1,128}$`.
pub fn valid_card_id(id: &str) -> bool {
    (1..=128).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
}

/// Requires a JSON object for records whose derived deserializer also accepts positional arrays.
struct JsonObject<T>(T);

impl<'de, T: Deserialize<'de>> Deserialize<'de> for JsonObject<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ObjectVisitor<T>(PhantomData<T>);

        impl<'de, T: Deserialize<'de>> Visitor<'de> for ObjectVisitor<T> {
            type Value = JsonObject<T>;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a JSON object")
            }

            fn visit_map<M: MapAccess<'de>>(self, map: M) -> Result<Self::Value, M::Error> {
                T::deserialize(MapAccessDeserializer::new(map)).map(JsonObject)
            }
        }

        deserializer.deserialize_map(ObjectVisitor(PhantomData))
    }
}

#[derive(Deserialize)]
struct RawReply {
    v: u32,
    entries: Vec<JsonObject<RawEntry>>,
}

#[derive(Deserialize)]
struct RawEntry {
    attempts: Vec<JsonObject<RawAttempt>>,
}

#[derive(Deserialize)]
struct RawAttempt {
    ts: f64,
    outcome: String,
    changes: JsonObject<RawChanges>,
}

#[derive(Deserialize)]
struct RawChanges {
    state: String,
    #[serde(default)]
    files: Vec<String>,
    #[serde(default)]
    more: u64,
}

fn outcome(s: &str) -> Option<AttemptOutcome> {
    Some(match s {
        "passed" => AttemptOutcome::Passed,
        "possible_pass" => AttemptOutcome::PossiblePass,
        "same_failure" => AttemptOutcome::SameFailure,
        "different_failure" => AttemptOutcome::DifferentFailure,
        "no_later_run" => AttemptOutcome::NoLaterRun,
        "unknown" => AttemptOutcome::Unknown,
        _ => return None,
    })
}

fn utc_date(ms: u64) -> String {
    let (y, m, d) = civil_from_days((ms / DAY_MS) as i64);
    format!("{y:04}-{m:02}-{d:02}")
}

/// Parses version 1 CLI output into at most five newest-first rows.
pub fn parse_attempts(stdout: &[u8]) -> Option<Vec<RelatedAttempt>> {
    let json = std::str::from_utf8(stdout).ok()?;
    let JsonObject(reply): JsonObject<RawReply> = serde_json::from_str(json).ok()?;
    if reply.v != 1 {
        return None;
    }
    let mut rows: Vec<(f64, RelatedAttempt)> = reply
        .entries
        .into_iter()
        .flat_map(|JsonObject(entry)| entry.attempts)
        .filter_map(|JsonObject(attempt)| {
            if !attempt.ts.is_finite() || attempt.ts < 0.0 {
                return None;
            }
            let outcome = outcome(&attempt.outcome)?;
            let JsonObject(changes) = attempt.changes;
            let (files, more) = if changes.state == "observed" {
                let extra = changes.files.len().saturating_sub(MAX_FILES) as u64;
                let files = changes.files.into_iter().take(MAX_FILES).collect();
                let more = extra.saturating_add(changes.more);
                (files, u32::try_from(more).unwrap_or(u32::MAX))
            } else {
                (Vec::new(), 0)
            };
            Some((
                attempt.ts,
                RelatedAttempt {
                    date: utc_date(attempt.ts as u64),
                    outcome,
                    files,
                    more,
                },
            ))
        })
        .collect();
    rows.sort_by(|a, b| b.0.total_cmp(&a.0));
    Some(
        rows.into_iter()
            .take(MAX_ROWS)
            .map(|(_, row)| row)
            .collect(),
    )
}

/// Bounds the paths and drops the oldest rows until the encoded message fits.
pub fn related_msg(card_id: &str, rev: u32, mut items: Vec<RelatedAttempt>) -> Option<ServerMsg> {
    items.truncate(MAX_ROWS);
    for item in &mut items {
        let extra = item.files.len().saturating_sub(MAX_FILES);
        item.more = item
            .more
            .saturating_add(u32::try_from(extra).unwrap_or(u32::MAX));
        item.files.truncate(MAX_FILES);
        for file in &mut item.files {
            if let Some((end, _)) = file.char_indices().nth(MAX_PATH_CHARS) {
                file.truncate(end);
            }
        }
    }
    while !items.is_empty() {
        let msg = ServerMsg::RelatedAttempts {
            card_id: card_id.to_string(),
            rev,
            items: items.clone(),
        };
        if encode(&msg).len() <= RELATED_ATTEMPTS_CAP {
            return Some(msg);
        }
        items.pop();
    }
    None
}

/// Runs the CLI once and kills and reaps the child at the deadline.
pub fn run_attempts_child(
    cli: &CliRecord,
    home: &Path,
    card_id: &str,
    timeout: Duration,
) -> Option<Vec<u8>> {
    if !valid_card_id(card_id) {
        return None;
    }
    let mut command = Command::new(&cli.node);
    command
        .arg(&cli.entry)
        .args(["attempts", "--card", card_id, "--json"])
        .env("ROCKY_HOME", home)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);

    let started = Instant::now();
    let mut child = command.spawn().ok()?;
    let (tx, rx) = mpsc::channel();
    // A grandchild may hold the pipe open, so the worker never joins the reader.
    let reader = child.stdout.take().and_then(|stdout| {
        thread::Builder::new()
            .name("rocky-attempts-reader".into())
            .spawn(move || {
                let mut bytes = Vec::new();
                let ok = stdout
                    .take(STDOUT_CAP as u64 + 1)
                    .read_to_end(&mut bytes)
                    .is_ok();
                let _ = tx.send((ok && bytes.len() <= STDOUT_CAP).then_some(bytes));
            })
            .ok()
    });
    if reader.is_none() {
        let _ = child.kill();
        let _ = child.wait();
        return None;
    }

    let status = loop {
        let remaining = timeout.saturating_sub(started.elapsed());
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if !remaining.is_zero() => thread::sleep(POLL.min(remaining)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };
    if !status.success() {
        return None;
    }
    let bytes = rx
        .recv_timeout(timeout.checked_sub(started.elapsed())?)
        .ok()??;
    std::str::from_utf8(&bytes).ok()?;
    Some(bytes)
}

/// One-child-at-a-time runner with a per-`(card_id, rev)` cache.
pub struct RelatedAttemptsLoop {
    runner: AttemptsRunner,
    cache: HashMap<Key, Option<ServerMsg>>,
    order: VecDeque<Key>,
    in_flight: Option<Key>,
    queued: Option<Key>,
    done_tx: Sender<Completion>,
    done_rx: Receiver<Completion>,
    ready: Vec<ServerMsg>,
}

impl RelatedAttemptsLoop {
    pub fn new(runner: AttemptsRunner) -> Self {
        let (done_tx, done_rx) = mpsc::channel();
        Self {
            runner,
            cache: HashMap::new(),
            order: VecDeque::new(),
            in_flight: None,
            queued: None,
            done_tx,
            done_rx,
            ready: Vec::new(),
        }
    }

    /// Reads the CLI registration under `home` for each child.
    pub fn for_home(home: PathBuf) -> Self {
        Self::new(Arc::new(move |card_id| {
            let cli = read_cli(&home)?;
            run_attempts_child(&cli, &home, card_id, ATTEMPTS_TIMEOUT)
        }))
    }

    pub fn set_runner(&mut self, runner: AttemptsRunner) {
        self.runner = runner;
    }

    /// Requests earlier attempts for this card revision without waiting for the child.
    pub fn request(&mut self, card_id: &str, rev: u32) {
        if !valid_card_id(card_id) {
            return;
        }
        let key = (card_id.to_string(), rev);
        if let Some(cached) = self.cache.get(&key) {
            self.queued = None;
            self.ready.extend(cached.clone());
            return;
        }
        if self.in_flight.as_ref() == Some(&key) {
            self.queued = None;
        } else if self.in_flight.is_some() {
            self.queued = Some(key);
        } else {
            self.start(key);
        }
    }

    fn start(&mut self, key: Key) {
        let runner = Arc::clone(&self.runner);
        let tx = self.done_tx.clone();
        let job = key.clone();
        let spawned = thread::Builder::new()
            .name("rocky-attempts".into())
            .spawn(move || {
                let out = runner(&job.0);
                let _ = tx.send((job, out));
            });
        if spawned.is_ok() {
            self.in_flight = Some(key);
        }
    }

    /// Collects finished children and returns messages ready to broadcast.
    pub fn service(&mut self) -> Vec<ServerMsg> {
        while let Ok((key, out)) = self.done_rx.try_recv() {
            self.in_flight = None;
            if let Some(items) = out.as_deref().and_then(parse_attempts) {
                let msg = related_msg(&key.0, key.1, items);
                self.ready.extend(msg.clone());
                self.insert(key, msg);
            }
        }
        if self.in_flight.is_none()
            && let Some(next) = self.queued.take()
        {
            self.start(next);
        }
        std::mem::take(&mut self.ready)
    }

    fn insert(&mut self, key: Key, msg: Option<ServerMsg>) {
        self.cache.insert(key.clone(), msg);
        self.order.push_back(key);
        if self.order.len() > CACHE_CAP
            && let Some(oldest) = self.order.pop_front()
        {
            self.cache.remove(&oldest);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rocky_proto::pipe::{AttemptOutcome, ServerMsg, encode};
    use std::sync::{Arc, Mutex, mpsc};
    use std::time::{Duration, Instant};

    fn reply(entries: &str) -> Vec<u8> {
        format!(r#"{{"v":1,"coverage":{{}},"ungroupedLegacy":0,"entries":[{entries}]}}"#)
            .into_bytes()
    }

    fn attempt(ts: u64, outcome: &str, changes: &str) -> String {
        format!(
            r#"{{"failureId":"f{ts}","ts":{ts},"cmd":"npm test","outcome":"{outcome}","sessionScoped":true,"changes":{changes}}}"#
        )
    }

    const DAY: u64 = 86_400_000;

    #[test]
    fn parse_rejects_other_versions_and_malformed_json() {
        assert_eq!(parse_attempts(br#"{"v":2,"entries":[]}"#), None);
        assert_eq!(parse_attempts(b"not json"), None);
        assert_eq!(parse_attempts(br#"{"entries":[]}"#), None);
        assert_eq!(parse_attempts(br#"[1,[]]"#), None);
        assert_eq!(
            parse_attempts(b"{\"v\":1,\"entries\":[],\"ignored\":\"\xff\"}"),
            None
        );
    }

    #[test]
    fn parse_keeps_newest_five_across_entries_with_observed_files_only() {
        let observed = r#"{"state":"observed","files":["a.ts","b.ts","c.ts","d.ts"],"more":2,"cardId":"c1","partial":false}"#;
        let testimony = r#"{"state":"testimony","files":["said.ts"],"rationaleId":"r1"}"#;
        let unknown = r#"{"state":"unknown"}"#;
        let e1 = format!(
            r#"{{"attempts":[{},{},{}]}}"#,
            attempt(DAY, "same_failure", observed),
            attempt(2 * DAY, "passed", testimony),
            attempt(3 * DAY, "not_a_real_outcome", unknown),
        );
        let e2 = format!(
            r#"{{"attempts":[{},{},{},{}]}}"#,
            attempt(4 * DAY, "different_failure", unknown),
            attempt(5 * DAY, "possible_pass", unknown),
            attempt(6 * DAY, "no_later_run", unknown),
            attempt(7 * DAY, "unknown", unknown),
        );
        let items = parse_attempts(&reply(&format!("{e1},{e2}"))).unwrap();
        let dates: Vec<&str> = items.iter().map(|i| i.date.as_str()).collect();
        // Newest first; the unknown outcome string (day 3) is dropped; capped at five.
        assert_eq!(
            dates,
            [
                "1970-01-08",
                "1970-01-07",
                "1970-01-06",
                "1970-01-05",
                "1970-01-03"
            ]
        );
        let parsed_all = parse_attempts(&reply(&e1)).unwrap();
        let observed_item = parsed_all
            .iter()
            .find(|i| i.outcome == AttemptOutcome::SameFailure)
            .unwrap();
        assert_eq!(observed_item.files, ["a.ts", "b.ts", "c.ts"]);
        assert_eq!(observed_item.more, 3);
        let testimony_item = parsed_all
            .iter()
            .find(|i| i.outcome == AttemptOutcome::Passed)
            .unwrap();
        assert!(testimony_item.files.is_empty());
    }

    #[test]
    fn related_msg_fits_the_cap_or_is_absent() {
        let long = "\u{1}".repeat(400);
        let items: Vec<RelatedAttempt> = (0..5)
            .map(|n| RelatedAttempt {
                date: format!("2026-11-{:02}", 12 - n),
                outcome: AttemptOutcome::SameFailure,
                files: vec![long.clone(), long.clone(), long.clone()],
                more: 0,
            })
            .collect();
        let msg = related_msg("c1", 1, items).unwrap();
        assert!(encode(&msg).len() <= RELATED_ATTEMPTS_CAP);
        let ServerMsg::RelatedAttempts { items, .. } = &msg else {
            unreachable!()
        };
        assert_eq!(items.len(), 2);
        assert_eq!(items[1].date, "2026-11-11");
        assert!(
            items
                .iter()
                .all(|i| i.files.iter().all(|f| f.chars().count() <= 160))
        );
        assert_eq!(related_msg("c1", 1, Vec::new()), None);
    }

    #[test]
    fn card_id_rule_matches_the_cli() {
        assert!(valid_card_id("card-1.a:b_C"));
        assert!(!valid_card_id(""));
        assert!(!valid_card_id("a b"));
        assert!(!valid_card_id(&"a".repeat(129)));
    }

    fn counting_runner(calls: Arc<Mutex<Vec<String>>>, body: Option<Vec<u8>>) -> AttemptsRunner {
        Arc::new(move |card_id: &str| {
            calls.lock().unwrap().push(card_id.to_string());
            body.clone()
        })
    }

    fn wait_msgs(lp: &mut RelatedAttemptsLoop, want: usize) -> Vec<ServerMsg> {
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut out = Vec::new();
        while out.len() < want && Instant::now() < deadline {
            out.extend(lp.service());
            std::thread::sleep(Duration::from_millis(5));
        }
        out
    }

    fn wait_for_silent_completion(lp: &mut RelatedAttemptsLoop) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while lp.in_flight.is_some() {
            assert!(lp.service().is_empty());
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(lp.service().is_empty());
    }

    #[test]
    fn caches_per_card_and_rev_and_reruns_on_new_rev() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let body = reply(&format!(
            r#"{{"attempts":[{}]}}"#,
            attempt(DAY, "passed", r#"{"state":"unknown"}"#)
        ));
        let mut lp = RelatedAttemptsLoop::new(counting_runner(calls.clone(), Some(body)));
        lp.request("c1", 1);
        assert_eq!(wait_msgs(&mut lp, 1).len(), 1);
        lp.request("c1", 1);
        assert_eq!(
            wait_msgs(&mut lp, 1).len(),
            1,
            "cache hit still yields the message"
        );
        assert_eq!(calls.lock().unwrap().len(), 1);
        lp.request("c1", 2);
        assert_eq!(wait_msgs(&mut lp, 1).len(), 1);
        assert_eq!(calls.lock().unwrap().len(), 2);
    }

    #[test]
    fn failures_and_empty_results_send_nothing_and_failures_are_not_cached() {
        for (body, expected_calls) in [
            (None, 2),
            (Some(b"malformed JSON".to_vec()), 2),
            (Some(reply("")), 1),
        ] {
            let calls = Arc::new(Mutex::new(Vec::new()));
            let mut lp = RelatedAttemptsLoop::new(counting_runner(calls.clone(), body));
            for _ in 0..2 {
                lp.request("c1", 1);
                wait_for_silent_completion(&mut lp);
            }
            assert_eq!(calls.lock().unwrap().len(), expected_calls);
        }
    }

    #[test]
    fn malformed_nested_reply_is_retried() {
        let valid = reply(&format!(
            r#"{{"attempts":[{}]}}"#,
            attempt(DAY, "passed", r#"{"state":"unknown"}"#)
        ));
        for malformed in [
            reply("[[]]"),
            reply(r#"{"attempts":[[86400000,"passed",{"state":"unknown"}]]}"#),
            reply(
                r#"{"attempts":[{"ts":86400000,"outcome":"passed","changes":["unknown",[],0]}]}"#,
            ),
        ] {
            let mut lp = RelatedAttemptsLoop::new(Arc::new(move |_| Some(malformed.clone())));
            lp.request("c1", 1);
            wait_for_silent_completion(&mut lp);

            let valid = valid.clone();
            lp.set_runner(Arc::new(move |_| Some(valid.clone())));
            lp.request("c1", 1);
            let messages = wait_msgs(&mut lp, 1);
            assert!(matches!(
                messages.as_slice(),
                [ServerMsg::RelatedAttempts { card_id, rev: 1, items }]
                    if card_id == "c1" && items.len() == 1 && items[0].outcome == AttemptOutcome::Passed
            ));
        }
    }

    #[test]
    fn cache_evicts_the_oldest_insertion_even_after_a_hit() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let mut lp = RelatedAttemptsLoop::new(counting_runner(calls.clone(), Some(reply(""))));
        for rev in 1..=64 {
            lp.request("c1", rev);
            wait_for_silent_completion(&mut lp);
        }
        for rev in [1, 65, 2, 1] {
            lp.request("c1", rev);
            wait_for_silent_completion(&mut lp);
        }
        assert_eq!(calls.lock().unwrap().len(), 66);
    }

    #[test]
    fn one_child_at_a_time_and_newest_queued_request_wins() {
        let (gate_tx, gate_rx) = mpsc::channel::<()>();
        let (start_tx, start_rx) = mpsc::channel();
        let gate_rx = Arc::new(Mutex::new(gate_rx));
        let calls = Arc::new(Mutex::new(Vec::new()));
        let seen = calls.clone();
        let body = reply(&format!(
            r#"{{"attempts":[{}]}}"#,
            attempt(DAY, "passed", r#"{"state":"unknown"}"#)
        ));
        let runner: AttemptsRunner = Arc::new(move |card_id: &str| {
            seen.lock().unwrap().push(card_id.to_string());
            start_tx.send(card_id.to_string()).unwrap();
            let _ = gate_rx.lock().unwrap().recv_timeout(Duration::from_secs(5));
            Some(body.clone())
        });
        let mut lp = RelatedAttemptsLoop::new(runner);
        lp.request("a", 1);
        assert_eq!(start_rx.recv_timeout(Duration::from_secs(5)).unwrap(), "a");
        lp.request("b", 1);
        lp.request("c", 1);
        lp.request("c", 1);
        assert_eq!(*calls.lock().unwrap(), ["a"]);
        gate_tx.send(()).unwrap();
        gate_tx.send(()).unwrap();
        let msgs = wait_msgs(&mut lp, 2);
        let ids: Vec<&str> = msgs
            .iter()
            .map(|m| match m {
                ServerMsg::RelatedAttempts { card_id, .. } => card_id.as_str(),
                _ => "",
            })
            .collect();
        assert_eq!(ids, ["a", "c"]);
        assert_eq!(*calls.lock().unwrap(), ["a", "c"]);
    }

    #[test]
    fn in_flight_request_supersedes_queued_lookup() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let mut lp = RelatedAttemptsLoop::new(counting_runner(calls.clone(), None));

        lp.request("a", 1);
        lp.request("b", 1);
        assert_eq!(lp.queued, Some(("b".into(), 1)));

        lp.request("a", 1);
        assert!(lp.queued.is_none());
        wait_for_silent_completion(&mut lp);
        assert_eq!(*calls.lock().unwrap(), ["a"]);
    }

    #[test]
    fn cached_request_supersedes_queued_lookup() {
        let (gate_tx, gate_rx) = mpsc::channel::<()>();
        let (start_tx, start_rx) = mpsc::channel();
        let gate_rx = Mutex::new(gate_rx);
        let body = reply(&format!(
            r#"{{"attempts":[{}]}}"#,
            attempt(DAY, "passed", r#"{"state":"unknown"}"#)
        ));
        let mut lp = RelatedAttemptsLoop::new(Arc::new(move |card_id| {
            start_tx.send(card_id.to_string()).unwrap();
            if card_id == "a" {
                let _ = gate_rx.lock().unwrap().recv_timeout(Duration::from_secs(5));
            }
            Some(body.clone())
        }));
        let next_started = || start_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        lp.request("c", 1);
        assert_eq!(next_started(), "c");
        let cached = wait_msgs(&mut lp, 1);
        assert_eq!(cached.len(), 1);

        lp.request("a", 1);
        assert_eq!(next_started(), "a");
        lp.request("b", 1);
        lp.request("c", 1);
        assert_eq!(lp.service(), cached);

        gate_tx.send(()).unwrap();
        let messages = wait_msgs(&mut lp, 1);
        assert!(matches!(
            messages.as_slice(),
            [ServerMsg::RelatedAttempts { card_id, .. }] if card_id == "a"
        ));
        wait_for_silent_completion(&mut lp);
        assert!(start_rx.try_recv().is_err());
    }

    #[test]
    fn child_runner_passes_args_and_home_and_rejects_failed_output() {
        let node = if cfg!(windows) { "node.exe" } else { "node" };
        if std::process::Command::new(node)
            .arg("--version")
            .output()
            .is_err()
        {
            eprintln!("skip: node not on PATH");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let entry = dir.path().join("attempts.js");
        std::fs::write(
            &entry,
            r#"
const [cmd, flag, card, format] = process.argv.slice(2);
const { realpathSync } = require("node:fs");
if (cmd !== "attempts" || flag !== "--card" || format !== "--json" ||
    realpathSync(process.env.ROCKY_HOME) !== realpathSync(__dirname)) process.exit(1);
if (card === "large") process.stdout.write(Buffer.alloc(1048577, 97));
else if (card === "invalid") process.stdout.write(Buffer.from([255]));
else if (card === "failed") { process.stdout.write("{}".repeat(5)); process.exit(1); }
else process.stdout.write(card);
"#,
        )
        .unwrap();
        let cli = CliRecord {
            node: node.into(),
            entry,
            version: "test".into(),
        };
        // Allow for Node startup under load. The separate timeout test exercises the deadline.
        const GUARD: Duration = Duration::from_secs(30);
        let run = |card| run_attempts_child(&cli, dir.path(), card, GUARD);
        assert_eq!(run("ok:a.b_C-1"), Some(b"ok:a.b_C-1".to_vec()));
        for card in ["large", "invalid", "failed", "bad id"] {
            assert_eq!(run(card), None, "{card}");
        }
    }

    #[test]
    fn child_runner_times_out_and_returns_none() {
        // Uses a real `node` when the machine has one; skips otherwise (GitHub images ship node).
        let node = if cfg!(windows) { "node.exe" } else { "node" };
        if std::process::Command::new(node)
            .arg("--version")
            .output()
            .is_err()
        {
            eprintln!("skip: node not on PATH");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let entry = dir.path().join("sleep.js");
        std::fs::write(&entry, "setTimeout(() => {}, 10000);").unwrap();
        let cli = CliRecord {
            node: node.into(),
            entry,
            version: "test".into(),
        };
        let started = Instant::now();
        assert_eq!(
            run_attempts_child(&cli, dir.path(), "c1", Duration::from_millis(500)),
            None
        );
        assert!(started.elapsed() < Duration::from_secs(3));
    }
}
