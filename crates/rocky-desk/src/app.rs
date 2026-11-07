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
use rocky_proto::pipe::{ClientMsg, CmdName, ServerMsg, Status};

use crate::client::{self, Outbox};
use crate::conn::{Action, ConnState, ConnectOutcome};
use crate::icons::tray_icon;
use crate::spawn::spawn_daemon;
use crate::view::{Conn, Model};

gpui::actions!(rocky, [OpenRocky, StopRecording, QuitDesk]);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

/// Result of one background connect attempt, delivered to the foreground.
struct ConnectDone {
    outcome: ConnectOutcome,
    /// Present on `Connected`: the live outbox + inbox.
    live: Option<(Outbox, Receiver<Option<ServerMsg>>)>,
    /// True when the daemon was spawned without breakaway (sticky warning).
    tied_to_job: bool,
}

impl ConnectDone {
    fn failed(outcome: ConnectOutcome) -> Self {
        ConnectDone {
            outcome,
            live: None,
            tied_to_job: false,
        }
    }
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
    last_tooltip: String,
}

impl Controller {
    fn set_conn(&mut self, c: Conn) {
        self.model.set_conn(c);
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

/// One connect attempt: probe the pipe; on absence spawn the daemon and retry
/// with backoff (100 ms doubling, 5 s total). Keeps the live streams of the
/// winning attempt. Never retries foreign/wrong-version daemons. Blocking is
/// fine: runs on a worker thread (or pre-loop at startup).
fn connect_attempt(rocky_home: &std::path::Path) -> ConnectDone {
    let mut first = true;
    let mut tied = false;
    let mut wait = Duration::from_millis(100);
    let total = Duration::from_secs(5);
    let mut spent = Duration::ZERO;
    loop {
        let (tx, rx) = mpsc::channel();
        match client::connect_and_subscribe(rocky_home, tx) {
            Ok(outbox) => {
                return ConnectDone {
                    outcome: ConnectOutcome::Connected,
                    live: Some((outbox, rx)),
                    tied_to_job: tied,
                };
            }
            Err(client::ConnectError::Unverified) => {
                return ConnectDone::failed(ConnectOutcome::Unverified);
            }
            Err(client::ConnectError::VersionMismatch) => {
                return ConnectDone::failed(ConnectOutcome::VersionMismatch);
            }
            Err(_) => {}
        }
        if first {
            first = false;
            let exe = std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|d| d.join("rockyd.exe")));
            if let Some(exe) = exe {
                match spawn_daemon(&exe) {
                    Ok(info) => tied = info.tied_to_job,
                    Err(_) => return ConnectDone::failed(ConnectOutcome::SpawnFailed),
                }
            }
        }
        if spent >= total {
            return ConnectDone::failed(ConnectOutcome::NoDaemon);
        }
        std::thread::sleep(wait);
        spent += wait;
        wait = (wait * 2).min(Duration::from_secs(1));
    }
}

/// Spawn one worker running `connect_attempt` and delivering the result.
fn spawn_connect_worker(rocky_home: PathBuf, tx: mpsc::Sender<ConnectDone>) {
    std::thread::spawn(move || {
        let _ = tx.send(connect_attempt(&rocky_home));
    });
}

struct DeskView {
    ctl: Controller,
    window: Option<WindowHandle<Self>>,
    tray: Option<Tray>,
}

impl DeskView {
    fn refresh_tray(&mut self, cx: &mut App) {
        let Some(tray) = self.tray.as_ref() else {
            return;
        };
        let agg = self.ctl.model.aggregate();
        if agg != self.ctl.last_aggregate {
            self.ctl.last_aggregate = agg;
            let _ = tray.set_icon(tray_icon(agg), cx);
        }
        let tip = self.ctl.model.tooltip();
        if tip != self.ctl.last_tooltip {
            self.ctl.last_tooltip = tip.clone();
            let _ = tray.set_tooltip(Some(tip), cx);
        }
    }

    fn on_inbox(&mut self, cx: &mut Context<Self>) {
        let mut changed = self.ctl.on_worker();
        let Some(inbox) = self.ctl.inbox.as_ref() else {
            if changed {
                cx.notify();
            }
            return;
        };
        loop {
            match inbox.try_recv() {
                Ok(Some(msg)) => {
                    if let ServerMsg::Ack { id, ok, .. } = &msg
                        && self.ctl.state.on_ack(*id, *ok)
                    {
                        // Ack state changed (stop acked or id cleared).
                    }
                    self.ctl.model.apply(msg);
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
        if changed {
            cx.notify();
        }
    }
}

impl Render for DeskView {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        let groups = self.ctl.model.groups(now_ms());
        let warnings = self.ctl.model.warnings();
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
                strip = strip.child(div().text_sm().child(w.clone()));
            }
            root = root.child(strip);
        }
        if groups.is_empty() {
            root = root.child(div().text_sm().child("No agents recorded yet."));
        }
        for g in &groups {
            let mut gdiv = div().flex_col().gap_1();
            gdiv = gdiv.child(div().text_sm().child(g.label.clone()));
            for s in &g.sessions {
                let mut sdiv = div().flex_col().pl_2();
                sdiv = sdiv.child(
                    div()
                        .text_xs()
                        .child(format!("session {}", s.session_short)),
                );
                for a in &s.agents {
                    let mut row = div().flex().gap_2().text_sm();
                    row = row
                        .child(chip(a.status))
                        .child(div().child(a.label.clone()))
                        .child(div().child(a.age_text.clone()));
                    if a.failures > 0 {
                        row = row.child(div().child(format!("{} failures", a.failures)));
                    }
                    if let Some(act) = &a.action_text {
                        row = row.child(div().text_xs().child(act.clone()));
                    }
                    sdiv = sdiv.child(row);
                }
                gdiv = gdiv.child(sdiv);
            }
            root = root.child(gdiv);
        }
        root
    }
}

fn status_text(s: Status) -> &'static str {
    match s {
        Status::Idle => "idle",
        Status::Working => "working",
        Status::NeedsYou => "needs you",
        Status::Done => "done",
        Status::Failed => "failed",
        Status::Ended => "ended",
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

fn chip(s: Status) -> Div {
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
        .child(status_text(s).to_string())
}

pub fn run(rocky_home: PathBuf) {
    Application::new().run(move |cx: &mut App| {
        // Blocking startup attempt (the GPUI loop is not running yet).
        let done = connect_attempt(&rocky_home);
        let (outcome, tied, live) = (done.outcome, done.tied_to_job, done.live);
        let (worker_tx, worker_rx) = mpsc::channel::<ConnectDone>();
        let state = ConnState::new(3, 300_000);
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
            last_tooltip: String::new(),
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
        window
            .update(cx, |_, window, cx| {
                window.on_window_should_close(&*cx, |window, _| {
                    set_visible(window, false);
                    false
                });
            })
            .ok();

        let agg = view.read(cx).ctl.model.aggregate();
        let tip = view.read(cx).ctl.model.tooltip();
        let tray = Tray::builder()
            .icon(tray_icon(agg))
            .tooltip(tip.clone())
            .on_activate_with({
                let view = view.clone();
                move |_, cx| show_window(&view, cx)
            })
            .menu(|_| {
                vec![
                    MenuItem::action("Open rocky", OpenRocky),
                    MenuItem::action("Stop recording", StopRecording),
                    MenuItem::action("Quit", QuitDesk),
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
