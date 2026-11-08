//! Bounded connect/spawn/retry for rocky-desk, run off the UI thread.

use std::path::Path;
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

use rocky_proto::pipe::ServerMsg;

use crate::client::{self, HELLO_TIMEOUT, Outbox};
use crate::conn::ConnectOutcome;
use crate::spawn::spawn_daemon;

/// Wall-clock budget for one connect attempt, handshake included.
pub const CONNECT_BUDGET: Duration = Duration::from_secs(5);

/// Result of one background connect attempt, delivered to the foreground.
pub struct ConnectDone {
    pub outcome: ConnectOutcome,
    /// Present on `Connected`: the live outbox + inbox.
    pub live: Option<(Outbox, Receiver<Option<ServerMsg>>)>,
    /// True when the daemon was spawned without breakaway (sticky warning).
    pub tied_to_job: bool,
}

impl ConnectDone {
    fn failed(outcome: ConnectOutcome) -> Self {
        ConnectDone {
            outcome,
            live: None,
            tied_to_job: false,
        }
    }
}

/// One connect attempt: probe the pipe; on absence spawn the daemon and retry
/// with backoff (100 ms doubling, capped at 1 s). The whole attempt is bounded
/// by `budget` of wall clock, handshake included, so a daemon that accepts and
/// then never answers hello costs one handshake bound instead of the full
/// retry budget. Keeps the live streams of the winning attempt. Never retries
/// foreign/wrong-version daemons and never spawns after a hello timeout.
/// Blocking is fine: runs on a worker thread (or pre-loop at startup).
pub fn connect_attempt(
    rocky_home: &Path,
    daemon_exe: Option<&Path>,
    budget: Duration,
) -> ConnectDone {
    let deadline = Instant::now() + budget;
    let mut first = true;
    let mut tied = false;
    let mut wait = Duration::from_millis(100);
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            // A try never starts after the deadline.
            return ConnectDone::failed(ConnectOutcome::NoDaemon);
        }
        // The 1 s floor keeps a late try from failing on a zero wait, and
        // keeps the total within one second of the budget.
        let hello_timeout = remaining.max(Duration::from_secs(1)).min(HELLO_TIMEOUT);
        let (tx, rx) = mpsc::channel();
        match client::connect_and_subscribe(rocky_home, tx, hello_timeout) {
            Ok(outbox) => {
                return ConnectDone {
                    outcome: ConnectOutcome::Connected,
                    live: Some((outbox, rx)),
                    tied_to_job: tied,
                };
            }
            Err(client::ConnectError::Unverified) => {
                return ConnectDone::failed(ConnectOutcome::Unverified);
            }
            Err(client::ConnectError::VersionMismatch) => {
                return ConnectDone::failed(ConnectOutcome::VersionMismatch);
            }
            Err(client::ConnectError::Unresponsive) => {
                return ConnectDone::failed(ConnectOutcome::Unresponsive);
            }
            Err(_) => {}
        }
        if first {
            first = false;
            if let Some(exe) = daemon_exe {
                match spawn_daemon(exe) {
                    Ok(info) => tied = info.tied_to_job,
                    Err(_) => return ConnectDone::failed(ConnectOutcome::SpawnFailed),
                }
            }
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return ConnectDone::failed(ConnectOutcome::NoDaemon);
        }
        std::thread::sleep(wait.min(remaining));
        wait = (wait * 2).min(Duration::from_secs(1));
    }
}
