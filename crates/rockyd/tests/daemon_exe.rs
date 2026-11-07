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
use rocky_proto::paths::{
    desk_dir, log_path, pipe_name, settings_path, spool_dir, tool_text_off_marker,
};
use rocky_proto::pipe::{
    AgentKey, ClientMsg, CmdName, Gap, GapReason, Outcome, ServerMsg, Status, StatusOp,
    TimelineKind, decode, encode,
};
use rocky_proto::settings::Settings;
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
    child: KillOnDrop,
    _home: TempDir,
}

impl Daemon {
    fn spawn(home: TempDir) -> Self {
        let mut child = spawn_daemon(home.path());
        wait_pipe(home.path(), &mut child);
        Daemon { child, _home: home }
    }

    fn home(&self) -> &Path {
        self._home.path()
    }

    fn try_wait(&mut self) -> std::io::Result<Option<std::process::ExitStatus>> {
        self.child.0.try_wait()
    }

    fn wait(&mut self) -> std::io::Result<std::process::ExitStatus> {
        self.child.0.wait()
    }
}

/// Kills its child and waits on drop, so a panicking assert never leaves a
/// process behind.
struct KillOnDrop(Child);

impl Drop for KillOnDrop {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn spawn_daemon(home: &Path) -> KillOnDrop {
    KillOnDrop(
        Command::new(env!("CARGO_BIN_EXE_rockyd"))
            .env("ROCKY_HOME", home)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    )
}

/// Wait for the pipe, surfacing an early daemon exit instead of hanging.
fn wait_pipe(home: &Path, child: &mut KillOnDrop) {
    let pipe = pipe_name(home);
    let start = Instant::now();
    loop {
        if PipeStream::<Bytes, Bytes>::connect_by_path(pipe.as_str()).is_ok() {
            break;
        }
        if let Ok(Some(status)) = child.0.try_wait() {
            panic!("rockyd exited early: {status}");
        }
        assert!(start.elapsed() < GUARD, "pipe never appeared");
        thread::sleep(Duration::from_millis(25));
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
    let mut child = KillOnDrop(
        Command::new(hook_exe())
            .args(["desk-hook", "claude-code"])
            .env("ROCKY_HOME", home)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    child
        .0
        .stdin
        .take()
        .unwrap()
        .write_all(payload.as_bytes())
        .unwrap();
    let status = child.0.wait().unwrap();
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
    let mut second = KillOnDrop(
        Command::new(env!("CARGO_BIN_EXE_rockyd"))
            .env("ROCKY_HOME", first.home())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
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
    // Bind-first: a duplicate daemon must exit 3 without ingesting or
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

    let mut second = KillOnDrop(
        Command::new(env!("CARGO_BIN_EXE_rockyd"))
            .env("ROCKY_HOME", first.home())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
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

/// Wait for a child with the anti-hang guard; kill and reap it rather than
/// hang forever on guard expiry.
fn wait_exit(child: &mut KillOnDrop, what: &str) -> std::process::ExitStatus {
    let start = Instant::now();
    loop {
        if let Some(s) = child.0.try_wait().unwrap() {
            return s;
        }
        if start.elapsed() >= GUARD {
            let _ = child.0.kill();
            let _ = child.0.wait();
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

fn main_key(session: &str) -> AgentKey {
    AgentKey {
        session_id: session.into(),
        agent_id: String::new(),
    }
}

/// Adds a spool file with the given name and content.
fn write_spool(home: &Path, name: &str, body: &str) {
    let spool = spool_dir(home);
    fs::create_dir_all(&spool).unwrap();
    fs::write(spool.join(name), body).unwrap();
}

/// Read past non-matching messages until a snapshot satisfies `want`; the
/// snapshot `hello_subscribe` already returned is checked first.
fn snapshot_until(
    client: &mut Client,
    first: ServerMsg,
    what: &str,
    want: impl Fn(&ServerMsg) -> bool,
) -> ServerMsg {
    let mut next = Some(first);
    let start = Instant::now();
    loop {
        let msg = match next.take() {
            Some(m) => m,
            None => decode(&client.read_line().unwrap()).unwrap(),
        };
        if want(&msg) {
            return msg;
        }
        assert!(start.elapsed() < GUARD, "{what} never arrived");
    }
}

/// Read past non-matching messages until the ack with `id` arrives.
fn ack_for(client: &mut Client, id: u64) -> ServerMsg {
    let start = Instant::now();
    loop {
        let msg: ServerMsg = decode(&client.read_line().unwrap()).unwrap();
        let matches_id = matches!(&msg, ServerMsg::Ack { id: got, .. } if *got == id);
        if matches_id {
            return msg;
        }
        assert!(start.elapsed() < GUARD, "ack {id} never arrived");
    }
}

#[test]
fn restart_replays_history() {
    let home = home();
    let mut first = spawn_daemon(home.path());
    wait_pipe(home.path(), &mut first);

    let mut client = connect(&pipe_name(home.path()));
    let _ = client.hello_subscribe();

    run_hook(
        home.path(),
        r#"{"hook_event_name":"SessionStart","session_id":"r1","cwd":"C:\\r"}"#,
    );
    run_hook(
        home.path(),
        r#"{"hook_event_name":"UserPromptSubmit","session_id":"r1","cwd":"C:\\r"}"#,
    );
    run_hook(
        home.path(),
        r#"{"hook_event_name":"PreToolUse","session_id":"r1","cwd":"C:\\r","tool_name":"Bash","tool_use_id":"t1","tool_input":{"command":"npm test"}}"#,
    );

    let key = main_key("r1");
    let start = Instant::now();
    loop {
        let msg: ServerMsg = decode(&client.read_line().unwrap()).unwrap();
        if let ServerMsg::Status {
            op: StatusOp::Upsert,
            agent,
        } = &msg
            && agent.key == key
            && agent.action.as_ref().and_then(|a| a.tool_use_id.as_deref()) == Some("t1")
        {
            break;
        }
        assert!(start.elapsed() < GUARD, "PreToolUse upsert never arrived");
    }

    // Hard kill: history must survive without a graceful exit.
    let _ = first.0.kill();
    let _ = first.0.wait();
    drop(client);

    let mut second = spawn_daemon(home.path());
    wait_pipe(home.path(), &mut second);
    let mut client = connect(&pipe_name(home.path()));
    let first_snapshot = client.hello_subscribe();
    let snapshot = snapshot_until(
        &mut client,
        first_snapshot,
        "replayed agent",
        |m| matches!(m, ServerMsg::Snapshot { agents, .. } if agents.iter().any(|a| a.key == main_key("r1"))),
    );
    match snapshot {
        ServerMsg::Snapshot { agents, .. } => {
            let main = agents.iter().find(|a| a.key == key).expect("agent missing");
            assert_eq!(main.status, Status::Working, "{main:?}");
            assert_eq!(
                main.action.as_ref().and_then(|a| a.command.as_deref()),
                Some("npm test"),
                "{main:?}"
            );
        }
        other => panic!("expected snapshot, got {other:?}"),
    }

    client.send(&encode(&ClientMsg::Timeline {
        id: 1,
        key: key.clone(),
    }));
    let start = Instant::now();
    let reply = loop {
        let msg: ServerMsg = decode(&client.read_line().unwrap()).unwrap();
        if matches!(&msg, ServerMsg::Timeline { .. }) {
            break msg;
        }
        assert!(start.elapsed() < GUARD, "timeline reply never arrived");
    };
    match reply {
        ServerMsg::Timeline {
            id,
            key: got_key,
            entries,
        } => {
            assert_eq!(id, 1);
            assert_eq!(got_key, key);
            let kinds: Vec<TimelineKind> = entries.iter().map(|e| e.kind).collect();
            assert_eq!(
                kinds,
                [
                    TimelineKind::SessionStart,
                    TimelineKind::TurnStart,
                    TimelineKind::Tool
                ],
                "{entries:?}"
            );
            assert_eq!(entries.last().unwrap().outcome, Some(Outcome::Pending));
        }
        other => panic!("expected timeline, got {other:?}"),
    }
}

#[test]
fn removed_replayed_child_reaches_the_desk() {
    let home = home();
    let mut first = spawn_daemon(home.path());
    wait_pipe(home.path(), &mut first);
    let mut client = connect(&pipe_name(home.path()));
    let _ = client.hello_subscribe();

    run_hook(
        home.path(),
        r#"{"hook_event_name":"SessionStart","session_id":"r3","cwd":"C:\\r"}"#,
    );
    run_hook(
        home.path(),
        r#"{"hook_event_name":"UserPromptSubmit","session_id":"r3","cwd":"C:\\r"}"#,
    );
    run_hook(
        home.path(),
        r#"{"hook_event_name":"SubagentStart","session_id":"r3","cwd":"C:\\r","agent_id":"c1","agent_type":"Explore"}"#,
    );
    run_hook(
        home.path(),
        r#"{"hook_event_name":"SubagentStop","session_id":"r3","cwd":"C:\\r","agent_id":"c1","agent_type":"Explore"}"#,
    );

    // The child's Done upsert proves every earlier file was ingested into
    // history before the kill.
    let child = AgentKey {
        session_id: "r3".into(),
        agent_id: "c1".into(),
    };
    let start = Instant::now();
    loop {
        let msg: ServerMsg = decode(&client.read_line().unwrap()).unwrap();
        if let ServerMsg::Status {
            op: StatusOp::Upsert,
            agent,
        } = &msg
            && agent.key == child
            && agent.status == Status::Done
        {
            break;
        }
        assert!(start.elapsed() < GUARD, "SubagentStop upsert never arrived");
    }

    let _ = first.0.kill();
    let _ = first.0.wait();
    drop(client);

    // Replay restores the finished child, and the startup snapshot tells the
    // desk about it.
    let mut second = spawn_daemon(home.path());
    wait_pipe(home.path(), &mut second);
    let mut client = connect(&pipe_name(home.path()));
    let first_snapshot = client.hello_subscribe();
    let snapshot = snapshot_until(&mut client, first_snapshot, "replayed child", |m| {
        matches!(m, ServerMsg::Snapshot { agents, .. } if agents.iter().any(|a| a.key == child))
    });
    match snapshot {
        ServerMsg::Snapshot { agents, .. } => {
            assert_eq!(
                agents.iter().find(|a| a.key == child).unwrap().status,
                Status::Done
            );
        }
        other => panic!("expected snapshot, got {other:?}"),
    }

    // A main prompt drops the finished child; the desk must be told to remove
    // the row it learned from the snapshot.
    run_hook(
        home.path(),
        r#"{"hook_event_name":"UserPromptSubmit","session_id":"r3","cwd":"C:\\r"}"#,
    );
    let start = Instant::now();
    loop {
        let msg: ServerMsg = decode(&client.read_line().unwrap()).unwrap();
        if let ServerMsg::Status {
            op: StatusOp::Remove,
            agent,
        } = &msg
            && agent.key == child
        {
            assert_eq!(agent.status, Status::Done);
            break;
        }
        assert!(
            start.elapsed() < GUARD,
            "Remove for the replayed child never arrived"
        );
    }
}

#[test]
fn set_persists_broadcasts_and_syncs_marker() {
    let home = home();
    let mut first = spawn_daemon(home.path());
    wait_pipe(home.path(), &mut first);
    let mut client = connect(&pipe_name(home.path()));
    let _ = client.hello_subscribe();

    client.send(&encode(&ClientMsg::Set {
        id: 2,
        name: "tool_text".into(),
        value: serde_json::json!(false),
    }));

    let start = Instant::now();
    let (mut settings_seen, mut ack_seen) = (false, false);
    while !(settings_seen && ack_seen) {
        let msg: ServerMsg = decode(&client.read_line().unwrap()).unwrap();
        match msg {
            ServerMsg::Settings { settings } => {
                assert!(!settings.tool_text, "{settings:?}");
                settings_seen = true;
            }
            ServerMsg::Ack { id: 2, ok, error } => {
                assert!(ok, "{error:?}");
                ack_seen = true;
            }
            _ => {}
        }
        assert!(start.elapsed() < GUARD, "set reply never arrived");
    }
    assert!(tool_text_off_marker(home.path()).is_file());
    let saved: Settings =
        serde_json::from_str(&fs::read_to_string(settings_path(home.path())).unwrap()).unwrap();
    assert!(!saved.tool_text, "{saved:?}");

    let _ = first.0.kill();
    let _ = first.0.wait();
    drop(client);

    let mut second = spawn_daemon(home.path());
    wait_pipe(home.path(), &mut second);
    let mut client = connect(&pipe_name(home.path()));
    let first_snapshot = client.hello_subscribe();
    snapshot_until(
        &mut client,
        first_snapshot,
        "persisted setting",
        |m| matches!(m, ServerMsg::Snapshot { settings, .. } if !settings.tool_text),
    );
}

#[test]
fn bad_set_acks_false_and_changes_nothing() {
    let home = home();
    let mut daemon = spawn_daemon(home.path());
    wait_pipe(home.path(), &mut daemon);
    let mut client = connect(&pipe_name(home.path()));
    let _ = client.hello_subscribe();

    client.send(&encode(&ClientMsg::Set {
        id: 3,
        name: "nope".into(),
        value: serde_json::json!(true),
    }));
    match ack_for(&mut client, 3) {
        ServerMsg::Ack { ok, error, .. } => {
            assert!(!ok);
            assert_eq!(error.as_deref(), Some("unknown setting"));
        }
        other => panic!("expected ack, got {other:?}"),
    }
    assert!(!settings_path(home.path()).exists());
}

#[test]
fn unreadable_settings_show_in_health_until_a_set() {
    let home = home();
    fs::create_dir_all(desk_dir(home.path())).unwrap();
    fs::write(settings_path(home.path()), "{bad").unwrap();

    let mut daemon = spawn_daemon(home.path());
    wait_pipe(home.path(), &mut daemon);
    let mut client = connect(&pipe_name(home.path()));
    let first_snapshot = client.hello_subscribe();
    let snapshot = snapshot_until(
        &mut client,
        first_snapshot,
        "unreadable health",
        |m| matches!(m, ServerMsg::Snapshot { health, .. } if health.settings_unreadable),
    );
    match snapshot {
        ServerMsg::Snapshot { settings, .. } => assert_eq!(settings, Settings::default()),
        other => panic!("expected snapshot, got {other:?}"),
    }
    assert_eq!(fs::read(settings_path(home.path())).unwrap(), b"{bad");

    client.send(&encode(&ClientMsg::Set {
        id: 4,
        name: "history".into(),
        value: serde_json::json!(false),
    }));
    let start = Instant::now();
    let (mut ack_seen, mut fixed_seen) = (false, false);
    while !(ack_seen && fixed_seen) {
        let msg: ServerMsg = decode(&client.read_line().unwrap()).unwrap();
        match msg {
            ServerMsg::Ack { id: 4, ok, .. } => {
                assert!(ok);
                ack_seen = true;
            }
            ServerMsg::Health { health } if !health.settings_unreadable => fixed_seen = true,
            _ => {}
        }
        assert!(start.elapsed() < GUARD, "set reply never arrived");
    }
    let saved: Settings =
        serde_json::from_str(&fs::read_to_string(settings_path(home.path())).unwrap()).unwrap();
    assert!(!saved.history, "{saved:?}");
}

#[test]
fn start_reports_bad_spool_file_as_gap() {
    let home = home();
    // Real clock in the spool name, so the reported gap is not legitimately
    // older than the 24-hour gap window.
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    write_spool(home.path(), &format!("{t:013}-1.json"), "{bad");

    let mut daemon = spawn_daemon(home.path());
    wait_pipe(home.path(), &mut daemon);
    let mut client = connect(&pipe_name(home.path()));
    let first_snapshot = client.hello_subscribe();
    let snapshot = snapshot_until(
        &mut client,
        first_snapshot,
        "bad file gap",
        |m| matches!(m, ServerMsg::Snapshot { health, .. } if health.bad_files == 1),
    );
    match snapshot {
        ServerMsg::Snapshot { health, .. } => {
            assert_eq!(health.bad_files, 1, "{health:?}");
            assert!(
                health.gaps.contains(&Gap {
                    from_ms: t,
                    to_ms: t,
                    count: 1,
                    reason: GapReason::BadFile,
                }),
                "{health:?}"
            );
        }
        other => panic!("expected snapshot, got {other:?}"),
    }
}

#[test]
fn timeline_for_unknown_agent_is_empty() {
    let home = home();
    let mut daemon = spawn_daemon(home.path());
    wait_pipe(home.path(), &mut daemon);
    let mut client = connect(&pipe_name(home.path()));
    let _ = client.hello_subscribe();

    let nobody = AgentKey {
        session_id: "nobody".into(),
        agent_id: "gone".into(),
    };
    client.send(&encode(&ClientMsg::Timeline {
        id: 3,
        key: nobody.clone(),
    }));
    let start = Instant::now();
    let reply = loop {
        let msg: ServerMsg = decode(&client.read_line().unwrap()).unwrap();
        if matches!(&msg, ServerMsg::Timeline { .. }) {
            break msg;
        }
        assert!(start.elapsed() < GUARD, "timeline reply never arrived");
    };
    match reply {
        ServerMsg::Timeline { id, key, entries } => {
            assert_eq!(id, 3);
            assert_eq!(key, nobody);
            assert!(entries.is_empty(), "{entries:?}");
        }
        other => panic!("expected timeline, got {other:?}"),
    }

    // The connection stays open: a following set still acks.
    client.send(&encode(&ClientMsg::Set {
        id: 4,
        name: "tool_text".into(),
        value: serde_json::json!(true),
    }));
    match ack_for(&mut client, 4) {
        ServerMsg::Ack { ok, .. } => assert!(ok),
        other => panic!("expected ack, got {other:?}"),
    }
}
