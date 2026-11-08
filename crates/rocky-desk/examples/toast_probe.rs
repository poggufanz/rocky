//! Manual probe: registers the desk AUMID, asks Windows whether toasts are
//! allowed, shows one, and reports whether a click reached the process.

#[cfg(windows)]
fn main() {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::{Duration, Instant};

    use rocky_desk::toast;

    toast::register_aumid("rocky", None).expect("register AUMID");
    toast::set_process_aumid().expect("set process AUMID");

    println!("setting: {:?}", toast::notifier_setting());

    let clicked = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&clicked);
    let shown = toast::show_toast(
        "rocky",
        "probe",
        "probe",
        Box::new(move || flag.store(true, Ordering::SeqCst)),
    );
    match shown {
        Ok(()) => println!("shown: ok"),
        Err(err) => println!("shown: {err:?}"),
    }

    let deadline = Instant::now() + Duration::from_secs(20);
    while !clicked.load(Ordering::SeqCst) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(200));
    }
    println!(
        "activated: {}",
        if clicked.load(Ordering::SeqCst) {
            "yes"
        } else {
            "no"
        }
    );
}

#[cfg(not(windows))]
fn main() {}
