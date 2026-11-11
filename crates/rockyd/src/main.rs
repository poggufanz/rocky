#![windows_subsystem = "windows"]

//! `rockyd`: drain spool into the status machine, serve desk over a named pipe.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use rocky_proto::history::{HISTORY_VERSION, HistoryBody, HistoryLine};
use rocky_proto::paths::{desk_dir, history_dir, log_path, rocky_home, settings_path, spool_dir};
use rocky_proto::pipe::{AgentKey, AgentStatus, Health, ServerMsg, StatusOp};
use rocky_proto::settings::Settings;
use rockyd::gaps::Gaps;
use rockyd::history::{HISTORY_CAP_BYTES, History, replay};
use rockyd::log::RotatingLog;
use rockyd::repo::resolve_repo;
use rockyd::server::{BindError, Control, Hub, serve};
use rockyd::settings;
use rockyd::spool::{Ingestor, MAX_BYTES, MAX_FILES, prune};
use rockyd::state::StatusState;
use serde_json::Value;

const RESCAN_EVERY: Duration = Duration::from_secs(5);
const TICK_EVERY: Duration = Duration::from_secs(60);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

struct Shared {
    state: StatusState,
    /// Last-known status per key, so `Remove` messages carry the final snapshot.
    last_known: HashMap<AgentKey, AgentStatus>,
    /// Ingest counters only. The broadcast `health` folds gaps and settings
    /// readability into these.
    counters: Health,
    /// Last broadcast health; what `snapshot` carries.
    health: Health,
    settings: Settings,
    settings_unreadable: bool,
    gaps: Gaps,
    history: History,
}

impl Shared {
    /// Recomposes the broadcast health from the ingest counters, the current
    /// gaps, and settings readability. Returns it and whether it moved.
    fn take_health(&mut self) -> (Health, bool) {
        let mut next = self.counters.clone();
        next.gaps = self.gaps.to_vec();
        next.settings_unreadable = self.settings_unreadable;
        let changed = next != self.health;
        if changed {
            self.health = next.clone();
        }
        (next, changed)
    }

    /// Rebuilds state and gaps from history; returns every src it saw.
    fn replay_history(&mut self) -> HashSet<String> {
        let mut repo_of = resolve_repo;
        replay(&self.history, &mut self.state, &mut self.gaps, &mut repo_of)
    }

    /// Records every agent the desk can have been told about, so a later
    /// removal can name it. Replay writes agents without an upsert broadcast;
    /// call this after it.
    fn remember_agents(&mut self) {
        for agent in self.state.agents() {
            self.last_known.insert(agent.key.clone(), agent);
        }
    }
}

/// One full snapshot, used by the subscriber closure and the startup broadcast.
fn snapshot_of(s: &Shared) -> ServerMsg {
    ServerMsg::Snapshot {
        agents: s.state.agents(),
        aggregate: s.state.aggregate(),
        health: s.health.clone(),
        settings: s.settings.clone(),
        repo_pending: Vec::new(),
    }
}

fn main() {
    let home = rocky_home();
    std::fs::create_dir_all(desk_dir(&home)).ok();
    let log = Arc::new(RotatingLog::new(&log_path(&home)));

    // Panic hook: log, then abort. Counts/lifecycle only.
    let panic_log = Arc::clone(&log);
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        default_hook(info);
        let at = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "unknown location".into());
        panic_log.line(&format!("panic, aborting: {at}"));
        std::process::abort();
    }));

    let spool = spool_dir(&home);
    if let Err(e) = std::fs::create_dir_all(&spool) {
        log.line(&format!("cannot create spool dir, exiting: {e}"));
        std::process::exit(1);
    }

    // Bind BEFORE touching the spool, settings, or history: a second daemon
    // must fail here (exit 3) without ingesting, pruning, or deleting anything.
    // The placeholder history is disabled and read-only until settings load.
    let shared = Arc::new(Mutex::new(Shared {
        state: StatusState::new(),
        last_known: HashMap::new(),
        counters: Health::default(),
        health: Health::default(),
        settings: Settings::default(),
        settings_unreadable: false,
        gaps: Gaps::new(),
        history: History::open(&history_dir(&home), HISTORY_CAP_BYTES, false),
    }));

    let hub = Arc::new(Hub::new());
    let snapshot_shared = Arc::clone(&shared);
    let snapshot: Arc<dyn Fn() -> ServerMsg + Send + Sync> =
        Arc::new(move || snapshot_of(&snapshot_shared.lock().unwrap()));

    let (control_tx, control_rx) = mpsc::channel();
    let _server = match serve(&home, Arc::clone(&hub), snapshot, control_tx) {
        Ok(h) => h,
        Err(BindError::Taken) => {
            log.line("pipe taken (another rockyd, or squatted)");
            std::process::exit(3);
        }
        Err(BindError::PathTooLong) => {
            log.line("socket path too long");
            std::process::exit(1);
        }
        Err(BindError::Io(e)) => {
            log.line(&format!("pipe bind failed, exiting: {e}"));
            std::process::exit(1);
        }
    };
    log.line("serving");

    // 1. Settings, marker, and the machine's tool-text flag before replay, so
    // replayed events drop text exactly like live ones.
    let loaded = settings::load(&settings_path(&home));
    if loaded.unreadable {
        log.line("settings unreadable, using defaults");
    }
    if let Err(e) = settings::sync_marker(&home, loaded.settings.tool_text) {
        log.line(&format!("tool-text marker sync failed: {e}"));
    }
    let settings = loaded.settings;
    {
        let mut s = shared.lock().unwrap();
        s.settings = settings.clone();
        s.settings_unreadable = loaded.unreadable;
        s.state.set_tool_text(settings.tool_text);
    }

    // 2. Prune the spool; keep its gap for the startup gap record.
    let now = now_ms();
    let mut ingest = Ingestor::new();
    let pruned = match prune(&spool, MAX_FILES, MAX_BYTES, now) {
        Ok(pruned) => {
            ingest.health.spool_dropped += pruned.deleted;
            if pruned.deleted > 0 {
                log.line(&format!("pruned {} spool files at start", pruned.deleted));
            }
            Some(pruned)
        }
        Err(e) => {
            log.line(&format!("start prune failed: {e}"));
            None
        }
    };

    // 3. History off deletes old segments and skips replay; on prunes, replay,
    // and seeds the ingestor with every replayed src.
    {
        let mut s = shared.lock().unwrap();
        s.history = History::open(&history_dir(&home), HISTORY_CAP_BYTES, settings.history);
        if settings.history {
            if let Err(e) = s.history.prune_old(now) {
                log.line(&format!("history prune failed: {e}"));
            }
            let srcs = s.replay_history();
            ingest.seed_applied(&spool, &srcs);
            s.remember_agents();
        } else if let Err(e) = s.history.set_enabled(false) {
            log.line(&format!("history disable failed: {e}"));
        }
    }

    // 4. The startup prune gap: in health, on every live timeline, and in
    // history so a later restart still reports it.
    if let Some(gap) = pruned.and_then(|p| p.gap) {
        let mut s = shared.lock().unwrap();
        s.gaps.push(gap);
        s.state.record_gap(&gap);
        let line = HistoryLine {
            v: HISTORY_VERSION,
            body: HistoryBody::Gap(gap),
            src: None,
        };
        match s.history.append(&line, now) {
            Ok(Some(full)) => {
                s.gaps.push(full);
                s.state.record_gap(&full);
            }
            Ok(None) => {}
            Err(e) => log.line(&format!("history append failed: {e}")),
        }
    }

    // 5. Initial ingest through the same path as rescans.
    rescan(&spool, &shared, &hub, &log, &mut ingest);

    // 6. Settle what replay and ingest produced, and drop day-old history and
    // gaps. Runs after ingest so pending spool events are never idled away.
    tick_once(&shared, &hub, &log);

    // 7. One full snapshot for desks that connected during startup.
    {
        let msg = snapshot_of(&shared.lock().unwrap());
        hub.broadcast(&msg);
    }

    // Watcher events (and errors) only trigger a rescan; paths untrusted.
    let (watch_tx, watch_rx) = mpsc::channel::<()>();
    let _watcher: Option<RecommendedWatcher> =
        match notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
            let _ = res;
            let _ = watch_tx.send(());
        }) {
            Ok(mut w) => {
                if let Err(e) = w.watch(&spool, RecursiveMode::NonRecursive) {
                    log.line(&format!("watch failed, polling only: {e}"));
                    None
                } else {
                    Some(w)
                }
            }
            Err(e) => {
                log.line(&format!("watcher unavailable, polling only: {e}"));
                None
            }
        };

    let mut last_rescan = Instant::now();
    let mut last_tick = Instant::now();
    loop {
        // Drain every pending control request so shutdown stays prompt and a
        // burst of sets/timelines never waits for the next rescan.
        loop {
            match control_rx.try_recv() {
                Ok(Control::Stop {
                    id,
                    reply,
                    flushed,
                    quit,
                }) => {
                    // Wait for the client thread to flush the ack before
                    // exiting: without this, `process::exit` can race the
                    // writer thread and the client never sees the ack. Only
                    // when the ack was accepted — otherwise the client is
                    // already gone, so exit immediately. Bounded so a dead
                    // client can't wedge shutdown; the pipe dies either way.
                    if reply
                        .send(ServerMsg::Ack {
                            id,
                            ok: true,
                            error: None,
                        })
                        .is_ok()
                    {
                        let _ = flushed.recv_timeout(Duration::from_secs(5));
                    }
                    log.line(if quit {
                        "quit requested, exiting"
                    } else {
                        "stop requested, exiting"
                    });
                    std::process::exit(0);
                }
                Ok(Control::Set {
                    id,
                    name,
                    value,
                    reply,
                }) => {
                    let msg = handle_set(id, &name, &value, &shared, &hub, &log, &home);
                    let _ = reply.send(msg);
                }
                Ok(Control::Timeline { id, key, reply }) => {
                    let entries = shared.lock().unwrap().state.timeline(&key);
                    let _ = reply.send(ServerMsg::Timeline { id, key, entries });
                }
                Err(mpsc::TryRecvError::Empty | mpsc::TryRecvError::Disconnected) => break,
            }
        }

        // Coalesce watcher triggers; never block the loop on them.
        let mut triggered = false;
        while watch_rx.try_recv().is_ok() {
            triggered = true;
        }
        let now = Instant::now();
        if now.duration_since(last_rescan) >= RESCAN_EVERY {
            triggered = true;
            last_rescan = now;
        }
        if triggered {
            rescan(&spool, &shared, &hub, &log, &mut ingest);
        }

        let now = Instant::now();
        if now.duration_since(last_tick) >= TICK_EVERY {
            last_tick = now;
            tick_once(&shared, &hub, &log);
        }

        thread::sleep(Duration::from_millis(25));
    }
}

/// Broadcasts the final state for a key the machine reported as removed: a
/// `Remove` carrying the last-known status, or an upsert when a later event in
/// the same pass re-added it.
fn push_removal(s: &mut Shared, msgs: &mut Vec<ServerMsg>, key: &AgentKey) {
    match s.state.get(key) {
        None => {
            if let Some(agent) = s.last_known.remove(key) {
                msgs.push(ServerMsg::Status {
                    op: StatusOp::Remove,
                    agent,
                });
            }
        }
        Some(agent) => {
            s.last_known.insert(key.clone(), agent.clone());
            msgs.push(ServerMsg::Status {
                op: StatusOp::Upsert,
                agent,
            });
        }
    }
}

/// Ingest the spool once, then broadcast one Status per changed key, one
/// Remove per dropped key, and a Health message when health moved. Lock
/// discipline: collect messages under the state lock, release it, broadcast.
fn rescan(
    spool: &Path,
    shared: &Arc<Mutex<Shared>>,
    hub: &Hub,
    log: &RotatingLog,
    ingest: &mut Ingestor,
) {
    let mut repo_of = resolve_repo;
    let (msgs, health, upserts, health_changed, history_errors) = {
        let mut guard = shared.lock().unwrap();
        let s = &mut *guard;
        let out = ingest.ingest_once(spool, &mut s.state, &mut repo_of, &mut s.history, now_ms());
        let changes = out.changes;
        for gap in &out.gaps {
            s.gaps.push(*gap);
            s.state.record_gap(gap);
        }
        let mut msgs = Vec::with_capacity(changes.upserted.len() + changes.removed.len() + 1);
        for key in &changes.upserted {
            if let Some(agent) = s.state.get(key) {
                s.last_known.insert(key.clone(), agent.clone());
                msgs.push(ServerMsg::Status {
                    op: StatusOp::Upsert,
                    agent,
                });
            }
        }
        for key in &changes.removed {
            push_removal(s, &mut msgs, key);
        }
        s.counters = ingest.health.clone();
        let (health, health_changed) = s.take_health();
        if health_changed {
            msgs.push(ServerMsg::Health {
                health: health.clone(),
            });
        }
        (
            msgs,
            health,
            changes.upserted.len(),
            health_changed,
            out.history_errors,
        )
    };
    for m in &msgs {
        hub.broadcast(m);
    }
    if history_errors > 0 {
        log.line(&format!("history: {history_errors} lines not written"));
    }
    if upserts > 0 || health_changed {
        log.line(&format!(
            "ingest: {upserts} agents updated, {} files pending",
            health.spool_pending
        ));
    }
}

/// Minute tick: prune old history and gaps, then broadcast done→idle upserts,
/// ended/child removals, and health when it moved.
fn tick_once(shared: &Arc<Mutex<Shared>>, hub: &Hub, log: &RotatingLog) {
    let now = now_ms();
    let (msgs, removed) = {
        let mut guard = shared.lock().unwrap();
        let s = &mut *guard;
        if let Err(e) = s.history.prune_old(now) {
            log.line(&format!("history prune failed: {e}"));
        }
        let changes = s.state.tick(now);
        s.gaps.prune(now);
        let mut msgs = Vec::with_capacity(changes.upserted.len() + changes.removed.len() + 1);
        for key in &changes.upserted {
            if let Some(agent) = s.state.get(key) {
                s.last_known.insert(key.clone(), agent.clone());
                msgs.push(ServerMsg::Status {
                    op: StatusOp::Upsert,
                    agent,
                });
            }
        }
        for key in &changes.removed {
            push_removal(s, &mut msgs, key);
        }
        let (health, health_changed) = s.take_health();
        if health_changed {
            msgs.push(ServerMsg::Health { health });
        }
        (msgs, changes.removed.len())
    };
    for m in &msgs {
        hub.broadcast(m);
    }
    if removed > 0 {
        log.line(&format!("tick: {removed} agents removed"));
    }
}

/// Applies one `set` control request: validate, save, sync the marker and the
/// machine's tool-text flag, switch history, broadcast, then return the ack.
fn handle_set(
    id: u64,
    name: &str,
    value: &Value,
    shared: &Arc<Mutex<Shared>>,
    hub: &Hub,
    log: &RotatingLog,
    home: &Path,
) -> ServerMsg {
    let mut msgs = Vec::new();
    let ack = {
        let mut s = shared.lock().unwrap();
        let current = s.settings.clone();
        match settings::apply_set(&current, name, value) {
            Err(e) => ServerMsg::Ack {
                id,
                ok: false,
                error: Some(e.to_string()),
            },
            Ok(next) => match settings::save(&settings_path(home), &next) {
                Err(e) => {
                    log.line(&format!("settings save failed: {e}"));
                    ServerMsg::Ack {
                        id,
                        ok: false,
                        error: Some("save failed".into()),
                    }
                }
                Ok(()) => {
                    if next.tool_text != current.tool_text {
                        if let Err(e) = settings::sync_marker(home, next.tool_text) {
                            log.line(&format!("tool-text marker sync failed: {e}"));
                        }
                        for key in s.state.set_tool_text(next.tool_text) {
                            if let Some(agent) = s.state.get(&key) {
                                s.last_known.insert(key.clone(), agent.clone());
                                msgs.push(ServerMsg::Status {
                                    op: StatusOp::Upsert,
                                    agent,
                                });
                            }
                        }
                    }
                    if next.history != current.history
                        && let Err(e) = s.history.set_enabled(next.history)
                    {
                        log.line(&format!("history switch failed: {e}"));
                    }
                    s.settings = next.clone();
                    s.settings_unreadable = false;
                    msgs.push(ServerMsg::Settings {
                        settings: next.clone(),
                    });
                    let (health, changed) = s.take_health();
                    if changed {
                        msgs.push(ServerMsg::Health { health });
                    }
                    ServerMsg::Ack {
                        id,
                        ok: true,
                        error: None,
                    }
                }
            },
        }
    };
    for m in &msgs {
        hub.broadcast(m);
    }
    ack
}
