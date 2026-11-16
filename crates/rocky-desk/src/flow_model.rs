//! Pure model for the Flow view: which files each agent read and changed,
//! built only from the change cards the desk already holds.
//!
//! A lane is one agent (a session's main agent or one of its subagents). A
//! file node is one path in one repo. An edge says a lane read or changed a
//! file, with how many turns did so. Nothing here is inferred: reads come
//! from the card's Read-tool paths, changes from its blocks.

use std::collections::HashMap;

use rocky_proto::cards::{Card, CardStatus};

use crate::cards_model::{repo_name, sanitize_single_line};

/// Most lanes drawn; older agents beyond this are counted, not drawn.
pub const MAX_LANES: usize = 8;
/// Most file nodes drawn; the least-touched files beyond this are counted.
pub const MAX_FILES: usize = 14;

/// Identity of one agent across its turns.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct LaneKey {
    pub session_id: String,
    pub agent_id: String,
}

/// Identity of one file: repo label plus display path.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct FileKey {
    pub repo: String,
    pub path: String,
}

/// What an agent did to a file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum EdgeKind {
    Read,
    Change,
}

/// One agent row on the left.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Lane {
    pub key: LaneKey,
    /// Repo name for a main agent, agent type for a subagent.
    pub label: String,
    /// Short session id, so two sessions in one repo stay apart.
    pub short_id: String,
    /// Index of the main-agent lane this subagent branched from.
    pub parent: Option<usize>,
    /// The agent's latest turn is still open.
    pub working: bool,
    /// Latest card of this agent; clicking the lane opens it.
    pub latest_card: String,
    pub last_ms: u64,
}

/// One file row on the right.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileNode {
    pub key: FileKey,
    /// Path as shown: last two segments, with the repo when several repos show.
    pub label: String,
    /// Full display path for the tooltip.
    pub full: String,
    /// Distinct lanes that read the file.
    pub readers: u32,
    /// Distinct lanes that changed the file.
    pub changers: u32,
    /// Latest card that touched this file; clicking the row opens it.
    pub latest_card: String,
}

/// One lane-to-file link.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Edge {
    pub lane: usize,
    pub file: usize,
    pub kind: EdgeKind,
    /// Turns of this lane that touched the file this way.
    pub turns: u32,
}

/// Everything the Flow view draws.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FlowGraph {
    pub lanes: Vec<Lane>,
    pub files: Vec<FileNode>,
    pub edges: Vec<Edge>,
    /// Agents with activity that did not fit.
    pub hidden_lanes: usize,
    /// Files with activity that did not fit.
    pub hidden_files: usize,
    /// Turns the graph was built from.
    pub turns: usize,
}

impl FlowGraph {
    pub fn is_empty(&self) -> bool {
        self.edges.is_empty()
    }
}

struct LaneAcc {
    key: LaneKey,
    label: String,
    working: bool,
    latest_card: String,
    last_ms: u64,
}

struct FileAcc {
    key: FileKey,
    last_ms: u64,
    latest_card: String,
}

/// Builds the graph from cards. Order of `cards` does not matter. `working`
/// lists agents the live status shows working: a turn still open has no
/// card in the list yet, so its lane is marked from the status instead.
pub fn build(cards: &[Card], working: &[LaneKey]) -> FlowGraph {
    let mut lanes: HashMap<LaneKey, LaneAcc> = HashMap::new();
    let mut files: HashMap<FileKey, FileAcc> = HashMap::new();
    let mut edges: HashMap<(LaneKey, FileKey, EdgeKind), u32> = HashMap::new();
    let mut turns = 0usize;

    for card in cards {
        let repo = repo_name(card).unwrap_or_default();
        let lane_key = LaneKey {
            session_id: card.session_id.clone(),
            agent_id: card.agent_id.clone(),
        };
        let at = card.ended_ms.unwrap_or(card.started_ms);
        let mut touched: Vec<(FileKey, EdgeKind)> = Vec::new();
        for block in &card.blocks {
            touched.push((file_key(&repo, &block.path), EdgeKind::Change));
        }
        for path in &card.reads {
            touched.push((file_key(&repo, path), EdgeKind::Read));
        }
        touched.retain(|(k, _)| !k.path.is_empty());
        touched.sort();
        touched.dedup();
        let working = card.status == CardStatus::Open;
        if touched.is_empty() && !working {
            continue;
        }
        turns += 1;

        let lane = lanes.entry(lane_key.clone()).or_insert_with(|| LaneAcc {
            key: lane_key.clone(),
            label: lane_label(card, &repo),
            working: false,
            latest_card: card.card_id.clone(),
            last_ms: 0,
        });
        if at >= lane.last_ms {
            lane.last_ms = at;
            lane.latest_card = card.card_id.clone();
            lane.working = working;
        }

        for (fk, kind) in touched {
            let file = files.entry(fk.clone()).or_insert_with(|| FileAcc {
                key: fk.clone(),
                last_ms: 0,
                latest_card: card.card_id.clone(),
            });
            if at >= file.last_ms {
                file.last_ms = at;
                file.latest_card = card.card_id.clone();
            }
            *edges.entry((lane_key.clone(), fk, kind)).or_default() += 1;
        }
    }

    let (mut lane_order, hidden_lanes) = order_lanes(lanes.into_values().collect());
    for lane in lane_order.iter_mut() {
        lane.working |= working.contains(&lane.key);
    }
    let lane_index: HashMap<LaneKey, usize> = lane_order
        .iter()
        .enumerate()
        .map(|(i, l)| (l.key.clone(), i))
        .collect();

    // Score files only by edges of drawn lanes; a change weighs more than a read.
    let mut score: HashMap<FileKey, u32> = HashMap::new();
    for ((lk, fk, kind), n) in &edges {
        if lane_index.contains_key(lk) {
            let w = match kind {
                EdgeKind::Change => 3,
                EdgeKind::Read => 1,
            };
            *score.entry(fk.clone()).or_default() += w * n;
        }
    }
    let mut ranked: Vec<FileAcc> = files
        .into_values()
        .filter(|f| score.contains_key(&f.key))
        .collect();
    ranked.sort_by(|a, b| {
        score[&b.key]
            .cmp(&score[&a.key])
            .then(b.last_ms.cmp(&a.last_ms))
            .then(a.key.cmp(&b.key))
    });
    let hidden_files = ranked.len().saturating_sub(MAX_FILES);
    let ranked = keep_files(ranked, &edges, &lane_order);

    // Barycenter order: each file sits near the lanes that touch it, so
    // strands cross less. Ties keep the rank order.
    let mut placed: Vec<(f32, usize, FileAcc)> = ranked
        .into_iter()
        .enumerate()
        .map(|(rank, f)| {
            let (sum, n) = edges
                .keys()
                .filter(|(_, fk, _)| fk == &f.key)
                .filter_map(|(lk, _, _)| lane_index.get(lk))
                .fold((0usize, 0usize), |(s, n), i| (s + i, n + 1));
            let center = if n == 0 { 0.0 } else { sum as f32 / n as f32 };
            (center, rank, f)
        })
        .collect();
    placed.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));

    let multi_repo = {
        let mut repos: Vec<&str> = placed.iter().map(|(_, _, f)| f.key.repo.as_str()).collect();
        repos.sort_unstable();
        repos.dedup();
        repos.len() > 1
    };
    let file_index: HashMap<FileKey, usize> = placed
        .iter()
        .enumerate()
        .map(|(i, (_, _, f))| (f.key.clone(), i))
        .collect();

    let mut out_edges: Vec<Edge> = edges
        .iter()
        .filter_map(|((lk, fk, kind), n)| {
            Some(Edge {
                lane: *lane_index.get(lk)?,
                file: *file_index.get(fk)?,
                kind: *kind,
                turns: *n,
            })
        })
        .collect();
    out_edges.sort_by_key(|e| (e.lane, e.file, e.kind));

    let file_nodes: Vec<FileNode> = placed
        .into_iter()
        .map(|(_, _, f)| {
            let readers = count_lanes(&out_edges, file_index[&f.key], EdgeKind::Read);
            let changers = count_lanes(&out_edges, file_index[&f.key], EdgeKind::Change);
            let short = short_path(&f.key.path);
            let (label, full) = if multi_repo && !f.key.repo.is_empty() {
                (
                    format!("{} \u{203a} {short}", f.key.repo),
                    format!("{} \u{203a} {}", f.key.repo, f.key.path),
                )
            } else {
                (short, f.key.path.clone())
            };
            FileNode {
                key: f.key,
                label,
                full,
                readers,
                changers,
                latest_card: f.latest_card,
            }
        })
        .collect();

    FlowGraph {
        lanes: lane_order,
        files: file_nodes,
        edges: out_edges,
        hidden_lanes,
        hidden_files,
        turns,
    }
}

/// Keeps `MAX_FILES` of the ranked files. Each drawn lane first keeps its own
/// best-ranked file, so no agent shows without a strand; the rest go by rank.
fn keep_files(
    ranked: Vec<FileAcc>,
    edges: &HashMap<(LaneKey, FileKey, EdgeKind), u32>,
    lanes: &[Lane],
) -> Vec<FileAcc> {
    if ranked.len() <= MAX_FILES {
        return ranked;
    }
    let mut keep = vec![false; ranked.len()];
    let mut kept = 0usize;
    for lane in lanes {
        if kept == MAX_FILES {
            break;
        }
        let best = ranked.iter().position(|f| {
            edges
                .keys()
                .any(|(lk, fk, _)| lk == &lane.key && fk == &f.key)
        });
        if let Some(i) = best
            && !keep[i]
        {
            keep[i] = true;
            kept += 1;
        }
    }
    for flag in keep.iter_mut() {
        if kept == MAX_FILES {
            break;
        }
        if !*flag {
            *flag = true;
            kept += 1;
        }
    }
    ranked
        .into_iter()
        .zip(keep)
        .filter_map(|(f, k)| k.then_some(f))
        .collect()
}

fn count_lanes(edges: &[Edge], file: usize, kind: EdgeKind) -> u32 {
    let n = edges
        .iter()
        .filter(|e| e.file == file && e.kind == kind)
        .count();
    u32::try_from(n).unwrap_or(u32::MAX)
}

fn file_key(repo: &str, path: &str) -> FileKey {
    FileKey {
        repo: repo.to_string(),
        path: sanitize_single_line(path).replace('\\', "/"),
    }
}

/// Empty for a main agent outside any repo: the view names it in the UI
/// language.
fn lane_label(card: &Card, repo: &str) -> String {
    if card.agent_id.is_empty() {
        repo.to_string()
    } else {
        let kind = sanitize_single_line(&card.agent_type);
        let kind = kind.trim();
        if kind.is_empty() {
            "subagent".to_string()
        } else {
            kind.to_string()
        }
    }
}

/// Main agents newest first, each followed by its subagents newest first.
/// Subagents whose main agent has no card become their own top-level lane.
fn order_lanes(all: Vec<LaneAcc>) -> (Vec<Lane>, usize) {
    let total = all.len();
    let mut mains: Vec<LaneAcc> = Vec::new();
    let mut subs: Vec<LaneAcc> = Vec::new();
    for l in all {
        if l.key.agent_id.is_empty() {
            mains.push(l);
        } else {
            subs.push(l);
        }
    }
    let main_sessions: Vec<String> = mains.iter().map(|m| m.key.session_id.clone()).collect();
    let (attached, orphans): (Vec<LaneAcc>, Vec<LaneAcc>) = subs
        .into_iter()
        .partition(|s| main_sessions.contains(&s.key.session_id));
    mains.extend(orphans);
    let newest_first = |a: &LaneAcc, b: &LaneAcc| b.last_ms.cmp(&a.last_ms).then(a.key.cmp(&b.key));
    mains.sort_by(newest_first);
    let mut attached = attached;
    attached.sort_by(newest_first);

    let mut out: Vec<Lane> = Vec::new();
    for m in mains {
        if out.len() >= MAX_LANES {
            break;
        }
        let parent_idx = out.len();
        let is_main = m.key.agent_id.is_empty();
        let session = m.key.session_id.clone();
        out.push(to_lane(m, None));
        if !is_main {
            continue;
        }
        for s in attached.iter().filter(|s| s.key.session_id == session) {
            if out.len() >= MAX_LANES {
                break;
            }
            out.push(to_lane_ref(s, Some(parent_idx)));
        }
    }
    let hidden = total.saturating_sub(out.len());
    (out, hidden)
}

fn to_lane(l: LaneAcc, parent: Option<usize>) -> Lane {
    to_lane_ref(&l, parent)
}

fn to_lane_ref(l: &LaneAcc, parent: Option<usize>) -> Lane {
    Lane {
        key: l.key.clone(),
        label: l.label.clone(),
        short_id: l.key.session_id.chars().take(6).collect(),
        parent,
        working: l.working,
        latest_card: l.latest_card.clone(),
        last_ms: l.last_ms,
    }
}

/// Last two path segments, so the file name always shows.
fn short_path(path: &str) -> String {
    let segs: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    if segs.len() <= 2 {
        segs.join("/")
    } else {
        format!("\u{2026}/{}", segs[segs.len() - 2..].join("/"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rocky_proto::cards::{Block, BlockVia, Coverage, CoverageState, Importance};

    fn block(path: &str) -> Block {
        Block {
            seq: 1,
            path: path.to_string(),
            symbol: None,
            labels: Vec::new(),
            importance: Importance::None,
            via: BlockVia::Edit,
            tool_use_ids: Vec::new(),
            bash: None,
            before: None,
            after: None,
            recorded: true,
            line: None,
            added: None,
            removed: None,
            quote: None,
        }
    }

    fn card(
        id: &str,
        session: &str,
        agent: &str,
        at: u64,
        changed: &[&str],
        read: &[&str],
    ) -> Card {
        Card {
            v: 1,
            card_id: id.to_string(),
            rev: 1,
            repo_id: "r".to_string(),
            root: "C:/work/rocky".to_string(),
            main_root: None,
            branch: None,
            session_id: session.to_string(),
            agent_id: agent.to_string(),
            agent_type: if agent.is_empty() {
                String::new()
            } else {
                "Explore".to_string()
            },
            parent_card_id: None,
            started_ms: at,
            ended_ms: Some(at),
            status: CardStatus::Done,
            prompt: String::new(),
            prompt_truncated: false,
            importance: Importance::None,
            blocks: changed.iter().map(|p| block(p)).collect(),
            more_count: 0,
            flow: Vec::new(),
            flow_more: 0,
            outside_count: 0,
            coverage: Coverage {
                state: CoverageState::Full,
                reasons: Vec::new(),
            },
            reads: read.iter().map(|p| p.to_string()).collect(),
            reads_more: 0,
        }
    }

    #[test]
    fn empty_cards_make_empty_graph() {
        let g = build(&[], &[]);
        assert!(g.is_empty());
        assert_eq!(g.turns, 0);
    }

    #[test]
    fn reads_and_changes_become_separate_edges() {
        let g = build(
            &[card(
                "c1",
                "s1",
                "",
                10,
                &["src/a.ts"],
                &["src/a.ts", "src/b.ts"],
            )],
            &[],
        );
        assert_eq!(g.lanes.len(), 1);
        assert_eq!(g.lanes[0].label, "rocky");
        assert_eq!(g.files.len(), 2);
        let kinds: Vec<EdgeKind> = g.edges.iter().map(|e| e.kind).collect();
        assert_eq!(kinds.iter().filter(|k| **k == EdgeKind::Change).count(), 1);
        assert_eq!(kinds.iter().filter(|k| **k == EdgeKind::Read).count(), 2);
        let a = g.files.iter().find(|f| f.key.path == "src/a.ts").unwrap();
        assert_eq!((a.readers, a.changers), (1, 1));
    }

    #[test]
    fn turns_of_one_agent_add_up_on_one_edge() {
        let g = build(
            &[
                card("c1", "s1", "", 10, &["src/a.ts"], &[]),
                card("c2", "s1", "", 20, &["src/a.ts"], &[]),
            ],
            &[],
        );
        assert_eq!(g.lanes.len(), 1);
        assert_eq!(g.lanes[0].latest_card, "c2");
        assert_eq!(g.edges.len(), 1);
        assert_eq!(g.edges[0].turns, 2);
        assert_eq!(g.files[0].latest_card, "c2");
    }

    #[test]
    fn subagent_lane_branches_from_its_main_agent() {
        let g = build(
            &[
                card("c1", "s1", "", 30, &["src/a.ts"], &[]),
                card("c2", "s1", "ag1", 20, &[], &["src/b.ts"]),
                card("c3", "s2", "", 40, &["src/c.ts"], &[]),
            ],
            &[],
        );
        let labels: Vec<(&str, Option<usize>)> = g
            .lanes
            .iter()
            .map(|l| (l.label.as_str(), l.parent))
            .collect();
        // s2 is newest, then s1 with its Explore subagent under it.
        assert_eq!(
            labels,
            vec![("rocky", None), ("rocky", None), ("Explore", Some(1))]
        );
        assert_eq!(g.lanes[0].key.session_id, "s2");
    }

    #[test]
    fn orphan_subagent_stands_alone() {
        let g = build(&[card("c2", "s1", "ag1", 20, &["src/b.ts"], &[])], &[]);
        assert_eq!(g.lanes.len(), 1);
        assert_eq!(g.lanes[0].parent, None);
        assert_eq!(g.lanes[0].label, "Explore");
    }

    #[test]
    fn every_drawn_lane_keeps_a_file_when_files_overflow() {
        // s1 changes many files and outranks s2's single read; s2 still
        // keeps that read so its lane is not left without a strand.
        let many: Vec<String> = (0..MAX_FILES + 4).map(|i| format!("a/{i}.ts")).collect();
        let many_refs: Vec<&str> = many.iter().map(String::as_str).collect();
        let g = build(
            &[
                card("c1", "s1", "", 20, &many_refs, &[]),
                card("c2", "s2", "", 10, &[], &["b/only.ts"]),
            ],
            &[],
        );
        assert_eq!(g.files.len(), MAX_FILES);
        let s2 = g
            .lanes
            .iter()
            .position(|l| l.key.session_id == "s2")
            .unwrap();
        assert!(g.edges.iter().any(|e| e.lane == s2));
    }

    #[test]
    fn repo_less_main_agent_label_is_left_to_the_view() {
        let mut c = card("c1", "s1", "", 10, &["x.ts"], &[]);
        c.root = String::new();
        let g = build(&[c], &[]);
        assert_eq!(g.lanes[0].label, "");
    }

    #[test]
    fn idle_turn_without_files_is_skipped_but_open_turn_shows() {
        let mut open = card("c2", "s2", "", 20, &[], &[]);
        open.status = CardStatus::Open;
        open.ended_ms = None;
        let g = build(&[card("c1", "s1", "", 10, &[], &[]), open], &[]);
        assert_eq!(g.turns, 1);
        assert_eq!(g.lanes.len(), 1);
        assert!(g.lanes[0].working);
        assert!(g.is_empty());
    }

    #[test]
    fn files_capped_with_changes_ranked_over_reads() {
        let reads: Vec<String> = (0..MAX_FILES + 5).map(|i| format!("r/{i}.ts")).collect();
        let read_refs: Vec<&str> = reads.iter().map(String::as_str).collect();
        let g = build(
            &[card("c1", "s1", "", 10, &["z/changed.ts"], &read_refs)],
            &[],
        );
        assert_eq!(g.files.len(), MAX_FILES);
        assert_eq!(g.hidden_files, 6);
        assert!(g.files.iter().any(|f| f.key.path == "z/changed.ts"));
    }

    #[test]
    fn lanes_capped_and_counted() {
        let cards: Vec<Card> = (0..MAX_LANES + 2)
            .map(|i| {
                card(
                    &format!("c{i}"),
                    &format!("s{i}"),
                    "",
                    i as u64,
                    &["src/a.ts"],
                    &[],
                )
            })
            .collect();
        let g = build(&cards, &[]);
        assert_eq!(g.lanes.len(), MAX_LANES);
        assert_eq!(g.hidden_lanes, 2);
        // Newest sessions win the space.
        assert_eq!(g.lanes[0].key.session_id, format!("s{}", MAX_LANES + 1));
    }

    #[test]
    fn several_repos_prefix_file_labels() {
        let mut other = card("c2", "s2", "", 20, &["src/a.ts"], &[]);
        other.root = "C:/work/notes".to_string();
        let g = build(&[card("c1", "s1", "", 10, &["src/a.ts"], &[]), other], &[]);
        assert_eq!(g.files.len(), 2);
        assert!(g.files.iter().all(|f| f.label.contains(" \u{203a} ")));
    }

    #[test]
    fn short_path_keeps_file_name() {
        assert_eq!(short_path("a.ts"), "a.ts");
        assert_eq!(short_path("src/a.ts"), "src/a.ts");
        assert_eq!(short_path("crates/desk/src/a.rs"), "\u{2026}/src/a.rs");
    }

    #[test]
    fn files_sit_near_the_lanes_that_touch_them() {
        let g = build(
            &[
                card("c1", "s1", "", 30, &["top.ts"], &[]),
                card("c2", "s2", "", 20, &["bottom.ts"], &[]),
            ],
            &[],
        );
        assert_eq!(g.files[0].key.path, "top.ts");
        assert_eq!(g.files[1].key.path, "bottom.ts");
    }

    #[test]
    fn live_working_status_marks_the_lane() {
        let working = [LaneKey {
            session_id: "s1".to_string(),
            agent_id: String::new(),
        }];
        let cards = [
            card("c1", "s1", "", 10, &["a.ts"], &[]),
            card("c2", "s2", "", 20, &["b.ts"], &[]),
        ];
        let g = build(&cards, &working);
        let lit: Vec<(&str, bool)> = g
            .lanes
            .iter()
            .map(|l| (l.key.session_id.as_str(), l.working))
            .collect();
        assert_eq!(lit, vec![("s2", false), ("s1", true)]);
    }
}
