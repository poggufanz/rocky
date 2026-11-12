//! Model of the Settings setup sections: harness and shell switches, repo
//! decisions, history deletion and Remove Rocky. Rendering lives in
//! `ui/setup_settings.rs`; nothing here touches the wire or the window.

use std::io;

use rocky_proto::pipe::{
    CaptureHealth, CaptureState, ConsentState, PendingRepo, RepoDecisionState, RepoEntry,
    ServerMsg, SetupHealth, SetupTarget, TargetState,
};

use crate::i18n::{Msg, SetupMsg};
use crate::requests::{Outcome, RequestKind, Requests};
use crate::root_match::same_root;
use crate::settings_view::View;

/// The command that removes the command line itself, which Rocky cannot do.
pub const UNINSTALL_COMMAND: &str = "npm uninstall -g @poggufanz/rocky-cli";

/// One harness in the Settings list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HarnessRow {
    pub harness: String,
    pub on: bool,
    pub state: Msg,
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeRow {
    pub root: String,
    pub size: String,
    pub missing: bool,
}

impl WorktreeRow {
    /// A worktree whose folder is gone still has recorded history to delete.
    pub fn offers_delete(&self) -> bool {
        self.missing
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoRow {
    pub main: String,
    pub name: String,
    pub decision: Msg,
    pub allowed: bool,
    pub declined: bool,
    pub size: String,
    pub capture: Option<Msg>,
    pub worktrees: Vec<WorktreeRow>,
}

/// What the Allow and second buttons of a repo do right now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoButtons {
    pub allow_enabled: bool,
    /// Revoke for an allowed repo, "No" for one that was not asked.
    pub second: SetupMsg,
    pub second_enabled: bool,
}

impl RepoRow {
    /// Allow is off once allowed. Revoke needs an allowed repo; a repo not yet
    /// asked offers "No" instead, and a declined one has nothing to revoke.
    pub fn buttons(&self) -> RepoButtons {
        let not_asked = !self.allowed && !self.declined;
        RepoButtons {
            allow_enabled: !self.allowed,
            second: if not_asked {
                SetupMsg::RepoBannerNo
            } else {
                SetupMsg::RepoRevoke
            },
            second_enabled: self.allowed || not_asked,
        }
    }

    /// History exists to delete only for a repo that was decided.
    pub fn offers_delete(&self) -> bool {
        self.allowed || self.declined
    }
}

/// One control that owns a request pair and can show its own error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Control {
    Harness(String),
    Shell,
    Reinstall,
    /// Allow and Revoke for one main root.
    Repo(String),
    Purge(String),
}

impl Control {
    /// Every request kind that makes this control wait.
    pub fn kinds(&self) -> Vec<RequestKind> {
        match self {
            Control::Harness(h) => vec![
                RequestKind::HarnessOn(h.clone()),
                RequestKind::HarnessOff(h.clone()),
            ],
            Control::Shell => vec![RequestKind::ShellOn, RequestKind::ShellOff],
            Control::Reinstall => vec![RequestKind::Apply],
            Control::Repo(root) => vec![
                RequestKind::RepoAllow(root.clone()),
                RequestKind::RepoDecline(root.clone()),
            ],
            Control::Purge(root) => vec![RequestKind::RepoPurge(root.clone())],
        }
    }

    /// True while a request of this control is in flight.
    pub fn busy(&self, requests: &Requests) -> bool {
        requests.busy(&self.kinds())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemoveFlow {
    Idle,
    Confirm,
    Removing,
    Failed(String),
}

/// What the app does after an outcome reached the model.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Step {
    pub send_plan: bool,
    pub send_repo_list: bool,
    pub show_removed: bool,
}

/// What closing the window does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseAction {
    Hide,
    Quit,
}

/// Closing the window hides it, except on the final screen, which quits.
pub fn close_action(view: View) -> CloseAction {
    match view {
        View::Removed => CloseAction::Quit,
        View::Agents | View::Settings | View::Consent => CloseAction::Hide,
    }
}

const BYTES_PER_MIB: f64 = 1_048_576.0;

/// Size as MiB with one decimal.
pub fn format_mib(bytes: u64) -> String {
    format!("{:.1} MiB", bytes as f64 / BYTES_PER_MIB)
}

/// What one config entry says about its harness, from the plan or live health.
struct Probe {
    state: TargetState,
    error: Option<String>,
    repaired_ms: Option<u64>,
}

/// How much a state needs the owner's eye; the worst entry names the harness.
fn rank(state: TargetState) -> u8 {
    match state {
        TargetState::Foreign | TargetState::Refused | TargetState::Error | TargetState::Changed => {
            3
        }
        TargetState::Missing | TargetState::Stale | TargetState::NotConsented => 2,
        TargetState::Ok | TargetState::Written => 1,
    }
}

fn probe_msg(probes: &[Probe], fmt_time: &dyn Fn(u64) -> String) -> Msg {
    let Some(worst) = probes.iter().reduce(|best, p| {
        if rank(p.state) > rank(best.state) {
            p
        } else {
            best
        }
    }) else {
        return Msg::Setup(SetupMsg::HarnessNotInstalled);
    };
    let failed = |error: &Option<String>| {
        Msg::Setup(SetupMsg::HarnessFailed {
            error: error.clone().unwrap_or_default(),
        })
    };
    match worst.state {
        TargetState::Foreign => Msg::Setup(SetupMsg::HarnessForeign),
        TargetState::Refused | TargetState::Error | TargetState::Changed => failed(&worst.error),
        TargetState::Missing | TargetState::Stale if worst.error.is_some() => failed(&worst.error),
        TargetState::Missing | TargetState::Stale | TargetState::NotConsented => {
            Msg::Setup(SetupMsg::HarnessNotInstalled)
        }
        TargetState::Ok | TargetState::Written => {
            match probes.iter().filter_map(|p| p.repaired_ms).max() {
                Some(ms) => Msg::Setup(SetupMsg::HarnessRestored { time: fmt_time(ms) }),
                None => Msg::Setup(SetupMsg::HarnessOk),
            }
        }
    }
}

/// One row per harness seen in the plan or switched off. The state reads from
/// live health when it has targets for the harness, else from the plan.
pub fn harness_rows(
    plan_targets: &[SetupTarget],
    harness_off: &[String],
    setup: &SetupHealth,
    fmt_time: &dyn Fn(u64) -> String,
) -> Vec<HarnessRow> {
    let mut names: Vec<&str> = plan_targets
        .iter()
        .map(|t| t.harness.as_str())
        .chain(harness_off.iter().map(String::as_str))
        .collect();
    names.sort_unstable();
    names.dedup();
    names
        .into_iter()
        .map(|name| {
            let off = harness_off.iter().any(|h| h == name);
            let live: Vec<Probe> = setup
                .targets
                .iter()
                .filter(|t| t.harness == name)
                .map(|t| Probe {
                    state: t.state,
                    error: t.error.clone(),
                    repaired_ms: t.last_repair_ms,
                })
                .collect();
            let planned: Vec<&SetupTarget> =
                plan_targets.iter().filter(|t| t.harness == name).collect();
            let state = if off {
                Msg::Setup(SetupMsg::HarnessOff)
            } else if live.is_empty() {
                let probes: Vec<Probe> = planned
                    .iter()
                    .map(|t| Probe {
                        state: t.state,
                        error: t.detail.clone(),
                        repaired_ms: None,
                    })
                    .collect();
                probe_msg(&probes, fmt_time)
            } else {
                probe_msg(&live, fmt_time)
            };
            let mut paths: Vec<String> = planned.iter().map(|t| t.path.clone()).collect();
            paths.dedup();
            HarnessRow {
                harness: name.to_string(),
                on: !off,
                state,
                paths,
            }
        })
        .collect()
}

fn capture_msg(row: &CaptureHealth) -> Msg {
    Msg::Setup(match row.state {
        CaptureState::Starting => SetupMsg::CaptureStarting,
        CaptureState::Ok => SetupMsg::CaptureOk,
        CaptureState::Partial => SetupMsg::CapturePartial,
        CaptureState::Elsewhere => SetupMsg::CaptureElsewhere,
        CaptureState::Polling => SetupMsg::Polling {
            root: row.root.clone(),
        },
        CaptureState::Failed => SetupMsg::Failed {
            root: row.root.clone(),
            error: row.error.clone().unwrap_or_default(),
        },
    })
}

/// Decided repos, then repos still waiting for an answer.
pub fn repo_rows(
    repos: &[RepoEntry],
    pending: &[PendingRepo],
    capture: &[CaptureHealth],
) -> Vec<RepoRow> {
    let capture_of = |main: &str| {
        capture
            .iter()
            .find(|c| same_root(&c.root, main, cfg!(windows)))
            .map(capture_msg)
    };
    let decided = repos.iter().map(|r| {
        let (decision, allowed, declined) = match r.decision {
            RepoDecisionState::Allowed => (SetupMsg::RepoAllowed, true, false),
            RepoDecisionState::Declined => (SetupMsg::RepoDeclined, false, true),
            RepoDecisionState::Undecided => (SetupMsg::RepoNotAsked, false, false),
        };
        RepoRow {
            main: r.main.clone(),
            name: r.name.clone(),
            decision: Msg::Setup(decision),
            allowed,
            declined,
            size: format_mib(r.bytes),
            capture: capture_of(&r.main),
            worktrees: r
                .worktrees
                .iter()
                .map(|w| WorktreeRow {
                    root: w.root.clone(),
                    size: format_mib(w.bytes),
                    missing: !w.exists,
                })
                .collect(),
        }
    });
    let waiting = pending
        .iter()
        .filter(|p| !repos.iter().any(|r| r.key == p.key))
        .map(|p| RepoRow {
            main: p.main.clone(),
            name: p.name.clone(),
            decision: Msg::Setup(SetupMsg::RepoNotAsked),
            allowed: false,
            declined: false,
            size: format_mib(0),
            capture: capture_of(&p.main),
            worktrees: Vec::new(),
        });
    decided.chain(waiting).collect()
}

/// Plan, repo list, pending repos, errors and the two confirmations.
#[derive(Debug)]
pub struct SetupSettings {
    pub remove: RemoveFlow,
    plan: Option<Plan>,
    repos: Vec<RepoEntry>,
    pending: Vec<PendingRepo>,
    errors: Vec<(Control, String)>,
    purge_ask: Option<String>,
}

#[derive(Debug, Clone)]
struct Plan {
    consent: ConsentState,
    targets: Vec<SetupTarget>,
    harness_off: Vec<String>,
    shell_hook: bool,
}

impl Default for SetupSettings {
    fn default() -> Self {
        Self {
            remove: RemoveFlow::Idle,
            plan: None,
            repos: Vec::new(),
            pending: Vec::new(),
            errors: Vec::new(),
            purge_ask: None,
        }
    }
}

impl SetupSettings {
    pub fn targets(&self) -> &[SetupTarget] {
        self.plan.as_ref().map_or(&[], |p| &p.targets)
    }

    pub fn harness_off(&self) -> &[String] {
        self.plan.as_ref().map_or(&[], |p| &p.harness_off)
    }

    /// The shell hook switch as of the last plan; `None` before one arrived.
    pub fn shell_hook(&self) -> Option<bool> {
        self.plan.as_ref().map(|p| p.shell_hook)
    }

    pub fn consent(&self) -> Option<ConsentState> {
        self.plan.as_ref().map(|p| p.consent)
    }

    pub fn repos(&self) -> &[RepoEntry] {
        &self.repos
    }

    pub fn pending(&self) -> &[PendingRepo] {
        &self.pending
    }

    /// The error last shown on a control, until its next request starts.
    pub fn error(&self, control: &Control) -> Option<&str> {
        self.errors
            .iter()
            .find(|(c, _)| c == control)
            .map(|(_, e)| e.as_str())
    }

    /// Repos waiting for a decision arrive in the snapshot and on their own message.
    pub fn on_server_msg(&mut self, msg: &ServerMsg) {
        match msg {
            ServerMsg::Snapshot { repo_pending, .. } => self.pending = repo_pending.clone(),
            ServerMsg::RepoPending { repos } => self.pending = repos.clone(),
            _ => {}
        }
    }

    /// The request for a switch's next state: the opposite of `on`.
    pub fn harness_request(harness: &str, on: bool) -> RequestKind {
        if on {
            RequestKind::HarnessOff(harness.to_string())
        } else {
            RequestKind::HarnessOn(harness.to_string())
        }
    }

    /// The request for the shell switch's next state: the opposite of `on`.
    pub fn shell_request(on: bool) -> RequestKind {
        if on {
            RequestKind::ShellOff
        } else {
            RequestKind::ShellOn
        }
    }

    /// The agent tools section (harness rows, shell, reinstall) shows only once
    /// the owner approved setup.
    pub fn shows_agent_tools(&self) -> bool {
        self.consent() == Some(ConsentState::Approved)
    }

    /// A control's request is about to start: its old error goes away.
    pub fn clear_error(&mut self, control: &Control) {
        self.errors.retain(|(c, _)| c != control);
    }

    /// Show an error on a control, replacing the one it had.
    pub fn show_error(&mut self, control: Control, error: String) {
        self.clear_error(&control);
        self.errors.push((control, error));
    }

    pub fn ask_purge(&mut self, root: &str) {
        self.purge_ask = Some(root.to_string());
    }

    pub fn cancel_purge(&mut self) {
        self.purge_ask = None;
    }

    /// The root awaiting its second step, if any.
    pub fn purge_asked(&self) -> Option<&str> {
        self.purge_ask.as_deref()
    }

    /// Second step. True only when `root` was asked first.
    pub fn confirm_purge(&mut self, root: &str) -> bool {
        if self.purge_ask.as_deref() == Some(root) {
            self.purge_ask = None;
            return true;
        }
        false
    }

    pub fn ask_remove(&mut self) {
        if self.remove == RemoveFlow::Idle {
            self.remove = RemoveFlow::Confirm;
        }
    }

    pub fn cancel_remove(&mut self) {
        if self.remove == RemoveFlow::Confirm {
            self.remove = RemoveFlow::Idle;
        }
    }

    /// Second step, or Retry after a failure. Autostart goes off first.
    /// Returns None when no removal may start from here. Otherwise the caller
    /// must now send `Remove`, and the inner error, if any, is a failed
    /// autostart write to log: it never blocks the removal, because the rest
    /// of the removal matters more than a stale sign-in entry.
    pub fn begin_remove(
        &mut self,
        disable: &mut dyn FnMut() -> io::Result<()>,
    ) -> Option<Option<io::Error>> {
        if !matches!(self.remove, RemoveFlow::Confirm | RemoveFlow::Failed(_)) {
            return None;
        }
        let error = disable().err();
        self.remove = RemoveFlow::Removing;
        Some(error)
    }

    /// The Remove request could not be started.
    pub fn remove_not_sent(&mut self, error: String) {
        self.remove = RemoveFlow::Failed(error);
    }

    /// Route one request outcome. `expired` is the error shown when the daemon
    /// never answered. Kinds this section does not own are ignored.
    pub fn route(&mut self, kind: RequestKind, outcome: Outcome, expired: &str) -> Step {
        let outcome = match outcome {
            Outcome::Expired => Outcome::Done {
                ok: false,
                error: Some(expired.to_string()),
            },
            other => other,
        };
        let mut step = Step::default();
        match (kind, outcome) {
            (
                RequestKind::Plan,
                Outcome::Plan {
                    consent,
                    targets,
                    harness_off,
                    shell_hook,
                },
            ) => {
                self.plan = Some(Plan {
                    consent,
                    targets,
                    harness_off,
                    shell_hook,
                });
            }
            (RequestKind::RepoList, Outcome::Repos(repos)) => self.repos = repos,
            (RequestKind::Remove, Outcome::Done { ok, error }) => {
                if ok {
                    self.remove = RemoveFlow::Idle;
                    step.show_removed = true;
                } else {
                    self.remove = RemoveFlow::Failed(error.unwrap_or_default());
                }
            }
            (kind, Outcome::Done { ok, error }) => {
                let Some(control) = control_of(&kind) else {
                    return step;
                };
                if ok {
                    self.clear_error(&control);
                } else {
                    self.show_error(control, error.unwrap_or_default());
                }
                match kind {
                    RequestKind::RepoAllow(_)
                    | RequestKind::RepoDecline(_)
                    | RequestKind::RepoPurge(_) => step.send_repo_list = true,
                    _ => step.send_plan = true,
                }
            }
            _ => {}
        }
        step
    }
}

/// The control a switch or button request belongs to.
fn control_of(kind: &RequestKind) -> Option<Control> {
    match kind {
        RequestKind::HarnessOn(h) | RequestKind::HarnessOff(h) => Some(Control::Harness(h.clone())),
        RequestKind::ShellOn | RequestKind::ShellOff => Some(Control::Shell),
        RequestKind::Apply => Some(Control::Reinstall),
        RequestKind::RepoAllow(r) | RequestKind::RepoDecline(r) => Some(Control::Repo(r.clone())),
        RequestKind::RepoPurge(r) => Some(Control::Purge(r.clone())),
        RequestKind::Plan
        | RequestKind::Approve
        | RequestKind::Later
        | RequestKind::Remove
        | RequestKind::RepoList => None,
    }
}

#[cfg(test)]
mod tests;
