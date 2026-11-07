//! Parity check for the shared redaction vectors.

use rocky_proto::redact::redact_secrets_at_boundary;

#[derive(serde::Deserialize)]
struct Vector {
    name: String,
    input: String,
    may_be_truncated: bool,
    expected: String,
}

#[test]
fn every_shared_vector_matches() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/redaction/vectors.json"
    );
    let raw = std::fs::read_to_string(path).expect("read the shared redaction vectors");
    let vectors: Vec<Vector> =
        serde_json::from_str(&raw).expect("parse the shared redaction vectors");
    assert!(!vectors.is_empty(), "the shared vector file is empty");

    let mut failures = Vec::new();
    for vector in &vectors {
        let actual = redact_secrets_at_boundary(&vector.input, vector.may_be_truncated);
        if actual != vector.expected {
            failures.push(format!(
                "{}: input={:?} may_be_truncated={} expected={:?} actual={:?}",
                vector.name, vector.input, vector.may_be_truncated, vector.expected, actual
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} shared vectors mismatched:\n{}",
        failures.len(),
        vectors.len(),
        failures.join("\n")
    );
}
