//! Single-worker read-only query executor for `cards`, `card_detail`, and `block_diff`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::mpsc::{self, SyncSender};
use std::thread::{self, JoinHandle};

use rocky_proto::pipe::ServerMsg;

use crate::cards::detail::{
    build_block_diff, build_block_diff_with, build_card_detail, build_card_detail_with,
    build_cards_reply,
};
use crate::cards::storage::CardStore;
use crate::cards::store::ObjectRead;

/// Custom object reader injected by tests into [`CardQueryLoop::new_with_object_reader`].
pub type QueryObjectReader = Arc<dyn Fn(&str) -> ObjectRead + Send + Sync>;

enum QueryKind {
    Cards {
        id: u64,
        query: Option<String>,
        before: Option<String>,
        limit: u32,
    },
    CardDetail {
        id: u64,
        card_id: String,
    },
    BlockDiff {
        id: u64,
        card_id: String,
        seq: u32,
        page: u32,
    },
}

impl QueryKind {
    fn id(&self) -> u64 {
        match self {
            QueryKind::Cards { id, .. }
            | QueryKind::CardDetail { id, .. }
            | QueryKind::BlockDiff { id, .. } => *id,
        }
    }
}

struct QueryJob {
    token: u64,
    kind: QueryKind,
}

struct QueryDone {
    token: u64,
    reply: ServerMsg,
}

/// Asynchronous query supervisor that runs card reads, detail snippet assembly,
/// block diffs, and frame sizing on one dedicated worker thread.
pub struct CardQueryLoop {
    home: PathBuf,
    object_reader: Option<QueryObjectReader>,
    next_token: u64,
    replies: HashMap<u64, SyncSender<ServerMsg>>,
    job_tx: Option<mpsc::Sender<QueryJob>>,
    job_rx: Option<mpsc::Receiver<QueryJob>>,
    res_tx: Option<mpsc::Sender<QueryDone>>,
    res_rx: mpsc::Receiver<QueryDone>,
    worker: Option<JoinHandle<()>>,
}

impl CardQueryLoop {
    /// Creates a query loop rooted at `home` (`~/.rocky`). The worker spawns lazily on first request.
    pub fn new(home: PathBuf) -> Self {
        Self::with_optional_reader(home, None)
    }

    /// Creates a query loop with a custom object reader for tests.
    #[doc(hidden)]
    pub fn new_with_object_reader(home: PathBuf, reader: QueryObjectReader) -> Self {
        Self::with_optional_reader(home, Some(reader))
    }

    fn with_optional_reader(home: PathBuf, object_reader: Option<QueryObjectReader>) -> Self {
        let (job_tx, job_rx) = mpsc::channel();
        let (res_tx, res_rx) = mpsc::channel();
        Self {
            home,
            object_reader,
            next_token: 0,
            replies: HashMap::new(),
            job_tx: Some(job_tx),
            job_rx: Some(job_rx),
            res_tx: Some(res_tx),
            res_rx,
            worker: None,
        }
    }

    /// Queues a `cards` page request to run on the query worker.
    pub fn cards(
        &mut self,
        id: u64,
        query: Option<String>,
        before: Option<String>,
        limit: u32,
        reply: SyncSender<ServerMsg>,
    ) {
        self.submit(
            QueryKind::Cards {
                id,
                query,
                before,
                limit,
            },
            reply,
        );
    }

    /// Queues a `card_detail` request to run on the query worker.
    pub fn card_detail(&mut self, id: u64, card_id: String, reply: SyncSender<ServerMsg>) {
        self.submit(QueryKind::CardDetail { id, card_id }, reply);
    }

    /// Queues a `block_diff` page request to run on the query worker.
    pub fn block_diff(
        &mut self,
        id: u64,
        card_id: String,
        seq: u32,
        page: u32,
        reply: SyncSender<ServerMsg>,
    ) {
        self.submit(
            QueryKind::BlockDiff {
                id,
                card_id,
                seq,
                page,
            },
            reply,
        );
    }

    /// Forwards every completed query reply back through its waiting client channel.
    pub fn service(&mut self) {
        while let Ok(done) = self.res_rx.try_recv() {
            if let Some(reply) = self.replies.remove(&done.token) {
                let _ = reply.send(done.reply);
            }
        }
    }

    fn ensure_started(&mut self) {
        let (Some(job_rx), Some(res_tx)) = (self.job_rx.take(), self.res_tx.take()) else {
            return;
        };
        let home = self.home.clone();
        let reader = self.object_reader.clone();
        let handle = thread::Builder::new()
            .name("rocky-card-query".to_string())
            .spawn(move || query_worker_loop(home, job_rx, res_tx, reader))
            .expect("spawn card query worker thread");
        self.worker = Some(handle);
    }

    fn submit(&mut self, kind: QueryKind, reply: SyncSender<ServerMsg>) {
        self.ensure_started();
        self.next_token = self.next_token.wrapping_add(1);
        let token = self.next_token;
        let id = kind.id();
        self.replies.insert(token, reply);
        let send_failed = self
            .job_tx
            .as_ref()
            .is_none_or(|tx| tx.send(QueryJob { token, kind }).is_err());
        if send_failed && let Some(reply) = self.replies.remove(&token) {
            let _ = reply.send(ServerMsg::Ack {
                id,
                ok: false,
                error: Some("query worker unavailable".to_string()),
            });
        }
    }
}

impl Drop for CardQueryLoop {
    fn drop(&mut self) {
        self.job_tx.take();
        self.res_tx.take();
        if let Some(handle) = self.worker.take() {
            let _ = handle.join();
        }
    }
}

fn query_worker_loop(
    home: PathBuf,
    job_rx: mpsc::Receiver<QueryJob>,
    res_tx: mpsc::Sender<QueryDone>,
    object_reader: Option<QueryObjectReader>,
) {
    // Dedicated read-only CardStore instance with its own cache; never calls append.
    let mut store = CardStore::new(home.clone());
    while let Ok(job) = job_rx.recv() {
        let reply = run_query(&mut store, &home, job.kind, object_reader.as_deref());
        if res_tx
            .send(QueryDone {
                token: job.token,
                reply,
            })
            .is_err()
        {
            break;
        }
    }
}

fn run_query(
    store: &mut CardStore,
    home: &Path,
    kind: QueryKind,
    object_reader: Option<&(dyn Fn(&str) -> ObjectRead + Send + Sync)>,
) -> ServerMsg {
    match kind {
        QueryKind::Cards {
            id,
            query,
            before,
            limit,
        } => {
            let (items, next) = store.page(query.as_deref(), before.as_deref(), limit as usize);
            build_cards_reply(id, items, next)
        }
        QueryKind::CardDetail { id, card_id } => match store.get(&card_id) {
            Some(card) => match object_reader {
                Some(read_obj) => build_card_detail_with(id, &card, |sha| read_obj(sha)),
                None => build_card_detail(id, &card, home),
            },
            None => ServerMsg::Ack {
                id,
                ok: false,
                error: Some("card not found".to_string()),
            },
        },
        QueryKind::BlockDiff {
            id,
            card_id,
            seq,
            page,
        } => match store.get(&card_id) {
            Some(card) => match object_reader {
                Some(read_obj) => build_block_diff_with(id, &card, seq, page, |sha| read_obj(sha)),
                None => build_block_diff(id, &card, seq, page, home),
            },
            None => ServerMsg::BlockDiff {
                id,
                lines: Vec::new(),
                page: 0,
                pages: 0,
                missing: true,
            },
        },
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::time::Duration;

    use rocky_proto::cards::{
        Block, BlockSymbol, BlockVia, CARD_VERSION, Card, CardStatus, Coverage, CoverageState,
        Importance, SymbolKind,
    };
    use rocky_proto::paths::{canonical_path, listening_store_dir, repo_id};

    use super::*;

    fn wait_reply(rx: &mpsc::Receiver<ServerMsg>, queries: &mut CardQueryLoop) -> ServerMsg {
        for _ in 0..200 {
            queries.service();
            if let Ok(msg) = rx.try_recv() {
                return msg;
            }
            thread::sleep(Duration::from_millis(5));
        }
        panic!("timed out waiting for query reply");
    }

    #[test]
    fn query_worker_serves_cards_detail_and_diff_from_read_only_store() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().to_path_buf();
        let repo = tmp.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        let canon = canonical_path(&repo.to_string_lossy(), cfg!(windows));
        let rid = repo_id(&canon, cfg!(windows));
        let objects = listening_store_dir(&home, &rid).join("objects");
        fs::create_dir_all(&objects).unwrap();

        let sha_a = "1".repeat(64);
        let sha_b = "2".repeat(64);
        fs::write(objects.join(&sha_a), "fn demo() {\n    1\n}\n").unwrap();
        fs::write(objects.join(&sha_b), "fn demo() {\n    2\n}\n").unwrap();

        let card = Card {
            v: CARD_VERSION,
            card_id: "card-q-1".to_string(),
            rev: 1,
            repo_id: rid,
            root: canon,
            main_root: None,
            branch: Some("main".to_string()),
            session_id: "s1".to_string(),
            agent_id: String::new(),
            agent_type: "claude".to_string(),
            parent_card_id: None,
            started_ms: 1_000,
            ended_ms: Some(2_000),
            status: CardStatus::Done,
            prompt: "demo".to_string(),
            prompt_truncated: false,
            importance: Importance::Medium,
            blocks: vec![Block {
                seq: 1,
                path: "src/lib.rs".to_string(),
                symbol: Some(BlockSymbol {
                    kind: SymbolKind::Function,
                    name: "demo".to_string(),
                    container: None,
                    exported: true,
                    nth: 0,
                }),
                labels: Vec::new(),
                importance: Importance::Medium,
                via: BlockVia::Edit,
                tool_use_ids: vec!["tu-1".to_string()],
                bash: None,
                before: Some(sha_a),
                after: Some(sha_b),
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
        };

        let mut writer = CardStore::new(home.clone());
        writer.append(&card).unwrap();

        let mut queries = CardQueryLoop::new(home);

        let (tx, rx) = mpsc::sync_channel(1);
        queries.cards(1, None, None, 20, tx);
        let ServerMsg::Cards { id: 1, items, .. } = wait_reply(&rx, &mut queries) else {
            panic!("expected ServerMsg::Cards");
        };
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].card_id, "card-q-1");

        let (tx, rx) = mpsc::sync_channel(1);
        queries.card_detail(2, "card-q-1".to_string(), tx);
        let ServerMsg::CardDetail {
            id: 2, snippets, ..
        } = wait_reply(&rx, &mut queries)
        else {
            panic!("expected ServerMsg::CardDetail");
        };
        assert_eq!(snippets.len(), 1);

        let (tx, rx) = mpsc::sync_channel(1);
        queries.block_diff(3, "card-q-1".to_string(), 1, 0, tx);
        let ServerMsg::BlockDiff {
            id: 3,
            missing: false,
            lines,
            ..
        } = wait_reply(&rx, &mut queries)
        else {
            panic!("expected ServerMsg::BlockDiff");
        };
        assert!(!lines.is_empty());

        let (tx, rx) = mpsc::sync_channel(1);
        queries.card_detail(4, "missing-card".to_string(), tx);
        assert_eq!(
            wait_reply(&rx, &mut queries),
            ServerMsg::Ack {
                id: 4,
                ok: false,
                error: Some("card not found".to_string()),
            }
        );

        let (tx, rx) = mpsc::sync_channel(1);
        queries.block_diff(5, "missing-card".to_string(), 1, 0, tx);
        assert_eq!(
            wait_reply(&rx, &mut queries),
            ServerMsg::BlockDiff {
                id: 5,
                lines: Vec::new(),
                page: 0,
                pages: 0,
                missing: true,
            }
        );
    }
}
