//! Star atlas state, actions, keys, and page composition on `DeskView`.

use gpui::prelude::*;
use gpui::{
    AnyElement, ClipboardItem, Context, Div, KeyDownEvent, SharedString, Window, div, px, rgb,
};

use super::{Controller, DeskView, now_ms};
use crate::atlas_model::constellation::constellation;
use crate::atlas_model::detail::{StepDetail, default_step, neighbor, step_detail, turn_step};
use crate::atlas_model::projects::{ProjectRow, default_project, needs_you_bars, projects};
use crate::atlas_model::sky::sky_chart;
use crate::atlas_model::{AtlasLayout, AtlasState, ProjectId, SkyWindow, StepRef, wanted_keys};
use crate::i18n::{AtlasMsg, Msg, UiLang, atlas_text, tr};
use crate::settings_view::View;
use crate::ui::atlas::constellation_view::constellation_card;
use crate::ui::atlas::detail_view::{detail_card, status_bar};
use crate::ui::atlas::sidebar::SIDEBAR_WIDTH;
use crate::ui::atlas::sky_view::{CARD_BORDER, CARD_PAD, sky_card};
use crate::ui::atlas::{AtlasAction, needs_you_bar, project_header, sidebar};
use crate::ui::cards_view::{CardAction, cards_section};
use crate::ui::title_bar::Tab;
use crate::ui::tooltip::{SURFACE_SUBTLE, TEXT_MUTED};
use crate::view::Model;

/// Below this window width the sidebar becomes a strip and the detail one column.
const NARROW_BELOW: f32 = 760.0;
/// Widest the atlas column grows.
const MAX_ATLAS_W: f32 = 1200.0;
/// Padding of the scrolling column and of the sidebar wrapper, per side.
const PAGE_PAD: f32 = 12.0;

/// Inner width of the Sky chart card for a window `viewport_w` wide.
pub(super) fn sky_avail_width(viewport_w: f32, narrow: bool) -> f32 {
    let sidebar = if narrow {
        0.0
    } else {
        SIDEBAR_WIDTH + 2.0 * PAGE_PAD
    };
    let column = (viewport_w - sidebar - 2.0 * PAGE_PAD).min(MAX_ATLAS_W);
    column - 2.0 * (CARD_PAD + CARD_BORDER)
}

/// The selected step when it still exists, else the project's default step.
fn resolve_detail(state: &AtlasState, model: &Model, home: Option<&str>) -> Option<StepDetail> {
    let picked = state
        .step
        .as_ref()
        .and_then(|s| step_detail(model, s, home));
    picked.or_else(|| {
        let step = default_step(model, state.project.as_ref()?)?;
        step_detail(model, &step, home)
    })
}

/// The step key presses and arrow buttons move from.
fn current_step(state: &AtlasState, model: &Model) -> Option<StepRef> {
    let known = state
        .step
        .as_ref()
        .filter(|s| step_detail(model, s, None).is_some());
    known
        .cloned()
        .or_else(|| default_step(model, state.project.as_ref()?))
}

/// Shows the turn of the selected step in the Constellation. A subagent's step
/// leaves the shown turn alone, since its lane hangs off the primary turn.
fn pin_turn(state: &mut AtlasState, model: &Model) {
    let Some(step) = state.step.as_ref().filter(|s| s.key.agent_id.is_empty()) else {
        return;
    };
    if let Some(detail) = step_detail(model, step, None) {
        state.turn = Some((step.key.clone(), detail.turn_start_ms));
    }
}

/// Pure part of an atlas action: moves selection state, never touches the UI.
pub(super) fn apply_atlas_action(state: &mut AtlasState, model: &Model, action: &AtlasAction) {
    match action {
        AtlasAction::SelectProject(id) => {
            state.project = Some(id.clone());
            state.step = None;
            state.turn = None;
        }
        AtlasAction::SetLayout(layout) => {
            state.layout = *layout;
            if *layout == AtlasLayout::Constellation {
                pin_turn(state, model);
            }
        }
        AtlasAction::SetWindow(window) => state.window = *window,
        AtlasAction::SelectStep(step) => {
            state.step = Some(step.clone());
            if state.layout == AtlasLayout::Constellation {
                pin_turn(state, model);
            }
        }
        AtlasAction::ShowTurn(key, start_ms) => {
            state.turn = Some((key.clone(), *start_ms));
            state.step = turn_step(model, key, *start_ms);
        }
        AtlasAction::StepBy(forward) => {
            if let Some(next) =
                current_step(state, model).and_then(|s| neighbor(model, &s, *forward))
            {
                state.step = Some(next);
            }
        }
        AtlasAction::CopyStep => {}
    }
}

impl Controller {
    /// Marks the project's sessions the map draws as wanted and asks for the
    /// timelines that are newly needed. Repeated calls ask only once. Working
    /// rows go through the 500 ms scheduler like active primaries.
    pub(super) fn sync_atlas_timelines(
        &mut self,
        project: &ProjectId,
        window: Option<SkyWindow>,
        now_ms: u64,
    ) {
        let subagents = self.model.subagent_tree_enabled();
        let keys = wanted_keys(self.model.agents(), project, window, now_ms, subagents);
        let added = self.model.set_wanted(keys);
        let active = self.model.active_timeline_keys();
        for key in added {
            if self.timeline_fetch.on_wanted(&key, &active, now_ms) {
                self.request_timeline(key);
            }
        }
    }
}

/// The selected project while it still exists, else the default one.
fn resolve_project(current: Option<&ProjectId>, rows: &[ProjectRow]) -> Option<ProjectId> {
    current
        .filter(|id| rows.iter().any(|r| &r.id == *id))
        .cloned()
        .or_else(|| default_project(rows))
}

impl DeskView {
    pub(crate) fn on_atlas_action(
        &mut self,
        action: AtlasAction,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        apply_atlas_action(&mut self.atlas, &self.ctl.model, &action);
        if action == AtlasAction::CopyStep
            && let Some(detail) =
                resolve_detail(&self.atlas, &self.ctl.model, self.home_dir.as_deref())
        {
            cx.write_to_clipboard(ClipboardItem::new_string(detail.text));
        }
        cx.notify();
    }

    /// Atlas keys on the Agents tab. Returns whether the key was taken.
    pub(super) fn on_atlas_key(
        &mut self,
        ev: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let m = ev.keystroke.modifiers;
        let plain = !(m.control || m.alt || m.platform || m.function);
        if !plain
            || self.ctl.view != View::Agents
            || self.main_tab != Tab::Agents
            || self.search_focus.is_focused(window)
        {
            return false;
        }
        let action = match ev.keystroke.key.as_str() {
            "1" => AtlasAction::SetLayout(AtlasLayout::Sky),
            "2" => AtlasAction::SetLayout(AtlasLayout::Constellation),
            "j" => AtlasAction::StepBy(true),
            "k" => AtlasAction::StepBy(false),
            "/" => {
                self.on_card_action(CardAction::FocusSearch, window, cx);
                return true;
            }
            _ => return false,
        };
        self.on_atlas_action(action, window, cx);
        true
    }

    /// The Agents page: sidebar, atlas column around `page`, and status bar.
    pub(super) fn atlas_page(
        &mut self,
        page: Div,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let lang = self.ctl.ui_lang;
        let now = now_ms();
        let rows = projects(self.ctl.model.agents(), now);
        let project = resolve_project(self.atlas.project.as_ref(), &rows);
        self.atlas.project = project.clone();
        let viewport_w = f32::from(window.viewport_size().width);
        let narrow = viewport_w < NARROW_BELOW;
        let side = sidebar(
            lang,
            &rows,
            project.as_ref(),
            narrow,
            cx,
            Self::on_atlas_action,
        );
        let mut column = page;
        let mut last_event = None;
        if let Some(project) = &project {
            self.ctl
                .sync_atlas_timelines(project, self.atlas.wanted_window(), now);
            let row = rows.iter().find(|r| &r.id == project);
            last_event = row.map(|r| r.last_event_ms);
            let name = row.and_then(|r| r.name.clone());
            column = self.atlas_body(column, project, name, viewport_w, now, cx);
        }
        let column = column.child(cards_section(
            lang,
            &self.cards,
            project.as_ref(),
            &self.search,
            &self.search_focus,
            window,
            cx,
            Self::on_card_action,
            Self::on_search_key,
        ));
        compose(side, column, status_bar(lang, last_event), narrow)
    }

    /// Needs-you bars, header, map, and detail for the selected project.
    fn atlas_body(
        &mut self,
        mut column: Div,
        project: &ProjectId,
        name: Option<String>,
        viewport_w: f32,
        now: u64,
        cx: &mut Context<Self>,
    ) -> Div {
        let lang = self.ctl.ui_lang;
        let narrow = viewport_w < NARROW_BELOW;
        let avail_w = sky_avail_width(viewport_w, narrow);
        let (bars, rest) = needs_you_bars(self.ctl.model.agents(), Some(project), now);
        for bar in &bars {
            column = column.child(needs_you_bar(lang, bar, cx, Self::on_atlas_action));
        }
        if rest > 0 {
            column = column.child(more_line(lang, rest));
        }
        let title = name.unwrap_or_else(|| tr(lang, &Msg::UnknownRepo));
        column = column.child(project_header(
            lang,
            &title,
            self.atlas.layout,
            cx,
            Self::on_atlas_action,
        ));
        let home = self.home_dir.as_deref();
        let detail = resolve_detail(&self.atlas, &self.ctl.model, home);
        let selected = detail.as_ref().map(|d| d.step.clone());
        column = column.child(self.map_card(
            lang,
            project,
            &title,
            selected.as_ref(),
            (now, avail_w),
            cx,
        ));
        column.child(detail_card(
            lang,
            detail.as_ref(),
            now,
            narrow,
            cx,
            Self::on_atlas_action,
        ))
    }

    /// The Sky chart or Constellation card for the current layout.
    #[allow(clippy::too_many_arguments)]
    fn map_card(
        &self,
        lang: UiLang,
        project: &ProjectId,
        title: &str,
        selected: Option<&StepRef>,
        (now, avail_w): (u64, f32),
        cx: &mut Context<Self>,
    ) -> Div {
        let model = &self.ctl.model;
        match self.atlas.layout {
            AtlasLayout::Sky => {
                let chart = sky_chart(model, &self.cards, project, self.atlas.window, now, lang);
                sky_card(
                    lang,
                    &chart,
                    title,
                    selected,
                    avail_w,
                    cx,
                    Self::on_atlas_action,
                )
            }
            AtlasLayout::Constellation => {
                let view = constellation(
                    model,
                    &self.cards,
                    project,
                    self.atlas.turn.as_ref(),
                    now,
                    self.home_dir.as_deref(),
                    lang,
                );
                constellation_card(
                    lang,
                    view.as_ref(),
                    selected,
                    now,
                    cx,
                    Self::on_atlas_action,
                )
            }
        }
    }
}

fn more_line(lang: UiLang, n: usize) -> Div {
    div()
        .px(px(4.0))
        .text_size(px(12.0))
        .text_color(rgb(TEXT_MUTED))
        .child(atlas_text(lang, &AtlasMsg::More { n }))
}

/// Sidebar beside (or above, when narrow) the scrolling column, status bar below.
fn compose(side: Div, column: Div, bar: Div, narrow: bool) -> AnyElement {
    let scroller = div()
        .id(SharedString::from("agents"))
        .flex_1()
        .min_w_0()
        .min_h_0()
        .overflow_y_scroll()
        .p(px(PAGE_PAD))
        .child(column.max_w(px(MAX_ATLAS_W)).mx_auto());
    let side = div()
        .id(SharedString::from("atlas-sidebar"))
        .flex_shrink_0()
        .overflow_y_scroll()
        .p(px(PAGE_PAD))
        .child(side);
    let mut body = div().flex().flex_1().min_h_0();
    body = if narrow {
        body.flex_col().child(side).child(scroller)
    } else {
        body.child(side).child(scroller)
    };
    div()
        .flex()
        .flex_col()
        .size_full()
        .child(body)
        .child(bar.flex_shrink_0().bg(rgb(SURFACE_SUBTLE)))
        .into_any_element()
}
