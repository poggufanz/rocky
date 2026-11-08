//! GPUI window, tray wiring, and connection controller for rocky-desk.
//!
//! The reader thread (see [`crate::client`]) pushes decoded messages into an
//! `mpsc` channel. A foreground `cx.spawn` pump drains that channel on a timer,
//! applies messages to the [`Model`], and refreshes the window and tray.
//! Connection decisions live in the pure [`crate::conn::ConnState`]; the actual
//! connect/spawn/retry work runs on a background worker thread so the UI never
//! blocks, and its result comes back through a second channel the pump drains.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use gpui::prelude::*;
use gpui::{
    App, Application, Bounds, Context, Div, Entity, IntoElement, MenuItem, Render, SharedString,
    TitlebarOptions, Window, WindowBounds, WindowHandle, WindowOptions, div, px, rgb, size,
};
use gpui_tray::Tray;
use rocky_proto::paths::desk_dir;
use rocky_proto::pipe::{AgentKey, ClientMsg, CmdName, Outcome, ServerMsg, Status};
use rocky_proto::settings::Lang;

use crate::autostart::{self, RunOptions};
use crate::client::Outbox;
use crate::clock;
use crate::conn::{Action, ConnState, ConnectOutcome};
use crate::connect::{CONNECT_BUDGET, ConnectDone, connect_attempt};
use crate::desklog::LogOnce;
use crate::i18n::{Msg, UiLang, detect_ui_lang, resolve_lang, tr};
use crate::icons::tray_icon;
use crate::notify::{Notifier, NotifyCtx, notice_text, toast_tag};
use crate::settings_view::{
    self, SettingId, View, set_autostart_asked, set_bool, set_lang, show_autostart_banner,
};
use crate::toast::{ToastHandle, ensure_icon_file, register_aumid, set_process_aumid, show_toast};
use crate::view::{Conn, Model};

gpui::actions!(rocky, [OpenRocky, StopRecording, QuitDesk]);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

struct Controller {
    model: Model,
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
        .and_then(|p| p.parent().map(|d| d.join("rockyd.exe")))
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
    /// Latest toast per tag, so a late click still reaches its handler.
    toasts: BTreeMap<String, ToastHandle>,
    /// Toast clicks cross from a WinRT thread on this channel.
    click_tx: mpsc::Sender<()>,
    clicks: Receiver<()>,
    /// Set by a click; the pump reveals the window outside the view lease.
    show_requested: bool,
    /// The toast identity is registered at most once per process.
    aumid_ready: bool,
    /// The tray menu must be rebuilt for the new language. Done by the pump
    /// outside the view lease, since the builder reads this entity.
    menu_stale: bool,
}

impl DeskView {
    fn refresh_tray(&mut self, cx: &mut App) {
        let Some(tray) = self.tray.as_ref() else {
            return;
        };
        let agg = self.ctl.model.aggregate();
        if agg != self.ctl.last_aggregate {
            self.ctl.last_aggregate = agg;
            if let Err(e) = tray.set_icon(tray_icon(agg), cx) {
                self.log.once("set_icon", &e);
            }
        }
        let tip = self.ctl.model.tooltip();
        if tip != self.ctl.last_tooltip {
            self.ctl.last_tooltip = tip.clone();
            if let Err(e) = tray.set_tooltip(Some(tr(self.ctl.ui_lang, &tip)), cx) {
                self.log.once("set_tooltip", &e);
            }
        }
    }

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
            View::Agents => View::Settings,
            View::Settings => View::Agents,
        };
        if self.ctl.view == View::Settings {
            self.read_autostart();
        }
        cx.notify();
    }

    /// Read the sign-in registration from the Run key.
    fn read_autostart(&mut self) {
        match std::env::current_exe().and_then(|exe| autostart::state(&exe)) {
            Ok(on) => {
                self.ctl.autostart_on = Some(on);
                self.ctl.autostart_failed = false;
            }
            Err(e) => {
                self.ctl.autostart_failed = true;
                self.log.once("autostart", &e);
            }
        }
    }

    fn toggle_autostart(&mut self, cx: &mut Context<Self>) {
        if !self.ctl.model.editable() {
            return;
        }
        let Some(on) = self.ctl.autostart_on else {
            return;
        };
        let result = if on {
            autostart::disable()
        } else {
            std::env::current_exe().and_then(|exe| autostart::enable(&exe))
        };
        match result {
            Ok(()) => self.read_autostart(),
            Err(e) => {
                self.ctl.autostart_failed = true;
                self.log.once("autostart", &e);
            }
        }
        cx.notify();
    }

    /// Answer the sign-in question. Both answers mark it asked; only Yes
    /// writes the Run value.
    fn answer_autostart(&mut self, yes: bool, cx: &mut Context<Self>) {
        if yes {
            match std::env::current_exe().and_then(|exe| autostart::enable(&exe)) {
                Ok(()) => {
                    self.ctl.autostart_on = Some(true);
                    self.ctl.autostart_failed = false;
                }
                Err(e) => {
                    self.ctl.autostart_failed = true;
                    self.log.once("autostart", &e);
                }
            }
        }
        let id = self.next_id();
        self.send_set(id, set_autostart_asked(id));
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

    /// The one-time sign-in question, shown while it is unanswered.
    fn banner(&mut self, cx: &mut Context<Self>) -> Option<Div> {
        if !show_autostart_banner(self.ctl.tray_start, self.ctl.model.settings()) {
            return None;
        }
        let lang = self.ctl.ui_lang;
        let mut banner = div()
            .flex()
            .flex_col()
            .gap_2()
            .p_2()
            .rounded_sm()
            .bg(rgb(0xE4E9F7));
        banner = banner.child(div().text_sm().child(tr(lang, &Msg::AutostartQuestion)));
        let mut buttons = div().flex().gap_2();
        for (label, yes) in [(Msg::Yes, true), (Msg::No, false)] {
            let id = if yes { "autostart-yes" } else { "autostart-no" };
            buttons = buttons.child(
                div()
                    .id(SharedString::from(id))
                    .px_2()
                    .rounded_sm()
                    .bg(rgb(0xFFFFFF))
                    .text_sm()
                    .cursor_pointer()
                    .child(tr(lang, &label))
                    .on_click(cx.listener(move |this, _, _, cx| this.answer_autostart(yes, cx))),
            );
        }
        banner = banner.child(buttons);
        if self.ctl.autostart_failed {
            banner = banner.child(
                div()
                    .text_xs()
                    .text_color(rgb(0xD92B2B))
                    .child(tr(lang, &Msg::AutostartFailed)),
            );
        }
        Some(banner)
    }

    /// Toggles reflect the last broadcast settings; sign-in state is read
    /// locally. Nothing here changes until the daemon confirms a `set`.
    fn settings_panel(&mut self, cx: &mut Context<Self>) -> Div {
        let lang = self.ctl.ui_lang;
        let editable = self.ctl.model.editable();
        let settings = self.ctl.model.settings().cloned();
        let mut panel = div().flex().flex_col().gap_2();
        if !editable {
            panel = panel.child(div().text_sm().child(tr(lang, &Msg::SettingsReadOnly)));
        }
        let Some(settings) = settings else {
            return panel;
        };
        for setting in SettingId::ALL {
            panel = panel.child(settings_view::toggle_row(
                SharedString::from(format!("setting:{}", setting.wire_name())),
                tr(lang, &setting.label()),
                setting.get(&settings),
                editable,
                cx.listener(move |this, _, _, _| this.toggle_setting(setting)),
            ));
        }
        if !settings.tool_text && settings.history {
            panel = panel.child(div().text_xs().child(tr(lang, &Msg::ToolTextHistoryNote)));
        }
        let mut langs = div().flex().gap_2();
        for (value, label) in [
            (Lang::Auto, Msg::LangAuto),
            (Lang::En, Msg::LangEn),
            (Lang::Id, Msg::LangId),
        ] {
            langs = langs.child(settings_view::choice(
                SharedString::from(format!("lang:{value:?}")),
                tr(lang, &label),
                settings.lang == value,
                editable,
                cx.listener(move |this, _, _, _| this.choose_lang(value)),
            ));
        }
        panel = panel.child(langs);
        panel = panel.child(settings_view::toggle_row(
            SharedString::from("setting:autostart"),
            tr(lang, &Msg::Autostart),
            self.ctl.autostart_on.unwrap_or(false),
            editable,
            cx.listener(|this, _, _, cx| this.toggle_autostart(cx)),
        ));
        if self.ctl.autostart_failed {
            panel = panel.child(
                div()
                    .text_xs()
                    .text_color(rgb(0xD92B2B))
                    .child(tr(lang, &Msg::AutostartFailed)),
            );
        }
        if let Some(err) = self.ctl.model.set_error() {
            panel = panel.child(div().text_sm().text_color(rgb(0xD92B2B)).child(tr(
                lang,
                &Msg::SetFailed {
                    reason: err.to_string(),
                },
            )));
        }
        panel
    }

    /// Register the toast identity once, after the first settings with a
    /// notice toggle on. A failed icon write or registry write is logged and
    /// not retried, so a broken key cannot make every broadcast write.
    fn register_toasts(&mut self) {
        if self.aumid_ready {
            return;
        }
        let Some(settings) = self.ctl.model.settings() else {
            return;
        };
        if !(settings.notify_needs_you || settings.notify_failed || settings.notify_done) {
            return;
        }
        self.aumid_ready = true;
        let icon = match ensure_icon_file(&self.ctl.rocky_home) {
            Ok(icon) => icon,
            Err(e) => {
                self.log.once("aumid", &e);
                return;
            }
        };
        if let Err(e) = register_aumid("rocky", Some(&icon)) {
            self.log.once("aumid", &e);
        }
    }

    /// Turn one message's notices into toasts. Each toast is held by its tag,
    /// which also makes a newer toast replace the one it supersedes.
    fn notify(&mut self, msg: &ServerMsg, window_active: bool) {
        let Some(settings) = self.ctl.model.settings() else {
            return;
        };
        let ctx = NotifyCtx {
            now_ms: now_ms(),
            window_active,
            settings,
        };
        let notices = self
            .ctl
            .notifier
            .on_message(msg, self.ctl.model.agents(), &ctx);
        let lang = self.ctl.ui_lang;
        for n in &notices {
            let (title, body) = notice_text(lang, n);
            let tag = toast_tag(&n.session_id);
            let click_tx = self.click_tx.clone();
            let shown = show_toast(
                &title,
                &body,
                &tag,
                Box::new(move || {
                    let _ = click_tx.send(());
                }),
            );
            match shown {
                Ok(toast) => {
                    self.toasts.insert(tag, toast);
                }
                Err(e) => {
                    self.log.once("toast", &e);
                }
            }
        }
    }

    /// Toast clicks arrive from a WinRT thread; drain them and let the pump
    /// reveal the window outside the view lease.
    fn on_clicks(&mut self) {
        let mut clicked = false;
        while self.clicks.try_recv().is_ok() {
            clicked = true;
        }
        if clicked {
            self.show_requested = true;
        }
    }

    fn on_inbox(&mut self, cx: &mut Context<Self>, window_active: bool) {
        let mut changed = self.ctl.on_worker();
        let mut requests = Vec::new();
        let mut pending_lang = None;
        if let Some(inbox) = self.ctl.inbox.take() {
            let mut alive = true;
            loop {
                match inbox.try_recv() {
                    Ok(Some(msg)) => {
                        let settings_msg =
                            matches!(msg, ServerMsg::Snapshot { .. } | ServerMsg::Settings { .. });
                        if let ServerMsg::Snapshot { settings, .. }
                        | ServerMsg::Settings { settings } = &msg
                        {
                            pending_lang = Some(settings.lang);
                        }
                        if let ServerMsg::Ack { id, ok, .. } = &msg
                            && self.ctl.state.on_ack(*id, *ok)
                        {
                            // Ack state changed (stop acked or id cleared).
                        }
                        let for_notify = msg.clone();
                        requests.extend(self.ctl.model.apply(msg));
                        if settings_msg {
                            self.register_toasts();
                        }
                        self.notify(&for_notify, window_active);
                        changed = true;
                    }
                    Ok(None) | Err(mpsc::TryRecvError::Disconnected) => {
                        // Transition exactly once: the taken inbox stays
                        // dropped so the next tick has nothing to re-handle.
                        alive = false;
                        break;
                    }
                    Err(mpsc::TryRecvError::Empty) => break,
                }
            }
            if alive {
                self.ctl.inbox = Some(inbox);
            } else {
                self.ctl.outbox = None;
                let action = self.ctl.state.on_disconnect(now_ms());
                self.ctl.act(action);
                changed = true;
            }
        }
        if let Some(lang) = pending_lang {
            self.sync_lang(lang, cx);
        }
        for key in requests {
            self.ctl.request_timeline(key);
        }
        if changed {
            cx.notify();
        }
    }
}

impl Render for DeskView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let warnings = self.ctl.model.warnings(&clock::local_hhmm);
        let lang = self.ctl.ui_lang;
        // Opaque background: without one, gpui on Windows shows the desktop through.
        let mut root = div()
            .flex()
            .flex_col()
            .gap_2()
            .p_3()
            .size_full()
            .bg(rgb(0xF5F5F4))
            .text_color(rgb(0x1C1C1C));
        if let Some(banner) = self.banner(cx) {
            root = root.child(banner);
        }
        let other = match self.ctl.view {
            View::Agents => Msg::ViewSettings,
            View::Settings => Msg::ViewAgents,
        };
        root = root.child(
            div()
                .id(SharedString::from("view-toggle"))
                .text_sm()
                .cursor_pointer()
                .child(tr(lang, &other))
                .on_click(cx.listener(|this, _, _, cx| this.toggle_view(cx))),
        );
        if !warnings.is_empty() {
            let mut strip = div().flex_col().gap_1();
            for w in &warnings {
                strip = strip.child(div().text_sm().child(tr(lang, w)));
            }
            root = root.child(strip);
        }
        if self.ctl.view == View::Settings {
            return root.child(self.settings_panel(cx));
        }
        let groups = self.ctl.model.groups(now_ms());
        if groups.is_empty() {
            root = root.child(div().text_sm().child(tr(lang, &Msg::NoAgents)));
        }
        for g in &groups {
            let mut gdiv = div().flex_col().gap_1();
            gdiv = gdiv.child(div().text_sm().child(g.label(lang)));
            for s in &g.sessions {
                let mut sdiv = div().flex_col().pl_2();
                sdiv = sdiv.child(div().text_xs().child(tr(
                    lang,
                    &Msg::Session {
                        short: s.session_short.clone(),
                    },
                )));
                for a in &s.rows {
                    let mut row = div()
                        .id(SharedString::from(format!(
                            "agent:{}:{}",
                            a.key.session_id, a.key.agent_id
                        )))
                        .flex()
                        .gap_2()
                        .text_sm()
                        .cursor_pointer()
                        .on_click(cx.listener({
                            let key = a.key.clone();
                            move |this, _event, _window, cx| {
                                if let Some(key) = this.ctl.model.toggle_open(&key) {
                                    this.ctl.request_timeline(key);
                                }
                                cx.notify();
                            }
                        }));
                    if a.child {
                        row = row.pl_3();
                    }
                    let mut label = div().flex_col();
                    label = label.child(div().child(a.label.clone()));
                    if let Some(desc) = &a.description {
                        label = label.child(div().text_xs().child(desc.clone()));
                    }
                    row = row
                        .child(chip(a.status, lang))
                        .child(label)
                        .child(div().child(tr(lang, &a.age)));
                    if a.failures > 0 {
                        row = row.child(div().child(tr(lang, &Msg::Failures { n: a.failures })));
                    }
                    if let Some(act) = &a.action_text {
                        row = row.child(div().text_xs().child(act.clone()));
                    }
                    if let Some(note) = &a.note {
                        row = row.child(div().text_xs().child(tr(lang, note)));
                    }
                    sdiv = sdiv.child(row);
                    if self.ctl.model.is_open(&a.key) {
                        let mut entries = div().flex_col().pl_6().text_xs();
                        for e in self.ctl.model.timeline_rows(&a.key, &clock::local_hhmm) {
                            let mut line = div()
                                .flex()
                                .gap_2()
                                .child(div().text_color(rgb(0x8A8A8A)).child(e.time))
                                .child(div().child(tr(lang, &e.text)));
                            if let Some(outcome) = e.outcome {
                                let color = match outcome {
                                    Outcome::Failed => rgb(0xD92B2B),
                                    Outcome::Ok => rgb(0x2BA044),
                                    Outcome::Pending => rgb(0x8A8A8A),
                                };
                                line = line.child(
                                    div()
                                        .text_color(color)
                                        .child(tr(lang, &Msg::Outcome(outcome))),
                                );
                            }
                            entries = entries.child(line);
                        }
                        sdiv = sdiv.child(entries);
                    }
                }
                if let Some(hidden) = &s.hidden_children {
                    sdiv = sdiv.child(div().text_xs().pl_3().child(tr(lang, hidden)));
                }
                gdiv = gdiv.child(sdiv);
            }
            root = root.child(gdiv);
        }
        root
    }
}

/// Restore and focus the desk window. Call it outside any `view.update`: the
/// window's root view is `view`, so updating the window inside that lease
/// double-borrows the entity and panics, which aborts inside the tray callback.
fn show_window(view: &Entity<DeskView>, cx: &mut App) {
    if let Some(handle) = view.read(cx).window {
        let _ = handle.update(cx, |_, window, _| {
            set_visible(window, true);
            window.activate_window();
        });
    }
}

/// Hide or show the desk window. gpui 0.2.2 has no hide on Windows, so close
/// (vetoed) hides the HWND directly; the tray brings it back.
#[cfg(windows)]
fn set_visible(window: &Window, visible: bool) {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use windows_sys::Win32::UI::WindowsAndMessaging::{SW_HIDE, SW_SHOW, ShowWindow};
    // Fully qualified: gpui's inherent `Window::window_handle` returns its own handle type.
    let Ok(handle) = HasWindowHandle::window_handle(window) else {
        return;
    };
    if let RawWindowHandle::Win32(w) = handle.as_raw() {
        let cmd = if visible { SW_SHOW } else { SW_HIDE };
        // SAFETY: the HWND belongs to this live gpui window on this (UI) thread;
        // ShowWindow only changes its visibility.
        unsafe { ShowWindow(w.hwnd.get() as _, cmd) };
    }
}

#[cfg(not(windows))]
fn set_visible(window: &Window, visible: bool) {
    if !visible {
        window.minimize_window();
    }
}

fn chip(s: Status, lang: UiLang) -> Div {
    let bg = match s {
        Status::NeedsYou => rgb(0xE8B800),
        Status::Failed => rgb(0xD92B2B),
        Status::Working => rgb(0x2B7DD9),
        Status::Done => rgb(0x2BA044),
        Status::Idle | Status::Ended => rgb(0x8A8A8A),
    };
    div()
        .px_2()
        .rounded_sm()
        .bg(bg)
        .text_xs()
        .child(tr(lang, &Msg::Status(s)))
}

pub fn run(rocky_home: PathBuf, opts: RunOptions) {
    Application::new().run(move |cx: &mut App| {
        // Blocking startup attempt (the GPUI loop is not running yet).
        let exe = daemon_exe();
        let done = connect_attempt(&rocky_home, exe.as_deref(), CONNECT_BUDGET);
        let (outcome, tied, live) = (done.outcome, done.tied_to_job, done.live);
        let log_path = desk_dir(&rocky_home).join("rocky-desk.log");
        let mut log = LogOnce::new(log_path);
        if let Err(e) = set_process_aumid() {
            log.once("aumid", &e);
        }
        let (click_tx, clicks) = mpsc::channel::<()>();
        let (worker_tx, worker_rx) = mpsc::channel::<ConnectDone>();
        let state = ConnState::new(3, 300_000);
        let detected = detect_ui_lang();
        let mut ctl = Controller {
            model: Model::new(),
            notifier: Notifier::default(),
            inbox: None,
            outbox: None,
            worker_rx,
            worker_tx,
            state,
            cmd_id: 0,
            rocky_home,
            last_aggregate: Status::Idle,
            last_tooltip: Msg::Tooltip {
                working: 0,
                needs_you: 0,
                failed: 0,
                done: 0,
                idle: 0,
            },
            ui_lang: detected,
            detected,
            view: View::default(),
            tray_start: opts.tray,
            autostart_on: None,
            autostart_failed: false,
        };
        let action = ctl.state.on_connect_result(outcome);
        if let Some((outbox, inbox)) = live {
            ctl.outbox = Some(outbox);
            ctl.inbox = Some(inbox);
        }
        if tied {
            ctl.state.set_tied();
            ctl.set_conn(Conn::TiedToJob);
        } else {
            ctl.act(action);
            if outcome == ConnectOutcome::Connected {
                ctl.set_conn(Conn::Connected);
            }
        }
        let view: Entity<DeskView> = cx.new(|_cx| DeskView {
            ctl,
            window: None,
            tray: None,
            log,
            toasts: BTreeMap::new(),
            click_tx,
            clicks,
            show_requested: false,
            aumid_ready: false,
            menu_stale: false,
        });

        let window = cx
            .open_window(
                WindowOptions {
                    show: !opts.tray,
                    titlebar: Some(TitlebarOptions {
                        title: Some(SharedString::from("rocky")),
                        appears_transparent: false,
                        traffic_light_position: None,
                    }),
                    window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
                        None,
                        size(px(440.), px(560.)),
                        cx,
                    ))),
                    ..Default::default()
                },
                |_, _| view.clone(),
            )
            .expect("open window");
        view.update(cx, |v, _| {
            v.window = Some(window);
        });
        // Closing the window hides it: veto the close and minimize instead.
        if let Err(e) = window.update(cx, |_, window, cx| {
            window.on_window_should_close(&*cx, |window, _| {
                set_visible(window, false);
                false
            });
        }) {
            view.update(cx, |v, _| {
                v.log.once("close_veto", &e);
            });
        }

        let lang = view.read(cx).ctl.ui_lang;
        let agg = view.read(cx).ctl.model.aggregate();
        let tip = view.read(cx).ctl.model.tooltip();
        let tray = Tray::builder()
            .icon(tray_icon(agg))
            .tooltip(tr(lang, &tip))
            .on_activate_with({
                let view = view.clone();
                move |_, cx| show_window(&view, cx)
            })
            .menu({
                let view = view.clone();
                move |cx| {
                    let lang = view.read(cx).ctl.ui_lang;
                    vec![
                        MenuItem::action(tr(lang, &Msg::MenuOpen), OpenRocky),
                        MenuItem::action(tr(lang, &Msg::MenuStop), StopRecording),
                        MenuItem::action(tr(lang, &Msg::MenuQuit), QuitDesk),
                    ]
                }
            })
            .build(cx)
            .expect("build tray");
        view.update(cx, |v, _| {
            v.ctl.last_aggregate = agg;
            v.ctl.last_tooltip = tip;
            v.tray = Some(tray.clone());
        });

        cx.on_action({
            let view = view.clone();
            move |_: &OpenRocky, cx: &mut App| {
                view.update(cx, |v, cx| {
                    // User-initiated: one background connect+spawn when there
                    // is no live connection and none in flight. No slot used.
                    if v.ctl.outbox.is_none() && !v.ctl.state.is_connecting() {
                        let action = v.ctl.state.on_user_open();
                        v.ctl.act(action);
                        cx.notify();
                    }
                });
                show_window(&view, cx);
            }
        });
        cx.on_action({
            let view = view.clone();
            move |_: &StopRecording, cx: &mut App| {
                view.update(cx, |v, cx| {
                    v.ctl.cmd_id += 1;
                    let id = v.ctl.cmd_id;
                    if let Some(outbox) = v.ctl.outbox.as_ref() {
                        let _ = outbox.send(ClientMsg::Cmd {
                            name: CmdName::Stop,
                            id,
                        });
                        v.ctl.state.stop_sent(id);
                    }
                    cx.notify();
                });
            }
        });
        cx.on_action({
            let view = view.clone();
            move |_: &QuitDesk, cx: &mut App| {
                if let Some(tray) = view.read(cx).tray.clone() {
                    let _ = tray.close(cx);
                }
                cx.quit();
            }
        });

        // Pump: drain the reader inbox every 100 ms; age text refreshes
        // every 5 s. notify only fires on real changes or the slow tick.
        cx.spawn({
            let view = view.downgrade();
            async move |cx| {
                let mut tick = 0u32;
                loop {
                    cx.background_executor()
                        .timer(Duration::from_millis(100))
                        .await;
                    tick = tick.wrapping_add(1);
                    let slow = tick.is_multiple_of(50);
                    let alive = cx
                        .update(|cx| {
                            let Some(v) = view.upgrade() else {
                                return false;
                            };
                            // Read outside the view lease: the window's root
                            // view is this entity, so updating it inside
                            // `v.update` would double-borrow.
                            let handle = v.read(cx).window;
                            let active = handle.and_then(|h| h.is_active(cx)).unwrap_or(false);
                            let mut menu_stale = false;
                            let mut show = false;
                            v.update(cx, |v, cx| {
                                v.on_inbox(cx, active);
                                v.on_clicks();
                                v.refresh_tray(cx);
                                menu_stale = std::mem::take(&mut v.menu_stale);
                                show = std::mem::take(&mut v.show_requested);
                                if slow {
                                    cx.notify();
                                }
                            });
                            // The menu builder reads this view, so the
                            // rebuild must run outside the lease above.
                            if menu_stale
                                && let Some(tray) = v.read(cx).tray.clone()
                                && let Err(e) = tray.refresh_menu(cx)
                            {
                                v.update(cx, |v, _| {
                                    v.log.once("refresh_menu", &e);
                                });
                            }
                            if show {
                                show_window(&v, cx);
                            }
                            true
                        })
                        .unwrap_or(false);
                    if !alive {
                        break;
                    }
                }
            }
        })
        .detach();
    });
}
