//! Spool record envelope (v1).

use serde::{Deserialize, Serialize};

use crate::hook::{DropReason, HookEvent};

pub const SPOOL_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SpoolRecord {
    pub v: u32,
    pub harness: String,
    pub recv_ms: u64,
    #[serde(flatten)]
    pub body: SpoolBody,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[allow(clippy::large_enum_variant)]
pub enum SpoolBody {
    Event { event: HookEvent },
    Dropped { reason: DropReason, bytes: u64 },
}

#[derive(Deserialize)]
struct VersionPeek {
    v: u32,
}

pub fn peek_spool_version(bytes: &[u8]) -> Option<u32> {
    serde_json::from_slice::<VersionPeek>(bytes)
        .map(|p| p.v)
        .ok()
}

#[cfg(test)]
mod tests {
    use crate::hook::DropReason;
    use crate::spool::{SpoolBody, SpoolRecord, peek_spool_version};

    #[test]
    fn spool_record_wire_shape() {
        let r = SpoolRecord {
            v: 1,
            harness: "claude-code".into(),
            recv_ms: 5,
            body: SpoolBody::Dropped {
                reason: DropReason::Oversize,
                bytes: 9,
            },
        };
        let wire = serde_json::to_string(&r).unwrap();
        assert_eq!(
            wire,
            r#"{"v":1,"harness":"claude-code","recv_ms":5,"kind":"dropped","reason":"oversize","bytes":9}"#
        );
        assert_eq!(serde_json::from_str::<SpoolRecord>(&wire).unwrap(), r);
        assert_eq!(
            peek_spool_version(br#"{"v":7,"kind":"future_thing"}"#),
            Some(7)
        );
    }
}
