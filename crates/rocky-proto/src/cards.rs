//! Wire and storage types for change card v1 records.

use serde::{Deserialize, Serialize};

/// Current wire and JSONL schema version for change cards.
pub const CARD_VERSION: u32 = 1;

/// Maximum number of change blocks included in a single card record.
pub const MAX_BLOCKS: usize = 30;

/// Relative significance of a change block or card.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Importance {
    None,
    Low,
    Medium,
    High,
}

/// Kind of symbol associated with a change block.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SymbolKind {
    Function,
    Method,
    Class,
    Struct,
    Enum,
    Trait,
    Interface,
    Type,
    Const,
    Test,
    Key,
}

/// Identified symbol within a changed file.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct BlockSymbol {
    pub kind: SymbolKind,
    pub name: String,
    pub container: Option<String>,
    pub exported: bool,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub nth: u32,
}

fn is_zero(value: &u32) -> bool {
    *value == 0
}

/// Closed catalog of structured change fact labels serialized onto blocks.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(tag = "id", content = "args", rename_all = "snake_case")]
pub enum Label {
    ParamsChanged {
        added: u32,
        removed: u32,
        changed: u32,
    },
    ReturnTypeChanged {},
    SymbolRemoved {},
    SymbolAdded {},
    SymbolRenamed {
        from: String,
    },
    GuardAdded {},
    ConditionChanged {},
    BranchAdded {},
    BranchRemoved {},
    ErrorHandlingAdded {},
    ErrorHandlingRemoved {},
    LoopAdded {},
    LoopRemoved {},
    ReturnChanged {},
    CallAdded {
        name: String,
    },
    CallRemoved {
        name: String,
    },
    AwaitChanged {
        added: u32,
        removed: u32,
    },
    BodyChanged {},
    ValueChanged {
        name: String,
        before: String,
        after: String,
    },
    ConfigChanged {
        key: String,
        before: Option<String>,
        after: Option<String>,
    },
    DepAdded {
        name: String,
        version: String,
    },
    DepRemoved {
        name: String,
    },
    DepVersion {
        name: String,
        before: String,
        after: String,
    },
    ImportAdded {
        module: String,
    },
    ImportRemoved {
        module: String,
    },
    TestAdded {
        name: String,
    },
    TestRemoved {
        name: String,
    },
    TestSkipped {
        name: String,
    },
    TestOnly {
        name: String,
    },
    FileNew {},
    FileDeleted {},
    FileRenamed {
        from: String,
    },
    FormatOnly {},
    Rewrite {
        pct: u32,
    },
    LockfileChanged {},
    LinesChanged {
        added: u32,
        removed: u32,
    },
    TooLarge {},
    NotCaptured {},
}

/// Lifecycle state of the turn represented by a card.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CardStatus {
    Open,
    Done,
    Failed,
}

/// Tool category that produced a change block.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BlockVia {
    Edit,
    Bash,
}

/// Bash execution metadata attached to blocks attributed to a shell command.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct BashInfo {
    pub cmd: String,
    pub candidates: u32,
}

/// Agent explanation excerpt associated with an attributed block.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Quote {
    pub text: String,
    pub shared: bool,
}

/// Single semantic or file-level change block within a card.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Block {
    pub seq: u32,
    pub path: String,
    pub symbol: Option<BlockSymbol>,
    pub labels: Vec<Label>,
    pub importance: Importance,
    pub via: BlockVia,
    pub tool_use_ids: Vec<String>,
    pub bash: Option<BashInfo>,
    pub before: Option<String>,
    pub after: Option<String>,
    pub recorded: bool,
    pub line: Option<u32>,
    pub added: Option<u32>,
    pub removed: Option<u32>,
    pub quote: Option<Quote>,
}

/// Kind of timeline step in a card's execution flow.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FlowKind {
    Cmd,
    Edit,
}

/// One chronological Bash or edit action observed during the turn.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct FlowStep {
    pub kind: FlowKind,
    pub text: String,
    pub ok: bool,
    pub dur_ms: u64,
    pub seqs: Vec<u32>,
}

/// Overall capture completeness of a card.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CoverageState {
    Full,
    Partial,
}

/// Specific reason a card's capture or attribution coverage is partial.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CoverageReason {
    DaemonGap,
    CaptureLate,
    CaptureOff,
    TooLarge,
    TranscriptUnreadable,
    TurnUnclosed,
}

/// Capture completeness indicator and qualifying gaps for a card.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Coverage {
    pub state: CoverageState,
    pub reasons: Vec<CoverageReason>,
}

/// Persisted and streamed change card v1 record for one agent turn.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Card {
    pub v: u32,
    pub card_id: String,
    pub rev: u32,
    pub repo_id: String,
    pub root: String,
    pub main_root: Option<String>,
    pub branch: Option<String>,
    pub session_id: String,
    pub agent_id: String,
    pub agent_type: String,
    pub parent_card_id: Option<String>,
    pub started_ms: u64,
    pub ended_ms: Option<u64>,
    pub status: CardStatus,
    pub prompt: String,
    pub prompt_truncated: bool,
    pub importance: Importance,
    pub blocks: Vec<Block>,
    pub flow: Vec<FlowStep>,
    pub outside_count: u64,
    pub coverage: Coverage,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn label_and_symbol_nth_serde() {
        let sym_zero = BlockSymbol {
            kind: SymbolKind::Function,
            name: "applyDiscount".to_string(),
            container: None,
            exported: false,
            nth: 0,
        };
        let v_zero = serde_json::to_value(&sym_zero).unwrap();
        assert!(!v_zero.as_object().unwrap().contains_key("nth"));

        let sym_nth = BlockSymbol { nth: 2, ..sym_zero };
        let v_nth = serde_json::to_value(&sym_nth).unwrap();
        assert_eq!(v_nth["nth"], 2);
        let back: BlockSymbol = serde_json::from_value(v_nth).unwrap();
        assert_eq!(back.nth, 2);

        let label = Label::SymbolAdded {};
        let v_lbl = serde_json::to_value(&label).unwrap();
        assert_eq!(v_lbl, serde_json::json!({"id": "symbol_added", "args": {}}));

        let reasons = vec![
            CoverageReason::DaemonGap,
            CoverageReason::CaptureLate,
            CoverageReason::CaptureOff,
            CoverageReason::TooLarge,
            CoverageReason::TranscriptUnreadable,
            CoverageReason::TurnUnclosed,
        ];
        let v_reasons = serde_json::to_value(&reasons).unwrap();
        assert_eq!(
            v_reasons,
            serde_json::json!([
                "daemon_gap",
                "capture_late",
                "capture_off",
                "too_large",
                "transcript_unreadable",
                "turn_unclosed"
            ])
        );
    }
}
