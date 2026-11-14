//! Desk client server (protocol v4): a single-instance user-only connection
//! endpoint (a named pipe on Windows, a unix socket elsewhere), per-client
//! threads, and a non-blocking broadcast hub.

use std::collections::HashMap;
use std::io;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::sync::mpsc::{Receiver, Sender, SyncSender};
use std::thread;
use std::thread::JoinHandle;

use rocky_proto::pipe::CLIENT_QUEUE_CAP;
use rocky_proto::pipe::{
    AgentKey, ClientMsg, CmdName, LINE_CAP, ServerMsg, SetupAction, WireError, decode, encode,
};
use serde_json::Value;

pub const DAEMON_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug)]
pub enum BindError {
    /// Another instance holds the daemon lock.
    Taken,
    /// The socket path exceeds the kernel's limit.
    PathTooLong,
    Io(io::Error),
}

impl From<io::Error> for BindError {
    fn from(e: io::Error) -> Self {
        BindError::Io(e)
    }
}

#[derive(Debug)]
pub enum Control {
    /// `cmd stop` and `cmd quit` share this path: the daemon acks and exits.
    Stop {
        id: u64,
        reply: SyncSender<ServerMsg>,
        /// Signalled by the client thread after the ack line is flushed, so
        /// the daemon can exit without racing the client writer thread.
        flushed: Receiver<()>,
        /// True for `cmd quit`, which also told every desk to close.
        quit: bool,
    },
    /// A settings change; the daemon replies with the ack to queue.
    Set {
        id: u64,
        name: String,
        value: Value,
        reply: SyncSender<ServerMsg>,
    },
    /// A timeline read; the daemon replies with the entries to queue.
    Timeline {
        id: u64,
        key: AgentKey,
        reply: SyncSender<ServerMsg>,
    },
    /// A `setup` request; the daemon replies with the ack or the consent plan.
    Setup {
        id: u64,
        action: SetupAction,
        reply: SyncSender<ServerMsg>,
    },
    /// A `repo_decision` request; the daemon replies with the ack.
    RepoDecision {
        id: u64,
        root: String,
        allow: bool,
        reply: SyncSender<ServerMsg>,
    },
    /// A `cards` page request; the daemon replies with `ServerMsg::Cards`.
    Cards {
        id: u64,
        query: Option<String>,
        before: Option<String>,
        limit: u32,
        reply: SyncSender<ServerMsg>,
    },
    /// A `card_detail` request; the daemon replies with `ServerMsg::CardDetail` or an ack error.
    CardDetail {
        id: u64,
        card_id: String,
        reply: SyncSender<ServerMsg>,
    },
    /// A `block_diff` page request; the daemon replies with `ServerMsg::BlockDiff`.
    BlockDiff {
        id: u64,
        card_id: String,
        seq: u32,
        page: u32,
        reply: SyncSender<ServerMsg>,
    },
}

/// Broadcast hub: one bounded queue per subscribed client. `broadcast` never
/// blocks; a client whose queue is full or gone is disconnected instead.
///
/// Lock order: `Hub::add` runs the snapshot closure while holding the hub
/// lock (so the snapshot is computed, registered, and enqueued atomically).
/// Callers must therefore never hold a lock the snapshot closure needs (e.g.
/// the daemon state lock) while calling `broadcast` — hub → state, never the
/// reverse — or the daemon can deadlock.
pub struct Hub {
    next_id: AtomicU64,
    clients: Mutex<HashMap<u64, Client>>,
}

struct Client {
    tx: SyncSender<String>,
    /// Fired when the client is removed so its connection actually closes.
    /// `None` once fired (close runs exactly once).
    close: Option<Sender<()>>,
}

impl Hub {
    pub fn new() -> Self {
        Hub {
            next_id: AtomicU64::new(1),
            clients: Mutex::new(HashMap::new()),
        }
    }

    /// Register a subscribed client with its snapshot queued atomically:
    /// snapshot computation, registration, and snapshot enqueue all happen
    /// under one hub-lock hold, so no broadcast delta can slip between the
    /// snapshot and (or ahead of) it. Returns the id and the receiving side
    /// of the client's queue, drained by the client's writer thread.
    ///
    /// The `snapshot` closure runs while holding the hub lock; it must not
    /// call back into the hub.
    fn add(&self, close: Sender<()>, snapshot: &dyn Fn() -> ServerMsg) -> (u64, Receiver<String>) {
        let (tx, rx) = mpsc::sync_channel(CLIENT_QUEUE_CAP);
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let mut clients = self.clients.lock().unwrap();
        let line = encode(&snapshot());
        // Infallible: fresh queue with CLIENT_QUEUE_CAP free slots.
        let _ = tx.try_send(line);
        clients.insert(
            id,
            Client {
                tx,
                close: Some(close),
            },
        );
        (id, rx)
    }

    fn remove(&self, id: u64) {
        Self::remove_locked(&mut self.clients.lock().unwrap(), id);
    }

    fn remove_locked(clients: &mut HashMap<u64, Client>, id: u64) {
        if let Some(mut c) = clients.remove(&id)
            && let Some(close) = c.close.take()
        {
            let _ = close.send(());
        }
    }

    pub fn broadcast(&self, msg: &ServerMsg) {
        self.broadcast_except(0, msg);
    }

    /// Queues one message to every subscribed client except `skip`. Client
    /// ids start at 1, so 0 means everyone.
    fn broadcast_except(&self, skip: u64, msg: &ServerMsg) {
        let line = encode(msg);
        let mut clients = self.clients.lock().unwrap();
        let ids: Vec<u64> = clients.keys().copied().collect();
        for id in ids {
            if id == skip {
                continue;
            }
            let drop = match clients.get_mut(&id) {
                Some(c) => c.tx.try_send(line.clone()).is_err(),
                None => false,
            };
            if drop {
                Self::remove_locked(&mut clients, id);
            }
        }
    }

    /// Queues one message to one client and drops it when its queue is full
    /// (or gone). Returns whether the message was queued.
    pub fn send_to(&self, client: u64, msg: &ServerMsg) -> bool {
        let line = encode(msg);
        let mut clients = self.clients.lock().unwrap();
        let queued = match clients.get_mut(&client) {
            Some(c) => c.tx.try_send(line).is_ok(),
            None => false,
        };
        if !queued {
            Self::remove_locked(&mut clients, client);
        }
        queued
    }
}

impl Default for Hub {
    fn default() -> Self {
        Self::new()
    }
}

pub fn serve(
    rocky_home: &Path,
    hub: Arc<Hub>,
    snapshot: Arc<dyn Fn() -> ServerMsg + Send + Sync>,
    control: Sender<Control>,
) -> Result<JoinHandle<()>, BindError> {
    imp::serve(rocky_home, hub, snapshot, control)
}

/// Whether `path` fits the kernel's unix socket path limit: the 108-byte
/// `sun_path` includes the NUL, so a path of up to 107 bytes fits.
#[cfg(unix)]
pub fn socket_path_fits(path: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;

    path.as_os_str().as_bytes().len() <= rocky_proto::paths::SOCKET_PATH_MAX
}

/// One connected client stream, whatever the transport.
pub(crate) trait DuplexConn: Send + Sync + 'static {
    /// Force the client to observe EOF: break the connection so a blocked
    /// read fails and the next read returns EOF. Safe to call while another
    /// thread is reading.
    fn hang_up(&self);
}

/// Read one line, capped at `LINE_CAP + 1` bytes so an over-long line is
/// detected without reading the rest into memory. Returns `None` on EOF.
/// The returned vec holds at most `LINE_CAP + 1` bytes; callers treat
/// `len() > LINE_CAP` as "too long" and disconnect.
fn read_line_capped<R: Read>(reader: &mut BufReader<R>) -> io::Result<Option<Vec<u8>>> {
    let mut line = Vec::new();
    loop {
        let avail = reader.fill_buf()?;
        if avail.is_empty() {
            return Ok(if line.is_empty() { None } else { Some(line) });
        }
        let take = avail.len().min(LINE_CAP + 1 - line.len());
        let end = avail[..take].iter().position(|&b| b == b'\n');
        let n = match end {
            Some(i) => i + 1,
            None => take,
        };
        line.extend_from_slice(&avail[..n]);
        reader.consume(n);
        if end.is_some() || line.len() > LINE_CAP {
            return Ok(Some(line));
        }
    }
}

fn handle_client<S>(
    stream: S,
    hub: &Hub,
    snapshot: &(dyn Fn() -> ServerMsg + Send + Sync),
    control: &Sender<Control>,
) where
    S: DuplexConn,
    for<'a> &'a S: Read + Write,
{
    // 1. hello must come first.
    let mut reader = BufReader::new(&stream);
    let hello = match read_line_capped(&mut reader) {
        Ok(Some(l)) if l.len() <= LINE_CAP => l,
        _ => return,
    };
    let Ok(text) = std::str::from_utf8(&hello) else {
        return;
    };
    match decode::<ClientMsg>(text) {
        Ok(ClientMsg::Hello { .. }) => {
            let hello = encode(&ServerMsg::Hello {
                daemon_version: DAEMON_VERSION.to_string(),
                pid: std::process::id(),
            });
            if write_line(&stream, hello.as_bytes()).is_err() {
                return;
            }
        }
        Ok(_) => return, // subscribe/cmd before hello: out of order.
        Err(WireError::Version(_)) => {
            let _ = write_line(
                &stream,
                encode(&ServerMsg::Error {
                    code: "version".into(),
                })
                .as_bytes(),
            );
            return;
        }
        Err(_) => return, // TooLong or Malformed.
    }

    // 2. subscribe must come next; snapshot is queued under the hub lock.
    let sub = match read_line_capped(&mut reader) {
        Ok(Some(l)) if l.len() <= LINE_CAP => l,
        _ => return,
    };
    let Ok(text) = std::str::from_utf8(&sub) else {
        return;
    };
    match decode::<ClientMsg>(text) {
        Ok(ClientMsg::Subscribe) => {}
        Err(WireError::Version(_)) => {
            let _ = write_line(
                &stream,
                encode(&ServerMsg::Error {
                    code: "version".into(),
                })
                .as_bytes(),
            );
            return;
        }
        _ => return,
    }

    // 3. Writer + reader share the stream by reference: the transport is
    // Sync so the writer can drain the hub queue while this thread reads
    // cmds, and both transports support concurrent reads and writes on one
    // connection. The scope joins the writer before the stream is dropped,
    // so the connection outlives both threads.
    thread::scope(|s| {
        let (close_tx, close_rx) = mpsc::channel::<()>();
        // Registration + snapshot enqueue are atomic under one hub-lock
        // hold (see `Hub::add`): no broadcast can slip a delta ahead of
        // the snapshot.
        let (client_id, queue) = hub.add(close_tx, snapshot);

        let ws = &stream;
        let writer = s.spawn(move || {
            loop {
                // Slow/full client dropped by the hub: force-disconnect so
                // the client observes EOF even though the reader may sit
                // blocked on a read.
                if close_rx.try_recv().is_ok() {
                    ws.hang_up();
                    break;
                }
                match queue.recv_timeout(std::time::Duration::from_millis(10)) {
                    Ok(line) => {
                        if write_line(ws, line.as_bytes()).is_err() {
                            break;
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => continue,
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
        });

        // 4. Reader loop (this thread): cmds until EOF/error/disconnect.
        loop {
            let line = match read_line_capped(&mut reader) {
                Ok(Some(l)) if l.len() <= LINE_CAP => l,
                _ => break,
            };
            let Ok(text) = std::str::from_utf8(&line) else {
                break;
            };
            match decode::<ClientMsg>(text) {
                Ok(ClientMsg::Cmd {
                    name: CmdName::Show,
                    id,
                }) => {
                    // Broadcast first so every desk sees it, then ack the
                    // sender through its own queue. The queue is not the
                    // only writer: the stop ack and the sender's quit below
                    // go out on this thread, so quit precedes the ack.
                    hub.broadcast(&ServerMsg::Show);
                    if !hub.send_to(
                        client_id,
                        &ServerMsg::Ack {
                            id,
                            ok: true,
                            error: None,
                        },
                    ) {
                        break;
                    }
                }
                Ok(ClientMsg::Set { id, name, value }) => {
                    if !relay(control, hub, client_id, id, |reply| Control::Set {
                        id,
                        name,
                        value,
                        reply,
                    }) {
                        break;
                    }
                }
                Ok(ClientMsg::Timeline { id, key }) => {
                    if !relay(control, hub, client_id, id, |reply| Control::Timeline {
                        id,
                        key,
                        reply,
                    }) {
                        break;
                    }
                }
                Ok(ClientMsg::Setup { id, action }) => {
                    if !relay(control, hub, client_id, id, |reply| Control::Setup {
                        id,
                        action,
                        reply,
                    }) {
                        break;
                    }
                }
                Ok(ClientMsg::RepoDecision { id, root, allow }) => {
                    if !relay(control, hub, client_id, id, |reply| Control::RepoDecision {
                        id,
                        root,
                        allow,
                        reply,
                    }) {
                        break;
                    }
                }
                Ok(ClientMsg::Cards {
                    id,
                    query,
                    before,
                    limit,
                }) => {
                    if !relay(control, hub, client_id, id, |reply| Control::Cards {
                        id,
                        query,
                        before,
                        limit,
                        reply,
                    }) {
                        break;
                    }
                }
                Ok(ClientMsg::CardDetail { id, card_id }) => {
                    if !relay(control, hub, client_id, id, |reply| Control::CardDetail {
                        id,
                        card_id,
                        reply,
                    }) {
                        break;
                    }
                }
                Ok(ClientMsg::BlockDiff {
                    id,
                    card_id,
                    seq,
                    page,
                }) => {
                    if !relay(control, hub, client_id, id, |reply| Control::BlockDiff {
                        id,
                        card_id,
                        seq,
                        page,
                        reply,
                    }) {
                        break;
                    }
                }
                Ok(ClientMsg::Cmd { name, id })
                    if matches!(name, CmdName::Stop | CmdName::Quit) =>
                {
                    // Quit reaches every desk, the sender included, before
                    // the ack. The sender's own line is written on this
                    // thread so the ack can never overtake it on its pipe.
                    // A broken sender pipe must not cancel the stop.
                    let quit = name == CmdName::Quit;
                    if quit {
                        hub.broadcast_except(client_id, &ServerMsg::Quit);
                        let _ = write_line(&stream, encode(&ServerMsg::Quit).as_bytes());
                    }
                    let (reply_tx, reply_rx) = mpsc::sync_channel(1);
                    let (flushed_tx, flushed_rx) = mpsc::channel();
                    if control
                        .send(Control::Stop {
                            id,
                            reply: reply_tx,
                            flushed: flushed_rx,
                            quit,
                        })
                        .is_err()
                    {
                        let ack = encode(&ServerMsg::Ack {
                            id,
                            ok: false,
                            error: Some("daemon stopping".into()),
                        });
                        if write_line(&stream, ack.as_bytes()).is_err() {
                            break;
                        }
                        continue;
                    }
                    match reply_rx.recv() {
                        Ok(ack) => {
                            let _ = write_line(&stream, encode(&ack).as_bytes());
                            let _ = flushed_tx.send(());
                            break;
                        }
                        Err(_) => {
                            let ack = encode(&ServerMsg::Ack {
                                id,
                                ok: false,
                                error: Some("daemon stopping".into()),
                            });
                            if write_line(&stream, ack.as_bytes()).is_err() {
                                break;
                            }
                        }
                    }
                }
                Err(WireError::Version(_)) => {
                    let _ = write_line(
                        &stream,
                        encode(&ServerMsg::Error {
                            code: "version".into(),
                        })
                        .as_bytes(),
                    );
                    break;
                }
                _ => break, // Malformed, TooLong, or hello/subscribe out of order.
            }
        }

        hub.remove(client_id);
        writer.join().unwrap();
    });
}

/// The reply used when the daemon control loop is gone.
fn daemon_stopping(id: u64) -> ServerMsg {
    ServerMsg::Ack {
        id,
        ok: false,
        error: Some("daemon stopping".into()),
    }
}

/// Hands one request to the daemon loop, then writes the loop's reply to this
/// client. Returns false when the client has gone.
fn relay(
    control: &Sender<Control>,
    hub: &Hub,
    client_id: u64,
    id: u64,
    request: impl FnOnce(SyncSender<ServerMsg>) -> Control,
) -> bool {
    let (reply_tx, reply_rx) = mpsc::sync_channel(1);
    if control.send(request(reply_tx)).is_err() {
        return hub.send_to(client_id, &daemon_stopping(id));
    }
    let replied = reply_rx.recv().unwrap_or_else(|_| daemon_stopping(id));
    hub.send_to(client_id, &replied)
}

fn write_line<S>(stream: &S, buf: &[u8]) -> io::Result<()>
where
    for<'a> &'a S: Write,
{
    let mut s = stream;
    s.write_all(buf)?;
    s.flush()
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::os::windows::io::AsRawHandle;

    use interprocess::os::windows::named_pipe::pipe_mode::Bytes;
    use interprocess::os::windows::named_pipe::{DuplexPipeStream, PipeListenerOptions};
    use interprocess::os::windows::security_descriptor::SecurityDescriptor;
    use rocky_proto::paths::pipe_name;
    use widestring::U16CString;

    pub fn serve(
        rocky_home: &Path,
        hub: Arc<Hub>,
        snapshot: Arc<dyn Fn() -> ServerMsg + Send + Sync>,
        control: Sender<Control>,
    ) -> Result<JoinHandle<()>, BindError> {
        let name = pipe_name(rocky_home);
        let sd = user_only_sd()?;
        // interprocess sets FILE_FLAG_FIRST_PIPE_INSTANCE on this first
        // instance, so a second listener on the same name fails.
        let listener = PipeListenerOptions::new()
            .path(name.as_str())
            .security_descriptor(Some(sd))
            .create_duplex::<Bytes>()
            .map_err(|e| match e.raw_os_error() {
                // ERROR_ACCESS_DENIED (name taken) or ERROR_PIPE_BUSY:
                // another instance owns the pipe.
                Some(5) | Some(231) => BindError::Taken,
                _ => BindError::Io(e),
            })?;
        let listener = Arc::new(listener);
        Ok(thread::spawn(move || {
            loop {
                match listener.accept() {
                    Ok(stream) => {
                        let hub = Arc::clone(&hub);
                        let snapshot = Arc::clone(&snapshot);
                        let control = control.clone();
                        thread::spawn(move || handle_client(stream, &hub, &*snapshot, &control));
                    }
                    // Accept only fails if the listener broke; back off briefly
                    // rather than busy-spinning, then keep serving.
                    Err(_) => thread::sleep(std::time::Duration::from_millis(50)),
                }
            }
        }))
    }

    /// `D:P(A;;GA;;;SID)` for the current process user: only this user can
    /// connect. `P` (protected) keeps inherited ACEs out.
    fn user_only_sd() -> Result<SecurityDescriptor, BindError> {
        use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, LocalFree};
        use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
        use windows_sys::Win32::Security::{
            GetTokenInformation, TOKEN_QUERY, TOKEN_USER, TokenUser,
        };
        use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

        unsafe {
            let mut token: HANDLE = std::ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                return Err(BindError::Io(io::Error::last_os_error()));
            }
            let mut len = 0u32;
            // Probe the size first; the ERROR_INSUFFICIENT_BUFFER failure is expected.
            let _ = GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut len);
            let mut buf = vec![0u8; len as usize];
            let ok = GetTokenInformation(token, TokenUser, buf.as_mut_ptr().cast(), len, &mut len);
            CloseHandle(token);
            if ok == 0 {
                return Err(BindError::Io(io::Error::last_os_error()));
            }
            // NB: `buf` is byte-aligned; copy the Sid pointer out without
            // forming a (possibly misaligned) `&TOKEN_USER`.
            let user_ptr = buf.as_ptr().cast::<TOKEN_USER>();
            let sid = std::ptr::addr_of!((*user_ptr).User.Sid).read_unaligned();
            let mut sid_str: *mut u16 = std::ptr::null_mut();
            if ConvertSidToStringSidW(sid, &mut sid_str) == 0 {
                return Err(BindError::Io(io::Error::last_os_error()));
            }
            let mut end = 0;
            while *sid_str.add(end) != 0 {
                end += 1;
            }
            let sid = String::from_utf16_lossy(std::slice::from_raw_parts(sid_str, end));
            LocalFree(sid_str.cast());
            let sddl = U16CString::from_str(format!("D:P(A;;GA;;;{sid})"))
                .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "bad sid"))?;
            SecurityDescriptor::deserialize(sddl.as_ucstr()).map_err(BindError::Io)
        }
    }

    /// `DisconnectNamedPipe` breaks the connection on this instance, failing
    /// the reader's blocked `ReadFileEx` and making the client's next read
    /// return EOF. Safe to call while the reader thread is blocked; the handle
    /// itself closes later when the stream drops after the scope joins both
    /// threads.
    impl DuplexConn for DuplexPipeStream<Bytes> {
        fn hang_up(&self) {
            use windows_sys::Win32::System::Pipes::DisconnectNamedPipe;
            unsafe {
                DisconnectNamedPipe(self.as_raw_handle());
            }
        }
    }
}

#[cfg(unix)]
mod imp {
    use super::*;
    use std::fs::OpenOptions;
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::time::Duration;

    use rocky_proto::paths::{daemon_lock_path, desk_dir, runtime_dir_from, socket_path};
    use rocky_proto::peer::{peer_uid, same_user};

    pub fn serve(
        rocky_home: &Path,
        hub: Arc<Hub>,
        snapshot: Arc<dyn Fn() -> ServerMsg + Send + Sync>,
        control: Sender<Control>,
    ) -> Result<JoinHandle<()>, BindError> {
        // 1. The desk dir holds the socket unless XDG_RUNTIME_DIR wins; only
        // this user may list or enter it either way.
        let desk = desk_dir(rocky_home);
        std::fs::create_dir_all(&desk)?;
        std::fs::set_permissions(&desk, std::fs::Permissions::from_mode(0o700))?;

        // 2. Refuse an oversized socket path before creating or unlinking
        // anything. Only the socket has the 107-byte `sun_path` limit; the
        // lock is a regular file, so a longer lock path is fine.
        let sock = socket_path(rocky_home);
        if !super::socket_path_fits(&sock) {
            return Err(BindError::PathTooLong);
        }

        // 3. The runtime dir (XDG_RUNTIME_DIR, else the desk dir) holds the
        // socket and the lock.
        let runtime = runtime_dir_from(rocky_home, std::env::var_os("XDG_RUNTIME_DIR").as_deref());
        std::fs::create_dir_all(&runtime)?;

        // 4. The lock is owner-only and non-blocking: a second daemon fails
        // here instead of waiting.
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(daemon_lock_path(rocky_home))?;
        // SAFETY: `lock` owns a live file descriptor; flock only touches that
        // descriptor and the process lock table.
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            let err = io::Error::last_os_error();
            return Err(if err.raw_os_error() == Some(libc::EWOULDBLOCK) {
                BindError::Taken
            } else {
                BindError::Io(err)
            });
        }

        // 5. A daemon killed with -9 leaves its socket file behind; the
        // kernel already freed its lock, so unlink the stale path and rebind.
        match std::fs::remove_file(&sock) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }

        // 6. Bind under a restrictive umask so the socket is born 0600; the
        // previous umask is restored before any error return.
        // SAFETY: umask has no preconditions; it is process-wide, and the
        // window between set and restore contains only the bind call.
        let previous = unsafe { libc::umask(0o177) };
        let bound = UnixListener::bind(&sock);
        // SAFETY: as above.
        unsafe { libc::umask(previous) };
        let listener = bound?;

        // 7. Accept: unknown or foreign uids are dropped without a reply.
        Ok(thread::spawn(move || {
            // Held for the process lifetime: the kernel frees the lock when
            // the daemon dies.
            let _lock = lock;
            loop {
                match listener.accept() {
                    Ok((stream, _)) => {
                        if !same_user(peer_uid(&stream)) {
                            continue;
                        }
                        let hub = Arc::clone(&hub);
                        let snapshot = Arc::clone(&snapshot);
                        let control = control.clone();
                        thread::spawn(move || handle_client(stream, &hub, &*snapshot, &control));
                    }
                    // Accept only fails if the listener broke; back off briefly
                    // rather than busy-spinning, then keep serving.
                    Err(_) => thread::sleep(Duration::from_millis(50)),
                }
            }
        }))
    }

    impl DuplexConn for UnixStream {
        /// `shutdown(2)` both ways: the reader observes EOF and the writer
        /// fails, even while either is blocked.
        fn hang_up(&self) {
            let _ = self.shutdown(std::net::Shutdown::Both);
        }
    }
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use std::path::Path;

    #[cfg(unix)]
    use super::socket_path_fits;

    #[cfg(unix)]
    #[test]
    fn socket_path_limit_is_107_bytes() {
        assert!(socket_path_fits(Path::new(&"a".repeat(107))));
        assert!(!socket_path_fits(Path::new(&"a".repeat(108))));
    }
}
