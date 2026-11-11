//! `rocky-hook desk-hook <harness>`: spool one stdin payload, always exit 0.
//!
//! Claude Code treats a non-zero exit as "block", so every failure path —
//! including panics — ends here with exit 0 and empty stdout/stderr.

mod write;

use std::io::Read as _;
use std::panic::{self, AssertUnwindSafe};
use std::time::{SystemTime, UNIX_EPOCH};

use rocky_proto::hook::{DropReason, ID_CAP, STDIN_CAP, parse_hook_payload};
use rocky_proto::paths::{rocky_home, spool_dir, tool_text_off_marker};
use rocky_proto::spool::{SPOOL_VERSION, SpoolBody, SpoolRecord};

fn main() {
    // The default panic hook prints to stderr; silence it before catch_unwind.
    panic::set_hook(Box::new(|_| {}));
    let _ = panic::catch_unwind(AssertUnwindSafe(run));
    std::process::exit(0);
}

fn run() {
    let Some(harness) = parse_argv() else {
        return;
    };
    let (data, oversize) = read_stdin();
    let home = rocky_home();
    let capture = !tool_text_off_marker(&home).exists();
    let body = match oversize {
        Some(total) => SpoolBody::Dropped {
            reason: DropReason::Oversize,
            bytes: total,
        },
        None => match parse_hook_payload(&data, capture) {
            Ok(event) => SpoolBody::Event { event },
            Err(reason) => SpoolBody::Dropped {
                reason,
                bytes: data.len() as u64,
            },
        },
    };
    let rec = SpoolRecord {
        v: SPOOL_VERSION,
        harness,
        recv_ms: now_ms(),
        config_dir: None,
        body,
    };
    let _ = write::write_record(&spool_dir(&home), &rec);
}

/// Exactly `desk-hook <harness>`; anything else means "write nothing".
fn parse_argv() -> Option<String> {
    let mut args = std::env::args_os().skip(1);
    let cmd = args.next()?;
    let harness = args.next()?;
    if args.next().is_some() || cmd != "desk-hook" {
        return None;
    }
    let harness = harness.into_string().ok()?;
    Some(cut_id(&harness))
}

/// Cap the harness id at [`ID_CAP`] bytes on a char boundary.
fn cut_id(s: &str) -> String {
    if s.len() <= ID_CAP {
        return s.to_owned();
    }
    let mut end = ID_CAP;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_owned()
}

/// Read stdin. Returns the payload, or `Some(total)` when it exceeds the cap
/// (the rest is drained and discarded while counting bytes).
fn read_stdin() -> (Vec<u8>, Option<u64>) {
    let stdin = std::io::stdin();
    let mut input = stdin.lock();
    let mut data = Vec::new();
    let mut chunk = [0u8; 8192];
    let mut oversize = None;
    loop {
        let n = match input.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        if oversize.is_some() {
            oversize = oversize.map(|total| total + n as u64);
        } else if data.len() + n > STDIN_CAP {
            oversize = Some((data.len() + n) as u64);
        } else {
            data.extend_from_slice(&chunk[..n]);
        }
    }
    (data, oversize)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}
