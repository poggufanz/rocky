//! Append-only per-target quote translation cache under `<home>/translate/cache`.

use std::collections::{HashMap, HashSet, VecDeque};
use std::fmt::Write as _;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use rocky_proto::translate::QuoteLang;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::marker::{cache_dir, translate_dir};

pub const CACHE_CAP_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Cached {
    Translated { from: QuoteLang, text: String },
    Original,
}

#[derive(Serialize)]
#[serde(untagged)]
enum CacheRecordOut<'a> {
    Translated {
        k: &'a str,
        from: QuoteLang,
        text: &'a str,
    },
    Original {
        k: &'a str,
        keep: bool,
    },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OriginalRecordIn {
    k: String,
    keep: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TranslatedRecordIn {
    k: String,
    from: QuoteLang,
    text: String,
}

/// Computes `sha256(model_sha256 + "\0" + to + "\0" + text)` as 64 lowercase hex characters.
pub fn cache_key(model_sha256: &str, to: QuoteLang, text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(model_sha256.as_bytes());
    hasher.update([0]);
    hasher.update(to.code().as_bytes());
    hasher.update([0]);
    hasher.update(text.as_bytes());
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for byte in digest {
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}

pub struct QuoteCache {
    home: PathBuf,
    cap: u64,
    en: Option<HashMap<String, Cached>>,
    id: Option<HashMap<String, Cached>>,
}

impl QuoteCache {
    pub fn new(home: PathBuf) -> Self {
        Self {
            home,
            cap: CACHE_CAP_BYTES,
            en: None,
            id: None,
        }
    }

    #[cfg(test)]
    pub fn with_cap(home: PathBuf, cap: u64) -> Self {
        Self {
            home,
            cap,
            en: None,
            id: None,
        }
    }

    pub fn get(&mut self, to: QuoteLang, key: &str) -> Option<Cached> {
        self.ensure_loaded(to).get(key).cloned()
    }

    pub fn put(&mut self, to: QuoteLang, key: &str, value: &Cached) -> io::Result<()> {
        self.ensure_loaded(to);
        self.ensure_cache_dir()?;

        let line = serialize_line(key, value)?;
        let path = self.file_path(to);
        if try_append_within_cap(&path, &line, self.cap)? {
            self.slot_mut(to)
                .get_or_insert_with(HashMap::new)
                .insert(key.to_string(), value.clone());
            return Ok(());
        }

        self.compact_with_new(to, key, &line)?;
        Ok(())
    }

    pub fn clear(&mut self) {
        self.en = None;
        self.id = None;
    }

    #[doc(hidden)]
    pub fn loaded_targets(&self) -> usize {
        usize::from(self.en.is_some()) + usize::from(self.id.is_some())
    }

    fn slot_mut(&mut self, to: QuoteLang) -> &mut Option<HashMap<String, Cached>> {
        match to {
            QuoteLang::En => &mut self.en,
            QuoteLang::Id => &mut self.id,
        }
    }

    fn file_path(&self, to: QuoteLang) -> PathBuf {
        cache_dir(&self.home).join(format!("{}.jsonl", to.code()))
    }

    fn part_path(&self, to: QuoteLang) -> PathBuf {
        cache_dir(&self.home).join(format!("{}.jsonl.part", to.code()))
    }

    fn ensure_loaded(&mut self, to: QuoteLang) -> &mut HashMap<String, Cached> {
        let already_loaded = match to {
            QuoteLang::En => self.en.is_some(),
            QuoteLang::Id => self.id.is_some(),
        };
        if !already_loaded {
            let map = self.load_from_disk(to);
            *self.slot_mut(to) = Some(map);
        }
        self.slot_mut(to).as_mut().expect("cache slot initialized")
    }

    fn load_from_disk(&self, to: QuoteLang) -> HashMap<String, Cached> {
        let mut map = HashMap::new();
        if !existing_real_dir(&translate_dir(&self.home))
            || !existing_real_dir(&cache_dir(&self.home))
        {
            return map;
        }
        let path = self.file_path(to);
        let Some(mut file) = open_real_file_read(&path) else {
            return map;
        };
        let Ok(meta) = file.metadata() else {
            return map;
        };
        let file_len = meta.len();
        if file_len == 0 || self.cap == 0 {
            return map;
        }

        if file_len > self.cap && file.seek(SeekFrom::Start(file_len - self.cap)).is_err() {
            return map;
        }

        let mut reader = BufReader::new(file.take(self.cap));
        if file_len > self.cap {
            let mut discard = Vec::new();
            if reader.read_until(b'\n', &mut discard).is_err() {
                return map;
            }
        }

        let mut buf = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    if let Some((key, cached)) = parse_line(&buf) {
                        map.insert(key, cached);
                    }
                }
            }
        }
        map
    }

    fn ensure_cache_dir(&self) -> io::Result<()> {
        let tdir = translate_dir(&self.home);
        check_not_symlink_dir(&tdir)?;
        let cdir = cache_dir(&self.home);
        check_not_symlink_dir(&cdir)?;
        fs::create_dir_all(&cdir)?;
        check_real_dir(&tdir)?;
        check_real_dir(&cdir)?;
        Ok(())
    }

    fn compact_with_new(
        &mut self,
        to: QuoteLang,
        new_key: &str,
        new_line: &[u8],
    ) -> io::Result<()> {
        let path = self.file_path(to);
        let part_path = self.part_path(to);
        let half_cap = self.cap / 2;

        let kept = {
            let mut deque: VecDeque<(String, Vec<u8>)> = VecDeque::new();
            let mut deque_bytes: u64 = 0;

            match fs::symlink_metadata(&path) {
                Ok(meta) if !is_real_file(&meta) => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "cache path is not a regular file",
                    ));
                }
                Ok(_) => {
                    let mut file = open_real_file_read(&path).ok_or_else(|| {
                        io::Error::new(io::ErrorKind::InvalidInput, "cache file unavailable")
                    })?;
                    let file_len = file.metadata()?.len();
                    let read_cap = self.cap.saturating_mul(2);
                    if file_len > read_cap {
                        file.seek(SeekFrom::Start(file_len - read_cap))?;
                    }

                    let mut reader = BufReader::new(file.take(read_cap));
                    if file_len > read_cap {
                        let mut discard = Vec::new();
                        reader.read_until(b'\n', &mut discard)?;
                    }

                    let mut buf = Vec::new();
                    loop {
                        buf.clear();
                        match reader.read_until(b'\n', &mut buf) {
                            Ok(0) => break,
                            Err(e) => return Err(e),
                            Ok(_) => {
                                let Some((key, cached)) = parse_line(&buf) else {
                                    continue;
                                };
                                if let Ok(canonical) = serialize_line(&key, &cached) {
                                    push_bounded(
                                        &mut deque,
                                        &mut deque_bytes,
                                        key,
                                        canonical,
                                        self.cap,
                                    );
                                }
                            }
                        }
                    }
                }
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => return Err(e),
            }

            push_bounded(
                &mut deque,
                &mut deque_bytes,
                new_key.to_string(),
                new_line.to_vec(),
                self.cap,
            );

            let mut selected: Vec<Vec<u8>> = Vec::new();
            let mut seen: HashSet<String> = HashSet::new();
            let mut total: u64 = 0;
            while let Some((key, line)) = deque.pop_back() {
                if !seen.insert(key) {
                    continue;
                }
                let line_len = line.len() as u64;
                if total.saturating_add(line_len) > half_cap {
                    break;
                }
                total += line_len;
                selected.push(line);
            }
            selected.reverse();
            selected
        };

        write_part_and_replace(&part_path, &path, &kept)?;

        let reloaded = self.load_from_disk(to);
        *self.slot_mut(to) = Some(reloaded);
        Ok(())
    }
}

fn push_bounded(
    deque: &mut VecDeque<(String, Vec<u8>)>,
    deque_bytes: &mut u64,
    key: String,
    line: Vec<u8>,
    cap: u64,
) {
    *deque_bytes = deque_bytes.saturating_add(line.len() as u64);
    deque.push_back((key, line));
    while *deque_bytes > cap && deque.len() > 1 {
        if let Some((_, dropped)) = deque.pop_front() {
            *deque_bytes = deque_bytes.saturating_sub(dropped.len() as u64);
        }
    }
}

fn serialize_line(key: &str, value: &Cached) -> io::Result<Vec<u8>> {
    let record = match value {
        Cached::Translated { from, text } => CacheRecordOut::Translated {
            k: key,
            from: *from,
            text: text.as_str(),
        },
        Cached::Original => CacheRecordOut::Original { k: key, keep: true },
    };
    let mut bytes =
        serde_json::to_vec(&record).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    bytes.push(b'\n');
    Ok(bytes)
}

fn parse_line(raw: &[u8]) -> Option<(String, Cached)> {
    let trimmed = trim_ascii_bytes(raw);
    if !trimmed.starts_with(b"{") {
        return None;
    }

    if let Ok(rec) = serde_json::from_slice::<OriginalRecordIn>(trimmed) {
        return rec.keep.then_some((rec.k, Cached::Original));
    }

    if let Ok(rec) = serde_json::from_slice::<TranslatedRecordIn>(trimmed) {
        return Some((
            rec.k,
            Cached::Translated {
                from: rec.from,
                text: rec.text,
            },
        ));
    }

    None
}

fn trim_ascii_bytes(mut bytes: &[u8]) -> &[u8] {
    while let Some(&first) = bytes.first() {
        if first.is_ascii_whitespace() {
            bytes = &bytes[1..];
        } else {
            break;
        }
    }
    while let Some(&last) = bytes.last() {
        if last.is_ascii_whitespace() {
            bytes = &bytes[..bytes.len() - 1];
        } else {
            break;
        }
    }
    bytes
}

fn try_append_within_cap(path: &Path, line: &[u8], cap: u64) -> io::Result<bool> {
    let line_len = line.len() as u64;
    match fs::symlink_metadata(path) {
        Ok(meta) if !is_real_file(&meta) => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "cache path is not a regular file",
            ));
        }
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            if line_len > cap {
                return Ok(false);
            }
        }
        Err(e) => return Err(e),
    }

    let mut opts = OpenOptions::new();
    opts.read(true).create(true).append(true);
    apply_no_follow(&mut opts);

    let mut file = opts.open(path)?;
    let meta = file.metadata()?;
    if !is_real_file(&meta) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "cache path is not a regular file",
        ));
    }

    let current_len = meta.len();
    let needs_newline = if current_len > 0 {
        file.seek(SeekFrom::End(-1))?;
        let mut last = [0u8; 1];
        file.read_exact(&mut last)?;
        last[0] != b'\n'
    } else {
        false
    };

    let added_len = line_len.saturating_add(u64::from(needs_newline));
    if current_len.saturating_add(added_len) > cap {
        return Ok(false);
    }

    if needs_newline {
        let mut buf = Vec::with_capacity(1 + line.len());
        buf.push(b'\n');
        buf.extend_from_slice(line);
        file.write_all(&buf)?;
    } else {
        file.write_all(line)?;
    }
    file.flush()?;
    Ok(true)
}

fn write_part_and_replace(
    part_path: &Path,
    target_path: &Path,
    lines: &[Vec<u8>],
) -> io::Result<()> {
    match fs::remove_file(part_path) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }

    let write_res = (|| -> io::Result<()> {
        let mut opts = OpenOptions::new();
        opts.write(true).create_new(true);
        apply_no_follow(&mut opts);
        let mut file = opts.open(part_path)?;
        if !is_real_file(&file.metadata()?) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "part path is not a regular file",
            ));
        }
        for line in lines {
            file.write_all(line)?;
        }
        file.flush()?;
        Ok(())
    })();

    if let Err(err) = write_res {
        let _ = fs::remove_file(part_path);
        return Err(err);
    }

    if let Err(err) = fs::rename(part_path, target_path) {
        let _ = fs::remove_file(part_path);
        return Err(err);
    }
    Ok(())
}

fn open_real_file_read(path: &Path) -> Option<File> {
    let meta = fs::symlink_metadata(path).ok()?;
    if !is_real_file(&meta) {
        return None;
    }

    let mut opts = OpenOptions::new();
    opts.read(true);
    apply_no_follow(&mut opts);

    let file = opts.open(path).ok()?;
    let opened = file.metadata().ok()?;
    is_real_file(&opened).then_some(file)
}

fn apply_no_follow(opts: &mut OpenOptions) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        opts.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
}

fn is_symlink_or_reparse(meta: &fs::Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
    }
    false
}

fn is_real_dir(meta: &fs::Metadata) -> bool {
    !is_symlink_or_reparse(meta) && meta.file_type().is_dir()
}

fn is_real_file(meta: &fs::Metadata) -> bool {
    !is_symlink_or_reparse(meta) && meta.file_type().is_file()
}

fn existing_real_dir(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|meta| is_real_dir(&meta))
        .unwrap_or(false)
}

fn check_not_symlink_dir(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) if is_real_dir(&meta) => Ok(()),
        Ok(_) => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "cache directory is not a regular directory",
        )),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

fn check_real_dir(path: &Path) -> io::Result<()> {
    let meta = fs::symlink_metadata(path)?;
    if is_real_dir(&meta) {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "cache directory is not a regular directory",
        ))
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::TempDir;

    use super::*;
    use crate::translate::marker::cache_dir;

    fn is_lower_hex_64(s: &str) -> bool {
        s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    }

    #[test]
    fn cache_key_mixes_model_target_and_text() {
        let base = cache_key("model_a", QuoteLang::En, "hello world");
        let diff_model = cache_key("model_b", QuoteLang::En, "hello world");
        let diff_target = cache_key("model_a", QuoteLang::Id, "hello world");
        let diff_text = cache_key("model_a", QuoteLang::En, "hello rocky");

        for k in [&base, &diff_model, &diff_target, &diff_text] {
            assert!(is_lower_hex_64(k), "expected 64 lowercase hex chars: {k}");
        }
        assert_ne!(base, diff_model);
        assert_ne!(base, diff_target);
        assert_ne!(base, diff_text);
        assert_ne!(diff_model, diff_target);
        assert_ne!(diff_model, diff_text);
        assert_ne!(diff_target, diff_text);
    }

    #[test]
    fn put_then_get_survives_reload() {
        let home = TempDir::new().unwrap();
        let mut cache = QuoteCache::new(home.path().to_path_buf());

        let translated = Cached::Translated {
            from: QuoteLang::Id,
            text: "Build passed cleanly.".to_string(),
        };
        cache.put(QuoteLang::En, "k1", &translated).unwrap();
        cache.put(QuoteLang::En, "k2", &Cached::Original).unwrap();

        assert_eq!(cache.get(QuoteLang::En, "k1"), Some(translated.clone()));
        assert_eq!(cache.get(QuoteLang::En, "k2"), Some(Cached::Original));

        let raw = fs::read_to_string(cache_dir(home.path()).join("en.jsonl")).unwrap();
        let lines: Vec<&str> = raw.lines().collect();
        assert_eq!(lines.len(), 2);
        let first: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(
            first,
            serde_json::json!({"k": "k1", "from": "id", "text": "Build passed cleanly."})
        );
        let second: serde_json::Value = serde_json::from_str(lines[1]).unwrap();
        assert_eq!(second, serde_json::json!({"k": "k2", "keep": true}));

        let mut reloaded = QuoteCache::new(home.path().to_path_buf());
        assert_eq!(reloaded.get(QuoteLang::En, "k1"), Some(translated));
        assert_eq!(reloaded.get(QuoteLang::En, "k2"), Some(Cached::Original));
        assert_eq!(reloaded.get(QuoteLang::En, "missing"), None);
    }

    #[test]
    fn later_line_wins_and_bad_lines_are_skipped() {
        let home = TempDir::new().unwrap();
        let dir = cache_dir(home.path());
        fs::create_dir_all(&dir).unwrap();
        let content = concat!(
            "{\"k\":\"k1\",\"from\":\"id\",\"text\":\"first\"}\n",
            "not json at all\n",
            "{\"k\":\"k2\",\"keep\":false}\n",
            "[\"k_arr_tr\",\"id\",\"from array\",null]\n",
            "[\"k_arr_keep\",null,null,true]\n",
            "{\"k\":\"k_null_keep\",\"keep\":true,\"text\":null}\n",
            "{\"k\":\"k_null_tr\",\"from\":\"id\",\"text\":\"hi\",\"keep\":null}\n",
            "{\"k\":\"k_null_val\",\"from\":\"id\",\"text\":null}\n",
            "{\"k\":\"k1\",\"from\":\"id\",\"text\":\"second\"}\n",
            "{\"k\":\"k1\",\"keep\":null,\"keep\":true}\n",
            "{\"k\":\"k1\",\"keep\":true,\"keep\":true}\n",
            "{\"k\":\"k1\",\"from\":\"id\",\"text\":\"dup1\",\"text\":\"dup2\"}\n",
            "{\"k\":\"k3\",\"keep\":true}\n",
            "{\"k\":\"k4\",\"from\":\"id\",\"text\":\"trun",
        );
        fs::write(dir.join("en.jsonl"), content).unwrap();

        let mut cache = QuoteCache::new(home.path().to_path_buf());
        assert_eq!(
            cache.get(QuoteLang::En, "k1"),
            Some(Cached::Translated {
                from: QuoteLang::Id,
                text: "second".to_string(),
            })
        );
        assert_eq!(cache.get(QuoteLang::En, "k2"), None);
        assert_eq!(cache.get(QuoteLang::En, "k_arr_tr"), None);
        assert_eq!(cache.get(QuoteLang::En, "k_arr_keep"), None);
        assert_eq!(cache.get(QuoteLang::En, "k_null_keep"), None);
        assert_eq!(cache.get(QuoteLang::En, "k_null_tr"), None);
        assert_eq!(cache.get(QuoteLang::En, "k_null_val"), None);
        assert_eq!(cache.get(QuoteLang::En, "k3"), Some(Cached::Original));
        assert_eq!(cache.get(QuoteLang::En, "k4"), None);

        let after_truncated = Cached::Translated {
            from: QuoteLang::Id,
            text: "after truncated".to_string(),
        };
        cache.put(QuoteLang::En, "k5", &after_truncated).unwrap();
        assert_eq!(
            cache.get(QuoteLang::En, "k5"),
            Some(after_truncated.clone())
        );

        let mut reloaded = QuoteCache::new(home.path().to_path_buf());
        assert_eq!(reloaded.get(QuoteLang::En, "k5"), Some(after_truncated));
        assert_eq!(reloaded.get(QuoteLang::En, "k3"), Some(Cached::Original));
        assert_eq!(reloaded.get(QuoteLang::En, "k4"), None);
    }

    #[test]
    fn compaction_keeps_newest_half() {
        let home = TempDir::new().unwrap();
        let mut cache = QuoteCache::with_cap(home.path().to_path_buf(), 4096);
        let payload = "x".repeat(160);

        for i in 0..40 {
            let key = format!("key-{i:02}");
            let value = Cached::Translated {
                from: QuoteLang::Id,
                text: format!("{i:02}-{payload}"),
            };
            cache.put(QuoteLang::En, &key, &value).unwrap();
        }

        let dir = cache_dir(home.path());
        let file_path = dir.join("en.jsonl");
        let part_path = dir.join("en.jsonl.part");

        let meta = fs::metadata(&file_path).unwrap();
        assert!(
            meta.len() <= 4096,
            "expected compacted file <= 4096 bytes, got {}",
            meta.len()
        );
        assert!(!part_path.exists(), "part file should not remain");
        assert_eq!(cache.get(QuoteLang::En, "key-00"), None);
        assert_eq!(
            cache.get(QuoteLang::En, "key-39"),
            Some(Cached::Translated {
                from: QuoteLang::Id,
                text: format!("39-{payload}"),
            })
        );

        let mut reloaded = QuoteCache::new(home.path().to_path_buf());
        assert_eq!(reloaded.get(QuoteLang::En, "key-00"), None);
        assert_eq!(
            reloaded.get(QuoteLang::En, "key-39"),
            Some(Cached::Translated {
                from: QuoteLang::Id,
                text: format!("39-{payload}"),
            })
        );
    }

    #[test]
    fn failed_compaction_keeps_cache_bounded_on_retry() {
        let home = TempDir::new().unwrap();
        let cap = 1024;
        let mut cache = QuoteCache::with_cap(home.path().to_path_buf(), cap);
        let payload = "x".repeat(150);

        for i in 0..5 {
            let key = format!("seed-{i:02}");
            let value = Cached::Translated {
                from: QuoteLang::Id,
                text: format!("{i:02}-{payload}"),
            };
            cache.put(QuoteLang::En, &key, &value).unwrap();
        }

        let dir = cache_dir(home.path());
        let file_path = dir.join("en.jsonl");
        let part_path = dir.join("en.jsonl.part");
        let len_before = fs::metadata(&file_path).unwrap().len();
        assert!(len_before <= cap);

        fs::create_dir(&part_path).unwrap();

        for i in 0..20 {
            let key = format!("blocked-{i:02}");
            let value = Cached::Translated {
                from: QuoteLang::Id,
                text: format!("{i:02}-{payload}"),
            };
            assert!(
                cache.put(QuoteLang::En, &key, &value).is_err(),
                "expected compaction error for {key}"
            );
            assert_eq!(cache.get(QuoteLang::En, &key), None);
        }

        let len_after = fs::metadata(&file_path).unwrap().len();
        assert!(len_after <= cap, "expected <= {cap}, got {len_after}");
        assert_eq!(len_after, len_before);

        for i in 0..5 {
            assert!(cache.get(QuoteLang::En, &format!("seed-{i:02}")).is_some());
        }

        // Removing the directory blocking `.part` lets a subsequent put compact and succeed.
        fs::remove_dir(&part_path).unwrap();
        let recovered = Cached::Translated {
            from: QuoteLang::Id,
            text: format!("ok-{payload}"),
        };
        cache.put(QuoteLang::En, "recovered", &recovered).unwrap();
        assert_eq!(cache.get(QuoteLang::En, "recovered"), Some(recovered));
        assert!(fs::metadata(&file_path).unwrap().len() <= cap);
    }

    #[test]
    fn targets_use_separate_files() {
        let home = TempDir::new().unwrap();
        let mut cache = QuoteCache::new(home.path().to_path_buf());

        let en_val = Cached::Translated {
            from: QuoteLang::Id,
            text: "to english".to_string(),
        };
        let id_val = Cached::Translated {
            from: QuoteLang::En,
            text: "ke indonesia".to_string(),
        };

        cache.put(QuoteLang::En, "shared", &en_val).unwrap();
        cache.put(QuoteLang::Id, "shared", &id_val).unwrap();
        cache
            .put(QuoteLang::En, "only_en", &Cached::Original)
            .unwrap();

        let dir = cache_dir(home.path());
        assert!(dir.join("en.jsonl").is_file());
        assert!(dir.join("id.jsonl").is_file());

        assert_eq!(cache.get(QuoteLang::En, "shared"), Some(en_val));
        assert_eq!(cache.get(QuoteLang::Id, "shared"), Some(id_val));
        assert_eq!(cache.get(QuoteLang::En, "only_en"), Some(Cached::Original));
        assert_eq!(cache.get(QuoteLang::Id, "only_en"), None);
    }

    #[test]
    fn clear_drops_memory_without_deleting_files() {
        let home = TempDir::new().unwrap();
        let mut cache = QuoteCache::new(home.path().to_path_buf());
        cache.put(QuoteLang::En, "k1", &Cached::Original).unwrap();

        cache.clear();
        let file_path = cache_dir(home.path()).join("en.jsonl");
        assert!(file_path.exists());

        // Clearing memory allows a subsequent removal of the directory to take effect immediately.
        fs::remove_dir_all(translate_dir(home.path())).unwrap();
        assert_eq!(cache.get(QuoteLang::En, "k1"), None);
    }

    #[test]
    fn oversized_file_load_stays_bounded_and_skips_invalid_utf8() {
        let home = TempDir::new().unwrap();
        let dir = cache_dir(home.path());
        fs::create_dir_all(&dir).unwrap();

        let mut raw = Vec::new();
        for i in 0..30 {
            raw.extend_from_slice(
                format!(
                    "{{\"k\":\"k-{i:02}\",\"from\":\"id\",\"text\":\"{}\"}}\n",
                    "a".repeat(80)
                )
                .as_bytes(),
            );
        }
        raw.extend_from_slice(b"{\"k\":\"bad\",\"from\":\"id\",\"text\":\"\xff\xfe\"}\n");
        raw.extend_from_slice(b"{\"k\":\"newest\",\"keep\":true}\n");
        fs::write(dir.join("en.jsonl"), &raw).unwrap();

        let mut cache = QuoteCache::with_cap(home.path().to_path_buf(), 1024);
        assert_eq!(cache.get(QuoteLang::En, "k-00"), None);
        assert_eq!(cache.get(QuoteLang::En, "bad"), None);
        assert_eq!(cache.get(QuoteLang::En, "newest"), Some(Cached::Original));
    }

    #[test]
    fn symlinked_cache_file_is_ignored_and_not_written() {
        let home = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let outside_file = outside.path().join("outside.jsonl");
        fs::write(&outside_file, "{\"k\":\"secret\",\"keep\":true}\n").unwrap();

        let dir = cache_dir(home.path());
        fs::create_dir_all(&dir).unwrap();
        let link_path = dir.join("en.jsonl");

        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(&outside_file, &link_path);
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_file(&outside_file, &link_path);

        if let Err(err) = linked {
            #[cfg(windows)]
            {
                eprintln!("skipping symlink assertion: cannot create symlink: {err}");
                return;
            }
            #[cfg(not(windows))]
            panic!("failed to create symlink: {err}");
        }

        let mut cache = QuoteCache::new(home.path().to_path_buf());
        assert_eq!(cache.get(QuoteLang::En, "secret"), None);
        assert!(cache.put(QuoteLang::En, "k1", &Cached::Original).is_err());
        assert_eq!(
            fs::read_to_string(&outside_file).unwrap(),
            "{\"k\":\"secret\",\"keep\":true}\n"
        );
    }
}
