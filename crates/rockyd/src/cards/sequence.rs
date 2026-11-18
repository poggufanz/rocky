//! Sequence pattern detection over a change card's execution flow.

use std::collections::HashSet;

use rocky_proto::cards::{Block, FlowKind, FlowStep, Sequence};

/// Detects a closed-catalog execution pattern across a card's chronological `flow`.
///
/// Pure function over `flow` and `blocks`; performs no I/O.
pub fn match_sequence(flow: &[FlowStep], blocks: &[Block]) -> Option<Sequence> {
    let normalized: Vec<String> = flow
        .iter()
        .map(|step| {
            if step.kind == FlowKind::Cmd {
                normalize_command(&step.text)
            } else {
                String::new()
            }
        })
        .collect();

    let (c1_idx, c2_idx) = find_fail_and_pass(flow, &normalized)?;

    let counted_edits: Vec<&FlowStep> = flow[c1_idx + 1..c2_idx]
        .iter()
        .filter(|step| step.kind == FlowKind::Edit && step.ok)
        .collect();
    if counted_edits.is_empty() {
        return None;
    }

    let mut edit_seqs = Vec::new();
    let mut seen_seqs = HashSet::new();
    for step in counted_edits {
        for &seq in &step.seqs {
            if seen_seqs.insert(seq) {
                edit_seqs.push(seq);
            }
        }
    }
    if edit_seqs.is_empty() {
        return None;
    }

    let c1 = &flow[c1_idx];
    let exit_code = c1.exit_code?;
    let error_names = c1
        .error
        .as_deref()
        .and_then(|err| first_named_edit_basename(err, &edit_seqs, blocks));

    Some(Sequence::FixAfterFail {
        command: normalized[c2_idx].clone(),
        exit_code,
        edit_seqs,
        error_names,
    })
}

fn find_fail_and_pass(flow: &[FlowStep], normalized: &[String]) -> Option<(usize, usize)> {
    for (c2_idx, step) in flow.iter().enumerate() {
        if step.kind != FlowKind::Cmd || !step.ok {
            continue;
        }
        let cmd = &normalized[c2_idx];
        if cmd.is_empty() {
            continue;
        }
        if let Some(c1_idx) = (0..c2_idx).rev().find(|&i| {
            let prev = &flow[i];
            prev.kind == FlowKind::Cmd
                && !prev.ok
                && matches!(prev.exit_code, Some(code) if code != 0)
                && normalized[i] == *cmd
        }) {
            return Some((c1_idx, c2_idx));
        }
    }
    None
}

fn normalize_command(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn first_named_edit_basename(err: &str, edit_seqs: &[u32], blocks: &[Block]) -> Option<String> {
    for &seq in edit_seqs {
        let Some(block) = blocks.iter().find(|b| b.seq == seq) else {
            continue;
        };
        let Some(base) = path_basename(&block.path) else {
            continue;
        };
        if err.contains(base) {
            return Some(base.to_string());
        }
    }
    None
}

fn path_basename(path: &str) -> Option<&str> {
    path.rsplit(['/', '\\']).next().filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use rocky_proto::cards::{Block, BlockVia, FlowKind, FlowStep, Importance, Sequence};

    use super::*;

    fn cmd_fail(text: &str, exit_code: Option<i32>, error: Option<&str>) -> FlowStep {
        FlowStep {
            kind: FlowKind::Cmd,
            text: text.to_string(),
            ok: false,
            dur_ms: 10,
            seqs: Vec::new(),
            exit_code,
            error: error.map(str::to_string),
        }
    }

    fn cmd_ok(text: &str) -> FlowStep {
        FlowStep {
            kind: FlowKind::Cmd,
            text: text.to_string(),
            ok: true,
            dur_ms: 10,
            seqs: Vec::new(),
            exit_code: None,
            error: None,
        }
    }

    fn edit_step(text: &str, ok: bool, seqs: Vec<u32>) -> FlowStep {
        FlowStep {
            kind: FlowKind::Edit,
            text: text.to_string(),
            ok,
            dur_ms: 5,
            seqs,
            exit_code: None,
            error: None,
        }
    }

    fn block(seq: u32, path: &str) -> Block {
        Block {
            seq,
            path: path.to_string(),
            symbol: None,
            labels: Vec::new(),
            importance: Importance::Low,
            via: BlockVia::Edit,
            tool_use_ids: Vec::new(),
            bash: None,
            before: None,
            after: None,
            recorded: true,
            line: None,
            added: None,
            removed: None,
            quote: None,
        }
    }

    #[test]
    fn fail_edit_pass_matches() {
        let flow = vec![
            cmd_fail("npm test", Some(1), None),
            edit_step("src/auth.ts", true, vec![1]),
            cmd_ok("npm test"),
        ];
        assert_eq!(
            match_sequence(&flow, &[block(1, "src/auth.ts")]),
            Some(Sequence::FixAfterFail {
                command: "npm test".to_string(),
                exit_code: 1,
                edit_seqs: vec![1],
                error_names: None,
            })
        );
    }

    #[test]
    fn repeated_failure_uses_last_one() {
        let flow = vec![
            cmd_fail("npm test", Some(1), None),
            edit_step("src/a.ts", true, vec![1]),
            cmd_fail("npm test", Some(2), None),
            edit_step("src/b.ts", true, vec![2]),
            cmd_ok("npm test"),
        ];
        assert_eq!(
            match_sequence(&flow, &[block(1, "src/a.ts"), block(2, "src/b.ts")]),
            Some(Sequence::FixAfterFail {
                command: "npm test".to_string(),
                exit_code: 2,
                edit_seqs: vec![2],
                error_names: None,
            })
        );
    }

    #[test]
    fn different_command_does_not_match() {
        let flow = vec![
            cmd_fail("npm test", Some(1), None),
            edit_step("src/auth.ts", true, vec![1]),
            cmd_ok("npm run build"),
        ];
        assert_eq!(match_sequence(&flow, &[block(1, "src/auth.ts")]), None);
    }

    #[test]
    fn failure_without_exit_code_is_not_c1() {
        let flow = vec![
            cmd_fail("npm test", None, Some("boom")),
            edit_step("src/auth.ts", true, vec![1]),
            cmd_ok("npm test"),
        ];
        assert_eq!(match_sequence(&flow, &[block(1, "src/auth.ts")]), None);

        let zero_exit = vec![
            cmd_fail("npm test", Some(0), Some("boom")),
            edit_step("src/auth.ts", true, vec![1]),
            cmd_ok("npm test"),
        ];
        assert_eq!(match_sequence(&zero_exit, &[block(1, "src/auth.ts")]), None);
    }

    #[test]
    fn failed_edit_is_not_counted() {
        let only_failed_edit = vec![
            cmd_fail("npm test", Some(1), None),
            edit_step("src/auth.ts", false, vec![1]),
            cmd_ok("npm test"),
        ];
        assert_eq!(
            match_sequence(&only_failed_edit, &[block(1, "src/auth.ts")]),
            None
        );

        let mixed_edits = vec![
            cmd_fail("npm test", Some(1), None),
            edit_step("src/a.ts", false, vec![1]),
            edit_step("src/b.ts", true, vec![2]),
            edit_step("src/b.ts", true, vec![2, 3]),
            cmd_ok("npm test"),
        ];
        assert_eq!(
            match_sequence(
                &mixed_edits,
                &[
                    block(1, "src/a.ts"),
                    block(2, "src/b.ts"),
                    block(3, "src/c.ts")
                ]
            ),
            Some(Sequence::FixAfterFail {
                command: "npm test".to_string(),
                exit_code: 1,
                edit_seqs: vec![2, 3],
                error_names: None,
            })
        );
    }

    #[test]
    fn whitespace_differences_still_match() {
        let flow = vec![
            cmd_fail("  npm  \t test ", Some(1), None),
            edit_step("src/auth.ts", true, vec![1]),
            cmd_ok("npm test"),
        ];
        assert_eq!(
            match_sequence(&flow, &[block(1, "src/auth.ts")]),
            Some(Sequence::FixAfterFail {
                command: "npm test".to_string(),
                exit_code: 1,
                edit_seqs: vec![1],
                error_names: None,
            })
        );
    }

    #[test]
    fn empty_command_never_matches() {
        let flow = vec![
            cmd_fail("", Some(1), None),
            edit_step("src/auth.ts", true, vec![1]),
            cmd_ok(""),
        ];
        assert_eq!(match_sequence(&flow, &[block(1, "src/auth.ts")]), None);

        let whitespace_only = vec![
            cmd_fail("   \t ", Some(1), None),
            edit_step("src/auth.ts", true, vec![1]),
            cmd_ok("  "),
        ];
        assert_eq!(
            match_sequence(&whitespace_only, &[block(1, "src/auth.ts")]),
            None
        );
    }

    #[test]
    fn error_names_edited_file() {
        let flow = vec![
            cmd_fail("npm test", Some(1), Some("✗ auth.test.ts … src/auth.ts:41")),
            edit_step("src/helper.ts", true, vec![1]),
            edit_step("src/auth.ts", true, vec![2]),
            cmd_ok("npm test"),
        ];
        assert_eq!(
            match_sequence(&flow, &[block(1, "src/helper.ts"), block(2, "src/auth.ts")]),
            Some(Sequence::FixAfterFail {
                command: "npm test".to_string(),
                exit_code: 1,
                edit_seqs: vec![1, 2],
                error_names: Some("auth.ts".to_string()),
            })
        );
    }

    #[test]
    fn first_pass_wins() {
        let flow = vec![
            cmd_fail("npm test", Some(1), None),
            edit_step("src/a.ts", true, vec![1]),
            cmd_ok("npm test"),
            edit_step("src/b.ts", true, vec![2]),
            cmd_fail("cargo test", Some(101), None),
            edit_step("src/c.rs", true, vec![3]),
            cmd_ok("cargo test"),
        ];
        assert_eq!(
            match_sequence(
                &flow,
                &[
                    block(1, "src/a.ts"),
                    block(2, "src/b.ts"),
                    block(3, "src/c.rs")
                ]
            ),
            Some(Sequence::FixAfterFail {
                command: "npm test".to_string(),
                exit_code: 1,
                edit_seqs: vec![1],
                error_names: None,
            })
        );
    }

    #[test]
    fn counted_edits_with_empty_seqs_do_not_match() {
        let flow = vec![
            cmd_fail("npm test", Some(1), None),
            edit_step("src/auth.ts", true, Vec::new()),
            cmd_ok("npm test"),
        ];
        assert_eq!(match_sequence(&flow, &[]), None);
    }

    #[test]
    fn mixed_empty_and_non_empty_edit_seqs_collect_non_empty() {
        let flow = vec![
            cmd_fail("npm test", Some(1), None),
            edit_step("src/reverted.ts", true, Vec::new()),
            edit_step("src/kept.ts", true, vec![3]),
            cmd_ok("npm test"),
        ];
        assert_eq!(
            match_sequence(&flow, &[block(3, "src/kept.ts")]),
            Some(Sequence::FixAfterFail {
                command: "npm test".to_string(),
                exit_code: 1,
                edit_seqs: vec![3],
                error_names: None,
            })
        );
    }
}
