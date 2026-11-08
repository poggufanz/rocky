//! `HH:MM` formatting for health-strip timestamps: local on Windows, UTC elsewhere.

/// UTC `HH:MM` for a Unix millisecond timestamp.
pub fn utc_hhmm(ms: u64) -> String {
    let secs = ms / 1000;
    let day = secs % 86_400;
    format!("{:02}:{:02}", day / 3600, (day % 3600) / 60)
}

/// Local `HH:MM` for a Unix millisecond timestamp, converted with the Windows
/// rules for that instant. Falls back to UTC when a conversion fails.
#[cfg(windows)]
pub fn local_hhmm(ms: u64) -> String {
    use windows_sys::Win32::Foundation::{FILETIME, SYSTEMTIME};
    use windows_sys::Win32::System::Time::{FileTimeToSystemTime, SystemTimeToTzSpecificLocalTime};

    // 100 ns ticks between 1601 and the Unix epoch.
    let ticks = ms
        .saturating_mul(10_000)
        .saturating_add(116_444_736_000_000_000);
    let filetime = FILETIME {
        dwLowDateTime: ticks as u32,
        dwHighDateTime: (ticks >> 32) as u32,
    };
    let mut utc = SYSTEMTIME::default();
    let mut local = SYSTEMTIME::default();
    // SAFETY: both pointers refer to live stack values; a null time zone asks
    // for the current zone's rules.
    let converted = unsafe {
        FileTimeToSystemTime(&filetime, &mut utc) != 0
            && SystemTimeToTzSpecificLocalTime(std::ptr::null(), &utc, &mut local) != 0
    };
    if !converted {
        return utc_hhmm(ms);
    }
    format!("{:02}:{:02}", local.wHour, local.wMinute)
}

/// UTC `HH:MM` off Windows.
#[cfg(not(windows))]
pub fn local_hhmm(ms: u64) -> String {
    utc_hhmm(ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utc_hhmm_formats() {
        assert_eq!(utc_hhmm(0), "00:00");
        assert_eq!(utc_hhmm(50_520_000), "14:02");
    }
}
