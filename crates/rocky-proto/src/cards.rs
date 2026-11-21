//! Wire and storage types for change card v1 records.

use serde::{Deserialize, Serialize};

/// Current wire and JSONL schema version for change cards.
pub const CARD_VERSION: u32 = 1;

/// Maximum number of change blocks included in a single card record.
pub const MAX_BLOCKS: usize = 30;

/// Maximum number of timeline flow steps included in a single card record.
pub const MAX_FLOW_STEPS: usize = 100;

/// Maximum number of distinct read paths included in a single card record.
pub const MAX_READS: usize = 40;

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_ms: Option<u64>,
    /// PreToolUse cwd, omitted when it equals the card root.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_use_id: Option<String>,
    /// Bounded tool `description`; absent under `desk/tool-text-off`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub desc: Option<String>,
}

/// Detected behavioral pattern across a card's execution flow.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "pattern", rename_all = "snake_case")]
pub enum Sequence {
    FixAfterFail {
        command: String,
        exit_code: i32,
        edit_seqs: Vec<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error_names: Option<String>,
    },
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
    #[serde(default)]
    pub more_count: u32,
    pub flow: Vec<FlowStep>,
    #[serde(default)]
    pub flow_more: u32,
    pub outside_count: u64,
    pub coverage: Coverage,
    /// Distinct files the agent read with the Read tool, in first-read order,
    /// as display paths. Omitted when empty so older records stay byte-identical.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub reads: Vec<String>,
    /// Distinct read paths beyond [`MAX_READS`].
    #[serde(default, skip_serializing_if = "is_zero")]
    pub reads_more: u32,
    /// Matched pattern summary detected from the turn's flow, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sequence: Option<Sequence>,
}

/// How a card prompt should be shown when a harness envelope, not a person, started the turn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PromptKind {
    /// An ordinary prompt; show it as is.
    Plain,
    /// A background task notification envelope.
    TaskNotification,
    /// A cross-session message envelope.
    CrossSession,
    /// A slash command envelope: the command name (with its leading `/`) and its arguments.
    SlashCommand { name: String, args: String },
}

/// Classifies a card prompt as plain user text or a Claude Code harness envelope.
pub fn classify_prompt(prompt: &str) -> PromptKind {
    let trimmed = prompt.trim_start();
    if trimmed.starts_with("<cross-session-message") {
        return PromptKind::CrossSession;
    }
    if trimmed.starts_with("<task-notification>") {
        return PromptKind::TaskNotification;
    }
    if trimmed.starts_with("<command-name>") || trimmed.starts_with("<command-message>") {
        let Some(raw_name) = extract_tag(trimmed, "<command-name>", "</command-name>") else {
            return PromptKind::Plain;
        };
        if raw_name.is_empty() {
            return PromptKind::Plain;
        }
        let name = if raw_name.starts_with('/') {
            raw_name.to_string()
        } else {
            format!("/{raw_name}")
        };
        let args = extract_tag(trimmed, "<command-args>", "</command-args>")
            .unwrap_or_default()
            .to_string();
        return PromptKind::SlashCommand { name, args };
    }
    PromptKind::Plain
}

fn extract_tag<'a>(text: &'a str, open: &str, close: &str) -> Option<&'a str> {
    let start = text.find(open)? + open.len();
    let rest = &text[start..];
    let end = rest.find(close)?;
    Some(rest[..end].trim())
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

    #[test]
    fn classify_prompt_handles_envelopes_and_plain_prompts() {
        assert_eq!(
            classify_prompt("<task-notification>\n<task-id>x</task-id>\n</task-notification>"),
            PromptKind::TaskNotification
        );
        assert_eq!(
            classify_prompt("  \n\t<task-notification>\n<task-id>x</task-id>"),
            PromptKind::TaskNotification
        );

        assert_eq!(
            classify_prompt(
                "<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>"
            ),
            PromptKind::SlashCommand {
                name: "/compact".to_string(),
                args: String::new(),
            }
        );
        assert_eq!(
            classify_prompt(
                "\n <command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>64 --fast</command-args>"
            ),
            PromptKind::SlashCommand {
                name: "/review".to_string(),
                args: "64 --fast".to_string(),
            }
        );
        assert_eq!(
            classify_prompt("<command-name>compact</command-name>"),
            PromptKind::SlashCommand {
                name: "/compact".to_string(),
                args: String::new(),
            }
        );

        assert_eq!(
            classify_prompt("<command-name></command-name>"),
            PromptKind::Plain
        );
        assert_eq!(
            classify_prompt("<command-name>   \n</command-name>"),
            PromptKind::Plain
        );
        assert_eq!(classify_prompt("<command-name>/x"), PromptKind::Plain);
        assert_eq!(
            classify_prompt("<command-message>review</command-message>"),
            PromptKind::Plain
        );

        assert_eq!(classify_prompt("Fix the bug in cart.ts"), PromptKind::Plain);
        assert_eq!(
            classify_prompt("Please explain what <task-notification> means"),
            PromptKind::Plain
        );
        assert_eq!(
            classify_prompt("see <command-name>/x</command-name>"),
            PromptKind::Plain
        );

        assert_eq!(
            classify_prompt(
                "  \n\t<cross-session-message from=\"sess-1\" sender=\"coordinator\">\nhello\n</cross-session-message>"
            ),
            PromptKind::CrossSession
        );
        assert_eq!(
            classify_prompt("<cross-session-message from=\"other\">ping"),
            PromptKind::CrossSession
        );
        assert_eq!(
            classify_prompt("Please explain <cross-session-message from=\"x\">"),
            PromptKind::Plain
        );
    }

    #[derive(serde::Deserialize)]
    struct PromptKindVector {
        prompt: String,
        kind: String,
        name: Option<String>,
        args: Option<String>,
    }

    #[test]
    fn classify_prompt_matches_shared_vectors() {
        use std::collections::HashSet;

        let raw = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../fixtures/cards/prompt-kinds.json"
        ));
        let vectors: Vec<PromptKindVector> =
            serde_json::from_str(raw).expect("parse shared prompt-kinds vectors");
        assert!(!vectors.is_empty(), "shared prompt-kinds vectors are empty");

        let mut seen_kinds = HashSet::new();
        for (idx, v) in vectors.iter().enumerate() {
            let expected = match v.kind.as_str() {
                "plain" => {
                    assert!(
                        v.name.is_none() && v.args.is_none(),
                        "vector {idx}: plain must not specify name or args"
                    );
                    PromptKind::Plain
                }
                "task_notification" => {
                    assert!(
                        v.name.is_none() && v.args.is_none(),
                        "vector {idx}: task_notification must not specify name or args"
                    );
                    PromptKind::TaskNotification
                }
                "cross_session" => {
                    assert!(
                        v.name.is_none() && v.args.is_none(),
                        "vector {idx}: cross_session must not specify name or args"
                    );
                    PromptKind::CrossSession
                }
                "slash_command" => {
                    let name = v
                        .name
                        .clone()
                        .unwrap_or_else(|| panic!("vector {idx}: slash_command missing name"));
                    let args = v
                        .args
                        .clone()
                        .unwrap_or_else(|| panic!("vector {idx}: slash_command missing args"));
                    PromptKind::SlashCommand { name, args }
                }
                other => panic!("vector {idx}: unexpected kind {other:?}"),
            };

            assert_eq!(
                classify_prompt(&v.prompt),
                expected,
                "vector {idx}: prompt={:?}",
                v.prompt
            );
            seen_kinds.insert(v.kind.as_str());
        }

        for required in [
            "plain",
            "task_notification",
            "cross_session",
            "slash_command",
        ] {
            assert!(
                seen_kinds.contains(required),
                "shared prompt-kinds vectors missing kind {required:?}"
            );
        }
    }

    #[test]
    fn flow_step_without_new_fields_deserializes() {
        let step: FlowStep = serde_json::from_str(
            r#"{"kind":"cmd","text":"npm test","ok":false,"dur_ms":5,"seqs":[]}"#,
        )
        .expect("deserialize legacy FlowStep");
        assert_eq!(step.kind, FlowKind::Cmd);
        assert_eq!(step.text, "npm test");
        assert!(!step.ok);
        assert_eq!(step.dur_ms, 5);
        assert!(step.seqs.is_empty());
        assert_eq!(step.exit_code, None);
        assert_eq!(step.error, None);

        let serialized = serde_json::to_string(&step).expect("serialize FlowStep");
        assert!(
            !serialized.contains("exit_code"),
            "unexpected exit_code key: {serialized}"
        );
        assert!(
            !serialized.contains("error"),
            "unexpected error key: {serialized}"
        );
    }

    #[test]
    fn old_v1_card_json_round_trips_byte_identical() {
        // Serialized v1 card from rocky-desk card_detail_model::tests::timeline_steps_with_subs_and_facts
        // with legacy cmd and edit flow steps (no start_ms, end_ms, cwd, tool_use_id, or desc keys).
        let old_line = concat!(
            r#"{"v":1,"card_id":"c1","rev":1,"repo_id":"repo-1","root":"/work/rocky","#,
            r#""main_root":"/work/rocky","branch":"feat/cards","session_id":"sess-1","agent_id":"","#,
            r#""agent_type":"","parent_card_id":null,"started_ms":1000,"ended_ms":90000,"#,
            r#""status":"done","prompt":"Fix discount calculation","prompt_truncated":false,"#,
            r#""importance":"medium","blocks":["#,
            r#"{"seq":1,"path":"src/auth.rs","symbol":{"kind":"function","name":"login","container":null,"exported":false},"labels":[{"id":"guard_added","args":{}}],"importance":"medium","via":"edit","tool_use_ids":["tu-1"],"bash":null,"before":"sha-before","after":"sha-after","recorded":true,"line":42,"added":3,"removed":1,"quote":null},"#,
            r#"{"seq":2,"path":"src/auth.rs","symbol":null,"labels":[{"id":"return_changed","args":{}}],"importance":"medium","via":"edit","tool_use_ids":["tu-2"],"bash":null,"before":"sha-before","after":"sha-after","recorded":true,"line":null,"added":3,"removed":1,"quote":null},"#,
            r#"{"seq":3,"path":"src/auth.rs","symbol":null,"labels":[{"id":"body_changed","args":{}}],"importance":"medium","via":"edit","tool_use_ids":["tu-3"],"bash":null,"before":"sha-before","after":"sha-after","recorded":true,"line":null,"added":null,"removed":null,"quote":null},"#,
            r#"{"seq":4,"path":"src/auth.rs","symbol":null,"labels":[{"id":"loop_added","args":{}}],"importance":"medium","via":"edit","tool_use_ids":["tu-4"],"bash":null,"before":"sha-before","after":"sha-after","recorded":true,"line":99,"added":3,"removed":1,"quote":null}"#,
            r#"],"more_count":0,"flow":["#,
            r#"{"kind":"cmd","text":"cargo test\n-p rocky-desk","ok":true,"dur_ms":8000,"seqs":[]},"#,
            r#"{"kind":"edit","text":"src/auth.rs › login","ok":false,"dur_ms":65000,"seqs":[1,999,2,3,4]}"#,
            r#"],"flow_more":0,"outside_count":0,"coverage":{"state":"full","reasons":[]}}"#,
        );
        let card: Card = serde_json::from_str(old_line).expect("deserialize old v1 card line");
        assert_eq!(card.blocks.len(), 4);
        assert_eq!(card.flow.len(), 2);
        for step in &card.flow {
            assert_eq!(step.start_ms, None);
            assert_eq!(step.end_ms, None);
            assert_eq!(step.cwd, None);
            assert_eq!(step.tool_use_id, None);
            assert_eq!(step.desc, None);
        }
        let reserialized = serde_json::to_string(&card).expect("reserialize old v1 card");
        assert_eq!(reserialized, old_line);
    }

    #[test]
    fn flow_step_with_all_five_new_fields_round_trips() {
        let step = FlowStep {
            kind: FlowKind::Cmd,
            text: "npm test".to_string(),
            ok: false,
            dur_ms: 300,
            seqs: Vec::new(),
            exit_code: Some(1),
            error: Some("Error: boom".to_string()),
            start_ms: Some(1_100),
            end_ms: Some(1_400),
            cwd: Some("/repo/packages/api".to_string()),
            tool_use_id: Some("toolu_01abc".to_string()),
            desc: Some("Run tests".to_string()),
        };
        let encoded = serde_json::to_string(&step).expect("serialize FlowStep");
        let decoded: FlowStep = serde_json::from_str(&encoded).expect("deserialize FlowStep");
        assert_eq!(decoded, step);
    }

    #[test]
    fn flow_step_with_only_tool_use_id_omits_other_optional_keys() {
        let step = FlowStep {
            kind: FlowKind::Edit,
            text: "src/a.ts".to_string(),
            ok: true,
            dur_ms: 50,
            seqs: vec![1],
            exit_code: None,
            error: None,
            start_ms: None,
            end_ms: None,
            cwd: None,
            tool_use_id: Some("toolu_only".to_string()),
            desc: None,
        };
        let val = serde_json::to_value(&step).expect("serialize FlowStep to Value");
        let obj = val.as_object().expect("FlowStep serializes as JSON object");
        assert_eq!(
            obj.get("tool_use_id").and_then(|v| v.as_str()),
            Some("toolu_only")
        );
        for omitted in ["start_ms", "end_ms", "cwd", "desc"] {
            assert!(
                !obj.contains_key(omitted),
                "expected {omitted:?} to be omitted, got: {val}"
            );
        }
    }

    #[test]
    fn card_sequence_serde_round_trip() {
        let base_json = serde_json::json!({
            "v": 1,
            "card_id": "c-1",
            "rev": 1,
            "repo_id": "r-1",
            "root": "/repo",
            "main_root": null,
            "branch": null,
            "session_id": "s-1",
            "agent_id": "a-1",
            "agent_type": "",
            "parent_card_id": null,
            "started_ms": 1,
            "ended_ms": 2,
            "status": "done",
            "prompt": "fix tests",
            "prompt_truncated": false,
            "importance": "low",
            "blocks": [],
            "flow": [],
            "outside_count": 0,
            "coverage": { "state": "full", "reasons": [] }
        });

        let mut card: Card =
            serde_json::from_value(base_json).expect("deserialize card without sequence");
        assert_eq!(card.sequence, None);

        let serialized_none = serde_json::to_value(&card).expect("serialize card with None");
        assert!(
            !serialized_none
                .as_object()
                .unwrap()
                .contains_key("sequence"),
            "sequence key should be omitted when None"
        );

        let seq = Sequence::FixAfterFail {
            command: "npm test".to_string(),
            exit_code: 1,
            edit_seqs: vec![1, 2],
            error_names: Some("auth.ts".to_string()),
        };
        let seq_val = serde_json::to_value(&seq).expect("serialize Sequence");
        assert_eq!(
            seq_val,
            serde_json::json!({
                "pattern": "fix_after_fail",
                "command": "npm test",
                "exit_code": 1,
                "edit_seqs": [1, 2],
                "error_names": "auth.ts"
            })
        );
        let seq_back: Sequence = serde_json::from_value(seq_val).expect("deserialize Sequence");
        assert_eq!(seq_back, seq);

        let seq_no_err = Sequence::FixAfterFail {
            command: "npm test".to_string(),
            exit_code: 1,
            edit_seqs: vec![1],
            error_names: None,
        };
        let seq_no_err_val =
            serde_json::to_value(&seq_no_err).expect("serialize Sequence without error_names");
        assert!(
            !seq_no_err_val
                .as_object()
                .unwrap()
                .contains_key("error_names"),
            "error_names key should be omitted when None"
        );

        card.sequence = Some(seq);
        let card_with_seq = serde_json::to_value(&card).expect("serialize card with sequence");
        let card_back: Card =
            serde_json::from_value(card_with_seq).expect("deserialize card with sequence");
        assert_eq!(card_back.sequence, card.sequence);
    }
}
