//! Model of the first-use consent screen: the plan rows, the Agree and Later
//! flow, and when the screen opens by itself. Rendering lives in `ui/consent.rs`.

use std::io;

use rocky_proto::pipe::{ConsentState, SetupTarget, TargetHealth, TargetState};

use crate::i18n::{Msg, SetupMsg};
use crate::requests::{Outcome, RequestKind};
use crate::setup_lines::target_line;

/// True when the consent screen should open by itself at window start.
pub fn should_open_consent(tray_start: bool, consent: ConsentState) -> bool {
    !tray_start
        && matches!(
            consent,
            ConsentState::None | ConsentState::Removed | ConsentState::Invalid
        )
}

/// The settings "Install" row shows until setup is approved.
pub fn show_install_row(consent: ConsentState) -> bool {
    matches!(
        consent,
        ConsentState::None | ConsentState::Later | ConsentState::Removed
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanRow {
    pub harness: String,
    pub kind: String,
    pub path: String,
    pub installed: bool,
    pub failure: Option<Msg>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Stage {
    Loading,
    Ready,
    Applying,
    Result,
    Failed(String),
}

/// What the app does after a request outcome reached the model.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Step {
    pub send_plan: bool,
    pub log: Option<String>,
}

/// Why no plan is shown. Only a real answer means Node is missing; the other
/// two say the daemon was unreachable, which a later health message can fix.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlanFailure {
    CliMissing,
    TimedOut,
    NotConnected,
}

#[derive(Debug)]
pub struct ConsentModel {
    pub rows: Vec<PlanRow>,
    pub autostart: bool,
    pub stage: Stage,
    pub plan_failure: Option<PlanFailure>,
    consent: ConsentState,
    first_health_seen: bool,
    answered: bool,
}

impl Default for ConsentModel {
    fn default() -> Self {
        Self {
            rows: Vec::new(),
            autostart: true,
            stage: Stage::Loading,
            plan_failure: None,
            consent: ConsentState::None,
            first_health_seen: false,
            answered: false,
        }
    }
}

/// The copy that explains one kind of plan failure.
pub fn plan_failure_msg(why: PlanFailure) -> SetupMsg {
    match why {
        PlanFailure::CliMissing => SetupMsg::CliMissing { path: None },
        PlanFailure::TimedOut => SetupMsg::RequestTimedOut,
        PlanFailure::NotConnected => SetupMsg::ConsentNotConnected,
    }
}

/// The failure line for one plan row, if its state is a failure. A missing or
/// stale entry is just work to do, so it has none.
fn failure_of(t: &SetupTarget) -> Option<Msg> {
    if !matches!(
        t.state,
        TargetState::Changed | TargetState::Foreign | TargetState::Refused | TargetState::Error
    ) {
        return None;
    }
    target_line(&TargetHealth {
        harness: t.harness.clone(),
        kind: t.kind.clone(),
        path: t.path.clone(),
        state: t.state,
        last_repair_ms: None,
        fights_10m: 0,
        error: t.detail.clone(),
    })
}

impl ConsentModel {
    /// Feed a health or snapshot's consent state. Returns true when the screen
    /// should open: only the first one after connecting decides, and never
    /// after the owner has answered.
    pub fn on_health(&mut self, consent: ConsentState, tray_start: bool) -> bool {
        self.consent = consent;
        if self.first_health_seen {
            return false;
        }
        self.first_health_seen = true;
        !self.answered && should_open_consent(tray_start, consent)
    }

    /// Consent state as last reported by the daemon.
    pub fn consent(&self) -> ConsentState {
        self.consent
    }

    /// The owner answered Agree or Later during this run.
    pub fn answered(&self) -> bool {
        self.answered
    }

    /// Start a fresh pass; the caller requests the plan.
    pub fn open(&mut self) {
        self.rows.clear();
        self.plan_failure = None;
        self.stage = Stage::Loading;
    }

    /// The plan request could not be started. With another Plan already
    /// pending the stage resolves when that one answers or expires; otherwise
    /// nothing will ever resolve it, so it fails now.
    pub fn plan_not_sent(&mut self, already_pending: bool) {
        if !already_pending {
            self.on_plan_failed(PlanFailure::NotConnected);
        }
    }

    /// A health or snapshot arrived while the screen shows an unreachable
    /// failure: clear it and return true so the caller asks for the plan again.
    pub fn retry_plan_on_health(&mut self) -> bool {
        if !matches!(
            self.plan_failure,
            Some(PlanFailure::TimedOut | PlanFailure::NotConnected)
        ) {
            return false;
        }
        self.plan_failure = None;
        if self.stage == Stage::Ready {
            self.stage = Stage::Loading;
        }
        true
    }

    pub fn on_plan(&mut self, targets: &[SetupTarget]) {
        self.rows = targets
            .iter()
            .map(|t| PlanRow {
                harness: t.harness.clone(),
                kind: t.kind.clone(),
                path: t.path.clone(),
                installed: t.state == TargetState::Ok,
                failure: failure_of(t),
            })
            .collect();
        self.plan_failure = None;
        self.stage = self.stage_after_plan();
    }

    fn stage_after_plan(&self) -> Stage {
        match self.stage {
            Stage::Applying | Stage::Result => Stage::Result,
            _ => Stage::Ready,
        }
    }

    fn on_plan_failed(&mut self, why: PlanFailure) {
        self.plan_failure = Some(why);
        self.stage = self.stage_after_plan();
    }

    pub fn can_agree(&self) -> bool {
        self.plan_failure.is_none() && matches!(self.stage, Stage::Ready | Stage::Failed(_))
    }

    pub fn can_later(&self) -> bool {
        self.stage != Stage::Applying
    }

    /// Enter the applying stage. Autostart is registered first when checked;
    /// a failure comes back to be logged and never blocks the approval.
    pub fn begin_agree(&mut self, enable: &mut dyn FnMut() -> io::Result<()>) -> Option<io::Error> {
        let error = if self.autostart { enable().err() } else { None };
        self.stage = Stage::Applying;
        error
    }

    /// Later was chosen: the screen will not reopen on its own this run.
    pub fn later(&mut self) {
        self.answered = true;
    }

    pub fn on_approve_done(&mut self, ok: bool, error: Option<String>) {
        if ok {
            self.answered = true;
        } else {
            self.stage = Stage::Failed(error.unwrap_or_default());
        }
    }

    /// Returns the error to log when the Later request failed.
    pub fn on_later_done(&mut self, ok: bool, error: Option<String>) -> Option<String> {
        if ok {
            None
        } else {
            Some(error.unwrap_or_default())
        }
    }

    /// Route one request outcome. `expired` is the error shown when the
    /// daemon never answered. Kinds this screen does not own are ignored.
    pub fn route(&mut self, kind: RequestKind, outcome: Outcome, expired: &str) -> Step {
        // A plan that went unanswered is not a missing CLI, so it keeps its own failure.
        if kind == RequestKind::Plan && outcome == Outcome::Expired {
            self.on_plan_failed(PlanFailure::TimedOut);
            return Step::default();
        }
        let outcome = match outcome {
            Outcome::Expired => Outcome::Done {
                ok: false,
                error: Some(expired.to_string()),
            },
            other => other,
        };
        let mut step = Step::default();
        match (kind, outcome) {
            (RequestKind::Plan, Outcome::Plan { targets, .. }) => self.on_plan(&targets),
            (RequestKind::Plan, Outcome::Done { ok: false, .. }) => {
                self.on_plan_failed(PlanFailure::CliMissing);
            }
            (RequestKind::Approve, Outcome::Done { ok, error }) => {
                self.on_approve_done(ok, error);
                step.send_plan = ok;
            }
            (RequestKind::Later, Outcome::Done { ok, error }) => {
                step.log = self.on_later_done(ok, error);
            }
            _ => {}
        }
        step
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rocky_proto::pipe::TargetState;

    fn target(harness: &str, state: TargetState) -> SetupTarget {
        SetupTarget {
            harness: harness.into(),
            kind: "mcp".into(),
            path: format!("C:/h/{harness}.json"),
            state,
            detail: None,
        }
    }

    fn ok_enable() -> io::Result<()> {
        Ok(())
    }

    #[test]
    fn opens_for_none_removed_invalid_only_without_tray() {
        for c in [
            ConsentState::None,
            ConsentState::Removed,
            ConsentState::Invalid,
        ] {
            assert!(should_open_consent(false, c), "{c:?}");
            assert!(!should_open_consent(true, c), "{c:?}");
        }
        for c in [ConsentState::Approved, ConsentState::Later] {
            assert!(!should_open_consent(false, c), "{c:?}");
        }
    }

    #[test]
    fn opens_only_on_the_first_health_and_never_again_once_answered() {
        let mut m = ConsentModel::default();
        assert!(m.on_health(ConsentState::None, false));
        assert!(!m.on_health(ConsentState::None, false));
        let mut approved = ConsentModel::default();
        assert!(!approved.on_health(ConsentState::Approved, false));
        assert!(!approved.on_health(ConsentState::None, false));
        let mut tray = ConsentModel::default();
        assert!(!tray.on_health(ConsentState::None, true));
    }

    #[test]
    fn install_row_shows_until_approved() {
        assert!(show_install_row(ConsentState::Later));
        assert!(show_install_row(ConsentState::None));
        assert!(show_install_row(ConsentState::Removed));
        assert!(!show_install_row(ConsentState::Approved));
    }

    #[test]
    fn plan_rows_mark_installed_and_failures() {
        let mut m = ConsentModel::default();
        m.open();
        let mut refused = target("codex", TargetState::Refused);
        refused.detail = Some("outside home".into());
        m.on_plan(&[
            target("claude-code", TargetState::Ok),
            target("opencode", TargetState::Missing),
            refused,
        ]);
        assert_eq!(m.stage, Stage::Ready);
        assert!(m.rows[0].installed && m.rows[0].failure.is_none());
        assert!(!m.rows[1].installed && m.rows[1].failure.is_none());
        assert_eq!(
            m.rows[2].failure,
            Some(Msg::Setup(SetupMsg::Refused {
                path: "C:/h/codex.json".into(),
                error: "outside home".into()
            }))
        );
    }

    #[test]
    fn approve_flow_ends_in_result_after_fresh_plan() {
        let mut m = ConsentModel::default();
        m.open();
        assert_eq!(m.stage, Stage::Loading);
        assert!(!m.can_agree());
        m.on_plan(&[target("claude-code", TargetState::Missing)]);
        assert!(m.can_agree());
        assert!(m.begin_agree(&mut ok_enable).is_none());
        assert_eq!(m.stage, Stage::Applying);
        assert!(!m.can_agree() && !m.can_later());
        let step = m.route(
            RequestKind::Approve,
            Outcome::Done {
                ok: true,
                error: None,
            },
            "late",
        );
        assert!(step.send_plan);
        assert_eq!(m.stage, Stage::Applying);
        m.on_plan(&[target("claude-code", TargetState::Ok)]);
        assert_eq!(m.stage, Stage::Result);
        assert!(m.rows[0].installed);
        assert!(m.answered());
    }

    #[test]
    fn failed_or_expired_approve_allows_retry() {
        let mut m = ConsentModel::default();
        m.open();
        m.on_plan(&[target("codex", TargetState::Missing)]);
        m.begin_agree(&mut ok_enable);
        let step = m.route(
            RequestKind::Approve,
            Outcome::Done {
                ok: false,
                error: Some("boom".into()),
            },
            "late",
        );
        assert!(!step.send_plan);
        assert_eq!(m.stage, Stage::Failed("boom".into()));
        assert!(m.can_agree() && !m.answered());
        m.begin_agree(&mut ok_enable);
        m.route(RequestKind::Approve, Outcome::Expired, "late");
        assert_eq!(m.stage, Stage::Failed("late".into()));
    }

    #[test]
    fn plan_failure_shows_cli_hint_and_later_closes() {
        let mut m = ConsentModel::default();
        m.open();
        m.route(
            RequestKind::Plan,
            Outcome::Done {
                ok: false,
                error: Some("no cli".into()),
            },
            "late",
        );
        assert_eq!(m.plan_failure, Some(PlanFailure::CliMissing));
        assert!(!m.can_agree());
        assert!(m.can_later());
        m.later();
        assert!(m.answered());
        let step = m.route(
            RequestKind::Later,
            Outcome::Done {
                ok: false,
                error: Some("down".into()),
            },
            "late",
        );
        assert_eq!(step.log.as_deref(), Some("down"));
        let mut expired = ConsentModel::default();
        expired.open();
        expired.route(RequestKind::Plan, Outcome::Expired, "late");
        assert_eq!(expired.plan_failure, Some(PlanFailure::TimedOut));
        assert!(expired.can_later() && !expired.can_agree());
    }

    fn applied_after_ok_approve() -> ConsentModel {
        let mut m = ConsentModel::default();
        m.open();
        m.on_plan(&[target("codex", TargetState::Missing)]);
        m.begin_agree(&mut ok_enable);
        let step = m.route(
            RequestKind::Approve,
            Outcome::Done {
                ok: true,
                error: None,
            },
            "late",
        );
        assert!(step.send_plan);
        m
    }

    #[test]
    fn post_approve_plan_not_sent_leaves_the_applying_stage() {
        let mut m = applied_after_ok_approve();
        assert_eq!(m.stage, Stage::Applying);
        m.plan_not_sent(false);
        assert_eq!(m.stage, Stage::Result);
        assert_eq!(m.plan_failure, Some(PlanFailure::NotConnected));
        assert!(m.can_later());
    }

    #[test]
    fn pending_plan_still_resolves_the_applying_stage() {
        let mut m = applied_after_ok_approve();
        m.plan_not_sent(true);
        assert_eq!(m.stage, Stage::Applying);
        m.route(RequestKind::Plan, Outcome::Expired, "late");
        assert_eq!(m.stage, Stage::Result);
        let mut answered = applied_after_ok_approve();
        answered.plan_not_sent(true);
        answered.on_plan(&[target("codex", TargetState::Ok)]);
        assert_eq!(answered.stage, Stage::Result);
    }

    #[test]
    fn opening_without_a_connection_fails_as_not_connected() {
        let mut m = ConsentModel::default();
        m.open();
        m.plan_not_sent(false);
        assert_eq!(m.plan_failure, Some(PlanFailure::NotConnected));
        assert_eq!(m.stage, Stage::Ready);
    }

    #[test]
    fn health_clears_an_unreachable_failure_and_asks_for_the_plan_again() {
        let mut m = ConsentModel::default();
        m.open();
        m.route(RequestKind::Plan, Outcome::Expired, "late");
        assert!(m.retry_plan_on_health());
        assert_eq!(m.plan_failure, None);
        assert_eq!(m.stage, Stage::Loading);
        m.plan_not_sent(false);
        assert!(m.retry_plan_on_health());
        m.on_plan(&[target("codex", TargetState::Missing)]);
        assert_eq!(m.stage, Stage::Ready);
        assert!(!m.retry_plan_on_health());
    }

    #[test]
    fn a_real_failed_answer_is_not_retried_on_health() {
        let mut m = ConsentModel::default();
        m.open();
        m.route(
            RequestKind::Plan,
            Outcome::Done {
                ok: false,
                error: None,
            },
            "late",
        );
        assert!(!m.retry_plan_on_health());
        assert_eq!(m.plan_failure, Some(PlanFailure::CliMissing));
    }

    #[test]
    fn retry_after_a_post_approve_failure_keeps_the_result_stage() {
        let mut m = applied_after_ok_approve();
        m.plan_not_sent(false);
        assert!(m.retry_plan_on_health());
        assert_eq!(m.stage, Stage::Result);
        m.on_plan(&[target("codex", TargetState::Ok)]);
        assert_eq!(m.stage, Stage::Result);
        assert!(m.rows[0].installed);
    }

    #[test]
    fn plan_failure_copy_differs_by_kind() {
        let msgs = [
            plan_failure_msg(PlanFailure::CliMissing),
            plan_failure_msg(PlanFailure::TimedOut),
            plan_failure_msg(PlanFailure::NotConnected),
        ];
        assert_eq!(msgs[0], SetupMsg::CliMissing { path: None });
        assert_eq!(msgs[1], SetupMsg::RequestTimedOut);
        assert_eq!(msgs[2], SetupMsg::ConsentNotConnected);
    }

    #[test]
    fn autostart_unchecked_is_not_enabled() {
        let mut calls = 0;
        let mut m = ConsentModel::default();
        m.open();
        m.on_plan(&[]);
        m.autostart = false;
        m.begin_agree(&mut || {
            calls += 1;
            Ok(())
        });
        assert_eq!(calls, 0);
        let mut checked = ConsentModel::default();
        checked.open();
        checked.on_plan(&[]);
        assert!(checked.autostart);
        let mut calls = 0;
        let err = checked.begin_agree(&mut || {
            calls += 1;
            Err(io::Error::other("no run key"))
        });
        assert_eq!(calls, 1);
        assert!(err.is_some());
        assert_eq!(checked.stage, Stage::Applying);
    }
}
