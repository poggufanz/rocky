//! The same resource 1 so `rockyd.exe` shows the mark next to the desk's.

use std::env;

fn main() {
    println!("cargo:rerun-if-changed=rockyd.rc");
    println!("cargo:rerun-if-changed=../rocky-desk/assets/rocky.ico");
    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        embed_resource::compile("rockyd.rc", embed_resource::NONE)
            .manifest_optional()
            .unwrap();
    }
}
