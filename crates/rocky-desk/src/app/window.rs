//! Window visibility helpers, tray startup, and the GPUI application loop.

use std::path::PathBuf;
use std::sync::mpsc;
use std::time::Duration;

#[cfg(not(windows))]
use gpui::WindowHandle;
use gpui::prelude::*;
use gpui::{
    App, Application, Bounds, Entity, MenuItem, SharedString, TitlebarOptions, Window,
    WindowBounds, WindowOptions, px, size,
};
use gpui_tray::Tray;
use rocky_proto::paths::desk_dir;
use rocky_proto::pipe::{ClientMsg, CmdName, Status};

use super::{Controller, DeskView, OpenRocky, QuitDesk, StopRecording, daemon_exe};
use crate::autostart::RunOptions;
use crate::cards_model::CardsModel;
use crate::conn::{ConnState, ConnectOutcome};
use crate::connect::{CONNECT_BUDGET, ConnectDone, connect_attempt};
use crate::consent_view::ConsentModel;
use crate::desklog::LogOnce;
use crate::i18n::{Msg, detect_ui_lang, tr};
use crate::icons::tray_icon;
use crate::notified::NotifiedStore;
use crate::notify::Notifier;
use crate::now_model::TimelineFetch;
use crate::os_notice::OsNotices;
use crate::requests::Requests;
use crate::search_input::{Debounce, SearchInput};
use crate::settings_view::View;
use crate::setup_settings::SetupSettings;
#[cfg(windows)]
use crate::toast::set_process_aumid;
use crate::view::{Conn, Model};

/// Restore and focus the desk window. Call it outside any `view.update`: the
/// window's root view is `view`, so updating the window inside that lease
/// double-borrows the entity and panics, which aborts inside the tray callback.
/// Every user path that opens the window comes through here.
fn show_window(view: &Entity<DeskView>, cx: &mut App) {
    // Before the window shows, so a pending `--tray` retry cannot undo it.
    #[cfg(not(windows))]
    view.update(cx, |v, _| v.user_shown = true);
    if let Some(handle) = view.read(cx).window {
        let _ = handle.update(cx, |_, window, _| {
            set_visible(window, true);
            window.activate_window();
        });
    }
}

/// Hide or show the desk window. gpui 0.2.2 has no hide on Windows, so close
/// (vetoed) hides the HWND directly; the tray and the show relay bring it back.
#[cfg(windows)]
fn set_visible(window: &Window, visible: bool) {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        IsIconic, SW_HIDE, SW_RESTORE, SW_SHOW, ShowWindow,
    };
    // Fully qualified: gpui's inherent `Window::window_handle` returns its own handle type.
    let Ok(handle) = HasWindowHandle::window_handle(window) else {
        return;
    };
    if let RawWindowHandle::Win32(w) = handle.as_raw() {
        let hwnd = w.hwnd.get() as _;
        // SAFETY: the HWND belongs to this live gpui window on this (UI) thread;
        // these calls only change its visibility or restore state.
        let cmd = unsafe {
            if visible {
                // SW_SHOW leaves a minimized window minimized; restore it
                // instead so a second launch brings the window forward.
                if IsIconic(hwnd) != 0 {
                    SW_RESTORE
                } else {
                    SW_SHOW
                }
            } else {
                SW_HIDE
            }
        };
        unsafe { ShowWindow(hwnd, cmd) };
    }
}

#[cfg(not(windows))]
fn set_visible(window: &Window, visible: bool) {
    if !visible {
        window.minimize_window();
    }
}

/// Offsets from start, in milliseconds, at which a `--tray` start minimizes
/// the window again. A window manager that starts after the desk, as at
/// login, can drop the first request and leave the window showing.
#[cfg(not(windows))]
const TRAY_MINIMIZE_RETRY_MS: [u64; 3] = [1_000, 3_000, 8_000];

/// Minimize the window again at each `TRAY_MINIMIZE_RETRY_MS` offset. Stops at
/// the first offset where the user has opened the window, the view is gone, or
/// the window update fails.
#[cfg(not(windows))]
fn retry_tray_minimize(view: &Entity<DeskView>, window: WindowHandle<DeskView>, cx: &mut App) {
    // ponytail: fixed schedule; a taskbar restore in the first 8 s is minimized once more. Upgrade: wait for _NET_SUPPORTING_WM_CHECK on the root window.
    cx.spawn({
        let view = view.downgrade();
        async move |cx| {
            // Offsets count from start, so each wait is the gap since the previous one.
            let mut waited = 0;
            for at in TRAY_MINIMIZE_RETRY_MS {
                cx.background_executor()
                    .timer(Duration::from_millis(at.saturating_sub(waited)))
                    .await;
                waited = at;
                let again = cx
                    .update(|cx| {
                        let Some(v) = view.upgrade() else {
                            return false;
                        };
                        // Read the flag and drop the borrow first: updating
                        // the window leases this entity, its root view.
                        if v.read(cx).user_shown {
                            return false;
                        }
                        window
                            .update(cx, |_, window, _| window.minimize_window())
                            .is_ok()
                    })
                    .unwrap_or(false);
                if !again {
                    break;
                }
            }
        }
    })
    .detach();
}

pub fn run(rocky_home: PathBuf, opts: RunOptions) {
    Application::new().run(move |cx: &mut App| {
        // Blocking startup attempt (the GPUI loop is not running yet).
        let exe = daemon_exe();
        let done = connect_attempt(&rocky_home, exe.as_deref(), CONNECT_BUDGET);
        let (outcome, tied, live) = (done.outcome, done.tied_to_job, done.live);
        let log_path = desk_dir(&rocky_home).join("rocky-desk.log");
        #[cfg(windows)]
        let log = {
            let mut log = LogOnce::new(log_path);
            if let Err(e) = set_process_aumid() {
                log.once("aumid", &e);
            }
            log
        };
        #[cfg(not(windows))]
        let log = LogOnce::new(log_path);
        let notices = OsNotices::new(&rocky_home);
        let (click_tx, clicks) = mpsc::channel::<()>();
        let (worker_tx, worker_rx) = mpsc::channel::<ConnectDone>();
        let state = ConnState::new(3, 300_000);
        let detected = detect_ui_lang();
        let mut ctl = Controller {
            model: Model::new(),
            timeline_fetch: TimelineFetch::new(),
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
        let notified_path = desk_dir(&ctl.rocky_home).join("notified.json");
        let (notified, notified_unreadable) = NotifiedStore::load(&notified_path);
        let mut log = log;
        if notified_unreadable {
            log.once(
                "notified-read",
                &"notified.json is unreadable; starting empty",
            );
        }
        let view: Entity<DeskView> = cx.new(|cx| DeskView {
            ctl,
            window: None,
            tray: None,
            log,
            notices,
            click_tx,
            clicks,
            show_requested: false,
            notices_ready: false,
            notified,
            notified_path,
            requests: Requests::default(),
            consent: ConsentModel::default(),
            setup: SetupSettings::default(),
            cards: CardsModel::new(),
            card_detail: None,
            block_diff: None,
            search: SearchInput::default(),
            search_debounce: Debounce::default(),
            search_focus: cx.focus_handle(),
            removed_quit_at: None,
            menu_stale: false,
            #[cfg(not(windows))]
            user_shown: false,
        });

        let window = cx
            .open_window(
                WindowOptions {
                    // Windows can open straight into the tray; elsewhere the
                    // window is opened and then minimized, since a window that
                    // was never shown has no surface to minimize.
                    show: !opts.tray || cfg!(not(windows)),
                    // The consent and settings views scroll when the window is small.
                    is_resizable: true,
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
        // A `--tray` launch stays out of the way: Windows opened it hidden
        // above; elsewhere the window had to be opened first, so minimize it.
        #[cfg(not(windows))]
        {
            if opts.tray {
                let _ = window.update(cx, |_, window, _| window.minimize_window());
                retry_tray_minimize(&view, window, cx);
            }
        }
        // Closing the window hides it: veto the close and minimize instead.
        // On the final screen it quits instead.
        if let Err(e) = window.update(cx, |_, window, cx| {
            let view = view.clone();
            window.on_window_should_close(&*cx, move |window, cx| {
                let quitting = view.update(cx, |v, cx| v.on_close_request(cx));
                if !quitting {
                    set_visible(window, false);
                }
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
            .build(cx);
        #[cfg(windows)]
        let tray = Some(tray.expect("build tray"));
        #[cfg(not(windows))]
        let tray = match tray {
            Ok(tray) => Some(tray),
            Err(e) => {
                // A bus-less session has no tray; the rest of the desk works
                // without one (`self.tray = None` is handled everywhere).
                view.update(cx, |v, _| {
                    v.log.once("tray", &e);
                });
                None
            }
        };
        view.update(cx, |v, _| {
            v.ctl.last_aggregate = agg;
            v.ctl.last_tooltip = tip;
            v.tray = tray;
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
                view.update(cx, |v, cx| v.quit(cx));
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
                                v.poll_timelines();
                                v.poll_search_debounce(cx);
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
