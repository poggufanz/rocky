//! Health-strip lines for the setup guard: which problems with Rocky's config
//! entries the desk reports, and in what order.

use rocky_proto::pipe::{ConsentState, FIGHT_LIMIT, SetupHealth, TargetHealth, TargetState};

use crate::i18n::Msg;

/// Target lines the strip shows before the "more" summary.
pub const SETUP_LINES: usize = 5;

/// Setup lines in display order. The new-version line shows whatever the consent
/// state is. Everything else shows only after the owner approved setup, because
/// without approval Rocky does not touch any config entry and has nothing to repair.
pub fn setup_lines(setup: &SetupHealth) -> Vec<Msg> {
    let mut lines = Vec::new();
    if setup.version_mismatch {
        lines.push(Msg::SetupNewVersion);
    }
    if setup.consent_state != ConsentState::Approved {
        return lines;
    }
    if !setup.cli_found {
        lines.push(Msg::SetupCliMissing {
            path: setup.cli_missing.clone(),
        });
    }
    let mut targets = setup.targets.iter().filter_map(target_line);
    lines.extend(targets.by_ref().take(SETUP_LINES));
    let cut = targets.count();
    if cut > 0 {
        lines.push(Msg::SetupMore { n: cut as u64 });
    }
    lines
}

/// The line for one target, or `None` when the target needs no report. A target
/// that keeps losing its entries reports that instead of its current state.
/// Only `path`, `error`, and (for a foreign entry) `harness` are read: the daemon
/// may send a row with empty `harness` and `kind` for a path it holds no target for.
fn target_line(t: &TargetHealth) -> Option<Msg> {
    let path = t.path.clone();
    let error = t.error.clone().unwrap_or_default();
    if t.fights_10m > FIGHT_LIMIT {
        return Some(Msg::SetupFighting {
            path,
            n: t.fights_10m,
        });
    }
    match t.state {
        TargetState::Missing | TargetState::Stale => Some(match &t.error {
            Some(error) => Msg::SetupRepairFailed {
                path,
                error: error.clone(),
            },
            None => Msg::SetupRepairing { path },
        }),
        TargetState::Changed => Some(Msg::SetupChanged { path }),
        TargetState::Foreign => Some(Msg::SetupForeign {
            harness: t.harness.clone(),
            path,
        }),
        TargetState::Refused => Some(Msg::SetupRefused { path, error }),
        TargetState::Error => Some(Msg::SetupRepairFailed { path, error }),
        TargetState::Ok | TargetState::Written | TargetState::NotConsented => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::i18n::{en, id};
    use crate::view::{Conn, Model};
    use rocky_proto::pipe::{Gap, GapReason, Health, ServerMsg};

    fn target(state: TargetState, harness: &str, path: &str) -> TargetHealth {
        TargetHealth {
            harness: harness.into(),
            kind: "mcp".into(),
            path: path.into(),
            state,
            last_repair_ms: None,
            fights_10m: 0,
            error: None,
        }
    }

    fn approved(targets: Vec<TargetHealth>) -> SetupHealth {
        SetupHealth {
            consent_state: ConsentState::Approved,
            cli_found: true,
            cli_missing: None,
            version_mismatch: false,
            targets,
        }
    }

    #[test]
    fn warnings_place_setup_lines_after_settings_and_before_gaps() {
        let mut model = Model::new();
        model.apply(ServerMsg::Health {
            health: Health {
                settings_unreadable: true,
                gaps: vec![Gap {
                    from_ms: 1_000,
                    to_ms: 2_000,
                    count: 2,
                    reason: GapReason::SpoolFull,
                }],
                setup: SetupHealth {
                    version_mismatch: true,
                    ..approved(vec![target(TargetState::Changed, "codex", "/h/a.json")])
                },
                ..Default::default()
            },
        });
        model.set_conn(Conn::Disconnected);
        let w = model.warnings(&crate::clock::utc_hhmm);
        assert_eq!(w.len(), 5, "{w:?}");
        assert_eq!(w[0], Msg::SettingsUnreadable);
        assert_eq!(w[1], Msg::SetupNewVersion);
        assert_eq!(
            w[2],
            Msg::SetupChanged {
                path: "/h/a.json".into()
            }
        );
        assert!(matches!(w[3], Msg::Gap { .. }), "{w:?}");
        assert_eq!(w[4], Msg::ConnDisconnected);
    }

    #[test]
    fn default_health_adds_no_setup_lines() {
        assert!(setup_lines(&SetupHealth::default()).is_empty());
    }

    #[test]
    fn setup_lines_follow_target_state() {
        let mut setup = approved(vec![
            target(TargetState::Ok, "codex", "/h/codex.toml"),
            target(TargetState::Missing, "codex", "/h/missing.json"),
            target(TargetState::Written, "codex", "/h/written.json"),
            target(TargetState::Changed, "codex", "/h/changed.json"),
            target(TargetState::Foreign, "gemini-cli", "/h/foreign.json"),
            target(TargetState::NotConsented, "codex", "/h/later.json"),
            target(TargetState::Refused, "codex", "/h/refused.json"),
        ]);
        setup.targets[6].error = Some("path is outside the home folder".into());
        assert_eq!(
            setup_lines(&setup),
            vec![
                Msg::SetupRepairing {
                    path: "/h/missing.json".into()
                },
                Msg::SetupChanged {
                    path: "/h/changed.json".into()
                },
                Msg::SetupForeign {
                    harness: "gemini-cli".into(),
                    path: "/h/foreign.json".into()
                },
                Msg::SetupRefused {
                    path: "/h/refused.json".into(),
                    error: "path is outside the home folder".into()
                },
            ]
        );
    }

    #[test]
    fn missing_stale_and_error_lines_depend_on_the_error_text() {
        let mut stale_failed = target(TargetState::Stale, "codex", "/h/stale.json");
        stale_failed.error = Some("still missing after setup ran".into());
        let mut missing_failed = target(TargetState::Missing, "", "/h/gone.json");
        missing_failed.error = Some("Node did not finish within 120 seconds".into());
        let setup = approved(vec![
            stale_failed,
            missing_failed,
            target(TargetState::Stale, "codex", "/h/stale2.json"),
            target(TargetState::Error, "codex", "/h/error.json"),
            target(TargetState::Refused, "codex", "/h/refused.json"),
        ]);
        assert_eq!(
            setup_lines(&setup),
            vec![
                Msg::SetupRepairFailed {
                    path: "/h/stale.json".into(),
                    error: "still missing after setup ran".into()
                },
                Msg::SetupRepairFailed {
                    path: "/h/gone.json".into(),
                    error: "Node did not finish within 120 seconds".into()
                },
                Msg::SetupRepairing {
                    path: "/h/stale2.json".into()
                },
                Msg::SetupRepairFailed {
                    path: "/h/error.json".into(),
                    error: String::new()
                },
                Msg::SetupRefused {
                    path: "/h/refused.json".into(),
                    error: String::new()
                },
            ]
        );
    }

    #[test]
    fn setup_lines_hidden_without_approved_consent() {
        for consent in [
            ConsentState::None,
            ConsentState::Later,
            ConsentState::Removed,
            ConsentState::Invalid,
        ] {
            let mut setup = approved(vec![
                target(TargetState::Missing, "codex", "/h/a.json"),
                target(TargetState::Error, "codex", "/h/b.json"),
            ]);
            setup.consent_state = consent;
            setup.cli_found = false;
            assert!(setup_lines(&setup).is_empty(), "{consent:?}");
            setup.version_mismatch = true;
            assert_eq!(
                setup_lines(&setup),
                vec![Msg::SetupNewVersion],
                "{consent:?}"
            );
        }
    }

    #[test]
    fn version_line_comes_first_and_cli_line_before_targets() {
        let mut setup = approved(vec![target(TargetState::Changed, "codex", "/h/a.json")]);
        setup.version_mismatch = true;
        setup.cli_found = false;
        setup.cli_missing = Some("/opt/rocky/dist/index.js".into());
        assert_eq!(
            setup_lines(&setup),
            vec![
                Msg::SetupNewVersion,
                Msg::SetupCliMissing {
                    path: Some("/opt/rocky/dist/index.js".into())
                },
                Msg::SetupChanged {
                    path: "/h/a.json".into()
                },
            ]
        );
    }

    #[test]
    fn fighting_wins_over_state_line() {
        let mut fighting = target(TargetState::Missing, "codex", "/h/fight.json");
        fighting.fights_10m = FIGHT_LIMIT + 1;
        let mut at_limit = target(TargetState::Missing, "codex", "/h/limit.json");
        at_limit.fights_10m = FIGHT_LIMIT;
        let mut errored = target(TargetState::Error, "codex", "/h/err.json");
        errored.fights_10m = FIGHT_LIMIT + 4;
        errored.error = Some("boom".into());
        let setup = approved(vec![fighting, at_limit, errored]);
        assert_eq!(
            setup_lines(&setup),
            vec![
                Msg::SetupFighting {
                    path: "/h/fight.json".into(),
                    n: FIGHT_LIMIT + 1
                },
                Msg::SetupRepairing {
                    path: "/h/limit.json".into()
                },
                Msg::SetupFighting {
                    path: "/h/err.json".into(),
                    n: FIGHT_LIMIT + 4
                },
            ]
        );
    }

    #[test]
    fn setup_lines_are_bounded() {
        let eight: Vec<_> = (0..8)
            .map(|i| target(TargetState::Error, "codex", &format!("/h/{i}.json")))
            .collect();
        let lines = setup_lines(&approved(eight));
        assert_eq!(lines.len(), SETUP_LINES + 1);
        assert_eq!(
            lines[0],
            Msg::SetupRepairFailed {
                path: "/h/0.json".into(),
                error: String::new()
            }
        );
        assert_eq!(
            lines[4],
            Msg::SetupRepairFailed {
                path: "/h/4.json".into(),
                error: String::new()
            }
        );
        assert_eq!(lines[5], Msg::SetupMore { n: 3 });
    }

    #[test]
    fn exactly_five_target_lines_have_no_summary_and_ok_rows_do_not_count() {
        let mut targets: Vec<_> = (0..5)
            .map(|i| target(TargetState::Changed, "codex", &format!("/h/{i}.json")))
            .collect();
        targets.push(target(TargetState::Ok, "codex", "/h/ok.json"));
        targets.push(target(TargetState::Written, "codex", "/h/written.json"));
        let lines = setup_lines(&approved(targets));
        assert_eq!(lines.len(), 5);
        assert!(lines.iter().all(|m| matches!(m, Msg::SetupChanged { .. })));
    }

    #[test]
    fn version_and_cli_lines_do_not_count_toward_the_bound() {
        let mut setup = approved(
            (0..5)
                .map(|i| target(TargetState::Changed, "codex", &format!("/h/{i}.json")))
                .collect(),
        );
        setup.version_mismatch = true;
        setup.cli_found = false;
        let lines = setup_lines(&setup);
        assert_eq!(lines.len(), 7);
        assert!(!lines.iter().any(|m| matches!(m, Msg::SetupMore { .. })));
    }

    #[test]
    fn cli_missing_names_the_path() {
        let named = Msg::SetupCliMissing {
            path: Some("C:/rocky/dist/index.js".into()),
        };
        assert_eq!(
            en(&named),
            "C:/rocky/dist/index.js is gone. Run rocky once so Rocky can repair its entries."
        );
        assert_eq!(
            id(&named),
            "C:/rocky/dist/index.js sudah tidak ada. Jalankan rocky sekali supaya Rocky bisa memperbaiki entrinya."
        );
        let unknown = Msg::SetupCliMissing { path: None };
        assert_eq!(
            en(&unknown),
            "Rocky does not know where its command line is. Run rocky once."
        );
        assert_eq!(
            id(&unknown),
            "Rocky tidak tahu letak command line-nya. Jalankan rocky sekali."
        );
    }

    #[test]
    fn setup_copy_matches_the_catalog() {
        let path = || "/h/c.json".to_string();
        let error = || "Node did not finish within 120 seconds".to_string();
        let cases = [
            (
                Msg::SetupNewVersion,
                "New version installed. Run rocky once to use it.",
                "Versi baru terpasang. Jalankan rocky sekali untuk memakainya.",
            ),
            (
                Msg::SetupRepairing { path: path() },
                "Restoring Rocky entries in /h/c.json.",
                "Memasang ulang entri Rocky di /h/c.json.",
            ),
            (
                Msg::SetupRepairFailed {
                    path: path(),
                    error: error(),
                },
                "Cannot restore Rocky entries in /h/c.json: Node did not finish within 120 seconds.",
                "Tidak bisa memasang ulang entri Rocky di /h/c.json: Node did not finish within 120 seconds.",
            ),
            (
                Msg::SetupChanged { path: path() },
                "/h/c.json changed while Rocky was writing it. Trying again.",
                "/h/c.json berubah saat Rocky menulisnya. Mencoba lagi.",
            ),
            (
                Msg::SetupForeign {
                    harness: "gemini-cli".into(),
                    path: path(),
                },
                "/h/c.json has a rocky server Rocky did not write, so Rocky leaves gemini-cli alone.",
                "/h/c.json punya server rocky yang bukan tulisan Rocky, jadi Rocky tidak menyentuh gemini-cli.",
            ),
            (
                Msg::SetupRefused {
                    path: path(),
                    error: "path is outside the home folder".into(),
                },
                "Rocky will not write /h/c.json: path is outside the home folder.",
                "Rocky tidak mau menulis /h/c.json: path is outside the home folder.",
            ),
            (
                Msg::SetupFighting { path: path(), n: 6 },
                "/h/c.json keeps losing Rocky entries (6 times in 10 minutes).",
                "/h/c.json terus kehilangan entri Rocky (6 kali dalam 10 menit).",
            ),
            (
                Msg::SetupMore { n: 3 },
                "3 more setup problems.",
                "3 masalah setup lain.",
            ),
            (
                Msg::SetupMore { n: 1 },
                "1 more setup problem.",
                "1 masalah setup lain.",
            ),
        ];
        for (msg, want_en, want_id) in cases {
            assert_eq!(en(&msg), want_en, "{msg:?}");
            assert_eq!(id(&msg), want_id, "{msg:?}");
        }
    }

    #[test]
    fn error_text_is_shown_as_data_without_doubling_the_final_period() {
        let msg = Msg::SetupRepairFailed {
            path: "/h/c.json".into(),
            error: "Unexpected token.".into(),
        };
        assert_eq!(
            en(&msg),
            "Cannot restore Rocky entries in /h/c.json: Unexpected token."
        );
        assert_eq!(
            id(&msg),
            "Tidak bisa memasang ulang entri Rocky di /h/c.json: Unexpected token."
        );
    }

    #[test]
    fn empty_error_text_leaves_out_the_colon() {
        let failed = Msg::SetupRepairFailed {
            path: "/h/c.json".into(),
            error: String::new(),
        };
        assert_eq!(en(&failed), "Cannot restore Rocky entries in /h/c.json.");
        assert_eq!(
            id(&failed),
            "Tidak bisa memasang ulang entri Rocky di /h/c.json."
        );
        let refused = Msg::SetupRefused {
            path: "/h/c.json".into(),
            error: String::new(),
        };
        assert_eq!(en(&refused), "Rocky will not write /h/c.json.");
        assert_eq!(id(&refused), "Rocky tidak mau menulis /h/c.json.");
    }
}
