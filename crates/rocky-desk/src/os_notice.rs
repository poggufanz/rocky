//! OS notifications behind one desk type.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn body_markup_is_escaped() {
        assert_eq!(escape_markup("a <b> & c"), "a &lt;b&gt; &amp; c");
    }

    /// No session bus at the address: each notice reports the failure and the
    /// worker stays alive to try the next one.
    #[cfg(target_os = "linux")]
    #[test]
    fn worker_survives_a_missing_session_bus() {
        use std::sync::mpsc;
        use std::time::{Duration, Instant};

        fn wait_for_error(errors: &mpsc::Receiver<std::io::Error>) -> std::io::Error {
            let deadline = Instant::now() + Duration::from_secs(2);
            while Instant::now() < deadline {
                if let Ok(error) = errors.try_recv() {
                    return error;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            panic!("no notification error within 2 s");
        }

        let (tx, errors) = mpsc::channel();
        let notifier = FreedesktopNotifier::spawn_with_address(
            std::path::PathBuf::from("/nonexistent/rocky-test.png"),
            tx,
            Some("unix:path=/nonexistent/rocky-test-bus".into()),
        );

        notifier.notify("s1", "repo", "body").unwrap();
        wait_for_error(&errors);

        notifier.notify("s1", "repo", "body").unwrap();
        wait_for_error(&errors);
    }
}
