//! One rule for "do these two repo roots name the same place". Windows paths
//! ignore case and treat `\` as `/`; elsewhere the text must match exactly.

/// Whether `a` and `b` are the same root. `windows` picks the Windows rule.
pub fn same_root(a: &str, b: &str, windows: bool) -> bool {
    if !windows {
        return a == b;
    }
    let norm = |p: &str| p.replace('\\', "/").trim_end_matches('/').to_lowercase();
    norm(a) == norm(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_ignores_case_separators_and_a_trailing_slash() {
        assert!(same_root("C:\\Work\\App", "c:/work/app/", true));
        assert!(!same_root("C:\\Work\\App", "C:\\Work\\Other", true));
    }

    #[test]
    fn elsewhere_the_text_must_match_exactly() {
        assert!(same_root("/work/app", "/work/app", false));
        assert!(!same_root("/work/App", "/work/app", false));
        assert!(!same_root("C:\\work\\app", "C:/work/app", false));
    }
}
