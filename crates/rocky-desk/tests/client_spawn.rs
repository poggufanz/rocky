use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

#[cfg(windows)]
use interprocess::os::windows::named_pipe::pipe_mode::Bytes;
#[cfg(windows)]
use interprocess::os::windows::named_pipe::{PipeListenerOptions, PipeStream};
#[cfg(windows)]
use rocky_proto::paths::pipe_name;
use rocky_proto::pipe::{Health, ServerMsg, Status};
use rocky_proto::settings::Settings;
use rockyd::server::{Hub, serve};
use tempfile::TempDir;

#[cfg(windows)]
use rocky_desk::client::verify_server;
use rocky_desk::client::{ConnectError, connect_and_subscribe};
use rocky_desk::conn::ConnectOutcome;
use rocky_desk::connect::{CONNECT_BUDGET, connect_attempt};
#[cfg(windows)]
use rocky_desk::spawn::spawn_daemon;

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

/// `serve` sets the process umask for the bind, and Rust runs the tests in one
/// binary on parallel threads: a `TempDir` created inside that window would
/// lose its owner execute bit. Serialize the tests so nothing creates files
/// while another test binds.
#[cfg(unix)]
static SERVE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(unix)]
fn serialize() -> std::sync::MutexGuard<'static, ()> {
    SERVE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn temp_home() -> TempDir {
    #[cfg(unix)]
    let _serial = serialize();
    TempDir::new().unwrap()
}

fn start_server() -> (TempDir, std::thread::JoinHandle<()>) {
    #[cfg(unix)]
    let _serial = serialize();
    let home = TempDir::new().unwrap();
    let hub = Arc::new(Hub::new());
    let (control_tx, _control_rx) = mpsc::channel();
    let handle = serve(home.path(), hub, Arc::new(empty_snapshot), control_tx).unwrap();
    (home, handle)
}

/// A same-user pipe server that accepts every connection and never writes.
/// Held streams stay open, so a client read blocks instead of seeing EOF.
#[cfg(windows)]
struct SilentServer {
    name: String,
    stop: Arc<AtomicBool>,
    handle: Option<std::thread::JoinHandle<()>>,
}

#[cfg(windows)]
impl SilentServer {
    fn start(name: String) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        let listen_name = name.clone();
        let (ready_tx, ready_rx) = mpsc::channel::<()>();
        let handle = std::thread::spawn(move || {
            let Ok(listener) = PipeListenerOptions::new()
                .path(listen_name.as_str())
                .create_duplex::<Bytes>()
            else {
                return;
            };
            let _ = ready_tx.send(());
            let mut held = Vec::new();
            while !thread_stop.load(Ordering::SeqCst) {
                let Ok(stream) = listener.accept() else {
                    break;
                };
                held.push(stream);
            }
        });
        // The listener exists once the ready signal arrives — no probe client
        // that could steal the single accept.
        ready_rx.recv_timeout(GUARD).expect("listener ready");
        Self {
            name,
            stop,
            handle: Some(handle),
        }
    }
}

#[cfg(windows)]
impl Drop for SilentServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        // One connect releases a pending accept so the loop can see the stop
        // and exit; the listener is gone already if the loop left first.
        if let Ok(stream) = PipeStream::<Bytes, Bytes>::connect_by_path(self.name.as_str()) {
            drop(stream);
        }
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

/// A same-user socket server that accepts every connection and never writes.
/// Held streams stay open, so a client read blocks instead of seeing EOF.
#[cfg(unix)]
struct SilentServer {
    stop: Arc<AtomicBool>,
    handle: Option<std::thread::JoinHandle<()>>,
}

#[cfg(unix)]
impl SilentServer {
    fn start(path: std::path::PathBuf) -> Self {
        use std::os::unix::net::UnixListener;

        let listener = UnixListener::bind(&path).expect("silent listener binds");
        listener.set_nonblocking(true).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        let handle = std::thread::spawn(move || {
            let mut held = Vec::new();
            while !thread_stop.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((stream, _)) => held.push(stream),
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    Err(_) => break,
                }
            }
        });
        Self {
            stop,
            handle: Some(handle),
        }
    }
}

#[cfg(unix)]
impl Drop for SilentServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

fn start_silent_server() -> (TempDir, SilentServer) {
    let home = temp_home();
    #[cfg(windows)]
    let server = SilentServer::start(pipe_name(home.path()));
    #[cfg(unix)]
    let server = {
        let sock = rocky_proto::paths::socket_path(home.path());
        std::fs::create_dir_all(sock.parent().unwrap()).unwrap();
        SilentServer::start(sock)
    };
    (home, server)
}

#[test]
fn silent_server_is_unresponsive_within_six_seconds() {
    let (home, _server) = start_silent_server();
    // A spawn would turn into SpawnFailed, so this path must not spawn.
    let missing = home.path().join("missing.exe");
    let t = Instant::now();
    let done = connect_attempt(home.path(), Some(&missing), CONNECT_BUDGET);
    assert_eq!(done.outcome, ConnectOutcome::Unresponsive);
    assert!(
        t.elapsed() <= Duration::from_secs(6),
        "took {:?}",
        t.elapsed()
    );
}

#[test]
fn absent_daemon_gives_up_within_six_seconds() {
    let home = temp_home();
    let t = Instant::now();
    let done = connect_attempt(home.path(), None, CONNECT_BUDGET);
    assert_eq!(done.outcome, ConnectOutcome::NoDaemon);
    assert!(
        t.elapsed() <= Duration::from_secs(6),
        "took {:?}",
        t.elapsed()
    );
}

#[test]
fn verify_server_accepts_own_daemon() {
    let (home, _server) = start_server();
    let (tx, _rx0) = mpsc::channel();
    let start = Instant::now();
    let _cmd = loop {
        match connect_and_subscribe(home.path(), tx.clone(), HELLO) {
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

#[cfg(windows)]
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
#[cfg(windows)]
#[test]
fn verify_server_raw_handle_ok() {
    use std::os::windows::io::AsRawHandle;

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
    let (home, _server) = start_silent_server();
    let (tx, _rx) = mpsc::channel();
    let err = connect_and_subscribe(home.path(), tx, HELLO).expect_err("silent server must fail");
    assert!(
        matches!(err, ConnectError::Unresponsive),
        "expected unresponsive, got: {err}"
    );
}
