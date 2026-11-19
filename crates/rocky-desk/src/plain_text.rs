//! Markdown to plain text for agent quotes shown on change cards.

/// Strips markdown markup from an agent's words so the card shows prose:
/// no `**`, backticks, `#`, `>`, `-`/`*` list markers, code fences or link
/// syntax. Each list item keeps its own line. Characters that belong to the
/// content (`/`, `_` in names, quotes, braces) stay.
pub fn plain_quote(text: &str) -> String {
    let mut lines: Vec<String> = Vec::new();
    for raw in text.lines() {
        let trimmed = raw.trim();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            continue;
        }
        let line = clean_inline(strip_block_markers(trimmed));
        let line = line.trim();
        if !line.is_empty() {
            lines.push(line.to_string());
        } else if trimmed.is_empty() && lines.last().is_some_and(|l| !l.is_empty()) {
            // One blank line keeps a paragraph break; a line that only held
            // markup (a cut-off "- *") is dropped.
            lines.push(String::new());
        }
    }
    while lines.last().is_some_and(String::is_empty) {
        lines.pop();
    }
    lines.join("\n")
}

/// Drops leading heading `#`s, blockquote `>`s and one `-`/`*`/`+` list marker.
fn strip_block_markers(mut line: &str) -> &str {
    loop {
        let hashes = line.len() - line.trim_start_matches('#').len();
        if (1..=6).contains(&hashes) && line[hashes..].chars().next().is_none_or(|c| c == ' ') {
            line = line[hashes..].trim_start();
        } else if let Some(rest) = line.strip_prefix('>') {
            line = rest.trim_start();
        } else {
            break;
        }
    }
    for marker in ["- ", "* ", "+ "] {
        if let Some(rest) = line.strip_prefix(marker) {
            return rest.trim_start();
        }
    }
    line
}

/// Drops emphasis and code markup, and keeps only a link's label.
// ponytail: `__` bold is left alone so `__init__`-style names survive.
fn clean_inline(line: &str) -> String {
    let text = unlink(line)
        .replace("~~", "")
        .replace("**", "")
        .replace('`', "");
    let chars: Vec<char> = text.chars().collect();
    chars
        .iter()
        .enumerate()
        .filter(|&(i, &c)| c != '*' || is_operator_star(&chars, i))
        .map(|(_, &c)| c)
        .collect()
}

/// A `*` with whitespace on both sides (`a * b`) or word characters on both
/// sides (`2*3`) is content; one that opens or closes emphasis is markup.
fn is_operator_star(chars: &[char], i: usize) -> bool {
    let before = i.checked_sub(1).and_then(|j| chars.get(j));
    let after = chars.get(i + 1);
    match (before, after) {
        (Some(b), Some(a)) => {
            (b.is_whitespace() && a.is_whitespace()) || (b.is_alphanumeric() && a.is_alphanumeric())
        }
        _ => false,
    }
}

/// `[label](url)` becomes `label`; anything else stays as written.
fn unlink(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(open) = rest.find('[') {
        let after = &rest[open + 1..];
        if let Some(close) = after.find("](") {
            let label = &after[..close];
            let tail = &after[close + 2..];
            if let Some(end) = tail.find(')')
                && !label.contains('[')
            {
                out.push_str(&rest[..open]);
                out.push_str(label);
                rest = &tail[end + 1..];
                continue;
            }
        }
        out.push_str(&rest[..=open]);
        rest = after;
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::plain_quote;

    #[test]
    fn strips_bold_code_and_list_markers() {
        let text = "Tugas selesai. Di `C:/repo`:\n\n- **Validasi baru:** `scripts/check.js` wajib `host`.\n- **Merah:** gagal.\n- *";
        assert_eq!(
            plain_quote(text),
            "Tugas selesai. Di C:/repo:\n\nValidasi baru: scripts/check.js wajib host.\nMerah: gagal."
        );
    }

    #[test]
    fn strips_headings_quotes_fences_and_links() {
        let text = "## Ringkas\n> catatan\n```js\nconst a = 1;\n```\nLihat [docs](https://x.dev/a) dan ~~lama~~.";
        assert_eq!(
            plain_quote(text),
            "Ringkas\ncatatan\nconst a = 1;\nLihat docs dan lama."
        );
    }

    #[test]
    fn keeps_content_characters() {
        let text = "1. set `{\"port\": 8080}` in snake_case_name/path";
        assert_eq!(
            plain_quote(text),
            "1. set {\"port\": 8080} in snake_case_name/path"
        );
    }

    #[test]
    fn keeps_an_asterisk_that_is_an_operator() {
        assert_eq!(plain_quote("diedit menjadi a * b"), "diedit menjadi a * b");
        assert_eq!(
            plain_quote("hasil 2*3 dan *miring*"),
            "hasil 2*3 dan miring"
        );
    }

    #[test]
    fn collapses_blank_lines_and_trims() {
        assert_eq!(plain_quote("\n\na\n\n\n\nb\n\n"), "a\n\nb");
        assert_eq!(plain_quote("- *"), "");
    }
}
