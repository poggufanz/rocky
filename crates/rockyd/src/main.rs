#![windows_subsystem = "windows"]

//! `rockyd`: drain spool into the status machine, serve desk over a named pipe.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use rocky_proto::paths::{desk_dir, log_path, rocky_home, spool_dir};
use rocky_proto::pipe::{AgentKey, AgentStatus, Health, ServerMsg, StatusOp};
use rockyd::log::RotatingLog;
use rockyd::repo::resolve_repo;
use rockyd::server::{BindError, Control, Hub, serve};
use rockyd::spool::{Ingestor, MAX_BYTES, MAX_FILES, prune};
use rockyd::state::StatusState;

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
    health: Health,
}

fn refresh_last_known(s: &mut Shared) {
    for a in s.state.agents() {
        s.last_known.insert(a.key.clone(), a);
    }
}

fn main() {
    let home = rocky_home();
    std::fs::create_dir_all(desk_dir(&home)).ok();
    let log = Arc::new(RotatingLog::new(&log_path(&home)));

    // Panic hook: log, then abort (spec §7.1). Counts/lifecycle only.
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

    let mut ingest = Ingestor::new();
    match prune(&spool, MAX_FILES, MAX_BYTES) {
        Ok(dropped) => {
            ingest.health.spool_dropped += dropped;
            if dropped > 0 {
                log.line(&format!("pruned {dropped} spool files at start"));
            }
        }
        Err(e) => log.line(&format!("start prune failed: {e}")),
    }

    // Shared under a mutex for the snapshot closure; the daemon loop never
    // holds this lock while calling `broadcast` (see Hub lock order).
    let shared = Arc::new(Mutex::new(Shared {
        state: StatusState::new(),
        last_known: HashMap::new(),
        health: ingest.health.clone(),
    }));

    {
        let mut repo_of = resolve_repo;
        let mut s = shared.lock().unwrap();
        let changes = ingest.ingest_once(&spool, &mut s.state, &mut repo_of);
        refresh_last_known(&mut s);
        s.health = ingest.health.clone();
        let pending = s.health.spool_pending;
        let agents = changes.upserted.len();
        drop(s);
        if agents > 0 {
            log.line(&format!(
                "start ingest: {agents} agents, {pending} files pending"
            ));
        }
    }

    let hub = Arc::new(Hub::new());
    let snapshot_shared = Arc::clone(&shared);
    let snapshot: Arc<dyn Fn() -> ServerMsg + Send + Sync> = Arc::new(move || {
        let s = snapshot_shared.lock().unwrap();
        ServerMsg::Snapshot {
            agents: s.state.agents(),
            aggregate: s.state.aggregate(),
            health: s.health.clone(),
        }
    });

    let (control_tx, control_rx) = mpsc::channel();
    let _server = match serve(&home, Arc::clone(&hub), snapshot, control_tx) {
        Ok(h) => h,
        Err(BindError::Taken) => {
            log.line("pipe taken (another rockyd, or squatted)");
            std::process::exit(3);
        }
        Err(BindError::Io(e)) => {
            log.line(&format!("pipe bind failed, exiting: {e}"));
            std::process::exit(1);
        }
    };
    log.line("serving");

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
        // Drain stop requests first so shutdown stays prompt.
        if let Ok(Control::Stop { id, reply, flushed }) = control_rx.try_recv() {
            // Wait for the client thread to flush the ack before exiting:
            // without this, `process::exit` can race the writer thread and
            // the client never sees the ack. Only when the ack was accepted —
            // otherwise the client is already gone, so exit immediately.
            // Bounded so a dead client can't wedge shutdown; the pipe dies
            // with the process either way.
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
            log.line("stop requested, exiting");
            std::process::exit(0);
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

/// Ingest the spool once, then broadcast one Status per changed key plus a
/// Health message when health moved. Lock discipline: collect messages under
/// the state lock, release it, then broadcast.
fn rescan(
    spool: &Path,
    shared: &Arc<Mutex<Shared>>,
    hub: &Hub,
    log: &RotatingLog,
    ingest: &mut Ingestor,
) {
    let mut repo_of = resolve_repo;
    let (msgs, health, upserts, health_changed) = {
        let mut s = shared.lock().unwrap();
        let changes = ingest.ingest_once(spool, &mut s.state, &mut repo_of);
        let mut msgs = Vec::with_capacity(changes.upserted.len() + 1);
        for key in &changes.upserted {
            if let Some(agent) = s.state.get(key) {
                s.last_known.insert(key.clone(), agent.clone());
                msgs.push(ServerMsg::Status {
                    op: StatusOp::Upsert,
                    agent,
                });
            }
        }
        let health = ingest.health.clone();
        let health_changed = health != s.health;
        if health_changed {
            msgs.push(ServerMsg::Health {
                health: health.clone(),
            });
            s.health = health.clone();
        }
        (msgs, health, changes.upserted.len(), health_changed)
    };
    for m in &msgs {
        hub.broadcast(m);
    }
    if upserts > 0 || health_changed {
        log.line(&format!(
            "ingest: {upserts} agents updated, {} files pending",
            health.spool_pending
        ));
    }
}

/// Minute tick: broadcast done→idle upserts, ended removals, and removals log.
fn tick_once(shared: &Arc<Mutex<Shared>>, hub: &Hub, log: &RotatingLog) {
    let (msgs, removed) = {
        let mut s = shared.lock().unwrap();
        let changes = s.state.tick(now_ms());
        let mut msgs = Vec::with_capacity(changes.upserted.len() + changes.removed.len());
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
            if let Some(agent) = s.last_known.remove(key) {
                msgs.push(ServerMsg::Status {
                    op: StatusOp::Remove,
                    agent,
                });
            }
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
