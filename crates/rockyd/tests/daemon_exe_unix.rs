//! `rockyd` end-to-end on a unix socket: spawn the real binary with a temp
//! ROCKY_HOME, wait for the socket, and require a second daemon to exit 3.

#![cfg(unix)]

use std::os::unix::ffi::OsStrExt;
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use rocky_proto::paths::{daemon_lock_path_from, log_path, socket_path, socket_path_from};
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

/// Spawn with `XDG_RUNTIME_DIR` removed, so the socket falls back under
/// `<home>/desk` deterministically.
fn spawn_daemon_without_runtime_dir(home: &Path) -> KillOnDrop {
    KillOnDrop(
        Command::new(env!("CARGO_BIN_EXE_rockyd"))
            .env("ROCKY_HOME", home)
            .env_remove("XDG_RUNTIME_DIR")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    )
}

/// A child of `home` padded so the fallback socket path is `socket_len` bytes.
fn padded_home(home: &TempDir, socket_len: usize) -> std::path::PathBuf {
    let base = home.path().as_os_str().as_bytes().len() + 1 + "/desk/rockyd.sock".len();
    let pad = socket_len
        .checked_sub(base)
        .expect("temp dir too long for this test");
    let path = home.path().join("x".repeat(pad));
    std::fs::create_dir(&path).unwrap();
    assert_eq!(
        socket_path_from(&path, None).as_os_str().as_bytes().len(),
        socket_len
    );
    path
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

#[test]
fn socket_path_longer_than_107_bytes_exits_1() {
    let home = TempDir::new().unwrap();
    let long_home = padded_home(&home, 108);
    let mut child = spawn_daemon_without_runtime_dir(&long_home);
    let status = wait_exit(&mut child, "long-path daemon");
    assert_eq!(status.code(), Some(1), "status: {status}");

    let log = std::fs::read_to_string(log_path(&long_home)).unwrap();
    assert!(log.contains("socket path too long"), "log: {log}");
}

/// In the fallback layout the lock name is 17 bytes longer than the socket
/// name, so a socket path of 91-107 bytes passes the socket check but its
/// lock would fail to open with ENAMETOOLONG. It must take the documented
/// exit instead.
#[test]
fn lock_path_past_the_limit_still_exits_1() {
    let home = TempDir::new().unwrap();
    let band_home = padded_home(&home, 100);
    let lock = daemon_lock_path_from(&band_home, None);
    assert!(
        lock.as_os_str().as_bytes().len() > 107,
        "lock: {}",
        lock.display()
    );

    let mut child = spawn_daemon_without_runtime_dir(&band_home);
    let status = wait_exit(&mut child, "band-path daemon");
    assert_eq!(status.code(), Some(1), "status: {status}");

    let log = std::fs::read_to_string(log_path(&band_home)).unwrap();
    assert!(log.contains("socket path too long"), "log: {log}");
}
