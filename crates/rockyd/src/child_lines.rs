//! Line reading for the stdout of a supervised Node child (capture and translate).

use std::io::{self, BufRead, BufReader, Read};

use rocky_proto::pipe::LINE_CAP;

/// Splits `stdout` on `\n` and hands each line to `on_line`. Lines over [`LINE_CAP`] and bytes
/// that are not UTF-8 are dropped, and a final line with no newline is never handed over.
/// Returns at end of input, on a read error, or when `on_line` returns `false`.
pub(crate) fn read_capped_lines(stdout: impl Read, mut on_line: impl FnMut(&str) -> bool) {
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
                if let Some(bytes) = pending.finish()
                    && let Ok(line) = std::str::from_utf8(&bytes)
                    && !on_line(line)
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

    /// Ends the line and starts a new one. `None` for an oversized line.
    fn finish(&mut self) -> Option<Vec<u8>> {
        let overflowed = std::mem::take(&mut self.overflowed);
        let bytes = std::mem::take(&mut self.bytes);
        (!overflowed).then_some(bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(input: &[u8]) -> Vec<String> {
        let mut out = Vec::new();
        read_capped_lines(input, |line| {
            out.push(line.to_string());
            true
        });
        out
    }

    #[test]
    fn line_at_the_cap_is_kept_and_one_byte_over_is_dropped() {
        let at_cap = "a".repeat(LINE_CAP);
        let over = "b".repeat(LINE_CAP + 1);
        let input = format!("{at_cap}\n{over}\nnext\n");
        assert_eq!(lines(input.as_bytes()), vec![at_cap, "next".to_string()]);
    }

    #[test]
    fn oversized_line_is_not_held_in_memory() {
        let mut buffer = LineBuffer::default();
        buffer.extend(&vec![b'x'; LINE_CAP + 1]);
        buffer.extend(&vec![b'x'; LINE_CAP]);
        assert!(buffer.bytes.is_empty());
        assert_eq!(buffer.finish(), None);
        buffer.extend(b"ok");
        assert_eq!(buffer.finish(), Some(b"ok".to_vec()));
    }

    #[test]
    fn line_in_pieces_is_joined() {
        // A one-byte reader buffer forces every line to arrive in pieces.
        let reader = BufReader::with_capacity(1, &b"abc\ndef\n"[..]);
        assert_eq!(lines_from(reader), vec!["abc", "def"]);
    }

    fn lines_from(reader: impl Read) -> Vec<String> {
        let mut out = Vec::new();
        read_capped_lines(reader, |line| {
            out.push(line.to_string());
            true
        });
        out
    }

    #[test]
    fn bytes_that_are_not_utf8_are_dropped() {
        assert_eq!(lines(b"\xff\xfe{\nok\n"), vec!["ok"]);
    }

    #[test]
    fn final_line_with_no_newline_is_dropped() {
        assert_eq!(lines(b"one\ntwo"), vec!["one"]);
    }

    #[test]
    fn stops_when_the_callback_says_so() {
        let mut seen = 0;
        read_capped_lines(&b"a\nb\nc\n"[..], |_| {
            seen += 1;
            false
        });
        assert_eq!(seen, 1);
    }
}
