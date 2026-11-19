//! Short-lived Node children for quote translation (`translate run` and `translate install`).
//!
//! Each job spawns Node directly (no shell, `CREATE_NO_WINDOW` on Windows, stderr discarded) and
//! hands stdin/stdout to helper threads while one supervisor thread owns the `Child`, enforces the
//! job deadline, and kills/reaps on timeout or `Drop`.

use std::collections::HashSet;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use rocky_proto::pipe::LINE_CAP;
use rocky_proto::translate::{QuoteLang, TranslateFailure, TranslatePair};
use serde::{Deserialize, Serialize};

use crate::guard::records::CliRecord;

pub const RUN_TIMEOUT: Duration = Duration::from_secs(60);
pub const INSTALL_TIMEOUT: Duration = Duration::from_secs(600);
pub const MAX_RUN_QUOTES: usize = 64;

const WIRE_VERSION: u32 = 1;
const EXIT_POLL_INTERVAL: Duration = Duration::from_millis(15);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunRequest {
    pub key: String,
    pub to: QuoteLang,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunReply {
    Translated {
        key: String,
        from: QuoteLang,
        text: String,
    },
    Original {
        key: String,
    },
    Failed {
        key: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunEvent {
    Reply(RunReply),
    Done,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstallEvent {
    Progress { done_bytes: u64, total_bytes: u64 },
    Finished(Result<(), TranslateFailure>),
}

/// A running `rocky translate run` child. Dropping it kills and reaps the process.
#[derive(Debug)]
pub struct RunJob {
    inner: JobHandle<RunEvent, RunReply>,
}

impl RunJob {
    pub fn try_next(&mut self) -> Option<RunEvent> {
        self.inner.try_next()
    }
}

/// A running `rocky translate install` child. Dropping it kills and reaps the process.
#[derive(Debug)]
pub struct InstallJob {
    inner: JobHandle<InstallEvent, InstallLine>,
}

impl InstallJob {
    pub fn try_next(&mut self) -> Option<InstallEvent> {
        self.inner.try_next()
    }
}

pub fn start_run(
    cli: &CliRecord,
    home: &Path,
    requests: &[RunRequest],
    timeout: Duration,
) -> io::Result<RunJob> {
    if requests.len() > MAX_RUN_QUOTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "too many translate requests",
        ));
    }

    let mut request_lines = Vec::with_capacity(requests.len());
    let mut requested_keys = HashSet::with_capacity(requests.len());
    for req in requests {
        let mut line = serde_json::to_string(&WireRunRequest {
            v: WIRE_VERSION,
            key: &req.key,
            to: req.to,
            text: &req.text,
        })
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?;
        line.push('\n');
        request_lines.push(line);
        requested_keys.insert(req.key.clone());
    }

    let mut child = ChildGuard::new(spawn_node_child(cli, home, &["translate", "run"], true)?);
    let (Some(stdin), Some(stdout)) = (child.take_stdin(), child.take_stdout()) else {
        return Err(io::Error::other("translate run pipes were not set up"));
    };

    let (msg_tx, msg_rx) = mpsc::channel();
    let reader_tx = msg_tx.clone();
    // Neither pipe helper thread is joined: after kill, a grandchild holding a pipe open would
    // block a join. Each ends on its own when the pipe closes or the receiver drops.
    spawn_thread("translate-run-reader", move || {
        read_lines(stdout, &reader_tx, parse_run_line);
    })?;
    spawn_thread("translate-run-writer", move || {
        write_requests(stdin, request_lines);
    })?;

    let (events_tx, events_rx) = mpsc::channel();
    let cancelled = Arc::new(AtomicBool::new(false));
    let cancelled_flag = Arc::clone(&cancelled);
    let supervisor = spawn_supervisor("translate-run-supervisor", move || {
        supervise(
            child,
            msg_rx,
            events_tx,
            &cancelled_flag,
            timeout,
            requested_keys,
            |keys, reply, out| {
                if keys.contains(reply.key()) {
                    let _ = out.send(RunEvent::Reply(reply));
                }
            },
            |_keys, _timed_out| RunEvent::Done,
        );
    })?;

    Ok(RunJob {
        inner: JobHandle {
            events: events_rx,
            cancelled,
            cancel: Some(msg_tx),
            supervisor: Some(supervisor),
        },
    })
}

pub fn start_install(
    cli: &CliRecord,
    home: &Path,
    pair: TranslatePair,
    timeout: Duration,
) -> io::Result<InstallJob> {
    let mut child = ChildGuard::new(spawn_node_child(
        cli,
        home,
        &["translate", "install", "--pair", pair.as_str()],
        false,
    )?);
    let Some(stdout) = child.take_stdout() else {
        return Err(io::Error::other("translate install stdout was not set up"));
    };

    let (msg_tx, msg_rx) = mpsc::channel();
    let reader_tx = msg_tx.clone();
    spawn_thread("translate-install-reader", move || {
        read_lines(stdout, &reader_tx, parse_install_line);
    })?;

    let (events_tx, events_rx) = mpsc::channel();
    let cancelled = Arc::new(AtomicBool::new(false));
    let cancelled_flag = Arc::clone(&cancelled);
    let supervisor = spawn_supervisor("translate-install-supervisor", move || {
        supervise(
            child,
            msg_rx,
            events_tx,
            &cancelled_flag,
            timeout,
            None,
            |outcome, line, out| match line {
                InstallLine::Progress {
                    done_bytes,
                    total_bytes,
                } => {
                    let _ = out.send(InstallEvent::Progress {
                        done_bytes,
                        total_bytes,
                    });
                }
                InstallLine::Result(result) => {
                    *outcome = Some(result);
                }
            },
            |outcome, timed_out| {
                let result = if timed_out {
                    Err(TranslateFailure::Download)
                } else {
                    outcome.unwrap_or(Err(TranslateFailure::Engine))
                };
                InstallEvent::Finished(result)
            },
        );
    })?;

    Ok(InstallJob {
        inner: JobHandle {
            events: events_rx,
            cancelled,
            cancel: Some(msg_tx),
            supervisor: Some(supervisor),
        },
    })
}

impl RunReply {
    fn key(&self) -> &str {
        match self {
            Self::Translated { key, .. } | Self::Original { key } | Self::Failed { key } => key,
        }
    }
}

#[derive(Debug)]
struct JobHandle<E, L> {
    events: Receiver<E>,
    cancelled: Arc<AtomicBool>,
    cancel: Option<Sender<SupervisorMsg<L>>>,
    supervisor: Option<JoinHandle<()>>,
}

impl<E, L> JobHandle<E, L> {
    fn try_next(&mut self) -> Option<E> {
        self.events.try_recv().ok()
    }
}

impl<E, L> Drop for JobHandle<E, L> {
    fn drop(&mut self) {
        self.cancelled.store(true, Ordering::Release);
        if let Some(cancel) = self.cancel.take() {
            let _ = cancel.send(SupervisorMsg::Cancel);
        }
        if let Some(supervisor) = self.supervisor.take() {
            let _ = supervisor.join();
        }
    }
}

enum SupervisorMsg<L> {
    Line(L),
    StdoutClosed,
    Cancel,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum InstallLine {
    Progress { done_bytes: u64, total_bytes: u64 },
    Result(Result<(), TranslateFailure>),
}

#[derive(Serialize)]
struct WireRunRequest<'a> {
    v: u32,
    key: &'a str,
    to: QuoteLang,
    text: &'a str,
}

#[derive(Deserialize)]
struct WireRunReply {
    v: u32,
    key: String,
    ok: bool,
    #[serde(default)]
    from: Option<QuoteLang>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    reason: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum WireInstallLine {
    Progress {
        v: u32,
        done_bytes: u64,
        total_bytes: u64,
    },
    Result {
        v: u32,
        ok: bool,
        #[serde(default)]
        reason: Option<String>,
    },
}

fn parse_run_line(line: &str) -> Option<RunReply> {
    let wire: WireRunReply = serde_json::from_str(line).ok()?;
    if wire.v != WIRE_VERSION {
        return None;
    }
    if wire.ok {
        let (Some(from), Some(text)) = (wire.from, wire.text) else {
            return None;
        };
        return Some(RunReply::Translated {
            key: wire.key,
            from,
            text,
        });
    }
    match wire.reason.as_deref() {
        Some("same-language" | "no-prose") => Some(RunReply::Original { key: wire.key }),
        _ => Some(RunReply::Failed { key: wire.key }),
    }
}

fn parse_install_line(line: &str) -> Option<InstallLine> {
    match serde_json::from_str::<WireInstallLine>(line).ok()? {
        WireInstallLine::Progress {
            v: WIRE_VERSION,
            done_bytes,
            total_bytes,
        } => Some(InstallLine::Progress {
            done_bytes,
            total_bytes,
        }),
        WireInstallLine::Result {
            v: WIRE_VERSION,
            ok: true,
            ..
        } => Some(InstallLine::Result(Ok(()))),
        WireInstallLine::Result {
            v: WIRE_VERSION,
            ok: false,
            reason,
        } => Some(InstallLine::Result(Err(map_install_reason(
            reason.as_deref(),
        )))),
        _ => None,
    }
}

fn map_install_reason(reason: Option<&str>) -> TranslateFailure {
    match reason {
        Some("download") => TranslateFailure::Download,
        Some("checksum") => TranslateFailure::Checksum,
        Some("write") => TranslateFailure::Write,
        _ => TranslateFailure::Engine,
    }
}

fn spawn_node_child(
    cli: &CliRecord,
    home: &Path,
    args: &[&str],
    pipe_stdin: bool,
) -> io::Result<Child> {
    let mut command = Command::new(&cli.node);
    command
        .arg(&cli.entry)
        .args(args)
        .env("ROCKY_HOME", home)
        .stdin(if pipe_stdin {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
    command.spawn()
}

fn spawn_thread(name: &str, work: impl FnOnce() + Send + 'static) -> io::Result<()> {
    thread::Builder::new()
        .name(name.to_string())
        .spawn(work)
        .map(drop)
}

fn spawn_supervisor(
    name: &str,
    work: impl FnOnce() + Send + 'static,
) -> io::Result<JoinHandle<()>> {
    thread::Builder::new().name(name.to_string()).spawn(work)
}

enum ChildExit {
    Running,
    Exited,
    Error,
}

struct ChildGuard {
    child: Child,
    reaped: bool,
}

impl ChildGuard {
    fn new(child: Child) -> Self {
        Self {
            child,
            reaped: false,
        }
    }

    fn take_stdin(&mut self) -> Option<ChildStdin> {
        self.child.stdin.take()
    }

    fn take_stdout(&mut self) -> Option<std::process::ChildStdout> {
        self.child.stdout.take()
    }

    fn try_reap(&mut self) -> ChildExit {
        if self.reaped {
            return ChildExit::Exited;
        }
        match self.child.try_wait() {
            Ok(Some(_)) => {
                self.reaped = true;
                ChildExit::Exited
            }
            Ok(None) => ChildExit::Running,
            Err(_) => ChildExit::Error,
        }
    }

    fn kill_and_reap(&mut self) {
        if !self.reaped {
            kill_and_reap(&mut self.child);
            self.reaped = true;
        }
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        self.kill_and_reap();
    }
}

/// Safe to repeat: killing or waiting on a process that is already gone changes nothing.
fn kill_and_reap(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

#[allow(clippy::too_many_arguments)]
fn supervise<L, S, E>(
    mut child: ChildGuard,
    rx: Receiver<SupervisorMsg<L>>,
    events_tx: Sender<E>,
    cancelled: &AtomicBool,
    timeout: Duration,
    mut state: S,
    mut on_line: impl FnMut(&mut S, L, &Sender<E>),
    on_finish: impl FnOnce(S, bool) -> E,
) {
    let deadline = Instant::now() + timeout;
    let mut stdout_closed = false;

    loop {
        if cancelled.load(Ordering::Acquire) {
            child.kill_and_reap();
            return;
        }

        if stdout_closed {
            match child.try_reap() {
                ChildExit::Exited => {
                    let _ = events_tx.send(on_finish(state, false));
                    return;
                }
                ChildExit::Error => {
                    child.kill_and_reap();
                    let _ = events_tx.send(on_finish(state, false));
                    return;
                }
                ChildExit::Running => {}
            }
        }

        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            child.kill_and_reap();
            let _ = events_tx.send(on_finish(state, true));
            return;
        };

        let wait_for = if stdout_closed {
            remaining.min(EXIT_POLL_INTERVAL)
        } else {
            remaining
        };

        match rx.recv_timeout(wait_for) {
            Ok(SupervisorMsg::Line(line)) => {
                on_line(&mut state, line, &events_tx);
            }
            Ok(SupervisorMsg::StdoutClosed) => {
                stdout_closed = true;
            }
            Ok(SupervisorMsg::Cancel) | Err(RecvTimeoutError::Disconnected) => {
                child.kill_and_reap();
                return;
            }
            Err(RecvTimeoutError::Timeout) => {}
        }
    }
}

fn write_requests(mut stdin: ChildStdin, lines: Vec<String>) {
    for line in lines {
        if stdin
            .write_all(line.as_bytes())
            .and_then(|()| stdin.flush())
            .is_err()
        {
            return;
        }
    }
}

/// Splits `stdout` on `\n`, drops oversized/invalid lines, sends parsed lines, and notifies the
/// supervisor when stdout closes.
fn read_lines<L>(
    stdout: impl Read,
    sender: &Sender<SupervisorMsg<L>>,
    parse: fn(&str) -> Option<L>,
) {
    let mut reader = BufReader::new(stdout);
    let mut pending = LineBuffer::default();
    loop {
        let chunk = match reader.fill_buf() {
            Ok([]) => {
                let _ = sender.send(SupervisorMsg::StdoutClosed);
                return;
            }
            Ok(chunk) => chunk,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => {
                let _ = sender.send(SupervisorMsg::StdoutClosed);
                return;
            }
        };
        let used = match chunk.iter().position(|byte| *byte == b'\n') {
            Some(end) => {
                pending.extend(&chunk[..end]);
                if let Some(line) = pending.finish(parse)
                    && sender.send(SupervisorMsg::Line(line)).is_err()
                {
                    return;
                }
                end + 1
            }
            None => {
                pending.extend(chunk);
                chunk.len()
            }
        };
        reader.consume(used);
    }
}

/// One line being assembled. A line over [`LINE_CAP`] is dropped without being kept in memory.
#[derive(Default)]
struct LineBuffer {
    bytes: Vec<u8>,
    overflowed: bool,
}

impl LineBuffer {
    fn extend(&mut self, part: &[u8]) {
        if self.overflowed {
            return;
        }
        self.bytes.extend_from_slice(part);
        if self.bytes.len() > LINE_CAP {
            self.overflowed = true;
            self.bytes = Vec::new();
        }
    }

    fn finish<L>(&mut self, parse: fn(&str) -> Option<L>) -> Option<L> {
        let overflowed = std::mem::take(&mut self.overflowed);
        let bytes = std::mem::take(&mut self.bytes);
        if overflowed {
            return None;
        }
        parse(std::str::from_utf8(&bytes).ok()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EMPTY_REPLY_LEN: usize = r#"{"v":1,"key":"k","ok":true,"from":"id","text":""}"#.len();

    fn reply_line(len: usize) -> String {
        let text = "a".repeat(len - EMPTY_REPLY_LEN);
        format!(r#"{{"v":1,"key":"k","ok":true,"from":"id","text":"{text}"}}"#)
    }

    fn finish_run(buffer: &mut LineBuffer, line: &str) -> Option<RunReply> {
        buffer.extend(line.as_bytes());
        buffer.finish(parse_run_line)
    }

    #[test]
    fn line_at_the_cap_is_kept() {
        let mut buffer = LineBuffer::default();
        assert!(finish_run(&mut buffer, &reply_line(LINE_CAP)).is_some());
    }

    #[test]
    fn line_one_byte_over_the_cap_is_dropped() {
        let mut buffer = LineBuffer::default();
        assert_eq!(finish_run(&mut buffer, &reply_line(LINE_CAP + 1)), None);
    }

    #[test]
    fn dropping_oversized_line_does_not_taint_next() {
        let mut buffer = LineBuffer::default();
        assert_eq!(finish_run(&mut buffer, &reply_line(LINE_CAP + 1)), None);
        assert!(finish_run(&mut buffer, &reply_line(EMPTY_REPLY_LEN + 2)).is_some());
    }

    #[test]
    fn oversized_line_is_not_held_in_memory() {
        let mut buffer = LineBuffer::default();
        buffer.extend(&vec![b'x'; LINE_CAP + 1]);
        buffer.extend(&vec![b'x'; LINE_CAP]);
        assert!(buffer.bytes.is_empty());
    }

    #[test]
    fn parse_run_line_maps_all_variants() {
        assert_eq!(
            parse_run_line(r#"{"v":1,"key":"a","ok":true,"from":"id","text":"hi"}"#),
            Some(RunReply::Translated {
                key: "a".to_string(),
                from: QuoteLang::Id,
                text: "hi".to_string(),
            })
        );
        assert_eq!(
            parse_run_line(r#"{"v":1,"key":"a","ok":false,"reason":"same-language"}"#),
            Some(RunReply::Original {
                key: "a".to_string(),
            })
        );
        assert_eq!(
            parse_run_line(r#"{"v":1,"key":"a","ok":false,"reason":"no-prose"}"#),
            Some(RunReply::Original {
                key: "a".to_string(),
            })
        );
        assert_eq!(
            parse_run_line(r#"{"v":1,"key":"a","ok":false,"reason":"engine"}"#),
            Some(RunReply::Failed {
                key: "a".to_string(),
            })
        );
        assert_eq!(
            parse_run_line(r#"{"v":1,"key":"a","ok":false}"#),
            Some(RunReply::Failed {
                key: "a".to_string(),
            })
        );
        assert_eq!(
            parse_run_line(r#"{"v":2,"key":"a","ok":true,"from":"id","text":"hi"}"#),
            None
        );
        assert_eq!(
            parse_run_line(r#"{"v":1,"key":"a","ok":true,"from":"id"}"#),
            None
        );
        assert_eq!(parse_run_line("not json"), None);
    }

    #[test]
    fn parse_install_line_maps_progress_and_results() {
        assert_eq!(
            parse_install_line(r#"{"v":1,"kind":"progress","done_bytes":10,"total_bytes":20}"#),
            Some(InstallLine::Progress {
                done_bytes: 10,
                total_bytes: 20,
            })
        );
        assert_eq!(
            parse_install_line(r#"{"v":1,"kind":"result","ok":true}"#),
            Some(InstallLine::Result(Ok(())))
        );
        assert_eq!(
            parse_install_line(r#"{"v":1,"kind":"result","ok":false,"reason":"download"}"#),
            Some(InstallLine::Result(Err(TranslateFailure::Download)))
        );
        assert_eq!(
            parse_install_line(r#"{"v":1,"kind":"result","ok":false,"reason":"checksum"}"#),
            Some(InstallLine::Result(Err(TranslateFailure::Checksum)))
        );
        assert_eq!(
            parse_install_line(r#"{"v":1,"kind":"result","ok":false,"reason":"write"}"#),
            Some(InstallLine::Result(Err(TranslateFailure::Write)))
        );
        assert_eq!(
            parse_install_line(r#"{"v":1,"kind":"result","ok":false,"reason":"other"}"#),
            Some(InstallLine::Result(Err(TranslateFailure::Engine)))
        );
        assert_eq!(
            parse_install_line(r#"{"v":2,"kind":"result","ok":true}"#),
            None
        );
        assert_eq!(parse_install_line("garbage"), None);
    }

    #[test]
    fn reader_drops_final_line_without_newline_and_signals_close() {
        let valid = reply_line(EMPTY_REPLY_LEN + 1);
        let input = format!("{valid}\n{valid}");
        let (sender, receiver) = mpsc::channel();

        read_lines(input.as_bytes(), &sender, parse_run_line);

        let msgs: Vec<_> = receiver.try_iter().collect();
        assert_eq!(msgs.len(), 2);
        assert!(matches!(msgs[0], SupervisorMsg::Line(_)));
        assert!(matches!(msgs[1], SupervisorMsg::StdoutClosed));
    }
}
