#![windows_subsystem = "windows"]

//! `rockyd`: drain spool into the status machine, serve desk over a named pipe.

mod capture_loop;
mod guard_loop;

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::mpsc::SyncSender;
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use capture_loop::CaptureLoop;
use guard_loop::GuardLoop;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use rocky_proto::history::{HISTORY_VERSION, HistoryBody, HistoryLine};
use rocky_proto::paths::{desk_dir, history_dir, log_path, rocky_home, settings_path, spool_dir};
use rocky_proto::pipe::{
    AgentKey, AgentStatus, CaptureHealth, Health, PendingRepo, ServerMsg, SetupHealth, StatusOp,
};
use rocky_proto::settings::Settings;
use rockyd::cards::query::CardQueryLoop;
use rockyd::cards::storage::CardStore;
use rockyd::cards::transcript::claude_config_dirs;
use rockyd::cards::{Engine, EngineCtx};
use rockyd::gaps::Gaps;
use rockyd::guard::records::startup_setup;
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
    /// The setup guard's status. `take_health` carries it into the broadcast health.
    setup: SetupHealth,
    /// Repos waiting for a capture decision, as the last broadcast listed them.
    repo_pending: Vec<PendingRepo>,
    /// Per-repo capture state. `take_health` carries it into the broadcast health.
    capture: Vec<CaptureHealth>,
    /// Change card log store.
    cards: CardStore,
}

impl Shared {
    /// Recomposes the broadcast health from the ingest counters, the current
    /// gaps, and settings readability. Returns it and whether it moved.
    fn take_health(&mut self) -> (Health, bool) {
        let mut next = self.counters.clone();
        next.gaps = self.gaps.to_vec();
        next.settings_unreadable = self.settings_unreadable;
        next.setup = self.setup.clone();
        next.capture = self.capture.clone();
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
        repo_pending: s.repo_pending.clone(),
    }
}

fn main() {
    let home = rocky_home();
    std::fs::create_dir_all(desk_dir(&home)).ok();
    let log = Arc::new(RotatingLog::new(&log_path(&home)));

    // Panic hook: log, then abort. Counts/lifecycle only.
    rockyd::log::install_panic_hook(Arc::clone(&log));

    let spool = spool_dir(&home);
    if let Err(e) = std::fs::create_dir_all(&spool) {
        log.line(&format!("cannot create spool dir, exiting: {e}"));
        std::process::exit(1);
    }

    // Bind BEFORE touching the spool, settings, or history: a second daemon
    // must fail here (exit 3) without ingesting, pruning, or deleting anything.
    // The placeholder history is disabled and read-only until settings load.
    // The setup status comes from local files only (no Node run), so the first
    // snapshot a desk reads already carries the real consent state.
    let setup = startup_setup(&home);
    let shared = Arc::new(Mutex::new(Shared {
        state: StatusState::new(),
        last_known: HashMap::new(),
        counters: Health::default(),
        health: Health {
            setup: setup.clone(),
            ..Health::default()
        },
        settings: Settings::default(),
        settings_unreadable: false,
        gaps: Gaps::new(),
        history: History::open(&history_dir(&home), HISTORY_CAP_BYTES, false),
        setup,
        repo_pending: Vec::new(),
        capture: Vec::new(),
        cards: CardStore::new(home.clone()),
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

    // 1. Settings, markers, and the machine's tool-text flag before replay, so
    // replayed events drop text exactly like live ones.
    let loaded = settings::load(&settings_path(&home));
    if loaded.unreadable {
        log.line("settings unreadable, using defaults");
    }
    if let Err(e) = settings::sync_markers(&home, &loaded.settings) {
        log.line(&format!("marker sync failed: {e}"));
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

    // 5. Initial ingest through the same path as rescans. Discovery queues config
    // dirs only under approved consent, so the guard checks before the ingest and
    // again after it.
    let workers = thread::available_parallelism().map_or(1, |n| n.get().min(4));
    let mut cards = Engine::new(home.clone(), workers);
    cards.set_enabled(settings.cards);
    let mut queries = CardQueryLoop::new(home.clone(), cards.worker_count());

    let mut guards = GuardLoop::new(home.clone(), &log, now_ms());
    guards.check(&shared, &hub, &log);
    rescan(
        &spool,
        &shared,
        &hub,
        &log,
        &mut ingest,
        &mut guards,
        &mut cards,
        None,
    );
    guards.check(&shared, &hub, &log);
    let mut config_dirs = claude_config_dirs(&home);
    let mut captures = CaptureLoop::new(home.clone(), &log);
    captures.check(&guards.allowed_roots());

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
        while let Ok(ctrl) = control_rx.try_recv() {
            if let LoopAction::Stop {
                id,
                reply,
                flushed,
                quit,
            } = handle_control(
                ctrl,
                &shared,
                &hub,
                &log,
                &home,
                &mut cards,
                &mut queries,
                &mut guards,
            ) {
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
                // `process::exit` runs no destructors, so the capture child is stopped here.
                captures.shutdown(&log);
                std::process::exit(0);
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
            rescan(
                &spool,
                &shared,
                &hub,
                &log,
                &mut ingest,
                &mut guards,
                &mut cards,
                Some(&mut captures),
            );
            config_dirs = claude_config_dirs(&home);
        }

        let now = Instant::now();
        if now.duration_since(last_tick) >= TICK_EVERY {
            last_tick = now;
            tick_once(&shared, &hub, &log);
            guards.check(&shared, &hub, &log);
            captures.check(&guards.allowed_roots());
            config_dirs = claude_config_dirs(&home);
        }

        guards.service(&shared, &hub, &log);
        // ponytail: rebuilt every 25 ms; cache it on the guard if the set grows large.
        let capture_results = captures.service(&guards.allowed_roots(), &shared, &hub, &log);
        cards.on_capture(&capture_results);
        service_cards(
            &mut cards,
            &captures.owned_roots(),
            &config_dirs,
            &shared,
            &hub,
            &log,
        );
        service_queries(&mut queries, &log);
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
#[allow(clippy::too_many_arguments)]
fn rescan(
    spool: &Path,
    shared: &Arc<Mutex<Shared>>,
    hub: &Hub,
    log: &RotatingLog,
    ingest: &mut Ingestor,
    guards: &mut GuardLoop,
    cards: &mut Engine,
    captures: Option<&mut CaptureLoop>,
) {
    let mut repo_of = resolve_repo;
    let now = now_ms();
    let (msgs, health, upserts, health_changed, out, cards_enabled) = {
        let mut guard = shared.lock().unwrap();
        let s = &mut *guard;
        let out = ingest.ingest_once(spool, &mut s.state, &mut repo_of, &mut s.history, now);
        for gap in &out.gaps {
            s.gaps.push(*gap);
            s.state.record_gap(gap);
        }
        guards.rescanned(&out.config_locations, &s.state.session_roots());
        let mut msgs =
            Vec::with_capacity(out.changes.upserted.len() + out.changes.removed.len() + 1);
        for key in &out.changes.upserted {
            if let Some(agent) = s.state.get(key) {
                s.last_known.insert(key.clone(), agent.clone());
                msgs.push(ServerMsg::Status {
                    op: StatusOp::Upsert,
                    agent,
                });
            }
        }
        for key in &out.changes.removed {
            push_removal(s, &mut msgs, key);
        }
        s.counters = ingest.health.clone();
        let (health, health_changed) = s.take_health();
        if health_changed {
            msgs.push(ServerMsg::Health {
                health: health.clone(),
            });
        }
        let upserts = out.changes.upserted.len();
        let cards_enabled = s.settings.cards;
        (msgs, health, upserts, health_changed, out, cards_enabled)
    };
    for m in &msgs {
        hub.broadcast(m);
    }
    if cards_enabled {
        let flushes = cards.on_ingest(&out, &mut repo_of, now);
        if let Some(cap) = captures {
            for req in flushes {
                cap.flush(&req.root, now);
            }
        }
    }
    if out.history_errors > 0 {
        log.line(&format!(
            "history: {} lines not written",
            out.history_errors
        ));
    }
    if upserts > 0 || health_changed {
        log.line(&format!(
            "ingest: {upserts} agents updated, {} files pending",
            health.spool_pending
        ));
    }
}

fn service_cards(
    cards: &mut Engine,
    owned_roots: &std::collections::BTreeSet<String>,
    config_dirs: &[std::path::PathBuf],
    shared: &Arc<Mutex<Shared>>,
    hub: &Hub,
    log: &RotatingLog,
) {
    let ctx = {
        let s = shared.lock().unwrap();
        EngineCtx {
            cards: s.settings.cards,
            owned_roots: owned_roots.clone(),
            capture: s.capture.clone(),
            gaps: s.gaps.to_vec(),
            config_dirs: config_dirs.to_vec(),
        }
    };
    let built = cards.poll(now_ms(), &ctx);
    let panics = cards.take_worker_panics();
    if panics > 0 {
        log.line(&format!("cards: {panics} worker panics"));
    }
    if !built.is_empty() {
        let mut errs = 0u64;
        let mut appended = Vec::with_capacity(built.len());
        {
            let mut s = shared.lock().unwrap();
            for card in built {
                if s.cards.append(&card).is_err() {
                    errs += 1;
                } else {
                    appended.push(card);
                }
            }
        }
        if errs > 0 {
            log.line(&format!("cards: {errs} append errors"));
        }
        broadcast_appended_cards(appended, hub, log);
    }
}

fn broadcast_appended_cards(appended: Vec<rocky_proto::cards::Card>, hub: &Hub, log: &RotatingLog) {
    let mut skipped = 0u64;
    for card in appended {
        match rockyd::cards::detail::build_card_broadcast(card) {
            Some(msg) => hub.broadcast(&msg),
            None => skipped += 1,
        }
    }
    if skipped > 0 {
        log.line(&format!("cards: {skipped} broadcasts too large"));
    }
}

fn service_queries(queries: &mut CardQueryLoop, log: &RotatingLog) {
    queries.service();
    let panics = queries.take_worker_panics();
    if panics > 0 {
        log.line(&format!("cards: {panics} query worker panics"));
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

/// Applies one `set` control request: validate, save, sync the markers and the
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
                    if (next.tool_text != current.tool_text || next.cards != current.cards)
                        && let Err(e) = settings::sync_markers(home, &next)
                    {
                        log.line(&format!("marker sync failed: {e}"));
                    }
                    if next.tool_text != current.tool_text {
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

enum LoopAction {
    Continue,
    Stop {
        id: u64,
        reply: SyncSender<ServerMsg>,
        flushed: mpsc::Receiver<()>,
        quit: bool,
    },
}

#[allow(clippy::too_many_arguments)]
fn handle_control(
    ctrl: Control,
    shared: &Arc<Mutex<Shared>>,
    hub: &Hub,
    log: &RotatingLog,
    home: &Path,
    cards: &mut Engine,
    queries: &mut CardQueryLoop,
    guards: &mut GuardLoop,
) -> LoopAction {
    match ctrl {
        Control::Stop {
            id,
            reply,
            flushed,
            quit,
        } => LoopAction::Stop {
            id,
            reply,
            flushed,
            quit,
        },
        Control::Set {
            id,
            name,
            value,
            reply,
        } => {
            let msg = handle_set(id, &name, &value, shared, hub, log, home);
            let cards_on = shared.lock().unwrap().settings.cards;
            cards.set_enabled(cards_on);
            let _ = reply.send(msg);
            LoopAction::Continue
        }
        Control::Timeline { id, key, reply } => {
            let entries = shared.lock().unwrap().state.timeline(&key);
            let _ = reply.send(ServerMsg::Timeline { id, key, entries });
            LoopAction::Continue
        }
        Control::Setup { id, action, reply } => {
            guards.setup_request(id, action, reply, shared, hub, log);
            LoopAction::Continue
        }
        Control::RepoDecision {
            id,
            root,
            allow,
            reply,
        } => {
            guards.repo_request(id, root, allow, reply);
            LoopAction::Continue
        }
        Control::Cards {
            id,
            query,
            before,
            limit,
            reply,
        } => {
            queries.cards(id, query, before, limit, reply);
            LoopAction::Continue
        }
        Control::CardDetail { id, card_id, reply } => {
            queries.card_detail(id, card_id, reply);
            LoopAction::Continue
        }
        Control::BlockDiff {
            id,
            card_id,
            seq,
            page,
            reply,
        } => {
            queries.block_diff(id, card_id, seq, page, reply);
            LoopAction::Continue
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rocky_proto::cards::{
        Block, BlockSymbol, BlockVia, CARD_VERSION, Card, CardStatus, Coverage, CoverageState,
        Importance, SymbolKind,
    };
    use rockyd::cards::store::ObjectRead;

    fn make_test_shared(home: &Path) -> Arc<Mutex<Shared>> {
        Arc::new(Mutex::new(Shared {
            state: StatusState::new(),
            last_known: HashMap::new(),
            counters: Health::default(),
            health: Health::default(),
            settings: Settings::default(),
            settings_unreadable: false,
            gaps: Gaps::new(),
            history: History::open(&history_dir(home), HISTORY_CAP_BYTES, false),
            setup: SetupHealth::default(),
            repo_pending: Vec::new(),
            capture: Vec::new(),
            cards: CardStore::new(home.to_path_buf()),
        }))
    }

    fn make_test_card(home: &Path, card_id: &str) -> Card {
        Card {
            v: CARD_VERSION,
            card_id: card_id.to_string(),
            rev: 1,
            repo_id: "r1".to_string(),
            root: home.to_string_lossy().into_owned(),
            main_root: None,
            branch: Some("main".to_string()),
            session_id: "s-seed".to_string(),
            agent_id: String::new(),
            agent_type: "claude".to_string(),
            parent_card_id: None,
            started_ms: 1_000,
            ended_ms: Some(2_000),
            status: CardStatus::Done,
            prompt: "fix".to_string(),
            prompt_truncated: false,
            importance: Importance::Medium,
            blocks: vec![Block {
                seq: 1,
                path: "src/lib.rs".to_string(),
                symbol: Some(BlockSymbol {
                    kind: SymbolKind::Function,
                    name: "f".to_string(),
                    container: None,
                    exported: true,
                    nth: 0,
                }),
                labels: Vec::new(),
                importance: Importance::Medium,
                via: BlockVia::Edit,
                tool_use_ids: vec!["tu-1".to_string()],
                bash: None,
                before: Some("1".repeat(64)),
                after: Some("2".repeat(64)),
                recorded: true,
                line: Some(1),
                added: Some(1),
                removed: Some(1),
                quote: None,
            }],
            flow: Vec::new(),
            outside_count: 0,
            coverage: Coverage {
                state: CoverageState::Full,
                reasons: Vec::new(),
            },
        }
    }

    #[test]
    fn stalled_cards_query_reader_does_not_stall_hook_ingest() {
        struct UnblockOnPanic(mpsc::Sender<()>);
        impl Drop for UnblockOnPanic {
            fn drop(&mut self) {
                if std::thread::panicking() {
                    for _ in 0..8 {
                        let _ = self.0.send(());
                    }
                }
            }
        }

        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().to_path_buf();
        let spool = spool_dir(&home);
        std::fs::create_dir_all(&spool).unwrap();
        let log = Arc::new(RotatingLog::new(&log_path(&home)));
        let shared = make_test_shared(&home);
        let hub = Arc::new(Hub::new());

        let card = make_test_card(&home, "card-stalled");
        shared.lock().unwrap().cards.append(&card).unwrap();

        let (entered_tx, entered_rx) = mpsc::channel::<()>();
        let entered_tx = Mutex::new(entered_tx);
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let release_rx = Mutex::new(release_rx);
        let (ingest_done_tx, ingest_done_rx) = mpsc::channel::<()>();
        let (detail_tx, detail_rx) = mpsc::sync_channel::<ServerMsg>(1);

        let shared_bg = Arc::clone(&shared);
        let hub_bg = Arc::clone(&hub);
        let log_bg = Arc::clone(&log);
        let home_bg = home.clone();
        let spool_bg = spool.clone();
        let release_worker = release_tx.clone();

        let worker = thread::spawn(move || {
            let mut ingest = Ingestor::new();
            let mut guards = GuardLoop::new(home_bg.clone(), &log_bg, now_ms());
            let mut cards = Engine::new(home_bg.clone(), 1);
            let mut queries = CardQueryLoop::new_with_object_reader(
                home_bg.clone(),
                cards.worker_count(),
                Arc::new(move |sha: &str| {
                    let _ = entered_tx.lock().unwrap().send(());
                    let _ = release_rx.lock().unwrap().recv();
                    if sha.starts_with('1') {
                        ObjectRead::Text("fn f() {\n    1\n}\n".to_string())
                    } else {
                        ObjectRead::Text("fn f() {\n    2\n}\n".to_string())
                    }
                }),
            );
            let _unblock_worker = UnblockOnPanic(release_worker);
            let _ = handle_control(
                Control::CardDetail {
                    id: 99,
                    card_id: "card-stalled".to_string(),
                    reply: detail_tx,
                },
                &shared_bg,
                &hub_bg,
                &log_bg,
                &home_bg,
                &mut cards,
                &mut queries,
                &mut guards,
            );
            entered_rx
                .recv_timeout(Duration::from_secs(2))
                .expect("query reader should have started");
            std::fs::write(
                spool_bg.join("0000000001000-1-0.json"),
                r#"{"v":1,"harness":"claude-code","recv_ms":1000,"kind":"event","event":{"hook_event_name":"SessionStart","session_id":"live-after-query","cwd":"C:\\repo"}}"#,
            )
            .unwrap();
            rescan(
                &spool_bg,
                &shared_bg,
                &hub_bg,
                &log_bg,
                &mut ingest,
                &mut guards,
                &mut cards,
                None,
            );
            let _ = ingest_done_tx.send(());
            queries
        });

        let ingested = ingest_done_rx.recv_timeout(Duration::from_millis(800));
        if ingested.is_err() {
            let _ = release_tx.send(());
            let _ = release_tx.send(());
            let _ = worker.join();
            panic!("hook ingest stalled behind blocked card query reader");
        }

        let mut queries = worker.join().unwrap();
        let _unblock_test = UnblockOnPanic(release_tx.clone());
        assert!(
            shared
                .lock()
                .unwrap()
                .state
                .agents()
                .iter()
                .any(|a| a.key.session_id == "live-after-query"),
            "hook event should be ingested while query reader is stalled"
        );
        queries.service();
        assert!(
            detail_rx.try_recv().is_err(),
            "stalled query should not have replied yet"
        );

        let _ = release_tx.send(());
        let _ = release_tx.send(());
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        let reply = loop {
            queries.service();
            if let Ok(msg) = detail_rx.try_recv() {
                break msg;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "timed out waiting for unblocked card detail reply"
            );
            thread::sleep(Duration::from_millis(5));
        };
        assert!(matches!(reply, ServerMsg::CardDetail { id: 99, .. }));
    }

    #[test]
    fn service_cards_skips_oversized_broadcast_and_logs_count() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().to_path_buf();
        let log = RotatingLog::new(&log_path(&home));
        let hub = Hub::new();
        let mut card = make_test_card(&home, "card-oversized");
        card.branch = Some("b".repeat(80_000));

        broadcast_appended_cards(vec![card], &hub, &log);

        let contents = std::fs::read_to_string(log_path(&home)).unwrap();
        assert!(
            contents.contains("cards: 1 broadcasts too large"),
            "expected broadcast skip count in log, got: {contents}"
        );
    }

    #[test]
    fn cards_query_worker_panic_is_contained_and_daemon_keeps_serving() {
        if std::env::var_os("ROCKY_QUERY_PANIC_HOOK_TEST").is_some() {
            let home = std::path::PathBuf::from(
                std::env::var_os("ROCKY_QUERY_PANIC_HOME").expect("home dir env"),
            );
            let spool = spool_dir(&home);
            std::fs::create_dir_all(&spool).unwrap();
            let log = Arc::new(RotatingLog::new(&log_path(&home)));
            rockyd::log::install_panic_hook(Arc::clone(&log));

            let shared = make_test_shared(&home);
            let hub = Arc::new(Hub::new());
            let mut card_panic = make_test_card(&home, "card-panic");
            card_panic.blocks[0].before = Some("a".repeat(64));
            card_panic.blocks[0].after = Some("b".repeat(64));
            let card_ok = make_test_card(&home, "card-ok");
            {
                let mut s = shared.lock().unwrap();
                s.cards.append(&card_panic).unwrap();
                s.cards.append(&card_ok).unwrap();
            }

            let mut ingest = Ingestor::new();
            let mut guards = GuardLoop::new(home.clone(), &log, now_ms());
            let mut cards = Engine::new(home.clone(), 2);
            assert_eq!(cards.worker_count(), 2);
            let observed_thread = Arc::new(Mutex::new(None::<String>));
            let observed_thread_ref = Arc::clone(&observed_thread);
            let mut queries = CardQueryLoop::new_with_object_reader(
                home.clone(),
                cards.worker_count(),
                Arc::new(move |sha: &str| {
                    *observed_thread_ref.lock().unwrap() =
                        std::thread::current().name().map(str::to_owned);
                    if sha.starts_with('a') {
                        panic!("SECRET_QUERY_LEAK_TOKEN");
                    }
                    if sha.starts_with('1') {
                        ObjectRead::Text("fn f() {\n    1\n}\n".to_string())
                    } else {
                        ObjectRead::Text("fn f() {\n    2\n}\n".to_string())
                    }
                }),
            );

            let (tx1, rx1) = mpsc::sync_channel(1);
            let (tx2, rx2) = mpsc::sync_channel(1);
            let _ = handle_control(
                Control::CardDetail {
                    id: 10,
                    card_id: "card-panic".to_string(),
                    reply: tx1,
                },
                &shared,
                &hub,
                &log,
                &home,
                &mut cards,
                &mut queries,
                &mut guards,
            );
            let _ = handle_control(
                Control::CardDetail {
                    id: 11,
                    card_id: "card-ok".to_string(),
                    reply: tx2,
                },
                &shared,
                &hub,
                &log,
                &home,
                &mut cards,
                &mut queries,
                &mut guards,
            );

            let mut reply1 = None;
            let mut reply2 = None;
            let deadline = Instant::now() + Duration::from_secs(3);
            while Instant::now() < deadline && (reply1.is_none() || reply2.is_none()) {
                service_queries(&mut queries, &log);
                if reply1.is_none()
                    && let Ok(msg) = rx1.try_recv()
                {
                    reply1 = Some(msg);
                }
                if reply2.is_none()
                    && let Ok(msg) = rx2.try_recv()
                {
                    reply2 = Some(msg);
                }
                thread::sleep(Duration::from_millis(5));
            }
            assert_eq!(queries.worker_panics(), 0);
            assert_eq!(
                reply1,
                Some(ServerMsg::Error {
                    code: "internal".to_string(),
                })
            );
            assert!(matches!(reply2, Some(ServerMsg::CardDetail { id: 11, .. })));

            let (tx3, rx3) = mpsc::sync_channel(1);
            let _ = handle_control(
                Control::Cards {
                    id: 12,
                    query: None,
                    before: None,
                    limit: 20,
                    reply: tx3,
                },
                &shared,
                &hub,
                &log,
                &home,
                &mut cards,
                &mut queries,
                &mut guards,
            );
            let deadline = Instant::now() + Duration::from_secs(3);
            let reply3 = loop {
                service_queries(&mut queries, &log);
                if let Ok(msg) = rx3.try_recv() {
                    break msg;
                }
                assert!(Instant::now() < deadline, "timed out waiting for cards");
                thread::sleep(Duration::from_millis(5));
            };
            let ServerMsg::Cards { id: 12, items, .. } = reply3 else {
                panic!("expected ServerMsg::Cards after query panic");
            };
            assert_eq!(items.len(), 2);

            std::fs::write(
                spool.join("0000000001000-1-0.json"),
                r#"{"v":1,"harness":"claude-code","recv_ms":1000,"kind":"event","event":{"hook_event_name":"SessionStart","session_id":"live-after-query-panic","cwd":"C:\\repo"}}"#,
            )
            .unwrap();
            rescan(
                &spool,
                &shared,
                &hub,
                &log,
                &mut ingest,
                &mut guards,
                &mut cards,
                None,
            );
            assert!(
                shared
                    .lock()
                    .unwrap()
                    .state
                    .agents()
                    .iter()
                    .any(|a| a.key.session_id == "live-after-query-panic"),
                "hook event should ingest after query worker panic"
            );
            assert_eq!(
                observed_thread.lock().unwrap().as_deref(),
                Some("rocky-card-worker-2")
            );
            return;
        }

        let tmp = tempfile::tempdir().unwrap();
        let exe = std::env::current_exe().expect("current test exe");
        let out = std::process::Command::new(&exe)
            .args([
                "--exact",
                "tests::cards_query_worker_panic_is_contained_and_daemon_keeps_serving",
                "--nocapture",
            ])
            .env("ROCKY_QUERY_PANIC_HOOK_TEST", "1")
            .env("ROCKY_QUERY_PANIC_HOME", tmp.path())
            .output()
            .expect("run query panic child");
        assert!(
            out.status.success(),
            "query panic child aborted or failed: status={:?}, stdout={}, stderr={}",
            out.status,
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        let log_text = std::fs::read_to_string(log_path(tmp.path())).expect("read rockyd.log");
        assert!(
            log_text.contains("cards: 1 worker panic"),
            "expected panic-hook count line, got: {log_text:?}"
        );
        assert!(
            log_text.contains("cards: 1 query worker panics"),
            "expected service_queries count line, got: {log_text:?}"
        );
        assert!(!log_text.contains("SECRET_QUERY_LEAK_TOKEN"));
        assert!(!log_text.contains("panic, aborting"));
        assert!(!String::from_utf8_lossy(&out.stderr).contains("SECRET_QUERY_LEAK_TOKEN"));
    }
}
