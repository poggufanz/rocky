//! Reads translation readiness markers (`installed.json`) under `<home>/translate`.

use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use rocky_proto::translate::TranslatePair;
use serde::Deserialize;

const MARKER_FILE: &str = "installed.json";
const MARKER_VERSION: u32 = 1;
const MAX_MARKER_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Marker {
    pub model_sha256: Option<String>,
}

#[derive(Deserialize)]
struct RawMarker {
    v: u32,
    model_sha256: Option<String>,
    files: Vec<RawMarkerFile>,
}

#[derive(Deserialize)]
struct RawMarkerFile {
    name: String,
    size: u64,
}

pub fn translate_dir(home: &Path) -> PathBuf {
    home.join("translate")
}

pub fn engine_dir(home: &Path) -> PathBuf {
    translate_dir(home).join("engine")
}

pub fn model_dir(home: &Path, pair: TranslatePair) -> PathBuf {
    models_dir(home).join(pair.as_str())
}

pub fn cache_dir(home: &Path) -> PathBuf {
    translate_dir(home).join("cache")
}

fn models_dir(home: &Path) -> PathBuf {
    translate_dir(home).join("models")
}

pub fn read_marker(dir: &Path) -> Option<Marker> {
    if !is_real_dir_path(dir) {
        return None;
    }
    let bytes = read_marker_bytes(&dir.join(MARKER_FILE))?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    let obj = value.as_object()?;
    let files = obj.get("files")?.as_array()?;
    if files.is_empty() || !files.iter().all(|entry| entry.is_object()) {
        return None;
    }
    let raw: RawMarker = serde_json::from_value(value).ok()?;
    if raw.v != MARKER_VERSION || raw.files.is_empty() {
        return None;
    }
    for file in &raw.files {
        if !is_plain_file_name(&file.name) {
            return None;
        }
        let meta = fs::symlink_metadata(dir.join(&file.name)).ok()?;
        if !is_real_file(&meta) || meta.len() != file.size {
            return None;
        }
    }
    Some(Marker {
        model_sha256: raw.model_sha256,
    })
}

pub fn ready_pairs(home: &Path) -> Vec<TranslatePair> {
    if !is_real_dir_path(&translate_dir(home)) {
        return Vec::new();
    }
    if read_marker(&engine_dir(home)).is_none() {
        return Vec::new();
    }
    if !is_real_dir_path(&models_dir(home)) {
        return Vec::new();
    }
    [TranslatePair::IdEn, TranslatePair::EnId]
        .into_iter()
        .filter(|&pair| read_pair_sha(home, pair).is_some())
        .collect()
}

pub fn model_sha(home: &Path, pair: TranslatePair) -> Option<String> {
    if !is_real_dir_path(&translate_dir(home)) {
        return None;
    }
    read_marker(&engine_dir(home))?;
    if !is_real_dir_path(&models_dir(home)) {
        return None;
    }
    read_pair_sha(home, pair)
}

fn read_pair_sha(home: &Path, pair: TranslatePair) -> Option<String> {
    let marker = read_marker(&model_dir(home, pair))?;
    marker.model_sha256.filter(|sha| is_sha256_hex(sha))
}

fn read_marker_bytes(path: &Path) -> Option<Vec<u8>> {
    let meta = fs::symlink_metadata(path).ok()?;
    if !is_real_file(&meta) {
        return None;
    }

    let mut opts = fs::OpenOptions::new();
    opts.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        opts.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }

    let file = opts.open(path).ok()?;
    let opened = file.metadata().ok()?;
    if !is_real_file(&opened) {
        return None;
    }

    let mut bytes = Vec::new();
    file.take((MAX_MARKER_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .ok()?;
    (bytes.len() <= MAX_MARKER_BYTES).then_some(bytes)
}

fn is_symlink_or_reparse(meta: &fs::Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
    }
    false
}

fn is_real_dir(meta: &fs::Metadata) -> bool {
    !is_symlink_or_reparse(meta) && meta.file_type().is_dir()
}

fn is_real_file(meta: &fs::Metadata) -> bool {
    !is_symlink_or_reparse(meta) && meta.file_type().is_file()
}

fn is_real_dir_path(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|meta| is_real_dir(&meta))
        .unwrap_or(false)
}

fn is_plain_file_name(name: &str) -> bool {
    if name.is_empty()
        || name == "."
        || name.contains("..")
        || name.contains('/')
        || name.contains('\\')
        || name.contains('\0')
    {
        return false;
    }
    let mut components = Path::new(name).components();
    matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none()
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::TempDir;

    use super::*;

    const SHA_A: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const SHA_B: &str = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

    fn write_file(path: &Path, bytes: &[u8]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    fn write_engine_marker(home: &Path) {
        let dir = engine_dir(home);
        write_file(&dir.join("bergamot.js"), b"console.log(1);");
        write_file(&dir.join("bergamot.wasm"), b"wasm-bytes");
        let json = serde_json::json!({
            "v": 1,
            "files": [
                { "role": "glue", "name": "bergamot.js", "size": 15 },
                { "role": "wasm", "name": "bergamot.wasm", "size": 10 },
            ]
        });
        write_file(&dir.join("installed.json"), json.to_string().as_bytes());
    }

    fn write_pair_marker(home: &Path, pair: TranslatePair, sha: &str) {
        let dir = model_dir(home, pair);
        write_file(&dir.join("model.bin"), b"model-payload");
        write_file(&dir.join("lex.bin"), b"lex");
        write_file(&dir.join("vocab.spm"), b"vocab");
        let json = serde_json::json!({
            "v": 1,
            "pair": pair.as_str(),
            "model_sha256": sha,
            "extra_ignored": true,
            "files": [
                { "role": "model", "name": "model.bin", "size": 13 },
                { "role": "lex", "name": "lex.bin", "size": 3 },
                { "role": "vocab", "name": "vocab.spm", "size": 5 },
            ]
        });
        write_file(&dir.join("installed.json"), json.to_string().as_bytes());
    }

    #[test]
    fn valid_markers_make_a_pair_ready() {
        let home = TempDir::new().unwrap();
        let h = home.path();
        assert_eq!(translate_dir(h), h.join("translate"));
        assert_eq!(engine_dir(h), h.join("translate").join("engine"));
        assert_eq!(
            model_dir(h, TranslatePair::IdEn),
            h.join("translate").join("models").join("id-en")
        );
        assert_eq!(
            model_dir(h, TranslatePair::EnId),
            h.join("translate").join("models").join("en-id")
        );
        assert_eq!(cache_dir(h), h.join("translate").join("cache"));

        write_engine_marker(h);
        write_pair_marker(h, TranslatePair::EnId, SHA_B);
        assert_eq!(ready_pairs(h), vec![TranslatePair::EnId]);

        write_pair_marker(h, TranslatePair::IdEn, SHA_A);
        assert_eq!(
            ready_pairs(h),
            vec![TranslatePair::IdEn, TranslatePair::EnId]
        );
    }

    #[test]
    fn engine_without_pair_is_not_ready() {
        let home = TempDir::new().unwrap();
        let h = home.path();
        write_engine_marker(h);

        assert_eq!(
            read_marker(&engine_dir(h)),
            Some(Marker { model_sha256: None })
        );
        assert!(ready_pairs(h).is_empty());

        let only_pair = TempDir::new().unwrap();
        write_pair_marker(only_pair.path(), TranslatePair::IdEn, SHA_A);
        assert!(ready_pairs(only_pair.path()).is_empty());
        assert_eq!(model_sha(only_pair.path(), TranslatePair::IdEn), None);
    }

    #[test]
    fn size_drift_is_not_ready() {
        let home = TempDir::new().unwrap();
        let h = home.path();
        write_engine_marker(h);
        write_pair_marker(h, TranslatePair::IdEn, SHA_A);
        assert_eq!(ready_pairs(h), vec![TranslatePair::IdEn]);

        write_file(
            &model_dir(h, TranslatePair::IdEn).join("model.bin"),
            b"short",
        );
        assert_eq!(read_marker(&model_dir(h, TranslatePair::IdEn)), None);
        assert!(ready_pairs(h).is_empty());

        write_pair_marker(h, TranslatePair::IdEn, SHA_A);
        assert_eq!(ready_pairs(h), vec![TranslatePair::IdEn]);

        fs::remove_file(engine_dir(h).join("bergamot.wasm")).unwrap();
        assert_eq!(read_marker(&engine_dir(h)), None);
        assert!(ready_pairs(h).is_empty());

        // Replacing a required file with a directory is also not ready.
        fs::create_dir_all(engine_dir(h).join("bergamot.wasm")).unwrap();
        assert_eq!(read_marker(&engine_dir(h)), None);
        assert!(ready_pairs(h).is_empty());
    }

    #[test]
    fn bad_json_and_wrong_version_are_not_ready() {
        let home = TempDir::new().unwrap();
        let h = home.path();
        write_engine_marker(h);
        let dir = model_dir(h, TranslatePair::IdEn);
        write_file(&dir.join("model.bin"), b"ok");

        write_file(&dir.join("installed.json"), b"{");
        assert_eq!(read_marker(&dir), None);
        assert!(ready_pairs(h).is_empty());

        write_file(
            &dir.join("installed.json"),
            format!(
                r#"{{"v":2,"model_sha256":"{SHA_A}","files":[{{"name":"model.bin","size":2}}]}}"#
            )
            .as_bytes(),
        );
        assert_eq!(read_marker(&dir), None);
        assert!(ready_pairs(h).is_empty());

        write_file(
            &dir.join("installed.json"),
            format!(r#"{{"v":1,"model_sha256":"{SHA_A}","files":[]}}"#).as_bytes(),
        );
        assert_eq!(read_marker(&dir), None);
        assert!(ready_pairs(h).is_empty());

        // Oversized marker (> 64 KiB) is rejected.
        let padding = " ".repeat(65 * 1024);
        let big = format!(
            r#"{{"v":1,"model_sha256":"{SHA_A}","files":[{{"name":"model.bin","size":2}}],"pad":"{padding}"}}"#
        );
        write_file(&dir.join("installed.json"), big.as_bytes());
        assert_eq!(read_marker(&dir), None);
        assert!(ready_pairs(h).is_empty());
    }

    #[test]
    fn file_name_with_separator_or_dotdot_is_not_ready() {
        let home = TempDir::new().unwrap();
        let h = home.path();
        let payload = b"decoy-bytes";
        let len = payload.len();

        // Decoy files with matching size at paths the bad names would resolve to,
        // plus directly at <home>/x.
        write_file(&h.join("x"), payload);
        write_file(&translate_dir(h).join("x"), payload);
        write_file(&translate_dir(h).join("models").join("x"), payload);
        write_file(&engine_dir(h).join("a").join("b"), payload);
        write_file(
            &model_dir(h, TranslatePair::IdEn).join("a").join("b"),
            payload,
        );
        #[cfg(unix)]
        {
            write_file(&engine_dir(h).join(r"a\b"), payload);
            write_file(&model_dir(h, TranslatePair::IdEn).join(r"a\b"), payload);
        }

        let bad_names = ["../x", "a/b", r"a\b", "..", ".", "", "a\0b"];
        for bad in bad_names {
            let edir = engine_dir(h);
            let e_json = serde_json::json!({
                "v": 1,
                "files": [{ "name": bad, "size": len }],
            });
            write_file(&edir.join("installed.json"), e_json.to_string().as_bytes());
            assert_eq!(read_marker(&edir), None, "engine bad name: {bad:?}");
            assert!(ready_pairs(h).is_empty());

            // Also test pair marker with a valid engine marker present.
            write_engine_marker(h);
            let mdir = model_dir(h, TranslatePair::IdEn);
            let m_json = serde_json::json!({
                "v": 1,
                "model_sha256": SHA_A,
                "files": [{ "name": bad, "size": len }],
            });
            write_file(&mdir.join("installed.json"), m_json.to_string().as_bytes());
            assert_eq!(read_marker(&mdir), None, "pair bad name: {bad:?}");
            assert!(ready_pairs(h).is_empty());
        }
    }

    #[test]
    fn pair_marker_needs_model_sha() {
        let home = TempDir::new().unwrap();
        let h = home.path();
        write_engine_marker(h);
        let dir = model_dir(h, TranslatePair::IdEn);
        write_file(&dir.join("model.bin"), b"ok");

        // Missing model_sha256
        write_file(
            &dir.join("installed.json"),
            br#"{"v":1,"files":[{"name":"model.bin","size":2}]}"#,
        );
        assert!(ready_pairs(h).is_empty());
        assert_eq!(model_sha(h, TranslatePair::IdEn), None);

        // Null model_sha256
        write_file(
            &dir.join("installed.json"),
            br#"{"v":1,"model_sha256":null,"files":[{"name":"model.bin","size":2}]}"#,
        );
        assert!(ready_pairs(h).is_empty());

        // Too short
        write_file(
            &dir.join("installed.json"),
            br#"{"v":1,"model_sha256":"deadbeef","files":[{"name":"model.bin","size":2}]}"#,
        );
        assert!(ready_pairs(h).is_empty());

        // 64 chars but non-hex
        let non_hex = "g".repeat(64);
        write_file(
            &dir.join("installed.json"),
            format!(
                r#"{{"v":1,"model_sha256":"{non_hex}","files":[{{"name":"model.bin","size":2}}]}}"#
            )
            .as_bytes(),
        );
        assert!(ready_pairs(h).is_empty());

        // 65 hex chars
        let too_long = format!("{SHA_A}0");
        write_file(
            &dir.join("installed.json"),
            format!(
                r#"{{"v":1,"model_sha256":"{too_long}","files":[{{"name":"model.bin","size":2}}]}}"#
            )
            .as_bytes(),
        );
        assert!(ready_pairs(h).is_empty());
    }

    #[test]
    fn model_sha_returns_marker_value() {
        let home = TempDir::new().unwrap();
        let h = home.path();
        write_engine_marker(h);
        write_pair_marker(h, TranslatePair::IdEn, SHA_A);

        assert_eq!(model_sha(h, TranslatePair::IdEn), Some(SHA_A.to_string()));
        assert_eq!(model_sha(h, TranslatePair::EnId), None);

        // Pair is not ready if engine marker disappears.
        fs::remove_file(engine_dir(h).join("installed.json")).unwrap();
        assert_eq!(model_sha(h, TranslatePair::IdEn), None);
    }

    #[test]
    fn array_shaped_marker_is_not_ready() {
        let home = TempDir::new().unwrap();
        let h = home.path();
        let edir = engine_dir(h);
        write_file(&edir.join("bergamot.js"), b"console.log(1);");
        write_file(&edir.join("bergamot.wasm"), b"wasm-bytes");
        let array_engine = serde_json::json!([
            1,
            null,
            [
                { "name": "bergamot.js", "size": 15 },
                { "name": "bergamot.wasm", "size": 10 },
            ]
        ]);
        write_file(
            &edir.join("installed.json"),
            array_engine.to_string().as_bytes(),
        );
        assert_eq!(read_marker(&edir), None);
        assert!(ready_pairs(h).is_empty());

        write_engine_marker(h);
        let mdir = model_dir(h, TranslatePair::IdEn);
        write_file(&mdir.join("model.bin"), b"model-payload");
        write_file(&mdir.join("lex.bin"), b"lex");
        write_file(&mdir.join("vocab.spm"), b"vocab");
        let array_pair = serde_json::json!([
            1,
            SHA_A,
            [
                { "name": "model.bin", "size": 13 },
                { "name": "lex.bin", "size": 3 },
                { "name": "vocab.spm", "size": 5 },
            ]
        ]);
        write_file(
            &mdir.join("installed.json"),
            array_pair.to_string().as_bytes(),
        );
        assert_eq!(read_marker(&mdir), None);
        assert!(ready_pairs(h).is_empty());
        assert_eq!(model_sha(h, TranslatePair::IdEn), None);
    }

    #[test]
    fn array_shaped_file_entry_is_not_ready() {
        let home = TempDir::new().unwrap();
        let h = home.path();
        let edir = engine_dir(h);
        write_file(&edir.join("bergamot.js"), b"console.log(1);");
        write_file(&edir.join("bergamot.wasm"), b"wasm-bytes");
        let engine_with_array_files = serde_json::json!({
            "v": 1,
            "files": [
                ["bergamot.js", 15],
                ["bergamot.wasm", 10],
            ]
        });
        write_file(
            &edir.join("installed.json"),
            engine_with_array_files.to_string().as_bytes(),
        );
        assert_eq!(read_marker(&edir), None);
        assert!(ready_pairs(h).is_empty());

        write_engine_marker(h);
        let mdir = model_dir(h, TranslatePair::IdEn);
        write_file(&mdir.join("model.bin"), b"model-payload");
        write_file(&mdir.join("lex.bin"), b"lex");
        write_file(&mdir.join("vocab.spm"), b"vocab");
        let pair_with_array_files = serde_json::json!({
            "v": 1,
            "model_sha256": SHA_A,
            "files": [
                ["model.bin", 13],
                ["lex.bin", 3],
                ["vocab.spm", 5],
            ]
        });
        write_file(
            &mdir.join("installed.json"),
            pair_with_array_files.to_string().as_bytes(),
        );
        assert_eq!(read_marker(&mdir), None);
        assert!(ready_pairs(h).is_empty());
        assert_eq!(model_sha(h, TranslatePair::IdEn), None);
    }

    fn create_file_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, link)
        }
        #[cfg(windows)]
        {
            std::os::windows::fs::symlink_file(target, link)
        }
    }

    fn create_dir_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, link)
        }
        #[cfg(windows)]
        {
            std::os::windows::fs::symlink_dir(target, link)
        }
    }

    #[test]
    fn symlinked_file_or_marker_is_not_ready() {
        let home = TempDir::new().unwrap();
        let h = home.path();
        write_engine_marker(h);
        write_pair_marker(h, TranslatePair::IdEn, SHA_A);
        assert_eq!(ready_pairs(h), vec![TranslatePair::IdEn]);

        // Replace listed file with a symlink to a same-size file outside the marker dir.
        let mdir = model_dir(h, TranslatePair::IdEn);
        let outside_model = h.join("outside-model.bin");
        write_file(&outside_model, b"model-payload");
        fs::remove_file(mdir.join("model.bin")).unwrap();
        if let Err(err) = create_file_symlink(&outside_model, &mdir.join("model.bin")) {
            #[cfg(windows)]
            {
                eprintln!("skipping file symlink assertion: cannot create symlink: {err}");
                return;
            }
            #[cfg(not(windows))]
            panic!("failed to create file symlink: {err}");
        }
        assert_eq!(read_marker(&mdir), None);
        assert!(ready_pairs(h).is_empty());
        assert_eq!(model_sha(h, TranslatePair::IdEn), None);

        // Restore real model.bin and replace installed.json with a symlink to an outside file.
        fs::remove_file(mdir.join("model.bin")).unwrap();
        write_pair_marker(h, TranslatePair::IdEn, SHA_A);
        assert_eq!(ready_pairs(h), vec![TranslatePair::IdEn]);

        let outside_marker = h.join("outside-installed.json");
        let existing_json = fs::read(mdir.join("installed.json")).unwrap();
        write_file(&outside_marker, &existing_json);
        fs::remove_file(mdir.join("installed.json")).unwrap();
        create_file_symlink(&outside_marker, &mdir.join("installed.json")).unwrap();
        assert_eq!(read_marker(&mdir), None);
        assert!(ready_pairs(h).is_empty());
        assert_eq!(model_sha(h, TranslatePair::IdEn), None);
    }

    #[test]
    fn symlinked_directory_chain_is_not_ready() {
        let outside = TempDir::new().unwrap();
        write_engine_marker(outside.path());
        write_pair_marker(outside.path(), TranslatePair::IdEn, SHA_A);

        // 1. <home>/translate is a symlink.
        let home1 = TempDir::new().unwrap();
        if let Err(err) =
            create_dir_symlink(&translate_dir(outside.path()), &translate_dir(home1.path()))
        {
            #[cfg(windows)]
            {
                eprintln!("skipping dir symlink assertion: cannot create symlink: {err}");
                return;
            }
            #[cfg(not(windows))]
            panic!("failed to create dir symlink: {err}");
        }
        assert!(ready_pairs(home1.path()).is_empty());
        assert_eq!(model_sha(home1.path(), TranslatePair::IdEn), None);

        // 2. <home>/translate/engine is a symlink.
        let home2 = TempDir::new().unwrap();
        fs::create_dir_all(models_dir(home2.path())).unwrap();
        write_pair_marker(home2.path(), TranslatePair::IdEn, SHA_A);
        create_dir_symlink(&engine_dir(outside.path()), &engine_dir(home2.path())).unwrap();
        assert_eq!(read_marker(&engine_dir(home2.path())), None);
        assert!(ready_pairs(home2.path()).is_empty());
        assert_eq!(model_sha(home2.path(), TranslatePair::IdEn), None);

        // 3. <home>/translate/models is a symlink.
        let home3 = TempDir::new().unwrap();
        write_engine_marker(home3.path());
        create_dir_symlink(&models_dir(outside.path()), &models_dir(home3.path())).unwrap();
        assert!(ready_pairs(home3.path()).is_empty());
        assert_eq!(model_sha(home3.path(), TranslatePair::IdEn), None);

        // 4. <home>/translate/models/id-en is a symlink.
        let home4 = TempDir::new().unwrap();
        write_engine_marker(home4.path());
        fs::create_dir_all(models_dir(home4.path())).unwrap();
        create_dir_symlink(
            &model_dir(outside.path(), TranslatePair::IdEn),
            &model_dir(home4.path(), TranslatePair::IdEn),
        )
        .unwrap();
        assert_eq!(
            read_marker(&model_dir(home4.path(), TranslatePair::IdEn)),
            None
        );
        assert!(ready_pairs(home4.path()).is_empty());
        assert_eq!(model_sha(home4.path(), TranslatePair::IdEn), None);
    }

    #[cfg(windows)]
    #[test]
    fn windows_junction_directory_chain_is_not_ready() {
        let outside = TempDir::new().unwrap();
        write_engine_marker(outside.path());
        write_pair_marker(outside.path(), TranslatePair::IdEn, SHA_A);

        let make_junction = |target: &Path, link: &Path| -> bool {
            let output = std::process::Command::new("cmd")
                .arg("/C")
                .arg("mklink")
                .arg("/J")
                .arg(link)
                .arg(target)
                .output();
            match output {
                Ok(out) if out.status.success() => true,
                Ok(out) => {
                    eprintln!(
                        "skipping junction assertion: mklink /J failed: {}",
                        String::from_utf8_lossy(&out.stderr)
                    );
                    false
                }
                Err(err) => {
                    eprintln!("skipping junction assertion: cmd failed: {err}");
                    false
                }
            }
        };

        // 1. <home>/translate is a junction.
        let home1 = TempDir::new().unwrap();
        if !make_junction(&translate_dir(outside.path()), &translate_dir(home1.path())) {
            return;
        }
        assert!(ready_pairs(home1.path()).is_empty());
        assert_eq!(model_sha(home1.path(), TranslatePair::IdEn), None);

        // 2. <home>/translate/engine is a junction.
        let home2 = TempDir::new().unwrap();
        fs::create_dir_all(models_dir(home2.path())).unwrap();
        write_pair_marker(home2.path(), TranslatePair::IdEn, SHA_A);
        assert!(make_junction(
            &engine_dir(outside.path()),
            &engine_dir(home2.path())
        ));
        assert_eq!(read_marker(&engine_dir(home2.path())), None);
        assert!(ready_pairs(home2.path()).is_empty());
        assert_eq!(model_sha(home2.path(), TranslatePair::IdEn), None);

        // 3. <home>/translate/models is a junction.
        let home3 = TempDir::new().unwrap();
        write_engine_marker(home3.path());
        assert!(make_junction(
            &models_dir(outside.path()),
            &models_dir(home3.path())
        ));
        assert!(ready_pairs(home3.path()).is_empty());
        assert_eq!(model_sha(home3.path(), TranslatePair::IdEn), None);

        // 4. <home>/translate/models/id-en is a junction.
        let home4 = TempDir::new().unwrap();
        write_engine_marker(home4.path());
        fs::create_dir_all(models_dir(home4.path())).unwrap();
        assert!(make_junction(
            &model_dir(outside.path(), TranslatePair::IdEn),
            &model_dir(home4.path(), TranslatePair::IdEn)
        ));
        assert_eq!(
            read_marker(&model_dir(home4.path(), TranslatePair::IdEn)),
            None
        );
        assert!(ready_pairs(home4.path()).is_empty());
        assert_eq!(model_sha(home4.path(), TranslatePair::IdEn), None);
    }

    #[cfg(unix)]
    #[test]
    fn fifo_marker_does_not_hang_and_is_not_ready() {
        let home = TempDir::new().unwrap();
        let edir = engine_dir(home.path());
        fs::create_dir_all(&edir).unwrap();
        let fifo_path = edir.join("installed.json");
        let status = std::process::Command::new("mkfifo")
            .arg(&fifo_path)
            .status()
            .unwrap();
        assert!(status.success());
        assert_eq!(read_marker(&edir), None);
        assert!(ready_pairs(home.path()).is_empty());
    }
}
