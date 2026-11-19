pub mod cache;
pub mod child;
pub mod marker;

use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use rocky_proto::pipe::ServerMsg;
use rocky_proto::translate::{
    InstallProgress, QuoteLang, QuoteTranslation, TranslateFailure, TranslatePair, TranslateStatus,
    quote_key,
};

use crate::guard::records::{CliRecord, read_cli};
use cache::{Cached, QuoteCache};
use child::{InstallEvent, InstallJob, RunEvent, RunJob, RunReply, RunRequest};

pub const MAX_PENDING: usize = 512;
pub const LAUNCH_RETRY: Duration = Duration::from_secs(30);

struct PendingQuote {
    quote_key: String,
    to: QuoteLang,
    text: String,
    cards: Vec<String>,
}

struct InFlightQuote {
    quote_key: String,
    to: QuoteLang,
    text: String,
    cards: Vec<String>,
}

#[derive(Default)]
struct RunShas {
    en: Option<String>,
    id: Option<String>,
}

impl RunShas {
    fn get(&self, to: QuoteLang) -> Option<&str> {
        match to {
            QuoteLang::En => self.en.as_deref(),
            QuoteLang::Id => self.id.as_deref(),
        }
    }

    fn set(&mut self, to: QuoteLang, sha: String) {
        match to {
            QuoteLang::En => self.en = Some(sha),
            QuoteLang::Id => self.id = Some(sha),
        }
    }
}

struct ActiveRun {
    job: RunJob,
    shas: RunShas,
    ok: usize,
    original: usize,
    failed: usize,
    dropped: usize,
}

struct ActiveInstall {
    pair: TranslatePair,
    job: InstallJob,
}

enum ActiveJob {
    Run(ActiveRun),
    Install(ActiveInstall),
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DetailTranslations {
    pub hits: Vec<QuoteTranslation>,
    pub pending: Vec<String>,
}

pub struct Translator {
    home: PathBuf,
    cache: QuoteCache,
    status: TranslateStatus,
    last_emitted_status: TranslateStatus,
    install_failure: Option<TranslateFailure>,
    engine_failed: bool,
    last_cli: Option<CliRecord>,
    launch_retry: Duration,
    next_launch_at: Option<Instant>,
    queue: VecDeque<PendingQuote>,
    in_flight: HashMap<String, InFlightQuote>,
    staged_later: Vec<ServerMsg>,
    ready_later: Vec<ServerMsg>,
    job: Option<ActiveJob>,
    log_lines: Vec<String>,
}

impl Translator {
    pub fn new(home: PathBuf) -> Self {
        Self::with_launch_retry(home, LAUNCH_RETRY)
    }

    pub fn with_launch_retry(home: PathBuf, launch_retry: Duration) -> Self {
        let mut translator = Self {
            cache: QuoteCache::new(home.clone()),
            home,
            status: TranslateStatus::default(),
            last_emitted_status: TranslateStatus::default(),
            install_failure: None,
            engine_failed: false,
            last_cli: None,
            launch_retry,
            next_launch_at: None,
            queue: VecDeque::new(),
            in_flight: HashMap::new(),
            staged_later: Vec::new(),
            ready_later: Vec::new(),
            job: None,
            log_lines: Vec::new(),
        };
        translator.recheck_from_disk();
        translator.last_emitted_status = translator.status.clone();
        translator
    }

    #[doc(hidden)]
    pub fn has_job(&self) -> bool {
        self.job.is_some()
    }

    #[doc(hidden)]
    pub fn pending_len(&self) -> usize {
        self.queue.len() + self.in_flight.len()
    }

    #[doc(hidden)]
    pub fn cache_loaded_targets(&self) -> usize {
        self.cache.loaded_targets()
    }

    pub fn status(&self) -> &TranslateStatus {
        &self.status
    }

    pub fn check(&mut self) -> Option<TranslateStatus> {
        let previous = self.status.clone();
        self.recheck_from_disk();
        (self.status != previous).then(|| self.status.clone())
    }

    pub fn on_detail(
        &mut self,
        enabled: bool,
        card_id: &str,
        to: QuoteLang,
        quotes: &[String],
    ) -> DetailTranslations {
        if !enabled {
            return DetailTranslations::default();
        }
        let pair = TranslatePair::to(to);
        let Some(sha) = marker::model_sha(&self.home, pair) else {
            return DetailTranslations::default();
        };

        let mut seen = HashSet::with_capacity(quotes.len());
        let mut detail = DetailTranslations::default();
        for text in quotes {
            if !seen.insert(text.as_str()) {
                continue;
            }
            let ckey = cache::cache_key(&sha, to, text);
            match self.cache.get(to, &ckey) {
                Some(Cached::Translated {
                    from,
                    text: translated,
                }) => {
                    detail.hits.push(QuoteTranslation {
                        quote_key: quote_key(text),
                        from,
                        text: translated,
                    });
                }
                Some(Cached::Original) => {}
                None => {
                    let qkey = quote_key(text);
                    if let Some(evicted) = self.enqueue_miss(card_id, to, &sha, text, &qkey) {
                        let removed_from_current = detail
                            .pending
                            .iter()
                            .position(|k| k == &evicted.quote_key)
                            .map(|idx| {
                                detail.pending.remove(idx);
                            })
                            .is_some();
                        for waiting_card in evicted.cards {
                            if removed_from_current && waiting_card == card_id {
                                continue;
                            }
                            self.staged_later.push(ServerMsg::QuoteSettled {
                                card_id: waiting_card,
                                quote_key: evicted.quote_key.clone(),
                                to: evicted.to,
                            });
                        }
                    }
                    detail.pending.push(qkey);
                }
            }
        }
        detail
    }

    pub fn push_later(&mut self, card_id: &str, items: Vec<QuoteTranslation>) {
        for item in items {
            self.staged_later.push(ServerMsg::QuoteTranslated {
                card_id: card_id.to_string(),
                item,
            });
        }
    }

    pub fn install(&mut self, enabled: bool, pair: TranslatePair) -> Result<(), &'static str> {
        if !enabled {
            return Err("disabled");
        }
        if self.job.is_some() {
            return Err("busy");
        }
        let Some(cli) = read_usable_cli(&self.home) else {
            self.last_cli = None;
            self.next_launch_at = None;
            self.engine_failed = true;
            self.refresh_failed();
            return Err("engine");
        };
        self.last_cli = Some(cli.clone());
        let Ok(job) = child::start_install(&cli, &self.home, pair, child::INSTALL_TIMEOUT) else {
            self.engine_failed = true;
            self.refresh_failed();
            return Err("engine");
        };
        self.next_launch_at = None;
        self.engine_failed = false;
        self.refresh_failed();
        self.job = Some(ActiveJob::Install(ActiveInstall { pair, job }));
        self.status.installing = Some(InstallProgress {
            pair,
            done_bytes: 0,
            total_bytes: 0,
        });
        Ok(())
    }

    pub fn remove(&mut self) -> Result<(), &'static str> {
        if self.job.is_some() {
            return Err("busy");
        }
        match fs::remove_dir_all(marker::translate_dir(&self.home)) {
            Ok(()) => {}
            Err(err) if err.kind() == io::ErrorKind::NotFound => {}
            Err(_) => return Err("remove failed"),
        }
        // Desk drops all translation state on remove/off, so queued/in-flight quotes clear
        // without emitting QuoteSettled.
        self.cache.clear();
        self.queue.clear();
        self.in_flight.clear();
        self.staged_later.clear();
        self.ready_later.clear();
        self.install_failure = None;
        self.next_launch_at = None;
        self.recheck_from_disk();
        Ok(())
    }

    pub fn service(&mut self, enabled: bool) -> Vec<ServerMsg> {
        let mut out = Vec::new();
        if !enabled {
            self.turn_off(&mut out);
            return out;
        }
        self.emit_status_if_changed(&mut out);
        self.drain_ready_later(&mut out);
        self.drain_active_job(&mut out);
        self.maybe_start_run(&mut out);
        // Promote staged overflow/eviction messages so they emit no earlier than the next loop
        // pass, giving the relay thread time to flush the CardDetail reply first. Ordering across
        // separate channels is best-effort, so the desk must accept pushes for a card whose detail
        // request is in flight.
        self.ready_later.append(&mut self.staged_later);
        self.emit_status_if_changed(&mut out);
        out
    }

    pub fn drain_log(&mut self) -> Vec<String> {
        std::mem::take(&mut self.log_lines)
    }

    fn refresh_failed(&mut self) {
        self.status.failed = if self.engine_failed {
            Some(TranslateFailure::Engine)
        } else {
            self.install_failure
        };
    }

    fn recheck_from_disk(&mut self) {
        self.status.ready = marker::ready_pairs(&self.home);
        let cli = read_usable_cli(&self.home);
        if cli != self.last_cli {
            self.last_cli = cli;
            self.next_launch_at = None;
            self.engine_failed = self.last_cli.is_none();
        } else if self.last_cli.is_none() {
            self.engine_failed = true;
        } else if self
            .next_launch_at
            .is_none_or(|retry_at| Instant::now() >= retry_at)
        {
            self.next_launch_at = None;
            self.engine_failed = false;
        }
        self.refresh_failed();
    }

    fn enqueue_miss(
        &mut self,
        card_id: &str,
        to: QuoteLang,
        current_sha: &str,
        text: &str,
        qkey: &str,
    ) -> Option<PendingQuote> {
        let in_flight_matches_sha = match &self.job {
            Some(ActiveJob::Run(run)) => run.shas.get(to) == Some(current_sha),
            _ => false,
        };
        if in_flight_matches_sha {
            let key = cache::cache_key(current_sha, to, text);
            if let Some(entry) = self.in_flight.get_mut(&key) {
                attach_card(&mut entry.cards, card_id);
                return None;
            }
        }
        if let Some(entry) = self
            .queue
            .iter_mut()
            .find(|entry| entry.to == to && entry.text == text)
        {
            attach_card(&mut entry.cards, card_id);
            return None;
        }
        let evicted = (self.queue.len() >= MAX_PENDING)
            .then(|| self.queue.pop_front())
            .flatten();
        self.queue.push_back(PendingQuote {
            quote_key: qkey.to_string(),
            to,
            text: text.to_string(),
            cards: vec![card_id.to_string()],
        });
        evicted
    }

    fn turn_off(&mut self, out: &mut Vec<ServerMsg>) {
        // Desk drops all translation state when off, so queued/in-flight quotes are cleared
        // without emitting QuoteSettled.
        self.job = None;
        self.queue.clear();
        self.in_flight.clear();
        self.staged_later.clear();
        self.ready_later.clear();
        self.cache.clear();
        self.status.installing = None;
        self.emit_status_if_changed(out);
    }

    fn drain_active_job(&mut self, out: &mut Vec<ServerMsg>) {
        match self.job.take() {
            None => {}
            Some(ActiveJob::Run(mut run)) => {
                if !self.drain_run_events(&mut run, out) {
                    self.job = Some(ActiveJob::Run(run));
                }
            }
            Some(ActiveJob::Install(mut install)) => {
                if !self.drain_install_events(&mut install, out) {
                    self.job = Some(ActiveJob::Install(install));
                }
            }
        }
    }

    fn drain_run_events(&mut self, run: &mut ActiveRun, out: &mut Vec<ServerMsg>) -> bool {
        while let Some(event) = run.job.try_next() {
            match event {
                RunEvent::Reply(reply) => self.handle_run_reply(run, reply, out),
                RunEvent::Done => {
                    let dropped = run.dropped + self.in_flight.len();
                    for (_, entry) in self.in_flight.drain() {
                        emit_settled(out, entry.cards, &entry.quote_key, entry.to);
                    }
                    self.log_lines.push(format!(
                        "translate run: {} ok, {} original, {} failed, {} dropped",
                        run.ok, run.original, run.failed, dropped
                    ));
                    return true;
                }
            }
        }
        false
    }

    fn valid_reply_cache_key(&self, run: &ActiveRun, to: QuoteLang, text: &str) -> Option<String> {
        let started_sha = run.shas.get(to)?;
        let current_sha = marker::model_sha(&self.home, TranslatePair::to(to))?;
        (current_sha == started_sha).then(|| cache::cache_key(started_sha, to, text))
    }

    fn handle_run_reply(&mut self, run: &mut ActiveRun, reply: RunReply, out: &mut Vec<ServerMsg>) {
        match reply {
            RunReply::Translated { key, from, text } => {
                let Some(entry) = self.in_flight.remove(&key) else {
                    return;
                };
                if from != entry.to.other() {
                    run.failed += 1;
                    emit_settled(out, entry.cards, &entry.quote_key, entry.to);
                    return;
                }
                let Some(ckey) = self.valid_reply_cache_key(run, entry.to, &entry.text) else {
                    run.dropped += 1;
                    emit_settled(out, entry.cards, &entry.quote_key, entry.to);
                    return;
                };
                run.ok += 1;
                let _ = self.cache.put(
                    entry.to,
                    &ckey,
                    &Cached::Translated {
                        from,
                        text: text.clone(),
                    },
                );
                for card_id in entry.cards {
                    out.push(ServerMsg::QuoteTranslated {
                        card_id,
                        item: QuoteTranslation {
                            quote_key: entry.quote_key.clone(),
                            from,
                            text: text.clone(),
                        },
                    });
                }
            }
            RunReply::Original { key } => {
                let Some(entry) = self.in_flight.remove(&key) else {
                    return;
                };
                let Some(ckey) = self.valid_reply_cache_key(run, entry.to, &entry.text) else {
                    run.dropped += 1;
                    emit_settled(out, entry.cards, &entry.quote_key, entry.to);
                    return;
                };
                run.original += 1;
                let _ = self.cache.put(entry.to, &ckey, &Cached::Original);
                emit_settled(out, entry.cards, &entry.quote_key, entry.to);
            }
            RunReply::Failed { key } => {
                if let Some(entry) = self.in_flight.remove(&key) {
                    run.failed += 1;
                    emit_settled(out, entry.cards, &entry.quote_key, entry.to);
                }
            }
        }
    }

    fn drain_install_events(
        &mut self,
        install: &mut ActiveInstall,
        out: &mut Vec<ServerMsg>,
    ) -> bool {
        while let Some(event) = install.job.try_next() {
            match event {
                InstallEvent::Progress {
                    done_bytes,
                    total_bytes,
                } => {
                    self.status.installing = Some(InstallProgress {
                        pair: install.pair,
                        done_bytes,
                        total_bytes,
                    });
                    self.emit_status_if_changed(out);
                }
                InstallEvent::Finished(result) => {
                    self.status.installing = None;
                    match result {
                        Ok(()) => {
                            self.install_failure = None;
                            self.recheck_from_disk();
                        }
                        Err(TranslateFailure::Engine) => {
                            self.engine_failed = true;
                            self.status.ready = marker::ready_pairs(&self.home);
                            self.refresh_failed();
                        }
                        Err(failure) => {
                            self.install_failure = Some(failure);
                            self.recheck_from_disk();
                        }
                    }
                    self.emit_status_if_changed(out);
                    return true;
                }
            }
        }
        false
    }

    fn drain_ready_later(&mut self, out: &mut Vec<ServerMsg>) {
        out.append(&mut self.ready_later);
    }

    fn maybe_start_run(&mut self, out: &mut Vec<ServerMsg>) {
        if self.job.is_some() || self.queue.is_empty() {
            return;
        }
        if self
            .next_launch_at
            .is_some_and(|retry_at| Instant::now() < retry_at)
        {
            return;
        }
        self.next_launch_at = None;
        let Some(cli) = read_usable_cli(&self.home) else {
            self.last_cli = None;
            self.engine_failed = true;
            self.refresh_failed();
            self.next_launch_at = Some(Instant::now() + self.launch_retry);
            return;
        };
        self.last_cli = Some(cli.clone());
        self.engine_failed = false;
        self.refresh_failed();

        let mut shas = RunShas::default();
        let mut checked_en = false;
        let mut checked_id = false;
        let mut requests = Vec::new();
        let mut batch = Vec::new();

        while requests.len() < child::MAX_RUN_QUOTES {
            let Some(item) = self.queue.pop_front() else {
                break;
            };
            let sha = match item.to {
                QuoteLang::En => {
                    if !checked_en {
                        checked_en = true;
                        if let Some(sha) = marker::model_sha(&self.home, TranslatePair::IdEn) {
                            shas.set(QuoteLang::En, sha);
                        }
                    }
                    shas.get(QuoteLang::En)
                }
                QuoteLang::Id => {
                    if !checked_id {
                        checked_id = true;
                        if let Some(sha) = marker::model_sha(&self.home, TranslatePair::EnId) {
                            shas.set(QuoteLang::Id, sha);
                        }
                    }
                    shas.get(QuoteLang::Id)
                }
            };
            let Some(sha) = sha else {
                emit_settled(out, item.cards, &item.quote_key, item.to);
                continue;
            };
            let key = cache::cache_key(sha, item.to, &item.text);
            match self.cache.get(item.to, &key) {
                Some(Cached::Translated { from, text }) => {
                    for card_id in item.cards {
                        out.push(ServerMsg::QuoteTranslated {
                            card_id,
                            item: QuoteTranslation {
                                quote_key: item.quote_key.clone(),
                                from,
                                text: text.clone(),
                            },
                        });
                    }
                }
                Some(Cached::Original) => {
                    emit_settled(out, item.cards, &item.quote_key, item.to);
                }
                None => {
                    requests.push(RunRequest {
                        key: key.clone(),
                        to: item.to,
                        text: item.text.clone(),
                    });
                    batch.push((key, item));
                }
            }
        }

        if requests.is_empty() {
            return;
        }

        match child::start_run(&cli, &self.home, &requests, child::RUN_TIMEOUT) {
            Ok(job) => {
                for (key, item) in batch {
                    self.in_flight.insert(
                        key,
                        InFlightQuote {
                            quote_key: item.quote_key,
                            to: item.to,
                            text: item.text,
                            cards: item.cards,
                        },
                    );
                }
                self.job = Some(ActiveJob::Run(ActiveRun {
                    job,
                    shas,
                    ok: 0,
                    original: 0,
                    failed: 0,
                    dropped: 0,
                }));
            }
            Err(err) => {
                for (_, item) in batch.into_iter().rev() {
                    self.queue.push_front(item);
                }
                self.engine_failed = true;
                self.refresh_failed();
                self.next_launch_at = Some(Instant::now() + self.launch_retry);
                self.log_lines.push(format!(
                    "translate run launch failed: {} quotes, {:?}",
                    requests.len(),
                    err.kind()
                ));
            }
        }
    }

    fn emit_status_if_changed(&mut self, out: &mut Vec<ServerMsg>) {
        if self.status != self.last_emitted_status {
            self.last_emitted_status = self.status.clone();
            out.push(ServerMsg::Translate {
                status: self.status.clone(),
            });
        }
    }
}

fn read_usable_cli(home: &Path) -> Option<CliRecord> {
    let cli = read_cli(home)?;
    fs::metadata(&cli.node)
        .is_ok_and(|meta| meta.is_file())
        .then_some(cli)
}

fn emit_settled(out: &mut Vec<ServerMsg>, cards: Vec<String>, quote_key: &str, to: QuoteLang) {
    for card_id in cards {
        out.push(ServerMsg::QuoteSettled {
            card_id,
            quote_key: quote_key.to_string(),
            to,
        });
    }
}

fn attach_card(cards: &mut Vec<String>, card_id: &str) {
    if !cards.iter().any(|existing| existing == card_id) {
        cards.push(card_id.to_string());
    }
}

#[cfg(test)]
mod tests {
    use rocky_proto::paths::cli_record_path;
    use tempfile::TempDir;

    use super::*;

    const TEST_SHA: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn write_ready_id_en(home: &Path) {
        let engine = marker::engine_dir(home);
        fs::create_dir_all(&engine).unwrap();
        fs::write(engine.join("bergamot.js"), b"x").unwrap();
        fs::write(
            engine.join("installed.json"),
            r#"{"v":1,"files":[{"name":"bergamot.js","size":1}]}"#,
        )
        .unwrap();

        let model = marker::model_dir(home, TranslatePair::IdEn);
        fs::create_dir_all(&model).unwrap();
        fs::write(model.join("model.bin"), b"m").unwrap();
        fs::write(
            model.join("installed.json"),
            format!(
                r#"{{"v":1,"model_sha256":"{TEST_SHA}","files":[{{"name":"model.bin","size":1}}]}}"#
            ),
        )
        .unwrap();
    }

    fn write_valid_cli(home: &Path) {
        let node = home.join("fake-node");
        fs::write(&node, b"x").unwrap();
        let path = cli_record_path(home);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let json = serde_json::json!({
            "v": 1,
            "node": node.to_string_lossy(),
            "entry": home.join("index.js").to_string_lossy(),
            "version": "1.0.0",
        });
        fs::write(path, json.to_string()).unwrap();
    }

    #[test]
    fn queue_caps_at_max_pending_dropping_oldest() {
        let home = TempDir::new().unwrap();
        write_ready_id_en(home.path());
        let mut translator = Translator::new(home.path().to_path_buf());

        for i in 0..(MAX_PENDING + 3) {
            translator.on_detail(true, "c1", QuoteLang::En, &[format!("quote-{i}")]);
        }
        assert_eq!(translator.queue.len(), MAX_PENDING);
        assert_eq!(translator.queue.front().unwrap().text, "quote-3");
        assert_eq!(
            translator.queue.back().unwrap().text,
            format!("quote-{}", MAX_PENDING + 2)
        );
        // Evicted quotes settle on the next pass rather than silently vanishing.
        assert!(translator.service(true).is_empty());
        let settled = translator.service(true);
        assert_eq!(
            settled,
            vec![
                ServerMsg::QuoteSettled {
                    card_id: "c1".to_string(),
                    quote_key: quote_key("quote-0"),
                    to: QuoteLang::En,
                },
                ServerMsg::QuoteSettled {
                    card_id: "c1".to_string(),
                    quote_key: quote_key("quote-1"),
                    to: QuoteLang::En,
                },
                ServerMsg::QuoteSettled {
                    card_id: "c1".to_string(),
                    quote_key: quote_key("quote-2"),
                    to: QuoteLang::En,
                },
            ]
        );

        // Attaching another card to an already-pending quote does not evict anything.
        translator.on_detail(true, "c2", QuoteLang::En, &["quote-3".to_string()]);
        assert_eq!(translator.queue.len(), MAX_PENDING);
        assert_eq!(translator.queue.front().unwrap().text, "quote-3");
        assert_eq!(translator.queue.front().unwrap().cards, vec!["c1", "c2"]);
    }

    #[test]
    fn settled_reply_names_the_target_language() {
        let home = TempDir::new().unwrap();
        write_ready_id_en(home.path());
        let mut translator = Translator::new(home.path().to_path_buf());

        let text = "Already English.";
        let detail = translator.on_detail(true, "c1", QuoteLang::En, &[text.to_string()]);
        assert_eq!(detail.pending, vec![quote_key(text)]);

        let pending = translator.queue.pop_front().unwrap();
        let key = cache::cache_key(TEST_SHA, pending.to, &pending.text);
        translator.in_flight.insert(
            key.clone(),
            InFlightQuote {
                quote_key: pending.quote_key,
                to: pending.to,
                text: pending.text,
                cards: pending.cards,
            },
        );
        let mut shas = RunShas::default();
        shas.set(QuoteLang::En, TEST_SHA.to_string());
        translator.job = Some(ActiveJob::Run(ActiveRun {
            job: RunJob::from_events([RunEvent::Reply(RunReply::Original { key }), RunEvent::Done]),
            shas,
            ok: 0,
            original: 0,
            failed: 0,
            dropped: 0,
        }));

        let out = translator.service(true);
        assert_eq!(
            out,
            vec![ServerMsg::QuoteSettled {
                card_id: "c1".into(),
                quote_key: quote_key(text),
                to: QuoteLang::En,
            }]
        );
    }

    #[test]
    fn single_detail_over_max_pending_drops_evicted_from_pending() {
        let home = TempDir::new().unwrap();
        write_ready_id_en(home.path());
        let mut translator = Translator::new(home.path().to_path_buf());

        let quotes: Vec<String> = (0..(MAX_PENDING + 2))
            .map(|i| format!("single-{i}"))
            .collect();
        let detail = translator.on_detail(true, "c1", QuoteLang::En, &quotes);
        assert!(detail.hits.is_empty());
        assert_eq!(detail.pending.len(), MAX_PENDING);
        assert_eq!(detail.pending[0], quote_key("single-2"));
        assert!(translator.service(true).is_empty());
        assert!(translator.service(true).is_empty());
    }

    #[test]
    fn duplicate_quotes_in_single_detail_count_once() {
        let home = TempDir::new().unwrap();
        write_ready_id_en(home.path());
        let mut translator = Translator::new(home.path().to_path_buf());

        let quotes = vec![
            "dup".to_string(),
            "dup".to_string(),
            "other".to_string(),
            "dup".to_string(),
        ];
        let detail = translator.on_detail(true, "c1", QuoteLang::En, &quotes);
        assert!(detail.hits.is_empty());
        assert_eq!(detail.pending, vec![quote_key("dup"), quote_key("other")]);
        assert_eq!(translator.queue.len(), 2);
        assert_eq!(translator.queue[0].text, "dup");
        assert_eq!(translator.queue[0].cards, vec!["c1"]);
        assert_eq!(translator.queue[1].text, "other");
    }

    #[test]
    fn check_persists_install_failures_and_clears_engine_when_fixed() {
        let home = TempDir::new().unwrap();
        let mut translator = Translator::new(home.path().to_path_buf());
        assert_eq!(translator.status().failed, Some(TranslateFailure::Engine));

        // Simulate an install checksum failure while cli is present.
        write_valid_cli(home.path());
        assert_eq!(
            translator.check(),
            Some(TranslateStatus {
                ready: Vec::new(),
                installing: None,
                failed: None,
            })
        );

        translator.install_failure = Some(TranslateFailure::Checksum);
        translator.refresh_failed();
        assert_eq!(translator.check(), None);
        assert_eq!(translator.status().failed, Some(TranslateFailure::Checksum));

        // Temporary CLI loss surfaces Engine without erasing Checksum.
        fs::remove_file(cli_record_path(home.path())).unwrap();
        assert_eq!(
            translator.check(),
            Some(TranslateStatus {
                ready: Vec::new(),
                installing: None,
                failed: Some(TranslateFailure::Engine),
            })
        );
        write_valid_cli(home.path());
        assert_eq!(
            translator.check(),
            Some(TranslateStatus {
                ready: Vec::new(),
                installing: None,
                failed: Some(TranslateFailure::Checksum),
            })
        );

        // remove() clears Checksum; missing CLI still reports Engine.
        fs::remove_file(cli_record_path(home.path())).unwrap();
        assert_eq!(translator.remove(), Ok(()));
        assert_eq!(translator.status().failed, Some(TranslateFailure::Engine));
    }

    #[test]
    fn missing_or_unspawnable_cli_keeps_pending_queue() {
        let home = TempDir::new().unwrap();
        write_ready_id_en(home.path());
        let mut translator = Translator::new(home.path().to_path_buf());

        let detail = translator.on_detail(true, "c1", QuoteLang::En, &["Merah.".to_string()]);
        assert!(detail.hits.is_empty());
        assert_eq!(detail.pending, vec![quote_key("Merah.")]);
        let msgs = translator.service(true);
        assert!(msgs.is_empty());
        assert_eq!(translator.queue.len(), 1);
        assert_eq!(translator.status().failed, Some(TranslateFailure::Engine));
        assert!(translator.next_launch_at.is_some());

        // While missing CLI is in cooldown, writing cli.json without check() does not re-read on every pass.
        write_valid_cli(home.path());
        for _ in 0..10 {
            assert!(translator.service(true).is_empty());
        }
        assert!(translator.drain_log().is_empty());
        assert_eq!(translator.queue.len(), 1);

        // check() detects the new CLI record, clears cooldown, and lets the next pass try launching.
        let updated = translator.check().expect("cli appeared");
        assert_eq!(updated.failed, None);
        let _ = translator.service(true);
        assert_eq!(translator.queue.len(), 1);
        assert_eq!(translator.status().failed, Some(TranslateFailure::Engine));
        assert_eq!(translator.drain_log().len(), 1);
    }

    fn write_cli_with_node(home: &Path, node_name: &str) {
        let node = home.join(node_name);
        fs::write(&node, b"x").unwrap();
        let path = cli_record_path(home);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let json = serde_json::json!({
            "v": 1,
            "node": node.to_string_lossy(),
            "entry": home.join("index.js").to_string_lossy(),
            "version": "1.0.0",
        });
        fs::write(path, json.to_string()).unwrap();
    }

    #[test]
    fn launch_error_paces_retries_and_check_clears_when_cli_changes() {
        let home = TempDir::new().unwrap();
        write_ready_id_en(home.path());
        write_valid_cli(home.path());
        let mut translator = Translator::new(home.path().to_path_buf());

        let detail = translator.on_detail(true, "c1", QuoteLang::En, &["Merah.".to_string()]);
        assert!(detail.hits.is_empty());
        assert_eq!(detail.pending, vec![quote_key("Merah.")]);

        for _ in 0..20 {
            let _ = translator.service(true);
        }
        let logs = translator.drain_log();
        assert_eq!(logs.len(), 1);
        assert!(logs[0].starts_with("translate run launch failed: 1 quotes, "));
        assert_eq!(translator.queue.len(), 1);
        assert_eq!(translator.status().failed, Some(TranslateFailure::Engine));

        // Unchanged CLI record does not clear backoff or flip status on check().
        assert_eq!(translator.check(), None);
        assert!(translator.service(true).is_empty());
        assert!(translator.drain_log().is_empty());

        // Changed CLI record clears backoff early and lets the next pass retry once.
        write_cli_with_node(home.path(), "fake-node-2");
        let updated = translator.check().expect("changed cli clears engine error");
        assert_eq!(updated.failed, None);
        assert!(translator.next_launch_at.is_none());

        let _ = translator.service(true);
        assert_eq!(translator.drain_log().len(), 1);
        assert_eq!(translator.queue.len(), 1);
        assert_eq!(translator.status().failed, Some(TranslateFailure::Engine));
    }

    #[test]
    fn launch_retry_resumes_once_backoff_expires() {
        let home = TempDir::new().unwrap();
        write_ready_id_en(home.path());
        write_valid_cli(home.path());
        let mut translator =
            Translator::with_launch_retry(home.path().to_path_buf(), Duration::from_millis(60));

        let detail = translator.on_detail(true, "c1", QuoteLang::En, &["Merah.".to_string()]);
        assert!(detail.hits.is_empty());
        assert_eq!(detail.pending, vec![quote_key("Merah.")]);
        let _ = translator.service(true);
        assert_eq!(translator.drain_log().len(), 1);

        // Passes within the backoff window do not retry.
        for _ in 0..10 {
            let _ = translator.service(true);
        }
        assert!(translator.drain_log().is_empty());

        std::thread::sleep(Duration::from_millis(80));
        let _ = translator.service(true);
        assert_eq!(translator.drain_log().len(), 1);
        assert_eq!(translator.queue.len(), 1);
    }
}
