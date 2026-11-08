//! Peer credentials for local unix sockets.

use std::io;

/// Effective uid of this process.
pub fn own_uid() -> u32 {
    // SAFETY: geteuid has no preconditions and cannot fail.
    unsafe { libc::geteuid() }
}

/// Effective uid of the process on the other end of `stream`.
///
/// Linux reads `SO_PEERCRED`; other unix targets fail closed.
#[cfg(target_os = "linux")]
pub fn peer_uid(stream: &std::os::unix::net::UnixStream) -> io::Result<u32> {
    use std::os::fd::AsRawFd;

    let mut cred = libc::ucred {
        pid: 0,
        uid: 0,
        gid: 0,
    };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    // SAFETY: `stream` owns a live socket fd; `cred`/`len` are valid out-params
    // for a `SO_PEERCRED` query, which writes at most one `ucred`.
    let rc = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            std::ptr::from_mut(&mut cred).cast(),
            &mut len,
        )
    };
    if rc != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(cred.uid)
}

#[cfg(all(unix, not(target_os = "linux")))]
pub fn peer_uid(_stream: &std::os::unix::net::UnixStream) -> io::Result<u32> {
    Err(io::ErrorKind::Unsupported.into())
}

/// Whether the peer resolving to `peer` is this user; unknown peers are refused.
pub fn same_user(peer: io::Result<u32>) -> bool {
    matches!(peer, Ok(uid) if uid == own_uid())
}

#[cfg(test)]
mod tests {
    use super::{own_uid, peer_uid, same_user};

    #[test]
    #[cfg(target_os = "linux")]
    fn socketpair_peer_is_this_user() {
        let (a, _b) = std::os::unix::net::UnixStream::pair().unwrap();
        assert_eq!(peer_uid(&a).unwrap(), own_uid());
    }

    #[test]
    fn other_or_unknown_peer_is_refused() {
        assert!(!same_user(Ok(own_uid().wrapping_add(1))));
        assert!(!same_user(Err(std::io::Error::other("no cred"))));
        assert!(same_user(Ok(own_uid())));
    }
}
