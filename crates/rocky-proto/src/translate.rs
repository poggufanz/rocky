//! Quote translation wire types and stable quote hashing.

use std::fmt::Write;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QuoteLang {
    En,
    Id,
}

impl QuoteLang {
    pub fn other(self) -> Self {
        match self {
            Self::En => Self::Id,
            Self::Id => Self::En,
        }
    }

    pub fn code(self) -> &'static str {
        match self {
            Self::En => "en",
            Self::Id => "id",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum TranslatePair {
    #[serde(rename = "id-en")]
    IdEn,
    #[serde(rename = "en-id")]
    EnId,
}

impl TranslatePair {
    pub fn to(target: QuoteLang) -> Self {
        match target {
            QuoteLang::En => Self::IdEn,
            QuoteLang::Id => Self::EnId,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::IdEn => "id-en",
            Self::EnId => "en-id",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuoteTranslation {
    pub quote_key: String,
    pub from: QuoteLang,
    pub text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TranslateFailure {
    Download,
    Checksum,
    Write,
    Engine,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstallProgress {
    pub pair: TranslatePair,
    pub done_bytes: u64,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct TranslateStatus {
    pub ready: Vec<TranslatePair>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installing: Option<InstallProgress>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failed: Option<TranslateFailure>,
}

/// Returns the lowercase hex SHA-256 digest of `text`.
pub fn quote_key(text: &str) -> String {
    let digest = Sha256::digest(text.as_bytes());
    let mut hex = String::with_capacity(64);
    for byte in digest {
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quote_key_is_sha256_hex() {
        assert_eq!(
            quote_key("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn idle_status_omits_empty_fields() {
        let idle = TranslateStatus::default();
        let json = serde_json::to_string(&idle).unwrap();
        assert_eq!(json, r#"{"ready":[]}"#);
        // A status written with explicit nulls still reads back.
        let old: TranslateStatus =
            serde_json::from_str(r#"{"ready":[],"installing":null,"failed":null}"#).unwrap();
        assert_eq!(old, idle);
    }

    #[test]
    fn pair_for_target() {
        assert_eq!(TranslatePair::to(QuoteLang::En), TranslatePair::IdEn);
        assert_eq!(TranslatePair::IdEn.as_str(), "id-en");
        assert_eq!(TranslatePair::to(QuoteLang::Id), TranslatePair::EnId);
        assert_eq!(TranslatePair::EnId.as_str(), "en-id");
        assert_eq!(QuoteLang::Id.other(), QuoteLang::En);
        assert_eq!(QuoteLang::En.other(), QuoteLang::Id);
        assert_eq!(QuoteLang::En.code(), "en");
        assert_eq!(QuoteLang::Id.code(), "id");
    }
}
