//! Finished sessions and collapsible idle sessions card inside Now.

use std::collections::BTreeSet;

use gpui::prelude::*;
use gpui::{Context, Div, FontWeight, SharedString, div, px, rgb};

use super::{NowAction, OnNowAction, dot_el, failures_chip, status_dot};
use crate::i18n::{CardMsg, UiLang, card_text};
use crate::now_model::{FinishedRow, IdleRow};
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
            div()
                .id(SharedString::from(format!("now-view-card:{idx}:{card_id}")))
                .ml_auto()
                .flex_shrink_0()
                .whitespace_nowrap()
                .text_size(px(12.0))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(rgb(LINK))
                .cursor_pointer()
                .hover(|s| s.underline())
                .on_click(cx.listener(move |this, _, window, cx| {
                    on_action(this, NowAction::OpenCard(open_id.clone()), window, cx);
                }))
                .child(card_text(lang, &CardMsg::ViewCard)),
        );
    }

    out
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
            let mut item = div()
                .flex()
                .items_center()
                .gap(px(8.0))
                .text_size(px(12.0))
                .text_color(rgb(TEXT_SUBTLE))
                .child(
                    div()
                        .font_weight(FontWeight::SEMIBOLD)
                        .flex_shrink_0()
                        .child(row.repo.clone()),
                );
            if let Some(branch) = &row.branch {
                item = item.child(
                    div()
                        .min_w_0()
                        .truncate()
                        .text_color(rgb(TEXT_MUTED))
                        .child(format!("@ {branch}")),
                );
            }
            item = item
                .child(
                    div()
                        .font_family(mono_font())
                        .text_color(rgb(TEXT_MUTED))
                        .whitespace_nowrap()
                        .flex_shrink_0()
                        .child(row.session_short.clone()),
                )
                .child(
                    div()
                        .ml_auto()
                        .font_family(mono_font())
                        .text_color(rgb(TEXT_MUTED))
                        .whitespace_nowrap()
                        .flex_shrink_0()
                        .child(row.age.clone()),
                );
            body = body.child(item);
        }
        group = group.child(body);
    }

    group
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
    use super::idle_repo_summary;
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
}
