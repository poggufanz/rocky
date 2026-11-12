pub mod app;
pub mod autostart;
pub mod capture_lines;
pub mod client;
pub mod clock;
pub mod conn;
pub mod connect;
pub mod consent_view;
pub mod desklog;
pub mod i18n;
pub mod icons;
pub mod notified;
pub mod notify;
pub mod os_notice;
pub mod quit;
pub mod relay;
pub mod requests;
pub mod settings_view;
pub mod setup_lines;
pub mod spawn;
pub mod toast;
pub mod ui;
pub mod view;

#[cfg(windows)]
pub mod winreg;
