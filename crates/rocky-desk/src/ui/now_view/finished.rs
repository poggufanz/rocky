//! Finished sessions and collapsible idle sessions card inside Now.

use std::collections::BTreeSet;

use gpui::prelude::*;
use gpui::{Context, Div, FontWeight, SharedString, div, px, rgb};

use super::{NowAction, OnNowAction};
use crate::i18n::{CardMsg, UiLang, card_text};
use crate::now_model::{FinishedRow, IdleRow};
use crate::ui::status::{dot_el, failures_chip, status_dot};
use crate::ui::tooltip::{
    BORDER_SUBTLE, LINK, ROW_HOVER_BG, TEXT_DARK, TEXT_DIM, TEXT_MUTED, TEXT_SUBTLE,
    card_container, mono_font,
};

pub(super) fn finished_idle_card<T: 'static>(
    lang: UiLang,
    finished: &[FinishedRow],
    idle: &[IdleRow],
    idle_open: bool,
    cx: &mut Context<T>,
    on_action: OnNowAction<T>,
) -> Div {
    let mut card = card_container();
    for (idx, row) in finished.iter().enumerate() {
        card = card.child(finished_row_view(lang, row, idx, cx, on_action));
    }
    if !idle.is_empty() {
        card = card.child(idle_group_view(
            lang,
            idle,
            idle_open,
            !finished.is_empty(),
            cx,
            on_action,
        ));
    }
    card
}

fn finished_row_view<T: 'static>(
    lang: UiLang,
    row: &FinishedRow,
    idx: usize,
    cx: &mut Context<T>,
    on_action: OnNowAction<T>,
) -> Div {
    let done_part = card_text(
        lang,
        &CardMsg::DoneAge {
            age: row.age.clone(),
        },
    );
    let summary = match &row.branch {
        Some(branch) => format!("@ {branch} \u{00b7} {done_part}"),
        None => done_part,
    };

    let mut left = div()
        .flex()
        .items_center()
        .gap(px(8.0))
        .flex_1()
        .min_w_0()
        .overflow_hidden()
        .child(status_dot(row.status, None))
        .child(
            div()
                .text_size(px(13.5))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(rgb(TEXT_DARK))
                .whitespace_nowrap()
                .flex_shrink_0()
                .child(row.repo.clone()),
        )
        .child(
            div()
                .min_w_0()
                .truncate()
                .text_size(px(12.5))
                .text_color(rgb(TEXT_MUTED))
                .child(summary),
        );
    if row.failures > 0 {
        left = left.child(failures_chip(card_text(
            lang,
            &CardMsg::FailuresChip { n: row.failures },
        )));
    }

    let mut out = div()
        .flex()
        .items_center()
        .gap(px(8.0))
        .py(px(9.0))
        .px(px(12.0))
        .hover(|s| s.bg(rgb(ROW_HOVER_BG)))
        .child(left);
    if idx > 0 {
        out = out.border_t_1().border_color(rgb(BORDER_SUBTLE));
    }

    if let Some(card_id) = &row.card_id {
        let open_id = card_id.clone();
        out = out.child(
            view_card_link_base(idx, card_id, card_text(lang, &CardMsg::ViewCard)).on_click(
                cx.listener(move |this, _, window, cx| {
                    on_action(this, NowAction::OpenCard(open_id.clone()), window, cx);
                }),
            ),
        );
    }

    out
}

fn view_card_link_base(idx: usize, card_id: &str, label: String) -> gpui::Stateful<Div> {
    div()
        .id(SharedString::from(format!("now-view-card:{idx}:{card_id}")))
        .flex_shrink_0()
        .whitespace_nowrap()
        .text_size(px(12.0))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(rgb(LINK))
        .cursor_pointer()
        .hover(|s| s.underline())
        .child(label)
}

fn idle_group_view<T: 'static>(
    lang: UiLang,
    idle: &[IdleRow],
    idle_open: bool,
    border_top: bool,
    cx: &mut Context<T>,
    on_action: OnNowAction<T>,
) -> Div {
    let toggle_label = card_text(
        lang,
        if idle_open {
            &CardMsg::Hide
        } else {
            &CardMsg::Show
        },
    );
    let head = div()
        .id(SharedString::from("now-idle-toggle"))
        .flex()
        .items_center()
        .gap(px(8.0))
        .py(px(8.0))
        .px(px(12.0))
        .cursor_pointer()
        .hover(|s| s.bg(rgb(ROW_HOVER_BG)))
        .on_click(cx.listener(move |this, _, window, cx| {
            on_action(this, NowAction::ToggleIdle, window, cx);
        }))
        .child(dot_el(TEXT_DIM))
        .child(
            div()
                .text_size(px(12.5))
                .text_color(rgb(TEXT_SUBTLE))
                .whitespace_nowrap()
                .flex_shrink_0()
                .child(card_text(lang, &CardMsg::IdleSessions { n: idle.len() })),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .text_size(px(12.0))
                .text_color(rgb(TEXT_MUTED))
                .child(idle_repo_summary(idle)),
        )
        .child(
            div()
                .text_size(px(12.0))
                .text_color(rgb(TEXT_MUTED))
                .whitespace_nowrap()
                .flex_shrink_0()
                .child(toggle_label),
        );

    let mut group = div().flex().flex_col();
    if border_top {
        group = group.border_t_1().border_color(rgb(BORDER_SUBTLE));
    }
    group = group.child(head);

    if idle_open {
        let mut body = div()
            .flex()
            .flex_col()
            .gap(px(4.0))
            .pl(px(28.0))
            .pr(px(12.0))
            .pb(px(8.0));
        for row in idle {
            body = body.child(idle_compact_row(row));
        }
        group = group.child(body);
    }

    group
}

fn idle_compact_left(row: &IdleRow) -> Div {
    let mut left = div()
        .flex()
        .items_center()
        .gap(px(8.0))
        .flex_1()
        .min_w_0()
        .overflow_hidden()
        .child(
            div()
                .font_weight(FontWeight::SEMIBOLD)
                .whitespace_nowrap()
                .flex_shrink_0()
                .child(row.repo.clone()),
        );
    if let Some(branch) = &row.branch {
        left = left.child(
            div()
                .min_w_0()
                .truncate()
                .text_color(rgb(TEXT_MUTED))
                .child(format!("@ {branch}")),
        );
    }
    left.child(
        div()
            .font_family(mono_font())
            .text_color(rgb(TEXT_MUTED))
            .whitespace_nowrap()
            .flex_shrink_0()
            .child(row.session_short.clone()),
    )
}

fn idle_compact_age(age: String) -> Div {
    div()
        .font_family(mono_font())
        .text_color(rgb(TEXT_MUTED))
        .whitespace_nowrap()
        .flex_shrink_0()
        .child(age)
}

fn idle_compact_row(row: &IdleRow) -> Div {
    div()
        .flex()
        .items_center()
        .gap(px(8.0))
        .text_size(px(12.0))
        .text_color(rgb(TEXT_SUBTLE))
        .child(idle_compact_left(row))
        .child(idle_compact_age(row.age.clone()))
}

fn idle_repo_summary(rows: &[IdleRow]) -> String {
    let mut seen = BTreeSet::new();
    let mut names = Vec::new();
    for row in rows {
        if !row.repo.is_empty() && seen.insert(row.repo.as_str()) {
            names.push(row.repo.as_str());
        }
    }
    names.join(", ")
}

#[cfg(test)]
mod tests {
    use gpui::{DefiniteLength, Display, Length, Overflow, Styled, px};

    use super::{
        idle_compact_age, idle_compact_left, idle_compact_row, idle_repo_summary,
        view_card_link_base,
    };
    use crate::now_model::IdleRow;

    fn idle_row(repo: &str) -> IdleRow {
        IdleRow {
            repo: repo.to_string(),
            branch: None,
            session_short: "aaaaaaaa".to_string(),
            age: "1h".to_string(),
        }
    }

    #[test]
    fn idle_repo_summary_dedups_preserving_first_seen_order() {
        let rows = [
            idle_row("rocky"),
            idle_row("docs-site"),
            idle_row("rocky"),
            idle_row("api"),
            idle_row("docs-site"),
        ];
        assert_eq!(idle_repo_summary(&rows), "rocky, docs-site, api");
    }

    #[test]
    fn idle_compact_row_keeps_8px_gap_without_auto_margin() {
        let mut with_branch = idle_row("rocky-cli");
        with_branch.branch = Some("feat/desk-cards".to_string());

        for row_data in [with_branch, idle_row("rocky-cli")] {
            let mut row = idle_compact_row(&row_data);
            let row_style = row.style();
            assert_eq!(row_style.display, Some(Display::Flex));
            assert_eq!(row_style.gap.width, Some(DefiniteLength::from(px(8.0))));

            let mut left = idle_compact_left(&row_data);
            let left_style = left.style();
            assert_eq!(left_style.display, Some(Display::Flex));
            assert_eq!(left_style.gap.width, Some(DefiniteLength::from(px(8.0))));
            assert_eq!(left_style.flex_grow, Some(1.0));
            assert_eq!(left_style.min_size.width, Some(Length::from(px(0.0))));
            assert_eq!(left_style.overflow.x, Some(Overflow::Hidden));
        }

        let mut age = idle_compact_age("2h".to_string());
        let age_style = age.style();
        assert_eq!(age_style.margin.left, None);
        assert_eq!(age_style.flex_shrink, Some(0.0));
    }

    #[test]
    fn view_card_link_uses_flex_shrink_without_auto_margin() {
        let mut link = view_card_link_base(0, "card-1", "View card".to_string());
        let style = link.style();
        assert_eq!(style.margin.left, None);
        assert_eq!(style.flex_shrink, Some(0.0));
    }
}
