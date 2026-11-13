//! Desk history: hourly JSONL segments under `<ROCKY_HOME>/desk/history/`,
//! kept for a day and capped in bytes. Replay rebuilds state after a restart.

use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use rocky_proto::history::{HISTORY_VERSION, HistoryBody, HistoryLine};
use rocky_proto::hook::HookEvent;
use rocky_proto::pipe::{Gap, GapReason, RepoInfo};

use crate::gaps::Gaps;
use crate::state::StatusState;

pub const HISTORY_CAP_BYTES: u64 = 64 * 1024 * 1024;
pub const HISTORY_KEEP_MS: u64 = 24 * 60 * 60_000;

const SEGMENT_MS: u64 = 3_600_000;
const DAY_MS: u64 = 86_400_000;

#[derive(Debug)]
pub struct History {
    dir: PathBuf,
    cap_bytes: u64,
    enabled: bool,
    total_bytes: u64,
}

impl History {
    /// Opens the history directory; creates it only when enabled. The byte
    /// total covers accepted segments only.
    pub fn open(dir: &Path, cap_bytes: u64, enabled: bool) -> History {
        if enabled {
            let _ = fs::create_dir_all(dir);
        }
        let mut history = History {
            dir: dir.to_path_buf(),
            cap_bytes,
            enabled,
            total_bytes: 0,
        };
        history.total_bytes = history.segment_total();
        history
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }

    /// Deletes segments that ended before `now_ms - HISTORY_KEEP_MS`.
    /// Foreign files and delete failures are left alone.
    pub fn prune_old(&mut self, now_ms: u64) -> io::Result<()> {
        let cutoff = now_ms.saturating_sub(HISTORY_KEEP_MS);
        for (path, name, size) in self.segments() {
            let Some(start) = segment_start_ms(&name) else {
                continue;
            };
            if start.saturating_add(SEGMENT_MS) > cutoff {
                continue;
            }
            match fs::remove_file(&path) {
                Ok(()) => self.total_bytes = self.total_bytes.saturating_sub(size),
                Err(e) if e.kind() == io::ErrorKind::NotFound => {
                    self.total_bytes = self.total_bytes.saturating_sub(size);
                }
                Err(_) => {}
            }
        }
        Ok(())
    }

    /// Appends one line to the segment for `now_ms`. A torn last line gets a
    /// newline first. Over cap, the oldest other segment is deleted and one
    /// `history_full` gap line is written for what was lost.
    pub fn append(&mut self, line: &HistoryLine, now_ms: u64) -> io::Result<Option<Gap>> {
        if !self.enabled {
            return Ok(None);
        }
        let name = segment_name(now_ms);
        let path = self.dir.join(&name);
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .read(true)
            .open(&path)?;
        let mut written = 0u64;
        let len = file.metadata()?.len();
        if len > 0 {
            let mut last = [0u8; 1];
            file.seek(SeekFrom::Start(len - 1))?;
            if file.read(&mut last)? == 1 && last[0] != b'\n' {
                file.write_all(b"\n")?;
                written += 1;
            }
        }
        written += write_line(&mut file, line)?;
        self.total_bytes = self.total_bytes.saturating_add(written);

        let mut deleted: Vec<(u64, u64)> = Vec::new();
        while self.total_bytes > self.cap_bytes {
            let Some((other, other_start, size)) = self.oldest_segment_except(&name) else {
                break;
            };
            let lines = fs::read(&other)
                .map(|bytes| count_lines(&bytes))
                .unwrap_or(0);
            let removed = match fs::remove_file(&other) {
                Ok(()) => true,
                Err(e) if e.kind() == io::ErrorKind::NotFound => true,
                Err(_) => false,
            };
            if !removed {
                break;
            }
            self.total_bytes = self.total_bytes.saturating_sub(size);
            deleted.push((other_start, lines));
        }
        if deleted.is_empty() {
            return Ok(None);
        }
        let gap = Gap {
            from_ms: deleted[0].0,
            to_ms: deleted[deleted.len() - 1].0.saturating_add(SEGMENT_MS - 1),
            count: deleted.iter().map(|(_, lines)| lines).sum(),
            reason: GapReason::HistoryFull,
        };
        let gap_line = HistoryLine {
            v: HISTORY_VERSION,
            body: HistoryBody::Gap(gap),
            src: None,
        };
        let written = write_line(&mut file, &gap_line)?;
        self.total_bytes = self.total_bytes.saturating_add(written);
        Ok(Some(gap))
    }

    /// Off deletes every accepted segment and makes `append` a no-op; on
    /// creates the directory and resumes.
    pub fn set_enabled(&mut self, on: bool) -> io::Result<()> {
        if on {
            fs::create_dir_all(&self.dir)?;
            self.total_bytes = self.segment_total();
            self.enabled = true;
        } else {
            self.enabled = false;
            let mut first_error = None;
            for (path, _, _) in self.segments() {
                match fs::remove_file(&path) {
                    Ok(()) => {}
                    Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                    Err(e) => {
                        if first_error.is_none() {
                            first_error = Some(e);
                        }
                    }
                }
            }
            self.total_bytes = 0;
            if let Some(e) = first_error {
                return Err(e);
            }
        }
        Ok(())
    }

    /// Accepted segment files only, oldest first by name.
    fn segments(&self) -> Vec<(PathBuf, String, u64)> {
        let Ok(entries) = fs::read_dir(&self.dir) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|n| n.to_str()).map(str::to_owned) else {
                continue;
            };
            if segment_start_ms(&name).is_none() {
                continue;
            }
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if !meta.is_file() {
                continue;
            }
            out.push((path, name, meta.len()));
        }
        out.sort_by(|a, b| a.1.cmp(&b.1));
        out
    }

    fn segment_total(&self) -> u64 {
        self.segments()
            .iter()
            .fold(0, |sum, (_, _, size)| sum.saturating_add(*size))
    }

    /// Oldest segment other than `name`, with its start time and size.
    fn oldest_segment_except(&self, name: &str) -> Option<(PathBuf, u64, u64)> {
        self.segments().into_iter().find_map(|(path, other, size)| {
            if other == name {
                return None;
            }
            let start = segment_start_ms(&other)?;
            Some((path, start, size))
        })
    }
}

/// Replays accepted segments into state and gaps, returning every `src` seen.
/// Unparseable lines, foreign versions, and unreadable segments are skipped.
pub fn replay(
    history: &History,
    state: &mut StatusState,
    gaps: &mut Gaps,
    repo_of: &mut dyn FnMut(&str) -> RepoInfo,
) -> HashSet<String> {
    let mut srcs = HashSet::new();
    if !history.enabled() {
        return srcs;
    }
    for (path, _, _) in history.segments() {
        let Ok(bytes) = fs::read(&path) else {
            continue;
        };
        for raw in bytes.split(|b| *b == b'\n') {
            if raw.is_empty() {
                continue;
            }
            let Ok(line) = serde_json::from_slice::<HistoryLine>(raw) else {
                continue;
            };
            if line.v != HISTORY_VERSION {
                continue;
            }
            if let Some(src) = line.src {
                srcs.insert(src);
            }
            match line.body {
                HistoryBody::Event { recv_ms, event, .. } => {
                    let event = HookEvent {
                        prompt: None,
                        ..event
                    };
                    let event = state.prepare(event);
                    state.apply(&event, recv_ms, repo_of);
                }
                HistoryBody::Gap(gap) => {
                    gaps.push(gap);
                    state.record_gap(&gap);
                }
            }
        }
    }
    srcs
}

/// `yyyyMMddHH.jsonl` for the UTC hour containing `ms`.
pub fn segment_name(ms: u64) -> String {
    let (year, month, day) = civil_from_days((ms / DAY_MS) as i64);
    let hour = (ms / SEGMENT_MS) % 24;
    format!("{year:04}{month:02}{day:02}{hour:02}.jsonl")
}

/// Start of the UTC hour named by `name`, or `None` when the name is not an
/// accepted segment name.
pub fn segment_start_ms(name: &str) -> Option<u64> {
    let digits = name.strip_suffix(".jsonl")?;
    if digits.len() != 10 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let year: i64 = digits[0..4].parse().ok()?;
    let month: u32 = digits[4..6].parse().ok()?;
    let day: u32 = digits[6..8].parse().ok()?;
    let hour: u32 = digits[8..10].parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour >= 24 {
        return None;
    }
    let days = days_from_civil(year, month, day);
    let ms = days
        .checked_mul(DAY_MS as i64)?
        .checked_add(i64::from(hour) * SEGMENT_MS as i64)?;
    let ms = u64::try_from(ms).ok()?;
    (segment_name(ms) == name).then_some(ms)
}

/// Writes one JSON line and returns its byte count.
fn write_line(file: &mut File, line: &HistoryLine) -> io::Result<u64> {
    let json = serde_json::to_vec(line).map_err(io::Error::other)?;
    file.write_all(&json)?;
    file.write_all(b"\n")?;
    Ok(json.len() as u64 + 1)
}

/// Records in a segment: newline-terminated lines plus a torn tail.
fn count_lines(bytes: &[u8]) -> u64 {
    let newlines = bytes.iter().filter(|b| **b == b'\n').count() as u64;
    match bytes.last() {
        None => 0,
        Some(b'\n') => newlines,
        Some(_) => newlines + 1,
    }
}

/// Days since 1970-01-01 to civil date, after Howard Hinnant's algorithm.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

/// Civil date to days since 1970-01-01, the inverse of [`civil_from_days`].
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64;
    let mp = u64::from(if month > 2 { month - 3 } else { month + 9 });
    let doy = (153 * mp + 2) / 5 + u64::from(day) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe as i64 - 719_468
}
