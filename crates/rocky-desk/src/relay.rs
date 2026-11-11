//! Second-launch relay: ask the running desk to come to the front, or to close.
//!
//! The relay connects without spawning, completes hello and subscribe (the
//! daemon requires subscribe before commands), sends one command, and waits a
//! bounded time for the ack. Failures are returned to the caller, which stays
//! silent: the running desk may be starting up or already gone.

use std::path::Path;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use rocky_proto::pipe::{ClientMsg, CmdName, ServerMsg};

use crate::client::{ConnectError, connect_and_subscribe};

/// Upper bound on the whole relay round trip: connect, hello, subscribe, the
/// command, and its ack. A launch that cannot finish in this time gives up.
pub const RELAY_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug)]
pub enum RelayError {
    /// The daemon could not be reached or did not answer the handshake.
    Connect(ConnectError),
    /// The connection closed before the command could be queued.
    Send,
    /// No ack arrived before the timeout (or the connection closed first).
    NoAck,
    /// The daemon answered the command with an error.
    Rejected(String),
}

/// Ask the daemon to broadcast `name` to every subscriber.
///
/// Subscribes first because the daemon rejects commands from unsubscribed
/// clients. Broadcasts and other acks arriving before the matching
/// [`ServerMsg::Ack`] are skipped. `timeout` bounds the entire call.
pub fn send_cmd(rocky_home: &Path, name: CmdName, timeout: Duration) -> Result<(), RelayError> {
    let deadline = Instant::now() + timeout;
    let (tx, rx) = mpsc::channel();
    let outbox = connect_and_subscribe(rocky_home, tx, timeout).map_err(RelayError::Connect)?;
    outbox
        .send(ClientMsg::Cmd { name, id: 1 })
        .map_err(|_| RelayError::Send)?;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(RelayError::NoAck);
        }
        match rx.recv_timeout(remaining) {
            Ok(Some(ServerMsg::Ack {
                id: 1, ok: true, ..
            })) => return Ok(()),
            Ok(Some(ServerMsg::Ack {
                id: 1,
                ok: false,
                error,
            })) => return Err(RelayError::Rejected(error.unwrap_or_default())),
            // Snapshot, settings, and the command's own broadcast may arrive
            // before the ack; the ack is the only message that ends the wait.
            Ok(Some(_)) => {}
            Ok(None) | Err(mpsc::RecvTimeoutError::Disconnected) => return Err(RelayError::NoAck),
            Err(mpsc::RecvTimeoutError::Timeout) => return Err(RelayError::NoAck),
        }
    }
}

/// Ask the daemon to broadcast `show` so the running desk reveals its window.
pub fn send_show(rocky_home: &Path, timeout: Duration) -> Result<(), RelayError> {
    send_cmd(rocky_home, CmdName::Show, timeout)
}
