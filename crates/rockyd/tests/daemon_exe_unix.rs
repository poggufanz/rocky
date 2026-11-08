//! `rockyd` end-to-end on a unix socket: spawn the real binary with a temp
//! ROCKY_HOME, wait for the socket, and require a second daemon to exit 3.

#![cfg(unix)]

use std::os::unix::net::UnixStream;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use rocky_proto::paths::socket_path;
use tempfile::TempDir;

const GUARD: Duration = Duration::from_secs(5);

/// Kills its child and waits on drop, so a panicking assert never leaves a
/// process behind.
struct KillOnDrop(Child);

impl Drop for KillOnDrop {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn spawn_daemon(home: &Path) -> KillOnDrop {
    KillOnDrop(
        Command::new(env!("CARGO_BIN_EXE_rockyd"))
            .env("ROCKY_HOME", home)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    )
}

/// Wait for the socket, surfacing an early daemon exit instead of hanging.
fn wait_socket(path: &Path, child: &mut KillOnDrop) {
    let start = Instant::now();
    loop {
        if UnixStream::connect(path).is_ok() {
            return;
        }
        if let Ok(Some(status)) = child.0.try_wait() {
            panic!("rockyd exited early: {status}");
        }
        assert!(start.elapsed() < GUARD, "socket never appeared");
        std::thread::sleep(Duration::from_millis(25));
    }
}

/// Wait for a child with the anti-hang guard; kill and reap it rather than
/// hang forever on guard expiry.
fn wait_exit(child: &mut KillOnDrop, what: &str) -> std::process::ExitStatus {
    let start = Instant::now();
    loop {
        if let Some(s) = child.0.try_wait().unwrap() {
            return s;
        }
        if start.elapsed() >= GUARD {
            let _ = child.0.kill();
            let _ = child.0.wait();
            panic!("{what} never exited");
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

#[test]
fn second_daemon_exits_3() {
    let home = TempDir::new().unwrap();
    let mut first = spawn_daemon(home.path());
    wait_socket(&socket_path(home.path()), &mut first);

    let mut second = spawn_daemon(home.path());
    let status = wait_exit(&mut second, "second daemon");
    assert_eq!(status.code(), Some(3), "status: {status}");
}
