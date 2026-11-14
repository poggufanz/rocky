//! Read-only Listening store reader and worker-backed change card engine.

pub mod attribute;
pub mod detail;
pub mod query;
pub mod storage;
pub mod store;
pub mod transcript;
pub mod windows;

use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};
use std::fs;
use std::panic::{self, AssertUnwindSafe};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread::{self, JoinHandle};

use rocky_proto::cards::Card;
use rocky_proto::hook::HookEvent;
use rocky_proto::paths::{canonical_path, listening_store_dir, repo_id};
use rocky_proto::pipe::{AgentKey, CaptureHealth, CaptureState, Gap, RepoInfo};
use sha2::{Digest, Sha256};

use crate::capture::CaptureResult;
use crate::cards::attribute::{BuildInput, build_card, collect_edit_windows_for_turn};
use crate::cards::store::{ObjectRead, StoreReader, Version, read_object};
use crate::cards::transcript::{TranscriptRead, read_quotes, validate_transcript_path};
use crate::cards::windows::{PromptIn, ToolKind, ToolWindow, Tracker, TrackerSignal, Turn};
use crate::spool::IngestOutput;

const CAPTURE_WAIT_MS: u64 = 4_000;
const WINDOW_CAP_MS: u64 = 30_000;
const MAX_CACHED_VERSIONS: usize = 20_000;
const MAX_CACHED_RESULTS_PER_ROOT: usize = 256;

/// Thread-name prefix shared with the daemon panic hook to contain card worker panics.
pub const CARD_WORKER_THREAD_PREFIX: &str = "rocky-card-worker-";

/// Request from [`Engine::on_ingest`] asking the daemon loop to flush capture for one root.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FlushRequest {
    pub root: String,
    pub post_ms: u64,
}

/// Snapshot of daemon settings and capture state consumed by [`Engine::poll`].
#[derive(Debug, Clone, Default)]
pub struct EngineCtx {
    pub cards: bool,
    pub owned_roots: BTreeSet<String>,
    pub capture: Vec<CaptureHealth>,
    pub gaps: Vec<Gap>,
    pub config_dirs: Vec<PathBuf>,
}

type TurnId = (AgentKey, u64);
type BuildHook = Arc<dyn Fn(&BuildInput) + Send + Sync>;

struct PendingBuild {
    turn: Turn,
    deadline_ms: u64,
    awaited_roots: HashMap<String, u64>,
}

struct TurnBuildState {
    emitted_rev: u32,
    in_flight: bool,
    dirty: bool,
    latest_turn: Turn,
}

#[derive(Default)]
struct VersionsRead {
    versions: Vec<Version>,
    store_error: bool,
    tail_cut: bool,
}

struct CachedStore {
    reader: StoreReader,
    versions: Vec<Version>,
    tail_cut_through_ms: Option<u64>,
}

impl CachedStore {
    fn new(store_dir: PathBuf) -> Self {
        Self {
            reader: StoreReader::new(store_dir),
            versions: Vec::new(),
            tail_cut_through_ms: None,
        }
    }

    fn versions_in_range(
        &mut self,
        from_ms: u64,
        through_ms: u64,
        retain_from_ms: u64,
    ) -> VersionsRead {
        let reader_tail_cut = match self.reader.versions_since(0) {
            Ok((newly_read, reader_tail_cut)) => {
                if reader_tail_cut {
                    let cut_frontier = newly_read.iter().map(|v| v.ts).max().unwrap_or(from_ms);
                    self.tail_cut_through_ms = Some(
                        self.tail_cut_through_ms
                            .map_or(cut_frontier, |prev| prev.max(cut_frontier)),
                    );
                }
                self.versions.extend(newly_read);
                reader_tail_cut
            }
            Err(_) => {
                return VersionsRead {
                    versions: Vec::new(),
                    store_error: true,
                    tail_cut: false,
                };
            }
        };
        if retain_from_ms > 0 {
            self.versions.retain(|v| v.ts >= retain_from_ms);
        }
        if self.versions.len() > MAX_CACHED_VERSIONS {
            let drain = self.versions.len() - MAX_CACHED_VERSIONS;
            if let Some(evicted_max) = self.versions[..drain].iter().map(|v| v.ts).max() {
                self.tail_cut_through_ms = Some(
                    self.tail_cut_through_ms
                        .map_or(evicted_max, |prev| prev.max(evicted_max)),
                );
            }
            self.versions.drain(..drain);
        }
        let tail_cut =
            reader_tail_cut || self.tail_cut_through_ms.is_some_and(|cut| from_ms <= cut);
        let versions = self
            .versions
            .iter()
            .filter(|v| v.ts >= from_ms && v.ts <= through_ms)
            .cloned()
            .collect();
        VersionsRead {
            versions,
            store_error: false,
            tail_cut,
        }
    }
}

struct BuildJob {
    turn_id: TurnId,
    turn: Turn,
    card_id: String,
    rev: u32,
    session_root: Option<String>,
    recorded: bool,
    store_dir: Option<PathBuf>,
    results: Vec<CaptureResult>,
    other_bash: Vec<ToolWindow>,
    other_edits: Vec<(String, u64, u64)>,
    gaps: Vec<(u64, u64)>,
    capture_state: Option<CaptureState>,
    home_dir: PathBuf,
    config_dirs: Vec<PathBuf>,
    parent_card_id: Option<String>,
    versions_through_ms: u64,
    retain_versions_from_ms: u64,
}

struct BuildDone {
    turn_id: TurnId,
    card: Option<Card>,
    panicked: bool,
}

struct WorkerPool {
    workers: usize,
    job_tx: Option<mpsc::Sender<BuildJob>>,
    job_rx: Option<Arc<Mutex<mpsc::Receiver<BuildJob>>>>,
    res_tx: Option<mpsc::Sender<BuildDone>>,
    res_rx: mpsc::Receiver<BuildDone>,
    stores: Arc<Mutex<HashMap<PathBuf, Arc<Mutex<CachedStore>>>>>,
    hook: Option<BuildHook>,
    handles: Vec<JoinHandle<()>>,
    panics: Arc<AtomicU64>,
}

impl WorkerPool {
    fn new(workers: usize, hook: Option<BuildHook>) -> Self {
        let count = workers.clamp(1, 4);
        let (job_tx, job_rx) = mpsc::channel::<BuildJob>();
        let (res_tx, res_rx) = mpsc::channel::<BuildDone>();
        Self {
            workers: count,
            job_tx: Some(job_tx),
            job_rx: Some(Arc::new(Mutex::new(job_rx))),
            res_tx: Some(res_tx),
            res_rx,
            stores: Arc::new(Mutex::new(HashMap::new())),
            hook,
            handles: Vec::new(),
            panics: Arc::new(AtomicU64::new(0)),
        }
    }

    fn ensure_started(&mut self) {
        let (Some(job_rx), Some(res_tx)) = (self.job_rx.take(), self.res_tx.take()) else {
            return;
        };
        for idx in 0..self.workers {
            let rx = Arc::clone(&job_rx);
            let tx = res_tx.clone();
            let stores_ref = Arc::clone(&self.stores);
            let panics_ref = Arc::clone(&self.panics);
            let hook_ref = self.hook.clone();
            let name = format!("{CARD_WORKER_THREAD_PREFIX}{idx}");
            let handle = thread::Builder::new()
                .name(name)
                .spawn(move || {
                    worker_loop(rx, tx, stores_ref, panics_ref, hook_ref);
                })
                .expect("spawn card worker thread");
            self.handles.push(handle);
        }
    }

    fn submit(&mut self, job: BuildJob) {
        self.ensure_started();
        if let Some(tx) = &self.job_tx {
            let _ = tx.send(job);
        }
    }

    fn try_recv(&self) -> Option<BuildDone> {
        self.res_rx.try_recv().ok()
    }
}

impl Drop for WorkerPool {
    fn drop(&mut self) {
        self.job_tx.take();
        self.res_tx.take();
        for handle in self.handles.drain(..) {
            let _ = handle.join();
        }
    }
}

/// Asynchronous worker-backed change card engine fed by spool ingest and capture results.
pub struct Engine {
    home: PathBuf,
    enabled: bool,
    removed: bool,
    tracker: Tracker,
    repo_cache: HashMap<String, RepoInfo>,
    parent_card_ids: HashMap<TurnId, String>,
    bash_by_turn: HashMap<TurnId, Vec<ToolWindow>>,
    awaited_roots: HashMap<TurnId, HashMap<String, u64>>,
    pending_builds: HashMap<TurnId, PendingBuild>,
    turn_states: HashMap<TurnId, TurnBuildState>,
    captures_by_root: HashMap<String, Vec<CaptureResult>>,
    latest_valid_capture: HashMap<String, u64>,
    pool: WorkerPool,
}

impl Engine {
    /// Creates an engine using `home` (`~/.rocky`) and `workers` worker threads (clamped to `1..=4`).
    pub fn new(home: PathBuf, workers: usize) -> Self {
        Self::with_optional_hook(home, workers, None)
    }

    /// Creates an engine with a worker build hook used by tests to inspect inputs or inject panics.
    #[doc(hidden)]
    pub fn new_with_build_hook(home: PathBuf, workers: usize, hook: BuildHook) -> Self {
        Self::with_optional_hook(home, workers, Some(hook))
    }

    fn with_optional_hook(home: PathBuf, workers: usize, hook: Option<BuildHook>) -> Self {
        Self {
            home,
            enabled: true,
            removed: false,
            tracker: Tracker::new(),
            repo_cache: HashMap::new(),
            parent_card_ids: HashMap::new(),
            bash_by_turn: HashMap::new(),
            awaited_roots: HashMap::new(),
            pending_builds: HashMap::new(),
            turn_states: HashMap::new(),
            captures_by_root: HashMap::new(),
            latest_valid_capture: HashMap::new(),
            pool: WorkerPool::new(workers, hook),
        }
    }

    /// Latches card tracking and building off permanently once Remove Rocky starts.
    pub fn set_removed(&mut self) {
        self.removed = true;
        self.enabled = false;
        self.reset_tracking();
        self.captures_by_root.clear();
        self.latest_valid_capture.clear();
    }

    /// Updates whether change card tracking and building are active.
    pub fn set_enabled(&mut self, enabled: bool) {
        if self.removed {
            self.enabled = false;
            return;
        }
        if !enabled {
            self.reset_tracking();
        }
        self.enabled = enabled;
    }

    /// Returns the number of build worker threads configured for this engine.
    pub fn worker_count(&self) -> usize {
        self.pool.workers
    }

    /// Returns the number of currently uncollected worker panics.
    pub fn worker_panics(&self) -> u64 {
        self.pool.panics.load(Ordering::Relaxed)
    }

    /// Atomically takes and resets the accumulated worker panic count.
    pub fn take_worker_panics(&mut self) -> u64 {
        self.pool.panics.swap(0, Ordering::Relaxed)
    }

    /// Processes newly ingested spool events and prompts, returning capture flush requests.
    pub fn on_ingest(
        &mut self,
        out: &IngestOutput,
        repo_of: &mut dyn FnMut(&str) -> RepoInfo,
        now_ms: u64,
    ) -> Vec<FlushRequest> {
        if self.removed || !self.enabled {
            return Vec::new();
        }

        let mut flushes = Vec::new();
        let mut prompts: VecDeque<PromptIn> = out.prompts.iter().cloned().collect();
        let mut touched_turns: HashSet<TurnId> = HashSet::new();

        for (ev, recv_ms) in &out.events {
            let repo = self.resolve_session_repo(ev, repo_of);
            let key = AgentKey {
                session_id: ev.session_id.clone(),
                agent_id: ev.agent_id.clone().unwrap_or_default(),
            };

            let signals = self.tracker.on_event(ev, *recv_ms, &repo);
            if ev.hook_event_name == "SubagentStart" {
                self.record_parent_for_subagent(&key);
            }
            if ev.hook_event_name == "UserPromptSubmit"
                && let Some(pos) = prompts
                    .iter()
                    .position(|p| p.session_id == ev.session_id && p.recv_ms == *recv_ms)
                && let Some(prompt) = prompts.remove(pos)
            {
                self.tracker.on_prompt(prompt);
            }

            let is_post_tool =
                ev.hook_event_name == "PostToolUse" || ev.hook_event_name == "PostToolUseFailure";
            let mut awaited_turns: HashSet<TurnId> = HashSet::new();
            let mut closed_turns: Vec<TurnId> = Vec::new();
            let mut late_turns: Vec<TurnId> = Vec::new();

            for sig in signals {
                match sig {
                    TrackerSignal::EditDone {
                        agent,
                        started_ms,
                        root,
                        post_ms,
                    } => {
                        flushes.push(FlushRequest {
                            root: root.clone(),
                            post_ms,
                        });
                        let tid = (agent, started_ms);
                        self.record_awaited_root(&tid, &root, post_ms);
                        awaited_turns.insert(tid.clone());
                        touched_turns.insert(tid);
                    }
                    TrackerSignal::TurnClosed(closed_key) => {
                        if let Some(turn) = self.tracker.closed_turn(&closed_key).cloned() {
                            let tid = (closed_key, turn.started_ms);
                            self.record_completed_bashes_for_turn(&tid, &turn);
                            closed_turns.push(tid.clone());
                            touched_turns.insert(tid);
                        }
                    }
                    TrackerSignal::Late { agent, started_ms } => {
                        let tid = (agent, started_ms);
                        if is_post_tool && self.record_completed_bash_at(&tid, *recv_ms) {
                            awaited_turns.insert(tid.clone());
                        }
                        late_turns.push(tid.clone());
                        touched_turns.insert(tid);
                    }
                }
            }

            if let Some(open_turn) = self.tracker.open_turn(&key) {
                let tid = (key.clone(), open_turn.started_ms);
                if is_post_tool {
                    self.record_completed_bash_at(&tid, *recv_ms);
                }
                touched_turns.insert(tid);
            }

            for tid in closed_turns {
                self.enqueue_closed_turn(&tid, now_ms);
            }
            for tid in late_turns {
                let awaited_this_event = awaited_turns.contains(&tid);
                self.enqueue_late_turn(&tid, now_ms, awaited_this_event);
            }
        }

        for prompt in prompts {
            let key = AgentKey {
                session_id: prompt.session_id.clone(),
                agent_id: String::new(),
            };
            self.tracker.on_prompt(prompt);
            if let Some(turn) = self.tracker.open_turn(&key) {
                touched_turns.insert((key, turn.started_ms));
            }
        }

        for tid in touched_turns {
            if let Some(turn) = self.tracker.turn(&tid.0, tid.1).cloned() {
                let bashes: Vec<ToolWindow> = turn
                    .windows
                    .iter()
                    .filter(|w| w.kind == ToolKind::Bash)
                    .cloned()
                    .collect();
                if bashes.is_empty() {
                    self.bash_by_turn.remove(&tid);
                } else {
                    self.bash_by_turn.insert(tid.clone(), bashes);
                }
                if let Some(pending) = self.pending_builds.get_mut(&tid) {
                    pending.turn = turn.clone();
                }
                if let Some(state) = self.turn_states.get_mut(&tid) {
                    state.latest_turn = turn;
                }
            }
        }

        flushes
    }

    /// Records new reconcile results produced by the capture child.
    pub fn on_capture(&mut self, results: &[CaptureResult]) {
        if self.removed {
            return;
        }
        for res in results {
            let canon = canonical_path(&res.root, cfg!(windows));
            if res.started_ms > 0 {
                self.latest_valid_capture
                    .entry(canon.clone())
                    .and_modify(|prev| *prev = (*prev).max(res.started_ms))
                    .or_insert(res.started_ms);
            }
            let list = self.captures_by_root.entry(canon).or_default();
            list.push(res.clone());
            if list.len() > MAX_CACHED_RESULTS_PER_ROOT {
                let drop_count = list.len() - MAX_CACHED_RESULTS_PER_ROOT;
                list.drain(..drop_count);
            }
        }
    }

    /// Collects completed cards, dispatches ready builds to workers, and expires old turns.
    pub fn poll(&mut self, now_ms: u64, ctx: &EngineCtx) -> Vec<Card> {
        let mut ready_cards = Vec::new();
        while let Some(done) = self.pool.try_recv() {
            if let Some(state) = self.turn_states.get_mut(&done.turn_id) {
                state.in_flight = false;
                if !self.removed
                    && ctx.cards
                    && !done.panicked
                    && let Some(card) = done.card
                {
                    state.emitted_rev = card.rev;
                    ready_cards.push(card);
                }
            }
        }

        if self.removed {
            self.reset_tracking();
            return Vec::new();
        }
        if !ctx.cards {
            self.set_enabled(false);
            return Vec::new();
        }
        self.enabled = true;

        let owned_canon: BTreeSet<String> = ctx
            .owned_roots
            .iter()
            .map(|r| canonical_path(r, cfg!(windows)))
            .collect();

        let ready_ids: Vec<TurnId> = self
            .pending_builds
            .iter()
            .filter_map(|(tid, pending)| {
                let is_in_flight = self.turn_states.get(tid).is_some_and(|s| s.in_flight);
                if is_in_flight {
                    return None;
                }
                if self.is_pending_ready(pending, &owned_canon, now_ms) {
                    Some(tid.clone())
                } else {
                    None
                }
            })
            .collect();

        let min_retained_started = self.min_active_started_ms();

        for tid in ready_ids {
            if let Some(pending) = self.pending_builds.remove(&tid) {
                self.dispatch_turn(&tid, pending.turn, ctx, &owned_canon, min_retained_started);
            }
        }

        let dirty_ids: Vec<TurnId> = self
            .turn_states
            .iter()
            .filter(|&(tid, state)| {
                !state.in_flight && state.dirty && !self.pending_builds.contains_key(tid)
            })
            .map(|(tid, _)| tid.clone())
            .collect();

        for tid in dirty_ids {
            if let Some(turn) = self.turn_states.get(&tid).map(|s| s.latest_turn.clone()) {
                self.dispatch_turn(&tid, turn, ctx, &owned_canon, min_retained_started);
            }
        }

        self.expire_old_state(now_ms);
        ready_cards
    }

    fn reset_tracking(&mut self) {
        self.tracker = Tracker::new();
        self.repo_cache.clear();
        self.parent_card_ids.clear();
        self.bash_by_turn.clear();
        self.awaited_roots.clear();
        self.pending_builds.clear();
        for state in self.turn_states.values_mut() {
            state.dirty = false;
        }
        self.turn_states.retain(|_, s| s.in_flight);
    }

    fn resolve_session_repo(
        &mut self,
        ev: &HookEvent,
        repo_of: &mut dyn FnMut(&str) -> RepoInfo,
    ) -> RepoInfo {
        let cwd = ev.cwd.as_deref().map(str::trim).filter(|s| !s.is_empty());
        let needs_update = match (
            ev.hook_event_name.as_str(),
            self.repo_cache.get(&ev.session_id),
        ) {
            ("SessionStart", _) => cwd.is_some(),
            (_, None) => cwd.is_some(),
            (_, Some(cached)) => cached.root.is_none() && cwd.is_some(),
        };
        if needs_update && let Some(path) = cwd {
            let info = repo_of(path);
            self.repo_cache.insert(ev.session_id.clone(), info.clone());
            return info;
        }
        self.repo_cache
            .get(&ev.session_id)
            .cloned()
            .unwrap_or_else(empty_repo_info)
    }

    fn record_awaited_root(&mut self, tid: &TurnId, root: &str, post_ms: u64) {
        let trimmed = root.trim();
        if trimmed.is_empty() {
            return;
        }
        let canon = canonical_path(trimmed, cfg!(windows));
        let entry = self.awaited_roots.entry(tid.clone()).or_default();
        entry
            .entry(canon)
            .and_modify(|prev| *prev = (*prev).max(post_ms))
            .or_insert(post_ms);
    }

    fn record_completed_bashes_for_turn(&mut self, tid: &TurnId, turn: &Turn) {
        let Some(root) = turn
            .repo
            .root
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        else {
            return;
        };
        for win in &turn.windows {
            if win.kind == ToolKind::Bash
                && let Some(post_ms) = win.post_ms
            {
                self.record_awaited_root(tid, root, post_ms);
            }
        }
    }

    fn record_completed_bash_at(&mut self, tid: &TurnId, post_ms: u64) -> bool {
        let Some(turn) = self.tracker.turn(&tid.0, tid.1) else {
            return false;
        };
        let Some(root) = turn
            .repo
            .root
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToOwned::to_owned)
        else {
            return false;
        };
        let has_bash = turn
            .windows
            .iter()
            .any(|w| w.kind == ToolKind::Bash && w.post_ms == Some(post_ms));
        if has_bash {
            self.record_awaited_root(tid, &root, post_ms);
            true
        } else {
            false
        }
    }

    fn record_parent_for_subagent(&mut self, sub_key: &AgentKey) {
        if sub_key.agent_id.is_empty() {
            return;
        }
        let Some(sub_turn) = self.tracker.open_turn(sub_key) else {
            return;
        };
        let tid = (sub_key.clone(), sub_turn.started_ms);
        if self.parent_card_ids.contains_key(&tid) {
            return;
        }
        let main_key = AgentKey {
            session_id: sub_key.session_id.clone(),
            agent_id: String::new(),
        };
        if let Some(main_turn) = self.tracker.parent_turn_for(&main_key, sub_turn.started_ms) {
            let parent_cid = card_id(&sub_key.session_id, "", main_turn.started_ms);
            self.parent_card_ids.insert(tid, parent_cid);
        }
    }

    fn enqueue_closed_turn(&mut self, tid: &TurnId, now_ms: u64) {
        let Some(turn) = self.tracker.closed_turn_at(&tid.0, tid.1).cloned() else {
            return;
        };
        self.record_completed_bashes_for_turn(tid, &turn);
        let awaited = self.awaited_roots.get(tid).cloned().unwrap_or_default();
        self.pending_builds.insert(
            tid.clone(),
            PendingBuild {
                turn,
                deadline_ms: now_ms.saturating_add(CAPTURE_WAIT_MS),
                awaited_roots: awaited,
            },
        );
    }

    fn enqueue_late_turn(&mut self, tid: &TurnId, now_ms: u64, awaited_this_event: bool) {
        let Some(turn) = self.tracker.closed_turn_at(&tid.0, tid.1).cloned() else {
            return;
        };
        if awaited_this_event {
            self.record_completed_bashes_for_turn(tid, &turn);
        }
        let awaited = self.awaited_roots.get(tid).cloned().unwrap_or_default();
        if let Some(pending) = self.pending_builds.get_mut(tid) {
            pending.turn = turn;
            pending.awaited_roots = awaited;
            if awaited_this_event {
                pending.deadline_ms = pending
                    .deadline_ms
                    .max(now_ms.saturating_add(CAPTURE_WAIT_MS));
            }
            return;
        }
        if let Some(state) = self.turn_states.get_mut(tid) {
            state.latest_turn = turn.clone();
            if state.in_flight {
                state.dirty = true;
                if awaited_this_event {
                    self.pending_builds.insert(
                        tid.clone(),
                        PendingBuild {
                            turn,
                            deadline_ms: now_ms.saturating_add(CAPTURE_WAIT_MS),
                            awaited_roots: awaited,
                        },
                    );
                }
                return;
            }
        }
        let deadline_ms = if awaited_this_event {
            now_ms.saturating_add(CAPTURE_WAIT_MS)
        } else {
            now_ms
        };
        self.pending_builds.insert(
            tid.clone(),
            PendingBuild {
                turn,
                deadline_ms,
                awaited_roots: awaited,
            },
        );
    }

    fn is_pending_ready(
        &self,
        pending: &PendingBuild,
        owned_canon: &BTreeSet<String>,
        now_ms: u64,
    ) -> bool {
        if now_ms >= pending.deadline_ms {
            return true;
        }
        for (canon_root, &post_ms) in &pending.awaited_roots {
            if !owned_canon.contains(canon_root) {
                continue;
            }
            let satisfied = self
                .latest_valid_capture
                .get(canon_root)
                .is_some_and(|&started_ms| started_ms >= post_ms);
            if !satisfied {
                return false;
            }
        }
        true
    }

    fn min_active_started_ms(&self) -> u64 {
        let tracker_min = self.tracker.min_retained_started_ms();
        let pending_min = self
            .pending_builds
            .values()
            .map(|p| p.turn.started_ms)
            .min();
        let state_min = self
            .turn_states
            .values()
            .filter(|s| s.in_flight || s.dirty)
            .map(|s| s.latest_turn.started_ms)
            .min();
        [tracker_min, pending_min, state_min]
            .into_iter()
            .flatten()
            .min()
            .unwrap_or(0)
    }

    fn dispatch_turn(
        &mut self,
        tid: &TurnId,
        turn: Turn,
        ctx: &EngineCtx,
        owned_canon: &BTreeSet<String>,
        retain_versions_from_ms: u64,
    ) {
        let state = self
            .turn_states
            .entry(tid.clone())
            .or_insert_with(|| TurnBuildState {
                emitted_rev: 0,
                in_flight: false,
                dirty: false,
                latest_turn: turn.clone(),
            });
        state.latest_turn = turn.clone();
        state.in_flight = true;
        state.dirty = false;
        let next_rev = state.emitted_rev.saturating_add(1);

        let session_root = turn
            .repo
            .root
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToOwned::to_owned);
        let root_canon = session_root
            .as_deref()
            .map(|r| canonical_path(r, cfg!(windows)));
        let recorded = root_canon
            .as_deref()
            .is_some_and(|r| owned_canon.contains(r));
        let store_dir = if recorded {
            root_canon.as_deref().map(|canon| {
                let rid = repo_id(canon, cfg!(windows));
                listening_store_dir(&self.home, &rid)
            })
        } else {
            None
        };
        let results = root_canon
            .as_deref()
            .and_then(|r| self.captures_by_root.get(r))
            .cloned()
            .unwrap_or_default();
        let capture_state = root_canon.as_deref().and_then(|canon| {
            ctx.capture
                .iter()
                .find(|h| canonical_path(&h.root, cfg!(windows)) == canon)
                .map(|h| h.state)
        });
        let versions_through_ms =
            compute_versions_through_ms(&turn, &results, root_canon.as_deref());
        let other_bash = self.collect_other_bash(&turn, versions_through_ms);
        let other_edits = if recorded {
            self.collect_other_edits(&turn, session_root.as_deref(), &results, versions_through_ms)
        } else {
            Vec::new()
        };
        let parent_card_id = if turn.agent.agent_id.is_empty() {
            None
        } else {
            self.parent_card_ids.get(tid).cloned()
        };
        let cid = card_id(
            &turn.agent.session_id,
            &turn.agent.agent_id,
            turn.started_ms,
        );
        let gaps: Vec<(u64, u64)> = ctx.gaps.iter().map(|g| (g.from_ms, g.to_ms)).collect();

        self.pool.submit(BuildJob {
            turn_id: tid.clone(),
            turn,
            card_id: cid,
            rev: next_rev,
            session_root,
            recorded,
            store_dir,
            results,
            other_bash,
            other_edits,
            gaps,
            capture_state,
            home_dir: self.home.clone(),
            config_dirs: ctx.config_dirs.clone(),
            parent_card_id,
            versions_through_ms,
            retain_versions_from_ms,
        });
    }

    fn collect_other_bash(&self, turn: &Turn, through_ms: u64) -> Vec<ToolWindow> {
        let mut out = Vec::new();
        for windows in self.bash_by_turn.values() {
            for win in windows {
                if win.agent == turn.agent || win.kind != ToolKind::Bash {
                    continue;
                }
                let win_end_upper = match win.post_ms {
                    Some(post) => post.saturating_add(WINDOW_CAP_MS),
                    None => through_ms,
                };
                if win.pre_ms <= through_ms && win_end_upper >= turn.started_ms {
                    out.push(win.clone());
                }
            }
        }
        out
    }

    fn collect_other_edits(
        &self,
        turn: &Turn,
        session_root: Option<&str>,
        results: &[CaptureResult],
        through_ms: u64,
    ) -> Vec<(String, u64, u64)> {
        if session_root.is_none() {
            return Vec::new();
        }
        let mut out = Vec::new();
        for other in self.tracker.retained_turns() {
            if other.agent == turn.agent {
                continue;
            }
            for item in collect_edit_windows_for_turn(other, session_root, &self.home, results) {
                if item.1 <= through_ms && item.2 >= turn.started_ms {
                    out.push(item);
                }
            }
        }
        out
    }

    fn expire_old_state(&mut self, now_ms: u64) {
        let expired = self.tracker.expire(now_ms);
        for turn in expired {
            let tid = (turn.agent, turn.started_ms);
            let still_active = self.pending_builds.contains_key(&tid)
                || self
                    .turn_states
                    .get(&tid)
                    .is_some_and(|s| s.in_flight || s.dirty);
            if !still_active {
                self.parent_card_ids.remove(&tid);
                self.bash_by_turn.remove(&tid);
                self.awaited_roots.remove(&tid);
                self.turn_states.remove(&tid);
            }
        }
    }
}

fn worker_loop(
    rx: Arc<Mutex<mpsc::Receiver<BuildJob>>>,
    tx: mpsc::Sender<BuildDone>,
    stores: Arc<Mutex<HashMap<PathBuf, Arc<Mutex<CachedStore>>>>>,
    panics: Arc<AtomicU64>,
    hook: Option<BuildHook>,
) {
    loop {
        let job = {
            let guard = rx.lock().expect("worker job receiver lock");
            guard.recv()
        };
        let Ok(job) = job else {
            break;
        };
        let tid = job.turn_id.clone();
        let outcome =
            panic::catch_unwind(AssertUnwindSafe(|| run_job(job, &stores, hook.as_deref())));
        match outcome {
            Ok(card) => {
                let _ = tx.send(BuildDone {
                    turn_id: tid,
                    card,
                    panicked: false,
                });
            }
            Err(_) => {
                panics.fetch_add(1, Ordering::Relaxed);
                let _ = tx.send(BuildDone {
                    turn_id: tid,
                    card: None,
                    panicked: true,
                });
            }
        }
    }
}

fn run_job(
    job: BuildJob,
    stores: &Mutex<HashMap<PathBuf, Arc<Mutex<CachedStore>>>>,
    hook: Option<&(dyn Fn(&BuildInput) + Send + Sync)>,
) -> Option<Card> {
    let version_read = if job.recorded
        && let Some(store_dir) = &job.store_dir
    {
        let cached = {
            let mut map = stores.lock().expect("store cache map lock");
            Arc::clone(
                map.entry(store_dir.clone())
                    .or_insert_with(|| Arc::new(Mutex::new(CachedStore::new(store_dir.clone())))),
            )
        };
        let mut store = cached.lock().expect("store reader lock");
        store.versions_in_range(
            job.turn.started_ms,
            job.versions_through_ms,
            job.retain_versions_from_ms,
        )
    } else {
        VersionsRead::default()
    };

    let quotes = read_turn_quotes(&job.turn, &job.config_dirs);

    let input = BuildInput {
        turn: job.turn,
        card_id: job.card_id,
        rev: job.rev,
        session_root: job.session_root,
        recorded: job.recorded,
        versions: version_read.versions,
        results: job.results,
        other_bash: job.other_bash,
        other_edits: job.other_edits,
        versions_through_ms: job.versions_through_ms,
        quotes,
        gaps: job.gaps,
        capture_state: job.capture_state,
        store_error: version_read.store_error,
        tail_cut: version_read.tail_cut,
        home_dir: job.home_dir,
        parent_card_id: job.parent_card_id,
    };

    if let Some(cb) = hook {
        cb(&input);
    }

    let store_ref = input.recorded.then_some(job.store_dir.as_deref()).flatten();
    let card = build_card(
        &input,
        &|sha| match store_ref {
            Some(dir) => read_object(dir, sha),
            None => ObjectRead::Missing,
        },
        &|path| {
            if input.recorded {
                safe_stat_file(path)
            } else {
                None
            }
        },
    );

    if card.blocks.is_empty() {
        None
    } else {
        Some(card)
    }
}

fn read_turn_quotes(turn: &Turn, config_dirs: &[PathBuf]) -> TranscriptRead {
    let Some(raw_path) = turn.transcript_path.as_deref() else {
        return unreadable_transcript();
    };
    let Some(safe_path) = validate_transcript_path(raw_path, config_dirs) else {
        return unreadable_transcript();
    };
    let tool_ids: Vec<String> = turn.windows.iter().map(|w| w.tool_use_id.clone()).collect();
    read_quotes(&safe_path, &tool_ids, turn.started_ms).unwrap_or_else(|_| unreadable_transcript())
}

fn unreadable_transcript() -> TranscriptRead {
    TranscriptRead {
        quotes: Default::default(),
        first_user_text: None,
        complete: false,
    }
}

fn safe_stat_file(path: &str) -> Option<u64> {
    let meta = fs::symlink_metadata(path).ok()?;
    if meta.file_type().is_file() {
        Some(meta.len())
    } else {
        None
    }
}

fn compute_versions_through_ms(
    turn: &Turn,
    results: &[CaptureResult],
    root_canon: Option<&str>,
) -> u64 {
    let mut upper = turn.ended_ms.unwrap_or(turn.started_ms);
    for win in &turn.windows {
        let anchor = win.post_ms.or(turn.ended_ms).unwrap_or(win.pre_ms);
        let cap = anchor.saturating_add(WINDOW_CAP_MS);
        let win_end = root_canon
            .and_then(|root| {
                results
                    .iter()
                    .filter(|r| {
                        r.started_ms != 0
                            && r.started_ms >= anchor
                            && canonical_path(&r.root, cfg!(windows)) == root
                    })
                    .min_by_key(|r| (r.started_ms, r.at_ms))
                    .filter(|r| r.at_ms <= cap)
                    .map(|r| r.at_ms.max(win.pre_ms))
            })
            .unwrap_or(cap);
        upper = upper.max(win_end);
    }
    upper
}

fn empty_repo_info() -> RepoInfo {
    RepoInfo {
        root: None,
        main_root: None,
        name: String::new(),
        branch: None,
    }
}

/// Computes the deterministic 32-hex-character identifier for a turn card.
pub fn card_id(session_id: &str, agent_id: &str, started_ms: u64) -> String {
    let mut buf = Vec::with_capacity(session_id.len() + agent_id.len() + 24);
    buf.extend_from_slice(session_id.as_bytes());
    buf.push(0);
    buf.extend_from_slice(agent_id.as_bytes());
    buf.push(0);
    buf.extend_from_slice(started_ms.to_string().as_bytes());
    let digest = Sha256::digest(&buf);
    let mut hex = String::with_capacity(32);
    for byte in &digest[..16] {
        use std::fmt::Write;
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn card_id_matches_fixed_vectors_and_nul_boundaries() {
        assert_eq!(
            card_id("sess-1", "", 1_000),
            "4e5e1a6d22cea72d7a8b3985c9c27fcf"
        );
        assert_eq!(
            card_id("sess-1", "sub-1", 1_000),
            "97394ac43381e6ac7a3b66cb264cd2b9"
        );
        assert_eq!(card_id("s", "a", 123), "085fd43e5e4c84caf8d98e99af9d6ff2");
        assert_eq!(card_id("sa", "", 123), "a4a2a32beaaf4d9e15c7f0c649393eb4");
        assert_eq!(card_id("s", "a1", 23), "bcb390a344d2e7e6b1f5bf2650a1dd60");
    }
}
