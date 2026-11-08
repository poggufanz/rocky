//! Resource 1 is the window and taskbar icon; gpui loads it from the exe.

use std::env;

fn main() {
    println!("cargo:rerun-if-changed=assets/rocky-desk.rc");
    println!("cargo:rerun-if-changed=assets/rocky.ico");
    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        embed_resource::compile("assets/rocky-desk.rc", embed_resource::NONE)
            .manifest_optional()
            .unwrap();
    }
}
