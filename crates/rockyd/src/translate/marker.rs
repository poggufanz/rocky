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
    translate_dir(home).join("models").join(pair.as_str())
}

pub fn cache_dir(home: &Path) -> PathBuf {
    translate_dir(home).join("cache")
}

pub fn read_marker(dir: &Path) -> Option<Marker> {
    let bytes = read_marker_bytes(&dir.join(MARKER_FILE))?;
    let raw: RawMarker = serde_json::from_slice(&bytes).ok()?;
    if raw.v != MARKER_VERSION || raw.files.is_empty() {
        return None;
    }
    for file in &raw.files {
        if !is_plain_file_name(&file.name) {
            return None;
        }
        let meta = fs::metadata(dir.join(&file.name)).ok()?;
        if !meta.is_file() || meta.len() != file.size {
            return None;
        }
    }
    Some(Marker {
        model_sha256: raw.model_sha256,
    })
}

pub fn ready_pairs(home: &Path) -> Vec<TranslatePair> {
    if read_marker(&engine_dir(home)).is_none() {
        return Vec::new();
    }
    [TranslatePair::IdEn, TranslatePair::EnId]
        .into_iter()
        .filter(|&pair| read_pair_sha(home, pair).is_some())
        .collect()
}

pub fn model_sha(home: &Path, pair: TranslatePair) -> Option<String> {
    read_marker(&engine_dir(home))?;
    read_pair_sha(home, pair)
}

fn read_pair_sha(home: &Path, pair: TranslatePair) -> Option<String> {
    let marker = read_marker(&model_dir(home, pair))?;
    marker.model_sha256.filter(|sha| is_sha256_hex(sha))
}

fn read_marker_bytes(path: &Path) -> Option<Vec<u8>> {
    let file = fs::File::open(path).ok()?;
    if !file.metadata().ok()?.is_file() {
        return None;
    }
    let mut bytes = Vec::new();
    file.take((MAX_MARKER_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .ok()?;
    (bytes.len() <= MAX_MARKER_BYTES).then_some(bytes)
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
}
