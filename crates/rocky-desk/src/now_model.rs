//! Active timeline fetch scheduling and shared tool-label and path helpers for the desk.
use std::collections::{BTreeMap, BTreeSet};

use rocky_proto::pipe::{AgentKey, ServerMsg, StatusOp};

use crate::cards_model::sanitize_single_line;

/// Minimum interval between timeline fetches for the same active agent key.
pub const TIMELINE_DEBOUNCE_MS: u64 = 500;

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
    let norm_root = root.map(normalize_path).filter(|b| !b.is_empty());
    let norm_home = home.map(normalize_path).filter(|b| !b.is_empty());
    if norm_root.as_deref().is_some_and(|r| path_eq(&norm_path, r))
        || norm_home.as_deref().is_some_and(|h| path_eq(&norm_path, h))
    {
        return path.to_string();
    }
    if let Some(rel) = norm_root
        .as_deref()
        .and_then(|r| strip_path_prefix(&norm_path, r))
    {
        return rel;
    }
    if let Some(rel) = norm_home
        .as_deref()
        .and_then(|h| strip_path_prefix(&norm_path, h))
    {
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

fn strip_path_prefix(norm_path: &str, norm_base: &str) -> Option<String> {
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
        .all(|(p, b)| path_eq(p, b));
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

fn path_eq(a: &str, b: &str) -> bool {
    if cfg!(windows) {
        a.to_lowercase() == b.to_lowercase()
    } else {
        a == b
    }
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_timeline;
