use std::sync::Arc;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use rocky_proto::pipe::{Health, ServerMsg, Status};
use rockyd::server::{Hub, serve};
use tempfile::TempDir;

use rocky_desk::client::{connect_and_subscribe, verify_server};
use rocky_desk::spawn::spawn_daemon;

const GUARD: Duration = Duration::from_secs(10);

fn empty_snapshot() -> ServerMsg {
    ServerMsg::Snapshot {
        agents: Vec::new(),
        aggregate: Status::Idle,
        health: Health::default(),
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
fn verify_server_accepts_own_daemon() {
    let (home, _server) = start_server();
    let (tx, _rx0) = mpsc::channel();
    let start = Instant::now();
    let _cmd = loop {
        match connect_and_subscribe(home.path(), tx.clone()) {
            Ok(cmd) => break cmd,
            Err(_) => {
                assert!(start.elapsed() < GUARD, "connect timed out");
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    };
    // Verification and the hello handshake passed inside connect; the
    // snapshot arrives on the inbox (the daemon hello was consumed by the
    // handshake).
    let first = _rx0.recv_timeout(GUARD).expect("snapshot arrives");
    assert!(
        matches!(first, Some(ServerMsg::Snapshot { .. })),
        "got {first:?}"
    );
}

#[test]
fn spawn_daemon_runs_exe_that_exits_zero() {
    // Test binary lives in target/debug/deps/; examples in target/debug/examples/.
    let exe = std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("examples")
        .join("exit0.exe");
    let info = spawn_daemon(&exe).unwrap();
    let _ = info.tied_to_job;
}

// Direct verify_server check: a raw client handle against the in-process
// server must verify Ok.
#[test]
fn verify_server_raw_handle_ok() {
    use std::os::windows::io::AsRawHandle;

    use interprocess::os::windows::named_pipe::PipeStream;
    use interprocess::os::windows::named_pipe::pipe_mode::Bytes;
    use rocky_proto::paths::pipe_name;

    let (home, _server) = start_server();
    let name = pipe_name(home.path());
    let start = Instant::now();
    let stream = loop {
        match PipeStream::<Bytes, Bytes>::connect_by_path(name.as_str()) {
            Ok(s) => break s,
            Err(e) => {
                assert!(start.elapsed() < GUARD, "connect timed out: {e}");
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    };
    assert!(verify_server(stream.as_raw_handle()).is_ok());
}
