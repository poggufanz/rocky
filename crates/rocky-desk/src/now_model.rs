//! Pure view-model for the desk's live Now section and active timeline fetching.

use std::cmp::Reverse;
use std::collections::{BTreeMap, BTreeSet};

use rocky_proto::pipe::{
    AgentKey, AgentStatus, Outcome, ServerMsg, Status, StatusOp, TimelineEntry, TimelineKind,
};

use crate::card_detail_model::format_step_dur;
use crate::cards_model::{CardsModel, first_non_empty_line, prompt_display, sanitize_single_line};
use crate::i18n::{CardMsg, Msg, UiLang, card_text, tr};
use crate::view::{Model, action_target, action_text, age_secs, short8};

/// Minimum interval between timeline fetches for the same active agent key.
pub const TIMELINE_DEBOUNCE_MS: u64 = 500;

const MAX_COLLAPSED_STEPS: usize = 3;

/// Full rendered model for the desk's live Now section.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NowView {
    pub active_count: usize,
    pub needs_count: usize,
    pub active: Vec<SessionCard>,
    pub finished: Vec<FinishedRow>,
    pub idle: Vec<IdleRow>,
}

/// Live session card for a working or approval-waiting session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionCard {
    pub key: AgentKey,
    pub status: Status,
    pub repo: String,
    pub branch: Option<String>,
    pub session_short: String,
    pub timer: String,
    pub prompt: Option<String>,
    pub tool: String,
    pub action: Option<String>,
    pub failures: u32,
    pub steps: Vec<LiveStep>,
    pub hidden_steps: usize,
    pub expanded: bool,
    pub subs: Vec<SubRow>,
    pub hidden_children: Option<Msg>,
}

/// Single step row rendered inside a [`SessionCard`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveStep {
    pub ms: u64,
    pub mark: StepMark,
    pub title: String,
    pub dur: String,
}

/// Visual status indicator for a [`LiveStep`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepMark {
    Ok,
    Failed,
    Waiting,
    Running,
}

/// Subagent row nested under an active [`SessionCard`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubRow {
    pub key: AgentKey,
    pub status: Status,
    pub agent_type: String,
    pub description: Option<String>,
    pub timer: String,
    pub action: Option<String>,
    pub expanded: bool,
    pub steps: Vec<LiveStep>,
}

/// Compact row for a recently completed or failed session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FinishedRow {
    pub key: AgentKey,
    pub status: Status,
    pub repo: String,
    pub branch: Option<String>,
    pub age: String,
    pub failures: u32,
    pub card_id: Option<String>,
}

/// Compact row for an idle or ended session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdleRow {
    pub repo: String,
    pub branch: Option<String>,
    pub session_short: String,
    pub age: String,
}

/// Tracks per-key active state, 500 ms request cooldowns, and deferred trailing refreshes.
#[derive(Debug, Default)]
pub struct TimelineFetch {
    active: BTreeSet<AgentKey>,
    last_sent: BTreeMap<AgentKey, u64>,
    pending: BTreeSet<AgentKey>,
}

impl TimelineFetch {
    /// Creates an empty timeline request scheduler.
    pub fn new() -> Self {
        Self::default()
    }

    /// Clears active tracking, cooldowns, and pending refreshes (used on pipe disconnect).
    pub fn reset(&mut self) {
        self.active.clear();
        self.last_sent.clear();
        self.pending.clear();
    }

    /// Inspects an incoming daemon message after `model.apply` and returns due timeline keys.
    pub fn on_msg(
        &mut self,
        msg: &ServerMsg,
        active_keys: &BTreeSet<AgentKey>,
        now_ms: u64,
    ) -> Vec<AgentKey> {
        self.prune_inactive(active_keys, now_ms);
        match msg {
            ServerMsg::Snapshot { .. } => {
                self.active = active_keys.clone();
                let mut due = Vec::new();
                for key in active_keys {
                    if self.request_or_defer(key, now_ms) {
                        due.push(key.clone());
                    }
                }
                due
            }
            ServerMsg::Status { op, agent } => {
                let prev_active = std::mem::replace(&mut self.active, active_keys.clone());
                let mut due = Vec::new();
                for key in active_keys {
                    if !prev_active.contains(key) && self.request_or_defer(key, now_ms) {
                        due.push(key.clone());
                    }
                }
                if *op == StatusOp::Upsert
                    && active_keys.contains(&agent.key)
                    && prev_active.contains(&agent.key)
                    && !due.contains(&agent.key)
                    && self.request_or_defer(&agent.key, now_ms)
                {
                    due.push(agent.key.clone());
                }
                due
            }
            _ => Vec::new(),
        }
    }

    /// Requests a timeline fetch on row expansion while enforcing the 500 ms per-key cooldown
    /// for active primary agents.
    ///
    /// Active primary keys inside cooldown are queued for trailing flush on [`Self::poll`], while
    /// any already-cached timeline stays visible immediately. Non-primary keys bypass the
    /// scheduler so child/subagent expansions stay direct with no cooldown.
    pub fn on_open(
        &mut self,
        key: &AgentKey,
        active_keys: &BTreeSet<AgentKey>,
        now_ms: u64,
    ) -> bool {
        self.prune_inactive(active_keys, now_ms);
        if active_keys.contains(key) {
            self.request_or_defer(key, now_ms)
        } else {
            true
        }
    }

    /// Flushes any deferred keys whose 500 ms cooldown has elapsed by `now_ms`.
    pub fn poll(&mut self, active_keys: &BTreeSet<AgentKey>, now_ms: u64) -> Vec<AgentKey> {
        self.prune_inactive(active_keys, now_ms);
        let ready: Vec<AgentKey> = self
            .pending
            .iter()
            .filter(|k| self.cooldown_ready(k, now_ms))
            .cloned()
            .collect();
        for key in &ready {
            self.pending.remove(key);
            self.last_sent.insert(key.clone(), now_ms);
        }
        ready
    }

    fn prune_inactive(&mut self, active_keys: &BTreeSet<AgentKey>, now_ms: u64) {
        self.active.retain(|k| active_keys.contains(k));
        self.pending.retain(|k| active_keys.contains(k));
        self.last_sent.retain(|k, &mut last| {
            active_keys.contains(k) || now_ms.saturating_sub(last) < TIMELINE_DEBOUNCE_MS
        });
    }

    fn cooldown_ready(&self, key: &AgentKey, now_ms: u64) -> bool {
        self.last_sent
            .get(key)
            .is_none_or(|&last| now_ms.saturating_sub(last) >= TIMELINE_DEBOUNCE_MS)
    }

    fn request_or_defer(&mut self, key: &AgentKey, now_ms: u64) -> bool {
        if self.cooldown_ready(key, now_ms) {
            self.pending.remove(key);
            self.last_sent.insert(key.clone(), now_ms);
            true
        } else {
            self.pending.insert(key.clone());
            false
        }
    }
}

/// Projects the live daemon agent state and loaded cards into a [`NowView`].
pub fn now_view(
    model: &Model,
    cards: &CardsModel,
    now_ms: u64,
    lang: UiLang,
    home: Option<&str>,
) -> NowView {
    let mut by_session: BTreeMap<&str, Vec<&AgentStatus>> = BTreeMap::new();
    for agent in model.agents().values() {
        by_session
            .entry(agent.key.session_id.as_str())
            .or_default()
            .push(agent);
    }

    let mut active_items: Vec<(u64, SessionCard)> = Vec::new();
    let mut finished_items: Vec<(u64, FinishedRow)> = Vec::new();
    let mut idle_items: Vec<(u64, AgentKey, IdleRow)> = Vec::new();

    for mut agents in by_session.into_values() {
        agents.sort_by(|a, b| {
            (!a.key.agent_id.is_empty(), &a.key.agent_id)
                .cmp(&(!b.key.agent_id.is_empty(), &b.key.agent_id))
        });
        let primary = agents[0];
        let children = &agents[1..];
        match primary.status {
            Status::NeedsYou | Status::Working => {
                active_items.push((
                    primary.last_event_ms,
                    build_session_card(model, primary, children, now_ms, lang, home),
                ));
            }
            Status::Done | Status::Failed => {
                finished_items.push((
                    primary.last_event_ms,
                    FinishedRow {
                        key: primary.key.clone(),
                        status: primary.status,
                        repo: format_repo(&primary.repo.name, lang),
                        branch: format_branch(primary.repo.branch.as_deref()),
                        age: format_age(now_ms, primary.last_event_ms, lang),
                        failures: primary.failures,
                        card_id: find_card_id(cards, &primary.key.session_id),
                    },
                ));
            }
            Status::Idle | Status::Ended => {
                idle_items.push((
                    primary.last_event_ms,
                    primary.key.clone(),
                    IdleRow {
                        repo: format_repo(&primary.repo.name, lang),
                        branch: format_branch(primary.repo.branch.as_deref()),
                        session_short: short8(&primary.key.session_id),
                        age: format_age(now_ms, primary.last_event_ms, lang),
                    },
                ));
            }
        }
    }

    active_items.sort_by(|(ms_a, card_a), (ms_b, card_b)| {
        (
            card_a.status != Status::NeedsYou,
            Reverse(*ms_a),
            &card_a.key,
        )
            .cmp(&(
                card_b.status != Status::NeedsYou,
                Reverse(*ms_b),
                &card_b.key,
            ))
    });
    finished_items.sort_by(|(ms_a, row_a), (ms_b, row_b)| {
        (Reverse(*ms_a), &row_a.key).cmp(&(Reverse(*ms_b), &row_b.key))
    });
    idle_items.sort_by(|(ms_a, key_a, _), (ms_b, key_b, _)| {
        (Reverse(*ms_a), key_a).cmp(&(Reverse(*ms_b), key_b))
    });

    let active: Vec<SessionCard> = active_items.into_iter().map(|(_, c)| c).collect();
    let finished: Vec<FinishedRow> = finished_items.into_iter().map(|(_, r)| r).collect();
    let idle: Vec<IdleRow> = idle_items.into_iter().map(|(_, _, r)| r).collect();

    let active_count = active.len();
    let needs_count = active
        .iter()
        .filter(|c| c.status == Status::NeedsYou)
        .count();

    NowView {
        active_count,
        needs_count,
        active,
        finished,
        idle,
    }
}

fn build_session_card(
    model: &Model,
    primary: &AgentStatus,
    children: &[&AgentStatus],
    now_ms: u64,
    lang: UiLang,
    home: Option<&str>,
) -> SessionCard {
    let expanded = model.is_open(&primary.key);
    let entries = model.timeline(&primary.key).unwrap_or(&[]);
    let (steps, hidden_steps) = build_steps(
        entries,
        primary.status,
        expanded,
        now_ms,
        primary.repo.root.as_deref(),
        home,
        lang,
    );
    let (tool, action) = format_tool_and_action(primary);
    let (subs, hidden_children) = build_subrows(model, children, now_ms, home, lang);

    SessionCard {
        key: primary.key.clone(),
        status: primary.status,
        repo: format_repo(&primary.repo.name, lang),
        branch: format_branch(primary.repo.branch.as_deref()),
        session_short: short8(&primary.key.session_id),
        timer: format_age(now_ms, primary.last_event_ms, lang),
        prompt: format_prompt(primary, lang),
        tool,
        action,
        failures: primary.failures,
        steps,
        hidden_steps,
        expanded,
        subs,
        hidden_children,
    }
}

fn build_subrows(
    model: &Model,
    children: &[&AgentStatus],
    now_ms: u64,
    home: Option<&str>,
    lang: UiLang,
) -> (Vec<SubRow>, Option<Msg>) {
    if model.subagent_tree_enabled() {
        let rows = children
            .iter()
            .map(|sub| {
                let expanded = model.is_open(&sub.key);
                let steps = if expanded {
                    let entries = model.timeline(&sub.key).unwrap_or(&[]);
                    build_steps(
                        entries,
                        sub.status,
                        true,
                        now_ms,
                        sub.repo.root.as_deref(),
                        home,
                        lang,
                    )
                    .0
                } else {
                    Vec::new()
                };
                SubRow {
                    key: sub.key.clone(),
                    status: sub.status,
                    agent_type: clean_opt(sub.agent_type.as_deref())
                        .unwrap_or_else(|| short8(&sub.key.agent_id)),
                    description: clean_opt(sub.description.as_deref()),
                    timer: format_age(now_ms, sub.last_event_ms, lang),
                    action: sub.action.as_ref().and_then(|act| {
                        let clean =
                            sanitize_single_line(&action_text(act, sub.repo.root.as_deref()))
                                .trim()
                                .to_string();
                        (!clean.is_empty()).then_some(clean)
                    }),
                    expanded,
                    steps,
                }
            })
            .collect();
        (rows, None)
    } else if children.is_empty() {
        (Vec::new(), None)
    } else {
        let working = children
            .iter()
            .filter(|sub| sub.status == Status::Working)
            .count() as u64;
        (
            Vec::new(),
            Some(Msg::SubagentsHidden {
                n: children.len() as u64,
                working,
            }),
        )
    }
}

fn build_steps(
    entries: &[TimelineEntry],
    agent_status: Status,
    expanded: bool,
    now_ms: u64,
    root: Option<&str>,
    home: Option<&str>,
    lang: UiLang,
) -> (Vec<LiveStep>, usize) {
    let turn_start = entries
        .iter()
        .rposition(|e| e.kind == TimelineKind::TurnStart);
    let slice = match turn_start {
        Some(idx) => &entries[idx + 1..],
        None => entries,
    };
    let turn_last = slice.len().saturating_sub(1);

    let mut steps: Vec<LiveStep> = slice
        .iter()
        .enumerate()
        .filter(|(_, e)| matches!(e.kind, TimelineKind::Tool | TimelineKind::NeedsYou))
        .map(|(idx, entry)| {
            let mark = step_mark(entry, idx == turn_last, agent_status);
            let title = step_title(entry, root, home, lang);
            let dur = match mark {
                StepMark::Running | StepMark::Waiting => {
                    format_step_dur(now_ms.saturating_sub(entry.ms))
                }
                StepMark::Ok | StepMark::Failed => {
                    entry.dur_ms.map(format_step_dur).unwrap_or_default()
                }
            };
            LiveStep {
                ms: entry.ms,
                mark,
                title,
                dur,
            }
        })
        .collect();

    let hidden_steps = if expanded || steps.len() <= MAX_COLLAPSED_STEPS {
        0
    } else {
        let drop_count = steps.len() - MAX_COLLAPSED_STEPS;
        steps.drain(..drop_count);
        drop_count
    };
    (steps, hidden_steps)
}

fn step_mark(entry: &TimelineEntry, is_latest: bool, agent_status: Status) -> StepMark {
    match entry.outcome {
        Some(Outcome::Ok) => StepMark::Ok,
        Some(Outcome::Failed) => StepMark::Failed,
        Some(Outcome::Pending) | None => {
            if is_latest && entry.kind == TimelineKind::NeedsYou && agent_status == Status::NeedsYou
            {
                StepMark::Waiting
            } else if is_latest && agent_status == Status::Working {
                StepMark::Running
            } else {
                StepMark::Ok
            }
        }
    }
}

fn step_title(
    entry: &TimelineEntry,
    root: Option<&str>,
    home: Option<&str>,
    lang: UiLang,
) -> String {
    let tool = clean_opt(entry.tool_name.as_deref());
    let text = clean_opt(entry.text.as_deref());
    if entry.kind == TimelineKind::NeedsYou {
        let label = card_text(lang, &CardMsg::WaitingApproval);
        return match text.or(tool) {
            Some(detail) => format!("{detail} \u{00b7} {label}"),
            None => label,
        };
    }

    let label = tool.as_deref().map(tool_label).unwrap_or_default();
    if label == "cmd" {
        return text.unwrap_or(label);
    }
    let detail = text.map(|t| short_path(&t, root, home));
    match (label.is_empty(), detail) {
        (false, Some(detail)) => format!("{label} {detail}"),
        (false, None) => label,
        (true, Some(detail)) => detail,
        (true, None) => String::new(),
    }
}

/// Maps a tool name to its short display label (at most 9 chars).
pub(crate) fn tool_label(tool_name: &str) -> String {
    let clean = sanitize_single_line(tool_name);
    let trimmed = clean.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let lower = trimmed.to_lowercase();
    if lower == "bash" || lower == "powershell" || lower.contains("shell") {
        return "cmd".to_string();
    }
    match lower.as_str() {
        "edit" | "write" | "multiedit" | "notebookedit" => "edit".to_string(),
        "read" => "read".to_string(),
        "grep" | "glob" => "find".to_string(),
        "webfetch" | "websearch" => "web".to_string(),
        "task" | "agent" => "agent".to_string(),
        _ => {
            let mut chars = lower.chars();
            let head: String = chars.by_ref().take(8).collect();
            if chars.next().is_some() {
                format!("{head}\u{2026}")
            } else {
                lower
            }
        }
    }
}

/// Shortens a step path relative to `root`, or `~/` under `home`, using `/` separators.
pub(crate) fn short_path(path: &str, root: Option<&str>, home: Option<&str>) -> String {
    let norm_path = normalize_path(path);
    if let Some(rel) = root.and_then(|r| strip_path_prefix(&norm_path, r)) {
        return rel;
    }
    if let Some(rel) = home.and_then(|h| strip_path_prefix(&norm_path, h)) {
        return format!("~/{rel}");
    }
    path.to_string()
}

fn normalize_path(raw: &str) -> String {
    let replaced = raw.replace('\\', "/");
    let unprefixed = if let Some(rest) = replaced
        .strip_prefix("//?/UNC/")
        .or_else(|| replaced.strip_prefix("//?/unc/"))
    {
        format!("//{rest}")
    } else if let Some(rest) = replaced.strip_prefix("//?/") {
        rest.to_string()
    } else {
        replaced
    };
    let trimmed = unprefixed.trim_end_matches('/');
    if trimmed.is_empty() && !unprefixed.is_empty() {
        "/".to_string()
    } else {
        trimmed.to_string()
    }
}

fn strip_path_prefix(norm_path: &str, base: &str) -> Option<String> {
    let norm_base = normalize_path(base);
    if norm_base.is_empty() || norm_base == "/" {
        return None;
    }
    let path_segs: Vec<&str> = norm_path.split('/').collect();
    let base_segs: Vec<&str> = norm_base.split('/').collect();
    if path_segs.len() <= base_segs.len() {
        return None;
    }
    let matches_base = path_segs
        .iter()
        .zip(base_segs.iter())
        .all(|(p, b)| path_seg_eq(p, b));
    if !matches_base {
        return None;
    }
    let rel: Vec<&str> = path_segs[base_segs.len()..]
        .iter()
        .copied()
        .filter(|s| !s.is_empty())
        .collect();
    if rel.is_empty() {
        None
    } else {
        Some(rel.join("/"))
    }
}

fn path_seg_eq(a: &str, b: &str) -> bool {
    if cfg!(windows) {
        a.to_lowercase() == b.to_lowercase()
    } else {
        a == b
    }
}

fn format_repo(repo_name: &str, lang: UiLang) -> String {
    let trimmed = repo_name.trim();
    if trimmed.is_empty() {
        tr(lang, &Msg::UnknownRepo)
    } else {
        sanitize_single_line(trimmed).trim().to_string()
    }
}

fn format_branch(branch: Option<&str>) -> Option<String> {
    clean_opt(branch)
}

fn format_age(now_ms: u64, last_event_ms: u64, lang: UiLang) -> String {
    tr(
        lang,
        &Msg::Age {
            secs: age_secs(now_ms, last_event_ms),
        },
    )
}

fn format_prompt(primary: &AgentStatus, lang: UiLang) -> Option<String> {
    let text = &primary.prompt.as_ref()?.text;
    let (display, _) = prompt_display(text, lang);
    let first = first_non_empty_line(&display);
    let clean = sanitize_single_line(first).trim().to_string();
    (!clean.is_empty()).then_some(clean)
}

fn format_tool_and_action(primary: &AgentStatus) -> (String, Option<String>) {
    match primary.action.as_ref() {
        Some(act) => (
            tool_label(&act.tool_name),
            action_target(act, primary.repo.root.as_deref()),
        ),
        None => (
            primary
                .summary
                .as_deref()
                .map(tool_label)
                .unwrap_or_default(),
            None,
        ),
    }
}

fn find_card_id(cards: &CardsModel, session_id: &str) -> Option<String> {
    cards
        .items()
        .iter()
        .filter(|c| c.session_id == session_id && c.agent_id.is_empty())
        .max_by_key(|c| (c.ended_ms.unwrap_or(c.started_ms), c.card_id.as_str()))
        .map(|c| c.card_id.clone())
}

fn clean_opt(raw: Option<&str>) -> Option<String> {
    raw.map(|s| sanitize_single_line(s).trim().to_string())
        .filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_timeline;
