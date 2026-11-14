//! Tracks setup requests sent to the daemon: one in flight per kind, replies
//! matched by id, and a timeout so no control waits forever.

use rocky_proto::pipe::{ClientMsg, ConsentState, RepoEntry, ServerMsg, SetupAction, SetupTarget};

/// Node's 120 s guard plus slack.
pub const REQUEST_TIMEOUT_MS: u64 = 130_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RequestKind {
    Plan,
    Approve,
    Later,
    Apply,
    Remove,
    ShellOn,
    ShellOff,
    HarnessOn(String),
    HarnessOff(String),
    RepoList,
    RepoAllow(String),
    RepoDecline(String),
    RepoPurge(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Plan {
        consent: ConsentState,
        targets: Vec<SetupTarget>,
        harness_off: Vec<String>,
        shell_hook: bool,
    },
    Repos(Vec<RepoEntry>),
    Done {
        ok: bool,
        error: Option<String>,
        cleanup_errors: u32,
    },
    Expired,
}

/// The wire message that starts a request of this kind.
pub fn client_msg(kind: &RequestKind, id: u64) -> ClientMsg {
    let setup = |action| ClientMsg::Setup { id, action };
    match kind {
        RequestKind::Plan => setup(SetupAction::Plan),
        RequestKind::Approve => setup(SetupAction::ConsentApprove),
        RequestKind::Later => setup(SetupAction::ConsentLater),
        RequestKind::Apply => setup(SetupAction::Apply),
        RequestKind::Remove => setup(SetupAction::Remove),
        RequestKind::ShellOn => setup(SetupAction::ShellOn),
        RequestKind::ShellOff => setup(SetupAction::ShellOff),
        RequestKind::RepoList => setup(SetupAction::RepoList),
        RequestKind::HarnessOn(harness) => setup(SetupAction::HarnessOn {
            harness: harness.clone(),
        }),
        RequestKind::HarnessOff(harness) => setup(SetupAction::HarnessOff {
            harness: harness.clone(),
        }),
        RequestKind::RepoPurge(root) => setup(SetupAction::RepoPurge { root: root.clone() }),
        RequestKind::RepoAllow(root) => ClientMsg::RepoDecision {
            id,
            root: root.clone(),
            allow: true,
        },
        RequestKind::RepoDecline(root) => ClientMsg::RepoDecision {
            id,
            root: root.clone(),
            allow: false,
        },
    }
}

#[derive(Debug, Default)]
pub struct Requests {
    pending: Vec<(u64, RequestKind, u64)>,
}

impl Requests {
    /// Records a request. Returns false, recording nothing, when an equal kind is pending.
    pub fn start(&mut self, kind: RequestKind, id: u64, now_ms: u64) -> bool {
        if self.pending(&kind) {
            return false;
        }
        self.pending.push((id, kind, now_ms));
        true
    }

    /// Forgets a request that was recorded but never reached the wire.
    pub fn cancel(&mut self, id: u64) {
        self.pending.retain(|(pid, _, _)| *pid != id);
    }

    pub fn pending(&self, kind: &RequestKind) -> bool {
        self.pending.iter().any(|(_, k, _)| k == kind)
    }

    /// True when any of a control's kinds is pending, for example both halves of a switch.
    pub fn busy(&self, kinds: &[RequestKind]) -> bool {
        kinds.iter().any(|kind| self.pending(kind))
    }

    /// Matches a reply by id. Messages without an id, or with an unknown id, return None.
    pub fn on_message(&mut self, msg: &ServerMsg) -> Option<(RequestKind, Outcome)> {
        let (id, outcome) = match msg {
            ServerMsg::ConsentPlan {
                id,
                consent,
                targets,
                harness_off,
                shell_hook,
            } => (
                *id,
                Outcome::Plan {
                    consent: *consent,
                    targets: targets.clone(),
                    harness_off: harness_off.clone(),
                    shell_hook: *shell_hook,
                },
            ),
            ServerMsg::RepoList { id, repos } => (*id, Outcome::Repos(repos.clone())),
            ServerMsg::Ack {
                id,
                ok,
                error,
                cleanup_errors,
            } => (
                *id,
                Outcome::Done {
                    ok: *ok,
                    error: error.clone(),
                    cleanup_errors: *cleanup_errors,
                },
            ),
            _ => return None,
        };
        let index = self.pending.iter().position(|(pid, _, _)| *pid == id)?;
        let (_, kind, _) = self.pending.remove(index);
        Some((kind, outcome))
    }

    /// Removes and returns every request older than the timeout.
    pub fn expire(&mut self, now_ms: u64) -> Vec<(RequestKind, Outcome)> {
        let (old, kept): (Vec<_>, Vec<_>) = std::mem::take(&mut self.pending)
            .into_iter()
            .partition(|(_, _, at)| now_ms.saturating_sub(*at) > REQUEST_TIMEOUT_MS);
        self.pending = kept;
        old.into_iter()
            .map(|(_, kind, _)| (kind, Outcome::Expired))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rocky_proto::pipe::{ConsentState, ServerMsg};

    #[test]
    fn second_click_while_pending_sends_nothing() {
        let mut r = Requests::default();
        assert!(r.start(RequestKind::Plan, 1, 0));
        assert!(!r.start(RequestKind::Plan, 2, 10));
        assert!(r.pending(&RequestKind::Plan));
        assert!(r.start(RequestKind::Apply, 3, 10));
        assert!(r.start(RequestKind::HarnessOn("codex".into()), 4, 10));
        assert!(r.start(RequestKind::HarnessOn("gemini".into()), 5, 10));
        assert!(!r.start(RequestKind::HarnessOn("codex".into()), 6, 10));
    }

    #[test]
    fn cancel_drops_only_the_unsent_request() {
        let mut r = Requests::default();
        r.start(RequestKind::Apply, 1, 0);
        r.start(RequestKind::Plan, 2, 0);
        r.cancel(1);
        assert!(!r.pending(&RequestKind::Apply));
        assert!(r.pending(&RequestKind::Plan));
        // The same kind can start again at once instead of waiting for the timeout.
        assert!(r.start(RequestKind::Apply, 3, 1));
        assert!(r.expire(1).is_empty());
    }

    #[test]
    fn busy_covers_both_kinds_of_a_switch() {
        let mut r = Requests::default();
        let kinds = [
            RequestKind::HarnessOn("codex".into()),
            RequestKind::HarnessOff("codex".into()),
        ];
        assert!(!r.busy(&kinds));
        r.start(RequestKind::HarnessOff("codex".into()), 1, 0);
        assert!(r.busy(&kinds));
        assert!(!r.busy(&[RequestKind::ShellOn, RequestKind::ShellOff]));
    }

    #[test]
    fn ack_and_plan_and_repo_list_match_by_id() {
        let mut r = Requests::default();
        r.start(RequestKind::Apply, 1, 0);
        r.start(RequestKind::Plan, 2, 0);
        r.start(RequestKind::RepoList, 3, 0);
        let unknown = ServerMsg::Ack {
            id: 99,
            ok: true,
            error: None,
            cleanup_errors: 0,
        };
        assert!(r.on_message(&unknown).is_none());
        let ack = ServerMsg::Ack {
            id: 1,
            ok: false,
            error: Some("no".into()),
            cleanup_errors: 2,
        };
        assert_eq!(
            r.on_message(&ack),
            Some((
                RequestKind::Apply,
                Outcome::Done {
                    ok: false,
                    error: Some("no".into()),
                    cleanup_errors: 2,
                }
            ))
        );
        assert!(!r.pending(&RequestKind::Apply));
        assert!(r.on_message(&ack).is_none());
        let plan = ServerMsg::ConsentPlan {
            id: 2,
            consent: ConsentState::Later,
            targets: Vec::new(),
            harness_off: vec!["codex".into()],
            shell_hook: false,
        };
        let Some((
            RequestKind::Plan,
            Outcome::Plan {
                consent,
                harness_off,
                shell_hook,
                ..
            },
        )) = r.on_message(&plan)
        else {
            panic!("expected plan outcome");
        };
        assert_eq!(consent, ConsentState::Later);
        assert_eq!(harness_off, vec!["codex".to_string()]);
        assert!(!shell_hook);
        let list = ServerMsg::RepoList {
            id: 3,
            repos: Vec::new(),
        };
        assert_eq!(
            r.on_message(&list),
            Some((RequestKind::RepoList, Outcome::Repos(Vec::new())))
        );
    }

    #[test]
    fn request_expires_with_an_error() {
        let mut r = Requests::default();
        r.start(RequestKind::Apply, 1, 1_000);
        r.start(RequestKind::Plan, 2, 100_000);
        assert!(r.expire(1_000 + REQUEST_TIMEOUT_MS).is_empty());
        let gone = r.expire(1_001 + REQUEST_TIMEOUT_MS);
        assert_eq!(gone, vec![(RequestKind::Apply, Outcome::Expired)]);
        assert!(r.pending(&RequestKind::Plan));
        let late = ServerMsg::Ack {
            id: 1,
            ok: true,
            error: None,
            cleanup_errors: 0,
        };
        assert!(r.on_message(&late).is_none());
        assert!(r.start(RequestKind::Apply, 3, 200_000));
    }

    #[test]
    fn client_msg_maps_every_kind() {
        use rocky_proto::pipe::{ClientMsg, SetupAction};
        let setup = |action| ClientMsg::Setup { id: 7, action };
        let cases = [
            (RequestKind::Plan, setup(SetupAction::Plan)),
            (RequestKind::Approve, setup(SetupAction::ConsentApprove)),
            (RequestKind::Later, setup(SetupAction::ConsentLater)),
            (RequestKind::Apply, setup(SetupAction::Apply)),
            (RequestKind::Remove, setup(SetupAction::Remove)),
            (RequestKind::ShellOn, setup(SetupAction::ShellOn)),
            (RequestKind::ShellOff, setup(SetupAction::ShellOff)),
            (RequestKind::RepoList, setup(SetupAction::RepoList)),
            (
                RequestKind::HarnessOn("h".into()),
                setup(SetupAction::HarnessOn {
                    harness: "h".into(),
                }),
            ),
            (
                RequestKind::HarnessOff("h".into()),
                setup(SetupAction::HarnessOff {
                    harness: "h".into(),
                }),
            ),
            (
                RequestKind::RepoPurge("r".into()),
                setup(SetupAction::RepoPurge { root: "r".into() }),
            ),
            (
                RequestKind::RepoAllow("r".into()),
                ClientMsg::RepoDecision {
                    id: 7,
                    root: "r".into(),
                    allow: true,
                },
            ),
            (
                RequestKind::RepoDecline("r".into()),
                ClientMsg::RepoDecision {
                    id: 7,
                    root: "r".into(),
                    allow: false,
                },
            ),
        ];
        for (kind, expected) in cases {
            assert_eq!(client_msg(&kind, 7), expected);
        }
    }
}
