//! Pure projections behind the agents star atlas: no UI types here.

use rocky_proto::pipe::{AgentKey, AgentStatus, RepoInfo};
use std::collections::{BTreeMap, BTreeSet};

pub mod constellation;
pub mod detail;
pub mod projects;
pub mod sky;
pub mod time_scale;

#[cfg(test)]
pub mod test_support;
#[cfg(test)]
mod tests_constellation;
#[cfg(test)]
mod tests_projects;
#[cfg(test)]
mod tests_sky;

/// Stable identity of a project: the main checkout root, else the repo
/// root, else the folder name for a session outside any repo, else empty
/// when the daemon has no cwd for the session yet.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ProjectId(pub String);

pub fn project_id(repo: &RepoInfo) -> ProjectId {
    // ponytail: folders outside a repo group by basename only (the daemon sends
    // no full cwd); two same-named folders merge, send cwd if that bites.
    let id = match repo.main_root.as_ref().or(repo.root.as_ref()) {
        Some(root) => root.clone(),
        None if repo.name.is_empty() => String::new(),
        None => format!("folder:{}", repo.name),
    };
    ProjectId(id)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum AtlasLayout {
    #[default]
    Sky,
    Constellation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SkyWindow {
    #[default]
    Min10,
    Min30,
    Hours2,
}

impl SkyWindow {
    pub fn secs(self) -> u64 {
        match self {
            SkyWindow::Min10 => 600,
            SkyWindow::Min30 => 1800,
            SkyWindow::Hours2 => 7200,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StepRef {
    pub key: AgentKey,
    pub ms: u64,
}

#[derive(Debug, Clone, Default)]
pub struct AtlasState {
    pub project: Option<ProjectId>,
    pub layout: AtlasLayout,
    pub window: SkyWindow,
    pub step: Option<StepRef>,
    pub turn: Option<(AgentKey, u64)>,
}

impl AtlasState {
    /// The window that limits which sessions the map needs timelines for: the
    /// Sky chart draws only its window, the Constellation any session.
    pub fn wanted_window(&self) -> Option<SkyWindow> {
        (self.layout == AtlasLayout::Sky).then_some(self.window)
    }
}

/// Keys of every agent in `project` that the map draws: those active inside
/// `window`, or all of them when `window` is `None`. Subagents count only when
/// `subagents` is set.
pub fn wanted_keys(
    agents: &BTreeMap<AgentKey, AgentStatus>,
    project: &ProjectId,
    window: Option<SkyWindow>,
    now_ms: u64,
    subagents: bool,
) -> BTreeSet<AgentKey> {
    agents
        .values()
        .filter(|a| subagents || a.key.agent_id.is_empty())
        .filter(|a| project_id(&a.repo) == *project)
        .filter(|a| window.is_none_or(|w| a.last_event_ms + w.secs() * 1000 >= now_ms))
        .map(|a| a.key.clone())
        .collect()
}
