//! Render tree for the collapsible Notices card and live Now section.

use gpui::prelude::*;
use gpui::{AnyElement, Context, Div, FontWeight, SharedString, Window, div, px, rgb};
use rocky_proto::pipe::{AgentKey, Status};

use crate::i18n::{CardMsg, Msg, UiLang, card_text, tr};
use crate::now_model::{NowView, SessionCard, SubRow};
use crate::ui::motion;
use crate::ui::tooltip::{
    BORDER_NEEDS_YOU, BORDER_SUBTLE, CHIP_BG, CHIP_FG, CHIP_HIGH_BG, CHIP_HIGH_FG,
    CHIP_NEEDS_YOU_BG, CHIP_NEEDS_YOU_FG, CHIP_WORKING_BG, CHIP_WORKING_FG, NOTICE_DOT,
    ROW_HOVER_BG, STATUS_DONE, STATUS_FAILED, STATUS_IDLE, STATUS_NEEDS_YOU, STATUS_WORKING,
    TEXT_BODY, TEXT_DARK, TEXT_DIM, TEXT_MUTED, TEXT_SUBTLE, TIMER_NEEDS_YOU, TIMER_WORKING,
    card_container, mono_font,
};

mod finished;
mod steps;

use finished::finished_idle_card;
use steps::{primary_steps_section, steps_list};

/// User interactions emitted by the Notices card and Now section.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NowAction {
    ToggleNotices,
    ToggleAgent(AgentKey),
    ToggleIdle,
    OpenCard(String),
}

/// Callback invoked when Now UI controls are triggered.
pub type OnNowAction<T> = fn(&mut T, NowAction, &mut Window, &mut Context<T>);

/// Renders the collapsible Notices card replacing the top warnings strip.
pub fn notices_card<T: 'static>(
    lang: UiLang,
    warnings: &[Msg],
    open: bool,
    cx: &mut Context<T>,
    on_action: OnNowAction<T>,
) -> Div {
    let title = card_text(lang, &CardMsg::SetupNotes { n: warnings.len() });
    let summary = warnings.first().map(|w| tr(lang, w)).unwrap_or_default();
    let toggle_label = card_text(lang, if open { &CardMsg::Hide } else { &CardMsg::Show });

    let head = div()
        .id(SharedString::from("notices-toggle"))
        .flex()
        .items_center()
        .gap(px(8.0))
        .py(px(8.0))
        .px(px(12.0))
        .cursor_pointer()
        .hover(|s| s.bg(rgb(ROW_HOVER_BG)))
        .on_click(cx.listener(move |this, _, window, cx| {
            on_action(this, NowAction::ToggleNotices, window, cx);
        }))
        .child(dot_el(NOTICE_DOT))
        .child(
            div()
                .text_size(px(12.5))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(rgb(TEXT_DARK))
                .whitespace_nowrap()
                .flex_shrink_0()
                .child(title),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .text_size(px(12.0))
                .text_color(rgb(TEXT_MUTED))
                .child(summary),
        )
        .child(
            div()
                .text_size(px(12.0))
                .text_color(rgb(TEXT_MUTED))
                .whitespace_nowrap()
                .flex_shrink_0()
                .child(toggle_label),
        );

    let mut card = card_container().child(head);
    if open {
        let mut body = div()
            .flex()
            .flex_col()
            .gap(px(4.0))
            .border_t_1()
            .border_color(rgb(BORDER_SUBTLE))
            .pt(px(8.0))
            .pr(px(12.0))
            .pb(px(10.0))
            .pl(px(28.0))
            .text_size(px(12.0))
            .text_color(rgb(TEXT_SUBTLE));
        for w in warnings {
            body = body.child(div().child(tr(lang, w)));
        }
        card = card.child(body);
    }
    card
}

/// Renders the full Now section: header, active session cards, and finished/idle card.
pub fn now_section<T: 'static>(
    lang: UiLang,
    view: &NowView,
    idle_open: bool,
    cx: &mut Context<T>,
    on_action: OnNowAction<T>,
) -> Div {
    let mut section = div().flex().flex_col().gap(px(10.0));
    let is_empty = view.active.is_empty() && view.finished.is_empty() && view.idle.is_empty();

    section = section.child(section_header(lang, view, !is_empty));

    if is_empty {
        return section.child(
            div()
                .mx(px(2.0))
                .text_size(px(13.0))
                .text_color(rgb(TEXT_MUTED))
                .child(tr(lang, &Msg::NoAgents)),
        );
    }

    for (idx, card) in view.active.iter().enumerate() {
        let el = session_card(lang, card, cx, on_action);
        let id = SharedString::from(format!(
            "now-card:{}:{}",
            card.key.session_id, card.key.agent_id
        ));
        section = section.child(motion::enter(el, id, idx));
    }

    if !view.finished.is_empty() || !view.idle.is_empty() {
        section = section.child(finished_idle_card(
            lang,
            &view.finished,
            &view.idle,
            idle_open,
            cx,
            on_action,
        ));
    }

    section
}

fn section_header(lang: UiLang, view: &NowView, show_counts: bool) -> Div {
    let mut head = div()
        .flex()
        .items_baseline()
        .justify_between()
        .mt(px(6.0))
        .mx(px(2.0))
        .child(
            div()
                .text_size(px(11.0))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(rgb(TEXT_DIM))
                .child(card_text(lang, &CardMsg::SectionNow).to_uppercase()),
        );

    if show_counts {
        let mut right = div()
            .flex()
            .items_baseline()
            .text_size(px(12.0))
            .text_color(rgb(TEXT_MUTED))
            .child(card_text(
                lang,
                &CardMsg::ActiveCount {
                    n: view.active_count,
                },
            ));
        if view.needs_count > 0 {
            right = right.child(" \u{00b7} ").child(
                div()
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(rgb(TIMER_NEEDS_YOU))
                    .child(card_text(
                        lang,
                        &CardMsg::NeedYouCount {
                            n: view.needs_count,
                        },
                    )),
            );
        }
        head = head.child(right);
    }
    head
}

fn session_card<T: 'static>(
    lang: UiLang,
    card: &SessionCard,
    cx: &mut Context<T>,
    on_action: OnNowAction<T>,
) -> Div {
    let mut out = card_container();
    if card.status == Status::NeedsYou {
        out = out.border_color(rgb(BORDER_NEEDS_YOU));
    }

    out = out.child(session_header(lang, card, cx, on_action));

    if !card.tool.is_empty() || card.action.is_some() || card.failures > 0 {
        out = out.child(action_row(lang, card));
    }

    if !card.steps.is_empty() || card.hidden_steps > 0 {
        out = out.child(primary_steps_section(lang, card, cx, on_action));
    }

    for sub in &card.subs {
        out = out.child(sub_row_view(sub, cx, on_action));
        if sub.expanded && !sub.steps.is_empty() {
            out = out.child(steps_list(&sub.key, &sub.steps, 0, px(28.0)));
        }
    }

    if let Some(note) = &card.hidden_children {
        out = out.child(
            div()
                .border_t_1()
                .border_color(rgb(BORDER_SUBTLE))
                .py(px(7.0))
                .pl(px(28.0))
                .pr(px(12.0))
                .text_size(px(12.0))
                .text_color(rgb(TEXT_MUTED))
                .child(tr(lang, note)),
        );
    }

    out
}

fn session_header<T: 'static>(
    lang: UiLang,
    card: &SessionCard,
    cx: &mut Context<T>,
    on_action: OnNowAction<T>,
) -> impl IntoElement {
    let key = card.key.clone();
    let dot_id = SharedString::from(format!("now-dot:{}:{}", key.session_id, key.agent_id));
    let mut line1 = div()
        .flex()
        .items_center()
        .gap(px(8.0))
        .w_full()
        .min_w_0()
        .child(status_dot(card.status, Some(dot_id)))
        .child(
            div()
                .text_size(px(14.0))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(rgb(TEXT_DARK))
                .truncate()
                .child(card.repo.clone()),
        );
    if let Some(branch) = &card.branch {
        line1 = line1.child(
            div()
                .text_size(px(13.0))
                .text_color(rgb(TEXT_MUTED))
                .truncate()
                .child(format!("@ {branch}")),
        );
    }
    line1 = line1
        .child(
            div()
                .text_size(px(11.0))
                .font_family(mono_font())
                .text_color(rgb(TEXT_MUTED))
                .whitespace_nowrap()
                .flex_shrink_0()
                .child(card.session_short.clone()),
        )
        .child(status_pill(lang, card.status).ml_auto())
        .child(
            div()
                .min_w(px(40.0))
                .flex()
                .justify_end()
                .flex_shrink_0()
                .whitespace_nowrap()
                .text_size(px(12.0))
                .font_weight(FontWeight::MEDIUM)
                .font_family(mono_font())
                .text_color(rgb(timer_color(card.status)))
                .child(card.timer.clone()),
        );

    let mut header = div()
        .id(SharedString::from(format!(
            "now-head:{}:{}",
            key.session_id, key.agent_id
        )))
        .flex()
        .flex_col()
        .gap(px(3.0))
        .pt(px(10.0))
        .px(px(12.0))
        .pb(px(8.0))
        .cursor_pointer()
        .hover(|s| s.bg(rgb(ROW_HOVER_BG)))
        .on_click(cx.listener(move |this, _, window, cx| {
            on_action(this, NowAction::ToggleAgent(key.clone()), window, cx);
        }))
        .child(line1);

    if let Some(prompt) = &card.prompt {
        header = header.child(
            div()
                .pl(px(16.0))
                .text_size(px(13.0))
                .text_color(rgb(TEXT_BODY))
                .truncate()
                .child(prompt.clone()),
        );
    }

    header
}

fn action_row(lang: UiLang, card: &SessionCard) -> Div {
    let mut row = div()
        .flex()
        .items_center()
        .gap(px(8.0))
        .border_t_1()
        .border_color(rgb(BORDER_SUBTLE))
        .py(px(6.0))
        .px(px(12.0))
        .hover(|s| s.bg(rgb(ROW_HOVER_BG)))
        .child(action_tool_column(card.tool.clone()));

    if let Some(action) = &card.action {
        row = row.child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .font_family(mono_font())
                .text_size(px(12.5))
                .text_color(rgb(TEXT_DARK))
                .child(action.clone()),
        );
    } else {
        row = row.child(div().flex_1());
    }

    if card.failures > 0 {
        row = row.child(failures_chip(card_text(
            lang,
            &CardMsg::FailuresChip { n: card.failures },
        )));
    }

    row
}

fn action_tool_column(tool: String) -> Div {
    div()
        .w(px(34.0))
        .flex_shrink_0()
        .truncate()
        .text_size(px(11.0))
        .text_color(rgb(TEXT_MUTED))
        .child(tool)
}

fn sub_row_view<T: 'static>(
    sub: &SubRow,
    cx: &mut Context<T>,
    on_action: OnNowAction<T>,
) -> impl IntoElement {
    let key = sub.key.clone();
    let dot_id = SharedString::from(format!("now-sub-dot:{}:{}", key.session_id, key.agent_id));
    let mut line1 = div()
        .flex()
        .items_center()
        .gap(px(8.0))
        .w_full()
        .min_w_0()
        .child(
            div()
                .text_size(px(12.0))
                .text_color(rgb(TEXT_MUTED))
                .flex_shrink_0()
                .child("\u{21b3}"),
        )
        .child(status_dot(sub.status, Some(dot_id)))
        .child(
            div()
                .font_family(mono_font())
                .text_size(px(12.5))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(rgb(TEXT_DARK))
                .flex_shrink_0()
                .child(sub.agent_type.clone()),
        );

    if let Some(desc) = &sub.description {
        line1 = line1.child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .text_size(px(12.0))
                .text_color(rgb(TEXT_MUTED))
                .child(desc.clone()),
        );
    } else {
        line1 = line1.child(div().flex_1());
    }

    line1 = line1.child(
        div()
            .font_family(mono_font())
            .text_size(px(11.0))
            .text_color(rgb(TEXT_MUTED))
            .whitespace_nowrap()
            .flex_shrink_0()
            .child(sub.timer.clone()),
    );

    let mut row = div()
        .id(SharedString::from(format!(
            "now-sub:{}:{}",
            key.session_id, key.agent_id
        )))
        .flex()
        .flex_col()
        .gap(px(2.0))
        .border_t_1()
        .border_color(rgb(BORDER_SUBTLE))
        .py(px(7.0))
        .pl(px(28.0))
        .pr(px(12.0))
        .cursor_pointer()
        .hover(|s| s.bg(rgb(ROW_HOVER_BG)))
        .on_click(cx.listener(move |this, _, window, cx| {
            on_action(this, NowAction::ToggleAgent(key.clone()), window, cx);
        }))
        .child(line1);

    if let Some(action) = &sub.action {
        row = row.child(
            div()
                .pl(px(36.0))
                .font_family(mono_font())
                .text_size(px(12.0))
                .text_color(rgb(TEXT_SUBTLE))
                .truncate()
                .child(action.clone()),
        );
    }

    row
}

pub(super) fn dot_el(color: u32) -> Div {
    div()
        .w(px(8.0))
        .h(px(8.0))
        .rounded_full()
        .flex_shrink_0()
        .bg(rgb(color))
}

pub(super) fn status_dot(status: Status, pulse_id: Option<SharedString>) -> AnyElement {
    let dot = dot_el(status_dot_color(status));
    match pulse_id {
        Some(id) if matches!(status, Status::NeedsYou | Status::Working) => {
            motion::pulse(dot, id).into_any_element()
        }
        _ => dot.into_any_element(),
    }
}

fn status_pill(lang: UiLang, status: Status) -> Div {
    let (bg, fg) = match status {
        Status::NeedsYou => (CHIP_NEEDS_YOU_BG, CHIP_NEEDS_YOU_FG),
        Status::Working => (CHIP_WORKING_BG, CHIP_WORKING_FG),
        Status::Done | Status::Failed | Status::Idle | Status::Ended => (CHIP_BG, CHIP_FG),
    };
    div()
        .py(px(2.0))
        .px(px(7.0))
        .rounded(px(99.0))
        .whitespace_nowrap()
        .flex_shrink_0()
        .bg(rgb(bg))
        .text_color(rgb(fg))
        .text_size(px(10.5))
        .font_weight(FontWeight::SEMIBOLD)
        .child(tr(lang, &Msg::Status(status)))
}

pub(super) fn failures_chip(text: String) -> Div {
    div()
        .text_size(px(10.5))
        .font_weight(FontWeight::SEMIBOLD)
        .py(px(2.0))
        .px(px(6.0))
        .rounded(px(4.0))
        .whitespace_nowrap()
        .flex_shrink_0()
        .bg(rgb(CHIP_HIGH_BG))
        .text_color(rgb(CHIP_HIGH_FG))
        .child(text)
}

fn status_dot_color(status: Status) -> u32 {
    match status {
        Status::NeedsYou => STATUS_NEEDS_YOU,
        Status::Working => STATUS_WORKING,
        Status::Done => STATUS_DONE,
        Status::Failed => STATUS_FAILED,
        Status::Idle | Status::Ended => STATUS_IDLE,
    }
}

fn timer_color(status: Status) -> u32 {
    match status {
        Status::NeedsYou => TIMER_NEEDS_YOU,
        Status::Working => TIMER_WORKING,
        Status::Done | Status::Failed | Status::Idle | Status::Ended => TEXT_MUTED,
    }
}

#[cfg(test)]
mod tests {
    use gpui::{Display, Length, Overflow, Styled, TextOverflow, WhiteSpace, px};
    use rocky_proto::pipe::{AgentKey, Status};

    use super::{action_row, action_tool_column};
    use crate::i18n::UiLang;
    use crate::now_model::SessionCard;

    fn sample_card(tool: &str, action: Option<&str>, failures: u32) -> SessionCard {
        SessionCard {
            key: AgentKey {
                session_id: "sess-12345678".to_string(),
                agent_id: String::new(),
            },
            status: Status::Working,
            repo: "rocky".to_string(),
            branch: Some("main".to_string()),
            session_short: "sess-123".to_string(),
            timer: "12s".to_string(),
            prompt: Some("fix layout".to_string()),
            tool: tool.to_string(),
            action: action.map(str::to_string),
            failures,
            steps: Vec::new(),
            hidden_steps: 0,
            expanded: false,
            subs: Vec::new(),
            hidden_children: None,
        }
    }

    #[test]
    fn action_tool_column_is_fixed_34px_non_shrinking_single_line_truncated() {
        for label in [
            "mcp__filesystem__read_multiple_files",
            "menunggu persetujuan pengguna",
        ] {
            let mut col = action_tool_column(label.to_string());
            let style = col.style();
            assert_eq!(style.size.width, Some(Length::from(px(34.0))));
            assert_eq!(style.min_size.width, None);
            assert_eq!(style.flex_shrink, Some(0.0));
            assert_eq!(style.overflow.x, Some(Overflow::Hidden));
            assert_eq!(style.overflow.y, Some(Overflow::Hidden));
            let text = style.text.as_ref().expect("truncate sets text style");
            assert_eq!(text.white_space, Some(WhiteSpace::Nowrap));
            assert!(
                matches!(
                    text.text_overflow.as_ref(),
                    Some(TextOverflow::Truncate(s)) if s.as_ref() == "\u{2026}"
                ),
                "expected ellipsis truncation for {label}"
            );
        }
    }

    #[test]
    fn action_row_handles_long_tool_and_indonesian_fallback_with_action_and_failures() {
        let long_tool = sample_card(
            "mcp__filesystem__read_multiple_files",
            Some("cargo test -p rocky-desk"),
            2,
        );
        let mut long_row = action_row(UiLang::En, &long_tool);
        assert_eq!(long_row.style().display, Some(Display::Flex));

        let id_fallback = sample_card(
            "menunggu persetujuan pengguna",
            Some("git status --short"),
            3,
        );
        let mut id_row = action_row(UiLang::Id, &id_fallback);
        assert_eq!(id_row.style().display, Some(Display::Flex));
    }
}
