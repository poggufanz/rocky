//! Pure change-card attribution and record builder.

use std::cmp::Reverse;
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use rocky_facts::{
    Change as FactChange, FileInput, Label as FactLabel, MAX_BYTES, MAX_LABELS_PER_CHANGE, Side,
    Symbol as FactSymbol, SymbolKind as FactSymbolKind, analyze,
};
use rocky_proto::cards::{
    BashInfo, Block, BlockSymbol, BlockVia, CARD_VERSION, Card, CardStatus, Coverage,
    CoverageReason, CoverageState, FlowKind, FlowStep, Importance, Label, MAX_BLOCKS,
    MAX_FLOW_STEPS, Quote, SymbolKind,
};
use rocky_proto::paths::{canonical_path, repo_id};
use rocky_proto::pipe::CaptureState;

use crate::capture::CaptureResult;
use crate::cards::store::{Before, ObjectRead, Version};
use crate::cards::transcript::TranscriptRead;
use crate::cards::windows::{ToolKind, ToolWindow, Turn, TurnEnd};

const WINDOW_CAP_MS: u64 = 30_000;
const MAX_BASH_ATTR_MS: u64 = 120_000;
const QUOTE_MAX_CHARS: usize = 500;
const PROMPT_MAX_CHARS: usize = 1_000;

/// Inputs required to attribute capture versions and build one card revision.
#[derive(Debug, Clone)]
pub struct BuildInput {
    pub turn: Turn,
    pub card_id: String,
    pub rev: u32,
    pub session_root: Option<String>,
    pub recorded: bool,
    pub versions: Vec<Version>,
    pub results: Vec<CaptureResult>,
    pub other_bash: Vec<ToolWindow>,
    pub quotes: TranscriptRead,
    pub gaps: Vec<(u64, u64)>,
    pub capture_state: Option<CaptureState>,
    pub store_error: bool,
    pub tail_cut: bool,
    pub home_dir: PathBuf,
    pub parent_card_id: Option<String>,
}

#[derive(Debug, Clone)]
struct AbsPath {
    prefix: PathPrefix,
    segments: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum PathPrefix {
    PosixRoot,
    Drive(char),
    Unc(String, String),
}

impl AbsPath {
    fn parse_abs(raw: &str) -> Option<Self> {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return None;
        }
        let slash = trimmed.replace('\\', "/");
        let unc_buf;
        let slash = if let Some(after_q) = slash.strip_prefix("//?/") {
            if after_q
                .as_bytes()
                .get(..4)
                .is_some_and(|b| b.eq_ignore_ascii_case(b"unc/"))
            {
                unc_buf = format!("//{}", &after_q[4..]);
                unc_buf.as_str()
            } else {
                after_q
            }
        } else {
            slash.as_str()
        };
        if let Some(rest) = slash.strip_prefix("//") {
            let mut parts = rest.split('/').filter(|s| !s.is_empty() && *s != ".");
            let server = parts.next()?.to_string();
            let share = parts.next()?.to_string();
            let segments = normalize_segments(parts, true);
            return Some(Self {
                prefix: PathPrefix::Unc(server, share),
                segments,
            });
        }
        let bytes = slash.as_bytes();
        if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
            let drive = bytes[0].to_ascii_uppercase() as char;
            let rest = &slash[2..];
            if !rest.starts_with('/') {
                return None;
            }
            let segments =
                normalize_segments(rest.split('/').filter(|s| !s.is_empty() && *s != "."), true);
            return Some(Self {
                prefix: PathPrefix::Drive(drive),
                segments,
            });
        }
        if let Some(rest) = slash.strip_prefix('/') {
            let segments =
                normalize_segments(rest.split('/').filter(|s| !s.is_empty() && *s != "."), true);
            return Some(Self {
                prefix: PathPrefix::PosixRoot,
                segments,
            });
        }
        None
    }

    fn resolve(raw: &str, cwd: Option<&str>) -> Option<Self> {
        if let Some(abs) = Self::parse_abs(raw) {
            return Some(abs);
        }
        let base_str = cwd?;
        let base = Self::parse_abs(base_str)?;
        let slash = raw.trim().replace('\\', "/");
        if slash.is_empty() {
            return Some(base);
        }
        let mut combined = base.segments;
        for part in slash.split('/') {
            match part {
                "" | "." => {}
                ".." => {
                    combined.pop();
                }
                seg => combined.push(seg.to_string()),
            }
        }
        Some(Self {
            prefix: base.prefix,
            segments: combined,
        })
    }

    fn prefix_eq(a: &PathPrefix, b: &PathPrefix) -> bool {
        match (a, b) {
            (PathPrefix::PosixRoot, PathPrefix::PosixRoot) => true,
            (PathPrefix::Drive(x), PathPrefix::Drive(y)) => x == y,
            (PathPrefix::Unc(s1, sh1), PathPrefix::Unc(s2, sh2)) => {
                seg_eq(s1, s2) && seg_eq(sh1, sh2)
            }
            _ => false,
        }
    }

    fn strip_prefix(&self, base: &AbsPath) -> Option<Vec<String>> {
        if !Self::prefix_eq(&self.prefix, &base.prefix) {
            return None;
        }
        if self.segments.len() < base.segments.len() {
            return None;
        }
        for (a, b) in base.segments.iter().zip(&self.segments) {
            if !seg_eq(a, b) {
                return None;
            }
        }
        Some(self.segments[base.segments.len()..].to_vec())
    }

    fn format_slash(&self) -> String {
        match &self.prefix {
            PathPrefix::PosixRoot => {
                if self.segments.is_empty() {
                    "/".to_string()
                } else {
                    format!("/{}", self.segments.join("/"))
                }
            }
            PathPrefix::Drive(d) => {
                if self.segments.is_empty() {
                    format!("{d}:/")
                } else {
                    format!("{d}:/{}", self.segments.join("/"))
                }
            }
            PathPrefix::Unc(srv, shr) => {
                if self.segments.is_empty() {
                    format!("//{srv}/{shr}")
                } else {
                    format!("//{srv}/{shr}/{}", self.segments.join("/"))
                }
            }
        }
    }

    fn format_tilde(&self, home: Option<&AbsPath>) -> String {
        if let Some(h) = home
            && let Some(rest) = self.strip_prefix(h)
        {
            return if rest.is_empty() {
                "~".to_string()
            } else {
                format!("~/{}", rest.join("/"))
            };
        }
        self.format_slash()
    }
}

fn normalize_segments<'a>(parts: impl Iterator<Item = &'a str>, clamp_root: bool) -> Vec<String> {
    let mut out = Vec::new();
    for part in parts {
        match part {
            "" | "." => {}
            ".." => {
                if !out.is_empty() || !clamp_root {
                    out.pop();
                }
            }
            seg => out.push(seg.to_string()),
        }
    }
    out
}

fn seg_eq(a: &str, b: &str) -> bool {
    if cfg!(windows) {
        a.to_lowercase() == b.to_lowercase()
    } else {
        a == b
    }
}

fn normalize_rel_key(file_rel: &str) -> String {
    let slash = file_rel.trim().replace('\\', "/");
    let trimmed = slash.strip_prefix("./").unwrap_or(&slash);
    let cleaned = normalize_segments(
        trimmed.split('/').filter(|s| !s.is_empty() && *s != "."),
        true,
    )
    .join("/");
    if cfg!(windows) {
        cleaned.to_lowercase()
    } else {
        cleaned
    }
}

struct EditInfo {
    orig_idx: usize,
    tool_use_id: String,
    pre_ms: u64,
    end_ms: u64,
    ended_by_cap: bool,
    resolved_abs: Option<String>,
    repo_rel: Option<String>,
    repo_rel_key: Option<String>,
    display_path: String,
    matched_version: bool,
}

struct BashInfoWin {
    orig_idx: usize,
    tool_use_id: String,
    cmd: String,
    pre_ms: u64,
    end_ms: u64,
    within_2_min: bool,
}

#[derive(Clone, Copy)]
enum SideData<'a> {
    Absent,
    Unknown,
    Text(&'a str),
    TooLarge,
    Missing,
}

struct VersionAnalysis {
    changes: Vec<FactChange>,
    before_sha: Option<String>,
    after_sha: Option<String>,
    line_counts: Vec<(Option<u32>, Option<u32>)>,
}

struct CandidateBlock {
    sort_key: (u64, usize, usize, usize),
    block: Block,
}

/// Attributes capture versions to agent tool windows and builds a version-1 card record.
pub fn build_card(
    input: &BuildInput,
    read: &dyn Fn(&str) -> ObjectRead,
    stat: &dyn Fn(&str) -> Option<u64>,
) -> Card {
    let session_root_raw = input
        .session_root
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let root_canon = session_root_raw
        .map(|s| canonical_path(s, cfg!(windows)))
        .unwrap_or_default();
    let computed_repo_id = if root_canon.is_empty() {
        "_none".to_string()
    } else {
        repo_id(&root_canon, cfg!(windows))
    };
    let main_root = input
        .turn
        .repo
        .main_root
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| canonical_path(s, cfg!(windows)));

    let session_root_abs = session_root_raw.and_then(AbsPath::parse_abs);
    let home_str = input.home_dir.to_string_lossy();
    let home_abs = AbsPath::parse_abs(home_str.as_ref());
    let cwd = input.turn.cwd.as_deref();

    let (edits, bashes) = collect_windows(
        &input.turn.windows,
        input.turn.ended_ms,
        session_root_raw,
        session_root_abs.as_ref(),
        home_abs.as_ref(),
        cwd,
        &input.results,
    );

    let (blocks, outside_count, saw_capture_late) = if input.recorded {
        build_recorded_blocks(
            input,
            edits,
            &bashes,
            session_root_raw,
            &input.other_bash,
            read,
            stat,
        )
    } else {
        let blocks = build_unconsented_blocks(&edits, &input.quotes);
        (blocks, 0u64, false)
    };

    let importance = blocks
        .iter()
        .map(|b| b.importance)
        .max()
        .unwrap_or(Importance::None);
    let coverage = build_coverage(input, &blocks, saw_capture_late);

    let mut card_blocks = blocks;
    let more_count =
        u32::try_from(card_blocks.len().saturating_sub(MAX_BLOCKS)).unwrap_or(u32::MAX);
    if card_blocks.len() > MAX_BLOCKS {
        card_blocks.truncate(MAX_BLOCKS);
    }
    for (idx, blk) in card_blocks.iter_mut().enumerate() {
        blk.seq = (idx + 1) as u32;
    }

    let (flow, flow_more) = build_flow(
        &input.turn.windows,
        &card_blocks,
        session_root_abs.as_ref(),
        home_abs.as_ref(),
        cwd,
    );
    let (prompt, prompt_truncated) = select_prompt(input);

    let status = match input.turn.status {
        TurnEnd::Open => CardStatus::Open,
        TurnEnd::Done => CardStatus::Done,
        TurnEnd::Failed | TurnEnd::Unclosed => CardStatus::Failed,
    };

    let is_main = is_main_agent(&input.turn);
    let agent_type = if is_main {
        String::new()
    } else {
        input.turn.agent_type.clone()
    };
    let parent_card_id = if is_main {
        None
    } else {
        input.parent_card_id.clone()
    };

    Card {
        v: CARD_VERSION,
        card_id: input.card_id.clone(),
        rev: input.rev,
        repo_id: computed_repo_id,
        root: root_canon,
        main_root,
        branch: input.turn.repo.branch.clone(),
        session_id: input.turn.agent.session_id.clone(),
        agent_id: input.turn.agent.agent_id.clone(),
        agent_type,
        parent_card_id,
        started_ms: input.turn.started_ms,
        ended_ms: input.turn.ended_ms,
        status,
        prompt,
        prompt_truncated,
        importance,
        blocks: card_blocks,
        more_count,
        flow,
        flow_more,
        outside_count,
        coverage,
    }
}

fn collect_windows(
    windows: &[ToolWindow],
    turn_ended_ms: Option<u64>,
    session_root_raw: Option<&str>,
    session_root_abs: Option<&AbsPath>,
    home_abs: Option<&AbsPath>,
    cwd: Option<&str>,
    results: &[CaptureResult],
) -> (Vec<EditInfo>, Vec<BashInfoWin>) {
    let mut indexed: Vec<(usize, &ToolWindow)> = windows.iter().enumerate().collect();
    indexed.sort_by_key(|(idx, w)| (w.pre_ms, *idx));

    let mut edits = Vec::new();
    let mut bashes = Vec::new();
    let root_cmp = session_root_raw.map(|r| canonical_path(r, cfg!(windows)));

    for (orig_idx, win) in indexed {
        let (end_ms, ended_by_cap) =
            compute_window_end(win, turn_ended_ms, root_cmp.as_deref(), results);
        match win.kind {
            ToolKind::Edit => {
                let (resolved_abs, repo_rel, display_path) = classify_target_path(
                    win.target_path.as_deref(),
                    &win.tool,
                    session_root_abs,
                    home_abs,
                    cwd,
                );
                let repo_rel_key = repo_rel.as_deref().map(normalize_rel_key);
                edits.push(EditInfo {
                    orig_idx,
                    tool_use_id: win.tool_use_id.clone(),
                    pre_ms: win.pre_ms,
                    end_ms,
                    ended_by_cap,
                    resolved_abs,
                    repo_rel,
                    repo_rel_key,
                    display_path,
                    matched_version: false,
                });
            }
            ToolKind::Bash => {
                let within_2_min = win
                    .post_ms
                    .is_some_and(|post| post.saturating_sub(win.pre_ms) <= MAX_BASH_ATTR_MS);
                bashes.push(BashInfoWin {
                    orig_idx,
                    tool_use_id: win.tool_use_id.clone(),
                    cmd: win.command.clone().unwrap_or_default(),
                    pre_ms: win.pre_ms,
                    end_ms,
                    within_2_min,
                });
            }
            ToolKind::Other => {}
        }
    }

    (edits, bashes)
}

fn compute_window_end(
    win: &ToolWindow,
    turn_ended_ms: Option<u64>,
    root_cmp: Option<&str>,
    results: &[CaptureResult],
) -> (u64, bool) {
    let anchor = win.post_ms.or(turn_ended_ms).unwrap_or(win.pre_ms);
    let cap = anchor.saturating_add(WINDOW_CAP_MS);
    let Some(expected_root) = root_cmp else {
        return (cap, true);
    };

    let matching = results
        .iter()
        .filter(|r| {
            r.started_ms != 0
                && r.started_ms >= anchor
                && canonical_path(&r.root, cfg!(windows)) == expected_root
        })
        .min_by_key(|r| (r.started_ms, r.at_ms));

    match matching {
        Some(res) if res.at_ms <= cap => (res.at_ms.max(win.pre_ms), false),
        _ => (cap, true),
    }
}

fn classify_target_path(
    target_path: Option<&str>,
    fallback: &str,
    session_root_abs: Option<&AbsPath>,
    home_abs: Option<&AbsPath>,
    cwd: Option<&str>,
) -> (Option<String>, Option<String>, String) {
    let Some(raw) = target_path.map(str::trim).filter(|s| !s.is_empty()) else {
        return (None, None, fallback.to_string());
    };
    let Some(abs) = AbsPath::resolve(raw, cwd) else {
        return (Some(raw.to_string()), None, raw.to_string());
    };
    let resolved_str = abs.format_slash();

    if let Some(root) = session_root_abs
        && let Some(rel_parts) = abs.strip_prefix(root)
        && !rel_parts.is_empty()
    {
        let rel = rel_parts.join("/");
        return (Some(resolved_str), Some(rel.clone()), rel);
    }

    let display = abs.format_tilde(home_abs);
    (Some(resolved_str), None, display)
}

fn build_recorded_blocks(
    input: &BuildInput,
    mut edits: Vec<EditInfo>,
    bashes: &[BashInfoWin],
    session_root_raw: Option<&str>,
    other_bash: &[ToolWindow],
    read: &dyn Fn(&str) -> ObjectRead,
    stat: &dyn Fn(&str) -> Option<u64>,
) -> (Vec<Block>, u64, bool) {
    let mut candidates: Vec<CandidateBlock> = Vec::new();
    let mut outside_count = 0u64;
    let mut bash_groups: BTreeMap<usize, Vec<(usize, u32)>> = BTreeMap::new();
    let root_cmp = session_root_raw.map(|r| canonical_path(r, cfg!(windows)));

    if session_root_raw.is_some() && !input.store_error {
        let mut version_order: Vec<usize> = (0..input.versions.len()).collect();
        version_order.sort_by_key(|&i| (input.versions[i].ts, i));

        for v_idx in version_order {
            let ver = &input.versions[v_idx];
            let v_rel_key = normalize_rel_key(&ver.file_rel);

            let mut matched_edit_indices = Vec::new();
            for (ew_idx, ew) in edits.iter().enumerate() {
                if ew.repo_rel_key.as_deref() == Some(v_rel_key.as_str())
                    && ver.ts >= ew.pre_ms
                    && ver.ts <= ew.end_ms
                {
                    matched_edit_indices.push(ew_idx);
                }
            }

            if !matched_edit_indices.is_empty() {
                let mut tool_ids = Vec::new();
                for &ew_idx in &matched_edit_indices {
                    edits[ew_idx].matched_version = true;
                    let id = &edits[ew_idx].tool_use_id;
                    if !tool_ids.contains(id) {
                        tool_ids.push(id.clone());
                    }
                }
                let first_ew = matched_edit_indices[0];
                let analyzed = analyze_version_pair(
                    &ver.file_rel,
                    ver.before(),
                    ver.deleted,
                    ver.sha.as_deref(),
                    read,
                );
                let quote = lookup_quote(&input.quotes, tool_ids.first().map(String::as_str));

                for (c_idx, (change, (added, removed))) in analyzed
                    .changes
                    .iter()
                    .zip(&analyzed.line_counts)
                    .enumerate()
                {
                    candidates.push(CandidateBlock {
                        sort_key: (ver.ts, edits[first_ew].orig_idx, v_idx, c_idx),
                        block: Block {
                            seq: 0,
                            path: ver.file_rel.clone(),
                            symbol: change.symbol.as_ref().map(convert_symbol),
                            labels: change.labels.iter().map(convert_label).collect(),
                            importance: convert_importance(change.importance),
                            via: BlockVia::Edit,
                            tool_use_ids: tool_ids.clone(),
                            bash: None,
                            before: analyzed.before_sha.clone(),
                            after: analyzed.after_sha.clone(),
                            recorded: true,
                            line: None,
                            added: *added,
                            removed: *removed,
                            quote: quote.clone(),
                        },
                    });
                }
                continue;
            }

            let overlapping_bashes: Vec<usize> = bashes
                .iter()
                .enumerate()
                .filter(|(_, bw)| ver.ts >= bw.pre_ms && ver.ts <= bw.end_ms)
                .map(|(i, _)| i)
                .collect();

            if overlapping_bashes.len() == 1 {
                let bw_idx = overlapping_bashes[0];
                let bw = &bashes[bw_idx];
                if bw.within_2_min {
                    let other_overlap = other_bash
                        .iter()
                        .filter(|ow| {
                            ow.kind == ToolKind::Bash
                                && ow.agent != input.turn.agent
                                && ver.ts >= ow.pre_ms
                                && ver.ts
                                    <= compute_window_end(
                                        ow,
                                        None,
                                        root_cmp.as_deref(),
                                        &input.results,
                                    )
                                    .0
                        })
                        .count() as u32;
                    let total_candidates = 1u32.saturating_add(other_overlap);
                    bash_groups
                        .entry(bw_idx)
                        .or_default()
                        .push((v_idx, total_candidates));
                    continue;
                }
            }

            outside_count = outside_count.saturating_add(1);
        }
    }

    let mut saw_capture_late = false;
    for ew in &edits {
        if ew.matched_version {
            continue;
        }
        if ew.repo_rel.is_some() {
            if ew.ended_by_cap {
                saw_capture_late = true;
            }
            let size = ew.resolved_abs.as_deref().and_then(stat);
            let too_large = size.is_some_and(|sz| sz > MAX_BYTES as u64);
            let label = if too_large {
                Label::TooLarge {}
            } else {
                Label::NotCaptured {}
            };
            candidates.push(CandidateBlock {
                sort_key: (ew.pre_ms, ew.orig_idx, usize::MAX, 0),
                block: edit_only_block(
                    ew,
                    vec![label],
                    Importance::Low,
                    true,
                    lookup_quote(&input.quotes, Some(&ew.tool_use_id)),
                ),
            });
        } else {
            candidates.push(CandidateBlock {
                sort_key: (ew.pre_ms, ew.orig_idx, usize::MAX, 0),
                block: edit_only_block(
                    ew,
                    Vec::new(),
                    Importance::None,
                    false,
                    lookup_quote(&input.quotes, Some(&ew.tool_use_id)),
                ),
            });
        }
    }

    for (bw_idx, items) in bash_groups {
        if let Some(block) = build_bash_group_block(input, &bashes[bw_idx], &items, read) {
            let earliest_ts = items
                .iter()
                .map(|(v_idx, _)| input.versions[*v_idx].ts)
                .min()
                .unwrap_or(bashes[bw_idx].pre_ms);
            candidates.push(CandidateBlock {
                sort_key: (earliest_ts, bashes[bw_idx].orig_idx, usize::MAX, 0),
                block,
            });
        }
    }

    candidates.sort_by_key(|c| c.sort_key);
    let blocks = candidates.into_iter().map(|c| c.block).collect();
    (blocks, outside_count, saw_capture_late)
}

fn build_bash_group_block(
    input: &BuildInput,
    bw: &BashInfoWin,
    items: &[(usize, u32)],
    read: &dyn Fn(&str) -> ObjectRead,
) -> Option<Block> {
    let mut max_candidates = 1u32;
    let mut version_results: Vec<(String, VersionAnalysis)> = Vec::with_capacity(items.len());
    for &(v_idx, cand) in items {
        max_candidates = max_candidates.max(cand);
        let ver = &input.versions[v_idx];
        let analysis = analyze_version_pair(
            &ver.file_rel,
            ver.before(),
            ver.deleted,
            ver.sha.as_deref(),
            read,
        );
        if !analysis.changes.is_empty() {
            version_results.push((ver.file_rel.clone(), analysis));
        }
    }

    if version_results.is_empty() {
        return None;
    }

    let tool_use_ids = if max_candidates == 1 {
        vec![bw.tool_use_id.clone()]
    } else {
        Vec::new()
    };
    let quote = if max_candidates == 1 {
        lookup_quote(&input.quotes, Some(&bw.tool_use_id))
    } else {
        None
    };
    let bash = Some(BashInfo {
        cmd: bw.cmd.clone(),
        candidates: max_candidates,
    });

    if version_results.len() == 1 && version_results[0].1.changes.len() == 1 {
        let (path, analysis) = version_results.into_iter().next()?;
        let change = &analysis.changes[0];
        let (added, removed) = analysis.line_counts[0];
        return Some(Block {
            seq: 0,
            path,
            symbol: change.symbol.as_ref().map(convert_symbol),
            labels: change.labels.iter().map(convert_label).collect(),
            importance: convert_importance(change.importance),
            via: BlockVia::Bash,
            tool_use_ids,
            bash,
            before: analysis.before_sha,
            after: analysis.after_sha,
            recorded: true,
            line: None,
            added,
            removed,
            quote,
        });
    }

    let primary_path = version_results[0].0.clone();
    let single_version = version_results.len() == 1;
    let before_sha = if single_version {
        version_results[0].1.before_sha.clone()
    } else {
        None
    };
    let after_sha = if single_version {
        version_results[0].1.after_sha.clone()
    } else {
        None
    };

    let mut max_importance = Importance::None;
    let mut ranked_labels: Vec<(rocky_facts::Importance, FactLabel)> = Vec::new();
    let mut total_added = Some(0u32);
    let mut total_removed = Some(0u32);

    for (_, analysis) in &version_results {
        for (change, (added, removed)) in analysis.changes.iter().zip(&analysis.line_counts) {
            let imp = convert_importance(change.importance);
            if imp > max_importance {
                max_importance = imp;
            }
            let exported = change.symbol.as_ref().is_some_and(|s| s.exported);
            for label in &change.labels {
                ranked_labels.push((label.importance(exported), label.clone()));
            }
            match (total_added, added) {
                (Some(acc), Some(v)) => total_added = Some(acc.saturating_add(*v)),
                _ => total_added = None,
            }
            match (total_removed, removed) {
                (Some(acc), Some(v)) => total_removed = Some(acc.saturating_add(*v)),
                _ => total_removed = None,
            }
        }
    }

    ranked_labels.sort_by(|a, b| Reverse(a.0).cmp(&Reverse(b.0)).then_with(|| a.1.cmp(&b.1)));
    let mut labels = Vec::new();
    for (_, label) in ranked_labels {
        let converted = convert_label(&label);
        if !labels.contains(&converted) {
            labels.push(converted);
            if labels.len() == MAX_LABELS_PER_CHANGE {
                break;
            }
        }
    }

    Some(Block {
        seq: 0,
        path: primary_path,
        symbol: None,
        labels,
        importance: max_importance,
        via: BlockVia::Bash,
        tool_use_ids,
        bash,
        before: before_sha,
        after: after_sha,
        recorded: true,
        line: None,
        added: total_added,
        removed: total_removed,
        quote,
    })
}

fn edit_only_block(
    ew: &EditInfo,
    labels: Vec<Label>,
    importance: Importance,
    recorded: bool,
    quote: Option<Quote>,
) -> Block {
    Block {
        seq: 0,
        path: ew.display_path.clone(),
        symbol: None,
        labels,
        importance,
        via: BlockVia::Edit,
        tool_use_ids: vec![ew.tool_use_id.clone()],
        bash: None,
        before: None,
        after: None,
        recorded,
        line: None,
        added: None,
        removed: None,
        quote,
    }
}

fn build_unconsented_blocks(edits: &[EditInfo], quotes: &TranscriptRead) -> Vec<Block> {
    edits
        .iter()
        .map(|ew| {
            let quote = lookup_quote(quotes, Some(&ew.tool_use_id));
            edit_only_block(ew, Vec::new(), Importance::None, false, quote)
        })
        .collect()
}

fn analyze_version_pair(
    file_rel: &str,
    before_state: Before,
    deleted: bool,
    after_sha_in: Option<&str>,
    read: &dyn Fn(&str) -> ObjectRead,
) -> VersionAnalysis {
    let (before_sha, before_obj) = match &before_state {
        Before::Absent => (None, None),
        Before::Unknown => (None, None),
        Before::Known(sha) => (Some(sha.clone()), Some(read(sha))),
    };
    let (after_sha, after_obj) = if deleted {
        (None, None)
    } else if let Some(sha) = after_sha_in {
        let obj = read(sha);
        (Some(sha.to_string()), Some(obj))
    } else {
        (None, Some(ObjectRead::Missing))
    };

    let before_side = match (&before_state, &before_obj) {
        (Before::Absent, _) => SideData::Absent,
        (Before::Unknown, _) => SideData::Unknown,
        (Before::Known(_), Some(ObjectRead::Text(text))) => SideData::Text(text.as_str()),
        (Before::Known(_), Some(ObjectRead::TooLarge)) => SideData::TooLarge,
        (Before::Known(_), Some(ObjectRead::Missing | ObjectRead::Invalid)) => SideData::Unknown,
        (Before::Known(_), None) => SideData::Unknown,
    };

    let after_side = if deleted {
        SideData::Absent
    } else {
        match &after_obj {
            Some(ObjectRead::Text(text)) => SideData::Text(text.as_str()),
            Some(ObjectRead::TooLarge) => SideData::TooLarge,
            Some(ObjectRead::Missing | ObjectRead::Invalid) | None => SideData::Missing,
        }
    };

    let changes = match (before_side, after_side) {
        (SideData::TooLarge, _) | (_, SideData::TooLarge) => {
            vec![FactChange::new(None, vec![FactLabel::TooLarge {}])]
        }
        (_, SideData::Missing) => {
            vec![FactChange::new(None, vec![FactLabel::NotCaptured {}])]
        }
        _ => {
            let before = to_fact_side(before_side);
            let after = to_fact_side(after_side);
            analyze(&FileInput {
                path: file_rel,
                before,
                after,
            })
            .changes
        }
    };

    let b_fact = to_fact_side(before_side);
    let a_fact = to_fact_side(after_side);
    let line_counts = changes
        .iter()
        .map(|ch| diff_counts(ch, b_fact, a_fact))
        .collect();

    VersionAnalysis {
        changes,
        before_sha,
        after_sha,
        line_counts,
    }
}

fn to_fact_side(side: SideData<'_>) -> Side<'_> {
    match side {
        SideData::Absent => Side::Absent,
        SideData::Unknown | SideData::TooLarge | SideData::Missing => Side::Unknown,
        SideData::Text(text) => Side::Text(text),
    }
}

fn diff_counts(
    change: &FactChange,
    before: Side<'_>,
    after: Side<'_>,
) -> (Option<u32>, Option<u32>) {
    for label in &change.labels {
        if let FactLabel::LinesChanged { added, removed } = label {
            return (Some(*added), Some(*removed));
        }
    }
    if change
        .labels
        .iter()
        .any(|l| matches!(l, FactLabel::FileNew {}))
        && let Side::Text(text) = after
    {
        return (Some(count_lines(text)), Some(0));
    }
    if change
        .labels
        .iter()
        .any(|l| matches!(l, FactLabel::FileDeleted {}))
        && let Side::Text(text) = before
    {
        return (Some(0), Some(count_lines(text)));
    }
    (None, None)
}

fn count_lines(text: &str) -> u32 {
    u32::try_from(text.lines().count()).unwrap_or(u32::MAX)
}

fn build_flow(
    windows: &[ToolWindow],
    blocks: &[Block],
    session_root_abs: Option<&AbsPath>,
    home_abs: Option<&AbsPath>,
    cwd: Option<&str>,
) -> (Vec<FlowStep>, u32) {
    let mut indexed: Vec<(usize, &ToolWindow)> = windows
        .iter()
        .enumerate()
        .filter(|(_, w)| matches!(w.kind, ToolKind::Bash | ToolKind::Edit))
        .collect();
    indexed.sort_by_key(|(idx, w)| (w.pre_ms, *idx));
    let flow_more =
        u32::try_from(indexed.len().saturating_sub(MAX_FLOW_STEPS)).unwrap_or(u32::MAX);

    let flow = indexed
        .into_iter()
        .take(MAX_FLOW_STEPS)
        .map(|(_, win)| {
            let dur_ms = win
                .post_ms
                .map(|post| post.saturating_sub(win.pre_ms))
                .unwrap_or(0);
            let ok = win.ok.unwrap_or(false);
            match win.kind {
                ToolKind::Bash => FlowStep {
                    kind: FlowKind::Cmd,
                    text: win.command.clone().unwrap_or_default(),
                    ok,
                    dur_ms,
                    seqs: Vec::new(),
                },
                ToolKind::Edit => {
                    let matching: Vec<&Block> = blocks
                        .iter()
                        .filter(|b| b.tool_use_ids.iter().any(|id| id == &win.tool_use_id))
                        .collect();
                    let seqs: Vec<u32> = matching.iter().map(|b| b.seq).collect();
                    let (_, _, fallback_path) = classify_target_path(
                        win.target_path.as_deref(),
                        &win.tool,
                        session_root_abs,
                        home_abs,
                        cwd,
                    );
                    let display_path = matching
                        .first()
                        .map(|b| b.path.as_str())
                        .unwrap_or(fallback_path.as_str());
                    let sym_name = matching
                        .iter()
                        .find_map(|b| b.symbol.as_ref())
                        .map(|s| match s.container.as_deref() {
                            Some(c) if !c.is_empty() => format!("{c}.{}", s.name),
                            _ => s.name.clone(),
                        });
                    let text = match sym_name {
                        Some(sym) => format!("{display_path} \u{203a} {sym}"),
                        None => display_path.to_string(),
                    };
                    FlowStep {
                        kind: FlowKind::Edit,
                        text,
                        ok,
                        dur_ms,
                        seqs,
                    }
                }
                ToolKind::Other => unreachable!(),
            }
        })
        .collect();
    (flow, flow_more)
}

fn build_coverage(input: &BuildInput, blocks: &[Block], saw_capture_late: bool) -> Coverage {
    let mut reasons = BTreeSet::new();

    let turn_start = input.turn.started_ms;
    let turn_end = input.turn.ended_ms.unwrap_or(u64::MAX);
    if input
        .gaps
        .iter()
        .any(|&(from_ms, to_ms)| to_ms >= turn_start && from_ms <= turn_end)
    {
        reasons.insert(CoverageReason::DaemonGap);
    }

    if saw_capture_late || input.tail_cut {
        reasons.insert(CoverageReason::CaptureLate);
    }

    if input.store_error
        || matches!(
            input.capture_state,
            Some(CaptureState::Failed | CaptureState::Polling)
        )
    {
        reasons.insert(CoverageReason::CaptureOff);
    }

    if blocks
        .iter()
        .any(|b| b.labels.iter().any(|l| matches!(l, Label::TooLarge {})))
    {
        reasons.insert(CoverageReason::TooLarge);
    }

    if !input.quotes.complete {
        reasons.insert(CoverageReason::TranscriptUnreadable);
    }

    if matches!(input.turn.status, TurnEnd::Unclosed) {
        reasons.insert(CoverageReason::TurnUnclosed);
    }

    let reason_vec: Vec<CoverageReason> = reasons.into_iter().collect();
    let state = if reason_vec.is_empty() {
        CoverageState::Full
    } else {
        CoverageState::Partial
    };

    Coverage {
        state,
        reasons: reason_vec,
    }
}

fn is_main_agent(turn: &Turn) -> bool {
    turn.parent.is_none() && turn.agent.agent_id.is_empty()
}

fn select_prompt(input: &BuildInput) -> (String, bool) {
    let raw = if is_main_agent(&input.turn) {
        input
            .turn
            .prompt
            .as_ref()
            .map(|p| (p.text.as_str(), p.truncated))
    } else {
        input
            .quotes
            .first_user_text
            .as_ref()
            .map(|(text, truncated)| (text.as_str(), *truncated))
    };

    match raw {
        Some((text, prev_truncated)) => {
            let (bounded, cut) = cut_chars(text, PROMPT_MAX_CHARS);
            (bounded, prev_truncated || cut)
        }
        None => (String::new(), false),
    }
}

fn lookup_quote(quotes: &TranscriptRead, tool_use_id: Option<&str>) -> Option<Quote> {
    let id = tool_use_id?;
    let q = quotes.quotes.get(id)?;
    let (text, _) = cut_chars(&q.text, QUOTE_MAX_CHARS);
    Some(Quote {
        text,
        shared: q.shared,
    })
}

fn cut_chars(text: &str, max_chars: usize) -> (String, bool) {
    if text.chars().count() <= max_chars {
        return (text.to_string(), false);
    }
    (text.chars().take(max_chars).collect(), true)
}

fn convert_importance(imp: rocky_facts::Importance) -> Importance {
    match imp {
        rocky_facts::Importance::None => Importance::None,
        rocky_facts::Importance::Low => Importance::Low,
        rocky_facts::Importance::Medium => Importance::Medium,
        rocky_facts::Importance::High => Importance::High,
    }
}

fn convert_symbol_kind(kind: FactSymbolKind) -> SymbolKind {
    match kind {
        FactSymbolKind::Function => SymbolKind::Function,
        FactSymbolKind::Method => SymbolKind::Method,
        FactSymbolKind::Class => SymbolKind::Class,
        FactSymbolKind::Struct => SymbolKind::Struct,
        FactSymbolKind::Enum => SymbolKind::Enum,
        FactSymbolKind::Trait => SymbolKind::Trait,
        FactSymbolKind::Interface => SymbolKind::Interface,
        FactSymbolKind::Type => SymbolKind::Type,
        FactSymbolKind::Const => SymbolKind::Const,
        FactSymbolKind::Test => SymbolKind::Test,
        FactSymbolKind::Key => SymbolKind::Key,
    }
}

fn convert_symbol(sym: &FactSymbol) -> BlockSymbol {
    BlockSymbol {
        kind: convert_symbol_kind(sym.kind),
        name: sym.name.clone(),
        container: sym.container.clone(),
        exported: sym.exported,
        nth: sym.nth,
    }
}

fn convert_label(label: &FactLabel) -> Label {
    match label {
        FactLabel::ParamsChanged {
            added,
            removed,
            changed,
        } => Label::ParamsChanged {
            added: *added,
            removed: *removed,
            changed: *changed,
        },
        FactLabel::ReturnTypeChanged {} => Label::ReturnTypeChanged {},
        FactLabel::SymbolRemoved {} => Label::SymbolRemoved {},
        FactLabel::SymbolAdded {} => Label::SymbolAdded {},
        FactLabel::SymbolRenamed { from } => Label::SymbolRenamed { from: from.clone() },
        FactLabel::GuardAdded {} => Label::GuardAdded {},
        FactLabel::ConditionChanged {} => Label::ConditionChanged {},
        FactLabel::BranchAdded {} => Label::BranchAdded {},
        FactLabel::BranchRemoved {} => Label::BranchRemoved {},
        FactLabel::ErrorHandlingAdded {} => Label::ErrorHandlingAdded {},
        FactLabel::ErrorHandlingRemoved {} => Label::ErrorHandlingRemoved {},
        FactLabel::LoopAdded {} => Label::LoopAdded {},
        FactLabel::LoopRemoved {} => Label::LoopRemoved {},
        FactLabel::ReturnChanged {} => Label::ReturnChanged {},
        FactLabel::CallAdded { name } => Label::CallAdded { name: name.clone() },
        FactLabel::CallRemoved { name } => Label::CallRemoved { name: name.clone() },
        FactLabel::AwaitChanged { added, removed } => Label::AwaitChanged {
            added: *added,
            removed: *removed,
        },
        FactLabel::BodyChanged {} => Label::BodyChanged {},
        FactLabel::ValueChanged {
            name,
            before,
            after,
        } => Label::ValueChanged {
            name: name.clone(),
            before: before.clone(),
            after: after.clone(),
        },
        FactLabel::ConfigChanged { key, before, after } => Label::ConfigChanged {
            key: key.clone(),
            before: before.clone(),
            after: after.clone(),
        },
        FactLabel::DepAdded { name, version } => Label::DepAdded {
            name: name.clone(),
            version: version.clone(),
        },
        FactLabel::DepRemoved { name } => Label::DepRemoved { name: name.clone() },
        FactLabel::DepVersion {
            name,
            before,
            after,
        } => Label::DepVersion {
            name: name.clone(),
            before: before.clone(),
            after: after.clone(),
        },
        FactLabel::ImportAdded { module } => Label::ImportAdded {
            module: module.clone(),
        },
        FactLabel::ImportRemoved { module } => Label::ImportRemoved {
            module: module.clone(),
        },
        FactLabel::TestAdded { name } => Label::TestAdded { name: name.clone() },
        FactLabel::TestRemoved { name } => Label::TestRemoved { name: name.clone() },
        FactLabel::TestSkipped { name } => Label::TestSkipped { name: name.clone() },
        FactLabel::TestOnly { name } => Label::TestOnly { name: name.clone() },
        FactLabel::FileNew {} => Label::FileNew {},
        FactLabel::FileDeleted {} => Label::FileDeleted {},
        FactLabel::FileRenamed { from } => Label::FileRenamed { from: from.clone() },
        FactLabel::FormatOnly {} => Label::FormatOnly {},
        FactLabel::Rewrite { pct } => Label::Rewrite { pct: *pct },
        FactLabel::LockfileChanged {} => Label::LockfileChanged {},
        FactLabel::LinesChanged { added, removed } => Label::LinesChanged {
            added: *added,
            removed: *removed,
        },
        FactLabel::TooLarge {} => Label::TooLarge {},
        FactLabel::NotCaptured {} => Label::NotCaptured {},
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::collections::BTreeMap;

    use rocky_proto::cards::{
        BlockVia, CoverageReason, CoverageState, FlowKind, Importance, Label, SymbolKind,
    };
    use rocky_proto::pipe::{AgentKey, RepoInfo};

    use super::*;
    use crate::cards::transcript::Quote as TranscriptQuote;
    use crate::cards::windows::{PromptIn, ToolKind, TurnEnd};

    fn test_root() -> &'static str {
        if cfg!(windows) {
            "C:\\work\\repo"
        } else {
            "/work/repo"
        }
    }

    fn test_home() -> PathBuf {
        if cfg!(windows) {
            PathBuf::from("C:\\Users\\alice")
        } else {
            PathBuf::from("/home/alice")
        }
    }

    fn repo_join(rel: &str) -> String {
        if cfg!(windows) {
            format!("{}\\{}", test_root(), rel.replace('/', "\\"))
        } else {
            format!("{}/{}", test_root(), rel)
        }
    }

    fn home_join(rel: &str) -> String {
        if cfg!(windows) {
            format!("C:\\Users\\alice\\{}", rel.replace('/', "\\"))
        } else {
            format!("/home/alice/{}", rel)
        }
    }

    fn main_agent(session_id: &str) -> AgentKey {
        AgentKey {
            session_id: session_id.to_string(),
            agent_id: String::new(),
        }
    }

    fn sub_agent(session_id: &str, agent_id: &str) -> AgentKey {
        AgentKey {
            session_id: session_id.to_string(),
            agent_id: agent_id.to_string(),
        }
    }

    fn base_turn(windows: Vec<ToolWindow>) -> Turn {
        Turn {
            agent: main_agent("sess-1"),
            agent_type: String::new(),
            parent: None,
            cwd: Some(test_root().to_string()),
            repo: RepoInfo {
                root: Some(test_root().to_string()),
                main_root: Some(test_root().to_string()),
                name: "repo".to_string(),
                branch: Some("main".to_string()),
            },
            prompt: Some(PromptIn {
                session_id: "sess-1".to_string(),
                text: "Update discount calculation".to_string(),
                truncated: false,
                recv_ms: 1_000,
            }),
            started_ms: 1_000,
            ended_ms: Some(20_000),
            status: TurnEnd::Done,
            transcript_path: None,
            windows,
        }
    }

    fn edit_win(
        id: &str,
        session_id: &str,
        target_path: String,
        pre_ms: u64,
        post_ms: Option<u64>,
        ok: Option<bool>,
    ) -> ToolWindow {
        ToolWindow {
            tool_use_id: id.to_string(),
            agent: main_agent(session_id),
            kind: ToolKind::Edit,
            tool: "Edit".to_string(),
            target_path: Some(target_path),
            command: None,
            pre_ms,
            post_ms,
            ok,
        }
    }

    fn bash_win(
        id: &str,
        agent: AgentKey,
        cmd: &str,
        pre_ms: u64,
        post_ms: Option<u64>,
        ok: Option<bool>,
    ) -> ToolWindow {
        ToolWindow {
            tool_use_id: id.to_string(),
            agent,
            kind: ToolKind::Bash,
            tool: "Bash".to_string(),
            target_path: None,
            command: Some(cmd.to_string()),
            pre_ms,
            post_ms,
            ok,
        }
    }

    fn base_input(turn: Turn) -> BuildInput {
        BuildInput {
            turn,
            card_id: "card-1".to_string(),
            rev: 1,
            session_root: Some(test_root().to_string()),
            recorded: true,
            versions: Vec::new(),
            results: Vec::new(),
            other_bash: Vec::new(),
            quotes: TranscriptRead {
                quotes: BTreeMap::new(),
                first_user_text: None,
                complete: true,
            },
            gaps: Vec::new(),
            capture_state: Some(CaptureState::Ok),
            store_error: false,
            tail_cut: false,
            home_dir: test_home(),
            parent_card_id: None,
        }
    }

    fn ver(file_rel: &str, ts: u64, prev: Option<&str>, sha: Option<&str>) -> Version {
        Version {
            file_rel: file_rel.to_string(),
            ts,
            sha: sha.map(str::to_string),
            prev: prev.map(str::to_string),
            created: false,
            deleted: false,
            baseline: false,
        }
    }

    fn no_read(_sha: &str) -> ObjectRead {
        ObjectRead::Missing
    }

    fn no_stat(_path: &str) -> Option<u64> {
        None
    }

    #[test]
    fn direct_edit_with_window_end_from_result() {
        let mut input = base_input(base_turn(vec![edit_win(
            "edit-1",
            "sess-1",
            repo_join("src/cart.ts"),
            2_000,
            Some(2_500),
            Some(true),
        )]));
        input.results = vec![
            CaptureResult {
                root: test_root().to_string(),
                started_ms: 0,
                at_ms: 2_600,
                coverage: "ok".to_string(),
            },
            CaptureResult {
                root: test_root().to_string(),
                started_ms: 2_550,
                at_ms: 3_000,
                coverage: "ok".to_string(),
            },
        ];
        input.versions = vec![
            ver("src/cart.ts", 2_900, Some("sha-a"), Some("sha-b")),
            ver("src/cart.ts", 3_100, Some("sha-b"), Some("sha-c")),
        ];

        let read = |sha: &str| match sha {
            "sha-a" => ObjectRead::Text("export function total(x: number) { return x; }\n".into()),
            "sha-b" => ObjectRead::Text(
                "export function total(x: number) { return x; }\n\
                 export function applyDiscount(x: number) { return x * 0.9; }\n"
                    .into(),
            ),
            _ => ObjectRead::Missing,
        };

        let card = build_card(&input, &read, &no_stat);
        assert_eq!(card.blocks.len(), 1);
        assert_eq!(card.outside_count, 1);
        let blk = &card.blocks[0];
        assert_eq!(blk.via, BlockVia::Edit);
        assert_eq!(blk.tool_use_ids, vec!["edit-1".to_string()]);
        assert_eq!(blk.path, "src/cart.ts");
        assert_eq!(blk.before.as_deref(), Some("sha-a"));
        assert_eq!(blk.after.as_deref(), Some("sha-b"));
        let sym = blk.symbol.as_ref().expect("symbol detected");
        assert_eq!(sym.kind, SymbolKind::Function);
        assert_eq!(sym.name, "applyDiscount");
        assert!(sym.exported);
        assert_eq!(blk.labels, vec![Label::SymbolAdded {}]);
        assert_eq!(card.coverage.state, CoverageState::Full);
    }

    #[test]
    fn window_end_capped_at_30s() {
        let mut input = base_input(base_turn(vec![edit_win(
            "edit-1",
            "sess-1",
            repo_join("src/a.ts"),
            2_000,
            Some(5_000),
            Some(true),
        )]));
        input.results = vec![CaptureResult {
            root: test_root().to_string(),
            started_ms: 40_000,
            at_ms: 40_100,
            coverage: "ok".to_string(),
        }];
        input.versions = vec![
            ver("src/a.ts", 35_000, Some("sha-1"), Some("sha-2")),
            ver("src/a.ts", 35_001, Some("sha-2"), Some("sha-3")),
        ];

        let read = |sha: &str| match sha {
            "sha-1" => ObjectRead::Text("export function a() { return 1; }\n".into()),
            "sha-2" => ObjectRead::Text("export function a() { return 2; }\n".into()),
            _ => ObjectRead::Missing,
        };

        let card = build_card(&input, &read, &no_stat);
        assert_eq!(card.blocks.len(), 1);
        assert_eq!(card.blocks[0].before.as_deref(), Some("sha-1"));
        assert_eq!(card.blocks[0].after.as_deref(), Some("sha-2"));
        assert_eq!(card.outside_count, 1);
    }

    #[test]
    fn via_bash_single_candidate_grouped() {
        let mut input = base_input(base_turn(vec![bash_win(
            "bash-1",
            main_agent("sess-1"),
            "npm run gen",
            2_000,
            Some(7_000),
            Some(true),
        )]));
        input.results = vec![CaptureResult {
            root: test_root().to_string(),
            started_ms: 7_050,
            at_ms: 7_200,
            coverage: "ok".to_string(),
        }];
        let mut created_b = ver("src/gen/b.ts", 5_000, None, Some("sha-b2"));
        created_b.created = true;
        input.versions = vec![
            ver("src/gen/a.ts", 4_500, Some("sha-a1"), Some("sha-a2")),
            created_b,
        ];
        input.quotes.quotes.insert(
            "bash-1".to_string(),
            TranscriptQuote {
                text: "Generating client files now.".to_string(),
                shared: false,
            },
        );

        let read = |sha: &str| match sha {
            "sha-a1" => ObjectRead::Text("export function foo() { return 1; }\n".into()),
            "sha-a2" => ObjectRead::Text("export function foo() { return 2; }\n".into()),
            "sha-b2" => ObjectRead::Text("export const generated = true;\n".into()),
            _ => ObjectRead::Missing,
        };

        let card = build_card(&input, &read, &no_stat);
        assert_eq!(card.blocks.len(), 1);
        assert_eq!(card.outside_count, 0);
        let blk = &card.blocks[0];
        assert_eq!(blk.via, BlockVia::Bash);
        assert_eq!(
            blk.bash,
            Some(rocky_proto::cards::BashInfo {
                cmd: "npm run gen".to_string(),
                candidates: 1,
            })
        );
        assert_eq!(blk.tool_use_ids, vec!["bash-1".to_string()]);
        assert_eq!(
            blk.quote.as_ref().map(|q| q.text.as_str()),
            Some("Generating client files now.")
        );
    }

    #[test]
    fn bash_over_2_min_not_attributed() {
        let mut input = base_input(base_turn(vec![bash_win(
            "bash-long",
            main_agent("sess-1"),
            "cargo test --all",
            1_000,
            Some(121_001),
            Some(true),
        )]));
        input.results = vec![CaptureResult {
            root: test_root().to_string(),
            started_ms: 121_050,
            at_ms: 121_200,
            coverage: "ok".to_string(),
        }];
        input.versions = vec![ver("src/lib.rs", 60_000, Some("s1"), Some("s2"))];

        let card = build_card(&input, &no_read, &no_stat);
        assert!(card.blocks.is_empty());
        assert_eq!(card.outside_count, 1);
        assert_eq!(card.flow.len(), 1);
        assert_eq!(card.flow[0].kind, FlowKind::Cmd);
        assert_eq!(card.flow[0].dur_ms, 120_001);
    }

    #[test]
    fn parallel_bash_marks_candidates_uncertain() {
        let mut input = base_input(base_turn(vec![bash_win(
            "bash-1",
            main_agent("sess-1"),
            "prettier --write src/a.ts",
            2_000,
            Some(6_000),
            Some(true),
        )]));
        input.other_bash = vec![bash_win(
            "bash-other",
            sub_agent("sess-2", "worker-1"),
            "sed -i s/x/y/ src/a.ts",
            3_000,
            Some(8_000),
            Some(true),
        )];
        input.results = vec![CaptureResult {
            root: test_root().to_string(),
            started_ms: 6_100,
            at_ms: 6_300,
            coverage: "ok".to_string(),
        }];
        input.versions = vec![ver("src/a.ts", 4_000, Some("s1"), Some("s2"))];
        input.quotes.quotes.insert(
            "bash-1".to_string(),
            TranscriptQuote {
                text: "Formatting src/a.ts".to_string(),
                shared: false,
            },
        );

        let read = |sha: &str| match sha {
            "s1" => ObjectRead::Text("export function a() { return 1; }\n".into()),
            "s2" => ObjectRead::Text("export function a() { return 2; }\n".into()),
            _ => ObjectRead::Missing,
        };

        let card = build_card(&input, &read, &no_stat);
        assert_eq!(card.blocks.len(), 1);
        let blk = &card.blocks[0];
        assert_eq!(blk.via, BlockVia::Bash);
        assert_eq!(
            blk.bash,
            Some(rocky_proto::cards::BashInfo {
                cmd: "prettier --write src/a.ts".to_string(),
                candidates: 2,
            })
        );
        assert!(blk.tool_use_ids.is_empty());
        assert!(blk.quote.is_none());
    }

    #[test]
    fn outside_change_counted_only() {
        let mut input = base_input(base_turn(Vec::new()));
        input.versions = vec![
            ver("src/one.ts", 5_000, Some("a1"), Some("a2")),
            ver("src/two.ts", 8_000, Some("b1"), Some("b2")),
        ];

        let card = build_card(&input, &no_read, &no_stat);
        assert!(card.blocks.is_empty());
        assert_eq!(card.outside_count, 2);
        assert_eq!(card.importance, Importance::None);
    }

    #[test]
    fn one_version_two_edits_keeps_both_ids() {
        let path = repo_join("src/cart.ts");
        let mut input = base_input(base_turn(vec![
            edit_win(
                "e-1",
                "sess-1",
                path.clone(),
                2_000,
                Some(2_300),
                Some(true),
            ),
            edit_win("e-2", "sess-1", path, 2_400, Some(2_700), Some(true)),
        ]));
        input.results = vec![CaptureResult {
            root: test_root().to_string(),
            started_ms: 2_800,
            at_ms: 3_000,
            coverage: "ok".to_string(),
        }];
        input.versions = vec![ver("src/cart.ts", 2_900, Some("sha-1"), Some("sha-2"))];
        input.quotes.quotes.insert(
            "e-1".to_string(),
            TranscriptQuote {
                text: "First edit note".to_string(),
                shared: false,
            },
        );
        input.quotes.quotes.insert(
            "e-2".to_string(),
            TranscriptQuote {
                text: "Second edit note".to_string(),
                shared: false,
            },
        );

        let read = |sha: &str| match sha {
            "sha-1" => ObjectRead::Text("export function price() { return 10; }\n".into()),
            "sha-2" => ObjectRead::Text("export function price() { return 20; }\n".into()),
            _ => ObjectRead::Missing,
        };

        let card = build_card(&input, &read, &no_stat);
        assert_eq!(card.blocks.len(), 1);
        let blk = &card.blocks[0];
        assert_eq!(blk.tool_use_ids, vec!["e-1".to_string(), "e-2".to_string()]);
        assert_eq!(
            blk.quote.as_ref().map(|q| q.text.as_str()),
            Some("First edit note")
        );
        assert_eq!(card.flow.len(), 2);
        assert_eq!(card.flow[0].seqs, vec![blk.seq]);
        assert_eq!(card.flow[1].seqs, vec![blk.seq]);
    }

    #[test]
    fn edit_outside_session_repo_is_path_only_with_tilde() {
        let input = base_input(base_turn(vec![edit_win(
            "e-out",
            "sess-1",
            home_join("notes/todo.md"),
            2_000,
            Some(2_200),
            Some(true),
        )]));

        let io_called = RefCell::new(false);
        let read = |_sha: &str| {
            *io_called.borrow_mut() = true;
            ObjectRead::Missing
        };
        let stat = |_path: &str| {
            *io_called.borrow_mut() = true;
            Some(128)
        };

        let card = build_card(&input, &read, &stat);
        assert!(
            !*io_called.borrow(),
            "read and stat must not run for out-of-repo edit"
        );
        assert_eq!(card.blocks.len(), 1);
        let blk = &card.blocks[0];
        assert_eq!(blk.path, "~/notes/todo.md");
        assert!(!blk.recorded);
        assert!(blk.symbol.is_none());
        assert!(blk.labels.is_empty());
        assert_eq!(blk.importance, Importance::None);
        assert!(blk.before.is_none());
        assert!(blk.after.is_none());
        assert_eq!(card.coverage.state, CoverageState::Full);
    }

    #[test]
    fn edit_without_version_stat_too_large_or_not_captured() {
        let big_path = repo_join("assets/bundle.js");
        let small_path = repo_join("src/note.txt");
        let mut input = base_input(base_turn(vec![
            edit_win("e-big", "sess-1", big_path, 2_000, Some(2_200), Some(true)),
            edit_win(
                "e-small",
                "sess-1",
                small_path,
                3_000,
                Some(3_200),
                Some(true),
            ),
        ]));
        input.results = vec![CaptureResult {
            root: test_root().to_string(),
            started_ms: 3_500,
            at_ms: 4_000,
            coverage: "ok".to_string(),
        }];

        let stat = |path: &str| {
            let norm = path.replace('\\', "/").to_lowercase();
            if norm.ends_with("assets/bundle.js") {
                Some(1_048_577)
            } else {
                Some(256)
            }
        };

        let card = build_card(&input, &no_read, &stat);
        assert_eq!(card.blocks.len(), 2);
        assert_eq!(card.blocks[0].labels, vec![Label::TooLarge {}]);
        assert_eq!(card.blocks[0].importance, Importance::Low);
        assert_eq!(card.blocks[1].labels, vec![Label::NotCaptured {}]);
        assert_eq!(card.blocks[1].importance, Importance::Low);
        assert_eq!(card.coverage.state, CoverageState::Partial);
        assert!(card.coverage.reasons.contains(&CoverageReason::TooLarge));
    }

    #[test]
    fn version_without_prev_is_not_captured() {
        let mut input = base_input(base_turn(vec![edit_win(
            "e-1",
            "sess-1",
            repo_join("src/old.ts"),
            2_000,
            Some(2_300),
            Some(true),
        )]));
        input.results = vec![CaptureResult {
            root: test_root().to_string(),
            started_ms: 2_400,
            at_ms: 2_600,
            coverage: "ok".to_string(),
        }];
        input.versions = vec![ver("src/old.ts", 2_500, None, Some("sha-after"))];

        let read = |sha: &str| match sha {
            "sha-after" => ObjectRead::Text("export const x = 1;\n".into()),
            _ => ObjectRead::Missing,
        };

        let card = build_card(&input, &read, &no_stat);
        assert_eq!(card.blocks.len(), 1);
        assert_eq!(card.blocks[0].labels, vec![Label::NotCaptured {}]);
        assert!(card.blocks[0].before.is_none());
        assert_eq!(card.blocks[0].after.as_deref(), Some("sha-after"));
    }

    #[test]
    fn cap_30_blocks() {
        let mut windows = Vec::new();
        let mut versions = Vec::new();
        let mut blobs = BTreeMap::new();
        for i in 0..35u64 {
            let rel = format!("src/f_{i:02}.ts");
            let id = format!("e-{i:02}");
            let bsha = format!("b-{i:02}");
            let asha = format!("a-{i:02}");
            windows.push(edit_win(
                &id,
                "sess-1",
                repo_join(&rel),
                1_000 + i * 100,
                Some(1_050 + i * 100),
                Some(true),
            ));
            versions.push(ver(&rel, 1_060 + i * 100, Some(&bsha), Some(&asha)));
            if i == 34 {
                blobs.insert(bsha, "export function run() { return 1; }\n".to_string());
                blobs.insert(asha, String::new());
            } else {
                blobs.insert(bsha, "export function run() { return 1; }\n".to_string());
                blobs.insert(asha, "export function run() { return 2; }\n".to_string());
            }
        }
        let mut input = base_input(base_turn(windows));
        input.versions = versions;
        input.results = vec![CaptureResult {
            root: test_root().to_string(),
            started_ms: 20_000,
            at_ms: 20_100,
            coverage: "ok".to_string(),
        }];

        let read = |sha: &str| match blobs.get(sha) {
            Some(text) => ObjectRead::Text(text.clone()),
            None => ObjectRead::Missing,
        };

        let card = build_card(&input, &read, &no_stat);
        assert_eq!(card.blocks.len(), 30);
        assert_eq!(card.more_count, 5);
        assert_eq!(card.outside_count, 0);
        assert_eq!(card.blocks[0].seq, 1);
        assert_eq!(card.blocks[29].seq, 30);
        assert_eq!(card.importance, Importance::High);
    }

    #[test]
    fn flow_capped_at_100_records_flow_more() {
        let windows: Vec<ToolWindow> = (0..120u64)
            .map(|i| bash_win(&format!("b-{i}"), main_agent("sess-1"), &format!("echo {i}"), 1_000 + i * 10, Some(1_005 + i * 10), Some(true)))
            .collect();
        let input = base_input(base_turn(windows));
        let card = build_card(&input, &no_read, &no_stat);
        assert_eq!(card.flow.len(), 100);
        assert_eq!(card.flow_more, 20);
        assert_eq!(card.flow[0].text, "echo 0");
        assert_eq!(card.flow[99].text, "echo 99");
    }

    #[test]
    fn late_post_tool_use_revision_changes_card() {
        let mut rev1_turn = base_turn(vec![edit_win(
            "e-1",
            "sess-1",
            repo_join("src/cart.ts"),
            2_000,
            Some(2_300),
            Some(true),
        )]);
        rev1_turn.ended_ms = None;
        rev1_turn.status = TurnEnd::Open;
        let rev1_in = base_input(rev1_turn);
        let stat_small = |_: &str| Some(64);

        let c1 = build_card(&rev1_in, &no_read, &stat_small);
        assert_eq!(c1.rev, 1);
        assert_eq!(c1.card_id, "card-1");
        assert_eq!(c1.blocks.len(), 1);
        assert_eq!(c1.blocks[0].labels, vec![Label::NotCaptured {}]);
        assert_eq!(c1.coverage.state, CoverageState::Partial);
        assert!(c1.coverage.reasons.contains(&CoverageReason::CaptureLate));

        let mut rev2_in = rev1_in;
        rev2_in.rev = 2;
        rev2_in.turn.status = TurnEnd::Done;
        rev2_in.turn.ended_ms = Some(10_000);
        rev2_in.results = vec![CaptureResult {
            root: test_root().to_string(),
            started_ms: 2_350,
            at_ms: 2_500,
            coverage: "ok".to_string(),
        }];
        rev2_in.versions = vec![ver("src/cart.ts", 2_450, Some("b1"), Some("a1"))];
        let read = |sha: &str| match sha {
            "b1" => ObjectRead::Text("export function apply(x: number) { return x; }\n".into()),
            "a1" => ObjectRead::Text(
                "export function apply(x: number, rate: number) { return x * rate; }\n".into(),
            ),
            _ => ObjectRead::Missing,
        };

        let c2 = build_card(&rev2_in, &read, &stat_small);
        assert_eq!(c2.rev, 2);
        assert_eq!(c2.card_id, c1.card_id);
        assert_eq!(c2.blocks.len(), 1);
        assert_ne!(c2.blocks[0].labels, vec![Label::NotCaptured {}]);
        assert_eq!(c2.importance, Importance::High);
        assert_eq!(c2.coverage.state, CoverageState::Full);
        assert!(c2.coverage.reasons.is_empty());
    }

    #[test]
    fn unconsented_repo_path_only_no_code() {
        let mut input = base_input(base_turn(vec![edit_win(
            "e-1",
            "sess-1",
            repo_join("src/secret.ts"),
            2_000,
            Some(2_300),
            Some(true),
        )]));
        input.recorded = false;
        input.versions = vec![ver("src/secret.ts", 2_400, Some("s1"), Some("s2"))];
        input.quotes.quotes.insert(
            "e-1".to_string(),
            TranscriptQuote {
                text: "Updated src/secret.ts".to_string(),
                shared: false,
            },
        );

        let io_called = RefCell::new(false);
        let read = |_sha: &str| {
            *io_called.borrow_mut() = true;
            ObjectRead::Text("secret".into())
        };
        let stat = |_path: &str| {
            *io_called.borrow_mut() = true;
            Some(500)
        };

        let card = build_card(&input, &read, &stat);
        assert!(!*io_called.borrow());
        assert_eq!(card.blocks.len(), 1);
        assert_eq!(card.outside_count, 0);
        let blk = &card.blocks[0];
        assert_eq!(blk.path, "src/secret.ts");
        assert!(!blk.recorded);
        assert!(blk.symbol.is_none());
        assert!(blk.labels.is_empty());
        assert!(blk.before.is_none());
        assert!(blk.after.is_none());
        assert_eq!(
            blk.quote.as_ref().map(|q| q.text.as_str()),
            Some("Updated src/secret.ts")
        );
        assert_eq!(blk.importance, Importance::None);
    }

    #[test]
    fn two_sessions_same_file_no_cross_attribution() {
        let mut input = base_input(base_turn(vec![edit_win(
            "e-a",
            "sess-A",
            repo_join("src/shared.ts"),
            2_000,
            Some(2_200),
            Some(true),
        )]));
        input.turn.agent = main_agent("sess-A");
        input.results = vec![CaptureResult {
            root: test_root().to_string(),
            started_ms: 2_300,
            at_ms: 2_500,
            coverage: "ok".to_string(),
        }];
        input.other_bash = vec![bash_win(
            "b-other",
            main_agent("sess-B"),
            "node gen.js",
            3_000,
            Some(5_000),
            Some(true),
        )];
        input.versions = vec![
            ver("src/shared.ts", 2_400, Some("sha-1"), Some("sha-2")),
            ver("src/shared.ts", 4_000, Some("sha-2"), Some("sha-3")),
        ];

        let read = |sha: &str| match sha {
            "sha-1" => ObjectRead::Text("export const v = 1;\n".into()),
            "sha-2" => ObjectRead::Text("export const v = 2;\n".into()),
            "sha-3" => ObjectRead::Text("export const v = 3;\n".into()),
            _ => ObjectRead::Missing,
        };

        let card = build_card(&input, &read, &no_stat);
        assert_eq!(card.blocks.len(), 1);
        assert_eq!(card.blocks[0].tool_use_ids, vec!["e-a".to_string()]);
        assert_eq!(card.blocks[0].after.as_deref(), Some("sha-2"));
        assert_eq!(card.outside_count, 1);
    }

    #[test]
    fn flow_order_and_durations() {
        let other_win = ToolWindow {
            tool_use_id: "read-1".to_string(),
            agent: main_agent("sess-1"),
            kind: ToolKind::Other,
            tool: "Read".to_string(),
            target_path: Some(repo_join("src/cart.ts")),
            command: None,
            pre_ms: 1_500,
            post_ms: Some(1_600),
            ok: Some(true),
        };
        let mut input = base_input(base_turn(vec![
            bash_win(
                "b-2",
                main_agent("sess-1"),
                "npm test",
                5_000,
                Some(13_000),
                Some(false),
            ),
            other_win,
            edit_win(
                "e-1",
                "sess-1",
                repo_join("src/cart.ts"),
                2_000,
                Some(2_400),
                Some(true),
            ),
        ]));
        input.results = vec![CaptureResult {
            root: test_root().to_string(),
            started_ms: 2_500,
            at_ms: 2_700,
            coverage: "ok".to_string(),
        }];
        input.versions = vec![ver("src/cart.ts", 2_600, Some("b1"), Some("a1"))];
        let read = |sha: &str| match sha {
            "b1" => ObjectRead::Text("export function calc(x: number) { return x; }\n".into()),
            "a1" => ObjectRead::Text("export function calc(x: number) { return x + 1; }\n".into()),
            _ => ObjectRead::Missing,
        };

        let card = build_card(&input, &read, &no_stat);
        assert_eq!(card.flow.len(), 2);
        assert_eq!(card.flow[0].kind, FlowKind::Edit);
        assert_eq!(card.flow[0].text, "src/cart.ts \u{203a} calc");
        assert!(card.flow[0].ok);
        assert_eq!(card.flow[0].dur_ms, 400);
        assert_eq!(card.flow[0].seqs, vec![1]);

        assert_eq!(card.flow[1].kind, FlowKind::Cmd);
        assert_eq!(card.flow[1].text, "npm test");
        assert!(!card.flow[1].ok);
        assert_eq!(card.flow[1].dur_ms, 8_000);
        assert!(card.flow[1].seqs.is_empty());
    }

    #[test]
    fn coverage_reasons_each() {
        let mut gap_in = base_input(base_turn(Vec::new()));
        gap_in.gaps = vec![(15_000, 25_000)];
        let c_gap = build_card(&gap_in, &no_read, &no_stat);
        assert_eq!(c_gap.coverage.state, CoverageState::Partial);
        assert_eq!(c_gap.coverage.reasons, vec![CoverageReason::DaemonGap]);

        let late_in = base_input(base_turn(vec![edit_win(
            "e-1",
            "sess-1",
            repo_join("src/late.ts"),
            2_000,
            Some(2_100),
            Some(true),
        )]));
        let c_late = build_card(&late_in, &no_read, &|_| Some(64));
        assert_eq!(c_late.coverage.reasons, vec![CoverageReason::CaptureLate]);

        for st in [CaptureState::Failed, CaptureState::Polling] {
            let mut off_in = base_input(base_turn(Vec::new()));
            off_in.capture_state = Some(st);
            let c_off = build_card(&off_in, &no_read, &no_stat);
            assert_eq!(c_off.coverage.reasons, vec![CoverageReason::CaptureOff]);
        }

        let mut big_in = base_input(base_turn(vec![edit_win(
            "e-big",
            "sess-1",
            repo_join("src/big.bin"),
            2_000,
            Some(2_100),
            Some(true),
        )]));
        big_in.results = vec![CaptureResult {
            root: test_root().to_string(),
            started_ms: 2_200,
            at_ms: 2_300,
            coverage: "ok".to_string(),
        }];
        let c_big = build_card(&big_in, &no_read, &|_| Some(2_000_000));
        assert_eq!(c_big.coverage.reasons, vec![CoverageReason::TooLarge]);

        let mut tr_in = base_input(base_turn(Vec::new()));
        tr_in.quotes.complete = false;
        let c_tr = build_card(&tr_in, &no_read, &no_stat);
        assert_eq!(
            c_tr.coverage.reasons,
            vec![CoverageReason::TranscriptUnreadable]
        );

        let mut unc_in = base_input(base_turn(Vec::new()));
        unc_in.turn.status = TurnEnd::Unclosed;
        let c_unc = build_card(&unc_in, &no_read, &no_stat);
        assert_eq!(c_unc.coverage.reasons, vec![CoverageReason::TurnUnclosed]);
    }

    #[test]
    fn card_json_shape() {
        let mut turn = base_turn(vec![
            edit_win(
                "e-1",
                "sess-1",
                repo_join("src/cart.ts"),
                2_000,
                Some(2_300),
                Some(true),
            ),
            bash_win(
                "b-1",
                main_agent("sess-1"),
                "npm test",
                3_000,
                Some(11_000),
                Some(true),
            ),
        ]);
        turn.agent_type = String::new();
        let mut input = base_input(turn);
        input.results = vec![CaptureResult {
            root: test_root().to_string(),
            started_ms: 2_400,
            at_ms: 2_600,
            coverage: "ok".to_string(),
        }];
        input.versions = vec![ver("src/cart.ts", 2_500, Some("s1"), Some("s2"))];
        input.quotes.quotes.insert(
            "e-1".to_string(),
            TranscriptQuote {
                text: "Added discount helper.".to_string(),
                shared: false,
            },
        );
        let read = |sha: &str| match sha {
            "s1" => ObjectRead::Text("export function helper() { return 1; }\n".into()),
            "s2" => ObjectRead::Text(
                "export function helper() { return 1; }\n\
                 export function applyDiscount(x: number) { return x * 0.8; }\n"
                    .into(),
            ),
            _ => ObjectRead::Missing,
        };

        let card = build_card(&input, &read, &no_stat);
        let json: serde_json::Value = serde_json::to_value(&card).expect("serialize card");
        let obj = json.as_object().expect("card is JSON object");

        for key in [
            "v",
            "card_id",
            "rev",
            "repo_id",
            "root",
            "main_root",
            "branch",
            "session_id",
            "agent_id",
            "agent_type",
            "parent_card_id",
            "started_ms",
            "ended_ms",
            "status",
            "prompt",
            "prompt_truncated",
            "importance",
            "blocks",
            "more_count",
            "flow",
            "flow_more",
            "outside_count",
            "coverage",
        ] {
            assert!(obj.contains_key(key), "missing top-level key {key}");
        }
        assert_eq!(obj.len(), 23);
        assert_eq!(obj["v"], 1);
        assert_eq!(obj["status"], "done");
        assert_eq!(obj["importance"], "medium");

        let blk = obj["blocks"][0].as_object().expect("block is object");
        for key in [
            "seq",
            "path",
            "symbol",
            "labels",
            "importance",
            "via",
            "tool_use_ids",
            "bash",
            "before",
            "after",
            "recorded",
            "line",
            "added",
            "removed",
            "quote",
        ] {
            assert!(blk.contains_key(key), "missing block key {key}");
        }
        assert!(!blk.contains_key("chip"));
        assert_eq!(blk.len(), 15);

        let sym = blk["symbol"].as_object().expect("symbol is object");
        for key in ["kind", "name", "container", "exported"] {
            assert!(sym.contains_key(key), "missing symbol key {key}");
        }
        assert_eq!(sym.len(), 4);

        let step = obj["flow"][0].as_object().expect("flow step is object");
        for key in ["kind", "text", "ok", "dur_ms", "seqs"] {
            assert!(step.contains_key(key), "missing flow key {key}");
        }
        assert_eq!(step.len(), 5);

        let cov = obj["coverage"].as_object().expect("coverage is object");
        assert!(cov.contains_key("state"));
        assert!(cov.contains_key("reasons"));
        assert_eq!(cov.len(), 2);

        let roundtrip: Card = serde_json::from_value(json).expect("deserialize card");
        assert_eq!(roundtrip, card);

        let mut sub_in = input;
        sub_in.session_root = None;
        sub_in.turn.repo.root = None;
        sub_in.turn.repo.main_root = None;
        sub_in.turn.repo.branch = None;
        sub_in.turn.agent = sub_agent("sess-1", "worker-1");
        sub_in.turn.agent_type = "Explore".to_string();
        sub_in.turn.parent = Some(main_agent("sess-1"));
        sub_in.turn.windows = vec![edit_win(
            "e-sub",
            "sess-1",
            home_join("scratch/tmp.txt"),
            2_000,
            Some(2_100),
            Some(true),
        )];
        sub_in.quotes.first_user_text = Some(("Inspect auth token handling".to_string(), false));
        sub_in.quotes.quotes.insert(
            "e-sub".to_string(),
            TranscriptQuote {
                text: "z".repeat(600),
                shared: true,
            },
        );
        let sub_card = build_card(&sub_in, &no_read, &no_stat);
        assert_eq!(sub_card.repo_id, "_none");
        assert_eq!(sub_card.root, "");
        assert!(sub_card.main_root.is_none());
        assert!(sub_card.branch.is_none());
        assert_eq!(sub_card.agent_type, "Explore");
        assert_eq!(sub_card.prompt, "Inspect auth token handling");
        assert_eq!(sub_card.blocks.len(), 1);
        assert_eq!(
            sub_card.blocks[0]
                .quote
                .as_ref()
                .map(|q| q.text.chars().count()),
            Some(500)
        );
    }

    #[test]
    fn attribution_edge_cases() {
        // 1. CaptureResult at exact cap boundary is not CaptureLate.
        let win = edit_win(
            "e1",
            "sess-1",
            repo_join("src/a.ts"),
            2_000,
            Some(2_500),
            Some(true),
        );
        let results = vec![CaptureResult {
            root: test_root().to_string(),
            started_ms: 2_500,
            at_ms: 32_500,
            coverage: "ok".to_string(),
        }];
        let root_cmp = canonical_path(test_root(), cfg!(windows));
        assert_eq!(
            compute_window_end(&win, Some(20_000), Some(&root_cmp), &results),
            (32_500, false)
        );
        let mut cap_input = base_input(base_turn(vec![win]));
        cap_input.results = results;
        let cap_card = build_card(&cap_input, &no_read, &no_stat);
        assert!(
            !cap_card
                .coverage
                .reasons
                .contains(&CoverageReason::CaptureLate)
        );

        // 2. Main agent forces agent_type to empty even if Turn carried one.
        let mut main_turn = base_turn(Vec::new());
        main_turn.agent_type = "Explore".to_string();
        let main_card = build_card(&base_input(main_turn), &no_read, &no_stat);
        assert_eq!(main_card.agent_type, "");

        // 3. Verbatim Windows prefixes strip cleanly and bare drive-relative paths fail.
        assert!(AbsPath::parse_abs("C:").is_none());
        assert!(AbsPath::parse_abs(r"C:rel\a.ts").is_none());
        let verbatim = AbsPath::parse_abs(r"\\?\C:\work\repo\src\a.ts").expect("verbatim abs");
        let win_root = AbsPath::parse_abs(r"C:\work\repo").expect("win root");
        assert_eq!(
            verbatim.strip_prefix(&win_root),
            Some(vec!["src".to_string(), "a.ts".to_string()])
        );
        let unc = AbsPath::parse_abs(r"\\?\UNC\server\share\repo\src\a.ts").expect("verbatim unc");
        let unc_root = AbsPath::parse_abs(r"\\server\share\repo").expect("unc root");
        assert_eq!(
            unc.strip_prefix(&unc_root),
            Some(vec!["src".to_string(), "a.ts".to_string()])
        );

        // 4. Overlapping bash windows from other agents are counted even on id collision.
        let bw = bash_win(
            "bash-1",
            main_agent("sess-1"),
            "echo hi",
            2_000,
            Some(5_000),
            Some(true),
        );
        let mut bash_input = base_input(base_turn(vec![bw]));
        bash_input.other_bash = vec![bash_win(
            "bash-1",
            sub_agent("sess-1", "sub-9"),
            "echo other",
            3_000,
            Some(6_000),
            Some(true),
        )];
        bash_input.versions = vec![ver("src/shared.ts", 4_000, Some("prev"), Some("after"))];
        bash_input.results = vec![
            CaptureResult {
                root: test_root().to_string(),
                started_ms: 5_000,
                at_ms: 5_100,
                coverage: "ok".to_string(),
            },
            CaptureResult {
                root: test_root().to_string(),
                started_ms: 6_000,
                at_ms: 6_100,
                coverage: "ok".to_string(),
            },
        ];
        let bash_read = |sha: &str| match sha {
            "prev" => ObjectRead::Text("export function a() { return 1; }\n".into()),
            "after" => ObjectRead::Text("export function a() { return 2; }\n".into()),
            _ => ObjectRead::Missing,
        };
        let bash_card = build_card(&bash_input, &bash_read, &no_stat);
        assert_eq!(bash_card.blocks.len(), 1);
        assert_eq!(
            bash_card.blocks[0].bash.as_ref().map(|b| b.candidates),
            Some(2)
        );
    }

    #[test]
    fn bash_group_excludes_interleaved_direct_edit() {
        let mut input = base_input(base_turn(vec![
            bash_win(
                "bash-1",
                main_agent("sess-1"),
                "npm run build",
                2_000,
                Some(6_000),
                Some(true),
            ),
            edit_win(
                "edit-1",
                "sess-1",
                repo_join("src/mod.ts"),
                3_000,
                Some(3_400),
                Some(true),
            ),
        ]));
        input.results = vec![
            CaptureResult {
                root: test_root().to_string(),
                started_ms: 3_500,
                at_ms: 3_600,
                coverage: "ok".to_string(),
            },
            CaptureResult {
                root: test_root().to_string(),
                started_ms: 6_100,
                at_ms: 6_300,
                coverage: "ok".to_string(),
            },
        ];
        input.versions = vec![
            ver("src/mod.ts", 2_500, Some("sha-a"), Some("sha-b")),
            ver("src/mod.ts", 3_200, Some("sha-b"), Some("sha-c")),
            ver("src/mod.ts", 4_500, Some("sha-c"), Some("sha-d")),
        ];

        let read = |sha: &str| match sha {
            "sha-a" => ObjectRead::Text(
                "export function keep(x: number) { return x; }\n\
                 export function helper() { return 1; }\n"
                    .into(),
            ),
            "sha-b" => ObjectRead::Text(
                "export function keep(x: number) { return x + 1; }\n\
                 export function helper() { return 1; }\n"
                    .into(),
            ),
            "sha-c" => {
                ObjectRead::Text("export function keep(x: number) { return x + 1; }\n".into())
            }
            "sha-d" => ObjectRead::Text(
                "export function keep(x: number) { return x + 1; }\n\
                 export function addedByBash() { return 2; }\n"
                    .into(),
            ),
            _ => ObjectRead::Missing,
        };

        let card = build_card(&input, &read, &no_stat);
        assert_eq!(card.blocks.len(), 2);

        let bash_blk = card
            .blocks
            .iter()
            .find(|b| b.via == BlockVia::Bash)
            .expect("bash block");
        assert!(!bash_blk.labels.contains(&Label::SymbolRemoved {}));
        assert!(bash_blk.labels.contains(&Label::SymbolAdded {}));
        assert!(bash_blk.labels.contains(&Label::ReturnChanged {}));
        assert_eq!(bash_blk.importance, Importance::Medium);
        assert!(bash_blk.before.is_none());
        assert!(bash_blk.after.is_none());

        let direct_blk = card
            .blocks
            .iter()
            .find(|b| b.via == BlockVia::Edit)
            .expect("direct edit block");
        assert_eq!(direct_blk.tool_use_ids, vec!["edit-1".to_string()]);
        assert_eq!(direct_blk.labels, vec![Label::SymbolRemoved {}]);
        assert_eq!(
            direct_blk.symbol.as_ref().map(|s| s.name.as_str()),
            Some("helper")
        );
        assert_eq!(direct_blk.before.as_deref(), Some("sha-b"));
        assert_eq!(direct_blk.after.as_deref(), Some("sha-c"));
    }

    #[test]
    fn bash_group_preserves_reverted_changes() {
        let mut input = base_input(base_turn(vec![bash_win(
            "bash-1",
            main_agent("sess-1"),
            "scripts/toggle.sh",
            2_000,
            Some(6_000),
            Some(true),
        )]));
        input.results = vec![CaptureResult {
            root: test_root().to_string(),
            started_ms: 6_100,
            at_ms: 6_300,
            coverage: "ok".to_string(),
        }];
        input.versions = vec![
            ver("src/mod.ts", 3_000, Some("sha-a"), Some("sha-b")),
            ver("src/mod.ts", 4_000, Some("sha-b"), Some("sha-a")),
        ];

        let read = |sha: &str| match sha {
            "sha-a" => ObjectRead::Text("export function base() { return 1; }\n".into()),
            "sha-b" => ObjectRead::Text(
                "export function base() { return 1; }\n\
                 export function temp() { return 2; }\n"
                    .into(),
            ),
            _ => ObjectRead::Missing,
        };

        let card = build_card(&input, &read, &no_stat);
        assert_eq!(card.blocks.len(), 1);
        let blk = &card.blocks[0];
        assert_eq!(blk.via, BlockVia::Bash);
        assert_eq!(
            blk.bash,
            Some(rocky_proto::cards::BashInfo {
                cmd: "scripts/toggle.sh".to_string(),
                candidates: 1,
            })
        );
        assert!(blk.labels.contains(&Label::SymbolAdded {}));
        assert!(blk.labels.contains(&Label::SymbolRemoved {}));
        assert!(blk.before.is_none());
        assert!(blk.after.is_none());
    }

    #[test]
    fn subagent_keeps_parent_card_id_and_main_stays_none() {
        let mut main_1_turn = base_turn(Vec::new());
        main_1_turn.started_ms = 1_000;
        main_1_turn.ended_ms = Some(5_000);
        let mut main_1_in = base_input(main_1_turn);
        main_1_in.card_id = "card-main-1".to_string();
        main_1_in.parent_card_id = Some("ignored-parent".to_string());
        let main_1_card = build_card(&main_1_in, &no_read, &no_stat);
        assert_eq!(main_1_card.parent_card_id, None);

        let mut main_2_turn = base_turn(Vec::new());
        main_2_turn.started_ms = 6_000;
        main_2_turn.ended_ms = Some(10_000);
        let mut main_2_in = base_input(main_2_turn);
        main_2_in.card_id = "card-main-2".to_string();
        let main_2_card = build_card(&main_2_in, &no_read, &no_stat);
        assert_eq!(main_2_card.parent_card_id, None);

        let mut sub_turn = base_turn(Vec::new());
        sub_turn.agent = sub_agent("sess-1", "worker-1");
        sub_turn.agent_type = "Explore".to_string();
        sub_turn.parent = Some(main_agent("sess-1"));
        sub_turn.started_ms = 7_000;
        sub_turn.ended_ms = Some(9_000);
        let mut sub_in = base_input(sub_turn);
        sub_in.card_id = "card-sub-1".to_string();
        sub_in.parent_card_id = Some(main_2_card.card_id.clone());
        let sub_card = build_card(&sub_in, &no_read, &no_stat);
        assert_eq!(sub_card.parent_card_id.as_deref(), Some("card-main-2"));
        assert_eq!(sub_card.agent_type, "Explore");
    }

    #[test]
    fn store_error_suppresses_versions_and_tail_cut_marks_capture_late() {
        let turn = base_turn(vec![edit_win(
            "e-1",
            "sess-1",
            repo_join("src/a.ts"),
            2_000,
            Some(2_200),
            Some(true),
        )]);
        let read = |sha: &str| match sha {
            "b1" => ObjectRead::Text("export const a = 1;\n".into()),
            "a1" => ObjectRead::Text("export const a = 2;\n".into()),
            _ => ObjectRead::Missing,
        };

        let mut err_in = base_input(turn.clone());
        err_in.versions = vec![ver("src/a.ts", 2_100, Some("b1"), Some("a1"))];
        err_in.store_error = true;
        let err_card = build_card(&err_in, &read, &no_stat);
        assert_eq!(err_card.coverage.state, CoverageState::Partial);
        assert!(
            err_card
                .coverage
                .reasons
                .contains(&CoverageReason::CaptureOff)
        );
        assert_eq!(err_card.blocks.len(), 1);
        assert_eq!(err_card.blocks[0].labels, vec![Label::NotCaptured {}]);
        assert_eq!(err_card.blocks[0].before, None);
        assert_eq!(err_card.blocks[0].after, None);
        assert_eq!(err_card.blocks[0].symbol, None);

        let mut tail_in = base_input(turn);
        tail_in.versions = vec![ver("src/a.ts", 2_100, Some("b1"), Some("a1"))];
        tail_in.tail_cut = true;
        let tail_card = build_card(&tail_in, &read, &no_stat);
        assert_eq!(tail_card.coverage.state, CoverageState::Partial);
        assert!(
            tail_card
                .coverage
                .reasons
                .contains(&CoverageReason::CaptureLate)
        );
    }
}
