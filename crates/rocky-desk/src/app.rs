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
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use gpui::prelude::*;
use gpui::{
    App, Application, Bounds, Context, Div, Entity, IntoElement, MenuItem, Render, SharedString,
    TitlebarOptions, Window, WindowBounds, WindowHandle, WindowOptions, div, px, rgb, size,
};
use gpui_tray::Tray;
use rocky_proto::paths::desk_dir;
use rocky_proto::pipe::{AgentKey, ClientMsg, CmdName, Outcome, ServerMsg, Status};

use crate::client::Outbox;
use crate::clock;
use crate::conn::{Action, ConnState, ConnectOutcome};
use crate::connect::{CONNECT_BUDGET, ConnectDone, connect_attempt};
use crate::desklog::LogOnce;
use crate::i18n::{Msg, UiLang, detect_ui_lang, tr};
use crate::icons::tray_icon;
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
    #[allow(dead_code)]
    detected: UiLang,
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

    fn on_inbox(&mut self, cx: &mut Context<Self>) {
        let mut changed = self.ctl.on_worker();
        let mut requests = Vec::new();
        if let Some(inbox) = self.ctl.inbox.as_ref() {
            loop {
                match inbox.try_recv() {
                    Ok(Some(msg)) => {
                        if let ServerMsg::Ack { id, ok, .. } = &msg
                            && self.ctl.state.on_ack(*id, *ok)
                        {
                            // Ack state changed (stop acked or id cleared).
                        }
                        requests.extend(self.ctl.model.apply(msg));
                        changed = true;
                    }
                    Ok(None) | Err(mpsc::TryRecvError::Disconnected) => {
                        // Transition exactly once: drop the dead inbox first so
                        // the next tick has nothing to re-handle.
                        self.ctl.inbox = None;
                        self.ctl.outbox = None;
                        let action = self.ctl.state.on_disconnect(now_ms());
                        self.ctl.act(action);
                        changed = true;
                        break;
                    }
                    Err(mpsc::TryRecvError::Empty) => break,
                }
            }
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
        let groups = self.ctl.model.groups(now_ms());
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
        if !warnings.is_empty() {
            let mut strip = div().flex_col().gap_1();
            for w in &warnings {
                strip = strip.child(div().text_sm().child(tr(lang, w)));
            }
            root = root.child(strip);
        }
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

pub fn run(rocky_home: PathBuf) {
    Application::new().run(move |cx: &mut App| {
        // Blocking startup attempt (the GPUI loop is not running yet).
        let exe = daemon_exe();
        let done = connect_attempt(&rocky_home, exe.as_deref(), CONNECT_BUDGET);
        let (outcome, tied, live) = (done.outcome, done.tied_to_job, done.live);
        let log_path = desk_dir(&rocky_home).join("rocky-desk.log");
        let (worker_tx, worker_rx) = mpsc::channel::<ConnectDone>();
        let state = ConnState::new(3, 300_000);
        let detected = detect_ui_lang();
        let mut ctl = Controller {
            model: Model::new(),
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
            log: LogOnce::new(log_path),
        });

        let window = cx
            .open_window(
                WindowOptions {
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
            .menu(move |_| {
                vec![
                    MenuItem::action(tr(lang, &Msg::MenuOpen), OpenRocky),
                    MenuItem::action(tr(lang, &Msg::MenuStop), StopRecording),
                    MenuItem::action(tr(lang, &Msg::MenuQuit), QuitDesk),
                ]
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
                            if let Some(v) = view.upgrade() {
                                v.update(cx, |v, cx| {
                                    v.on_inbox(cx);
                                    v.refresh_tray(cx);
                                    if slow {
                                        cx.notify();
                                    }
                                });
                                true
                            } else {
                                false
                            }
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
