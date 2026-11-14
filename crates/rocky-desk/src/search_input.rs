//! Pure search input reducer and edit debounce timer for the change card list.

const MAX_SEARCH_CHARS: usize = 200;
const DEBOUNCE_MS: u64 = 300;

/// Single-line, append-only search query state.
// ponytail: minimal input; add cursor/selection/IME when search needs more than path fragments
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SearchInput {
    pub text: String,
}

/// Key and paste events handled by [`SearchInput::apply`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Key<'a> {
    Char(&'a str),
    Backspace,
    Escape,
    Paste(&'a str),
    Other,
}

impl SearchInput {
    /// Returns the next [`SearchInput`] state after applying `key`.
    pub fn apply(&self, key: Key<'_>) -> SearchInput {
        match key {
            Key::Char(s) => {
                let mut text = self.text.clone();
                append_printable(&mut text, s);
                SearchInput { text }
            }
            Key::Backspace => {
                let mut text = self.text.clone();
                text.pop();
                SearchInput { text }
            }
            Key::Escape => SearchInput {
                text: String::new(),
            },
            Key::Paste(s) => {
                let mut text = self.text.clone();
                let first_line = s.split(['\n', '\r']).next().unwrap_or("");
                append_printable(&mut text, first_line);
                SearchInput { text }
            }
            Key::Other => self.clone(),
        }
    }
}

fn append_printable(dst: &mut String, src: &str) {
    let remaining = MAX_SEARCH_CHARS.saturating_sub(dst.chars().count());
    if remaining == 0 {
        return;
    }
    dst.extend(src.chars().filter(|c| !c.is_control()).take(remaining));
}

/// Trailing 300 ms edit debounce state driven by caller-supplied millisecond timestamps.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Debounce {
    last_edit_ms: Option<u64>,
}

impl Debounce {
    /// Records an edit at `now_ms`, resetting the 300 ms quiet period.
    pub fn edited(&mut self, now_ms: u64) {
        self.last_edit_ms = Some(now_ms);
    }

    /// True once at least 300 ms have passed since the last [`Debounce::edited`] call
    /// and it has not yet fired since that edit.
    pub fn due(&self, now_ms: u64) -> bool {
        self.last_edit_ms
            .is_some_and(|last| now_ms.saturating_sub(last) >= DEBOUNCE_MS)
    }

    /// Returns `true` and clears the pending edit when [`Debounce::due`] holds at `now_ms`,
    /// so each typing pause fires at most once.
    pub fn take(&mut self, now_ms: u64) -> bool {
        if self.due(now_ms) {
            self.last_edit_ms = None;
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn typing_and_backspace_by_char() {
        let initial = SearchInput::default();
        assert_eq!(initial.text, "");
        assert_eq!(initial.apply(Key::Backspace).text, "");

        let s1 = initial.apply(Key::Char("a"));
        assert_eq!(initial.text, "");
        assert_eq!(s1.text, "a");

        let s2 = s1.apply(Key::Char("é")).apply(Key::Char("🔍"));
        assert_eq!(s2.text, "aé🔍");

        let s3 = s2.apply(Key::Char(" café🦀")).apply(Key::Other);
        assert_eq!(s3.text, "aé🔍 café🦀");

        let s4 = s3.apply(Key::Backspace);
        assert_eq!(s4.text, "aé🔍 café");

        let s5 = s4.apply(Key::Backspace);
        assert_eq!(s5.text, "aé🔍 caf");

        let cleared = s5
            .apply(Key::Backspace)
            .apply(Key::Backspace)
            .apply(Key::Backspace)
            .apply(Key::Backspace)
            .apply(Key::Backspace)
            .apply(Key::Backspace)
            .apply(Key::Backspace)
            .apply(Key::Backspace);
        assert_eq!(cleared.text, "");
    }

    #[test]
    fn escape_clears() {
        let input = SearchInput::default()
            .apply(Key::Char("src/lib.rs"))
            .apply(Key::Escape);
        assert_eq!(input.text, "");
        assert_eq!(input.apply(Key::Escape).text, "");
    }

    #[test]
    fn paste_first_line_only() {
        let lf = SearchInput::default().apply(Key::Paste("alpha\nbeta\ngamma"));
        assert_eq!(lf.text, "alpha");

        let crlf = SearchInput::default().apply(Key::Paste("crlf\r\nsecond"));
        assert_eq!(crlf.text, "crlf");

        let cr = SearchInput::default().apply(Key::Paste("cr\rsecond"));
        assert_eq!(cr.text, "cr");

        let leading = SearchInput::default()
            .apply(Key::Char("prefix:"))
            .apply(Key::Paste("\nsecond"));
        assert_eq!(leading.text, "prefix:");

        let appended = SearchInput::default()
            .apply(Key::Char("path/"))
            .apply(Key::Paste("file.rs\nother.rs"));
        assert_eq!(appended.text, "path/file.rs");
    }

    #[test]
    fn cap_200_chars() {
        let over_ascii = "a".repeat(205);
        let capped = SearchInput::default().apply(Key::Paste(&over_ascii));
        assert_eq!(capped.text.chars().count(), 200);
        assert_eq!(capped.apply(Key::Char("z")).text.chars().count(), 200);
        assert_eq!(capped.apply(Key::Paste("w")).text.chars().count(), 200);

        let over_multibyte = format!("{}{}", "é".repeat(120), "🔍".repeat(120));
        let multi = SearchInput::default().apply(Key::Char(&over_multibyte));
        assert_eq!(multi.text.chars().count(), 200);
        assert_eq!(
            multi.text,
            format!("{}{}", "é".repeat(120), "🔍".repeat(80))
        );

        let stepped = multi.apply(Key::Backspace).apply(Key::Char("xy"));
        assert_eq!(stepped.text.chars().count(), 200);
        assert!(stepped.text.ends_with('x'));
        assert!(!stepped.text.ends_with("xy"));

        let controls_then_200 = format!("{}{}", "\t\n".repeat(10), "b".repeat(200));
        let full = SearchInput::default().apply(Key::Char(&controls_then_200));
        assert_eq!(full.text.chars().count(), 200);
    }

    #[test]
    fn controls_dropped() {
        let input = SearchInput::default()
            .apply(Key::Char("\n"))
            .apply(Key::Char("\r"))
            .apply(Key::Char("\t"))
            .apply(Key::Char("\0"))
            .apply(Key::Char("\x1b"))
            .apply(Key::Char("\x7f"))
            .apply(Key::Char("\u{0085}"))
            .apply(Key::Char("a\tb\nc\x00 d"))
            .apply(Key::Paste("e\tf\x1b[31mg\u{0085}h\nignored"));
        assert_eq!(input.text, "abc def[31mgh");
    }

    #[test]
    fn debounce_300ms() {
        let mut debounce = Debounce::default();
        assert!(!debounce.due(0));
        assert!(!debounce.due(300));
        assert!(!debounce.due(10_000));
        assert!(!debounce.take(300));

        debounce.edited(100);
        assert!(!debounce.due(100));
        assert!(!debounce.due(399));
        assert!(!debounce.take(399));
        assert!(debounce.due(400));

        debounce.edited(250);
        assert!(!debounce.due(400));
        assert!(!debounce.due(549));
        assert!(debounce.due(550));
        assert!(debounce.take(550));
        assert!(!debounce.due(550));
        assert!(!debounce.due(1_000));
        assert!(!debounce.take(1_000));

        debounce.edited(1_000);
        assert!(!debounce.due(900));
        assert!(!debounce.due(1_299));
        assert!(debounce.due(1_300));
        assert!(debounce.take(1_300));
        assert!(!debounce.due(1_300));

        debounce.edited(u64::MAX - 10);
        assert!(!debounce.due(u64::MAX));
    }
}
