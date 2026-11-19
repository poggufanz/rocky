pub mod cache;
pub mod child;
pub mod marker;

use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use rocky_proto::pipe::ServerMsg;
use rocky_proto::translate::{
    InstallProgress, QuoteLang, QuoteTranslation, TranslateFailure, TranslatePair, TranslateStatus,
    quote_key,
};

use crate::guard::records::{CliRecord, read_cli};
use cache::{Cached, QuoteCache};
use child::{InstallEvent, InstallJob, RunEvent, RunJob, RunReply, RunRequest};

pub const MAX_PENDING: usize = 512;

struct PendingQuote {
    cache_key: String,
    quote_key: String,
    to: QuoteLang,
    text: String,
    cards: Vec<String>,
}

struct InFlightQuote {
    quote_key: String,
    to: QuoteLang,
    cards: Vec<String>,
}

struct ActiveRun {
    job: RunJob,
    ok: usize,
    original: usize,
    failed: usize,
}

struct ActiveInstall {
    pair: TranslatePair,
    job: InstallJob,
}

enum ActiveJob {
    Run(ActiveRun),
    Install(ActiveInstall),
}

pub struct Translator {
    home: PathBuf,
    cache: QuoteCache,
    status: TranslateStatus,
    last_emitted_status: TranslateStatus,
    queue: VecDeque<PendingQuote>,
    in_flight: HashMap<String, InFlightQuote>,
    pushed_later: Vec<(String, QuoteTranslation)>,
    job: Option<ActiveJob>,
    log_lines: Vec<String>,
}

impl Translator {
    pub fn new(home: PathBuf) -> Self {
        let mut translator = Self {
            cache: QuoteCache::new(home.clone()),
            home,
            status: TranslateStatus::default(),
            last_emitted_status: TranslateStatus::default(),
            queue: VecDeque::new(),
            in_flight: HashMap::new(),
            pushed_later: Vec::new(),
            job: None,
            log_lines: Vec::new(),
        };
        translator.recheck_from_disk();
        translator.last_emitted_status = translator.status.clone();
        translator
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
    ) -> Vec<QuoteTranslation> {
        if !enabled {
            return Vec::new();
        }
        let pair = TranslatePair::to(to);
        let Some(sha) = marker::model_sha(&self.home, pair) else {
            return Vec::new();
        };

        let mut seen = HashSet::with_capacity(quotes.len());
        let mut hits = Vec::new();
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
                    hits.push(QuoteTranslation {
                        quote_key: quote_key(text),
                        from,
                        text: translated,
                    });
                }
                Some(Cached::Original) => {}
                None => self.enqueue_miss(card_id, to, ckey, text),
            }
        }
        hits
    }

    pub fn push_later(&mut self, card_id: &str, items: Vec<QuoteTranslation>) {
        for item in items {
            self.pushed_later.push((card_id.to_string(), item));
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
            self.status.failed = Some(TranslateFailure::Engine);
            return Err("engine");
        };
        let Ok(job) = child::start_install(&cli, &self.home, pair, child::INSTALL_TIMEOUT) else {
            self.status.failed = Some(TranslateFailure::Engine);
            return Err("engine");
        };
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
        self.cache.clear();
        self.queue.clear();
        self.in_flight.clear();
        self.pushed_later.clear();
        self.status.failed = None;
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
        self.drain_active_job(&mut out);
        self.drain_pushed_later(&mut out);
        self.maybe_start_run();
        self.emit_status_if_changed(&mut out);
        out
    }

    pub fn drain_log(&mut self) -> Vec<String> {
        std::mem::take(&mut self.log_lines)
    }

    fn recheck_from_disk(&mut self) {
        self.status.ready = marker::ready_pairs(&self.home);
        if read_usable_cli(&self.home).is_none() {
            self.status.failed = Some(TranslateFailure::Engine);
        } else if self.status.failed == Some(TranslateFailure::Engine) {
            self.status.failed = None;
        }
    }

    fn enqueue_miss(&mut self, card_id: &str, to: QuoteLang, cache_key: String, text: &str) {
        if let Some(entry) = self.in_flight.get_mut(&cache_key) {
            attach_card(&mut entry.cards, card_id);
            return;
        }
        if let Some(entry) = self
            .queue
            .iter_mut()
            .find(|entry| entry.cache_key == cache_key)
        {
            attach_card(&mut entry.cards, card_id);
            return;
        }
        if self.queue.len() >= MAX_PENDING {
            self.queue.pop_front();
        }
        self.queue.push_back(PendingQuote {
            cache_key,
            quote_key: quote_key(text),
            to,
            text: text.to_string(),
            cards: vec![card_id.to_string()],
        });
    }

    fn turn_off(&mut self, out: &mut Vec<ServerMsg>) {
        self.job = None;
        self.queue.clear();
        self.in_flight.clear();
        self.pushed_later.clear();
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
                    let dropped = self.in_flight.len();
                    self.in_flight.clear();
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

    fn handle_run_reply(&mut self, run: &mut ActiveRun, reply: RunReply, out: &mut Vec<ServerMsg>) {
        match reply {
            RunReply::Translated { key, from, text } => {
                let Some(entry) = self.in_flight.remove(&key) else {
                    return;
                };
                run.ok += 1;
                let _ = self.cache.put(
                    entry.to,
                    &key,
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
                run.original += 1;
                let _ = self.cache.put(entry.to, &key, &Cached::Original);
            }
            RunReply::Failed { key } => {
                if self.in_flight.remove(&key).is_some() {
                    run.failed += 1;
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
                            self.status.failed = None;
                            self.recheck_from_disk();
                        }
                        Err(failure) => {
                            self.status.ready = marker::ready_pairs(&self.home);
                            self.status.failed = Some(failure);
                        }
                    }
                    self.emit_status_if_changed(out);
                    return true;
                }
            }
        }
        false
    }

    fn drain_pushed_later(&mut self, out: &mut Vec<ServerMsg>) {
        for (card_id, item) in self.pushed_later.drain(..) {
            out.push(ServerMsg::QuoteTranslated { card_id, item });
        }
    }

    fn maybe_start_run(&mut self) {
        if self.job.is_some() || self.queue.is_empty() {
            return;
        }
        let Some(cli) = read_usable_cli(&self.home) else {
            self.status.failed = Some(TranslateFailure::Engine);
            self.queue.clear();
            return;
        };
        let count = self.queue.len().min(child::MAX_RUN_QUOTES);
        let mut requests = Vec::with_capacity(count);
        let mut batch = Vec::with_capacity(count);
        for _ in 0..count {
            if let Some(item) = self.queue.pop_front() {
                requests.push(RunRequest {
                    key: item.cache_key.clone(),
                    to: item.to,
                    text: item.text.clone(),
                });
                batch.push(item);
            }
        }
        match child::start_run(&cli, &self.home, &requests, child::RUN_TIMEOUT) {
            Ok(job) => {
                for item in batch {
                    self.in_flight.insert(
                        item.cache_key,
                        InFlightQuote {
                            quote_key: item.quote_key,
                            to: item.to,
                            cards: item.cards,
                        },
                    );
                }
                self.job = Some(ActiveJob::Run(ActiveRun {
                    job,
                    ok: 0,
                    original: 0,
                    failed: 0,
                }));
            }
            Err(_) => {
                self.status.failed = Some(TranslateFailure::Engine);
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

        // Attaching another card to an already-pending quote does not evict anything.
        translator.on_detail(true, "c2", QuoteLang::En, &["quote-3".to_string()]);
        assert_eq!(translator.queue.len(), MAX_PENDING);
        assert_eq!(translator.queue.front().unwrap().text, "quote-3");
        assert_eq!(translator.queue.front().unwrap().cards, vec!["c1", "c2"]);
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
        assert!(
            translator
                .on_detail(true, "c1", QuoteLang::En, &quotes)
                .is_empty()
        );
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

        translator.status.failed = Some(TranslateFailure::Checksum);
        assert_eq!(translator.check(), None);
        assert_eq!(translator.status().failed, Some(TranslateFailure::Checksum));

        // remove() clears Checksum; missing CLI still reports Engine.
        fs::remove_file(cli_record_path(home.path())).unwrap();
        assert_eq!(translator.remove(), Ok(()));
        assert_eq!(translator.status().failed, Some(TranslateFailure::Engine));
    }
}
