//! Second-launch relay: one desk asks the running one to come to the front.

use std::sync::Arc;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use rocky_desk::client::connect_and_subscribe;
use rocky_desk::relay::{RELAY_TIMEOUT, RelayError, send_show};
use rocky_proto::pipe::{Health, ServerMsg, Status};
use rocky_proto::settings::Settings;
use rockyd::server::{Hub, serve};
use tempfile::TempDir;

const GUARD: Duration = Duration::from_secs(10);
const HELLO: Duration = Duration::from_secs(5);

fn empty_snapshot() -> ServerMsg {
    ServerMsg::Snapshot {
        agents: Vec::new(),
        aggregate: Status::Idle,
        health: Health::default(),
        settings: Settings::default(),
    }
}

fn start_server() -> (TempDir, std::thread::JoinHandle<()>) {
    let home = TempDir::new().unwrap();
    let hub = Arc::new(Hub::new());
    let (control_tx, _control_rx) = mpsc::channel();
    let handle = serve(home.path(), hub, Arc::new(empty_snapshot), control_tx).unwrap();
    (home, handle)
}

#[test]
fn show_relay_reaches_other_subscribers() {
    let (home, _server) = start_server();
    let (tx_b, rx_b) = mpsc::channel();
    let _outbox_b = connect_and_subscribe(home.path(), tx_b, HELLO).expect("subscriber connects");
    // The snapshot proves the daemon registered this subscriber under the
    // hub lock, so a later broadcast cannot slip past it.
    let first = rx_b.recv_timeout(GUARD).expect("snapshot arrives");
    assert!(
        matches!(first, Some(ServerMsg::Snapshot { .. })),
        "got {first:?}"
    );

    send_show(home.path(), RELAY_TIMEOUT).expect("relay is acked");

    loop {
        match rx_b.recv_timeout(GUARD) {
            Ok(Some(ServerMsg::Show)) => break,
            Ok(Some(_)) => {}
            Ok(None) => panic!("subscriber connection closed before show"),
            Err(e) => panic!("show broadcast not received: {e}"),
        }
    }
}

#[test]
fn show_relay_without_daemon_returns_quickly() {
    let home = TempDir::new().unwrap();
    let start = Instant::now();
    let err = send_show(home.path(), RELAY_TIMEOUT).expect_err("no daemon to relay to");
    let elapsed = start.elapsed();
    assert!(
        matches!(err, RelayError::Connect(_)),
        "expected connect failure, got: {err:?}"
    );
    // Anti-hang guard: a missing pipe fails now, never waits out the ack.
    assert!(
        elapsed <= RELAY_TIMEOUT + Duration::from_secs(1),
        "took {elapsed:?}"
    );
}
