//! The capture child: one `rocky listen collect --stdio` process the daemon supervises.
//!
//! Node stays the only writer of the Listening store. The daemon starts Node with separate
//! arguments and no shell, hides the console window on Windows, asks it to reconcile roots
//! over stdin, and reads its answers from stdout. Stderr goes nowhere, so Node text never
//! reaches a daemon log.
//!
//! Neither pipe is ever touched on the caller's thread. A reader thread owns stdout and a
//! writer thread owns stdin, so a Node that stalls cannot block the daemon thread that serves
//! the desk pipe and the guard.

use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, Receiver, Sender, SyncSender, TrySendError};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use rocky_proto::pipe::LINE_CAP;
use serde_json::json;

use super::{CaptureLine, parse_line};
use crate::guard::records::CliRecord;

/// How long [`CaptureChild::stop`] waits for the child to leave after its stdin closes.
pub const CHILD_STOP_GRACE: Duration = Duration::from_secs(5);

/// How often [`CaptureChild::stop`] checks whether the child has exited.
const POLL_INTERVAL: Duration = Duration::from_millis(20);

/// Requests that may wait for the writer thread. Past this, [`CaptureChild::send`] fails
/// instead of waiting.
const SEND_QUEUE: usize = 64;

/// A running capture child.
///
/// Dropping it kills and reaps the process, so no path leaves a zombie behind.
#[derive(Debug)]
pub struct CaptureChild {
    child: Child,
    /// Feeds the writer thread, which owns stdin. Taken by [`CaptureChild::stop`]: with the
    /// sender gone the writer ends and drops stdin, which tells Node to leave.
    requests: Option<SyncSender<String>>,
    lines: Receiver<CaptureLine>,
}

impl CaptureChild {
    /// Starts the capture command for `rocky_home`: `<node> <entry> listen collect --stdio`.
    pub fn spawn(cli: &CliRecord, rocky_home: &Path) -> io::Result<Self> {
        let mut command = Command::new(&cli.node);
        command
            .arg(&cli.entry)
            .args(["listen", "collect", "--stdio"])
            .env("ROCKY_HOME", rocky_home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);

        let mut child = command.spawn()?;
        let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
            kill_and_reap(&mut child);
            return Err(io::Error::other("capture pipes were not set up"));
        };
        let (sender, lines) = mpsc::channel();
        let (requests, queued) = mpsc::sync_channel(SEND_QUEUE);
        // Neither thread is joined. A grandchild can inherit a pipe and keep it open after
        // Node is killed, and a join would then hang `stop`. Both end on their own when
        // their pipe closes: the reader at end of stdout, the writer on a failed write or
        // once `requests` is dropped.
        if let Err(error) = spawn_thread("capture-reader", move || read_lines(stdout, &sender))
            .and_then(|()| spawn_thread("capture-writer", move || write_requests(stdin, &queued)))
        {
            kill_and_reap(&mut child);
            return Err(error);
        }
        Ok(Self {
            child,
            requests: Some(requests),
            lines,
        })
    }

    /// Asks the child to reconcile `root`. The request is one JSON line, so a root with
    /// spaces, quotes, or shell characters arrives as written.
    ///
    /// Never blocks: the line is queued for the writer thread. `Err` means the child is gone
    /// (`BrokenPipe`, which can show a moment after it exits) or is not reading and the queue
    /// is full (`WouldBlock`). The caller should stop the child.
    pub fn send(&mut self, root: &str) -> io::Result<()> {
        let requests = self
            .requests
            .as_ref()
            .ok_or_else(|| io::Error::from(io::ErrorKind::BrokenPipe))?;
        let mut line = json!({ "v": 1, "root": root }).to_string();
        line.push('\n');
        requests.try_send(line).map_err(|error| match error {
            TrySendError::Full(_) => io::Error::from(io::ErrorKind::WouldBlock),
            TrySendError::Disconnected(_) => io::Error::from(io::ErrorKind::BrokenPipe),
        })
    }

    /// The lines the child wrote that the daemon accepts. The channel closes when the child's
    /// stdout does.
    pub fn lines(&self) -> &Receiver<CaptureLine> {
        &self.lines
    }

    /// The exit status once the child has exited, `None` while it runs. A status that cannot
    /// be read also reads as `None`; the daemon then stops the child itself.
    pub fn try_exit(&mut self) -> Option<ExitStatus> {
        self.child.try_wait().ok().flatten()
    }

    /// Closes stdin, gives the child `grace` to exit by itself, then kills it. The process is
    /// reaped either way. Requests still queued are written before stdin closes, unless the
    /// child is not reading; the kill then ends the write.
    pub fn stop(mut self, grace: Duration) {
        drop(self.requests.take());
        let deadline = Instant::now() + grace;
        while Instant::now() < deadline {
            match self.child.try_wait() {
                Ok(None) => thread::sleep(POLL_INTERVAL),
                // Exited and reaped, or the status cannot be read; the drop below settles it.
                Ok(Some(_)) | Err(_) => return,
            }
        }
        kill_and_reap(&mut self.child);
    }
}

impl Drop for CaptureChild {
    fn drop(&mut self) {
        kill_and_reap(&mut self.child);
    }
}

/// Safe to repeat: killing or waiting on a process that is already gone changes nothing.
fn kill_and_reap(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn spawn_thread(name: &str, work: impl FnOnce() + Send + 'static) -> io::Result<()> {
    thread::Builder::new()
        .name(name.to_string())
        .spawn(work)
        .map(drop)
}

/// Writes each queued request to `stdin` and flushes it. Returns on a failed write, which is
/// a closed pipe or, after a kill, the end of a write that was stuck on a full one, and when
/// the sender is dropped. Either way `stdin` drops, so the child sees end of input.
fn write_requests(mut stdin: ChildStdin, requests: &Receiver<String>) {
    for line in requests {
        if stdin
            .write_all(line.as_bytes())
            .and_then(|()| stdin.flush())
            .is_err()
        {
            return;
        }
    }
}

/// Splits `stdout` on `\n` and sends each accepted line. Returns at end of input, on a read
/// error, or when the receiver is gone.
fn read_lines(stdout: impl Read, sender: &Sender<CaptureLine>) {
    let mut reader = BufReader::new(stdout);
    let mut pending = LineBuffer::default();
    loop {
        let chunk = match reader.fill_buf() {
            Ok([]) => return,
            Ok(chunk) => chunk,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => return,
        };
        let used = match chunk.iter().position(|byte| *byte == b'\n') {
            Some(end) => {
                pending.extend(&chunk[..end]);
                if let Some(line) = pending.finish()
                    && sender.send(line).is_err()
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

    /// Ends the line and starts a new one. `None` for an oversized line, bytes that are not
    /// UTF-8, and anything [`parse_line`] rejects.
    fn finish(&mut self) -> Option<CaptureLine> {
        let overflowed = std::mem::take(&mut self.overflowed);
        let bytes = std::mem::take(&mut self.bytes);
        if overflowed {
            return None;
        }
        parse_line(std::str::from_utf8(&bytes).ok()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EMPTY_ROOTS_LEN: usize =
        r#"{"v":1,"kind":"roots","roots":[{"root":"","owner":true}]}"#.len();

    /// A valid `roots` line that is exactly `len` bytes long.
    fn roots_line(len: usize) -> String {
        let root = "a".repeat(len - EMPTY_ROOTS_LEN);
        format!(r#"{{"v":1,"kind":"roots","roots":[{{"root":"{root}","owner":true}}]}}"#)
    }

    fn finish(buffer: &mut LineBuffer, line: &str) -> Option<CaptureLine> {
        buffer.extend(line.as_bytes());
        buffer.finish()
    }

    #[test]
    fn line_at_the_cap_is_kept() {
        let mut buffer = LineBuffer::default();

        assert!(finish(&mut buffer, &roots_line(LINE_CAP)).is_some());
    }

    #[test]
    fn line_one_byte_over_the_cap_is_dropped() {
        let mut buffer = LineBuffer::default();

        assert_eq!(finish(&mut buffer, &roots_line(LINE_CAP + 1)), None);
    }

    #[test]
    fn dropping_an_oversized_line_does_not_taint_the_next() {
        let mut buffer = LineBuffer::default();
        assert_eq!(finish(&mut buffer, &roots_line(LINE_CAP + 1)), None);

        assert!(finish(&mut buffer, &roots_line(EMPTY_ROOTS_LEN + 1)).is_some());
    }

    #[test]
    fn oversized_line_is_not_held_in_memory() {
        let mut buffer = LineBuffer::default();

        buffer.extend(&vec![b'x'; LINE_CAP + 1]);
        buffer.extend(&vec![b'x'; LINE_CAP]);

        assert!(buffer.bytes.is_empty());
    }

    #[test]
    fn line_in_pieces_is_joined() {
        let line = roots_line(EMPTY_ROOTS_LEN + 3);
        let (head, tail) = line.as_bytes().split_at(10);
        let mut buffer = LineBuffer::default();

        buffer.extend(head);
        buffer.extend(tail);

        assert!(buffer.finish().is_some());
    }

    #[test]
    fn bytes_that_are_not_utf8_are_dropped() {
        let mut buffer = LineBuffer::default();

        buffer.extend(&[0xff, 0xfe, b'{']);

        assert_eq!(buffer.finish(), None);
    }

    #[test]
    fn reader_drops_a_final_line_with_no_newline() {
        let valid = roots_line(EMPTY_ROOTS_LEN + 1);
        let input = format!("{valid}\n{valid}");
        let (sender, receiver) = mpsc::channel();

        read_lines(input.as_bytes(), &sender);
        drop(sender);

        assert_eq!(receiver.iter().count(), 1);
    }

    #[test]
    fn reader_stops_when_the_receiver_is_gone() {
        let valid = roots_line(EMPTY_ROOTS_LEN + 1);
        let input = format!("{valid}\n{valid}\n");
        let (sender, receiver) = mpsc::channel();
        drop(receiver);

        // Returns instead of panicking on the failed send.
        read_lines(input.as_bytes(), &sender);
    }
}
