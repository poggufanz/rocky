// rocky-proto: shared protocol types for rockyd / rocky-hook / rocky-desk.
pub mod cards;
pub mod history;
pub mod hook;
pub mod paths;
#[cfg(unix)]
pub mod peer;
pub mod pipe;
pub mod redact;
pub mod respawn;
pub mod settings;
pub mod spool;
