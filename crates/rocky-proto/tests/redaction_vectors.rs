//! Parity check for the shared redaction vectors.

use rocky_proto::redact::{
    PROMPT_MAX_CHARS, PROMPT_SCAN_BYTES, bound_prompt, redact_secrets_at_boundary,
};

#[derive(serde::Deserialize)]
struct Vector {
    name: String,
    input: String,
    may_be_truncated: bool,
    expected: String,
}

fn load_vectors() -> Vec<Vector> {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/redaction/vectors.json"
    );
    let raw = std::fs::read_to_string(path).expect("read the shared redaction vectors");
    let vectors: Vec<Vector> =
        serde_json::from_str(&raw).expect("parse the shared redaction vectors");
    assert!(!vectors.is_empty(), "the shared vector file is empty");
    vectors
}

#[test]
fn every_shared_vector_matches() {
    let vectors = load_vectors();

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

#[test]
fn prompt_matches_shared_vectors() {
    let vectors = load_vectors();
    let eligible: Vec<&Vector> = vectors
        .iter()
        .filter(|vector| {
            !vector.may_be_truncated
                && vector.input.len() <= PROMPT_SCAN_BYTES
                && vector.expected.chars().count() <= PROMPT_MAX_CHARS
                && vector
                    .expected
                    .chars()
                    .all(|character| !character.is_control() || matches!(character, '\n' | '\t'))
        })
        .collect();
    assert!(
        !eligible.is_empty(),
        "no shared vector matched the prompt filter"
    );

    let mut failures = Vec::new();
    for vector in &eligible {
        let (actual, _) = bound_prompt(&vector.input);
        if actual != vector.expected {
            failures.push(format!(
                "{}: input={:?} expected={:?} actual={:?}",
                vector.name, vector.input, vector.expected, actual
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} shared prompt vectors mismatched:\n{}",
        failures.len(),
        eligible.len(),
        failures.join("\n")
    );
}
