//! Bounded, day-scoped coverage gap list for desk health.

use std::collections::VecDeque;

use rocky_proto::pipe::Gap;

pub const GAP_CAP: usize = 100;
pub const GAP_KEEP_MS: u64 = 24 * 60 * 60_000;

#[derive(Debug, Default)]
pub struct Gaps {
    list: VecDeque<Gap>,
}

impl Gaps {
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds one gap, dropping the oldest once the cap is reached.
    pub fn push(&mut self, gap: Gap) {
        if self.list.len() >= GAP_CAP {
            self.list.pop_front();
        }
        self.list.push_back(gap);
    }

    /// Drops gaps that ended more than a day before `now_ms`.
    /// Returns whether any were dropped.
    pub fn prune(&mut self, now_ms: u64) -> bool {
        let before = self.list.len();
        self.list
            .retain(|gap| gap.to_ms.saturating_add(GAP_KEEP_MS) >= now_ms);
        self.list.len() != before
    }

    pub fn to_vec(&self) -> Vec<Gap> {
        self.list.iter().copied().collect()
    }
}
