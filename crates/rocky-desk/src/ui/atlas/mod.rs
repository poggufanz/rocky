//! Star atlas views: project sidebar, needs-you bars, and project header.

use gpui::prelude::*;
use gpui::{Context, Div, FontWeight, SharedString, Stateful, Window, div, px, rgb};
use rocky_proto::pipe::{AgentKey, Status};

use crate::atlas_model::projects::NeedsYouBar;
use crate::atlas_model::{AtlasLayout, ProjectId, SkyWindow, StepRef};
use crate::i18n::{AtlasMsg, Msg, UiLang, atlas_text, tr};
use crate::ui::harness::{HarnessKind, harness_icon};
use crate::ui::status::{dot_el, status_pill};
use crate::ui::tooltip::{
    BORDER_LIGHT, BORDER_NEEDS_YOU, CARD_BG, CHIP_NEEDS_YOU_BG, CHIP_NEEDS_YOU_FG,
    STATUS_NEEDS_YOU, SURFACE_SUBTLE, TEXT_DARK, TEXT_MUTED, TIMER_NEEDS_YOU, mono_font,
};

pub mod sidebar;

pub use sidebar::sidebar;

/// User interactions emitted by the atlas views.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AtlasAction {
    SelectProject(ProjectId),
    SetLayout(AtlasLayout),
    SetWindow(SkyWindow),
    SelectStep(StepRef),
    ShowTurn(AgentKey, u64),
    StepBy(bool),
    CopyStep,
}

/// Callback invoked when an atlas control is triggered.
pub type OnAtlasAction<T> = fn(&mut T, AtlasAction, &mut Window, &mut Context<T>);

const BAR_ICON: f32 = 16.0;

/// A full-width bar for an agent that waits on the user in another project.
pub fn needs_you_bar<T: 'static>(
    lang: UiLang,
    bar: &NeedsYouBar,
    cx: &mut Context<T>,
    on: OnAtlasAction<T>,
) -> Div {
    let name = bar
        .name
        .clone()
        .unwrap_or_else(|| tr(lang, &Msg::UnknownRepo));
    let kind = HarnessKind::from_id(bar.harness.as_deref());
    let project = bar.project.clone();
    let open = div()
        .id(SharedString::from(format!("atlas-open-{}", project.0)))
        .flex_shrink_0()
        .whitespace_nowrap()
        .py(px(4.0))
        .px(px(10.0))
        .rounded(px(6.0))
        .cursor_pointer()
        .text_size(px(12.0))
        .font_weight(FontWeight::SEMIBOLD)
        .bg(rgb(CHIP_NEEDS_YOU_BG))
        .text_color(rgb(CHIP_NEEDS_YOU_FG))
        .hover(|s| s.opacity(0.85))
        .on_click(cx.listener(move |this, _, window, cx| {
            on(
                this,
                AtlasAction::SelectProject(project.clone()),
                window,
                cx,
            );
        }))
        .child(atlas_text(
            lang,
            &AtlasMsg::OpenProject { name: name.clone() },
        ));
    let mut text = div()
        .flex()
        .flex_col()
        .gap(px(2.0))
        .flex_grow()
        .min_w(px(0.0))
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(8.0))
                .child(
                    div()
                        .truncate()
                        .text_size(px(13.5))
                        .font_weight(FontWeight::BOLD)
                        .text_color(rgb(TEXT_DARK))
                        .child(name),
                )
                .child(status_pill(lang, Status::NeedsYou))
                .child(
                    div()
                        .flex_shrink_0()
                        .whitespace_nowrap()
                        .font_family(mono_font())
                        .text_size(px(11.5))
                        .text_color(rgb(TIMER_NEEDS_YOU))
                        .child(tr(
                            lang,
                            &Msg::Age {
                                secs: bar.waiting_secs,
                            },
                        )),
                ),
        );
    if let Some(action) = &bar.action {
        text = text.child(
            div()
                .truncate()
                .whitespace_nowrap()
                .font_family(mono_font())
                .text_size(px(12.0))
                .text_color(rgb(TEXT_MUTED))
                .child(action.clone()),
        );
    }
    div()
        .flex()
        .items_center()
        .gap(px(10.0))
        .py(px(8.0))
        .px(px(12.0))
        .rounded(px(10.0))
        .bg(rgb(CARD_BG))
        .border_1()
        .border_color(rgb(BORDER_NEEDS_YOU))
        .child(dot_el(STATUS_NEEDS_YOU))
        .child(harness_icon(&kind, px(BAR_ICON)))
        .child(text)
        .child(open)
}

/// The project title with the Sky chart / Constellation switch.
pub fn project_header<T: 'static>(
    lang: UiLang,
    name: &str,
    layout: AtlasLayout,
    cx: &mut Context<T>,
    on: OnAtlasAction<T>,
) -> Div {
    let segment = |target: AtlasLayout, msg: AtlasMsg, key: &'static str, cx: &mut Context<T>| {
        layout_segment(lang, layout == target, target, msg, key, cx, on)
    };
    let switch = div()
        .flex()
        .flex_shrink_0()
        .gap(px(2.0))
        .p(px(2.0))
        .rounded(px(8.0))
        .bg(rgb(SURFACE_SUBTLE))
        .child(segment(AtlasLayout::Sky, AtlasMsg::SkyChart, "1", cx))
        .child(segment(
            AtlasLayout::Constellation,
            AtlasMsg::Constellation,
            "2",
            cx,
        ));
    div()
        .flex()
        .items_center()
        .gap(px(12.0))
        .child(
            div()
                .flex_grow()
                .min_w(px(0.0))
                .truncate()
                .text_size(px(22.0))
                .font_weight(FontWeight::BOLD)
                .text_color(rgb(TEXT_DARK))
                .child(name.to_string()),
        )
        .child(switch)
}

fn layout_segment<T: 'static>(
    lang: UiLang,
    selected: bool,
    target: AtlasLayout,
    msg: AtlasMsg,
    key: &'static str,
    cx: &mut Context<T>,
    on: OnAtlasAction<T>,
) -> Stateful<Div> {
    let mut seg = div()
        .id(SharedString::from(format!("atlas-layout-{key}")))
        .flex()
        .items_center()
        .gap(px(6.0))
        .py(px(4.0))
        .px(px(10.0))
        .rounded(px(6.0))
        .border_1()
        .whitespace_nowrap()
        .cursor_pointer()
        .text_size(px(12.5))
        .on_click(cx.listener(move |this, _, window, cx| {
            on(this, AtlasAction::SetLayout(target), window, cx);
        }));
    seg = if selected {
        seg.bg(rgb(CARD_BG))
            .border_color(rgb(BORDER_LIGHT))
            .text_color(rgb(TEXT_DARK))
            .font_weight(FontWeight::SEMIBOLD)
    } else {
        seg.border_color(gpui::transparent_black())
            .text_color(rgb(TEXT_MUTED))
            .hover(|s| s.text_color(rgb(TEXT_DARK)))
    };
    seg.child(atlas_text(lang, &msg)).child(
        div()
            .font_family(mono_font())
            .text_size(px(10.5))
            .text_color(rgb(TEXT_MUTED))
            .child(key),
    )
}
