//! Client requests, config-dir discovery, and repo status for the guard.
//!
//! Each job queued here runs Node. The guard queues the jobs and turns each
//! outcome into replies, log lines, and pending-repo changes. It starts no
//! process itself.

use std::collections::BTreeSet;

use rocky_proto::pipe::{ConsentState, PendingRepo, ServerMsg, SetupAction};

use super::node::{AutoResult, RepoDecisionState, RepoVerdict, RunError};
use super::{Effect, Guard, Job};

/// Harness ids the `setup` and discovery paths accept. Matches the Node MCP harness list.
const HARNESS_IDS: [&str; 5] = [
    "claude-code",
    "codex",
    "opencode",
    "gemini-cli",
    "copilot-cli",
];

/// Whether `harness` is one of the ids Node's `setup --auto` accepts.
fn is_known_harness(harness: &str) -> bool {
    HARNESS_IDS.contains(&harness)
}

impl Guard {
    /// Queues a client `setup` request. A harness outside the known list is
    /// refused at once: the reply is returned and no job is queued.
    pub fn setup_request(&mut self, token: u64, id: u64, action: SetupAction) -> Option<Effect> {
        if let Some(harness) = unknown_harness(&action) {
            let error = Some(format!("unknown harness {harness}"));
            let msg = ServerMsg::Ack {
                id,
                ok: false,
                error,
            };
            return Some(Effect::Reply { token, msg });
        }
        self.requests.push_back(Job::Setup { token, id, action });
        None
    }

    /// Queues a client `repo_decision` request.
    pub fn repo_request(&mut self, token: u64, id: u64, root: String, allow: bool) {
        self.requests.push_back(Job::RepoDecision {
            token,
            id,
            root,
            allow,
        });
    }

    /// Queues a repo status job for a session's root. Each root is queued once.
    pub fn session_root(&mut self, root: &str) {
        if self.queued_roots.insert(root.to_string()) {
            let job = Job::RepoStatus {
                root: root.to_string(),
            };
            self.repo_status.push_back(job);
        }
    }

    /// Queues a config-dir job for a `(harness, location)` pair a harness reported.
    ///
    /// Queues only under approved consent, for a known harness id, and only for a
    /// pair that is not recorded yet and was not queued before in this daemon run.
    /// An empty location is ignored.
    pub fn discovered(&mut self, harness: &str, location: &str) {
        if !is_known_harness(harness) || location.is_empty() {
            return;
        }
        if self.observed.consent.state != ConsentState::Approved {
            return;
        }
        let pair = (harness.to_string(), location.to_string());
        if self.observed.consent.locations.contains(&pair) || self.queued_pairs.contains(&pair) {
            return;
        }
        if self.queued_pairs.len() >= self.c.seen_cap {
            return;
        }
        self.queued_pairs.insert(pair.clone());
        let (harness, location) = pair;
        self.config_dirs
            .push_back(Job::ConfigDir { harness, location });
    }

    /// Repos that still need a Listening decision, ordered by main path.
    pub fn pending(&self) -> Vec<PendingRepo> {
        self.pending_repos.values().cloned().collect()
    }

    /// Session roots whose cached repo verdict is `allowed`. A repo decision updates the cache,
    /// so a desk "allow" shows here as soon as its job finishes.
    pub fn allowed_roots(&self) -> BTreeSet<String> {
        self.root_verdicts
            .iter()
            .filter(|(_, (_, decision))| *decision == RepoDecisionState::Allowed)
            .map(|(root, _)| root.clone())
            .collect()
    }

    /// The outcome of a `setup` job. A plan replies with the plan and leaves the
    /// stored targets alone. Any other action replaces them and acks.
    pub(super) fn finish_setup(
        &mut self,
        token: u64,
        id: u64,
        action: &SetupAction,
        out: Result<AutoResult, RunError>,
    ) -> Vec<Effect> {
        let result = match out {
            Ok(result) => result,
            Err(err) => return vec![ack_error(token, id, &err)],
        };
        let msg = if *action == SetupAction::Plan {
            ServerMsg::ConsentPlan {
                id,
                consent: result.consent,
                targets: result.targets,
            }
        } else {
            self.targets = result.targets;
            ServerMsg::Ack {
                id,
                ok: true,
                error: None,
            }
        };
        vec![Effect::Reply { token, msg }]
    }

    /// The outcome of a `repo_decision` job. A success updates the cached verdicts
    /// of the main repo, drops its pending entry, and acks.
    pub(super) fn finish_repo_decision(
        &mut self,
        token: u64,
        id: u64,
        out: Result<AutoResult, RunError>,
    ) -> Vec<Effect> {
        let result = match out {
            Ok(result) => result,
            Err(err) => return vec![ack_error(token, id, &err)],
        };
        let mut effects = Vec::new();
        if let Some(RepoVerdict { main, decision, .. }) = result.repo {
            for cached in self.root_verdicts.values_mut() {
                if cached.0 == main {
                    cached.1 = decision;
                }
            }
            effects.extend(self.drop_pending(&main));
        }
        let msg = ServerMsg::Ack {
            id,
            ok: true,
            error: None,
        };
        effects.push(Effect::Reply { token, msg });
        effects
    }

    /// The outcome of a `RepoStatus` job. A verdict is cached for its root. An
    /// undecided main becomes one pending entry, and a decided main leaves the
    /// pending list. A failure or a missing verdict leaves the root unknown; the
    /// root is not queued again.
    pub(super) fn finish_repo_status(
        &mut self,
        root: &str,
        out: Result<AutoResult, RunError>,
    ) -> Vec<Effect> {
        let Ok(AutoResult {
            repo: Some(verdict),
            ..
        }) = out
        else {
            return Vec::new();
        };
        let RepoVerdict {
            key,
            main,
            decision,
        } = verdict;
        self.root_verdicts
            .insert(root.to_string(), (main.clone(), decision));
        if decision != RepoDecisionState::Undecided {
            return self.drop_pending(&main);
        }
        if self.pending_repos.contains_key(&main) {
            return Vec::new();
        }
        let name = last_segment(&main);
        self.pending_repos
            .insert(main.clone(), PendingRepo { key, main, name });
        vec![Effect::PendingChanged]
    }

    /// The outcome of a `ConfigDir` job. A success replaces the stored targets. When Node
    /// reported notes, the log records how many, never their text. A failure is logged.
    pub(super) fn finish_config_dir(
        &mut self,
        harness: &str,
        out: Result<AutoResult, RunError>,
    ) -> Vec<Effect> {
        match out {
            Ok(result) => {
                self.targets = result.targets;
                let count = result.notes.len();
                if count == 0 {
                    return Vec::new();
                }
                vec![Effect::Log(format!(
                    "config dir {harness}: {count} note(s)"
                ))]
            }
            Err(err) => vec![Effect::Log(format!("config dir {harness}: {err}"))],
        }
    }

    /// Puts a config-dir or repo status job back at the front of its queue, for a run
    /// that found no CLI. Its pair or root stays marked as queued.
    pub(super) fn requeue(&mut self, job: &Job) {
        match job {
            Job::ConfigDir { .. } => self.config_dirs.push_front(job.clone()),
            Job::RepoStatus { .. } => self.repo_status.push_front(job.clone()),
            Job::Apply | Job::Setup { .. } | Job::RepoDecision { .. } => {}
        }
    }

    /// Drops the pending entry for `main`. Reports a change only when an entry was removed.
    fn drop_pending(&mut self, main: &str) -> Vec<Effect> {
        match self.pending_repos.remove(main) {
            Some(_) => vec![Effect::PendingChanged],
            None => Vec::new(),
        }
    }
}

/// The harness an `HarnessOn` or `HarnessOff` action names when it is not a known id.
fn unknown_harness(action: &SetupAction) -> Option<&str> {
    match action {
        SetupAction::HarnessOn { harness } | SetupAction::HarnessOff { harness }
            if !is_known_harness(harness) =>
        {
            Some(harness.as_str())
        }
        _ => None,
    }
}

/// The reply for a request whose Node run failed.
fn ack_error(token: u64, id: u64, err: &RunError) -> Effect {
    let msg = ServerMsg::Ack {
        id,
        ok: false,
        error: Some(err.to_string()),
    };
    Effect::Reply { token, msg }
}

/// The last segment of a repo's main path. Both `/` and `\` separate segments,
/// and trailing separators are ignored.
fn last_segment(main: &str) -> String {
    let trimmed = main.trim_end_matches(['/', '\\']);
    trimmed
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .to_string()
}
