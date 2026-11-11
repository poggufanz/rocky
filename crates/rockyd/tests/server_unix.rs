//! Server socket tests (in-process): each test gets its own temp ROCKY_HOME so
//! socket names are unique.

#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use rocky_proto::paths::{desk_dir, socket_path};
use rocky_proto::pipe::{ClientMsg, Health, ServerMsg, Status, decode, encode};
use rocky_proto::settings::Settings;
use rockyd::server::{BindError, Hub, serve};
use tempfile::TempDir;

const GUARD: Duration = Duration::from_secs(10);

/// `serve` sets the process umask for the bind, and Rust runs the tests in one
/// binary on parallel threads: a `TempDir` created inside that window would
/// lose its owner execute bit. Serialize the tests so nothing creates files
/// while another test binds.
static SERVE_LOCK: Mutex<()> = Mutex::new(());

fn serialize() -> std::sync::MutexGuard<'static, ()> {
    SERVE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn home() -> TempDir {
    TempDir::new().unwrap()
}

/// Test client: socket clone for blocking reads behind a read timeout, so a
/// missing reply fails the guard instead of hanging.
struct Client {
    stream: UnixStream,
    reader: BufReader<UnixStream>,
}

fn connect(path: &Path) -> Client {
    let start = Instant::now();
    loop {
        match UnixStream::connect(path) {
            Ok(stream) => {
                stream.set_read_timeout(Some(GUARD)).unwrap();
                let reader = BufReader::new(stream.try_clone().unwrap());
                return Client { stream, reader };
            }
            Err(e) => {
                assert!(start.elapsed() < GUARD, "connect timed out: {e}");
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    }
}

impl Client {
    fn send(&mut self, line: &str) {
        self.stream.write_all(line.as_bytes()).unwrap();
        self.stream.flush().unwrap();
    }

    /// Read one line; the read timeout bounds the wait. None means EOF.
    fn read_line(&mut self) -> Option<String> {
        let mut line = String::new();
        match self.reader.read_line(&mut line).unwrap() {
            0 => None,
            _ => Some(line),
        }
    }
}

fn snapshot_msg() -> ServerMsg {
    ServerMsg::Snapshot {
        agents: vec![],
        aggregate: Status::Idle,
        health: Health::default(),
        settings: Settings::default(),
        repo_pending: Vec::new(),
    }
}

fn hello_line() -> String {
    encode(&ClientMsg::Hello {
        client: "desk".into(),
        version: "0.1.0".into(),
    })
}

#[test]
fn hello_subscribe_snapshot_over_unix_socket() {
    let _serial = serialize();
    let home = home();
    let hub = Arc::new(Hub::new());
    let (control_tx, _control_rx) = mpsc::channel();
    let _handle = serve(
        home.path(),
        Arc::clone(&hub),
        Arc::new(snapshot_msg),
        control_tx,
    )
    .unwrap();

    let mut client = connect(&socket_path(home.path()));
    client.send(&hello_line());
    let hello: ServerMsg = decode(&client.read_line().unwrap()).unwrap();
    assert!(matches!(hello, ServerMsg::Hello { .. }), "{hello:?}");

    client.send(&encode(&ClientMsg::Subscribe));
    let snap: ServerMsg = decode(&client.read_line().unwrap()).unwrap();
    assert!(matches!(snap, ServerMsg::Snapshot { .. }), "{snap:?}");

    // Broadcasts after subscribe reach this client.
    let health = ServerMsg::Health {
        health: Health::default(),
    };
    hub.broadcast(&health);
    let got: ServerMsg = decode(&client.read_line().unwrap()).unwrap();
    assert_eq!(got, health);
}

#[test]
fn second_serve_on_the_same_home_is_taken() {
    let _serial = serialize();
    let home = home();
    let hub = Arc::new(Hub::new());
    let (control_tx, _control_rx) = mpsc::channel();
    let _first = serve(
        home.path(),
        Arc::clone(&hub),
        Arc::new(snapshot_msg),
        control_tx.clone(),
    )
    .unwrap();
    let second = serve(
        home.path(),
        Arc::clone(&hub),
        Arc::new(snapshot_msg),
        control_tx,
    );
    assert!(matches!(second, Err(BindError::Taken)), "got {second:?}");
}

#[test]
fn stale_socket_file_is_replaced() {
    let _serial = serialize();
    let home = home();
    let sock = socket_path(home.path());
    std::fs::create_dir_all(sock.parent().unwrap()).unwrap();
    std::fs::write(&sock, b"").unwrap();

    let hub = Arc::new(Hub::new());
    let (control_tx, _control_rx) = mpsc::channel();
    let _handle = serve(
        home.path(),
        Arc::clone(&hub),
        Arc::new(snapshot_msg),
        control_tx,
    )
    .unwrap();

    let mut client = connect(&sock);
    client.send(&hello_line());
    let hello: ServerMsg = decode(&client.read_line().unwrap()).unwrap();
    assert!(matches!(hello, ServerMsg::Hello { .. }), "{hello:?}");
}

#[test]
fn socket_and_desk_dir_are_owner_only() {
    let _serial = serialize();
    let home = home();
    let hub = Arc::new(Hub::new());
    let (control_tx, _control_rx) = mpsc::channel();
    let _handle = serve(
        home.path(),
        Arc::clone(&hub),
        Arc::new(snapshot_msg),
        control_tx,
    )
    .unwrap();

    let sock = std::fs::metadata(socket_path(home.path())).unwrap();
    assert_eq!(sock.permissions().mode() & 0o777, 0o600);
    let desk = std::fs::metadata(desk_dir(home.path())).unwrap();
    assert_eq!(desk.permissions().mode() & 0o777, 0o700);
}
