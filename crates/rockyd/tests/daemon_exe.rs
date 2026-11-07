//! `rockyd.exe` end-to-end: spawn the real binary with a temp ROCKY_HOME,
//! talk to it over the named pipe, kill it at test end.

#![cfg(windows)]

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::OnceLock;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use interprocess::os::windows::named_pipe::pipe_mode::Bytes;
use interprocess::os::windows::named_pipe::{PipeStream, RecvPipeStream, SendPipeStream};
use rocky_proto::paths::{log_path, pipe_name, spool_dir};
use rocky_proto::pipe::{ClientMsg, CmdName, ServerMsg, Status, StatusOp, decode, encode};
use tempfile::TempDir;

const GUARD: Duration = Duration::from_secs(20);

fn home() -> TempDir {
    TempDir::new().unwrap()
}

/// Build `rocky-hook` once per test process; return its exe path next to rockyd's.
fn hook_exe() -> &'static Path {
    static EXE: OnceLock<PathBuf> = OnceLock::new();
    EXE.get_or_init(|| {
        let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
        let status = Command::new(cargo)
            .args(["build", "-p", "rocky-hook", "--quiet"])
            .status()
            .unwrap();
        assert!(status.success(), "rocky-hook build failed");
        let mut exe = PathBuf::from(env!("CARGO_BIN_EXE_rockyd"));
        exe.set_file_name("rocky-hook.exe");
        assert!(exe.is_file(), "hook exe missing: {}", exe.display());
        exe
    })
}

/// Spawn the daemon; the guard kills it on drop so failing tests leak nothing.
struct Daemon {
    child: Child,
    _home: TempDir,
}

impl Daemon {
    fn spawn(home: TempDir) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_rockyd"))
            .env("ROCKY_HOME", home.path())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        // Fail fast if the daemon exits immediately: wait for the pipe but
        // also surface an early exit instead of hanging until the guard.
        let pipe = pipe_name(home.path());
        let start = Instant::now();
        loop {
            if PipeStream::<Bytes, Bytes>::connect_by_path(pipe.as_str()).is_ok() {
                break;
            }
            if let Ok(Some(status)) = child.try_wait() {
                panic!("rockyd exited early: {status}");
            }
            assert!(start.elapsed() < GUARD, "pipe never appeared");
            thread::sleep(Duration::from_millis(25));
        }
        Daemon { child, _home: home }
    }

    fn home(&self) -> &Path {
        self._home.path()
    }

    fn try_wait(&mut self) -> std::io::Result<Option<std::process::ExitStatus>> {
        self.child.try_wait()
    }

    fn wait(&mut self) -> std::io::Result<std::process::ExitStatus> {
        self.child.wait()
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

struct Client {
    send: SendPipeStream<Bytes>,
    chunks: mpsc::Receiver<Option<Vec<u8>>>,
    buf: Vec<u8>,
    eof: bool,
}

fn read_loop(mut recv: RecvPipeStream<Bytes>, tx: mpsc::Sender<Option<Vec<u8>>>) {
    loop {
        let mut chunk = [0u8; 4096];
        match recv.read(&mut chunk) {
            Ok(0) => {
                let _ = tx.send(None);
                break;
            }
            Ok(n) => {
                if tx.send(Some(chunk[..n].to_vec())).is_err() {
                    break;
                }
            }
            Err(_) => {
                let _ = tx.send(None);
                break;
            }
        }
    }
}

fn connect(pipe: &str) -> Client {
    let start = Instant::now();
    loop {
        match PipeStream::connect_by_path(pipe) {
            Ok(stream) => {
                let (recv, send) = stream.split();
                let (tx, rx) = mpsc::channel();
                thread::spawn(move || read_loop(recv, tx));
                return Client {
                    send,
                    chunks: rx,
                    buf: Vec::new(),
                    eof: false,
                };
            }
            Err(e) => {
                assert!(start.elapsed() < GUARD, "connect timed out: {e}");
                thread::sleep(Duration::from_millis(10));
            }
        }
    }
}

impl Client {
    fn send(&mut self, line: &str) {
        self.send.write_all(line.as_bytes()).unwrap();
        self.send.flush().unwrap();
    }

    fn read_line(&mut self) -> Option<String> {
        let deadline = Instant::now() + GUARD;
        loop {
            if let Some(i) = self.buf.iter().position(|&b| b == b'\n') {
                let line: Vec<u8> = self.buf.drain(..=i).collect();
                return Some(String::from_utf8(line).unwrap());
            }
            if self.eof {
                return if self.buf.is_empty() {
                    None
                } else {
                    Some(String::from_utf8(std::mem::take(&mut self.buf)).unwrap())
                };
            }
            let left = deadline.saturating_duration_since(Instant::now());
            assert!(!left.is_zero(), "read timed out");
            match self.chunks.recv_timeout(left) {
                Ok(Some(c)) => self.buf.extend_from_slice(&c),
                Ok(None) => self.eof = true,
                Err(_) => panic!("read timed out"),
            }
        }
    }

    fn hello_subscribe(&mut self) -> ServerMsg {
        self.send(&encode(&ClientMsg::Hello {
            client: "desk".into(),
            version: "0.1.0".into(),
        }));
        let hello: ServerMsg = decode(&self.read_line().unwrap()).unwrap();
        assert!(matches!(hello, ServerMsg::Hello { .. }), "{hello:?}");
        self.send(&encode(&ClientMsg::Subscribe));
        decode(&self.read_line().unwrap()).unwrap()
    }
}

const SEED_FIXTURE: &str = "session.jsonl";
const SEED_SESSION: &str = "S1";

/// Copy every line of a hook fixture into its own spool file, oldest first.
fn seed_spool(spool: &Path, fixture: &str) -> usize {
    let path = format!(
        "{}/../../fixtures/hooks/claude-code-2.1.319/{fixture}",
        env!("CARGO_MANIFEST_DIR")
    );
    let text = fs::read_to_string(&path).unwrap();
    fs::create_dir_all(spool).unwrap();
    let mut n = 0;
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        let file = spool.join(format!("{n:013}-1-{n}.json"));
        fs::write(&file, line).unwrap();
        n += 1;
    }
    n
}

fn run_hook(home: &Path, payload: &str) {
    let mut child = Command::new(hook_exe())
        .args(["desk-hook", "claude-code"])
        .env("ROCKY_HOME", home)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(payload.as_bytes())
        .unwrap();
    let status = child.wait().unwrap();
    assert!(status.success(), "hook failed: {status}");
}

fn spool_files(home: &Path) -> Vec<String> {
    let mut out: Vec<String> = fs::read_dir(spool_dir(home))
        .unwrap()
        .flatten()
        .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("json"))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    out.sort();
    out
}

#[test]
fn drains_existing_spool_on_start() {
    let home = home();
    let n = seed_spool(&spool_dir(home.path()), SEED_FIXTURE);
    assert!(n > 0);
    let daemon = Daemon::spawn(home);
    let mut client = connect(&pipe_name(daemon.home()));
    let snapshot = client.hello_subscribe();
    let ServerMsg::Snapshot { agents, .. } = snapshot else {
        panic!("expected snapshot, got {snapshot:?}");
    };
    assert!(
        agents
            .iter()
            .any(|a| a.key.session_id == SEED_SESSION && a.key.agent_id.is_empty()),
        "snapshot missing seed agent: {agents:?}"
    );
    assert!(spool_files(daemon.home()).is_empty());
}

#[test]
fn live_spool_file_reaches_subscriber() {
    let home = home();
    let daemon = Daemon::spawn(home);
    let mut client = connect(&pipe_name(daemon.home()));
    let snapshot = client.hello_subscribe();
    assert!(
        matches!(snapshot, ServerMsg::Snapshot { .. }),
        "{snapshot:?}"
    );

    run_hook(
        daemon.home(),
        r#"{"hook_event_name":"SessionStart","session_id":"live1","cwd":"C:\\r"}"#,
    );

    let start = Instant::now();
    let seen = loop {
        let msg: ServerMsg = decode(&client.read_line().unwrap()).unwrap();
        match msg {
            ServerMsg::Status {
                op: StatusOp::Upsert,
                agent,
            } if agent.key.session_id == "live1" => break agent,
            _ => assert!(start.elapsed() < GUARD, "upsert never arrived"),
        }
    };
    assert_eq!(seen.status, Status::Idle);
}

#[test]
fn second_daemon_exits_nonzero() {
    let home = home();
    let first = Daemon::spawn(home);
    let mut second = Command::new(env!("CARGO_BIN_EXE_rockyd"))
        .env("ROCKY_HOME", first.home())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let status = wait_exit(&mut second, "second daemon");
    assert_eq!(status.code(), Some(3), "status: {status}");
    let log = fs::read_to_string(log_path(first.home())).unwrap();
    assert!(
        log.lines()
            .any(|l| l == "pipe taken (another rockyd, or squatted)"),
        "log missing pipe-taken line: {log:?}"
    );
}

#[test]
fn second_daemon_touches_no_spool() {
    // Bind-first (R17): a duplicate daemon must exit 3 without ingesting or
    // deleting spool files. Write the file only AFTER A is serving and B has
    // had no chance to run before it exists... instead assert from A's side:
    // create the spool file, start B, wait for B's exit 3, then require that
    // A (not B) delivers the agent. If B had ingested the file into its own
    // memory, A would never see the agent and no snapshot text would match.
    let home = home();
    let first = Daemon::spawn(home);
    let mut client = connect(&pipe_name(first.home()));
    let snapshot = client.hello_subscribe();
    assert!(
        matches!(snapshot, ServerMsg::Snapshot { .. }),
        "{snapshot:?}"
    );

    run_hook(
        first.home(),
        r#"{"hook_event_name":"SessionStart","session_id":"kept1","cwd":"C:\\r"}"#,
    );

    let mut second = Command::new(env!("CARGO_BIN_EXE_rockyd"))
        .env("ROCKY_HOME", first.home())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let status = wait_exit(&mut second, "second daemon");
    assert_eq!(status.code(), Some(3), "status: {status}");

    // A applies the file: its status upsert must arrive here. Guarded reads
    // only, no timing asserts.
    let start = Instant::now();
    let seen = loop {
        let msg: ServerMsg = decode(&client.read_line().unwrap()).unwrap();
        match msg {
            ServerMsg::Status {
                op: StatusOp::Upsert,
                agent,
            } if agent.key.session_id == "kept1" => break agent,
            _ => assert!(start.elapsed() < GUARD, "upsert never arrived"),
        }
    };
    assert_eq!(seen.status, Status::Idle);
}

/// Wait for a child with the anti-hang guard; kill it rather than hang forever.
fn wait_exit(child: &mut Child, what: &str) -> std::process::ExitStatus {
    let start = Instant::now();
    loop {
        if let Some(s) = child.try_wait().unwrap() {
            return s;
        }
        if start.elapsed() >= GUARD {
            let _ = child.kill();
            panic!("{what} never exited");
        }
        thread::sleep(Duration::from_millis(25));
    }
}

#[test]
fn stop_cmd_exits_zero_and_hook_keeps_spooling() {
    let home = home();
    let mut daemon = Daemon::spawn(home);
    let mut client = connect(&pipe_name(daemon.home()));
    let snapshot = client.hello_subscribe();
    assert!(
        matches!(snapshot, ServerMsg::Snapshot { .. }),
        "{snapshot:?}"
    );

    client.send(&encode(&ClientMsg::Cmd {
        name: CmdName::Stop,
        id: 9,
    }));
    let ack: ServerMsg = decode(&client.read_line().unwrap()).unwrap();
    assert_eq!(
        ack,
        ServerMsg::Ack {
            id: 9,
            ok: true,
            error: None
        }
    );

    let start = Instant::now();
    let status = loop {
        if let Some(s) = daemon.try_wait().unwrap() {
            break s;
        }
        assert!(start.elapsed() < GUARD, "daemon never exited");
        thread::sleep(Duration::from_millis(25));
    };
    assert_eq!(status.code(), Some(0), "status: {status}");

    run_hook(
        daemon.home(),
        r#"{"hook_event_name":"SessionStart","session_id":"after","cwd":"C:\\r"}"#,
    );
    assert_eq!(spool_files(daemon.home()).len(), 1);
    let _ = daemon.wait();
}
