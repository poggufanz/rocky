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

use gpui::{Context, FocusHandle, WindowHandle};
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
    /// Current query text inside the change cards search box.
    search: SearchInput,
    /// 300 ms debounce state driving card search requests.
    search_debounce: Debounce,
    /// Keyboard focus handle for the cards search input.
    search_focus: FocusHandle,
    /// When the final screen gives up waiting for the daemon's quit broadcast.
    removed_quit_at: Option<u64>,
    /// The tray menu must be rebuilt for the new language. Done by the pump
    /// outside the view lease, since the builder reads this entity.
    menu_stale: bool,
    /// The user has opened the window since start, which ends the `--tray`
    /// start's minimize retries. Only that retry reads it.
    #[cfg(not(windows))]
    user_shown: bool,
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
}
