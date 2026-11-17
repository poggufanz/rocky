//! Project sidebar: one button per project, or a scrolling strip when narrow.

use gpui::prelude::*;
use gpui::{Context, Div, FontWeight, SharedString, Stateful, div, px, rgb};

use super::{AtlasAction, OnAtlasAction};
use crate::atlas_model::ProjectId;
use crate::atlas_model::projects::{ProjectRow, ProjectState};
use crate::i18n::{AtlasMsg, CardMsg, Msg, UiLang, atlas_text, card_text, tr};
use crate::ui::harness::{HarnessKind, session_badge};
use crate::ui::status::{failures_chip, status_pill};
use crate::ui::tooltip::{BORDER_LIGHT, CARD_BG, ROW_HOVER_BG, TEXT_DARK, TEXT_MUTED, TEXT_SUBTLE};
use rocky_proto::pipe::Status;

pub(crate) const SIDEBAR_WIDTH: f32 = 224.0;
const STRIP_ROW_WIDTH: f32 = 220.0;
const BADGE_ICON: f32 = 14.0;

/// The project list: a 224 px column, or a full-width scrolling strip when
/// `horizontal` is set for narrow windows.
pub fn sidebar<T: 'static>(
    lang: UiLang,
    rows: &[ProjectRow],
    selected: Option<&ProjectId>,
    horizontal: bool,
    cx: &mut Context<T>,
    on: OnAtlasAction<T>,
) -> Div {
    let buttons: Vec<Stateful<Div>> = rows
        .iter()
        .enumerate()
        .map(|(idx, row)| {
            project_button(
                lang,
                row,
                idx,
                selected == Some(&row.id),
                horizontal,
                cx,
                on,
            )
        })
        .collect();
    if horizontal {
        return div()
            .w_full()
            .flex_shrink_0()
            .child(strip().children(buttons));
    }
    let heading = div()
        .px(px(10.0))
        .pb(px(4.0))
        .text_size(px(11.0))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(rgb(TEXT_SUBTLE))
        .child(atlas_text(lang, &AtlasMsg::Projects));
    div()
        .w(px(SIDEBAR_WIDTH))
        .flex_shrink_0()
        .flex()
        .flex_col()
        .gap(px(4.0))
        .child(heading)
        .children(buttons)
}

/// Horizontal row of project buttons that scrolls on x.
fn strip() -> Stateful<Div> {
    div()
        .id("atlas-sidebar-strip")
        .w_full()
        .flex()
        .flex_row()
        .gap(px(6.0))
        .overflow_x_scroll()
}

fn project_button<T: 'static>(
    lang: UiLang,
    row: &ProjectRow,
    idx: usize,
    selected: bool,
    horizontal: bool,
    cx: &mut Context<T>,
    on: OnAtlasAction<T>,
) -> Stateful<Div> {
    let id = row.id.clone();
    let mut button = row_body(lang, row, selected)
        .id(SharedString::from(format!("atlas-project-{idx}")))
        .cursor_pointer()
        .on_click(cx.listener(move |this, _, window, cx| {
            on(this, AtlasAction::SelectProject(id.clone()), window, cx);
        }));
    if !selected {
        button = button.hover(|s| s.bg(rgb(ROW_HOVER_BG)));
    }
    if horizontal {
        button = button.w(px(STRIP_ROW_WIDTH)).flex_shrink_0();
    }
    button
}

/// The row's look without click handling: selected rows are white with a
/// light border, others transparent with a same-size transparent border.
fn row_body(lang: UiLang, row: &ProjectRow, selected: bool) -> Div {
    let name = row
        .name
        .clone()
        .unwrap_or_else(|| tr(lang, &Msg::UnknownRepo));
    let mut body = div()
        .flex()
        .flex_col()
        .gap(px(6.0))
        .py(px(8.0))
        .px(px(10.0))
        .rounded(px(8.0))
        .border_1();
    body = if selected {
        body.bg(rgb(CARD_BG)).border_color(rgb(BORDER_LIGHT))
    } else {
        body.border_color(gpui::transparent_black())
    };
    body.child(name_line(lang, &name, row.state))
        .child(badge_line(lang, row))
}

fn name_line(lang: UiLang, name: &str, state: ProjectState) -> Div {
    let state_el = match state {
        ProjectState::NeedsYou => status_pill(lang, Status::NeedsYou),
        ProjectState::Working => status_pill(lang, Status::Working),
        ProjectState::Quiet { idle_secs } => div()
            .flex_shrink_0()
            .whitespace_nowrap()
            .text_size(px(11.5))
            .text_color(rgb(TEXT_MUTED))
            .child(tr(lang, &Msg::Age { secs: idle_secs })),
    };
    div()
        .flex()
        .items_center()
        .gap(px(8.0))
        .child(
            div()
                .flex_grow()
                .min_w(px(0.0))
                .truncate()
                .text_size(px(14.0))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(rgb(TEXT_DARK))
                .child(name.to_string()),
        )
        .child(state_el)
}

fn badge_line(lang: UiLang, row: &ProjectRow) -> Div {
    let mut line = div().flex().flex_wrap().items_center().gap(px(4.0));
    for chip in &row.sessions {
        let kind = HarnessKind::from_id(chip.harness.as_deref());
        line = line.child(session_badge(&kind, chip.status, px(BADGE_ICON)));
    }
    if row.failures > 0 {
        line = line.child(failures_chip(card_text(
            lang,
            &CardMsg::FailuresChip { n: row.failures },
        )));
    }
    line
}

#[cfg(test)]
mod tests {
    use gpui::{Fill, Hsla, Overflow, Styled, rgb};
    use rocky_proto::pipe::{AgentKey, Status};

    use super::{row_body, strip};
    use crate::atlas_model::ProjectId;
    use crate::atlas_model::projects::{ProjectRow, ProjectState, SessionChip};
    use crate::i18n::UiLang;
    use crate::ui::tooltip::{BORDER_LIGHT, CARD_BG};

    fn row() -> ProjectRow {
        ProjectRow {
            id: ProjectId("/r".into()),
            name: Some("rocky".into()),
            state: ProjectState::Working,
            sessions: vec![SessionChip {
                key: AgentKey {
                    session_id: "s".into(),
                    agent_id: String::new(),
                },
                harness: Some("claude-code".into()),
                status: Status::Working,
            }],
            failures: 2,
            last_event_ms: 0,
        }
    }

    #[test]
    fn selected_row_is_white_with_light_border() {
        let mut selected = row_body(UiLang::En, &row(), true);
        let style = selected.style();
        assert_eq!(style.background, Some(Fill::from(Hsla::from(rgb(CARD_BG)))));
        assert_eq!(style.border_color, Some(Hsla::from(rgb(BORDER_LIGHT))));

        let mut other = row_body(UiLang::En, &row(), false);
        assert_ne!(
            other.style().background,
            Some(Fill::from(Hsla::from(rgb(CARD_BG))))
        );
    }

    #[test]
    fn horizontal_sidebar_scrolls_on_x() {
        let mut strip = strip();
        assert_eq!(strip.style().overflow.x, Some(Overflow::Scroll));
    }
}
