//! Shared fixtures for atlas tests.

use crate::view::Model;
use rocky_proto::pipe::{AgentKey, AgentStatus, Health, ServerMsg, Status, TimelineEntry};
use rocky_proto::settings::Settings;

/// A model seeded with `agents`, every key wanted, and one timeline reply per pair.
pub fn model_with(
    agents: Vec<AgentStatus>,
    timelines: Vec<(AgentKey, Vec<TimelineEntry>)>,
    subagent_tree: bool,
) -> Model {
    let mut model = Model::new();
    let keys = agents.iter().map(|a| a.key.clone()).collect();
    model.apply(ServerMsg::Snapshot {
        agents,
        aggregate: Status::Idle,
        health: Health::default(),
        settings: Settings {
            subagent_tree,
            ..Settings::default()
        },
        repo_pending: Vec::new(),
    });
    model.set_wanted(keys);
    for (key, entries) in timelines {
        model.apply(ServerMsg::Timeline {
            id: 0,
            key,
            entries,
        });
    }
    model
}
