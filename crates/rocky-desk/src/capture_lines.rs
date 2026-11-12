//! Health-strip lines for repo capture: which repos the desk reports because
//! their capture stopped or fell back to polling, and in what order.

use rocky_proto::pipe::{CaptureHealth, CaptureState};

use crate::i18n::Msg;

/// Repo lines the strip shows before the "more" summary.
pub const CAPTURE_LINES: usize = 3;

/// Capture lines in display order: failed repos first, then polling repos, each
/// group in the order the daemon sent them. Every other state needs no report.
pub fn capture_lines(rows: &[CaptureHealth]) -> Vec<Msg> {
    let in_state = |state: CaptureState| rows.iter().filter(move |r| r.state == state);
    let mut reported = in_state(CaptureState::Failed)
        .map(failed_line)
        .chain(in_state(CaptureState::Polling).map(polling_line));
    let mut lines: Vec<Msg> = reported.by_ref().take(CAPTURE_LINES).collect();
    let cut = reported.count();
    if cut > 0 {
        lines.push(Msg::CaptureMore { n: cut });
    }
    lines
}

/// A failed repo with no error text still reports; the empty `error` leaves out
/// the reason and the line reads "Capture for <root> failed."
fn failed_line(row: &CaptureHealth) -> Msg {
    Msg::CaptureFailed {
        root: row.root.clone(),
        error: row.error.clone().unwrap_or_default(),
    }
}

fn polling_line(row: &CaptureHealth) -> Msg {
    Msg::CapturePolling {
        root: row.root.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::i18n::{en, id};
    use crate::view::{Conn, Model};
    use rocky_proto::pipe::{Health, ServerMsg, SetupHealth};

    fn row(state: CaptureState, root: &str, error: Option<&str>) -> CaptureHealth {
        CaptureHealth {
            root: root.into(),
            state,
            last_reconcile_ms: None,
            error: error.map(Into::into),
        }
    }

    #[test]
    fn ok_partial_elsewhere_starting_add_no_lines() {
        let rows = [
            row(CaptureState::Starting, "/r/starting", None),
            row(CaptureState::Ok, "/r/ok", None),
            row(CaptureState::Partial, "/r/partial", Some("Skipped files.")),
            row(CaptureState::Elsewhere, "/r/elsewhere", None),
        ];
        assert!(capture_lines(&rows).is_empty());
        assert!(capture_lines(&[]).is_empty());
    }

    #[test]
    fn failed_and_polling_rows_add_lines_in_order() {
        let rows = [
            row(
                CaptureState::Polling,
                "/r/poll-a",
                Some("Watching files failed; capturing every 60 seconds."),
            ),
            row(CaptureState::Ok, "/r/ok", None),
            row(
                CaptureState::Failed,
                "/r/fail-a",
                Some("Node could not start."),
            ),
            row(CaptureState::Failed, "/r/fail-b", None),
        ];
        assert_eq!(
            capture_lines(&rows),
            vec![
                Msg::CaptureFailed {
                    root: "/r/fail-a".into(),
                    error: "Node could not start.".into()
                },
                Msg::CaptureFailed {
                    root: "/r/fail-b".into(),
                    error: String::new()
                },
                Msg::CapturePolling {
                    root: "/r/poll-a".into()
                },
            ]
        );
    }

    #[test]
    fn more_than_three_rows_end_with_a_more_line() {
        let mut rows: Vec<_> = (0..4)
            .map(|i| row(CaptureState::Failed, &format!("/r/f{i}"), None))
            .collect();
        rows.push(row(CaptureState::Polling, "/r/p0", None));
        rows.push(row(CaptureState::Ok, "/r/ok", None));
        let lines = capture_lines(&rows);
        assert_eq!(lines.len(), CAPTURE_LINES + 1);
        assert!(
            lines[..CAPTURE_LINES]
                .iter()
                .all(|m| matches!(m, Msg::CaptureFailed { .. }))
        );
        assert_eq!(lines[CAPTURE_LINES], Msg::CaptureMore { n: 2 });
    }

    #[test]
    fn exactly_three_rows_have_no_more_line() {
        let rows = [
            row(CaptureState::Failed, "/r/a", None),
            row(CaptureState::Polling, "/r/b", None),
            row(CaptureState::Polling, "/r/c", None),
            row(CaptureState::Ok, "/r/ok", None),
        ];
        assert_eq!(
            capture_lines(&rows),
            vec![
                Msg::CaptureFailed {
                    root: "/r/a".into(),
                    error: String::new()
                },
                Msg::CapturePolling {
                    root: "/r/b".into()
                },
                Msg::CapturePolling {
                    root: "/r/c".into()
                },
            ]
        );
    }

    #[test]
    fn warnings_place_capture_lines_after_setup_lines_and_before_connection() {
        let mut model = Model::new();
        model.apply(ServerMsg::Health {
            health: Health {
                setup: SetupHealth {
                    version_mismatch: true,
                    ..SetupHealth::default()
                },
                capture: vec![row(CaptureState::Failed, "/r/a", None)],
                ..Default::default()
            },
        });
        model.set_conn(Conn::Disconnected);
        let w = model.warnings(&crate::clock::utc_hhmm);
        assert_eq!(
            w,
            vec![
                Msg::SetupNewVersion,
                Msg::CaptureFailed {
                    root: "/r/a".into(),
                    error: String::new()
                },
                Msg::ConnDisconnected,
            ]
        );
    }

    #[test]
    fn capture_copy_matches_the_catalog() {
        let root = || "C:/work/app".to_string();
        let cases = [
            (
                Msg::CaptureFailed {
                    root: root(),
                    error: "Node could not start.".into(),
                },
                "Capture for C:/work/app failed: Node could not start.",
                "Capture untuk C:/work/app gagal: Node could not start.",
            ),
            (
                Msg::CaptureFailed {
                    root: root(),
                    error: "Capture stopped after 3 restarts in 5 minutes".into(),
                },
                "Capture for C:/work/app failed: Capture stopped after 3 restarts in 5 minutes.",
                "Capture untuk C:/work/app gagal: Capture stopped after 3 restarts in 5 minutes.",
            ),
            (
                Msg::CaptureFailed {
                    root: root(),
                    error: String::new(),
                },
                "Capture for C:/work/app failed.",
                "Capture untuk C:/work/app gagal.",
            ),
            (
                Msg::CapturePolling { root: root() },
                "Capture for C:/work/app checks every 60 seconds; watching files failed.",
                "Capture untuk C:/work/app dicek setiap 60 detik; pemantauan file gagal.",
            ),
            (
                Msg::CaptureMore { n: 2 },
                "And 2 more repos.",
                "Dan 2 repo lagi.",
            ),
            (
                Msg::CaptureMore { n: 1 },
                "And 1 more repo.",
                "Dan 1 repo lagi.",
            ),
        ];
        for (msg, want_en, want_id) in cases {
            assert_eq!(en(&msg), want_en, "{msg:?}");
            assert_eq!(id(&msg), want_id, "{msg:?}");
        }
    }
}
