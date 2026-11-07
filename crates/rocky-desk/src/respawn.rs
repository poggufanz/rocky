//! Sliding-window respawn policy: at most `max` daemon respawns per window.

#[derive(Debug)]
pub struct RespawnPolicy {
    max: usize,
    window_ms: u64,
    attempts: Vec<u64>,
}

impl RespawnPolicy {
    pub fn new(max: usize, window_ms: u64) -> Self {
        Self {
            max,
            window_ms,
            attempts: Vec::new(),
        }
    }

    pub fn allow(&mut self, now_ms: u64) -> bool {
        self.attempts
            .retain(|&t| now_ms <= t.saturating_add(self.window_ms));
        if self.attempts.len() >= self.max {
            return false;
        }
        self.attempts.push(now_ms);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn respawn_three_per_five_minutes() {
        let mut p = RespawnPolicy::new(3, 300_000);
        assert!(p.allow(0) && p.allow(1) && p.allow(2) && !p.allow(3) && p.allow(300_001));
    }
}
