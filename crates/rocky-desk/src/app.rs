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
use rocky_proto::translate::QuoteLang;

use crate::atlas_model::AtlasState;
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
use crate::requests::{RequestKind, Requests};
use crate::search_input::{Debounce, SearchInput};
use crate::settings_view::{SettingId, View, set_bool, set_lang, set_translate_quotes};
use crate::setup_settings::SetupSettings;
use crate::spawn::daemon_exe_name;
use crate::translate_model::{Outgoing, TranslateAction, TranslateFlow};
use crate::ui::cards_view::CardAction;
use crate::ui::flow_view::FlowHover;
use crate::ui::title_bar::Tab;
use crate::view::{Conn, Model};

mod atlas_wiring;
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
        let active_keys = self.model.active_timeline_keys();
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

    /// Dispatches deferred active timeline requests whose cooldown has elapsed.
    fn poll_timelines(&mut self, now_ms: u64) {
        let active_keys = self.model.active_timeline_keys();
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
    /// Quote translation download consent, status, and request error state.
    translate: TranslateFlow,
    /// Last resolved quote translation target language, for change detection.
    last_target: Option<QuoteLang>,
    /// Paginated, searchable change cards list state.
    cards: CardsModel,
    /// Open change card detail view-model, when viewing a card.
    card_detail: Option<DetailModel>,
    /// Open paged unified diff view-model, when viewing a block diff.
    block_diff: Option<DiffModel>,
    /// Whether the Notices collapsible card is expanded.
    notices_open: bool,
    /// Current query text inside the change cards search box.
    search: SearchInput,
    /// 300 ms debounce state driving card search requests.
    search_debounce: Debounce,
    /// Keyboard focus handle for the cards search input.
    search_focus: FocusHandle,
    /// When the final screen gives up waiting for the daemon's quit broadcast.
    removed_quit_at: Option<u64>,
    /// User home directory resolved once at startup for atlas step paths.
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
    /// Star atlas selection: project, layout, window, step, and turn.
    atlas: AtlasState,
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

    fn start_translate_request(&mut self, kind: RequestKind) {
        if !self.start_request(kind.clone()) && !self.requests.pending(&kind) {
            let reason = self.not_connected_text();
            self.translate.on_not_sent(&reason);
        }
    }

    /// Apply a quote translation settings action and emit any outgoing commands.
    fn translate_act(&mut self, action: TranslateAction) {
        if !self.ctl.model.editable() {
            return;
        }
        let Some(enabled) = self.ctl.model.settings().map(|s| s.translate_quotes) else {
            return;
        };
        let status = self.ctl.model.translate_status().clone();
        let outgoing = self
            .translate
            .act(action, enabled, &status, self.ctl.ui_lang);
        for cmd in outgoing {
            match cmd {
                Outgoing::SetEnabled(on) => {
                    let id = self.next_id();
                    self.send_set(id, set_translate_quotes(id, on));
                }
                Outgoing::Install(pair) => {
                    self.start_translate_request(RequestKind::TranslateInstall(pair));
                }
                Outgoing::Remove => {
                    self.start_translate_request(RequestKind::TranslateRemove);
                }
            }
        }
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
        if self.translate.asking().is_some() {
            let enabled = self
                .ctl
                .model
                .settings()
                .is_some_and(|s| s.translate_quotes);
            let status = self.ctl.model.translate_status().clone();
            self.translate
                .act(TranslateAction::Cancel, enabled, &status, lang);
        }
        // A value `tooltip` never returns forces the next refresh to re-send it.
        self.ctl.last_tooltip = Msg::NoAgents;
        self.menu_stale = true;
        cx.notify();
    }

    /// Current quote translation target language, or `None` when disabled or not ready.
    fn translate_target(&self) -> Option<QuoteLang> {
        crate::translate_model::translate_target(
            self.ctl.model.settings(),
            self.ctl.model.translate_status(),
            self.ctl.ui_lang,
        )
    }

    /// Re-requests open views if the active translation target language changed.
    fn sync_translate_target(&mut self) -> bool {
        let target = self.translate_target();
        if target == self.last_target {
            return false;
        }
        self.last_target = target;
        let cards_id = self.next_id();
        if let Some(msg) = self.cards.set_target(target, cards_id) {
            self.send_card_msg(msg);
        }
        if self.card_detail.is_some() {
            let id = self.next_id();
            if let Some(msg) = self
                .card_detail
                .as_mut()
                .and_then(|detail| detail.retarget(id, target))
            {
                self.send_card_msg(msg);
            }
        }
        true
    }

    fn on_toggle_notices(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        self.notices_open = !self.notices_open;
        cx.notify();
    }
}

#[cfg(test)]
mod tests;
