//! `rockyd` setup guard end to end. The daemon checks the guarded files, repairs
//! them through the fake Node CLI, and answers `setup` requests. Each daemon runs
//! with the temp directory as its Rocky home, a temp user home, and no
//! `CLAUDE_CONFIG_DIR`. The tests need `node` on PATH.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use rocky_proto::paths::log_path;
use rocky_proto::pipe::{
    ClientMsg, ConsentState, GapReason, Health, ServerMsg, SetupAction, SetupTarget, TargetState,
};
use serde_json::{Value, json};
use tempfile::TempDir;

/// Longest any wait may take. A test that goes past it fails instead of hanging.
const GUARD: Duration = Duration::from_secs(30);

/// The snippet the guarded settings file must contain.
const MARK: &str = "ROCKY-MARK";

/// Kills its child and waits on drop, so a failing assert never leaves a daemon behind.
struct KillOnDrop(Child);

impl Drop for KillOnDrop {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// The Rocky home (a temp dir), a user home inside it, and the guarded settings
/// file. Each test declares it before the daemon, so the daemon is killed first.
struct Layout {
    _dir: TempDir,
    home: PathBuf,
    user: PathBuf,
    settings: PathBuf,
}

fn layout() -> Layout {
    let dir = TempDir::new().expect("temp dir");
    let home = dir.path().to_path_buf();
    let user = home.join("user");
    let settings = home.join("cfg").join("settings.json");
    fs::create_dir_all(&user).expect("create user home");
    fs::create_dir_all(home.join("cfg")).expect("create config dir");
    Layout {
        _dir: dir,
        home,
        user,
        settings,
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

fn write_json(path: &Path, value: &Value) {
    fs::create_dir_all(path.parent().expect("record path has a parent"))
        .expect("create record dir");
    fs::write(path, value.to_string()).expect("write record");
}

/// The fake CLI's behavior: an approved apply that writes the snippet and reports
/// the settings file as written.
fn fake_config(settings: &Path) -> Value {
    let path = path_str(settings);
    json!({
        "mode": "print",
        "write": { "path": path, "text": format!("{{\"m\":\"{}\"}}", MARK) },
        "result": {
            "v": 1,
            "action": "apply",
            "consent": "approved",
            "targets": [{
                "harness": "claude-code",
                "kind": "desk-hooks",
                "path": path,
                "state": "written"
            }],
            "notes": []
        }
    })
}

/// Seeds the records the guard reads and the fake CLI's config. `cli_version`
/// writes `cli.json` when it is given, and `bin_version` writes `binaries.json`.
fn seed(layout: &Layout, cli_version: Option<&str>, bin_version: Option<&str>) {
    let setup = layout.home.join("setup");
    let bin = layout.home.join("bin");
    write_json(
        &setup.join("consent.json"),
        &json!({ "v": 1, "state": "approved", "config_dirs": {} }),
    );
    write_json(
        &setup.join("expected.json"),
        &json!({
            "v": 1,
            "files": [{ "path": path_str(&layout.settings), "snippets": [MARK] }]
        }),
    );
    if let Some(version) = cli_version {
        write_json(
            &bin.join("cli.json"),
            &json!({
                "v": 1,
                "node": path_str(&node_on_path()),
                "entry": path_str(&fake_entry()),
                "version": version
            }),
        );
    }
    if let Some(version) = bin_version {
        write_json(
            &bin.join("binaries.json"),
            &json!({ "v": 1, "version": version }),
        );
    }
    write_json(
        &layout.home.join("fake-cli.json"),
        &fake_config(&layout.settings),
    );
}

/// Starts the daemon for `layout`. The user home is the temp one and no Claude
/// config dir is inherited, so nothing outside the temp dir is read or written.
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

fn file_has_mark(path: &Path) -> bool {
    fs::read_to_string(path).is_ok_and(|text| text.contains(MARK))
}

/// The argv of each run the fake CLI logged. Index 0 is the entry script.
fn logged_runs(home: &Path) -> Vec<Vec<String>> {
    let text = fs::read_to_string(home.join("fake-cli.log")).expect("read fake CLI log");
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

/// Connects and completes the hello handshake, then subscribes. The next message
/// read is the snapshot.
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

/// Whether the first target has been repaired and at least `restores` restore gaps
/// are recorded.
fn repaired(health: &Health, restores: usize) -> bool {
    let target_repaired = health
        .setup
        .targets
        .first()
        .is_some_and(|target| target.last_repair_ms.is_some());
    let restored = health
        .gaps
        .iter()
        .filter(|gap| gap.reason == GapReason::HooksRestored)
        .count();
    target_repaired && restored >= restores
}

#[test]
fn guard_repairs_a_wiped_target() {
    let layout = layout();
    seed(&layout, Some("9.0.0"), None);
    let _daemon = spawn_daemon(&layout);
    let mut client = subscribe(&layout.home);

    // The startup repair must be recorded before the wipe. A wipe that lands while
    // the startup apply is still being judged counts as a failed attempt, and the
    // brake then holds repairs for a minute.
    read_until(&mut client, "the startup repair to be recorded", |msg| {
        health_of(msg).is_some_and(|health| repaired(health, 1))
    });

    fs::write(&layout.settings, "{}").expect("wipe the guarded file");
    wait_until("the guard to repair the wiped file", || {
        file_has_mark(&layout.settings)
    });
    read_until(&mut client, "the wipe's repair to be recorded", |msg| {
        health_of(msg).is_some_and(|health| repaired(health, 2))
    });

    let log = fs::read_to_string(log_path(&layout.home)).expect("read daemon log");
    assert!(
        log.lines().any(|line| line == "apply: 1 targets, 0 not ok"),
        "log: {log}"
    );
    assert!(
        !log.contains(MARK),
        "the daemon log must not carry config text"
    );
}

#[test]
fn setup_plan_request_returns_consent_plan() {
    let layout = layout();
    seed(&layout, Some("9.0.0"), None);
    let _daemon = spawn_daemon(&layout);

    let mut client = subscribe(&layout.home);
    client.send(&ClientMsg::Setup {
        id: 9,
        action: SetupAction::Plan,
    });
    let plan = read_until(&mut client, "the consent plan for request 9", |msg| {
        matches!(msg, ServerMsg::ConsentPlan { id: 9, .. })
    });

    let ServerMsg::ConsentPlan {
        consent, targets, ..
    } = plan
    else {
        panic!("not a consent plan: {plan:?}");
    };
    assert_eq!(consent, ConsentState::Approved);
    assert_eq!(
        targets,
        vec![SetupTarget {
            harness: "claude-code".into(),
            kind: "desk-hooks".into(),
            path: path_str(&layout.settings),
            state: TargetState::Written,
            detail: None,
        }]
    );
    let runs = logged_runs(&layout.home);
    assert!(
        runs.iter().any(|argv| argv
            .iter()
            .skip(1)
            .map(String::as_str)
            .eq(["setup", "--auto", "plan", "--json"])),
        "no plan run in the fake CLI log: {runs:?}"
    );
}

#[test]
fn version_mismatch_reaches_health() {
    let layout = layout();
    seed(&layout, Some("9.0.0"), Some("8.0.0"));
    let _daemon = spawn_daemon(&layout);

    let mut client = subscribe(&layout.home);
    read_until(
        &mut client,
        "a health with a version mismatch",
        |msg| matches!(health_of(msg), Some(health) if health.setup.version_mismatch),
    );
}

#[test]
fn setup_without_a_cli_record_is_refused_and_the_connection_stays_up() {
    let layout = layout();
    seed(&layout, None, None);
    let _daemon = spawn_daemon(&layout);
    let mut client = subscribe(&layout.home);

    client.send(&ClientMsg::Setup {
        id: 4,
        action: SetupAction::Plan,
    });
    let refused = read_until(&mut client, "the refusal of request 4", |msg| {
        matches!(msg, ServerMsg::Ack { id: 4, .. })
    });
    assert!(
        matches!(
            refused,
            ServerMsg::Ack {
                id: 4,
                ok: false,
                ..
            }
        ),
        "{refused:?}"
    );

    client.send(&ClientMsg::RepoDecision {
        id: 6,
        root: "C:/work/repo".into(),
        allow: true,
    });
    let answered = read_until(&mut client, "the answer to request 6", |msg| {
        matches!(msg, ServerMsg::Ack { id: 6, .. })
    });
    assert!(
        matches!(
            answered,
            ServerMsg::Ack {
                id: 6,
                ok: false,
                ..
            }
        ),
        "{answered:?}"
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

    /// Connects once the socket exists, failing at the anti-hang guard. The daemon
    /// runs without `XDG_RUNTIME_DIR`, so its socket sits under the Rocky home.
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
        // A read blocks at most GUARD. A timed-out read fails the test rather than
        // resuming, because a partial line is not kept.
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
