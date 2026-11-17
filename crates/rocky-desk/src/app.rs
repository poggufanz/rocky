//! GPUI window, tray wiring, and connection controller for rocky-desk.
//!
//! The reader thread (see [`crate::client`]) pushes decoded messages into an
//! `mpsc` channel. A foreground `cx.spawn` pump drains that channel on a timer,
//! applies messages to the [`Model`], and refreshes the window and tray.
//! Connection decisions live in the pure [`crate::conn::ConnState`]; the actual
//! connect/spawn/retry work runs on a background worker thread so the UI never
//! blocks, and its result comes back through a second channel the pump drains.

use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver};
use std::time::{SystemTime, UNIX_EPOCH};

use gpui::{Context, FocusHandle, Window, WindowHandle};
use gpui_tray::Tray;
use rocky_proto::pipe::{AgentKey, ClientMsg, ServerMsg, Status};
use rocky_proto::settings::Lang;

use crate::card_detail_model::{DetailModel, DiffModel};
use crate::cards_model::CardsModel;
use crate::client::Outbox;
use crate::conn::{Action, ConnState, ConnectOutcome};
use crate::connect::{CONNECT_BUDGET, ConnectDone, connect_attempt};
use crate::consent_view::ConsentModel;
use crate::desklog::LogOnce;
use crate::i18n::{Msg, UiLang, resolve_lang};
use crate::notified::NotifiedStore;
use crate::notify::Notifier;
use crate::now_model::TimelineFetch;
use crate::os_notice::OsNotices;
use crate::requests::Requests;
use crate::search_input::{Debounce, SearchInput};
use crate::settings_view::{SettingId, View, set_bool, set_lang};
use crate::setup_settings::SetupSettings;
use crate::spawn::daemon_exe_name;
use crate::ui::cards_view::CardAction;
use crate::ui::flow_view::FlowHover;
use crate::ui::now_view::NowAction;
use crate::ui::title_bar::Tab;
use crate::view::{Conn, Model};

mod autostart_wiring;
mod cards_wiring;
mod consent_wiring;
mod inbox;
mod notifications;
mod panels;
mod render;
mod setup_wiring;
mod tray;
mod window;

pub use window::run;

gpui::actions!(rocky, [OpenRocky, StopRecording, QuitDesk]);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

struct Controller {
    model: Model,
    /// Per-key 500 ms debounce and trailing refresh tracker for active timelines.
    timeline_fetch: TimelineFetch,
    /// Notification rules; remembers statuses across messages.
    notifier: Notifier,
    /// Live inbox, or `None` once its disconnect has been handled. The
    /// `None` flip is what makes disconnect handling run exactly once.
    inbox: Option<Receiver<Option<ServerMsg>>>,
    outbox: Option<Outbox>,
    /// Background worker results; at most one worker runs at a time.
    worker_rx: Receiver<ConnectDone>,
    worker_tx: mpsc::Sender<ConnectDone>,
    state: ConnState,
    cmd_id: u64,
    rocky_home: PathBuf,
    last_aggregate: Status,
    last_tooltip: Msg,
    /// Language every desk string renders in.
    ui_lang: UiLang,
    /// Detected UI language; the language setting resolves against it.
    detected: UiLang,
    /// Panel the window shows.
    view: View,
    /// Started with `--tray`, so the sign-in question is suppressed.
    tray_start: bool,
    /// Sign-in registration as last read; `None` until the settings view reads it.
    autostart_on: Option<bool>,
    /// A sign-in read or write failed; cleared by the next successful read.
    autostart_failed: bool,
}

impl Controller {
    fn set_conn(&mut self, c: Conn) {
        self.model.set_conn(c);
    }

    /// Ask the daemon for one agent's timeline; a no-op while disconnected.
    fn request_timeline(&mut self, key: AgentKey) {
        let Some(outbox) = self.outbox.as_ref() else {
            return;
        };
        self.cmd_id += 1;
        let _ = outbox.send(ClientMsg::Timeline {
            id: self.cmd_id,
            key,
        });
    }

    /// Collects due timeline keys after `self.model.apply(msg)`.
    fn collect_timeline_requests(
        &mut self,
        msg: &ServerMsg,
        legacy_requests: Vec<AgentKey>,
        now_ms: u64,
    ) -> Vec<AgentKey> {
        let active_keys = self.model.active_primary_keys();
        let mut requests = self.timeline_fetch.on_msg(msg, &active_keys, now_ms);
        for key in legacy_requests {
            if !active_keys.contains(&key)
                && self.model.accepts_timeline(&key)
                && !requests.contains(&key)
            {
                requests.push(key);
            }
        }
        requests
    }

    /// Toggles row expansion, debouncing active primary keys and sending child expansions directly.
    fn toggle_open(&mut self, key: &AgentKey, now_ms: u64) {
        if let Some(key) = self.model.toggle_open(key)
            && self.model.accepts_timeline(&key)
        {
            let active_keys = self.model.active_primary_keys();
            if self.timeline_fetch.on_open(&key, &active_keys, now_ms) {
                self.request_timeline(key);
            }
        }
    }

    /// Dispatches deferred active timeline requests whose cooldown has elapsed.
    fn poll_timelines(&mut self, now_ms: u64) {
        let active_keys = self.model.active_primary_keys();
        for key in self.timeline_fetch.poll(&active_keys, now_ms) {
            self.request_timeline(key);
        }
    }

    /// Handle one decision from `ConnState` (foreground, non-blocking).
    fn act(&mut self, action: Action) {
        match action {
            Action::None => {}
            Action::Show(c) => self.set_conn(c),
            Action::GiveUp => self.set_conn(Conn::KeepsCrashing),
            Action::Connect | Action::Respawn => {
                self.set_conn(Conn::Connecting);
                spawn_connect_worker(self.rocky_home.clone(), self.worker_tx.clone());
            }
        }
    }

    /// Drain finished worker results (at most one is ever pending).
    fn on_worker(&mut self) -> bool {
        let mut changed = false;
        while let Ok(done) = self.worker_rx.try_recv() {
            changed = true;
            let action = self.state.on_connect_result(done.outcome);
            if let Some((outbox, inbox)) = done.live {
                self.outbox = Some(outbox);
                self.inbox = Some(inbox);
            }
            if done.tied_to_job {
                self.state.set_tied();
                self.set_conn(Conn::TiedToJob);
            } else {
                self.act(action);
                // `Connected` maps to `Action::None`; still update the chip.
                if done.outcome == ConnectOutcome::Connected {
                    self.set_conn(Conn::Connected);
                }
            }
        }
        changed
    }
}

/// The daemon beside this exe, when the desk runs from a build or install dir.
fn daemon_exe() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join(daemon_exe_name())))
}

/// Spawn one worker running `connect_attempt` and delivering the result.
fn spawn_connect_worker(rocky_home: PathBuf, tx: mpsc::Sender<ConnectDone>) {
    std::thread::spawn(move || {
        let exe = daemon_exe();
        let _ = tx.send(connect_attempt(&rocky_home, exe.as_deref(), CONNECT_BUDGET));
    });
}

struct DeskView {
    ctl: Controller,
    window: Option<WindowHandle<Self>>,
    tray: Option<Tray>,
    log: LogOnce,
    /// Platform notifications; Windows keeps the latest toast per session, so
    /// a late click still reaches its handler.
    notices: OsNotices,
    /// Toast clicks cross from a WinRT thread on this channel.
    click_tx: mpsc::Sender<()>,
    clicks: Receiver<()>,
    /// Set by a toast click or the `show` relay; the pump reveals the window
    /// outside the view lease.
    show_requested: bool,
    /// The notification identity is prepared at most once per process.
    notices_ready: bool,
    /// Repos and harnesses already announced, kept in `desk/notified.json`.
    notified: NotifiedStore,
    notified_path: PathBuf,
    /// Setup requests in flight, matched to their replies by id.
    requests: Requests,
    /// First-use consent screen state.
    consent: ConsentModel,
    /// Settings setup sections: switches, repos and Remove Rocky.
    setup: SetupSettings,
    /// Paginated, searchable change cards list state.
    cards: CardsModel,
    /// Open change card detail view-model, when viewing a card.
    card_detail: Option<DetailModel>,
    /// Open paged unified diff view-model, when viewing a block diff.
    block_diff: Option<DiffModel>,
    /// Whether the Notices collapsible card is expanded.
    notices_open: bool,
    /// Whether the idle sessions disclosure inside Now is expanded.
    idle_open: bool,
    /// Current query text inside the change cards search box.
    search: SearchInput,
    /// 300 ms debounce state driving card search requests.
    search_debounce: Debounce,
    /// Keyboard focus handle for the cards search input.
    search_focus: FocusHandle,
    /// When the final screen gives up waiting for the daemon's quit broadcast.
    removed_quit_at: Option<u64>,
    /// User home directory resolved once at startup for short Now step paths.
    home_dir: Option<String>,
    /// The tray menu must be rebuilt for the new language. Done by the pump
    /// outside the view lease, since the builder reads this entity.
    menu_stale: bool,
    /// The user has opened the window since start, which ends the `--tray`
    /// start's minimize retries. Only that retry reads it.
    #[cfg(not(windows))]
    user_shown: bool,
    /// Page under `View::Agents`: the agent list or the Flow graph. A card
    /// modal opens over it and closing returns to it.
    main_tab: Tab,
    /// Flow row under the pointer, whose strands are drawn forward.
    flow_hover: Option<FlowHover>,
    /// Focus inside the card modal, so Escape reaches it.
    modal_focus: FocusHandle,
    /// Focus on the window root, so Tab and Escape reach the desk's key
    /// handler while no control has focus yet.
    root_focus: FocusHandle,
}

impl DeskView {
    fn next_id(&mut self) -> u64 {
        self.ctl.cmd_id += 1;
        self.ctl.cmd_id
    }

    /// Send a `set` and remember its id so a failed ack can be attributed.
    fn send_set(&mut self, id: u64, msg: ClientMsg) {
        let Some(outbox) = self.ctl.outbox.as_ref() else {
            return;
        };
        if outbox.send(msg).is_ok() {
            self.ctl.model.set_sent(id);
        }
    }

    /// Toggle one daemon setting; the UI moves only on the next broadcast.
    fn toggle_setting(&mut self, setting: SettingId) {
        if !self.ctl.model.editable() {
            return;
        }
        let Some(on) = self.ctl.model.settings().map(|s| setting.get(s)) else {
            return;
        };
        let id = self.next_id();
        self.send_set(id, set_bool(id, setting, !on));
    }

    /// Ask for another UI language; the broadcast applies it.
    fn choose_lang(&mut self, lang: Lang) {
        if !self.ctl.model.editable() {
            return;
        }
        let id = self.next_id();
        self.send_set(id, set_lang(id, lang));
    }

    fn toggle_view(&mut self, cx: &mut Context<Self>) {
        self.ctl.view = match self.ctl.view {
            View::Agents | View::CardDetail | View::BlockDiff => {
                self.card_detail = None;
                self.block_diff = None;
                View::Settings
            }
            View::Settings | View::Consent => View::Agents,
            View::Removed => View::Removed,
        };
        if self.ctl.view == View::Settings {
            self.read_autostart();
            self.refresh_setup();
        }
        cx.notify();
    }

    /// The tab the title bar shows as current.
    fn active_tab(&self) -> Tab {
        match self.ctl.view {
            View::Settings => Tab::Settings,
            _ => self.main_tab,
        }
    }

    /// Title bar tab click: any open card closes, then the page switches.
    fn select_tab(&mut self, tab: Tab, _window: &mut Window, cx: &mut Context<Self>) {
        if matches!(self.ctl.view, View::Consent | View::Removed) {
            return;
        }
        self.card_detail = None;
        self.block_diff = None;
        self.flow_hover = None;
        match tab {
            Tab::Agents | Tab::Flow => {
                self.main_tab = tab;
                self.ctl.view = View::Agents;
            }
            Tab::Settings => {
                if self.ctl.view != View::Settings {
                    self.ctl.view = View::Settings;
                    self.read_autostart();
                    self.refresh_setup();
                }
            }
        }
        cx.notify();
    }

    /// Escape, the backdrop, or Close: a diff steps back to its card, a card
    /// closes to the page underneath.
    fn close_modal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let action = if self.ctl.view == View::BlockDiff {
            CardAction::BackFromDiff
        } else {
            CardAction::BackFromDetail
        };
        self.on_card_action(action, window, cx);
        if self.ctl.view != View::BlockDiff && self.ctl.view != View::CardDetail {
            self.root_focus.focus(window);
        }
    }

    fn on_flow_hover(&mut self, row: FlowHover, entered: bool, cx: &mut Context<Self>) {
        // Moving between rows sends the enter and the leave in either order;
        // a leave clears only the row still marked.
        let next = if entered {
            Some(row)
        } else if self.flow_hover == Some(row) {
            None
        } else {
            return;
        };
        if next != self.flow_hover {
            self.flow_hover = next;
            cx.notify();
        }
    }

    /// Adopt a language broadcast: rebuild the tray menu and re-send the
    /// tooltip in the new language.
    fn sync_lang(&mut self, setting: Lang, cx: &mut Context<Self>) {
        let lang = resolve_lang(setting, self.ctl.detected);
        if lang == self.ctl.ui_lang {
            return;
        }
        self.ctl.ui_lang = lang;
        // A value `tooltip` never returns forces the next refresh to re-send it.
        self.ctl.last_tooltip = Msg::NoAgents;
        self.menu_stale = true;
        cx.notify();
    }

    fn on_now_action(&mut self, action: NowAction, window: &mut Window, cx: &mut Context<Self>) {
        match action {
            NowAction::ToggleNotices => {
                self.notices_open = !self.notices_open;
                cx.notify();
            }
            NowAction::ToggleAgent(key) => {
                self.ctl.toggle_open(&key, now_ms());
                cx.notify();
            }
            NowAction::ToggleIdle => {
                self.idle_open = !self.idle_open;
                cx.notify();
            }
            NowAction::OpenCard(card_id) => {
                self.on_card_action(CardAction::OpenDetail(card_id), window, cx);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use rocky_proto::pipe::{AgentStatus, Health, Outcome, RepoInfo, TimelineEntry, TimelineKind};
    use rocky_proto::settings::Settings;

    use super::*;

    fn test_controller() -> (Controller, Receiver<ClientMsg>) {
        let (out_tx, out_rx) = mpsc::channel();
        let (worker_tx, worker_rx) = mpsc::channel();
        let ctl = Controller {
            model: Model::new(),
            timeline_fetch: TimelineFetch::new(),
            notifier: Notifier::default(),
            inbox: None,
            outbox: Some(out_tx),
            worker_rx,
            worker_tx,
            state: ConnState::new(3, 300_000),
            cmd_id: 0,
            rocky_home: PathBuf::from("."),
            last_aggregate: Status::Idle,
            last_tooltip: Msg::NoAgents,
            ui_lang: UiLang::En,
            detected: UiLang::En,
            view: View::Agents,
            tray_start: false,
            autostart_on: None,
            autostart_failed: false,
        };
        (ctl, out_rx)
    }

    fn test_agent_with_id(
        session_id: &str,
        agent_id: &str,
        status: Status,
        last_event_ms: u64,
    ) -> AgentStatus {
        AgentStatus {
            key: AgentKey {
                session_id: session_id.to_string(),
                agent_id: agent_id.to_string(),
            },
            agent_type: (!agent_id.is_empty()).then(|| "Explore".to_string()),
            status,
            action: None,
            summary: None,
            description: None,
            failures: 0,
            last_event_ms,
            quiet_10m: false,
            repo: RepoInfo {
                root: Some("/repos/rocky".to_string()),
                main_root: None,
                name: "rocky".to_string(),
                branch: Some("main".to_string()),
            },
            prompt: None,
            harness: None,
        }
    }

    fn test_agent(session_id: &str, status: Status, last_event_ms: u64) -> AgentStatus {
        test_agent_with_id(session_id, "", status, last_event_ms)
    }

    fn apply_at(ctl: &mut Controller, msg: ServerMsg, now_ms: u64) {
        let copy = msg.clone();
        let legacy = ctl.model.apply(msg);
        for key in ctl.collect_timeline_requests(&copy, legacy, now_ms) {
            ctl.request_timeline(key);
        }
    }

    fn drain_timelines(rx: &Receiver<ClientMsg>) -> Vec<AgentKey> {
        let mut keys = Vec::new();
        while let Ok(msg) = rx.try_recv() {
            if let ClientMsg::Timeline { key, .. } = msg {
                keys.push(key);
            }
        }
        keys
    }

    #[test]
    fn controller_debounces_expansion_after_snapshot_fetch() {
        let (mut ctl, rx) = test_controller();
        let k1 = AgentKey {
            session_id: "S1".to_string(),
            agent_id: String::new(),
        };

        apply_at(
            &mut ctl,
            ServerMsg::Snapshot {
                agents: vec![test_agent("S1", Status::Working, 900)],
                aggregate: Status::Working,
                health: Health::default(),
                settings: Settings::default(),
                repo_pending: Vec::new(),
            },
            1_000,
        );
        assert_eq!(drain_timelines(&rx), vec![k1.clone()]);

        // Simulate daemon reply caching the timeline before expansion.
        apply_at(
            &mut ctl,
            ServerMsg::Timeline {
                id: 1,
                key: k1.clone(),
                entries: vec![TimelineEntry {
                    ms: 950,
                    kind: TimelineKind::Tool,
                    tool_name: Some("Bash".to_string()),
                    text: Some("cargo test".to_string()),
                    outcome: Some(Outcome::Ok),
                    dur_ms: Some(1_000),
                }],
            },
            1_050,
        );
        assert!(drain_timelines(&rx).is_empty());

        // Expanding within 500 ms must use the cached timeline and emit no extra request.
        ctl.toggle_open(&k1, 1_100);
        assert!(ctl.model.is_open(&k1));
        assert_eq!(
            ctl.model.timeline_rows(&k1, &crate::clock::utc_hhmm).len(),
            1
        );
        assert!(
            drain_timelines(&rx).is_empty(),
            "expansion inside 500 ms cooldown must not send a second timeline request"
        );

        ctl.poll_timelines(1_499);
        assert!(drain_timelines(&rx).is_empty());

        ctl.poll_timelines(1_500);
        assert_eq!(drain_timelines(&rx), vec![k1.clone()]);

        // Leaving active while open must not emit a dead request via legacy open requests.
        apply_at(
            &mut ctl,
            ServerMsg::Status {
                op: rocky_proto::pipe::StatusOp::Upsert,
                agent: test_agent("S1", Status::Done, 2_100),
            },
            2_100,
        );
        assert!(drain_timelines(&rx).is_empty());
    }

    #[test]
    fn controller_rapid_child_collapse_and_reopen_refills_timeline() {
        let (mut ctl, rx) = test_controller();
        let k_main = AgentKey {
            session_id: "S1".to_string(),
            agent_id: String::new(),
        };
        let k_child = AgentKey {
            session_id: "S1".to_string(),
            agent_id: "sub-1".to_string(),
        };

        apply_at(
            &mut ctl,
            ServerMsg::Snapshot {
                agents: vec![
                    test_agent("S1", Status::Working, 900),
                    test_agent_with_id("S1", "sub-1", Status::Working, 950),
                ],
                aggregate: Status::Working,
                health: Health::default(),
                settings: Settings::default(),
                repo_pending: Vec::new(),
            },
            1_000,
        );
        assert_eq!(drain_timelines(&rx), vec![k_main]);

        ctl.toggle_open(&k_child, 1_000);
        assert!(ctl.model.is_open(&k_child));
        assert_eq!(drain_timelines(&rx), vec![k_child.clone()]);

        apply_at(
            &mut ctl,
            ServerMsg::Timeline {
                id: 1,
                key: k_child.clone(),
                entries: vec![TimelineEntry {
                    ms: 960,
                    kind: TimelineKind::Tool,
                    tool_name: Some("Read".to_string()),
                    text: Some("src/lib.rs".to_string()),
                    outcome: Some(Outcome::Ok),
                    dur_ms: Some(100),
                }],
            },
            1_050,
        );
        assert_eq!(
            ctl.model
                .timeline_rows(&k_child, &crate::clock::utc_hhmm)
                .len(),
            1
        );

        // Collapse clears cached child entries; reopening inside 500 ms must fetch again directly.
        ctl.toggle_open(&k_child, 1_100);
        assert!(!ctl.model.is_open(&k_child));
        assert!(
            ctl.model
                .timeline_rows(&k_child, &crate::clock::utc_hhmm)
                .is_empty()
        );
        assert!(drain_timelines(&rx).is_empty());

        ctl.toggle_open(&k_child, 1_200);
        assert!(ctl.model.is_open(&k_child));
        assert_eq!(
            drain_timelines(&rx),
            vec![k_child.clone()],
            "reopening a child row inside 500 ms must re-request its timeline directly"
        );

        apply_at(
            &mut ctl,
            ServerMsg::Timeline {
                id: 2,
                key: k_child.clone(),
                entries: vec![
                    TimelineEntry {
                        ms: 960,
                        kind: TimelineKind::Tool,
                        tool_name: Some("Read".to_string()),
                        text: Some("src/lib.rs".to_string()),
                        outcome: Some(Outcome::Ok),
                        dur_ms: Some(100),
                    },
                    TimelineEntry {
                        ms: 1_180,
                        kind: TimelineKind::Tool,
                        tool_name: Some("Grep".to_string()),
                        text: Some("TimelineFetch".to_string()),
                        outcome: Some(Outcome::Pending),
                        dur_ms: None,
                    },
                ],
            },
            1_250,
        );
        assert_eq!(
            ctl.model
                .timeline_rows(&k_child, &crate::clock::utc_hhmm)
                .len(),
            2
        );

        ctl.poll_timelines(1_500);
        assert!(drain_timelines(&rx).is_empty());
    }

    #[test]
    fn controller_open_child_status_upsert_inside_cooldown_still_sends() {
        let (mut ctl, rx) = test_controller();
        let k_main = AgentKey {
            session_id: "S1".to_string(),
            agent_id: String::new(),
        };
        let k_child = AgentKey {
            session_id: "S1".to_string(),
            agent_id: "sub-1".to_string(),
        };

        apply_at(
            &mut ctl,
            ServerMsg::Snapshot {
                agents: vec![
                    test_agent("S1", Status::Working, 900),
                    test_agent_with_id("S1", "sub-1", Status::Working, 950),
                ],
                aggregate: Status::Working,
                health: Health::default(),
                settings: Settings::default(),
                repo_pending: Vec::new(),
            },
            1_000,
        );
        assert_eq!(drain_timelines(&rx), vec![k_main]);

        ctl.toggle_open(&k_child, 1_000);
        assert_eq!(drain_timelines(&rx), vec![k_child.clone()]);

        apply_at(
            &mut ctl,
            ServerMsg::Status {
                op: rocky_proto::pipe::StatusOp::Upsert,
                agent: test_agent_with_id("S1", "sub-1", Status::Working, 1_200),
            },
            1_200,
        );
        assert_eq!(
            drain_timelines(&rx),
            vec![k_child.clone()],
            "open child status upsert inside 500 ms must send directly"
        );

        apply_at(
            &mut ctl,
            ServerMsg::Status {
                op: rocky_proto::pipe::StatusOp::Upsert,
                agent: test_agent_with_id("S1", "sub-1", Status::NeedsYou, 1_350),
            },
            1_350,
        );
        assert_eq!(drain_timelines(&rx), vec![k_child.clone()]);

        apply_at(
            &mut ctl,
            ServerMsg::Status {
                op: rocky_proto::pipe::StatusOp::Upsert,
                agent: test_agent_with_id("S1", "sub-1", Status::Done, 1_400),
            },
            1_400,
        );
        assert!(drain_timelines(&rx).is_empty());

        // A child initially promoted in a main-less session becomes unthrottled once main arrives.
        let k_s2_main = AgentKey {
            session_id: "S2".to_string(),
            agent_id: String::new(),
        };
        let k_s2_child = AgentKey {
            session_id: "S2".to_string(),
            agent_id: "sub-a".to_string(),
        };
        apply_at(
            &mut ctl,
            ServerMsg::Status {
                op: rocky_proto::pipe::StatusOp::Upsert,
                agent: test_agent_with_id("S2", "sub-a", Status::Working, 1_000),
            },
            1_000,
        );
        assert_eq!(drain_timelines(&rx), vec![k_s2_child.clone()]);

        apply_at(
            &mut ctl,
            ServerMsg::Status {
                op: rocky_proto::pipe::StatusOp::Upsert,
                agent: test_agent("S2", Status::Working, 1_100),
            },
            1_100,
        );
        assert_eq!(drain_timelines(&rx), vec![k_s2_main]);

        ctl.toggle_open(&k_s2_child, 1_150);
        assert_eq!(drain_timelines(&rx), vec![k_s2_child.clone()]);

        apply_at(
            &mut ctl,
            ServerMsg::Status {
                op: rocky_proto::pipe::StatusOp::Upsert,
                agent: test_agent_with_id("S2", "sub-a", Status::Working, 1_200),
            },
            1_200,
        );
        assert_eq!(drain_timelines(&rx), vec![k_s2_child]);
    }
}
