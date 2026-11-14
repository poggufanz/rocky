//! Parity check for shared repository identity and path canonicalization vectors.

use rocky_proto::paths::{canonical_path, repo_id};

#[derive(serde::Deserialize)]
struct Vector {
    input: String,
    platform: String,
    canonical: String,
    id: String,
}

fn load_vectors() -> Vec<Vector> {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/paths/repo-id.json"
    );
    let raw = std::fs::read_to_string(path).expect("read shared repo-id vectors");
    let vectors: Vec<Vector> = serde_json::from_str(&raw).expect("parse shared repo-id vectors");
    assert!(!vectors.is_empty(), "shared repo-id vectors are empty");
    vectors
}

#[test]
fn every_repo_id_vector_matches() {
    let vectors = load_vectors();
    let mut failures = Vec::new();
    for v in &vectors {
        let win32 = match v.platform.as_str() {
            "win32" => true,
            "linux" => false,
            other => panic!("unexpected platform {other:?} in vector"),
        };
        let actual_canonical = canonical_path(&v.input, win32);
        let actual_id = repo_id(&v.input, win32);
        if actual_canonical != v.canonical || actual_id != v.id {
            failures.push(format!(
                "input={:?} platform={}: expected canonical={:?} id={:?}, got canonical={:?} id={:?}",
                v.input, v.platform, v.canonical, v.id, actual_canonical, actual_id
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} repo-id vectors mismatched:\n{}",
        failures.len(),
        vectors.len(),
        failures.join("\n")
    );
}
