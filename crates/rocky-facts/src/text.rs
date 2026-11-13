use std::borrow::Cow;
use std::collections::HashMap;
use std::hash::Hash;

use similar::{Algorithm, DiffOp, capture_diff_slices};

use crate::model::MAX_DIFF_ITEMS;

/// Strips a single leading UTF-8 BOM and converts CRLF sequences to LF.
pub(crate) fn normalize(s: &str) -> Cow<'_, str> {
    let without_bom = s.strip_prefix('\u{FEFF}').unwrap_or(s);
    if without_bom.contains("\r\n") {
        Cow::Owned(without_bom.replace("\r\n", "\n"))
    } else {
        Cow::Borrowed(without_bom)
    }
}

/// Truncates `s` to at most `max_chars` Unicode scalar values, appending `…` when shortened.
pub(crate) fn cut(s: &str, max_chars: usize) -> String {
    if max_chars == 0 {
        return String::new();
    }
    let mut chars = s.char_indices();
    if let Some((cut_byte, _)) = chars.nth(max_chars - 1)
        && chars.next().is_some()
    {
        let mut out = String::with_capacity(cut_byte + '…'.len_utf8());
        out.push_str(&s[..cut_byte]);
        out.push('…');
        return out;
    }
    s.to_string()
}

fn multiset_pairs<'a, T: Eq + Hash>(
    before: &'a [T],
    after: &'a [T],
) -> HashMap<&'a T, (usize, usize)> {
    let mut counts: HashMap<&'a T, (usize, usize)> =
        HashMap::with_capacity(before.len().max(after.len()).min(MAX_DIFF_ITEMS));
    for item in before {
        counts.entry(item).or_default().0 += 1;
    }
    for item in after {
        counts.entry(item).or_default().1 += 1;
    }
    counts
}

fn saturating_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

/// Counts `(added, removed)` lines using Myers diff, or multiset counts above `MAX_DIFF_ITEMS`.
pub(crate) fn line_counts(before: &str, after: &str) -> (u32, u32) {
    let before_lines: Vec<&str> = before.lines().collect();
    let after_lines: Vec<&str> = after.lines().collect();
    if before_lines.len() > MAX_DIFF_ITEMS || after_lines.len() > MAX_DIFF_ITEMS {
        let mut added = 0usize;
        let mut removed = 0usize;
        for (b_cnt, a_cnt) in multiset_pairs(&before_lines, &after_lines).into_values() {
            if a_cnt > b_cnt {
                added += a_cnt - b_cnt;
            } else {
                removed += b_cnt - a_cnt;
            }
        }
        return (saturating_u32(added), saturating_u32(removed));
    }

    let ops = capture_diff_slices(Algorithm::Myers, &before_lines, &after_lines);
    let mut added = 0usize;
    let mut removed = 0usize;
    for op in ops {
        match op {
            DiffOp::Equal { .. } => {}
            DiffOp::Delete { old_len, .. } => removed += old_len,
            DiffOp::Insert { new_len, .. } => added += new_len,
            DiffOp::Replace {
                old_len, new_len, ..
            } => {
                removed += old_len;
                added += new_len;
            }
        }
    }
    (saturating_u32(added), saturating_u32(removed))
}

/// Computes `100 - round(100 * matched / max(len_a, len_b))` over token slices.
pub(crate) fn token_change_pct<T: Eq + Hash>(a: &[T], b: &[T]) -> u32 {
    let max_len = a.len().max(b.len());
    if max_len == 0 {
        return 0;
    }
    let matched: usize = if a.len() > MAX_DIFF_ITEMS || b.len() > MAX_DIFF_ITEMS {
        multiset_pairs(a, b)
            .into_values()
            .map(|(a_cnt, b_cnt)| a_cnt.min(b_cnt))
            .sum()
    } else {
        capture_diff_slices(Algorithm::Myers, a, b)
            .into_iter()
            .map(|op| match op {
                DiffOp::Equal { len, .. } => len,
                _ => 0,
            })
            .sum()
    };
    let matched_pct = (100u128 * matched as u128 * 2 + max_len as u128) / (2 * max_len as u128);
    100u32.saturating_sub(matched_pct as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_respects_char_boundary() {
        let accented = "é".repeat(100);
        let cut_accented = cut(&accented, 60);
        assert!(cut_accented.chars().count() <= 60);
        assert!(cut_accented.ends_with('…'));

        let emoji = "😀".repeat(100);
        let cut_emoji = cut(&emoji, 60);
        assert!(cut_emoji.chars().count() <= 60);
        assert!(cut_emoji.ends_with('…'));

        for prefix_len in [58usize, 59, 60] {
            let mixed = format!("{}😀{}", "a".repeat(prefix_len), "b".repeat(10));
            let cut_mixed = cut(&mixed, 60);
            assert!(cut_mixed.chars().count() <= 60);
            assert!(cut_mixed.ends_with('…'));
        }

        let within = format!("{}😀", "a".repeat(59));
        assert_eq!(cut(&within, 60), within);
    }

    #[test]
    fn large_input_uses_multiset_counts() {
        let before_lines: Vec<String> = (0..=20_000).map(|i| format!("l{i}")).collect();
        let mut after_lines = Vec::with_capacity(before_lines.len() + 1);
        for (idx, line) in before_lines.iter().enumerate() {
            if idx == 5 {
                continue;
            }
            after_lines.push(line.clone());
            if idx == 7 {
                after_lines.push(line.clone());
            }
        }
        after_lines.push("new".to_string());

        let before = before_lines.join("\n");
        let after = after_lines.join("\n");
        assert_eq!(line_counts(&before, &after), (2, 1));
    }

    #[test]
    fn token_change_pct_basics() {
        let abcd: Vec<String> = ["a", "b", "c", "d"]
            .into_iter()
            .map(str::to_string)
            .collect();
        let abxy: Vec<String> = ["a", "b", "x", "y"]
            .into_iter()
            .map(str::to_string)
            .collect();
        let wxyz: Vec<String> = ["w", "x", "y", "z"]
            .into_iter()
            .map(str::to_string)
            .collect();

        assert_eq!(token_change_pct(&abcd, &abcd), 0);
        assert_eq!(token_change_pct(&abcd, &wxyz), 100);
        assert_eq!(token_change_pct(&abcd, &abxy), 50);
        assert_eq!(token_change_pct::<&str>(&[], &[]), 0);
    }

    #[test]
    fn large_token_change_pct_uses_multiset() {
        let a: Vec<String> = (0..12_000).map(|i| format!("t{i}")).collect();
        let mut b = a.clone();
        for item in b.iter_mut().take(3_000) {
            *item = "changed".to_string();
        }
        assert_eq!(token_change_pct(&a, &b), 25);
    }

    #[test]
    fn cut_edge_cases() {
        assert_eq!(cut("", 60), "");
        assert_eq!(cut("abc", 3), "abc");
        assert_eq!(cut("abcd", 1), "…");
        assert_eq!(cut("a", 1), "a");
        assert_eq!(cut("abc", 0), "");
    }

    #[test]
    fn normalize_bom_and_crlf() {
        assert!(matches!(
            normalize("plain\ntext\n"),
            Cow::Borrowed("plain\ntext\n")
        ));
        assert!(matches!(
            normalize("\u{FEFF}plain\ntext\n"),
            Cow::Borrowed("plain\ntext\n")
        ));
        assert_eq!(normalize("\u{FEFF}a\r\nb\r\n"), "a\nb\n");
    }
}
