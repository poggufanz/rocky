//! Checks that Rocky's entries in agent config files are still present.
//!
//! The records are written by Node. This module reads them and checks bytes;
//! it never parses or writes an agent config.

pub mod check;
pub mod records;
