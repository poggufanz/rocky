pub mod analyze;
mod compare;
mod config;
pub mod lang;
pub mod model;
pub mod snippet;
mod syntax;
mod text;

pub use analyze::analyze;
pub use lang::lang_for_path;
pub use model::*;
pub use snippet::{SnippetLine, debug, snippet, snippets};
