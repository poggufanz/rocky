//! Verified local client for rockyd (protocol v1): a named pipe on Windows,
//! a unix socket elsewhere.
//!
//! Connect → verify the peer → `hello` → `subscribe`. Nothing is sent to an
//! unverified server. A std reader thread forwards decoded messages to the
//! caller; over-long lines and decode errors disconnect.

use std::io;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::mpsc;
use std::sync::mpsc::Sender;
use std::thread;
use std::time::Duration;

#[cfg(windows)]
use rocky_proto::paths::pipe_name;
use rocky_proto::pipe::{ClientMsg, ServerMsg};
use rocky_proto::pipe::{LINE_CAP, WireError, decode, decode_unbounded, encode};

#[cfg(windows)]
use std::os::windows::io::{AsRawHandle, RawHandle};

#[derive(Debug)]
pub enum VerifyError {
    Io(io::Error),
    Unverified,
}

impl From<io::Error> for VerifyError {
    fn from(e: io::Error) -> Self {
        VerifyError::Io(e)
    }
}

impl std::fmt::Display for VerifyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            VerifyError::Io(e) => write!(f, "verify server: {e}"),
            VerifyError::Unverified => write!(f, "pipe server is not this user"),
        }
    }
}

#[derive(Debug)]
pub enum ConnectError {
    Io(io::Error),
    Unverified,
    VersionMismatch,
    /// The pipe server accepted the connection but never answered `hello`
    /// within the caller's bound.
    Unresponsive,
}

impl From<io::Error> for ConnectError {
    fn from(e: io::Error) -> Self {
        ConnectError::Io(e)
    }
}

impl From<VerifyError> for ConnectError {
    fn from(e: VerifyError) -> Self {
        match e {
            VerifyError::Io(e) => ConnectError::Io(e),
            VerifyError::Unverified => ConnectError::Unverified,
        }
    }
}

impl std::fmt::Display for ConnectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConnectError::Io(e) => write!(f, "connect: {e}"),
            ConnectError::Unverified => write!(f, "pipe server is not this user"),
            ConnectError::VersionMismatch => write!(f, "daemon version mismatch"),
            ConnectError::Unresponsive => write!(f, "daemon hello timed out"),
        }
    }
}

/// Send side for desk→daemon messages. `hello` + `subscribe` are sent inside
/// [`connect_and_subscribe`]; the caller sends `cmd` later.
pub type Outbox = Sender<ClientMsg>;

/// Verify the pipe server runs as our own user: server PID via
/// `GetNamedPipeServerProcessId`, then compare its process-token user SID
/// with ours via `EqualSid`. Every handle is closed on all paths.
// An invalid handle only fails the syscall; the OS never dereferences it,
// so a safe signature is sound here (and required by the brief).
#[cfg(windows)]
#[allow(clippy::not_unsafe_ptr_arg_deref)]
pub fn verify_server(pipe: RawHandle) -> Result<(), VerifyError> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Pipes::GetNamedPipeServerProcessId;
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    unsafe {
        let mut pid = 0u32;
        if GetNamedPipeServerProcessId(pipe, &mut pid) == 0 {
            return Err(VerifyError::Io(io::Error::last_os_error()));
        }
        let server = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if server.is_null() {
            return Err(VerifyError::Io(io::Error::last_os_error()));
        }
        let ok = verify_server_token(server);
        CloseHandle(server);
        ok
    }
}

/// Compare the user SID of `server_process`'s token with our own.
#[cfg(windows)]
fn verify_server_token(server_process: *mut core::ffi::c_void) -> Result<(), VerifyError> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::Security::{
        EqualSid, GetTokenInformation, TOKEN_QUERY, TOKEN_USER, TokenUser,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    fn token_user_sid(
        token: *mut core::ffi::c_void,
        buf: &mut Vec<u8>,
    ) -> io::Result<*mut core::ffi::c_void> {
        // SAFETY: caller holds valid token handles; buf outlives the Sid copy.
        unsafe {
            let mut len = 0u32;
            // Probe the size first; the ERROR_INSUFFICIENT_BUFFER failure is expected.
            let _ = GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut len);
            buf.resize(len as usize, 0);
            let ok = GetTokenInformation(token, TokenUser, buf.as_mut_ptr().cast(), len, &mut len);
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
            // NB: `buf` is byte-aligned; copy the Sid pointer out without
            // forming a (possibly misaligned) `&TOKEN_USER`.
            let user_ptr = buf.as_ptr().cast::<TOKEN_USER>();
            Ok(std::ptr::addr_of!((*user_ptr).User.Sid).read_unaligned())
        }
    }

    unsafe {
        let mut server_token = std::ptr::null_mut();
        if OpenProcessToken(server_process, TOKEN_QUERY, &mut server_token) == 0 {
            return Err(VerifyError::Io(io::Error::last_os_error()));
        }
        let mut own_token = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut own_token) == 0 {
            let e = io::Error::last_os_error();
            CloseHandle(server_token);
            return Err(VerifyError::Io(e));
        }
        let mut server_buf = Vec::new();
        let mut own_buf = Vec::new();
        let server_sid = token_user_sid(server_token, &mut server_buf);
        let own_sid = token_user_sid(own_token, &mut own_buf);
        CloseHandle(server_token);
        CloseHandle(own_token);
        let (server_sid, own_sid) = (server_sid?, own_sid?);
        if EqualSid(server_sid, own_sid) == 0 {
            return Err(VerifyError::Unverified);
        }
        Ok(())
    }
}

/// Connect to the daemon endpoint, verify the server, shake `hello` (read the
/// daemon reply before subscribing), then spawn the reader thread. Returns
/// the outbox. The hello read waits at most `hello_timeout`; a server that
/// accepts and stays silent yields [`ConnectError::Unresponsive`].
///
/// The reader forwards decoded messages to `tx`, then sends `None` once and
/// exits when the connection drops for any reason (EOF, line over
/// `SERVER_LINE_CAP`, bad UTF-8, decode error). A `Version` wire error is
/// forwarded as `ServerMsg::Error { code: "version" }` before the `None` so
/// the caller can show the mismatch state.
#[cfg(windows)]
pub fn connect_and_subscribe(
    rocky_home: &Path,
    tx: Sender<Option<ServerMsg>>,
    hello_timeout: Duration,
) -> Result<Outbox, ConnectError> {
    use interprocess::os::windows::named_pipe::PipeStream;
    use interprocess::os::windows::named_pipe::pipe_mode::Bytes;

    let name = pipe_name(rocky_home);
    // Bounded: Timeout(ZERO) does one CreateFile and never waits, so a hung
    // daemon (all instances busy) fails fast instead of wedging the caller.
    // Retry/backoff policy belongs to the caller.
    let stream = PipeStream::<Bytes, Bytes>::connect_by_path_with_wait_mode(
        name.as_str(),
        interprocess::ConnectWaitMode::Timeout(std::time::Duration::ZERO),
    )?;
    verify_server(stream.as_raw_handle())?;
    let stream = hello_and_subscribe(stream, hello_timeout)?;

    let (cmd_tx, cmd_rx) = mpsc::channel::<ClientMsg>();
    let (recv, send) = stream.split();
    thread::spawn(move || client_loop(recv, send, tx, cmd_rx));
    Ok(cmd_tx)
}

/// Connect to the daemon unix socket, verify the peer is this user, shake
/// `hello`, then spawn the reader thread with the same contract as the
/// Windows client. A missing socket or a refused connect surfaces as
/// [`ConnectError::Io`] so the caller treats it as no daemon.
#[cfg(unix)]
pub fn connect_and_subscribe(
    rocky_home: &Path,
    tx: Sender<Option<ServerMsg>>,
    hello_timeout: Duration,
) -> Result<Outbox, ConnectError> {
    use std::os::unix::net::UnixStream;

    use rocky_proto::paths::socket_path;
    use rocky_proto::peer::{peer_uid, same_user};

    // A missing or stale socket file refuses the connect (ENOENT /
    // ECONNREFUSED) as an `Io` error, which the caller's retry/spawn path
    // treats like a missing pipe.
    let stream = UnixStream::connect(socket_path(rocky_home))?;
    if !same_user(peer_uid(&stream)) {
        return Err(ConnectError::Unverified);
    }
    let stream = hello_and_subscribe(stream, hello_timeout)?;

    // Reading and writing on clones is safe: each fd is its own handle on the
    // same socket, and the reader only reads while the writer only writes.
    let recv = stream.try_clone()?;
    let (cmd_tx, cmd_rx) = mpsc::channel::<ClientMsg>();
    thread::spawn(move || client_loop(recv, stream, tx, cmd_rx));
    Ok(cmd_tx)
}

/// Write `hello`, read the daemon reply under `hello_timeout`, then send
/// `subscribe`. Shared by both transports; returns the stream for the reader.
///
/// The daemon answers hello before it will read a subscribe line (on pipes the
/// reply is also a read barrier), so subscribing first would deadlock both
/// sides — keep this order.
fn hello_and_subscribe<S: Read + Write + Send + 'static>(
    mut stream: S,
    hello_timeout: Duration,
) -> Result<S, ConnectError> {
    write_msg(
        &mut stream,
        &ClientMsg::Hello {
            client: "rocky-desk".to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
        },
    )?;
    let mut stream = hello_handshake(stream, hello_timeout)?;
    write_msg(&mut stream, &ClientMsg::Subscribe)?;
    Ok(stream)
}

fn write_msg<W: Write>(stream: &mut W, msg: &ClientMsg) -> io::Result<()> {
    // No flush: writes are visible to readers immediately, while flushing a
    // pipe blocks until the other side reads — a deadlock-prone barrier this
    // protocol never needs (a reader is always pending).
    let line = encode(msg);
    stream.write_all(line.as_bytes())
}

/// Default bound on the hello handshake, for callers with no tighter budget of
/// their own. Bounded: a silent server must fail this attempt, not wedge it —
/// this runs on the connect worker thread, never the UI thread.
pub const HELLO_TIMEOUT: Duration = Duration::from_secs(5);

/// Blocking one-line hello read; shared by the live handshake and tests.
/// Byte-at-a-time so no bytes past the newline are consumed (the stream is
/// split afterwards).
fn read_hello_line<R: Read>(r: &mut R) -> Result<String, ConnectError> {
    let mut buf = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        match r.read(&mut byte)? {
            0 => {
                return Err(ConnectError::Io(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "daemon closed pipe during hello",
                )));
            }
            _ => {
                buf.push(byte[0]);
                if buf.len() > LINE_CAP {
                    return Err(ConnectError::Io(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "hello line too long",
                    )));
                }
                if byte[0] == b'\n' {
                    break;
                }
            }
        }
    }
    String::from_utf8(buf).map_err(|_| {
        ConnectError::Io(io::Error::new(
            io::ErrorKind::InvalidData,
            "hello is not utf-8",
        ))
    })
}

fn check_hello_line(text: &str) -> Result<(), ConnectError> {
    match decode::<ServerMsg>(text) {
        Ok(ServerMsg::Hello { .. }) => Ok(()),
        Ok(ServerMsg::Error { code }) if code == "version" => Err(ConnectError::VersionMismatch),
        Ok(_) => Err(ConnectError::Io(io::Error::new(
            io::ErrorKind::InvalidData,
            "expected daemon hello",
        ))),
        Err(WireError::Version(_)) => Err(ConnectError::VersionMismatch),
        Err(_) => Err(ConnectError::Io(io::Error::new(
            io::ErrorKind::InvalidData,
            "bad daemon hello",
        ))),
    }
}

/// Hello read with a bounded wait. The one-line read runs on a helper thread
/// (the stream moves there and back through channels); on timeout the stream
/// stays with the helper — dropped when its read ends, the attempt fails now.
/// Returns the stream on success.
fn hello_handshake<S: Read + Send + 'static>(
    mut stream: S,
    hello_timeout: Duration,
) -> Result<S, ConnectError> {
    let (done_tx, done_rx) = mpsc::channel::<Result<String, ConnectError>>();
    let (back_tx, back_rx) = mpsc::channel();
    thread::spawn(move || {
        let line = read_hello_line(&mut stream);
        let _ = done_tx.send(line);
        let _ = back_tx.send(stream);
    });
    match done_rx.recv_timeout(hello_timeout) {
        Ok(Ok(text)) => {
            check_hello_line(&text)?;
            back_rx.recv().map_err(|_| {
                ConnectError::Io(io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "hello helper lost the stream",
                ))
            })
        }
        Ok(Err(e)) => {
            // Helper finished with an error; reclaim the stream to close it.
            let _ = back_rx.recv();
            Err(e)
        }
        Err(_) => {
            // Timeout: reclaiming the stream would block on the wedged
            // helper, so detach — the helper drops it when its read ends.
            // The handle stays open until then; the attempt fails now.
            Err(ConnectError::Unresponsive)
        }
    }
}

/// Reader + writer on split halves: the writer drains `cmd_rx`, this thread
/// reads lines. Ends by sending `None` to `tx`.
fn client_loop<R, W>(
    mut recv: R,
    mut send: W,
    tx: Sender<Option<ServerMsg>>,
    cmd_rx: mpsc::Receiver<ClientMsg>,
) where
    R: Read + Send + 'static,
    W: Write + Send + 'static,
{
    let writer = thread::spawn(move || {
        for msg in cmd_rx {
            if write_msg(&mut send, &msg).is_err() {
                break;
            }
        }
    });

    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        match recv.read(&mut chunk) {
            Ok(0) => break, // EOF
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if !drain_lines(&mut buf, &tx) {
                    break;
                }
            }
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(5));
            }
            Err(_) => break,
        }
    }
    let _ = tx.send(None);
    writer.join().ok();
}

/// Decode complete lines in `buf`, forwarding to `tx`. Returns false when the
/// connection must drop (over-long line, bad UTF-8, decode error).
///
/// The 64 KiB `LINE_CAP` applies to client→daemon lines only. Server→desk
/// snapshots grow with agent count, so the desk allows much larger lines
/// here — still bounded so a rogue server cannot grow memory without limit.
const SERVER_LINE_CAP: usize = 16 * 1024 * 1024;

fn drain_lines(buf: &mut Vec<u8>, tx: &Sender<Option<ServerMsg>>) -> bool {
    loop {
        let Some(i) = buf.iter().position(|&b| b == b'\n') else {
            // No complete line: reject without buffering the rest into memory.
            return buf.len() <= SERVER_LINE_CAP;
        };
        let line: Vec<u8> = buf.drain(..=i).collect();
        if line.len() > SERVER_LINE_CAP {
            return false;
        }
        let Ok(text) = std::str::from_utf8(&line) else {
            return false;
        };
        match decode_unbounded::<ServerMsg>(text) {
            Ok(msg) => {
                if tx.send(Some(msg)).is_err() {
                    return false;
                }
            }
            Err(WireError::Version(_)) => {
                let _ = tx.send(Some(ServerMsg::Error {
                    code: "version".to_string(),
                }));
                return false;
            }
            Err(_) => return false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rocky_proto::pipe::{AgentKey, AgentStatus, Health, RepoInfo, Status, encode};
    use rocky_proto::settings::Settings;

    fn big_agent(name_len: usize) -> AgentStatus {
        AgentStatus {
            key: AgentKey {
                session_id: "s".into(),
                agent_id: String::new(),
            },
            agent_type: None,
            status: Status::Working,
            action: None,
            summary: None,
            description: None,
            failures: 0,
            last_event_ms: 1,
            quiet_10m: false,
            repo: RepoInfo {
                root: None,
                main_root: None,
                name: "n".repeat(name_len),
                branch: None,
            },
        }
    }

    #[test]
    fn server_lines_over_64kib_still_decode() {
        // A snapshot larger than the client-line cap must not disconnect: it
        // decodes and forwards under the larger server bound.
        let msg = ServerMsg::Snapshot {
            agents: vec![big_agent(LINE_CAP)],
            aggregate: Status::Working,
            health: Health::default(),
            settings: Settings::default(),
            repo_pending: Vec::new(),
        };
        let line = encode(&msg);
        assert!(line.len() > LINE_CAP, "fixture must exceed 64 KiB");
        let (tx, rx) = mpsc::channel();
        let mut buf = line.into_bytes();
        assert!(drain_lines(&mut buf, &tx));
        let got = rx.try_recv().unwrap().unwrap();
        assert!(matches!(got, ServerMsg::Snapshot { .. }), "{got:?}");
    }

    #[test]
    fn server_lines_past_16mib_disconnect() {
        // Still bounded: a line past SERVER_LINE_CAP drops the connection.
        let (tx, rx) = mpsc::channel();
        let mut buf = vec![b'x'; SERVER_LINE_CAP + 1];
        assert!(!drain_lines(&mut buf, &tx));
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn hello_line_reader_consumes_one_line() {
        let hello = encode(&ServerMsg::Hello {
            daemon_version: "0.1.0".into(),
            pid: 1,
        });
        let trailing = encode(&ServerMsg::Health {
            health: Health::default(),
        });
        let mut input = hello.as_bytes().to_vec();
        input.extend_from_slice(trailing.as_bytes());
        let mut cursor = io::Cursor::new(input);
        let text = read_hello_line(&mut cursor).unwrap();
        // Only the first line was consumed (byte-at-a-time, no over-read).
        assert_eq!(cursor.position() as usize, hello.len());
        check_hello_line(&text).unwrap();
    }
}
