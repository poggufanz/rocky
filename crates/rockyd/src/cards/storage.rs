//! Append-only per-repo JSONL card storage under `<ROCKY_HOME>/desk/cards/`.

use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use rocky_proto::cards::Card;
use rocky_proto::paths::{cards_dir, cards_file, cards_none_file, desk_dir};

/// Maximum card file size (8 MiB) before rotation trims older cards.
pub const MAX_CARD_FILE_BYTES: u64 = 8 * 1024 * 1024;

/// Target maximum card file size (6 MiB) after rotation.
pub const ROTATE_TARGET_BYTES: u64 = 6 * 1024 * 1024;

/// Maximum number of cards returned by a single [`CardStore::page`] call.
pub const MAX_PAGE_LIMIT: usize = 20;

#[derive(Debug)]
struct CachedFile {
    len: u64,
    modified: Option<SystemTime>,
    cards: HashMap<String, Card>,
}

/// Persistent per-repo JSONL change card store with per-file read cache.
#[derive(Debug)]
pub struct CardStore {
    rocky_home: PathBuf,
    files: HashMap<PathBuf, CachedFile>,
    removed: bool,
    #[cfg(test)]
    disk_reads: u64,
}

impl CardStore {
    /// Creates a store rooted at `rocky_home`.
    pub fn new(rocky_home: PathBuf) -> CardStore {
        CardStore {
            rocky_home,
            files: HashMap::new(),
            removed: false,
            #[cfg(test)]
            disk_reads: 0,
        }
    }

    /// Permanently disables appends so removed card folders are never recreated.
    pub fn set_removed(&mut self) {
        self.removed = true;
        self.files.clear();
    }

    /// Appends one card revision line to its repo JSONL file (or `_none.jsonl`),
    /// rotating the file through `<file>.tmp` if it exceeds 8 MiB.
    pub fn append(&mut self, card: &Card) -> io::Result<()> {
        if self.removed {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "change cards removed",
            ));
        }
        let path = card_file_path(&self.rocky_home, &card.repo_id)?;
        let mut line = serde_json::to_vec(card).map_err(io::Error::other)?;
        line.push(b'\n');

        ensure_cards_dir(&self.rocky_home)?;

        let len = {
            let mut file = open_append_private(&path)?;
            let existing_len = file.metadata()?.len();
            if existing_len > 0 {
                let mut last = [0u8; 1];
                file.seek(SeekFrom::Start(existing_len - 1))?;
                if file.read(&mut last)? == 1 && last[0] != b'\n' {
                    file.write_all(b"\n")?;
                }
            }
            file.write_all(&line)?;
            file.flush()?;
            file.metadata()?.len()
        };

        self.files.remove(&path);

        if len > MAX_CARD_FILE_BYTES {
            rotate_file(&path)?;
        }
        Ok(())
    }

    /// Returns one page of latest card revisions matching `query` strictly after
    /// `before` in `(ended_ms.unwrap_or(started_ms) desc, card_id desc)` order,
    /// along with the opaque `"<key_ms>:<card_id>"` cursor for the next page.
    pub fn page(
        &mut self,
        query: Option<&str>,
        before: Option<&str>,
        limit: usize,
    ) -> (Vec<Card>, Option<String>) {
        self.refresh_cache();
        let limit = limit.min(MAX_PAGE_LIMIT);
        if limit == 0 {
            return (Vec::new(), None);
        }

        let cursor = before.and_then(parse_cursor);
        let needle = query.filter(|q| !q.is_empty()).map(str::to_lowercase);
        let latest = self.latest_cards();

        let mut matched: Vec<&Card> = latest
            .into_iter()
            .filter(|card| {
                cursor.is_none_or(|(cur_key, cur_id)| {
                    (card_sort_key(card), card.card_id.as_str()) < (cur_key, cur_id)
                })
            })
            .filter(|card| needle.as_deref().is_none_or(|q| matches_query(card, q)))
            .collect();

        matched.sort_by(|a, b| {
            (card_sort_key(b), b.card_id.as_str()).cmp(&(card_sort_key(a), a.card_id.as_str()))
        });

        let has_more = matched.len() > limit;
        let items: Vec<Card> = matched.into_iter().take(limit).cloned().collect();
        let next = if has_more {
            items.last().map(format_cursor)
        } else {
            None
        };
        (items, next)
    }

    /// Returns the latest revision for `card_id`, if present on disk.
    pub fn get(&mut self, card_id: &str) -> Option<Card> {
        self.refresh_cache();
        let mut best: Option<&Card> = None;
        for cached in self.files.values() {
            if let Some(card) = cached.cards.get(card_id)
                && best.is_none_or(|cur| is_newer_revision(card, cur))
            {
                best = Some(card);
            }
        }
        best.cloned()
    }

    fn latest_cards(&self) -> Vec<&Card> {
        if self.files.len() <= 1 {
            return self
                .files
                .values()
                .flat_map(|cached| cached.cards.values())
                .collect();
        }
        let mut by_id: HashMap<&str, &Card> = HashMap::new();
        for cached in self.files.values() {
            for (card_id, card) in &cached.cards {
                match by_id.get_mut(card_id.as_str()) {
                    Some(existing) => {
                        if is_newer_revision(card, existing) {
                            *existing = card;
                        }
                    }
                    None => {
                        by_id.insert(card_id.as_str(), card);
                    }
                }
            }
        }
        by_id.into_values().collect()
    }

    fn refresh_cache(&mut self) {
        let desk = desk_dir(&self.rocky_home);
        let dir = cards_dir(&self.rocky_home);
        let (Ok(desk_meta), Ok(dir_meta)) =
            (fs::symlink_metadata(&desk), fs::symlink_metadata(&dir))
        else {
            self.files.clear();
            return;
        };
        if !is_real_dir(&desk_meta) || !is_real_dir(&dir_meta) {
            self.files.clear();
            return;
        }

        let Ok(entries) = fs::read_dir(&dir) else {
            self.files.clear();
            return;
        };

        let mut seen = HashSet::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension() != Some(OsStr::new("jsonl")) {
                continue;
            }
            let Ok(meta) = fs::symlink_metadata(&path) else {
                continue;
            };
            if !is_real_file(&meta) {
                continue;
            }

            let len = meta.len();
            let modified = meta.modified().ok();
            let cache_hit = self.files.get(&path).is_some_and(|cached| {
                cached.len == len && cached.modified.is_some() && cached.modified == modified
            });
            if cache_hit {
                seen.insert(path);
                continue;
            }

            #[cfg(test)]
            {
                self.disk_reads += 1;
            }
            if let Some(cached) = read_cards_file(&path) {
                self.files.insert(path.clone(), cached);
                seen.insert(path);
            }
        }

        self.files.retain(|path, _| seen.contains(path));
    }
}

fn card_sort_key(card: &Card) -> u64 {
    card.ended_ms.unwrap_or(card.started_ms)
}

fn format_cursor(card: &Card) -> String {
    format!("{}:{}", card_sort_key(card), card.card_id)
}

fn parse_cursor(cursor: &str) -> Option<(u64, &str)> {
    let (key_str, card_id) = cursor.split_once(':')?;
    if key_str.is_empty() || !key_str.bytes().all(|b| b.is_ascii_digit()) || card_id.is_empty() {
        return None;
    }
    let key_ms = key_str.parse::<u64>().ok()?;
    Some((key_ms, card_id))
}

fn is_newer_revision(candidate: &Card, current: &Card) -> bool {
    candidate.rev > current.rev
        || (candidate.rev == current.rev && candidate.ended_ms > current.ended_ms)
}

fn card_file_path(rocky_home: &Path, repo_id: &str) -> io::Result<PathBuf> {
    if repo_id.is_empty() || repo_id == "_none" {
        Ok(cards_none_file(rocky_home))
    } else if repo_id.contains('/')
        || repo_id.contains('\\')
        || repo_id.contains('\0')
        || repo_id == "."
        || repo_id == ".."
    {
        Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid repo_id for card file",
        ))
    } else {
        Ok(cards_file(rocky_home, repo_id))
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

fn ensure_real_dir(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) => {
            if !is_real_dir(&meta) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "storage directory must not be a link",
                ));
            }
            Ok(())
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            match fs::create_dir(path) {
                Ok(()) => {}
                Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {}
                Err(err) => return Err(err),
            }
            let meta = fs::symlink_metadata(path)?;
            if !is_real_dir(&meta) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "storage directory must not be a link",
                ));
            }
            Ok(())
        }
        Err(e) => Err(e),
    }
}

fn ensure_cards_dir(rocky_home: &Path) -> io::Result<()> {
    if !rocky_home.exists() {
        fs::create_dir_all(rocky_home)?;
    }
    ensure_real_dir(&desk_dir(rocky_home))?;
    let dir = cards_dir(rocky_home);
    ensure_real_dir(&dir)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let mut opts = OpenOptions::new();
        opts.read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY);
        let dir_file = opts.open(&dir)?;
        let meta = dir_file.metadata()?;
        if !meta.file_type().is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "cards directory is not a directory",
            ));
        }
        dir_file.set_permissions(fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn ensure_regular_file(path: &Path) -> io::Result<()> {
    let meta = fs::symlink_metadata(path)?;
    if !is_real_file(&meta) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "card file must not be a link",
        ));
    }
    Ok(())
}

fn ensure_regular_file_or_missing(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) => {
            if !is_real_file(&meta) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "card file must not be a link",
                ));
            }
            Ok(())
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

fn open_nofollow_private(path: &Path, opts: &mut OpenOptions) -> io::Result<File> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
        opts.custom_flags(libc::O_NOFOLLOW);
    }
    let file = opts.open(path)?;
    let opened = file.metadata()?;
    if !opened.file_type().is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "opened card file is not a regular file",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    Ok(file)
}

fn open_append_private(path: &Path) -> io::Result<File> {
    ensure_regular_file_or_missing(path)?;
    let mut opts = OpenOptions::new();
    opts.create(true).append(true).read(true);
    open_nofollow_private(path, &mut opts)
}

fn prepare_tmp_file(tmp_path: &Path) -> io::Result<File> {
    match fs::symlink_metadata(tmp_path) {
        Ok(meta) => {
            if !is_real_file(&meta) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "temporary card file must not be a link",
                ));
            }
            fs::remove_file(tmp_path)?;
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }

    let mut opts = OpenOptions::new();
    opts.write(true).create_new(true);
    open_nofollow_private(tmp_path, &mut opts)
}

fn open_nofollow_readonly(path: &Path) -> io::Result<File> {
    ensure_regular_file(path)?;
    let mut opts = OpenOptions::new();
    opts.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.custom_flags(libc::O_NOFOLLOW);
    }
    let file = opts.open(path)?;
    let opened = file.metadata()?;
    if !opened.file_type().is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "not a regular file",
        ));
    }
    Ok(file)
}

fn read_cards_file(path: &Path) -> Option<CachedFile> {
    let file = open_nofollow_readonly(path).ok()?;
    let meta = file.metadata().ok()?;
    let len = meta.len();
    let modified = meta.modified().ok();
    let mut reader = BufReader::new(file);
    let mut cards: HashMap<String, Card> = HashMap::new();
    let mut buf = Vec::new();
    loop {
        buf.clear();
        let read = match reader.read_until(b'\n', &mut buf) {
            Ok(n) => n,
            Err(_) => break,
        };
        if read == 0 {
            break;
        }
        let trimmed = buf.trim_ascii();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(card) = serde_json::from_slice::<Card>(trimmed) else {
            continue;
        };
        match cards.get_mut(&card.card_id) {
            Some(existing) => {
                if card.rev >= existing.rev {
                    *existing = card;
                }
            }
            None => {
                cards.insert(card.card_id.clone(), card);
            }
        }
    }
    Some(CachedFile {
        len,
        modified,
        cards,
    })
}

struct CardGroup {
    card_id: String,
    latest_rev: u32,
    latest_ended_ms: Option<u64>,
    latest_sort_key: u64,
    line_idx: usize,
    line_bytes: Vec<u8>,
}

fn rotate_file(path: &Path) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        let dir_meta = fs::symlink_metadata(parent)?;
        if !is_real_dir(&dir_meta) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "cards directory must not be a link",
            ));
        }
    }

    let mut groups: HashMap<String, CardGroup> = HashMap::new();
    {
        let file = open_nofollow_readonly(path)?;
        let mut reader = BufReader::new(file);
        let mut buf = Vec::new();
        let mut line_idx = 0usize;
        loop {
            buf.clear();
            let read = reader.read_until(b'\n', &mut buf)?;
            if read == 0 {
                break;
            }
            let cur_idx = line_idx;
            line_idx += 1;
            let trimmed = buf.trim_ascii();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(card) = serde_json::from_slice::<Card>(trimmed) else {
                continue;
            };
            let line_bytes = trimmed.to_vec();
            let sort_key = card_sort_key(&card);
            match groups.get_mut(&card.card_id) {
                Some(group) => {
                    let is_newer = card.rev > group.latest_rev
                        || (card.rev == group.latest_rev
                            && card.ended_ms >= group.latest_ended_ms);
                    if is_newer {
                        group.latest_rev = card.rev;
                        group.latest_ended_ms = card.ended_ms;
                        group.latest_sort_key = sort_key;
                        group.line_idx = cur_idx;
                        group.line_bytes = line_bytes;
                    }
                }
                None => {
                    groups.insert(
                        card.card_id.clone(),
                        CardGroup {
                            card_id: card.card_id,
                            latest_rev: card.rev,
                            latest_ended_ms: card.ended_ms,
                            latest_sort_key: sort_key,
                            line_idx: cur_idx,
                            line_bytes,
                        },
                    );
                }
            }
        }
    }

    let mut ordered: Vec<CardGroup> = groups.into_values().collect();
    ordered.sort_by(|a, b| {
        b.latest_sort_key
            .cmp(&a.latest_sort_key)
            .then_with(|| b.line_idx.cmp(&a.line_idx))
            .then_with(|| a.card_id.cmp(&b.card_id))
    });

    let mut kept_bytes = 0u64;
    let mut kept_lines: Vec<(usize, Vec<u8>)> = Vec::new();
    for (idx, group) in ordered.into_iter().enumerate() {
        let byte_len = group.line_bytes.len() as u64 + 1;
        if idx > 0 && kept_bytes.saturating_add(byte_len) > ROTATE_TARGET_BYTES {
            break;
        }
        kept_bytes = kept_bytes.saturating_add(byte_len);
        kept_lines.push((group.line_idx, group.line_bytes));
    }
    kept_lines.sort_by_key(|(idx, _)| *idx);

    let tmp_path = tmp_file_path(path);
    let file = prepare_tmp_file(&tmp_path)?;
    let write_res = (|| -> io::Result<()> {
        let mut writer = BufWriter::new(file);
        for (_, bytes) in &kept_lines {
            writer.write_all(bytes)?;
            writer.write_all(b"\n")?;
        }
        writer.flush()
    })();
    if let Err(err) = write_res {
        let _ = fs::remove_file(&tmp_path);
        return Err(err);
    }
    if let Err(err) = ensure_regular_file(path) {
        let _ = fs::remove_file(&tmp_path);
        return Err(err);
    }
    if let Err(err) = fs::rename(&tmp_path, path) {
        let _ = fs::remove_file(&tmp_path);
        return Err(err);
    }
    Ok(())
}

fn tmp_file_path(path: &Path) -> PathBuf {
    let mut tmp = path.as_os_str().to_os_string();
    tmp.push(".tmp");
    PathBuf::from(tmp)
}

fn matches_query(card: &Card, needle_lower: &str) -> bool {
    if card
        .main_root
        .as_deref()
        .and_then(repo_name_from_root)
        .is_some_and(|name| name.to_lowercase().contains(needle_lower))
    {
        return true;
    }
    card.blocks
        .iter()
        .any(|block| block.path.to_lowercase().contains(needle_lower))
}

fn repo_name_from_root(root: &str) -> Option<&str> {
    let seg = root.split(['/', '\\']).rfind(|s| !s.is_empty())?;
    let bytes = seg.as_bytes();
    if bytes.len() == 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return None;
    }
    Some(seg)
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::fs::{self, OpenOptions};
    use std::io::Write;
    use std::path::Path;

    use rocky_proto::cards::{
        Block, BlockSymbol, BlockVia, CARD_VERSION, Card, CardStatus, Coverage, CoverageState,
        Importance, Label, Quote, SymbolKind,
    };
    use rocky_proto::paths::{cards_dir, cards_file, cards_none_file, desk_dir};

    use super::{
        CardStore, MAX_CARD_FILE_BYTES, MAX_PAGE_LIMIT, ROTATE_TARGET_BYTES, tmp_file_path,
    };

    fn sample_block(seq: u32, path: &str, padding: usize) -> Block {
        Block {
            seq,
            path: path.to_string(),
            symbol: Some(BlockSymbol {
                kind: SymbolKind::Function,
                name: format!("fn_{seq}"),
                container: None,
                exported: true,
                nth: 0,
            }),
            labels: vec![Label::BodyChanged {}],
            importance: Importance::Medium,
            via: BlockVia::Edit,
            tool_use_ids: vec![format!("tu-{seq}")],
            bash: None,
            before: Some("a".repeat(64)),
            after: Some("b".repeat(64)),
            recorded: true,
            line: Some(10),
            added: Some(4),
            removed: Some(2),
            quote: (padding > 0).then(|| Quote {
                text: "q".repeat(padding),
                shared: false,
            }),
        }
    }

    fn make_card(
        card_id: &str,
        rev: u32,
        repo_id: &str,
        main_root: Option<&str>,
        ended_ms: Option<u64>,
        paths: &[&str],
    ) -> Card {
        let blocks = paths
            .iter()
            .enumerate()
            .map(|(i, p)| sample_block((i + 1) as u32, p, 0))
            .collect();
        Card {
            v: CARD_VERSION,
            card_id: card_id.to_string(),
            rev,
            repo_id: repo_id.to_string(),
            root: main_root.unwrap_or("").to_string(),
            main_root: main_root.map(str::to_string),
            branch: main_root.map(|_| "main".to_string()),
            session_id: "sess-1".to_string(),
            agent_id: String::new(),
            agent_type: String::new(),
            parent_card_id: None,
            started_ms: ended_ms.unwrap_or(1_000).saturating_sub(500),
            ended_ms,
            status: CardStatus::Done,
            prompt: format!("prompt for {card_id} r{rev}"),
            prompt_truncated: false,
            importance: Importance::Medium,
            blocks,
            flow: Vec::new(),
            outside_count: 0,
            coverage: Coverage {
                state: CoverageState::Full,
                reasons: Vec::new(),
            },
        }
    }

    fn append_raw(path: &Path, bytes: &[u8]) {
        let mut f = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap();
        f.write_all(bytes).unwrap();
    }

    #[test]
    fn latest_revision_wins() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = CardStore::new(dir.path().to_path_buf());
        let repo = "0123456789abcdef0123456789abcdef";

        let r1 = make_card("card-1", 1, repo, Some("/work/app"), Some(1_000), &["a.rs"]);
        let r2 = make_card(
            "card-1",
            2,
            repo,
            Some("/work/app"),
            Some(1_500),
            &["a.rs", "b.rs"],
        );
        store.append(&r1).unwrap();
        store.append(&r2).unwrap();

        let got = store.get("card-1").expect("card-1 present");
        assert_eq!(got.rev, 2);
        assert_eq!(got.ended_ms, Some(1_500));
        assert_eq!(got.blocks.len(), 2);

        let (page, next) = store.page(None, None, 20);
        assert_eq!(page.len(), 1);
        assert_eq!(page[0].rev, 2);
        assert_eq!(next, None);

        let mut fresh = CardStore::new(dir.path().to_path_buf());
        assert_eq!(fresh.get("card-1").unwrap().rev, 2);
    }

    #[test]
    fn append_creates_private_dir_and_file() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = CardStore::new(dir.path().to_path_buf());
        let repo = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let card = make_card(
            "card-priv",
            1,
            repo,
            Some("/work/repo"),
            Some(2_000),
            &["lib.rs"],
        );

        store.append(&card).unwrap();

        let cdir = cards_dir(dir.path());
        let cfile = cards_file(dir.path(), repo);
        assert!(cdir.is_dir());
        assert!(cfile.is_file());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&cdir).unwrap().permissions().mode() & 0o777,
                0o700
            );
            assert_eq!(
                fs::metadata(&cfile).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn rotation_at_8_mib_keeps_newest_under_6_mib() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = CardStore::new(dir.path().to_path_buf());
        let repo = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        let path = cards_file(dir.path(), repo);

        // Build ~90 KiB cards (30 blocks x ~2.5 KiB each) so ~95 cards cross 8 MiB.
        let big_blocks: Vec<Block> = (1..=30)
            .map(|seq| sample_block(seq, &format!("src/file_{seq}.rs"), 2_500))
            .collect();

        let make_big = |id: &str, rev: u32, ended_ms: u64| {
            let mut c = make_card(id, rev, repo, Some("/work/big"), Some(ended_ms), &[]);
            c.blocks = big_blocks.clone();
            c
        };

        store.append(&make_big("oldest-1", 1, 1_000)).unwrap();
        store.append(&make_big("oldest-1", 2, 1_000)).unwrap();
        store.append(&make_big("kept-multi", 1, 900_000)).unwrap();
        store.append(&make_big("kept-multi", 2, 900_000)).unwrap();

        let mut rotated = false;
        let mut i = 0u64;
        while fs::metadata(&path).unwrap().len() <= MAX_CARD_FILE_BYTES {
            i += 1;
            let len_before = fs::metadata(&path).unwrap().len();
            let card = make_big(&format!("c-{i:04}"), 1, 10_000 + i);
            store.append(&card).unwrap();
            let len_after = fs::metadata(&path).unwrap().len();
            if len_after < len_before {
                rotated = true;
                break;
            }
        }
        assert!(rotated, "expected file rotation above 8 MiB");

        let final_len = fs::metadata(&path).unwrap().len();
        assert!(
            final_len > 0 && final_len <= ROTATE_TARGET_BYTES,
            "rotated len={final_len}"
        );
        assert!(!tmp_file_path(&path).exists());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }

        assert!(store.get("oldest-1").is_none());
        let kept = store.get("kept-multi").expect("kept-multi retained");
        assert_eq!(kept.rev, 2);

        // Only the latest revision of each kept card remains on disk after rotation.
        let raw = fs::read_to_string(&path).unwrap();
        let revs: Vec<u32> = raw
            .lines()
            .filter_map(|line| serde_json::from_str::<Card>(line).ok())
            .filter(|c| c.card_id == "kept-multi")
            .map(|c| c.rev)
            .collect();
        assert_eq!(revs, vec![2]);
    }

    #[test]
    fn purged_file_drops_cache() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = CardStore::new(dir.path().to_path_buf());
        let repo_a = "11111111111111111111111111111111";
        let repo_b = "22222222222222222222222222222222";

        store
            .append(&make_card(
                "ca",
                1,
                repo_a,
                Some("/work/a"),
                Some(100),
                &["a.rs"],
            ))
            .unwrap();
        store
            .append(&make_card(
                "cb",
                1,
                repo_b,
                Some("/work/b"),
                Some(200),
                &["b.rs"],
            ))
            .unwrap();

        assert!(store.get("ca").is_some());
        assert_eq!(store.page(None, None, 20).0.len(), 2);

        fs::remove_file(cards_file(dir.path(), repo_a)).unwrap();

        assert!(store.get("ca").is_none());
        let (items, _) = store.page(None, None, 20);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].card_id, "cb");

        fs::remove_dir_all(cards_dir(dir.path())).unwrap();
        assert!(store.get("cb").is_none());
        assert!(store.page(None, None, 20).0.is_empty());
    }

    #[test]
    fn page_query_by_path_and_repo() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = CardStore::new(dir.path().to_path_buf());
        let r1 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let r2 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        let r3 = "cccccccccccccccccccccccccccccccc";

        store
            .append(&make_card(
                "c1",
                1,
                r1,
                Some("C:/Users/dev/AlphaRepo"),
                Some(100),
                &["src/auth/Login.rs", "Cargo.toml"],
            ))
            .unwrap();
        store
            .append(&make_card(
                "c2",
                1,
                r2,
                Some("/home/dev/BetaService/"),
                Some(200),
                &["src/Cart.ts"],
            ))
            .unwrap();
        store
            .append(&make_card(
                "c3",
                1,
                r3,
                Some("/work/parent-only/GammaApp"),
                Some(300),
                &["README.md"],
            ))
            .unwrap();

        let (all, _) = store.page(None, None, 20);
        let all_ids: Vec<&str> = all.iter().map(|c| c.card_id.as_str()).collect();
        assert_eq!(all_ids, vec!["c3", "c2", "c1"]);

        let (by_path, _) = store.page(Some("AUTH/login"), None, 20);
        assert_eq!(by_path.len(), 1);
        assert_eq!(by_path[0].card_id, "c1");
        assert_eq!(by_path[0].blocks.len(), 2);

        let (by_repo, _) = store.page(Some("betaservice"), None, 20);
        assert_eq!(by_repo.len(), 1);
        assert_eq!(by_repo[0].card_id, "c2");

        let (parent_miss, _) = store.page(Some("parent-only"), None, 20);
        assert!(parent_miss.is_empty());

        let (empty_q, _) = store.page(Some(""), None, 20);
        assert_eq!(empty_q.len(), 3);
    }

    #[test]
    fn page_cursor() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = CardStore::new(dir.path().to_path_buf());
        let repo = "dddddddddddddddddddddddddddddddd";

        for i in 1..=25u64 {
            let card = make_card(
                &format!("card-{i:02}"),
                1,
                repo,
                Some("/work/repo"),
                Some(i * 1_000),
                &["src/lib.rs"],
            );
            store.append(&card).unwrap();
        }

        // Limit above 20 is capped at 20.
        let (p1, next1) = store.page(None, None, 50);
        assert_eq!(p1.len(), MAX_PAGE_LIMIT);
        assert_eq!(p1[0].ended_ms, Some(25_000));
        assert_eq!(p1[19].ended_ms, Some(6_000));
        assert_eq!(next1.as_deref(), Some("6000:card-06"));

        let (p2, next2) = store.page(None, next1.as_deref(), 20);
        assert_eq!(p2.len(), 5);
        assert_eq!(p2[0].ended_ms, Some(5_000));
        assert_eq!(p2[4].ended_ms, Some(1_000));
        assert_eq!(next2, None);

        // Smaller limit paging through multiple cursors.
        let (s1, sn1) = store.page(None, None, 10);
        assert_eq!(s1.len(), 10);
        assert_eq!(sn1.as_deref(), Some("16000:card-16"));

        let (s2, sn2) = store.page(None, sn1.as_deref(), 10);
        assert_eq!(s2.len(), 10);
        assert_eq!(s2[0].ended_ms, Some(15_000));
        assert_eq!(sn2.as_deref(), Some("6000:card-06"));

        let (s3, sn3) = store.page(None, sn2.as_deref(), 10);
        assert_eq!(s3.len(), 5);
        assert_eq!(sn3, None);

        let (empty, next_empty) = store.page(None, None, 0);
        assert!(empty.is_empty());
        assert_eq!(next_empty, None);
    }

    #[test]
    fn page_cursor_breaks_identical_end_time_ties() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = CardStore::new(dir.path().to_path_buf());
        let repo = "dddddddddddddddddddddddddddddddd";

        for i in 1..=21u64 {
            let mut card = make_card(
                &format!("card-{i:02}"),
                1,
                repo,
                Some("/work/repo"),
                Some(5_000),
                &["src/lib.rs"],
            );
            // Vary started_ms in reverse order to verify sort order uses (key, card_id).
            card.started_ms = 4_000 - i;
            store.append(&card).unwrap();
        }

        let (p1, next1) = store.page(None, None, 20);
        assert_eq!(p1.len(), 20);
        assert_eq!(p1[0].card_id, "card-21");
        assert_eq!(p1[19].card_id, "card-02");
        assert_eq!(next1.as_deref(), Some("5000:card-02"));

        let (p2, next2) = store.page(None, next1.as_deref(), 20);
        assert_eq!(p2.len(), 1);
        assert_eq!(p2[0].card_id, "card-01");
        assert_eq!(next2, None);

        let seen: HashSet<String> = p1
            .iter()
            .chain(p2.iter())
            .map(|c| c.card_id.clone())
            .collect();
        assert_eq!(seen.len(), 21);
    }

    #[test]
    fn page_cursor_reaches_and_crosses_open_cards() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = CardStore::new(dir.path().to_path_buf());
        let repo = "dddddddddddddddddddddddddddddddd";

        for i in 1..=21u64 {
            let card = make_card(
                &format!("done-{i:02}"),
                1,
                repo,
                Some("/work/repo"),
                Some(10_000 + i),
                &["src/lib.rs"],
            );
            store.append(&card).unwrap();
        }
        let mut open_old = make_card("open-old", 1, repo, Some("/work/repo"), None, &["a.rs"]);
        open_old.started_ms = 500;
        open_old.status = CardStatus::Open;
        store.append(&open_old).unwrap();

        let (p1, next1) = store.page(None, None, 20);
        assert_eq!(p1.len(), 20);
        assert!(next1.is_some());

        let (p2, next2) = store.page(None, next1.as_deref(), 20);
        assert_eq!(p2.len(), 2);
        assert_eq!(p2[0].card_id, "done-01");
        assert_eq!(p2[1].card_id, "open-old");
        assert_eq!(p2[1].ended_ms, None);
        assert_eq!(next2, None);

        // Now verify paging when an open card sits at the exact page boundary and
        // shares its sort key with a completed card.
        let dir2 = tempfile::tempdir().unwrap();
        let mut store2 = CardStore::new(dir2.path().to_path_buf());
        for i in 1..=19u64 {
            store2
                .append(&make_card(
                    &format!("head-{i:02}"),
                    1,
                    repo,
                    Some("/work/repo"),
                    Some(30_000 + i),
                    &["a.rs"],
                ))
                .unwrap();
        }
        let mut open_mid = make_card("card-open", 1, repo, Some("/work/repo"), None, &["b.rs"]);
        open_mid.started_ms = 20_000;
        open_mid.status = CardStatus::Open;
        store2.append(&open_mid).unwrap();

        let mut tied_closed = make_card(
            "card-closed",
            1,
            repo,
            Some("/work/repo"),
            Some(20_000),
            &["c.rs"],
        );
        tied_closed.started_ms = 19_000;
        store2.append(&tied_closed).unwrap();

        store2
            .append(&make_card(
                "tail-01",
                1,
                repo,
                Some("/work/repo"),
                Some(10_000),
                &["d.rs"],
            ))
            .unwrap();

        let (b1, bnext1) = store2.page(None, None, 20);
        assert_eq!(b1.len(), 20);
        assert_eq!(b1[19].card_id, "card-open");
        assert_eq!(bnext1.as_deref(), Some("20000:card-open"));

        let (b2, bnext2) = store2.page(None, bnext1.as_deref(), 20);
        let b2_ids: Vec<&str> = b2.iter().map(|c| c.card_id.as_str()).collect();
        assert_eq!(b2_ids, vec!["card-closed", "tail-01"]);
        assert_eq!(bnext2, None);

        // Single-item paging visits every card exactly once without duplicates.
        let mut collected = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let (items, next) = store2.page(None, cursor.as_deref(), 1);
            assert_eq!(items.len(), 1);
            collected.push(items[0].card_id.clone());
            match next {
                Some(c) => cursor = Some(c),
                None => break,
            }
        }
        assert_eq!(collected.len(), 22);
        let unique: HashSet<&str> = collected.iter().map(String::as_str).collect();
        assert_eq!(unique.len(), 22);
    }

    #[test]
    fn page_malformed_cursor_returns_first_page() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = CardStore::new(dir.path().to_path_buf());
        let repo = "dddddddddddddddddddddddddddddddd";

        for (id, ms) in [("c1", 1_000), ("c2", 2_000), ("c3", 3_000)] {
            store
                .append(&make_card(
                    id,
                    1,
                    repo,
                    Some("/work/repo"),
                    Some(ms),
                    &["a.rs"],
                ))
                .unwrap();
        }

        let expected = store.page(None, None, 2);
        for bad in [
            "",
            "invalid",
            "2000",
            ":c2",
            "2000:",
            "-1:c2",
            "+2000:c2",
            " 2000:c2",
            "abc:c2",
            "99999999999999999999999999999:c2",
        ] {
            assert_eq!(
                store.page(None, Some(bad), 2),
                expected,
                "malformed cursor {bad:?} should return first page"
            );
        }
    }

    #[test]
    fn none_repo_goes_to_none_file() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = CardStore::new(dir.path().to_path_buf());

        let c_none = make_card("c-none", 1, "_none", None, Some(1_000), &["~/notes.md"]);
        let c_empty = make_card("c-empty", 1, "", None, Some(2_000), &["~/todo.md"]);
        store.append(&c_none).unwrap();
        store.append(&c_empty).unwrap();

        let none_path = cards_none_file(dir.path());
        assert!(none_path.is_file());
        assert!(!cards_file(dir.path(), "").exists());

        assert_eq!(store.get("c-none").unwrap().card_id, "c-none");
        assert_eq!(store.get("c-empty").unwrap().card_id, "c-empty");
        let (items, _) = store.page(None, None, 20);
        assert_eq!(items.len(), 2);
    }

    #[test]
    fn corrupt_line_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = CardStore::new(dir.path().to_path_buf());
        let repo = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
        let path = cards_file(dir.path(), repo);

        let c1 = make_card("c1", 1, repo, Some("/work/r"), Some(1_000), &["a.rs"]);
        store.append(&c1).unwrap();

        append_raw(&path, b"{corrupt json line\n");
        append_raw(&path, b"\xff\xfe\xfd\n");
        append_raw(&path, b"\n");
        // Torn trailing write without newline.
        append_raw(&path, b"{\"v\":1,\"card_id\":\"torn\"");

        let c2 = make_card("c2", 1, repo, Some("/work/r"), Some(2_000), &["b.rs"]);
        store.append(&c2).unwrap();

        // Non-jsonl stray files and bogus `.jsonl` directories are ignored by readers.
        append_raw(&tmp_file_path(&path), b"{not json}\n");
        fs::create_dir(cards_dir(dir.path()).join("bogus.jsonl")).unwrap();

        assert_eq!(store.get("c1").unwrap().card_id, "c1");
        assert_eq!(store.get("c2").unwrap().card_id, "c2");
        assert!(store.get("torn").is_none());

        let (items, _) = store.page(None, None, 20);
        let ids: Vec<&str> = items.iter().map(|c| c.card_id.as_str()).collect();
        assert_eq!(ids, vec!["c2", "c1"]);
    }

    fn prepare_near_limit_file(
        store: &mut CardStore,
        path: &Path,
        repo: &str,
        overflow_id: &str,
    ) -> Card {
        let big_blocks: Vec<Block> = (1..=30)
            .map(|seq| sample_block(seq, &format!("src/file_{seq}.rs"), 2_500))
            .collect();
        let make_big = |id: &str, ended_ms: u64| {
            let mut c = make_card(id, 1, repo, Some("/work/big"), Some(ended_ms), &[]);
            c.blocks = big_blocks.clone();
            c
        };

        let overflow = make_big(overflow_id, 99_999);
        let overflow_bytes = serde_json::to_vec(&overflow).unwrap().len() as u64 + 1;

        let mut i = 0u64;
        loop {
            i += 1;
            let c = make_big(&format!("pre-{i:04}"), 1_000 + i);
            store.append(&c).unwrap();
            let len = fs::metadata(path).unwrap().len();
            assert!(len <= MAX_CARD_FILE_BYTES);
            if len + overflow_bytes > MAX_CARD_FILE_BYTES {
                break;
            }
        }
        overflow
    }

    #[test]
    fn failed_rotation_leaves_original_intact() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = CardStore::new(dir.path().to_path_buf());
        let repo = "ffffffffffffffffffffffffffffffff";
        let path = cards_file(dir.path(), repo);

        let overflow = prepare_near_limit_file(&mut store, &path, repo, "overflow-card");

        // Block `<file>.tmp` with a directory so rewriting fails.
        fs::create_dir(tmp_file_path(&path)).unwrap();

        assert!(store.append(&overflow).is_err());

        // Original file still exists with the appended line and was not clobbered.
        let len_after = fs::metadata(&path).unwrap().len();
        assert!(len_after > MAX_CARD_FILE_BYTES);
        assert!(store.get("overflow-card").is_some());
        assert!(store.get("pre-0001").is_some());
    }

    #[test]
    fn cache_hits_when_stat_unchanged_and_reloads_on_change() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = CardStore::new(dir.path().to_path_buf());
        let repo = "00000000000000000000000000000001";

        store
            .append(&make_card(
                "c1",
                1,
                repo,
                Some("/work/r"),
                Some(1_000),
                &["a.rs"],
            ))
            .unwrap();
        assert!(store.get("c1").is_some());
        assert_eq!(store.disk_reads, 1);

        // Unchanged file stays cached on subsequent get/page calls.
        assert!(store.get("c1").is_some());
        assert_eq!(store.page(None, None, 20).0.len(), 1);
        assert_eq!(store.disk_reads, 1);

        // External append changes len -> reloads file.
        let c2 = make_card("c2", 1, repo, Some("/work/r"), Some(2_000), &["b.rs"]);
        let mut line = serde_json::to_vec(&c2).unwrap();
        line.push(b'\n');
        append_raw(&cards_file(dir.path(), repo), &line);

        assert!(store.get("c2").is_some());
        assert_eq!(store.disk_reads, 2);
        assert_eq!(store.page(None, None, 20).0.len(), 2);
        assert_eq!(store.disk_reads, 2);
    }

    fn create_file_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, link)
        }
        #[cfg(windows)]
        {
            std::os::windows::fs::symlink_file(target, link)
        }
    }

    fn create_dir_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, link)
        }
        #[cfg(windows)]
        {
            std::os::windows::fs::symlink_dir(target, link)
        }
    }

    #[test]
    fn append_refuses_symlinked_card_file() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = CardStore::new(dir.path().to_path_buf());
        let repo = "12121212121212121212121212121212";
        fs::create_dir_all(cards_dir(dir.path())).unwrap();

        let protected = dir.path().join("protected.jsonl");
        fs::write(&protected, b"do-not-overwrite\n").unwrap();

        let card_path = cards_file(dir.path(), repo);
        if let Err(err) = create_file_symlink(&protected, &card_path) {
            #[cfg(windows)]
            {
                eprintln!("skipping symlink assertion: cannot create symlink on this host: {err}");
                return;
            }
            #[cfg(not(windows))]
            panic!("failed to create symlink: {err}");
        }

        let card = make_card("c-link", 1, repo, Some("/work/r"), Some(1_000), &["a.rs"]);
        assert!(store.append(&card).is_err());
        assert_eq!(fs::read(&protected).unwrap(), b"do-not-overwrite\n");

        let dangling_repo = "34343434343434343434343434343434";
        let missing_target = dir.path().join("missing-target.jsonl");
        let dangling_link = cards_file(dir.path(), dangling_repo);
        create_file_symlink(&missing_target, &dangling_link).unwrap();

        let dangling_card = make_card(
            "c-dangling",
            1,
            dangling_repo,
            Some("/work/r"),
            Some(1_000),
            &["a.rs"],
        );
        assert!(store.append(&dangling_card).is_err());
        assert!(!missing_target.exists());
    }

    #[test]
    fn rotation_refuses_symlinked_tmp_file() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = CardStore::new(dir.path().to_path_buf());
        let repo = "56565656565656565656565656565656";
        let path = cards_file(dir.path(), repo);

        let overflow = prepare_near_limit_file(&mut store, &path, repo, "overflow-link");

        let protected = dir.path().join("protected-tmp-target.jsonl");
        fs::write(&protected, b"must-not-truncate\n").unwrap();
        let tmp = tmp_file_path(&path);
        if let Err(err) = create_file_symlink(&protected, &tmp) {
            #[cfg(windows)]
            {
                eprintln!("skipping symlink assertion: cannot create symlink on this host: {err}");
                return;
            }
            #[cfg(not(windows))]
            panic!("failed to create symlink: {err}");
        }

        assert!(store.append(&overflow).is_err());
        assert_eq!(fs::read(&protected).unwrap(), b"must-not-truncate\n");
        assert!(fs::symlink_metadata(&tmp).unwrap().file_type().is_symlink());
    }

    #[test]
    fn rotation_replaces_stale_regular_tmp_file() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = CardStore::new(dir.path().to_path_buf());
        let repo = "78787878787878787878787878787878";
        let path = cards_file(dir.path(), repo);

        let overflow = prepare_near_limit_file(&mut store, &path, repo, "overflow-stale");

        let tmp = tmp_file_path(&path);
        fs::write(&tmp, b"stale partial tmp\n").unwrap();

        store.append(&overflow).unwrap();
        assert!(!tmp.exists());
        let final_len = fs::metadata(&path).unwrap().len();
        assert!(final_len > 0 && final_len <= ROTATE_TARGET_BYTES);
        assert!(store.get("overflow-stale").is_some());
    }

    #[test]
    fn rotation_keeps_only_latest_revision_and_never_drops_newest_card() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = CardStore::new(dir.path().to_path_buf());
        let repo_multi = "61616161616161616161616161616161";

        let mut older = make_card("multi-rev", 1, repo_multi, Some("/work/m"), Some(1_000), &["a.rs"]);
        older.prompt = "a".repeat(4_500_000);
        store.append(&older).unwrap();

        let mut latest = make_card("multi-rev", 2, repo_multi, Some("/work/m"), Some(2_000), &["a.rs"]);
        latest.prompt = "b".repeat(4_500_000);
        store.append(&latest).unwrap();

        let kept = store
            .get("multi-rev")
            .expect("card with revisions totaling over 6 MiB must survive rotation");
        assert_eq!(kept.rev, 2);
        let path_multi = cards_file(dir.path(), repo_multi);
        let raw_multi = fs::read_to_string(&path_multi).unwrap();
        let revs: Vec<u32> = raw_multi
            .lines()
            .filter_map(|line| serde_json::from_str::<Card>(line).ok())
            .filter(|c| c.card_id == "multi-rev")
            .map(|c| c.rev)
            .collect();
        assert_eq!(revs, vec![2]);

        let repo_huge = "62626262626262626262626262626262";
        let old_small = make_card("old-small", 1, repo_huge, Some("/work/h"), Some(100), &["a.rs"]);
        store.append(&old_small).unwrap();

        let mut huge_newest = make_card(
            "huge-newest",
            1,
            repo_huge,
            Some("/work/h"),
            Some(9_000),
            &["b.rs"],
        );
        huge_newest.prompt = "z".repeat(MAX_CARD_FILE_BYTES as usize + 1_024);
        store.append(&huge_newest).unwrap();

        let path_huge = cards_file(dir.path(), repo_huge);
        assert!(fs::metadata(&path_huge).unwrap().len() > 0);
        assert!(store.get("huge-newest").is_some());
        assert!(store.get("old-small").is_none());
    }

    #[test]
    fn append_refuses_symlinked_cards_dir() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = CardStore::new(dir.path().to_path_buf());
        let repo = "90909090909090909090909090909090";

        let target_dir = dir.path().join("outside-cards-target");
        fs::create_dir_all(&target_dir).unwrap();
        fs::create_dir_all(desk_dir(dir.path())).unwrap();

        let cdir = cards_dir(dir.path());
        if let Err(err) = create_dir_symlink(&target_dir, &cdir) {
            #[cfg(windows)]
            {
                eprintln!("skipping symlink assertion: cannot create symlink on this host: {err}");
                return;
            }
            #[cfg(not(windows))]
            panic!("failed to create dir symlink: {err}");
        }

        let card = make_card(
            "c-dir-link",
            1,
            repo,
            Some("/work/r"),
            Some(1_000),
            &["a.rs"],
        );
        assert!(store.append(&card).is_err());
        assert_eq!(fs::read_dir(&target_dir).unwrap().count(), 0);
    }

    #[cfg(windows)]
    #[test]
    fn append_refuses_reparse_point_cards_dir() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = CardStore::new(dir.path().to_path_buf());
        let repo = "abababababababababababababababab";

        let target_dir = dir.path().join("outside-junction-target");
        fs::create_dir_all(&target_dir).unwrap();
        fs::create_dir_all(desk_dir(dir.path())).unwrap();

        let cdir = cards_dir(dir.path());
        let output = std::process::Command::new("cmd")
            .arg("/C")
            .arg("mklink")
            .arg("/J")
            .arg(&cdir)
            .arg(&target_dir)
            .output()
            .unwrap();
        if !output.status.success() {
            eprintln!(
                "skipping reparse point assertion: mklink /J failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }

        let card = make_card(
            "c-junction",
            1,
            repo,
            Some("/work/r"),
            Some(1_000),
            &["a.rs"],
        );
        assert!(store.append(&card).is_err());
        assert_eq!(fs::read_dir(&target_dir).unwrap().count(), 0);

        let existing = make_card(
            "c-outside",
            1,
            repo,
            Some("/work/r"),
            Some(2_000),
            &["b.rs"],
        );
        let line = serde_json::to_string(&existing).unwrap() + "\n";
        fs::write(target_dir.join(format!("{repo}.jsonl")), line).unwrap();
        assert!(store.get("c-outside").is_none());
        assert!(store.page(None, None, 20).0.is_empty());

        // Also refuse when desk_dir itself is a reparse point before cards_dir exists.
        let dir2 = tempfile::tempdir().unwrap();
        let mut store2 = CardStore::new(dir2.path().to_path_buf());
        let desk_target = dir2.path().join("outside-desk-target");
        fs::create_dir_all(&desk_target).unwrap();
        let ddir = desk_dir(dir2.path());
        let out2 = std::process::Command::new("cmd")
            .arg("/C")
            .arg("mklink")
            .arg("/J")
            .arg(&ddir)
            .arg(&desk_target)
            .output()
            .unwrap();
        assert!(out2.status.success());
        assert!(store2.append(&card).is_err());
        assert_eq!(fs::read_dir(&desk_target).unwrap().count(), 0);
    }

    #[test]
    fn append_refuses_without_creating_directories_when_removed() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = CardStore::new(dir.path().to_path_buf());
        store.set_removed();

        let card = make_card(
            "c-removed",
            1,
            "r1",
            Some("/work/r"),
            Some(1_000),
            &["a.rs"],
        );
        assert!(store.append(&card).is_err());
        assert!(!cards_dir(dir.path()).exists());
        assert!(!desk_dir(dir.path()).exists());

        fs::create_dir_all(desk_dir(dir.path())).unwrap();
        assert!(store.append(&card).is_err());
        assert!(!cards_dir(dir.path()).exists());
    }
}
