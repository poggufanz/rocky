//! Flow page: agents on the left, files on the right, one strand per turn
//! that read or changed a file. Strands bundle where several agents meet on
//! one file, so a busy file reads as a thick knot without any extra chrome.
//!
//! Encoding, kept to what the data says:
//! - thin grey strand: the agent read the file;
//! - heavier ink strand: the agent changed it;
//! - blue: the agent's turn is still open (the one accent, as in Now);
//! - more strands in a bundle: more turns did it (up to four drawn).

use gpui::prelude::*;
use gpui::{
    Bounds, Context, Div, FontWeight, Hsla, PathBuilder, Pixels, Point, SharedString, Window,
    canvas, div, point, px, relative, rgb,
};

use crate::cards_model::TooltipLine;
use crate::flow_model::{EdgeKind, FlowGraph};
use crate::i18n::{CardMsg, UiLang, card_text};
use crate::ui::cards_view::{CardAction, OnCardAction};
use crate::ui::motion;
use crate::ui::tooltip::{
    BORDER_SUBTLE, CARD_BG, LINK, ROW_HOVER_BG, TEXT_DARK, TEXT_MUTED, TEXT_SUBTLE, mono_font,
    tooltip_view,
};

const ROW_H: f32 = 30.0;
const PAD_Y: f32 = 14.0;
const MIN_ROWS: usize = 3;
/// Share of the panel width for agent labels; strands start at its edge.
const LEFT_FRAC: f32 = 0.30;
/// Share of the panel width for file labels; strands end at its edge.
const RIGHT_FRAC: f32 = 0.36;
const SUB_INDENT: f32 = 14.0;
const NODE: f32 = 8.0;
const MAX_STRANDS: u32 = 4;

/// Ink for changes: 9.8:1 on white, the strongest mark on the panel.
const STRAND_CHANGE: u32 = 0x44403C;
/// Grey for reads: 3.3:1 on white, the graphics minimum.
const STRAND_READ: u32 = 0x938C86;
/// Branch from a main agent to its subagent.
const STRAND_BRANCH: u32 = 0xB5AFA9;
/// Strands outside the hovered agent or file step back to this.
const STRAND_FADED: u32 = 0xE7E5E4;

/// Which row the pointer is over, to bring its strands forward.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FlowHover {
    Lane(usize),
    File(usize),
}

/// Called when the pointer enters (`true`) or leaves (`false`) a row.
pub type OnFlowHover<T> = fn(&mut T, FlowHover, bool, &mut Context<T>);

/// Renders the Flow page. `empty_copy` explains an empty graph: the cards
/// list's own empty message when there are no cards at all.
#[allow(clippy::too_many_arguments)]
pub fn flow_section<T: 'static>(
    lang: UiLang,
    graph: &FlowGraph,
    loading: bool,
    no_cards: Option<CardMsg>,
    hover: Option<FlowHover>,
    cx: &mut Context<T>,
    on_action: OnCardAction<T>,
    on_hover: OnFlowHover<T>,
) -> Div {
    let mut section = div().flex().flex_col().gap(px(10.0)).pt(px(4.0));

    if graph.lanes.is_empty() {
        let copy = if loading {
            CardMsg::Loading
        } else {
            no_cards.unwrap_or(CardMsg::FlowEmpty)
        };
        let note = div()
            .px(px(14.0))
            .py(px(18.0))
            .rounded(px(8.0))
            .bg(rgb(CARD_BG))
            .border_1()
            .border_color(rgb(BORDER_SUBTLE))
            .text_size(px(12.5))
            .text_color(rgb(TEXT_MUTED))
            .child(card_text(lang, &copy));
        let note = if loading {
            motion::pulse(note, SharedString::from("flow-loading")).into_any_element()
        } else {
            note.into_any_element()
        };
        return section.child(note);
    }

    section = section.child(header(lang, graph.turns));
    section = section.child(panel(graph, lang, hover, cx, on_action, on_hover));

    let mut more: Vec<String> = Vec::new();
    if graph.hidden_lanes > 0 {
        more.push(card_text(
            lang,
            &CardMsg::FlowMoreAgents {
                n: graph.hidden_lanes,
            },
        ));
    }
    if graph.hidden_files > 0 {
        more.push(card_text(
            lang,
            &CardMsg::FlowMoreFiles {
                n: graph.hidden_files,
            },
        ));
    }
    if !more.is_empty() {
        section = section.child(
            div()
                .px(px(2.0))
                .text_size(px(12.0))
                .text_color(rgb(TEXT_MUTED))
                .child(more.join(" \u{00b7} ")),
        );
    }
    section
}

fn header(lang: UiLang, turns: usize) -> Div {
    div()
        .flex()
        .flex_wrap()
        .items_center()
        .justify_between()
        .gap(px(8.0))
        .px(px(2.0))
        .child(
            div()
                .min_w_0()
                .text_size(px(12.5))
                .text_color(rgb(TEXT_SUBTLE))
                .child(card_text(lang, &CardMsg::FlowCaption { turns })),
        )
        .child(
            div()
                .flex()
                .flex_none()
                .items_center()
                .gap(px(12.0))
                .text_size(px(12.0))
                .text_color(rgb(TEXT_SUBTLE))
                .child(legend_item(
                    swatch_line(STRAND_READ, 1.0),
                    card_text(lang, &CardMsg::FlowLegendRead),
                ))
                .child(legend_item(
                    swatch_line(STRAND_CHANGE, 2.0),
                    card_text(lang, &CardMsg::FlowLegendChanged),
                ))
                .child(legend_item(
                    swatch_line(LINK, 2.0),
                    card_text(lang, &CardMsg::FlowLegendWorking),
                )),
        )
}

fn legend_item(swatch: Div, label: String) -> Div {
    div()
        .flex()
        .items_center()
        .gap(px(5.0))
        .child(swatch)
        .child(label)
}

fn swatch_line(color: u32, thickness: f32) -> Div {
    div().w(px(16.0)).h(px(thickness)).bg(rgb(color))
}

fn rows(graph: &FlowGraph) -> usize {
    graph.lanes.len().max(graph.files.len()).max(MIN_ROWS)
}

/// Center of row `i` when `count` rows are centered among `total`.
fn row_y(i: usize, count: usize, total: usize) -> f32 {
    let offset = (total - count) as f32 * ROW_H / 2.0;
    PAD_Y + offset + i as f32 * ROW_H + ROW_H / 2.0
}

fn panel<T: 'static>(
    graph: &FlowGraph,
    lang: UiLang,
    hover: Option<FlowHover>,
    cx: &mut Context<T>,
    on_action: OnCardAction<T>,
    on_hover: OnFlowHover<T>,
) -> Div {
    let total = rows(graph);
    let height = total as f32 * ROW_H + 2.0 * PAD_Y;
    let strands = strand_specs(graph, hover, total);

    let mut panel = div()
        .relative()
        .w_full()
        .h(px(height))
        .bg(rgb(CARD_BG))
        .border_1()
        .border_color(rgb(BORDER_SUBTLE))
        .rounded(px(8.0))
        .overflow_hidden()
        .child(
            canvas(
                move |_, _, _| (),
                move |bounds, (), window, _| paint_strands(bounds, &strands, window),
            )
            .absolute()
            .top_0()
            .left_0()
            .size_full(),
        );

    // Nodes go on after the labels so a label's hover fill never covers them.
    let mut nodes: Vec<Div> = Vec::new();
    let lane_count = graph.lanes.len();
    for (i, lane) in graph.lanes.iter().enumerate() {
        let y = row_y(i, lane_count, total);
        let lit = hover.is_none_or(|h| lane_lit(graph, h, i));
        nodes.push(node(
            NodeSide::Left,
            y,
            if lane.working { LINK } else { TEXT_DARK },
            true,
            lit,
        ));
        let card_id = lane.latest_card.clone();
        let indent = if lane.parent.is_some() {
            SUB_INDENT
        } else {
            0.0
        };
        let mut label = div()
            .id(SharedString::from(format!("flow-lane-{i}")))
            .tab_index(0)
            .absolute()
            .left_0()
            .top(px(y - ROW_H / 2.0))
            .w(relative(LEFT_FRAC))
            .h(px(ROW_H))
            .flex()
            .items_center()
            .gap(px(6.0))
            .pl(px(12.0 + indent))
            .pr(px(12.0))
            .border_1()
            .border_color(gpui::transparent_black())
            .cursor_pointer()
            .hover(|s| s.bg(rgb(ROW_HOVER_BG)))
            .focus(|s| s.border_color(rgb(LINK)))
            .on_hover(cx.listener(move |this, hovered: &bool, _, cx| {
                on_hover(this, FlowHover::Lane(i), *hovered, cx);
            }))
            .on_click(cx.listener(move |this, _, window, cx| {
                on_action(this, CardAction::OpenDetail(card_id.clone()), window, cx);
            }))
            .tooltip({
                let lines = vec![TooltipLine::text(card_text(lang, &CardMsg::FlowOpenLatest))];
                move |window, cx| tooltip_view(lines.clone(), window, cx)
            })
            .child(
                div()
                    .min_w_0()
                    .truncate()
                    .text_size(px(13.0))
                    .font_weight(if lane.parent.is_some() {
                        FontWeight::NORMAL
                    } else {
                        FontWeight::MEDIUM
                    })
                    .text_color(rgb(if lit { TEXT_DARK } else { TEXT_MUTED }))
                    .child(if lane.label.is_empty() {
                        card_text(lang, &CardMsg::MainAgent)
                    } else {
                        lane.label.clone()
                    }),
            );
        if lane.parent.is_none() && !lane.short_id.is_empty() {
            label = label.child(
                div()
                    .flex_none()
                    .font_family(mono_font())
                    .text_size(px(11.0))
                    .text_color(rgb(TEXT_MUTED))
                    .child(lane.short_id.clone()),
            );
        }
        panel = panel.child(label);
    }

    let file_count = graph.files.len();
    for (i, file) in graph.files.iter().enumerate() {
        let y = row_y(i, file_count, total);
        let lit = hover.is_none_or(|h| file_lit(graph, h, i));
        let changed = file.changers > 0;
        nodes.push(node(
            NodeSide::Right,
            y,
            if changed { STRAND_CHANGE } else { STRAND_READ },
            changed,
            lit,
        ));
        let card_id = file.latest_card.clone();
        let mut lines = vec![TooltipLine::text(&file.full)];
        if file.changers > 0 {
            lines.push(TooltipLine::text(card_text(
                lang,
                &CardMsg::FlowChangedBy { n: file.changers },
            )));
        }
        if file.readers > 0 {
            lines.push(TooltipLine::text(card_text(
                lang,
                &CardMsg::FlowReadBy { n: file.readers },
            )));
        }
        lines.push(TooltipLine::text(card_text(lang, &CardMsg::FlowOpenLatest)));
        panel = panel.child(
            div()
                .id(SharedString::from(format!("flow-file-{i}")))
                .tab_index(0)
                .absolute()
                .right_0()
                .top(px(y - ROW_H / 2.0))
                .w(relative(RIGHT_FRAC))
                .h(px(ROW_H))
                .flex()
                .items_center()
                .pl(px(14.0))
                .pr(px(12.0))
                .border_1()
                .border_color(gpui::transparent_black())
                .cursor_pointer()
                .hover(|s| s.bg(rgb(ROW_HOVER_BG)))
                .focus(|s| s.border_color(rgb(LINK)))
                .on_hover(cx.listener(move |this, hovered: &bool, _, cx| {
                    on_hover(this, FlowHover::File(i), *hovered, cx);
                }))
                .on_click(cx.listener(move |this, _, window, cx| {
                    on_action(this, CardAction::OpenDetail(card_id.clone()), window, cx);
                }))
                .tooltip(move |window, cx| tooltip_view(lines.clone(), window, cx))
                .child(
                    div()
                        .min_w_0()
                        .truncate()
                        .font_family(mono_font())
                        .text_size(px(12.0))
                        .text_color(rgb(match (lit, changed) {
                            (true, true) => TEXT_DARK,
                            (true, false) => TEXT_SUBTLE,
                            (false, _) => TEXT_MUTED,
                        }))
                        .child(file.label.clone()),
                ),
        );
    }
    panel.children(nodes)
}

#[derive(Clone, Copy)]
enum NodeSide {
    Left,
    Right,
}

/// A node dot on the strand edge. Filled for agents and changed files,
/// a ring for files only read.
fn node(side: NodeSide, y: f32, color: u32, filled: bool, lit: bool) -> Div {
    let color = if lit { color } else { STRAND_FADED };
    let el = div()
        .absolute()
        .top(px(y - NODE / 2.0))
        .w(px(NODE))
        .h(px(NODE))
        .rounded_full()
        .border(px(1.5))
        .border_color(rgb(color))
        .bg(rgb(if filled { color } else { CARD_BG }));
    match side {
        NodeSide::Left => el.left(relative(LEFT_FRAC)).ml(px(-NODE / 2.0)),
        NodeSide::Right => el.right(relative(RIGHT_FRAC)).mr(px(-NODE / 2.0)),
    }
}

fn lane_lit(graph: &FlowGraph, hover: FlowHover, lane: usize) -> bool {
    match hover {
        FlowHover::Lane(l) => l == lane || graph.lanes.get(lane).and_then(|x| x.parent) == Some(l),
        FlowHover::File(f) => graph.edges.iter().any(|e| e.file == f && e.lane == lane),
    }
}

fn file_lit(graph: &FlowGraph, hover: FlowHover, file: usize) -> bool {
    match hover {
        FlowHover::File(f) => f == file,
        FlowHover::Lane(l) => graph
            .edges
            .iter()
            .any(|e| e.file == file && lane_lit(graph, FlowHover::Lane(l), e.lane)),
    }
}

/// One curve to paint, in panel-relative units: x as a share of the width,
/// y in pixels from the top.
#[derive(Clone, Copy)]
struct StrandSpec {
    from: (f32, f32),
    to: (f32, f32),
    /// Pixel offsets of this strand inside its bundle, at each end.
    spread: (f32, f32),
    width: f32,
    color: u32,
    /// A branch bows left of the agent column instead of crossing the panel.
    branch: bool,
}

fn strand_specs(graph: &FlowGraph, hover: Option<FlowHover>, total: usize) -> Vec<StrandSpec> {
    let lanes = graph.lanes.len();
    let files = graph.files.len();
    let left = LEFT_FRAC;
    let right = 1.0 - RIGHT_FRAC;
    let mut out = Vec::new();

    for (i, lane) in graph.lanes.iter().enumerate() {
        if let Some(parent) = lane.parent {
            let lit = hover.is_none_or(|h| lane_lit(graph, h, i));
            out.push(StrandSpec {
                from: (left, row_y(parent, lanes, total)),
                to: (left, row_y(i, lanes, total)),
                spread: (0.0, 0.0),
                width: 1.2,
                color: if lit { STRAND_BRANCH } else { STRAND_FADED },
                branch: true,
            });
        }
    }

    // Faded strands first so lit ones paint on top of them.
    let mut edges: Vec<_> = graph.edges.iter().collect();
    edges.sort_by_key(|e| {
        let lit = hover.is_none_or(|h| edge_lit(graph, h, e.lane, e.file));
        (lit, e.kind == EdgeKind::Change)
    });
    for e in edges {
        let lane = &graph.lanes[e.lane];
        let lit = hover.is_none_or(|h| edge_lit(graph, h, e.lane, e.file));
        let (width, base) = match e.kind {
            EdgeKind::Read => (1.0, STRAND_READ),
            EdgeKind::Change => (1.6, STRAND_CHANGE),
        };
        let color = match (lit, lane.working) {
            (false, _) => STRAND_FADED,
            (true, true) => LINK,
            (true, false) => base,
        };
        let n = e.turns.clamp(1, MAX_STRANDS);
        for k in 0..n {
            let centered = k as f32 - (n - 1) as f32 / 2.0;
            out.push(StrandSpec {
                from: (left, row_y(e.lane, lanes, total)),
                to: (right, row_y(e.file, files, total)),
                spread: (centered * 2.2, centered * 1.2),
                width,
                color,
                branch: false,
            });
        }
    }
    out
}

fn edge_lit(graph: &FlowGraph, hover: FlowHover, lane: usize, file: usize) -> bool {
    match hover {
        FlowHover::File(f) => f == file,
        FlowHover::Lane(l) => lane == l || graph.lanes.get(lane).and_then(|x| x.parent) == Some(l),
    }
}

fn paint_strands(bounds: Bounds<Pixels>, strands: &[StrandSpec], window: &mut Window) {
    let w = f32::from(bounds.size.width);
    let at = |x_frac: f32, y: f32| -> Point<Pixels> {
        point(bounds.origin.x + px(x_frac * w), bounds.origin.y + px(y))
    };
    for s in strands {
        let mut path = PathBuilder::stroke(px(s.width));
        if s.branch {
            let from = at(s.from.0, s.from.1);
            let to = at(s.to.0, s.to.1);
            let bow = px(16.0);
            path.move_to(from);
            path.cubic_bezier_to(
                to,
                point(from.x - bow, from.y + px(8.0)),
                point(to.x - bow, to.y - px(8.0)),
            );
        } else {
            let from = at(s.from.0, s.from.1 + s.spread.0);
            let to = at(s.to.0, s.to.1 + s.spread.1);
            let dx = to.x - from.x;
            // Control points pulled half the span inward give the S-curve;
            // the bundle offset shifts them a little so strands fan, not stack.
            let pull = dx * 0.5;
            path.move_to(from);
            path.cubic_bezier_to(
                to,
                point(from.x + pull + px(s.spread.0), from.y),
                point(to.x - pull + px(s.spread.1), to.y),
            );
        }
        if let Ok(path) = path.build() {
            window.paint_path(path, Hsla::from(rgb(s.color)));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rows_center_the_shorter_column() {
        // Two rows centered among four start one row down.
        assert_eq!(row_y(0, 2, 4), PAD_Y + ROW_H + ROW_H / 2.0);
        assert_eq!(row_y(0, 4, 4), PAD_Y + ROW_H / 2.0);
    }
}
