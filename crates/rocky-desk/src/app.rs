//! GPUI window, tray wiring, and connection controller for rocky-desk.
//!
//! The reader thread (see [`crate::client`]) pushes decoded messages into an
//! `mpsc` channel. A foreground `cx.spawn` task drains that channel on a
//! timer, applies messages to the [`Model`], and refreshes the window and
//! tray. All respawn/stop decisions run on the foreground thread.

use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use gpui::prelude::*;
use gpui::{
    App, Application, Context, Div, Entity, IntoElement, MenuItem, Render, SharedString,
    TitlebarOptions, Window, WindowHandle, WindowOptions, div, rgb,
};
use gpui_tray::Tray;
use rocky_proto::pipe::{ClientMsg, CmdName, ServerMsg, Status};

use crate::client::{self, Outbox};
use crate::icons::tray_icon;
use crate::respawn::RespawnPolicy;
use crate::spawn::spawn_daemon;
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
    inbox: Receiver<Option<ServerMsg>>,
    outbox: Option<Outbox>,
    conn: Conn,
    stopped: bool,
    stop_ack_id: Option<u64>,
    cmd_id: u64,
    policy: RespawnPolicy,
    rocky_home: PathBuf,
    last_aggregate: Status,
    last_tooltip: String,
}

impl Controller {
    fn set_conn(&mut self, c: Conn) {
        self.conn = c;
        self.model.set_conn(c);
    }

    /// Try one connect; on failure spawn the daemon first and retry with
    /// backoff (100 ms doubling, 5 s total). Sets `conn` accordingly.
    fn ensure_connected(&mut self) -> bool {
        if self.outbox.is_some() {
            return true;
        }
        if self.try_connect() {
            return true;
        }
        // The daemon answered but is foreign or the wrong version: show the
        // warning, do not spawn or retry.
        if matches!(self.conn, Conn::ServerUnverified | Conn::VersionMismatch) {
            return false;
        }
        let exe = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join("rockyd.exe")));
        if let Some(exe) = exe {
            match spawn_daemon(&exe) {
                Ok(info) => {
                    if info.tied_to_job {
                        self.set_conn(Conn::TiedToJob);
                    }
                }
                Err(_) => {
                    self.set_conn(Conn::Disconnected);
                    return false;
                }
            }
        }
        let mut wait = Duration::from_millis(100);
        let total = Duration::from_secs(5);
        let mut spent = Duration::ZERO;
        while spent < total {
            std::thread::sleep(wait);
            spent += wait;
            if self.try_connect() {
                return true;
            }
            wait = (wait * 2).min(Duration::from_secs(1));
        }
        // Keep ServerUnverified: a foreign pipe owner is not a disconnect.
        if !matches!(self.conn, Conn::ServerUnverified) {
            self.set_conn(Conn::Disconnected);
        }
        false
    }

    fn try_connect(&mut self) -> bool {
        let (tx, rx) = mpsc::channel();
        match client::connect_and_subscribe(&self.rocky_home, tx) {
            Ok(outbox) => {
                self.inbox = rx;
                self.outbox = Some(outbox);
                // TiedToJob is sticky: the warning stays visible while
                // connected through a job-tied daemon.
                if !matches!(self.conn, Conn::TiedToJob) {
                    self.set_conn(Conn::Connected);
                }
                true
            }
            Err(client::ConnectError::Unverified) => {
                self.set_conn(Conn::ServerUnverified);
                false
            }
            Err(client::ConnectError::VersionMismatch) => {
                self.set_conn(Conn::VersionMismatch);
                false
            }
            Err(_) => false,
        }
    }
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

    fn show_window(&mut self, cx: &mut App) {
        if let Some(handle) = self.window.as_ref() {
            let _ = handle.update(cx, |_, window, _| {
                window.activate_window();
            });
        }
    }

    fn on_inbox(&mut self, cx: &mut Context<Self>) {
        let mut changed = false;
        loop {
            match self.ctl.inbox.try_recv() {
                Ok(Some(msg)) => {
                    if let ServerMsg::Ack { id, ok: true, .. } = &msg
                        && Some(*id) == self.ctl.stop_ack_id
                    {
                        self.ctl.stopped = true;
                        self.ctl.stop_ack_id = None;
                    }
                    self.ctl.model.apply(msg);
                    changed = true;
                }
                Ok(None) | Err(mpsc::TryRecvError::Disconnected) => {
                    self.on_disconnect();
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

    fn on_disconnect(&mut self) {
        self.ctl.outbox = None;
        if self.ctl.stopped {
            // Expected: the daemon exited after our stop ack.
            self.ctl.set_conn(Conn::Disconnected);
            return;
        }
        if self.ctl.policy.allow(now_ms()) {
            // ensure_connected sets conn itself (Disconnected, or keeps
            // ServerUnverified).
            self.ctl.ensure_connected();
        } else {
            self.ctl.set_conn(Conn::KeepsCrashing);
        }
    }
}

impl Render for DeskView {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        let groups = self.ctl.model.groups(now_ms());
        let warnings = self.ctl.model.warnings();
        let mut root = div().flex_col().gap_2().p_3().size_full();
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
        let (_tx, inbox) = mpsc::channel::<Option<ServerMsg>>();
        let mut ctl = Controller {
            model: Model::new(),
            inbox,
            outbox: None,
            conn: Conn::Connecting,
            stopped: false,
            stop_ack_id: None,
            cmd_id: 0,
            policy: RespawnPolicy::new(3, 300_000),
            rocky_home,
            last_aggregate: Status::Idle,
            last_tooltip: String::new(),
        };
        ctl.ensure_connected();
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
                    window.minimize_window();
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
                move |_, cx| {
                    view.update(cx, |v, cx| v.show_window(cx));
                }
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
                    // After a stop, Open tries one fresh connect+spawn.
                    if v.ctl.stopped && v.ctl.outbox.is_none() {
                        v.ctl.stopped = false;
                        v.ctl.ensure_connected();
                        cx.notify();
                    }
                    v.show_window(cx);
                });
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
                        v.ctl.stop_ack_id = Some(id);
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
