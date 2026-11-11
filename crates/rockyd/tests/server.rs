//! Server pipe tests (in-process): each test gets its own temp ROCKY_HOME so
//! pipe names are unique.

#![cfg(windows)]

use std::io::{Read, Write};
use std::sync::Arc;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use interprocess::os::windows::named_pipe::pipe_mode::Bytes;
use interprocess::os::windows::named_pipe::{PipeStream, RecvPipeStream, SendPipeStream};
use rocky_proto::paths::pipe_name;
use rocky_proto::pipe::{
    AgentKey, CLIENT_QUEUE_CAP, ClientMsg, CmdName, Health, LINE_CAP, ServerMsg, Status, decode,
    encode,
};
use rocky_proto::settings::Settings;
use rockyd::server::{BindError, Control, DAEMON_VERSION, Hub, serve};
use tempfile::TempDir;

const GUARD: Duration = Duration::from_secs(10);

fn home() -> TempDir {
    TempDir::new().unwrap()
}

/// Test client: split stream, with a reader thread doing blocking reads and
/// forwarding chunks over a channel. (A nonblocking client read returns
/// `Ok(0)` when no data is available, which is indistinguishable from EOF, so
/// blocking reads behind `recv_timeout` are the only correct guarded read.)
struct Client {
    send: SendPipeStream<Bytes>,
    chunks: mpsc::Receiver<Option<Vec<u8>>>,
    buf: Vec<u8>,
    eof: bool,
    /// When set, the reader thread stops pulling from the pipe (simulates a
    /// client that never reads, so the hub queue overflows).
    paused: Arc<std::sync::atomic::AtomicBool>,
}

fn connect(pipe: &str) -> Client {
    let start = Instant::now();
    loop {
        match PipeStream::connect_by_path(pipe) {
            Ok(stream) => {
                let (recv, send) = stream.split();
                let (tx, rx) = mpsc::channel();
                let paused = Arc::new(std::sync::atomic::AtomicBool::new(false));
                thread::spawn({
                    let paused = Arc::clone(&paused);
                    move || read_loop(recv, tx, paused)
                });
                return Client {
                    send,
                    chunks: rx,
                    buf: Vec::new(),
                    eof: false,
                    paused,
                };
            }
            Err(e) => {
                assert!(start.elapsed() < GUARD, "connect timed out: {e}");
                thread::sleep(Duration::from_millis(10));
            }
        }
    }
}

/// Blocking read loop: `None` means EOF (or read error, treated as EOF).
fn read_loop(
    mut recv: RecvPipeStream<Bytes>,
    tx: mpsc::Sender<Option<Vec<u8>>>,
    paused: Arc<std::sync::atomic::AtomicBool>,
) {
    loop {
        if paused.load(std::sync::atomic::Ordering::Relaxed) {
            thread::sleep(Duration::from_millis(5));
            continue;
        }
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

impl Client {
    fn send(&mut self, line: &str) {
        self.send.write_all(line.as_bytes()).unwrap();
        self.send.flush().unwrap();
    }

    /// Read one line with an anti-hang guard; returns None on EOF.
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

    /// Drain everything until EOF (guarded per chunk).
    fn read_until_eof(&mut self) {
        while self.read_line().is_some() {}
    }
}

fn snapshot_msg() -> ServerMsg {
    ServerMsg::Snapshot {
        agents: vec![],
        aggregate: Status::Idle,
        health: Health::default(),
        settings: Settings::default(),
    }
}

/// hello + subscribe, leaving the client positioned after the snapshot.
fn hello_subscribe(client: &mut Client) {
    client.send(&encode(&ClientMsg::Hello {
        client: "desk".into(),
        version: "0.1.0".into(),
    }));
    let hello: ServerMsg = decode(&client.read_line().unwrap()).unwrap();
    assert!(matches!(hello, ServerMsg::Hello { .. }), "{hello:?}");
    client.send(&encode(&ClientMsg::Subscribe));
    let snap: ServerMsg = decode(&client.read_line().unwrap()).unwrap();
    assert!(matches!(snap, ServerMsg::Snapshot { .. }), "{snap:?}");
}

/// Next control message, guarded.
fn next_control(rx: &mpsc::Receiver<Control>) -> Control {
    let start = Instant::now();
    loop {
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(c) => return c,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                assert!(start.elapsed() < GUARD, "control never arrived");
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => panic!("control gone"),
        }
    }
}

#[test]
fn hello_then_subscribe_gets_snapshot_first() {
    let home = home();
    let hub = Arc::new(Hub::new());
    let (control_tx, _control_rx) = mpsc::channel();
    let snapshot = Arc::new(snapshot_msg);
    let _handle = serve(home.path(), Arc::clone(&hub), snapshot, control_tx).unwrap();

    let pipe = pipe_name(home.path());
    let mut client = connect(&pipe);
    client.send(&encode(&ClientMsg::Hello {
        client: "desk".into(),
        version: "0.1.0".into(),
    }));
    let hello: ServerMsg = decode(&client.read_line().unwrap()).unwrap();
    match hello {
        ServerMsg::Hello {
            daemon_version,
            pid,
        } => {
            assert_eq!(daemon_version, DAEMON_VERSION);
            assert_eq!(pid, std::process::id());
        }
        other => panic!("expected hello, got {other:?}"),
    }
    client.send(&encode(&ClientMsg::Subscribe));
    let snap: ServerMsg = decode(&client.read_line().unwrap()).unwrap();
    assert!(matches!(snap, ServerMsg::Snapshot { .. }), "got {snap:?}");

    // Broadcasts after subscribe reach this client.
    let health = ServerMsg::Health {
        health: Health::default(),
    };
    hub.broadcast(&health);
    let got: ServerMsg = decode(&client.read_line().unwrap()).unwrap();
    assert_eq!(got, health);
}

#[test]
fn version_mismatch_gets_error_and_close() {
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

    let pipe = pipe_name(home.path());
    let mut client = connect(&pipe);
    client.send("{\"v\":1,\"type\":\"hello\",\"client\":\"x\",\"version\":\"y\"}\n");
    let err: ServerMsg = decode(&client.read_line().unwrap()).unwrap();
    assert_eq!(
        err,
        ServerMsg::Error {
            code: "version".into()
        }
    );
    assert!(client.read_line().is_none(), "expected EOF after error");
}

#[test]
fn second_bind_is_taken() {
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
fn long_line_disconnects_client() {
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

    let pipe = pipe_name(home.path());
    let mut client = connect(&pipe);
    // No hello: one over-long line must be dropped without reading it all.
    let big = "x".repeat(LINE_CAP + 100);
    client.send(&format!(
        "{{\"v\":3,\"type\":\"hello\",\"client\":\"{big}\"}}\n"
    ));
    assert!(client.read_line().is_none(), "expected EOF");
}

#[test]
fn slow_client_is_dropped_not_blocking() {
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

    let pipe = pipe_name(home.path());
    let mut client = connect(&pipe);
    client.send(&encode(&ClientMsg::Hello {
        client: "desk".into(),
        version: "0.1.0".into(),
    }));
    let _hello = client.read_line().unwrap();
    client.send(&encode(&ClientMsg::Subscribe));
    let _snap = client.read_line().unwrap();

    // Client never reads again: broadcast must still return. While paused, the
    // writer's flush blocks (nothing consumes the pipe), so the hub queue must
    // overflow and the client is dropped.
    client
        .paused
        .store(true, std::sync::atomic::Ordering::Relaxed);
    for _ in 0..CLIENT_QUEUE_CAP + 10 {
        hub.broadcast(&ServerMsg::Health {
            health: Health::default(),
        });
    }
    client
        .paused
        .store(false, std::sync::atomic::Ordering::Relaxed);

    // Client observes EOF after draining whatever was written.
    client.read_until_eof();
    assert!(client.read_line().is_none());
}

#[test]
fn stop_cmd_reaches_control_and_acks() {
    let home = home();
    let hub = Arc::new(Hub::new());
    let (control_tx, control_rx) = mpsc::channel();
    let _handle = serve(
        home.path(),
        Arc::clone(&hub),
        Arc::new(snapshot_msg),
        control_tx,
    )
    .unwrap();

    let pipe = pipe_name(home.path());
    let mut client = connect(&pipe);
    client.send(&encode(&ClientMsg::Hello {
        client: "desk".into(),
        version: "0.1.0".into(),
    }));
    let _hello = client.read_line().unwrap();
    client.send(&encode(&ClientMsg::Subscribe));
    let _snap = client.read_line().unwrap();
    client.send(&encode(&ClientMsg::Cmd {
        name: CmdName::Stop,
        id: 7,
    }));

    let start = Instant::now();
    let ctrl = loop {
        match control_rx.recv_timeout(Duration::from_millis(50)) {
            Ok(c) => break c,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                assert!(start.elapsed() < GUARD, "control never arrived");
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => panic!("control gone"),
        }
    };
    let Control::Stop {
        id,
        reply,
        flushed,
        quit,
    } = ctrl
    else {
        panic!("expected stop, got {ctrl:?}");
    };
    assert_eq!(id, 7);
    assert!(!quit, "cmd stop is not quit");
    reply
        .send(ServerMsg::Ack {
            id: 7,
            ok: true,
            error: None,
        })
        .unwrap();
    flushed.recv_timeout(GUARD).unwrap();
    let ack: ServerMsg = decode(&client.read_line().unwrap()).unwrap();
    assert_eq!(
        ack,
        ServerMsg::Ack {
            id: 7,
            ok: true,
            error: None
        }
    );
}

#[test]
fn quit_broadcasts_to_every_subscriber_then_acks() {
    let home = home();
    let hub = Arc::new(Hub::new());
    let (control_tx, control_rx) = mpsc::channel();
    let _handle = serve(
        home.path(),
        Arc::clone(&hub),
        Arc::new(snapshot_msg),
        control_tx,
    )
    .unwrap();

    let pipe = pipe_name(home.path());
    let mut a = connect(&pipe);
    let mut b = connect(&pipe);
    hello_subscribe(&mut a);
    hello_subscribe(&mut b);

    a.send(&encode(&ClientMsg::Cmd {
        name: CmdName::Quit,
        id: 5,
    }));

    // Every subscriber hears quit before the sender's ack.
    let quit_a: ServerMsg = decode(&a.read_line().unwrap()).unwrap();
    assert_eq!(quit_a, ServerMsg::Quit);
    let quit_b: ServerMsg = decode(&b.read_line().unwrap()).unwrap();
    assert_eq!(quit_b, ServerMsg::Quit);

    let Control::Stop {
        id,
        reply,
        flushed,
        quit,
    } = next_control(&control_rx)
    else {
        panic!("expected the stop path");
    };
    assert_eq!(id, 5);
    assert!(quit, "quit must reach the daemon as quit");
    reply
        .send(ServerMsg::Ack {
            id: 5,
            ok: true,
            error: None,
        })
        .unwrap();
    flushed.recv_timeout(GUARD).unwrap();

    let ack: ServerMsg = decode(&a.read_line().unwrap()).unwrap();
    assert_eq!(
        ack,
        ServerMsg::Ack {
            id: 5,
            ok: true,
            error: None
        }
    );
}

#[test]
fn snapshot_always_precedes_broadcast_deltas() {
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

    // Hammer broadcast while clients subscribe; registration + snapshot
    // enqueue are atomic, so no delta can ever precede the snapshot.
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let hammer = thread::spawn({
        let hub = Arc::clone(&hub);
        let stop = Arc::clone(&stop);
        move || {
            while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                hub.broadcast(&ServerMsg::Health {
                    health: Health::default(),
                });
            }
        }
    });

    let pipe = pipe_name(home.path());
    for _ in 0..20 {
        let mut client = connect(&pipe);
        client.send(&encode(&ClientMsg::Hello {
            client: "desk".into(),
            version: "0.1.0".into(),
        }));
        let _hello = client.read_line().unwrap();
        client.send(&encode(&ClientMsg::Subscribe));
        let first: ServerMsg = decode(&client.read_line().unwrap()).unwrap();
        assert!(
            matches!(first, ServerMsg::Snapshot { .. }),
            "delta preceded snapshot: {first:?}"
        );
    }
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    hammer.join().unwrap();
}

#[test]
fn cmd_show_reaches_other_clients_and_acks_sender() {
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

    let pipe = pipe_name(home.path());
    let mut a = connect(&pipe);
    let mut b = connect(&pipe);
    hello_subscribe(&mut a);
    hello_subscribe(&mut b);

    b.send(&encode(&ClientMsg::Cmd {
        name: CmdName::Show,
        id: 5,
    }));

    // A sees the broadcast.
    let shown: ServerMsg = decode(&a.read_line().unwrap()).unwrap();
    assert_eq!(shown, ServerMsg::Show);

    // B sees its own broadcast first, then the ack queued on its hub queue.
    let shown_b: ServerMsg = decode(&b.read_line().unwrap()).unwrap();
    assert_eq!(shown_b, ServerMsg::Show);
    let ack: ServerMsg = decode(&b.read_line().unwrap()).unwrap();
    assert_eq!(
        ack,
        ServerMsg::Ack {
            id: 5,
            ok: true,
            error: None
        }
    );
}

#[test]
fn set_and_timeline_route_through_control_to_sender_only() {
    let home = home();
    let hub = Arc::new(Hub::new());
    let (control_tx, control_rx) = mpsc::channel();
    let _handle = serve(
        home.path(),
        Arc::clone(&hub),
        Arc::new(snapshot_msg),
        control_tx,
    )
    .unwrap();

    let pipe = pipe_name(home.path());
    let mut sender = connect(&pipe);
    let mut bystander = connect(&pipe);
    hello_subscribe(&mut sender);
    hello_subscribe(&mut bystander);

    let key = AgentKey {
        session_id: "s1".into(),
        agent_id: String::new(),
    };

    sender.send(&encode(&ClientMsg::Set {
        id: 1,
        name: "tool_text".into(),
        value: serde_json::json!(false),
    }));
    let Control::Set {
        id,
        name,
        value,
        reply,
    } = next_control(&control_rx)
    else {
        panic!("expected set");
    };
    assert_eq!(id, 1);
    assert_eq!(name, "tool_text");
    assert_eq!(value, serde_json::json!(false));
    reply
        .send(ServerMsg::Ack {
            id: 1,
            ok: true,
            error: None,
        })
        .unwrap();
    let ack: ServerMsg = decode(&sender.read_line().unwrap()).unwrap();
    assert_eq!(
        ack,
        ServerMsg::Ack {
            id: 1,
            ok: true,
            error: None
        }
    );

    sender.send(&encode(&ClientMsg::Timeline {
        id: 2,
        key: key.clone(),
    }));
    let Control::Timeline {
        id,
        key: got_key,
        reply,
    } = next_control(&control_rx)
    else {
        panic!("expected timeline");
    };
    assert_eq!(id, 2);
    assert_eq!(got_key, key);
    reply
        .send(ServerMsg::Timeline {
            id: 2,
            key: key.clone(),
            entries: vec![],
        })
        .unwrap();
    let reply: ServerMsg = decode(&sender.read_line().unwrap()).unwrap();
    assert_eq!(
        reply,
        ServerMsg::Timeline {
            id: 2,
            key,
            entries: vec![]
        }
    );

    // Neither reply reached the bystander: a marker broadcast is its next line.
    let marker = ServerMsg::Health {
        health: Health::default(),
    };
    hub.broadcast(&marker);
    let got: ServerMsg = decode(&bystander.read_line().unwrap()).unwrap();
    assert_eq!(got, marker);
}
