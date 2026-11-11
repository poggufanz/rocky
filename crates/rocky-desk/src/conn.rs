//! Pure connection-state decisions for rocky-desk (no GPUI, no threads).
//!
//! [`ConnState`] answers the one question the UI controller asks on every
//! connection event: what should happen next? All transition logic lives here
//! so it is unit-testable; `app.rs` only executes the returned [`Action`].

use super::view::Conn;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectOutcome {
    Connected,
    /// No daemon answered (pipe missing, refused, I/O error).
    NoDaemon,
    /// A foreign process owns the pipe; never spawn or retry.
    Unverified,
    /// The daemon answered but speaks another protocol version; never respawn.
    VersionMismatch,
    /// Spawn failed or the daemon never appeared after spawn.
    SpawnFailed,
    /// The daemon accepted the pipe but never answered hello; never respawn.
    Unresponsive,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// Nothing to do (duplicate event, or stable warning state).
    None,
    /// Show `conn` (warning states that persist without retries).
    Show(Conn),
    /// Start a background connect attempt (no respawn slot consumed).
    Connect,
    /// Consume one respawn slot and start a background connect+spawn attempt.
    Respawn,
    /// Show `KeepsCrashing`: slots exhausted.
    GiveUp,
}

#[derive(Debug)]
pub struct ConnState {
    policy: super::respawn::RespawnPolicy,
    /// Id of the stop cmd awaiting its ack, if any.
    stop_ack_id: Option<u64>,
    /// A stop was acked (or the daemon died while one was pending).
    stopped: bool,
    /// A background connect attempt is currently running.
    connecting: bool,
    /// Last shown conn state (for sticky warnings).
    conn: Conn,
}

impl ConnState {
    pub fn new(max_respawns: usize, window_ms: u64) -> Self {
        Self {
            policy: super::respawn::RespawnPolicy::new(max_respawns, window_ms),
            stop_ack_id: None,
            stopped: false,
            connecting: false,
            conn: Conn::Connecting,
        }
    }

    pub fn conn(&self) -> Conn {
        self.conn
    }

    pub fn is_connecting(&self) -> bool {
        self.connecting
    }

    /// A stop cmd was sent; its ack id is now pending.
    pub fn stop_sent(&mut self, id: u64) {
        self.stop_ack_id = Some(id);
    }

    /// The daemon broadcast `quit`, so this desk is closing. It counts as a
    /// requested stop: no respawn may follow the disconnect that comes with it.
    pub fn on_quit(&mut self) {
        self.stopped = true;
        self.stop_ack_id = None;
    }

    /// An ack arrived. Returns true when the UI should re-render (state changed).
    pub fn on_ack(&mut self, id: u64, ok: bool) -> bool {
        if Some(id) != self.stop_ack_id {
            return false;
        }
        self.stop_ack_id = None;
        if ok {
            self.stopped = true;
        }
        true
    }

    /// The live connection dropped. `now_ms` gates the respawn window.
    /// Must be called exactly once per connection (the caller guards that by
    /// dropping the inbox/outbox on the first observation).
    pub fn on_disconnect(&mut self, now_ms: u64) -> Action {
        if self.stopped || self.stop_ack_id.is_some() {
            // Expected (acked) or user-initiated (pending): never respawn.
            self.stopped = true;
            self.stop_ack_id = None;
            self.conn = Conn::Disconnected;
            return Action::Show(Conn::Disconnected);
        }
        if self.conn == Conn::ServerUnverified || self.conn == Conn::VersionMismatch {
            // Stable warnings, decided at connect time; nothing to retry.
            return Action::None;
        }
        if self.policy.allow(now_ms) {
            self.connecting = true;
            Action::Respawn
        } else {
            self.conn = Conn::KeepsCrashing;
            Action::GiveUp
        }
    }

    /// A background connect attempt finished.
    pub fn on_connect_result(&mut self, outcome: ConnectOutcome) -> Action {
        self.connecting = false;
        match outcome {
            ConnectOutcome::Connected => {
                self.conn = Conn::Connected;
                Action::None
            }
            ConnectOutcome::NoDaemon | ConnectOutcome::SpawnFailed => {
                self.conn = Conn::Disconnected;
                Action::Show(Conn::Disconnected)
            }
            ConnectOutcome::Unverified => {
                self.conn = Conn::ServerUnverified;
                Action::Show(Conn::ServerUnverified)
            }
            ConnectOutcome::VersionMismatch => {
                self.conn = Conn::VersionMismatch;
                Action::Show(Conn::VersionMismatch)
            }
            ConnectOutcome::Unresponsive => {
                self.conn = Conn::Unresponsive;
                Action::Show(Conn::Unresponsive)
            }
        }
    }

    /// Mark the current connection as job-tied (sticky warning). Called by the
    /// UI when a connect result reports a tied daemon.
    pub fn set_tied(&mut self) {
        self.conn = Conn::TiedToJob;
    }

    /// User pressed Open with no live connection: one connect attempt, no slot.
    pub fn on_user_open(&mut self) -> Action {
        if self.connecting {
            return Action::None;
        }
        self.stopped = false;
        self.stop_ack_id = None;
        self.connecting = true;
        Action::Connect
    }

    /// A connect was requested while already connected: ignore.
    pub fn cancel_connecting(&mut self) {
        self.connecting = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_disconnect_consumes_exactly_one_slot() {
        let mut s = ConnState::new(3, 300_000);
        // First crash: respawn.
        assert_eq!(s.on_disconnect(0), Action::Respawn);
        assert!(s.is_connecting());
        // Reconnect ok.
        assert_eq!(s.on_connect_result(ConnectOutcome::Connected), Action::None);
        assert_eq!(s.conn(), Conn::Connected);
        // Second crash later: still slots left.
        assert_eq!(s.on_disconnect(1_000), Action::Respawn);
    }

    #[test]
    fn fourth_crash_within_window_gives_up() {
        let mut s = ConnState::new(3, 300_000);
        for t in [0, 1, 2] {
            assert_eq!(s.on_disconnect(t), Action::Respawn);
            s.cancel_connecting();
            s.on_connect_result(ConnectOutcome::SpawnFailed);
        }
        assert_eq!(s.on_disconnect(3), Action::GiveUp);
        assert_eq!(s.conn(), Conn::KeepsCrashing);
        // Window slides: allowed again after 5 min.
        assert_eq!(s.on_disconnect(300_001), Action::Respawn);
    }

    #[test]
    fn unverified_and_mismatch_are_stable_and_never_respawn() {
        let mut s = ConnState::new(3, 300_000);
        assert_eq!(
            s.on_connect_result(ConnectOutcome::Unverified),
            Action::Show(Conn::ServerUnverified)
        );
        // A later disconnect observation must not respawn or overwrite.
        assert_eq!(s.on_disconnect(1_000), Action::None);
        assert_eq!(s.conn(), Conn::ServerUnverified);

        let mut s = ConnState::new(3, 300_000);
        assert_eq!(
            s.on_connect_result(ConnectOutcome::VersionMismatch),
            Action::Show(Conn::VersionMismatch)
        );
        assert_eq!(s.on_disconnect(1_000), Action::None);
        assert_eq!(s.conn(), Conn::VersionMismatch);
    }

    #[test]
    fn acked_stop_never_respawns() {
        let mut s = ConnState::new(3, 300_000);
        s.stop_sent(7);
        assert!(s.on_ack(7, true));
        assert_eq!(s.on_disconnect(1_000), Action::Show(Conn::Disconnected));
        assert_eq!(s.conn(), Conn::Disconnected);
    }

    #[test]
    fn pending_stop_treated_as_stopped_on_disconnect() {
        let mut s = ConnState::new(3, 300_000);
        s.stop_sent(7);
        // Daemon died before acking: the user asked for it, no respawn.
        assert_eq!(s.on_disconnect(1_000), Action::Show(Conn::Disconnected));
        assert!(!s.on_ack(7, true)); // ack id already cleared
    }

    #[test]
    fn failed_ack_does_not_mark_stopped_but_clears_id() {
        let mut s = ConnState::new(3, 300_000);
        s.stop_sent(7);
        assert!(s.on_ack(7, false));
        // Not stopped: a later disconnect still respawns.
        assert_eq!(s.on_disconnect(1_000), Action::Respawn);
    }

    #[test]
    fn unrelated_ack_is_ignored() {
        let mut s = ConnState::new(3, 300_000);
        s.stop_sent(7);
        assert!(!s.on_ack(8, true));
        assert_eq!(s.on_disconnect(1_000), Action::Show(Conn::Disconnected));
    }

    #[test]
    fn received_quit_suppresses_respawn() {
        let mut s = ConnState::new(3, 300_000);
        s.on_quit();
        let action = s.on_disconnect(1_000);
        assert!(!matches!(action, Action::Respawn | Action::Connect));
        assert_eq!(action, Action::Show(Conn::Disconnected));
        assert_eq!(s.conn(), Conn::Disconnected);
    }

    #[test]
    fn unresponsive_shows_and_user_open_retries() {
        let mut s = ConnState::new(3, 300_000);
        assert_eq!(
            s.on_connect_result(ConnectOutcome::Unresponsive),
            Action::Show(Conn::Unresponsive)
        );
        assert_eq!(s.on_user_open(), Action::Connect);
    }

    #[test]
    fn user_open_connects_once_without_slot() {
        let mut s = ConnState::new(3, 300_000);
        assert_eq!(s.on_user_open(), Action::Connect);
        // Second open while connecting: no duplicate worker.
        assert_eq!(s.on_user_open(), Action::None);
        assert_eq!(
            s.on_connect_result(ConnectOutcome::NoDaemon),
            Action::Show(Conn::Disconnected)
        );
        // Slots untouched: 3 respawns still available.
        for t in [0, 1, 2] {
            assert_eq!(s.on_disconnect(t), Action::Respawn);
            s.cancel_connecting();
            s.on_connect_result(ConnectOutcome::SpawnFailed);
        }
        assert_eq!(s.on_disconnect(3), Action::GiveUp);
    }
}
