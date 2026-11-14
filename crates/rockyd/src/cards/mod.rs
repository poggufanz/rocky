//! Read-only Listening store reader and worker-backed change card engine.

pub mod attribute;
pub mod detail;
pub mod query;
pub mod storage;
pub mod store;
pub mod transcript;
pub mod windows;

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::fs;
use std::panic::{self, AssertUnwindSafe};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, mpsc};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use rocky_proto::cards::Card;
use rocky_proto::hook::HookEvent;
use rocky_proto::paths::{canonical_path, listening_store_dir, repo_id};
use rocky_proto::pipe::{AgentKey, CaptureHealth, CaptureState, Gap, RepoInfo};
use sha2::{Digest, Sha256};

use crate::capture::CaptureResult;
use crate::cards::attribute::{BuildInput, IndexedEdit, build_card, resolve_other_edits};
use crate::cards::store::{ObjectRead, StoreReader, Version, read_object};
use crate::cards::transcript::{TranscriptRead, read_quotes, validate_transcript_path};
use crate::cards::windows::{
    ClosedEdit, PromptIn, REVISION_WINDOW_MS, ToolKind, ToolWindow, Tracker, TrackerSignal, Turn,
};
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
#[cfg(test)]
type JobHook = Arc<dyn Fn(&BuildJob) + Send + Sync>;

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

    fn extend_versions_deduped(&mut self, newly_read: Vec<crate::cards::store::Version>) {
        if newly_read.is_empty() {
            return;
        }
        let mut seen: HashSet<(u64, String, Option<String>, bool)> = self
            .versions
            .iter()
            .map(|v| (v.ts, v.file_rel.clone(), v.sha.clone(), v.deleted))
            .collect();
        for v in newly_read {
            let key = (v.ts, v.file_rel.clone(), v.sha.clone(), v.deleted);
            if seen.insert(key) {
                self.versions.push(v);
            }
        }
    }

    fn versions_in_range(
        &mut self,
        from_ms: u64,
        through_ms: u64,
        retain_from_ms: u64,
    ) -> VersionsRead {
        let reader_tail_cut = match self.reader.versions_since_with_restart(0) {
            Ok(batch) => {
                if batch.restarted {
                    self.versions.clear();
                    self.tail_cut_through_ms = None;
                }
                if batch.tail_cut {
                    let cut_frontier = batch.versions.iter().map(|v| v.ts).max().unwrap_or(from_ms);
                    self.tail_cut_through_ms = Some(
                        self.tail_cut_through_ms
                            .map_or(cut_frontier, |prev| prev.max(cut_frontier)),
                    );
                }
                self.extend_versions_deduped(batch.versions);
                batch.tail_cut
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
    other_edits: Vec<IndexedEdit>,
    gaps: Vec<(u64, u64)>,
    capture_state: Option<CaptureState>,
    home_dir: PathBuf,
    config_dirs: Vec<PathBuf>,
    parent_card_id: Option<String>,
    versions_through_ms: u64,
    retain_versions_from_ms: u64,
}

#[cfg(test)]
impl BuildJob {
    fn other_edit_count(&self) -> usize {
        self.other_edits.len()
    }
}

struct BuildDone {
    turn_id: TurnId,
    card: Option<Card>,
    panicked: bool,
}

pub(crate) const WORKER_DROP_TIMEOUT: Duration = Duration::from_secs(2);

pub(crate) struct WorkerExitGuard {
    state: Arc<(Mutex<usize>, Condvar)>,
    finished: Arc<AtomicBool>,
}

impl WorkerExitGuard {
    pub(crate) fn finished_flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.finished)
    }
}

impl Drop for WorkerExitGuard {
    fn drop(&mut self) {
        self.finished.store(true, Ordering::Release);
        let (lock, cvar) = &*self.state;
        let mut active = lock.lock().unwrap_or_else(|p| p.into_inner());
        *active = active.saturating_sub(1);
        cvar.notify_all();
    }
}

pub(crate) struct BoundedWorkers {
    state: Arc<(Mutex<usize>, Condvar)>,
    handles: Vec<(JoinHandle<()>, Arc<AtomicBool>)>,
}

impl BoundedWorkers {
    pub(crate) fn new() -> Self {
        Self {
            state: Arc::new((Mutex::new(0), Condvar::new())),
            handles: Vec::new(),
        }
    }

    pub(crate) fn prepare_spawn(&self) -> WorkerExitGuard {
        let (lock, _) = &*self.state;
        let mut active = lock.lock().unwrap_or_else(|p| p.into_inner());
        *active += 1;
        WorkerExitGuard {
            state: Arc::clone(&self.state),
            finished: Arc::new(AtomicBool::new(false)),
        }
    }

    pub(crate) fn push(&mut self, handle: JoinHandle<()>, finished: Arc<AtomicBool>) {
        self.handles.push((handle, finished));
    }

    pub(crate) fn join_bounded(&mut self, timeout: Duration) {
        if self.handles.is_empty() {
            return;
        }
        let (lock, cvar) = &*self.state;
        let deadline = Instant::now() + timeout;
        let mut active = lock.lock().unwrap_or_else(|p| p.into_inner());
        while *active > 0 {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            let (next, res) = cvar
                .wait_timeout(active, left)
                .unwrap_or_else(|p| p.into_inner());
            active = next;
            if res.timed_out() {
                break;
            }
        }
        drop(active);

        for (handle, finished) in self.handles.drain(..) {
            if finished.load(Ordering::Acquire) {
                let _ = handle.join();
            }
        }
    }
}

struct WorkerPool {
    workers: usize,
    job_tx: Option<mpsc::Sender<BuildJob>>,
    job_rx: Option<Arc<Mutex<mpsc::Receiver<BuildJob>>>>,
    res_tx: Option<mpsc::Sender<BuildDone>>,
    res_rx: mpsc::Receiver<BuildDone>,
    stores: Arc<Mutex<HashMap<PathBuf, Arc<Mutex<CachedStore>>>>>,
    hook: Option<BuildHook>,
    #[cfg(test)]
    job_hook: Option<JobHook>,
    pool_workers: BoundedWorkers,
    panics: Arc<AtomicU64>,
}

impl WorkerPool {
    fn with_hooks(
        workers: usize,
        hook: Option<BuildHook>,
        #[cfg(test)] job_hook: Option<JobHook>,
    ) -> Self {
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
            #[cfg(test)]
            job_hook,
            pool_workers: BoundedWorkers::new(),
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
            let exit_guard = self.pool_workers.prepare_spawn();
            let finished = exit_guard.finished_flag();
            let name = format!("{CARD_WORKER_THREAD_PREFIX}{idx}");
            let handle = thread::Builder::new()
                .name(name)
                .spawn(move || {
                    let _exit_guard = exit_guard;
                    worker_loop(rx, tx, stores_ref, panics_ref, hook_ref);
                })
                .expect("spawn card worker thread");
            self.pool_workers.push(handle, finished);
        }
    }

    fn submit(&mut self, job: BuildJob) {
        #[cfg(test)]
        if let Some(cb) = &self.job_hook {
            cb(&job);
        }
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
        self.pool_workers.join_bounded(WORKER_DROP_TIMEOUT);
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
    next_edit_seq: u64,
    edit_index: BTreeMap<(u64, u64), IndexedEdit>,
    edit_keys_by_turn: HashMap<u64, Vec<(u64, u64)>>,
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
        Self::with_hooks(
            home,
            workers,
            hook,
            #[cfg(test)]
            None,
        )
    }

    #[cfg(test)]
    fn new_with_job_hook(home: PathBuf, workers: usize, job_hook: JobHook) -> Self {
        Self::with_hooks(home, workers, None, Some(job_hook))
    }

    fn with_hooks(
        home: PathBuf,
        workers: usize,
        hook: Option<BuildHook>,
        #[cfg(test)] job_hook: Option<JobHook>,
    ) -> Self {
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
            next_edit_seq: 0,
            edit_index: BTreeMap::new(),
            edit_keys_by_turn: HashMap::new(),
            pool: WorkerPool::with_hooks(
                workers,
                hook,
                #[cfg(test)]
                job_hook,
            ),
        }
    }

    #[cfg(test)]
    fn edit_index_len(&self) -> usize {
        self.edit_index.len()
    }

    #[cfg(test)]
    fn in_flight_count(&self) -> usize {
        self.turn_states.values().filter(|s| s.in_flight).count()
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

            let mut closed_edits = Vec::new();
            let signals =
                self.tracker
                    .on_event_recording_edits(ev, *recv_ms, &repo, &mut closed_edits);
            for closed in closed_edits {
                self.index_closed_edit(closed);
            }
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
        self.edit_index.clear();
        self.edit_keys_by_turn.clear();
        for state in self.turn_states.values_mut() {
            state.dirty = false;
        }
        self.turn_states.retain(|_, s| s.in_flight);
    }

    /// Seeds a session's cached repository when cards have not seen the session yet.
    pub fn seed_session_repo_if_absent(&mut self, session_id: &str, repo: &RepoInfo) {
        if repo.root.is_none()
            && repo.main_root.is_none()
            && repo.name.is_empty()
            && repo.branch.is_none()
        {
            return;
        }
        self.repo_cache
            .entry(session_id.to_string())
            .or_insert_with(|| repo.clone());
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
            (_, Some(_)) => false,
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
            self.collect_overlapping_edits(&turn, versions_through_ms)
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

    fn index_closed_edit(&mut self, closed: ClosedEdit) {
        let seq = self.next_edit_seq;
        self.next_edit_seq = self.next_edit_seq.saturating_add(1);
        let key = (closed.pre_ms, seq);
        self.edit_index.insert(
            key,
            IndexedEdit {
                agent: closed.agent,
                tool_use_id: closed.tool_use_id,
                target_path: closed.target_path,
                session_root: closed.session_root,
                cwd: closed.cwd,
                pre_ms: closed.pre_ms,
                post_ms: closed.post_ms,
            },
        );
        self.edit_keys_by_turn
            .entry(closed.turn_id)
            .or_default()
            .push(key);
    }

    fn collect_overlapping_edits(&self, turn: &Turn, versions_through_ms: u64) -> Vec<IndexedEdit> {
        let card_end_upper = turn
            .ended_ms
            .unwrap_or(turn.started_ms)
            .saturating_add(REVISION_WINDOW_MS)
            .max(versions_through_ms);
        let mut out = Vec::new();
        for (_, entry) in self.edit_index.range(..=(card_end_upper, u64::MAX)) {
            if entry.agent != turn.agent
                && entry
                    .post_ms
                    .max(entry.pre_ms)
                    .saturating_add(WINDOW_CAP_MS)
                    >= turn.started_ms
            {
                out.push(entry.clone());
            }
        }
        out
    }

    fn expire_old_state(&mut self, now_ms: u64) {
        let expired = self.tracker.expire_with_ids(now_ms);
        for (turn_id, turn) in expired {
            if let Some(keys) = self.edit_keys_by_turn.remove(&turn_id) {
                for key in keys {
                    self.edit_index.remove(&key);
                }
            }
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
    let other_edits = if job.recorded {
        resolve_other_edits(
            &job.other_edits,
            job.turn.started_ms,
            job.session_root.as_deref(),
            &job.home_dir,
            &job.results,
            job.versions_through_ms,
        )
    } else {
        Vec::new()
    };

    let input = BuildInput {
        turn: job.turn,
        card_id: job.card_id,
        rev: job.rev,
        session_root: job.session_root,
        recorded: job.recorded,
        versions: version_read.versions,
        results: job.results,
        other_bash: job.other_bash,
        other_edits,
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

    fn test_hook_event(name: &str, session_id: &str, cwd: Option<&str>) -> HookEvent {
        HookEvent {
            hook_event_name: name.to_string(),
            session_id: session_id.to_string(),
            cwd: cwd.map(str::to_string),
            agent_id: None,
            agent_type: None,
            tool_name: None,
            tool_use_id: None,
            transcript_path: None,
            agent_transcript_path: None,
            notification_type: None,
            target_path: None,
            command: None,
            description: None,
            prompt: None,
            truncated: false,
        }
    }

    #[test]
    fn resolve_session_repo_caches_non_git_sessions_after_first_resolution() {
        let dir = tempfile::tempdir().unwrap();
        let mut engine = Engine::new(dir.path().to_path_buf(), 1);
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let mut repo_of = |cwd: &str| {
            calls.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            RepoInfo {
                root: None,
                main_root: None,
                name: std::path::Path::new(cwd)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("")
                    .to_string(),
                branch: None,
            }
        };

        let events = IngestOutput {
            events: vec![
                (
                    test_hook_event("UserPromptSubmit", "non-git-sess", Some("/tmp/plain")),
                    1_000,
                ),
                (
                    test_hook_event("PreToolUse", "non-git-sess", Some("/tmp/plain")),
                    1_100,
                ),
                (
                    test_hook_event("PostToolUse", "non-git-sess", Some("/tmp/plain")),
                    1_200,
                ),
                (
                    test_hook_event("Stop", "non-git-sess", Some("/tmp/plain")),
                    1_300,
                ),
            ],
            ..IngestOutput::default()
        };
        let _ = engine.on_ingest(&events, &mut repo_of, 1_300);
        assert_eq!(calls.load(std::sync::atomic::Ordering::Relaxed), 1);

        let refresh = IngestOutput {
            events: vec![(
                test_hook_event("SessionStart", "non-git-sess", Some("/tmp/plain-2")),
                2_000,
            )],
            ..IngestOutput::default()
        };
        let _ = engine.on_ingest(&refresh, &mut repo_of, 2_000);
        assert_eq!(calls.load(std::sync::atomic::Ordering::Relaxed), 2);
    }

    #[test]
    fn cached_store_clears_versions_on_shrink_and_dedupes_overlapping_reads() {
        let dir = tempfile::tempdir().unwrap();
        let events = dir.path().join("events.jsonl");
        let sha1 = "1".repeat(64);
        let sha2 = "2".repeat(64);
        let sha3 = "3".repeat(64);
        let pad = "p".repeat(600);

        let initial = format!(
            "{{\"v\":1,\"node\":\"file_version\",\"ts\":50,\"refs\":{{\"fileRel\":\"old_pad.ts\",\"version\":\"{sha1}\"}},\"pad\":\"{pad}\"}}\n\
             {{\"v\":1,\"node\":\"file_version\",\"ts\":200,\"refs\":{{\"fileRel\":\"kept.ts\",\"version\":\"{sha2}\"}}}}\n\
             {{\"v\":1,\"node\":\"file_version\",\"ts\":300,\"refs\":{{\"fileRel\":\"kept2.ts\",\"version\":\"{sha3}\"}}}}\n"
        );
        fs::write(&events, initial.as_bytes()).unwrap();

        let mut cache = CachedStore::new(dir.path().to_path_buf());
        let first = cache.versions_in_range(150, 500, 150);
        assert_eq!(first.versions.len(), 2);

        // Shrink events.jsonl (removing old_pad.ts) while retaining kept.ts and kept2.ts
        // plus one new event.
        let compacted = format!(
            "{{\"v\":1,\"node\":\"file_version\",\"ts\":200,\"refs\":{{\"fileRel\":\"kept.ts\",\"version\":\"{sha2}\"}}}}\n\
             {{\"v\":1,\"node\":\"file_version\",\"ts\":300,\"refs\":{{\"fileRel\":\"kept2.ts\",\"version\":\"{sha3}\"}}}}\n\
             {{\"v\":1,\"node\":\"file_version\",\"ts\":400,\"refs\":{{\"fileRel\":\"new.ts\",\"version\":\"{sha1}\"}}}}\n"
        );
        assert!(compacted.len() < initial.len());
        fs::write(&events, compacted.as_bytes()).unwrap();

        let second = cache.versions_in_range(150, 500, 150);
        assert_eq!(
            second.versions.len(),
            3,
            "shrink/restart must not duplicate cached versions; got {:?}",
            second
                .versions
                .iter()
                .map(|v| (&v.file_rel, v.ts))
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn worker_pool_drop_returns_within_deadline_when_worker_stalls() {
        let dir = tempfile::tempdir().unwrap();
        let (entered_tx, entered_rx) = mpsc::channel::<()>();
        let (release_tx, release_rx) = mpsc::sync_channel::<()>(1);
        let entered_tx = Mutex::new(entered_tx);
        let release_rx = Mutex::new(release_rx);
        let hook: BuildHook = Arc::new(move |_| {
            let _ = entered_tx.lock().unwrap().send(());
            let _ = release_rx
                .lock()
                .unwrap()
                .recv_timeout(std::time::Duration::from_secs(8));
        });

        let mut pool = WorkerPool::with_hooks(1, Some(hook), None);
        let agent = AgentKey {
            session_id: "sess-drop".to_string(),
            agent_id: String::new(),
        };
        let job = BuildJob {
            turn_id: (agent.clone(), 1_000),
            turn: Turn {
                agent,
                agent_type: "claude".to_string(),
                parent: None,
                cwd: None,
                repo: empty_repo_info(),
                prompt: None,
                started_ms: 1_000,
                ended_ms: Some(2_000),
                status: crate::cards::windows::TurnEnd::Done,
                transcript_path: None,
                windows: Vec::new(),
            },
            card_id: "card-drop-test".to_string(),
            rev: 1,
            session_root: None,
            recorded: false,
            store_dir: None,
            results: Vec::new(),
            other_bash: Vec::new(),
            other_edits: Vec::new(),
            gaps: Vec::new(),
            capture_state: None,
            home_dir: dir.path().to_path_buf(),
            config_dirs: Vec::new(),
            parent_card_id: None,
            versions_through_ms: 2_000,
            retain_versions_from_ms: 0,
        };
        pool.submit(job);
        entered_rx
            .recv_timeout(std::time::Duration::from_secs(3))
            .expect("worker entered build hook");

        struct Unblock(mpsc::SyncSender<()>, Option<JoinHandle<()>>);
        impl Drop for Unblock {
            fn drop(&mut self) {
                let _ = self.0.try_send(());
                if let Some(h) = self.1.take() {
                    let _ = h.join();
                }
            }
        }

        let (dropped_tx, dropped_rx) = mpsc::channel::<()>();
        let helper = thread::spawn(move || {
            drop(pool);
            let _ = dropped_tx.send(());
        });
        let _guard = Unblock(release_tx, Some(helper));

        assert!(
            dropped_rx
                .recv_timeout(std::time::Duration::from_secs(4))
                .is_ok(),
            "WorkerPool::drop must return within deadline even if a worker stalls"
        );
    }

    fn canonical_temp_root(path: &std::path::Path) -> PathBuf {
        let canon = fs::canonicalize(path).expect("canonicalize tempdir");
        #[cfg(windows)]
        if let Some(stripped) = canon.to_str().and_then(|s| s.strip_prefix(r"\\?\")) {
            return PathBuf::from(stripped);
        }
        canon
    }

    #[test]
    fn dispatch_clones_only_overlapping_edit_windows() {
        use rocky_proto::cards::CoverageState;
        use rocky_proto::pipe::CaptureHealth;
        use serde_json::json;

        let dir = tempfile::tempdir().unwrap();
        let root = canonical_temp_root(dir.path());
        let home = root.join("home");
        let repo_root = root.join("repo-main");
        let other_root = root.join("repo-other");
        let config_dir = root.join("claude");
        let projects_dir = config_dir.join("projects").join("proj-a");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(repo_root.join("src")).unwrap();
        fs::create_dir_all(other_root.join("src")).unwrap();
        fs::create_dir_all(&projects_dir).unwrap();

        let repo_canon = canonical_path(&repo_root.to_string_lossy(), cfg!(windows));
        let other_canon = canonical_path(&other_root.to_string_lossy(), cfg!(windows));
        let rid = repo_id(&repo_canon, cfg!(windows));
        let store_dir = listening_store_dir(&home, &rid);
        fs::create_dir_all(store_dir.join("objects")).unwrap();

        let sha_a = "a".repeat(64);
        let sha_b = "b".repeat(64);
        fs::write(
            store_dir.join("objects").join(&sha_a),
            "export const x = 1;\n",
        )
        .unwrap();
        fs::write(
            store_dir.join("objects").join(&sha_b),
            "export const x = 2;\n",
        )
        .unwrap();
        let events_jsonl = format!(
            "{}\n{}\n",
            json!({
                "v": 1,
                "node": "file_version",
                "ts": 50_400u64,
                "refs": {
                    "fileRel": "src/other_edit.ts",
                    "version": sha_b,
                    "prev": sha_a,
                    "created": false,
                    "deleted": false,
                    "baseline": false
                }
            }),
            json!({
                "v": 1,
                "node": "file_version",
                "ts": 50_600u64,
                "refs": {
                    "fileRel": "src/target_bash.ts",
                    "version": sha_b,
                    "prev": sha_a,
                    "created": false,
                    "deleted": false,
                    "baseline": false
                }
            }),
        );
        fs::write(store_dir.join("events.jsonl"), events_jsonl).unwrap();

        let transcript_path = projects_dir.join("sess-target.jsonl");
        let transcript = format!(
            "{}\n{}\n",
            json!({
                "type": "user",
                "timestamp": "1970-01-01T00:00:50.000Z",
                "message": { "content": "Run cargo check" }
            }),
            json!({
                "type": "assistant",
                "timestamp": "1970-01-01T00:00:50.500Z",
                "message": {
                    "id": "m1",
                    "content": [
                        { "type": "text", "text": "Running cargo check." },
                        { "type": "tool_use", "id": "tu-bash" }
                    ]
                }
            }),
        );
        fs::write(&transcript_path, transcript).unwrap();
        let transcript_str = transcript_path.to_string_lossy().into_owned();

        let job_counts = Arc::new(Mutex::new(HashMap::<String, usize>::new()));
        let job_counts_ref = Arc::clone(&job_counts);
        let mut engine = Engine::new_with_job_hook(
            home.clone(),
            1,
            Arc::new(move |job| {
                job_counts_ref
                    .lock()
                    .unwrap()
                    .insert(job.card_id.clone(), job.other_edit_count());
            }),
        );

        let repo_canon_ref = repo_canon.clone();
        let other_canon_ref = other_canon.clone();
        let mut repo_of = move |cwd: &str| {
            let c = canonical_path(cwd, cfg!(windows));
            if c == repo_canon_ref {
                RepoInfo {
                    root: Some(repo_canon_ref.clone()),
                    main_root: None,
                    name: "repo-main".to_string(),
                    branch: Some("main".to_string()),
                }
            } else {
                RepoInfo {
                    root: Some(other_canon_ref.clone()),
                    main_root: None,
                    name: "repo-other".to_string(),
                    branch: Some("main".to_string()),
                }
            }
        };

        let ctx = EngineCtx {
            cards: true,
            owned_roots: BTreeSet::from([repo_canon.clone()]),
            capture: vec![CaptureHealth {
                root: repo_canon.clone(),
                state: CaptureState::Ok,
                last_reconcile_ms: None,
                error: None,
            }],
            gaps: Vec::new(),
            config_dirs: vec![config_dir.clone()],
        };

        // Seed 200 retained closed turns outside the target card's time range
        // (100 in the target root, 100 in another root, mixing PostToolUse and PostToolUseFailure).
        let mut seed_events = Vec::with_capacity(200 * 4);
        for i in 0..200u64 {
            let sid = format!("sess-old-{i}");
            let (root, cwd) = if i < 100 {
                (&repo_root, repo_canon.as_str())
            } else {
                (&other_root, other_canon.as_str())
            };
            let target = root
                .join(format!("src/old_{i}.ts"))
                .to_string_lossy()
                .into_owned();
            let base_ts = 10_000 + i * 10;
            let tu_id = format!("tu-old-{i}");

            let mut pre = test_hook_event("PreToolUse", &sid, Some(cwd));
            pre.tool_name = Some("Edit".to_string());
            pre.tool_use_id = Some(tu_id.clone());
            pre.target_path = Some(target.clone());

            let post_name = if i % 2 == 0 {
                "PostToolUse"
            } else {
                "PostToolUseFailure"
            };
            let mut post = test_hook_event(post_name, &sid, Some(cwd));
            post.tool_name = Some("Edit".to_string());
            post.tool_use_id = Some(tu_id);
            post.target_path = Some(target);

            seed_events.push((
                test_hook_event("UserPromptSubmit", &sid, Some(cwd)),
                base_ts,
            ));
            seed_events.push((pre, base_ts + 2));
            seed_events.push((post, base_ts + 4));
            seed_events.push((test_hook_event("Stop", &sid, Some(cwd)), base_ts + 8));
        }
        let _ = engine.on_ingest(
            &IngestOutput {
                events: seed_events,
                ..IngestOutput::default()
            },
            &mut repo_of,
            13_000,
        );

        // Drain the 200 seeded builds so only the target and overlap cards dispatch next,
        // while keeping all 200 closed turns retained inside their 60 s window.
        let drain_deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < drain_deadline {
            let _ = engine.poll(20_000, &ctx);
            if job_counts.lock().unwrap().len() >= 200 && engine.in_flight_count() == 0 {
                break;
            }
            thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(engine.in_flight_count(), 0);
        assert_eq!(engine.edit_index_len(), 200);

        // Overlapping other-agent edit plus the target turn.
        let other_target = repo_root
            .join("src/other_edit.ts")
            .to_string_lossy()
            .into_owned();
        let mut ov_pre = test_hook_event("PreToolUse", "sess-overlap", Some(&repo_canon));
        ov_pre.tool_name = Some("Edit".to_string());
        ov_pre.tool_use_id = Some("tu-other".to_string());
        ov_pre.target_path = Some(other_target.clone());

        let mut ov_post = test_hook_event("PostToolUse", "sess-overlap", Some(&repo_canon));
        ov_post.tool_name = Some("Edit".to_string());
        ov_post.tool_use_id = Some("tu-other".to_string());
        ov_post.target_path = Some(other_target);

        let mut bash_pre = test_hook_event("PreToolUse", "sess-target", Some(&repo_canon));
        bash_pre.tool_name = Some("Bash".to_string());
        bash_pre.tool_use_id = Some("tu-bash".to_string());
        bash_pre.command = Some("cargo check".to_string());

        let mut bash_post = test_hook_event("PostToolUse", "sess-target", Some(&repo_canon));
        bash_post.tool_name = Some("Bash".to_string());
        bash_post.tool_use_id = Some("tu-bash".to_string());

        let mut target_start =
            test_hook_event("UserPromptSubmit", "sess-target", Some(&repo_canon));
        target_start.transcript_path = Some(transcript_str.clone());
        let mut target_stop = test_hook_event("Stop", "sess-target", Some(&repo_canon));
        target_stop.transcript_path = Some(transcript_str.clone());

        let _ = engine.on_ingest(
            &IngestOutput {
                prompts: vec![PromptIn {
                    session_id: "sess-target".to_string(),
                    text: "Run cargo check".to_string(),
                    truncated: false,
                    recv_ms: 50_000,
                }],
                events: vec![
                    (target_start, 50_000),
                    (
                        test_hook_event("UserPromptSubmit", "sess-overlap", Some(&repo_canon)),
                        50_050,
                    ),
                    (bash_pre, 50_200),
                    (ov_pre, 50_300),
                    (ov_post, 50_500),
                    (
                        test_hook_event("Stop", "sess-overlap", Some(&repo_canon)),
                        50_700,
                    ),
                    (bash_post, 50_800),
                    (target_stop, 51_000),
                ],
                ..IngestOutput::default()
            },
            &mut repo_of,
            51_000,
        );

        let cap = CaptureResult {
            root: repo_canon.clone(),
            started_ms: 50_900,
            at_ms: 51_000,
            coverage: "ok".to_string(),
        };
        engine.on_capture(std::slice::from_ref(&cap));

        assert_eq!(engine.edit_index_len(), 201);

        let target_cid = card_id("sess-target", "", 50_000);
        let mut built = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            built.extend(engine.poll(51_100, &ctx));
            if built.len() >= 2 {
                break;
            }
            thread::sleep(Duration::from_millis(5));
        }
        let target_card = built
            .into_iter()
            .find(|c| c.card_id == target_cid)
            .expect("expected target card");

        assert_eq!(
            job_counts.lock().unwrap().get(&target_cid).copied(),
            Some(1)
        );

        // Compare against building the card directly with pre-change inputs.
        let target_agent = AgentKey {
            session_id: "sess-target".to_string(),
            agent_id: String::new(),
        };
        let expected_turn = Turn {
            agent: target_agent.clone(),
            agent_type: String::new(),
            parent: None,
            cwd: Some(repo_canon.clone()),
            repo: RepoInfo {
                root: Some(repo_canon),
                main_root: None,
                name: "repo-main".to_string(),
                branch: Some("main".to_string()),
            },
            prompt: Some(PromptIn {
                session_id: "sess-target".to_string(),
                text: "Run cargo check".to_string(),
                truncated: false,
                recv_ms: 50_000,
            }),
            started_ms: 50_000,
            ended_ms: Some(51_000),
            status: crate::cards::windows::TurnEnd::Done,
            transcript_path: Some(transcript_str),
            windows: vec![ToolWindow {
                tool_use_id: "tu-bash".to_string(),
                agent: target_agent,
                kind: ToolKind::Bash,
                tool: "Bash".to_string(),
                target_path: None,
                command: Some("cargo check".to_string()),
                pre_ms: 50_200,
                post_ms: Some(50_800),
                ok: Some(true),
            }],
        };
        let versions: Vec<Version> = StoreReader::new(store_dir.clone())
            .versions_since_with_restart(0)
            .unwrap()
            .versions
            .into_iter()
            .filter(|v| v.ts >= 50_000 && v.ts <= 51_000)
            .collect();
        let quotes = read_turn_quotes(&expected_turn, &ctx.config_dirs);
        let expected_input = BuildInput {
            turn: expected_turn,
            card_id: target_cid,
            rev: 1,
            session_root: expected_input_root(&repo_root),
            recorded: true,
            versions,
            results: vec![cap],
            other_bash: Vec::new(),
            other_edits: vec![("src/other_edit.ts".to_string(), 50_300, 51_000)],
            versions_through_ms: 51_000,
            quotes,
            gaps: Vec::new(),
            capture_state: Some(CaptureState::Ok),
            store_error: false,
            tail_cut: false,
            home_dir: home,
            parent_card_id: None,
        };
        let expected_card = build_card(
            &expected_input,
            &|sha| read_object(&store_dir, sha),
            &|path| safe_stat_file(path),
        );
        assert_eq!(
            target_card.coverage.state,
            CoverageState::Full,
            "coverage reasons: {:?}",
            target_card.coverage.reasons
        );
        assert_eq!(
            target_card.blocks[0]
                .quote
                .as_ref()
                .map(|q| q.text.as_str()),
            Some("Running cargo check.")
        );
        assert_eq!(target_card, expected_card);

        // Once closed turns pass their 60 s retention window, indexed edits are evicted.
        let _ = engine.poll(120_000, &ctx);
        assert_eq!(engine.edit_index_len(), 0);
    }

    #[test]
    fn edit_index_excludes_future_edits_filters_other_roots_on_worker_and_evicts_while_in_flight() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        let root_a = dir.path().join("repo-a");
        let root_b = dir.path().join("repo-b");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&root_a).unwrap();
        fs::create_dir_all(&root_b).unwrap();

        let root_a_str = root_a.to_string_lossy().into_owned();
        let root_b_str = root_b.to_string_lossy().into_owned();
        let mut engine = Engine::new(home.clone(), 1);

        let mut repo_of = |cwd: &str| {
            let root = if cwd == root_a_str {
                root_a_str.clone()
            } else {
                root_b_str.clone()
            };
            RepoInfo {
                root: Some(root),
                main_root: None,
                name: "repo".to_string(),
                branch: Some("main".to_string()),
            }
        };

        let make_edit = |sid: &str, root: &str, tu: &str, rel: &str| {
            let path = std::path::Path::new(root)
                .join(rel)
                .to_string_lossy()
                .into_owned();
            let mut pre = test_hook_event("PreToolUse", sid, Some(root));
            pre.tool_name = Some("Edit".to_string());
            pre.tool_use_id = Some(tu.to_string());
            pre.target_path = Some(path.clone());
            let mut post = test_hook_event("PostToolUse", sid, Some(root));
            post.tool_name = Some("Edit".to_string());
            post.tool_use_id = Some(tu.to_string());
            post.target_path = Some(path);
            (pre, post)
        };

        let (other_b_pre, other_b_post) = make_edit("sess-b", &root_b_str, "tu-b", "src/b.ts");
        let (other_a_pre, other_a_post) = make_edit("sess-a-2", &root_a_str, "tu-a2", "src/a2.ts");
        let (future_pre, future_post) =
            make_edit("sess-future", &root_a_str, "tu-fut", "src/fut.ts");

        let _ = engine.on_ingest(
            &IngestOutput {
                events: vec![
                    (
                        test_hook_event("UserPromptSubmit", "sess-main", Some(&root_a_str)),
                        10_000,
                    ),
                    (
                        test_hook_event("UserPromptSubmit", "sess-b", Some(&root_b_str)),
                        10_100,
                    ),
                    (other_b_pre, 10_200),
                    (other_b_post, 10_400),
                    (test_hook_event("Stop", "sess-b", Some(&root_b_str)), 10_500),
                    (
                        test_hook_event("UserPromptSubmit", "sess-a-2", Some(&root_a_str)),
                        10_600,
                    ),
                    (other_a_pre, 10_700),
                    (other_a_post, 10_900),
                    (
                        test_hook_event("Stop", "sess-a-2", Some(&root_a_str)),
                        11_000,
                    ),
                    (
                        test_hook_event("Stop", "sess-main", Some(&root_a_str)),
                        12_000,
                    ),
                    // Closed edit starting beyond main turn's ended_ms + 60_000.
                    (
                        test_hook_event("UserPromptSubmit", "sess-future", Some(&root_a_str)),
                        80_000,
                    ),
                    (future_pre, 80_100),
                    (future_post, 80_200),
                    (
                        test_hook_event("Stop", "sess-future", Some(&root_a_str)),
                        80_300,
                    ),
                ],
                ..IngestOutput::default()
            },
            &mut repo_of,
            80_300,
        );
        assert_eq!(engine.edit_index_len(), 3);

        let main_agent = AgentKey {
            session_id: "sess-main".to_string(),
            agent_id: String::new(),
        };
        let main_turn = engine
            .tracker
            .closed_turn_at(&main_agent, 10_000)
            .cloned()
            .expect("main turn retained");
        let cloned = engine.collect_overlapping_edits(&main_turn, 12_000);
        // Future edit (pre_ms = 80_100 > 12_000 + 60_000) is excluded by BTreeMap::range,
        // while overlapping other-root edit is cloned without main-loop root parsing.
        assert_eq!(cloned.len(), 2);
        let ids: Vec<&str> = cloned.iter().map(|e| e.tool_use_id.as_str()).collect();
        assert_eq!(ids, vec!["tu-b", "tu-a2"]);

        let resolved = resolve_other_edits(
            &cloned,
            main_turn.started_ms,
            Some(&root_a_str),
            &home,
            &[],
            12_000,
        );
        assert_eq!(resolved, vec![("src/a2.ts".to_string(), 10_700, 40_900)]);

        // Eviction drops indexed edits once turns leave the 60 s window even while still in_flight.
        let b_tid = (
            AgentKey {
                session_id: "sess-b".to_string(),
                agent_id: String::new(),
            },
            10_100,
        );
        let b_turn = engine
            .tracker
            .closed_turn_at(&b_tid.0, b_tid.1)
            .cloned()
            .unwrap();
        engine.turn_states.insert(
            b_tid,
            TurnBuildState {
                emitted_rev: 0,
                in_flight: true,
                dirty: false,
                latest_turn: b_turn,
            },
        );
        engine.expire_old_state(71_000);
        // sess-b (ended 10_500) and sess-a-2 (ended 11_000) expired at 71_000; sess-future remains.
        assert_eq!(engine.edit_index_len(), 1);
    }

    fn expected_input_root(repo_root: &std::path::Path) -> Option<String> {
        Some(canonical_path(&repo_root.to_string_lossy(), cfg!(windows)))
    }
}
