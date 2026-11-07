//! Minimal hook stand-in: drain stdin, exit 0, print nothing.

use std::io::Read as _;

fn main() {
    let mut sink = [0u8; 8192];
    let mut stdin = std::io::stdin().lock();
    while stdin.read(&mut sink).is_ok_and(|n| n > 0) {}
}
