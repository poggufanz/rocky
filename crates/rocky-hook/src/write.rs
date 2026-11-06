//! Atomic spool writes: `<name>.json.tmp` + rename to `<name>.json`.

use std::fs::{self, File};
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};

use rocky_proto::spool::SpoolRecord;

/// Serialize `rec` and store it under `spool`, creating the directory if needed.
///
/// A candidate name is taken when `<name>.json` already exists or
/// `<name>.json.tmp` cannot be created exclusively; taken names retry with a
/// `-1`, `-2`, … suffix. Never renames onto an existing `.json` (Windows
/// `rename` would silently replace it).
pub fn write_record(spool: &Path, rec: &SpoolRecord) -> io::Result<PathBuf> {
    let data = serde_json::to_vec(rec).map_err(io::Error::other)?;
    let stem = format!("{:013}-{}", rec.recv_ms, std::process::id());
    write_once(spool, &stem, &data).or_else(|e| {
        if spool.is_dir() {
            return Err(e);
        }
        fs::create_dir_all(spool)?;
        write_once(spool, &stem, &data)
    })
}

fn write_once(spool: &Path, stem: &str, data: &[u8]) -> io::Result<PathBuf> {
    let mut suffix = String::new();
    let mut n = 0u32;
    loop {
        let dest = spool.join(format!("{stem}{suffix}.json"));
        if !dest.exists() {
            let tmp = spool.join(format!("{stem}{suffix}.json.tmp"));
            match File::options().write(true).create_new(true).open(&tmp) {
                Ok(mut file) => {
                    file.write_all(data)?;
                    // Windows cannot rename an open file.
                    drop(file);
                    fs::rename(&tmp, &dest)?;
                    return Ok(dest);
                }
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(e),
            }
        }
        n += 1;
        suffix = format!("-{n}");
    }
}
