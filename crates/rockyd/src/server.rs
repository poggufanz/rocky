//! Desk client pipe server (protocol v1): single-instance user-only named pipe,
//! per-client threads, and a non-blocking broadcast hub.

use std::collections::HashMap;
use std::io;
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, SyncSender};
use std::thread::{self, JoinHandle};

use rocky_proto::pipe::{CLIENT_QUEUE_CAP, ServerMsg, encode};

pub const DAEMON_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug)]
pub enum BindError {
    Taken,
    Io(io::Error),
}

impl From<io::Error> for BindError {
    fn from(e: io::Error) -> Self {
        BindError::Io(e)
    }
}

#[derive(Debug)]
pub enum Control {
    Stop {
        id: u64,
        reply: SyncSender<ServerMsg>,
        /// Signalled by the client thread after the ack line is flushed, so
        /// the daemon can exit without racing the client writer thread.
        flushed: Receiver<()>,
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
        let line = encode(msg);
        let mut clients = self.clients.lock().unwrap();
        let ids: Vec<u64> = clients.keys().copied().collect();
        for id in ids {
            let drop = match clients.get_mut(&id) {
                Some(c) => c.tx.try_send(line.clone()).is_err(),
                None => false,
            };
            if drop {
                Self::remove_locked(&mut clients, id);
            }
        }
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

#[cfg(windows)]
mod imp {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::os::windows::io::AsRawHandle;

    use interprocess::os::windows::named_pipe::pipe_mode::Bytes;
    use interprocess::os::windows::named_pipe::{DuplexPipeStream, PipeListenerOptions};
    use interprocess::os::windows::security_descriptor::SecurityDescriptor;
    use rocky_proto::paths::pipe_name;
    use rocky_proto::pipe::{ClientMsg, CmdName, LINE_CAP, WireError, decode};
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

    fn handle_client(
        stream: DuplexPipeStream<Bytes>,
        hub: &Hub,
        snapshot: &(dyn Fn() -> ServerMsg + Send + Sync),
        control: &Sender<Control>,
    ) {
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

        // 3. Writer + reader share the stream by reference (interprocess
        // streams are Sync for exactly this): the writer drains the hub queue,
        // this thread reads cmds. Concurrent ReadFile/WriteFile on one pipe
        // handle is supported by Windows. The scope joins the writer before
        // the stream is dropped, so the handle outlives both threads.
        thread::scope(|s| {
            let (close_tx, close_rx) = mpsc::channel::<()>();
            // Registration + snapshot enqueue are atomic under one hub-lock
            // hold (see `Hub::add`): no broadcast can slip a delta ahead of
            // the snapshot.
            let (id, queue) = hub.add(close_tx, snapshot);

            let ws = &stream;
            let writer = s.spawn(move || {
                loop {
                    // Slow/full client dropped by the hub: force-disconnect so
                    // the client observes EOF even though the reader may sit
                    // blocked in ReadFileEx.
                    if close_rx.try_recv().is_ok() {
                        disconnect(ws);
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
                        name: CmdName::Stop,
                        id,
                    }) => {
                        let (reply_tx, reply_rx) = mpsc::sync_channel(1);
                        let (flushed_tx, flushed_rx) = mpsc::channel();
                        if control
                            .send(Control::Stop {
                                id,
                                reply: reply_tx,
                                flushed: flushed_rx,
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

            hub.remove(id);
            writer.join().unwrap();
        });
    }

    fn write_line(stream: &DuplexPipeStream<Bytes>, buf: &[u8]) -> io::Result<()> {
        let mut s = stream;
        s.write_all(buf)?;
        s.flush()
    }

    /// Force the client to observe EOF: `DisconnectNamedPipe` breaks the
    /// connection on this instance, failing the reader's blocked `ReadFileEx`
    /// and making the client's next read return EOF. Safe to call while the
    /// reader thread is blocked; the handle itself closes later when the
    /// stream drops after the scope joins both threads.
    fn disconnect(stream: &DuplexPipeStream<Bytes>) {
        use windows_sys::Win32::System::Pipes::DisconnectNamedPipe;
        unsafe {
            DisconnectNamedPipe(stream.as_raw_handle());
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;

    pub fn serve(
        _rocky_home: &Path,
        _hub: Arc<Hub>,
        _snapshot: Arc<dyn Fn() -> ServerMsg + Send + Sync>,
        _control: Sender<Control>,
    ) -> Result<JoinHandle<()>, BindError> {
        Err(BindError::Io(io::Error::new(
            io::ErrorKind::Unsupported,
            "named pipe server is Windows-only",
        )))
    }
}
