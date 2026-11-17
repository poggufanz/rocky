//! Pure projections behind the agents star atlas: no UI types here.

use rocky_proto::pipe::{AgentKey, RepoInfo};

pub mod projects;

#[cfg(test)]
mod tests_projects;

/// Stable identity of a project: the main checkout root, else the repo
/// root, else empty for sessions outside any repo.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ProjectId(pub String);

pub fn project_id(repo: &RepoInfo) -> ProjectId {
    ProjectId(
        repo.main_root
            .clone()
            .or_else(|| repo.root.clone())
            .unwrap_or_default(),
    )
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
