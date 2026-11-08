use std::sync::Arc;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use rocky_proto::pipe::{Health, ServerMsg, Status};
use rocky_proto::settings::Settings;
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

/// A server that accepts the pipe and then stays silent must fail the
/// connect attempt (bounded by the hello timeout) instead of wedging it.
#[test]
fn connect_fails_on_silent_server() {
    use std::io::Read;

    use interprocess::os::windows::named_pipe::PipeListenerOptions;
    use interprocess::os::windows::named_pipe::pipe_mode::Bytes;
    use rocky_proto::paths::pipe_name;

    let home = TempDir::new().unwrap();
    let name = pipe_name(home.path());
    // Raw listener: every accepted client gets its hello line drained, then
    // silence (no reply). Detached thread: no join, so nothing can hang.
    let listen_name = name.clone();
    let (ready_tx, ready_rx) = mpsc::channel::<()>();
    std::thread::spawn(move || {
        let Ok(listener) = PipeListenerOptions::new()
            .path(listen_name.as_str())
            .create_duplex::<Bytes>()
        else {
            return;
        };
        let _ = ready_tx.send(());
        loop {
            let Ok(mut stream) = listener.accept() else {
                continue;
            };
            std::thread::spawn(move || {
                let mut one = [0u8; 1];
                loop {
                    match stream.read(&mut one) {
                        Ok(_) if one[0] == b'\n' => break,
                        Ok(0) => return,
                        Ok(_) => {}
                        Err(_) => return,
                    }
                }
                std::thread::sleep(Duration::from_secs(120));
            });
        }
    });
    // The listener exists once the ready signal arrives — no probe client
    // that could steal the single accept.
    ready_rx.recv_timeout(GUARD).expect("listener ready");

    let (tx, _rx) = mpsc::channel();
    let err = connect_and_subscribe(home.path(), tx).expect_err("silent server must fail");
    // TimedOut proves the bounded wait fired (a wedge would hang the test
    // until the harness kills it; no timing assert on the duration itself).
    let msg = err.to_string();
    assert!(
        msg.contains("timed out"),
        "expected hello timeout, got: {msg}"
    );
}
