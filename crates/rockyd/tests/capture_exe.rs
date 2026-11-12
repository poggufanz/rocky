//! `rockyd` capture end to end. The daemon supervises one capture child (the fake Node CLI),
//! wakes it on file changes in a consented repo, and publishes capture health. Each daemon runs
//! with the temp directory as its Rocky home, a temp user home, and no `CLAUDE_CONFIG_DIR`. The
//! tests need `node` on PATH.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use rocky_proto::paths::{listening_dir, repo_consents_path};
use rocky_proto::pipe::{CaptureHealth, CaptureState, ClientMsg, CmdName, Health, ServerMsg};
use rockyd::capture::RESTARTS;
use serde_json::{Value, json};
use tempfile::TempDir;

/// Longest any wait may take. A test that goes past it fails instead of hanging.
const GUARD: Duration = Duration::from_secs(30);

/// Kills its child and waits on drop, so a failing assert never leaves a daemon behind.
struct KillOnDrop(Child);

impl Drop for KillOnDrop {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// The Rocky home (a temp dir), a user home inside it, and the repo capture watches. Each test
/// declares it before the daemon, so the daemon is killed first.
struct Layout {
    _dir: TempDir,
    home: PathBuf,
    user: PathBuf,
    repo: PathBuf,
}

fn layout() -> Layout {
    let dir = TempDir::new().expect("temp dir");
    let home = dir.path().to_path_buf();
    let user = home.join("user");
    let repo = home.join("work").join("repo");
    fs::create_dir_all(&user).expect("create user home");
    fs::create_dir_all(&repo).expect("create repo");
    Layout {
        _dir: dir,
        home,
        user,
        repo,
    }
}

/// The first `node` on PATH. Panics when Node is not installed.
fn node_on_path() -> PathBuf {
    let names: &[&str] = if cfg!(windows) {
        &["node.exe", "node"]
    } else {
        &["node"]
    };
    let path = std::env::var_os("PATH").unwrap_or_default();
    std::env::split_paths(&path)
        .flat_map(|dir| names.iter().map(move |name| dir.join(name)))
        .find(|candidate| candidate.is_file())
        .unwrap_or_else(|| {
            panic!("node is not on PATH; these tests run the fake CLI with Node.js and need it installed")
        })
}

fn fake_entry() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("fake-cli.cjs")
}

fn path_str(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// The repo as Node names a root: forward slashes on every platform. The daemon watches that
/// spelling, so Windows events carry mixed separators.
fn root_text(layout: &Layout) -> String {
    path_str(&layout.repo).replace('\\', "/")
}

fn write_json(path: &Path, value: &Value) {
    fs::create_dir_all(path.parent().expect("record path has a parent"))
        .expect("create record dir");
    fs::write(path, value.to_string()).expect("write record");
}

/// Seeds the CLI record and the fake capture command's behavior. The listening directory exists
/// before the daemon starts, as it does once Listening has been used, so its watch can be set.
fn seed(layout: &Layout, mode: &str) {
    write_json(
        &layout.home.join("bin").join("cli.json"),
        &json!({
            "v": 1,
            "node": path_str(&node_on_path()),
            "entry": path_str(&fake_entry()),
            "version": "9.0.0"
        }),
    );
    write_json(
        &layout.home.join("fake-capture.json"),
        &json!({ "mode": mode, "roots": [root_text(layout)] }),
    );
    fs::create_dir_all(listening_dir(&layout.home)).expect("create listening dir");
}

/// Grants capture for the repo, the way Node's consent store records it.
fn consent_repo(layout: &Layout) {
    write_json(
        &repo_consents_path(&layout.home),
        &json!({ root_text(layout): true }),
    );
}

/// Starts the daemon for `layout`. The user home is the temp one and no Claude config dir is
/// inherited, so nothing outside the temp dir is read or written.
fn spawn_daemon(layout: &Layout) -> KillOnDrop {
    KillOnDrop(
        Command::new(env!("CARGO_BIN_EXE_rockyd"))
            .env("ROCKY_HOME", &layout.home)
            .env("HOME", &layout.user)
            .env("USERPROFILE", &layout.user)
            .env_remove("CLAUDE_CONFIG_DIR")
            .env_remove("XDG_RUNTIME_DIR")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn rockyd"),
    )
}

/// Polls `condition` until it holds. Panics with `what` at the anti-hang guard.
fn wait_until(what: &str, mut condition: impl FnMut() -> bool) {
    let start = Instant::now();
    while !condition() {
        assert!(start.elapsed() < GUARD, "{what} never happened");
        std::thread::sleep(Duration::from_millis(25));
    }
}

/// The argv of each run the fake CLI logged so far. Index 0 is the entry script. No log yet reads
/// as no runs.
fn logged_runs(home: &Path) -> Vec<Vec<String>> {
    let Ok(text) = fs::read_to_string(home.join("fake-cli.log")) else {
        return Vec::new();
    };
    text.lines()
        .map(|line| {
            let entry: Value = serde_json::from_str(line).expect("log line is JSON");
            entry["argv"]
                .as_array()
                .expect("argv is an array")
                .iter()
                .map(|arg| arg.as_str().expect("argv entries are strings").to_string())
                .collect()
        })
        .collect()
}

/// How many times the daemon has started the capture command.
fn listen_runs(home: &Path) -> usize {
    logged_runs(home)
        .iter()
        .filter(|argv| {
            argv.iter()
                .skip(1)
                .map(String::as_str)
                .eq(["listen", "collect", "--stdio"])
        })
        .count()
}

/// The lines the fake capture command read from its stdin, plus its `eof` marker. No log yet
/// reads as no lines.
fn capture_log(home: &Path) -> Vec<String> {
    fs::read_to_string(home.join("fake-capture.log"))
        .map(|text| text.lines().map(str::to_string).collect())
        .unwrap_or_default()
}

/// Connects and completes the hello handshake, then subscribes. The next message read is the
/// snapshot.
fn subscribe(home: &Path) -> transport::Client {
    let mut client = transport::connect(home);
    client.send(&ClientMsg::Hello {
        client: "desk".into(),
        version: "0.1.0".into(),
    });
    let hello = client.recv();
    assert!(matches!(hello, ServerMsg::Hello { .. }), "{hello:?}");
    client.send(&ClientMsg::Subscribe);
    client
}

/// Reads messages until one satisfies `want`, failing at the anti-hang guard.
fn read_until(
    client: &mut transport::Client,
    what: &str,
    want: impl Fn(&ServerMsg) -> bool,
) -> ServerMsg {
    let start = Instant::now();
    loop {
        let msg = client.recv();
        if want(&msg) {
            return msg;
        }
        assert!(start.elapsed() < GUARD, "{what} never arrived");
    }
}

/// The health a snapshot or a health message carries, if the message is one.
fn health_of(msg: &ServerMsg) -> Option<&Health> {
    match msg {
        ServerMsg::Snapshot { health, .. } | ServerMsg::Health { health } => Some(health),
        _ => None,
    }
}

/// The capture row for `root`, if the health has one.
fn row_for<'a>(health: &'a Health, root: &str) -> Option<&'a CaptureHealth> {
    health.capture.iter().find(|row| row.root == root)
}

/// Asks the daemon to quit, then waits for the process to exit.
fn quit(daemon: &mut KillOnDrop, client: &mut transport::Client) {
    client.send(&ClientMsg::Cmd {
        name: CmdName::Quit,
        id: 9,
    });
    read_until(client, "the quit ack", |msg| {
        matches!(msg, ServerMsg::Ack { id: 9, .. })
    });
    let start = Instant::now();
    loop {
        if daemon.0.try_wait().expect("poll the daemon").is_some() {
            return;
        }
        assert!(start.elapsed() < GUARD, "the daemon never exited");
        std::thread::sleep(Duration::from_millis(25));
    }
}

#[test]
fn consented_repo_gets_a_capture_child_and_change_requests() {
    let layout = layout();
    seed(&layout, "echo");
    let mut daemon = spawn_daemon(&layout);
    let mut client = subscribe(&layout.home);

    consent_repo(&layout);
    wait_until("the capture child to start", || {
        listen_runs(&layout.home) == 1
    });

    // The repo watch is set only after the child lists its roots, and a change before that is
    // not seen. Keep changing a file until the daemon asks the child to reconcile the repo.
    let mut edits = 0u32;
    wait_until("a reconcile request for the repo", || {
        edits += 1;
        fs::write(layout.repo.join("a.txt"), edits.to_string()).expect("edit a repo file");
        !capture_log(&layout.home).is_empty()
    });
    let first = &capture_log(&layout.home)[0];
    let request: Value = serde_json::from_str(first).expect("the request is JSON");
    assert_eq!(request["v"], 1);
    assert_eq!(request["root"], root_text(&layout));

    read_until(&mut client, "an ok capture row for the repo", |msg| {
        health_of(msg)
            .and_then(|health| row_for(health, &root_text(&layout)))
            .is_some_and(|row| row.state == CaptureState::Ok)
    });
    assert_eq!(listen_runs(&layout.home), 1, "one child serves the repo");

    quit(&mut daemon, &mut client);
    assert_eq!(
        capture_log(&layout.home).last().map(String::as_str),
        Some("eof")
    );
}

#[test]
fn crashing_capture_child_is_restarted_three_times() {
    let layout = layout();
    seed(&layout, "exit");
    let _daemon = spawn_daemon(&layout);
    let mut client = subscribe(&layout.home);

    consent_repo(&layout);
    let msg = read_until(
        &mut client,
        "a failed row naming the restart limit",
        |msg| {
            health_of(msg)
                .and_then(|health| row_for(health, &root_text(&layout)))
                .is_some_and(|row| row.error.as_deref() == Some(RESTARTS))
        },
    );

    let health = health_of(&msg).expect("a health message");
    let row = row_for(health, &root_text(&layout)).expect("a row for the repo");
    assert_eq!(row.state, CaptureState::Failed);
    assert_eq!(listen_runs(&layout.home), 3);
}

#[test]
fn quit_stops_the_capture_child() {
    let layout = layout();
    seed(&layout, "echo");
    let mut daemon = spawn_daemon(&layout);
    let mut client = subscribe(&layout.home);

    consent_repo(&layout);
    wait_until("the capture child to start", || {
        listen_runs(&layout.home) == 1
    });

    quit(&mut daemon, &mut client);

    // The daemon exits only after the child has, and the child logs `eof` when its stdin closes.
    assert_eq!(
        capture_log(&layout.home).last().map(String::as_str),
        Some("eof")
    );
}

#[cfg(windows)]
mod transport {
    use std::io::{Read, Write};
    use std::path::Path;
    use std::sync::mpsc;
    use std::thread;
    use std::time::{Duration, Instant};

    use interprocess::os::windows::named_pipe::pipe_mode::Bytes;
    use interprocess::os::windows::named_pipe::{PipeStream, RecvPipeStream, SendPipeStream};
    use rocky_proto::paths::pipe_name;
    use rocky_proto::pipe::{ClientMsg, ServerMsg, decode, encode};

    use super::GUARD;

    /// One connection to the daemon's named pipe.
    pub struct Client {
        writer: SendPipeStream<Bytes>,
        chunks: mpsc::Receiver<Option<Vec<u8>>>,
        buf: Vec<u8>,
    }

    /// Connects once the pipe exists, failing at the anti-hang guard.
    pub fn connect(home: &Path) -> Client {
        let pipe = pipe_name(home);
        let start = Instant::now();
        loop {
            match PipeStream::connect_by_path(pipe.as_str()) {
                Ok(stream) => {
                    let (recv, writer) = stream.split();
                    let (tx, chunks) = mpsc::channel();
                    thread::spawn(move || read_loop(recv, tx));
                    return Client {
                        writer,
                        chunks,
                        buf: Vec::new(),
                    };
                }
                Err(error) => {
                    assert!(start.elapsed() < GUARD, "connect timed out: {error}");
                    thread::sleep(Duration::from_millis(10));
                }
            }
        }
    }

    /// Forwards every chunk the pipe delivers. `None` marks the end.
    fn read_loop(mut recv: RecvPipeStream<Bytes>, tx: mpsc::Sender<Option<Vec<u8>>>) {
        loop {
            let mut chunk = [0u8; 4096];
            match recv.read(&mut chunk) {
                Ok(0) | Err(_) => {
                    let _ = tx.send(None);
                    break;
                }
                Ok(n) => {
                    if tx.send(Some(chunk[..n].to_vec())).is_err() {
                        break;
                    }
                }
            }
        }
    }

    impl Client {
        /// Writes one client message as a line.
        pub fn send(&mut self, msg: &ClientMsg) {
            self.writer
                .write_all(encode(msg).as_bytes())
                .expect("write to the daemon");
            self.writer.flush().expect("flush to the daemon");
        }

        /// Reads the next server message, failing at the anti-hang guard.
        pub fn recv(&mut self) -> ServerMsg {
            let deadline = Instant::now() + GUARD;
            loop {
                if let Some(i) = self.buf.iter().position(|&b| b == b'\n') {
                    let line: Vec<u8> = self.buf.drain(..=i).collect();
                    let text = String::from_utf8(line).expect("daemon sent UTF-8");
                    return decode(&text).expect("daemon sent a valid message");
                }
                let left = deadline.saturating_duration_since(Instant::now());
                assert!(!left.is_zero(), "read timed out");
                match self.chunks.recv_timeout(left) {
                    Ok(Some(chunk)) => self.buf.extend_from_slice(&chunk),
                    Ok(None) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                        panic!("the daemon closed the pipe")
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => panic!("read timed out"),
                }
            }
        }
    }
}

#[cfg(unix)]
mod transport {
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixStream;
    use std::path::Path;
    use std::thread;
    use std::time::{Duration, Instant};

    use rocky_proto::paths::socket_path_from;
    use rocky_proto::pipe::{ClientMsg, ServerMsg, decode, encode};

    use super::GUARD;

    /// One connection to the daemon's unix socket.
    pub struct Client {
        writer: UnixStream,
        reader: BufReader<UnixStream>,
    }

    /// Connects once the socket exists, failing at the anti-hang guard. The daemon runs without
    /// `XDG_RUNTIME_DIR`, so its socket sits under the Rocky home.
    pub fn connect(home: &Path) -> Client {
        let path = socket_path_from(home, None);
        let start = Instant::now();
        let stream = loop {
            match UnixStream::connect(&path) {
                Ok(stream) => break stream,
                Err(error) => {
                    assert!(start.elapsed() < GUARD, "connect timed out: {error}");
                    thread::sleep(Duration::from_millis(10));
                }
            }
        };
        // A read blocks at most GUARD. A timed-out read fails the test rather than resuming,
        // because a partial line is not kept.
        stream
            .set_read_timeout(Some(GUARD))
            .expect("set read timeout");
        let reader = BufReader::new(stream.try_clone().expect("clone socket"));
        Client {
            writer: stream,
            reader,
        }
    }

    impl Client {
        /// Writes one client message as a line.
        pub fn send(&mut self, msg: &ClientMsg) {
            self.writer
                .write_all(encode(msg).as_bytes())
                .expect("write to the daemon");
            self.writer.flush().expect("flush to the daemon");
        }

        /// Reads the next server message. A timeout or a closed socket fails the test.
        pub fn recv(&mut self) -> ServerMsg {
            let mut line = String::new();
            let read = self
                .reader
                .read_line(&mut line)
                .expect("read from the daemon");
            assert!(read > 0, "the daemon closed the socket");
            decode(&line).expect("daemon sent a valid message")
        }
    }
}
