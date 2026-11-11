//! Limits repairs of a config file that keeps losing Rocky's entries.
//!
//! A loss soon after a repair is a fight. A path with more fights inside the
//! window than the limit, or whose last attempt failed, waits out a throttle
//! after its last attempt before the next repair. Every time comes from the
//! caller; the brake reads no clock.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use rocky_proto::pipe::FIGHT_LIMIT;

/// Timing and limits for the brake. The daemon uses `Default`; tests override fields.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BrakeConsts {
    /// A loss this soon after a repair counts as a fight.
    pub fight_after_ms: u64,
    /// Fights older than this no longer count.
    pub window_ms: u64,
    /// More fights than this inside the window throttle repairs.
    pub limit: u32,
    /// How long a throttled path waits after its last attempt.
    pub throttle_ms: u64,
}

impl Default for BrakeConsts {
    fn default() -> Self {
        Self {
            fight_after_ms: 30_000,
            window_ms: 600_000,
            limit: FIGHT_LIMIT,
            throttle_ms: 60_000,
        }
    }
}

#[derive(Debug, Default)]
struct PathState {
    last_repair: Option<u64>,
    last_attempt: Option<u64>,
    failed: bool,
    fights: Vec<u64>,
}

/// Repair history for each config path.
#[derive(Debug)]
pub struct Brake {
    c: BrakeConsts,
    paths: BTreeMap<PathBuf, PathState>,
}

impl Brake {
    pub fn new(c: BrakeConsts) -> Self {
        Self {
            c,
            paths: BTreeMap::new(),
        }
    }

    /// Counts a fight when the path went missing soon after its last repair.
    pub fn lost(&mut self, path: &Path, now_ms: u64) {
        let c = self.c;
        let state = self.state_mut(path);
        state
            .fights
            .retain(|&at| now_ms.saturating_sub(at) < c.window_ms);
        let is_fight = state
            .last_repair
            .is_some_and(|repaired| now_ms.saturating_sub(repaired) < c.fight_after_ms);
        if is_fight {
            state.fights.push(now_ms);
        }
    }

    pub fn attempted(&mut self, path: &Path, now_ms: u64) {
        self.state_mut(path).last_attempt = Some(now_ms);
    }

    pub fn repaired(&mut self, path: &Path, at_ms: u64) {
        let state = self.state_mut(path);
        state.last_repair = Some(at_ms);
        state.failed = false;
    }

    /// Records that the attempt made at `at_ms` did not restore the path.
    pub fn failed(&mut self, path: &Path, at_ms: u64) {
        let state = self.state_mut(path);
        state.failed = true;
        state.last_attempt = Some(at_ms);
    }

    /// False only while the path is throttled and its last attempt is recent.
    pub fn may_repair(&self, path: &Path, now_ms: u64) -> bool {
        let Some(state) = self.paths.get(path) else {
            return true;
        };
        let Some(attempt) = state.last_attempt else {
            return true;
        };
        let throttled = state.failed || self.fights(path, now_ms) > self.c.limit;
        !throttled || now_ms.saturating_sub(attempt) >= self.c.throttle_ms
    }

    /// Fights inside the window ending at `now_ms`.
    pub fn fights(&self, path: &Path, now_ms: u64) -> u32 {
        let Some(state) = self.paths.get(path) else {
            return 0;
        };
        let inside = state
            .fights
            .iter()
            .filter(|&&at| now_ms.saturating_sub(at) < self.c.window_ms)
            .count();
        u32::try_from(inside).unwrap_or(u32::MAX)
    }

    pub fn last_repair(&self, path: &Path) -> Option<u64> {
        self.paths.get(path)?.last_repair
    }

    fn state_mut(&mut self, path: &Path) -> &mut PathState {
        self.paths.entry(path.to_path_buf()).or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CFG: &str = "/home/u/.claude/settings.json";

    fn brake() -> Brake {
        Brake::new(BrakeConsts::default())
    }

    /// Repaired at `at`, then lost again one second later.
    fn fight(brake: &mut Brake, path: &Path, at: u64) {
        brake.repaired(path, at);
        brake.lost(path, at + 1_000);
    }

    #[test]
    fn untouched_path_may_repair_and_has_no_fights() {
        let brake = brake();
        let path = Path::new(CFG);
        assert!(brake.may_repair(path, 0));
        assert_eq!(brake.fights(path, 0), 0);
        assert_eq!(brake.last_repair(path), None);
    }

    #[test]
    fn loss_inside_the_fight_window_counts_a_fight() {
        let mut brake = brake();
        let path = Path::new(CFG);
        brake.repaired(path, 1_000);
        brake.lost(path, 30_999);
        assert_eq!(brake.fights(path, 30_999), 1);
    }

    #[test]
    fn loss_at_the_fight_window_edge_is_not_a_fight() {
        let mut brake = brake();
        let path = Path::new(CFG);
        brake.repaired(path, 1_000);
        brake.lost(path, 31_000);
        assert_eq!(brake.fights(path, 31_000), 0);
    }

    #[test]
    fn fights_age_out_of_the_window() {
        let mut brake = brake();
        let path = Path::new(CFG);
        fight(&mut brake, path, 0);
        assert_eq!(brake.fights(path, 1_000 + 599_999), 1);
        assert_eq!(brake.fights(path, 1_000 + 600_000), 0);
    }

    #[test]
    fn more_fights_than_the_limit_throttle_for_a_minute() {
        let mut brake = brake();
        let path = Path::new(CFG);
        for n in 0..5u64 {
            fight(&mut brake, path, n * 3_000);
        }
        brake.attempted(path, 15_000);
        assert!(
            brake.may_repair(path, 15_001),
            "five fights are at the limit"
        );
        fight(&mut brake, path, 15_000);
        brake.attempted(path, 20_000);
        assert!(!brake.may_repair(path, 20_001));
        assert!(brake.may_repair(path, 80_000));
    }

    #[test]
    fn failed_attempt_throttles_until_the_window_ends() {
        let mut brake = brake();
        let path = Path::new(CFG);
        brake.attempted(path, 100);
        brake.failed(path, 100);
        assert!(!brake.may_repair(path, 100 + 59_999));
        assert!(brake.may_repair(path, 100 + 60_000));
    }

    #[test]
    fn repair_clears_the_failed_mark() {
        let mut brake = brake();
        let path = Path::new(CFG);
        brake.attempted(path, 100);
        brake.failed(path, 100);
        brake.repaired(path, 110);
        assert!(brake.may_repair(path, 111));
    }
}
