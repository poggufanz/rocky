//! Render trees for the Settings setup sections and the final removed screen.
//! Every decision comes from `setup_settings`; buttons only name an action.

use gpui::prelude::*;
use gpui::{
    AnyElement, ClickEvent, Context, Div, IntoElement, SharedString, Stateful, div, px, rgb,
};
use rocky_proto::pipe::Health;

use crate::cards_model::TooltipLine;
use crate::clock;
use crate::i18n::{Msg, SetupMsg, UiLang, tr};
use crate::requests::Requests;
use crate::setup_settings::{
    Control, HarnessRow, RemoveFlow, RepoRow, SetupSettings, Tone, UNINSTALL_COMMAND, harness_name,
    harness_rows, home_short, repo_rows, split_shell,
};
use crate::ui::settings_kit::{self as kit, Weight};
use crate::ui::tooltip::{ROW_HOVER_BG, tooltip_view};

/// What a Settings control asks the app to do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SettingsAction {
    /// `on` is the switch's current state; the request is its opposite.
    Harness {
        harness: String,
        on: bool,
    },
    Shell {
        on: bool,
    },
    Reinstall,
    RepoAllow(String),
    RepoRevoke(String),
    PurgeAsk(String),
    PurgeConfirm(String),
    PurgeCancel,
    RemoveAsk,
    RemoveCancel,
    RemoveConfirm,
}

/// The app's handler for an action. A plain function, so the render code
/// needs no knowledge of the view type that owns the state.
pub type OnAction<T> = fn(&mut T, SettingsAction, &mut Context<T>);

fn text(lang: UiLang, m: SetupMsg) -> String {
    tr(lang, &Msg::Setup(m))
}

pub(crate) fn error_line(lang: UiLang, error: &str) -> Div {
    kit::error_text(text(
        lang,
        SetupMsg::ConsentFailed {
            error: error.to_string(),
        },
    ))
}

pub(crate) fn action_button<T: 'static>(
    id: String,
    label: String,
    enabled: bool,
    action: SettingsAction,
    cx: &mut Context<T>,
    on_action: OnAction<T>,
) -> Stateful<Div> {
    weighted_button(id, label, Weight::Normal, enabled, action, cx, on_action)
}

fn weighted_button<T: 'static>(
    id: String,
    label: String,
    weight: Weight,
    enabled: bool,
    action: SettingsAction,
    cx: &mut Context<T>,
    on_action: OnAction<T>,
) -> Stateful<Div> {
    kit::button(
        SharedString::from(id),
        label,
        weight,
        enabled,
        cx.listener(move |this, _: &ClickEvent, _, cx| on_action(this, action.clone(), cx)),
    )
}

fn heading(lang: UiLang, m: SetupMsg) -> Div {
    div().text_base().child(text(lang, m))
}

struct Ctx<'a, T: 'static> {
    lang: UiLang,
    requests: &'a Requests,
    model: &'a SetupSettings,
    on_action: OnAction<T>,
    home: Option<String>,
}

impl<T: 'static> Ctx<'_, T> {
    fn short(&self, path: &str) -> String {
        home_short(path, self.home.as_deref())
    }
}

/// A row label: the name, then a status chip when there is one.
fn name_with_chip(name: String, chip: Option<(String, Tone)>) -> Div {
    let mut head = div()
        .flex()
        .flex_wrap()
        .items_center()
        .gap(px(8.0))
        .child(div().min_w_0().child(name));
    if let Some((label, tone)) = chip {
        head = head.child(kit::chip(label, tone));
    }
    head
}

/// The first config path, "+N more" for the rest, and every path in a tooltip.
fn paths_line(id: String, paths: &[String], c: &Ctx<'_, impl Sized>) -> Option<AnyElement> {
    let first = paths.first()?;
    let mut line = c.short(first);
    if paths.len() > 1 {
        line = format!(
            "{line}  {}",
            text(c.lang, SetupMsg::SettingsMorePaths { n: paths.len() - 1 })
        );
    }
    let lines: Vec<TooltipLine> = paths
        .iter()
        .map(|p| TooltipLine::text(c.short(p)))
        .collect();
    Some(
        div()
            .id(SharedString::from(id))
            .w_full()
            .min_w_0()
            .child(kit::mono_line(line))
            .tooltip(move |window, cx| tooltip_view(lines.clone(), window, cx))
            .into_any_element(),
    )
}

/// One agent tool: name and state, its config files, and its switch. The
/// shell hook uses the same row with the shell switch.
fn tool_row<T: 'static>(
    c: &Ctx<'_, T>,
    name: String,
    row: Option<&HarnessRow>,
    on: bool,
    control: Control,
    action: SettingsAction,
    cx: &mut Context<T>,
) -> AnyElement {
    let busy = control.busy(c.requests);
    let chip = if busy {
        Some((text(c.lang, SetupMsg::SwitchWorking), Tone::Neutral))
    } else if !on {
        Some((text(c.lang, SetupMsg::HarnessOff), Tone::Neutral))
    } else {
        row.map(|r| {
            let state = if r.error.is_some() {
                Msg::Setup(SetupMsg::HarnessFailed {
                    error: String::new(),
                })
            } else {
                r.state.clone()
            };
            (tr(c.lang, &state), r.tone)
        })
    };
    let id = match &control {
        Control::Harness(h) => format!("harness:{h}"),
        _ => "shell-hook".to_string(),
    };
    let mut label = div()
        .w_full()
        .flex()
        .flex_col()
        .gap(px(2.0))
        .child(name_with_chip(name.clone(), chip));
    if let Some(r) = row.filter(|_| on) {
        if let Some(path) = &r.foreign_path {
            label = label.child(kit::note_line(text(
                c.lang,
                SetupMsg::Foreign {
                    harness: name.clone(),
                    path: c.short(path),
                },
            )));
        }
        if let Some(error) = &r.error {
            label = label.child(kit::error_text(error.clone()));
        }
    }
    if let Some(r) = row
        && let Some(paths) = paths_line(format!("{id}:paths"), &r.paths, c)
    {
        label = label.child(paths);
    }
    if let Some(error) = c.model.error(&control) {
        label = label.child(error_line(c.lang, error));
    }
    let on_action = c.on_action;
    let mut out = kit::row(label, None, Some(kit::switch(on, !busy).into_any_element()))
        .id(SharedString::from(id));
    if !busy {
        out = out
            .cursor_pointer()
            .hover(|s| s.bg(rgb(ROW_HOVER_BG)))
            .on_click(
                cx.listener(move |this, _: &ClickEvent, _, cx| on_action(this, action.clone(), cx)),
            );
    }
    out.into_any_element()
}

/// Delete history for one root: the quiet button, or its inline question
/// and answers once asked, plus any error.
struct Purge {
    button: Option<AnyElement>,
    below: Option<Div>,
}

fn purge_parts<T: 'static>(c: &Ctx<'_, T>, root: &str, name: &str, cx: &mut Context<T>) -> Purge {
    let control = Control::Purge(root.to_string());
    let busy = control.busy(c.requests);
    let error = c.model.error(&control).map(|e| error_line(c.lang, e));
    if c.model.purge_asked() == Some(root) {
        let ask = div()
            .flex()
            .flex_wrap()
            .items_center()
            .gap(px(8.0))
            .pt(px(4.0))
            .child(kit::note_line(text(
                c.lang,
                SetupMsg::DeleteHistoryAsk {
                    name: name.to_string(),
                },
            )))
            .child(weighted_button(
                format!("purge:{root}-yes"),
                text(c.lang, SetupMsg::DeleteConfirm),
                Weight::Danger,
                true,
                SettingsAction::PurgeConfirm(root.to_string()),
                cx,
                c.on_action,
            ))
            .child(weighted_button(
                format!("purge:{root}-no"),
                text(c.lang, SetupMsg::DeleteCancel),
                Weight::Quiet,
                true,
                SettingsAction::PurgeCancel,
                cx,
                c.on_action,
            ));
        let below = match error {
            Some(e) => ask.child(e),
            None => ask,
        };
        return Purge {
            button: None,
            below: Some(below),
        };
    }
    let label = if busy {
        SetupMsg::SwitchWorking
    } else {
        SetupMsg::DeleteHistory
    };
    Purge {
        button: Some(
            weighted_button(
                format!("purge-ask:{root}"),
                text(c.lang, label),
                Weight::QuietDanger,
                !busy,
                SettingsAction::PurgeAsk(root.to_string()),
                cx,
                c.on_action,
            )
            .into_any_element(),
        ),
        below: error,
    }
}

fn repo_row<T: 'static>(c: &Ctx<'_, T>, row: &RepoRow, cx: &mut Context<T>) -> AnyElement {
    let control = Control::Repo(row.main.clone());
    let busy = control.busy(c.requests);
    let buttons = row.buttons();
    let status = row.capture.as_ref().unwrap_or(&row.decision);
    let mut label = div()
        .w_full()
        .flex()
        .flex_col()
        .gap(px(2.0))
        .child(name_with_chip(
            row.name.clone(),
            Some((tr(c.lang, status), row.tone)),
        ))
        .child(kit::mono_line(format!(
            "{} \u{b7} {}",
            c.short(&row.main),
            row.size
        )));
    if let Some(error) = &row.capture_error {
        label = label.child(kit::error_text(error.clone()));
    }
    if let Some(error) = c.model.error(&control) {
        label = label.child(error_line(c.lang, error));
    }

    let mut actions = div().flex().items_center().gap(px(4.0));
    if busy {
        actions = actions.child(action_button(
            format!("repo-busy:{}", row.main),
            text(c.lang, SetupMsg::SwitchWorking),
            false,
            SettingsAction::RepoAllow(row.main.clone()),
            cx,
            c.on_action,
        ));
    } else {
        if buttons.allow_enabled {
            actions = actions.child(action_button(
                format!("repo-allow:{}", row.main),
                text(c.lang, SetupMsg::RepoAllow),
                true,
                SettingsAction::RepoAllow(row.main.clone()),
                cx,
                c.on_action,
            ));
        }
        if buttons.second_enabled {
            actions = actions.child(action_button(
                format!("repo-revoke:{}", row.main),
                text(c.lang, buttons.second),
                true,
                SettingsAction::RepoRevoke(row.main.clone()),
                cx,
                c.on_action,
            ));
        }
    }
    if row.offers_delete() {
        let purge = purge_parts(c, &row.main, &row.name, cx);
        if let Some(button) = purge.button {
            actions = actions.child(button);
        }
        if let Some(below) = purge.below {
            label = label.child(below);
        }
    }
    for wt in &row.worktrees {
        let mut line = div()
            .flex()
            .flex_col()
            .pl(px(12.0))
            .child(kit::mono_line(format!(
                "{} \u{b7} {}",
                c.short(&wt.root),
                wt.size
            )));
        if wt.offers_delete() {
            let purge = purge_parts(c, &wt.root, &wt.root, cx);
            let mut gone = div()
                .flex()
                .items_center()
                .gap(px(8.0))
                .child(kit::note_line(text(c.lang, SetupMsg::WorktreeMissing)));
            if let Some(button) = purge.button {
                gone = gone.child(button);
            }
            line = line.child(gone);
            if let Some(below) = purge.below {
                line = line.child(below);
            }
        }
        label = label.child(line);
    }
    kit::row(label, None, Some(actions.into_any_element())).into_any_element()
}

fn remove_section<T: 'static>(c: &Ctx<'_, T>, cx: &mut Context<T>) -> Div {
    let row = match &c.model.remove {
        RemoveFlow::Idle => kit::row(
            text(c.lang, SetupMsg::RemoveRocky),
            Some(text(c.lang, SetupMsg::SettingsRemoveNote)),
            Some(
                weighted_button(
                    "remove-ask".to_string(),
                    text(c.lang, SetupMsg::SettingsRemoveButton),
                    Weight::Danger,
                    true,
                    SettingsAction::RemoveAsk,
                    cx,
                    c.on_action,
                )
                .into_any_element(),
            ),
        ),
        RemoveFlow::Confirm => kit::row(
            text(c.lang, SetupMsg::RemoveAsk),
            None,
            Some(
                div()
                    .flex()
                    .gap(px(4.0))
                    .child(weighted_button(
                        "remove-yes".to_string(),
                        text(c.lang, SetupMsg::RemoveConfirm),
                        Weight::Danger,
                        true,
                        SettingsAction::RemoveConfirm,
                        cx,
                        c.on_action,
                    ))
                    .child(weighted_button(
                        "remove-no".to_string(),
                        text(c.lang, SetupMsg::RemoveCancel),
                        Weight::Quiet,
                        true,
                        SettingsAction::RemoveCancel,
                        cx,
                        c.on_action,
                    ))
                    .into_any_element(),
            ),
        ),
        RemoveFlow::Removing => kit::row(text(c.lang, SetupMsg::RemoveWorking), None, None),
        RemoveFlow::Failed(error) => kit::row(
            kit::error_text(text(
                c.lang,
                SetupMsg::RemoveFailed {
                    error: error.clone(),
                },
            )),
            None,
            Some(
                weighted_button(
                    "remove-retry".to_string(),
                    text(c.lang, SetupMsg::RemoveRetry),
                    Weight::Danger,
                    true,
                    SettingsAction::RemoveConfirm,
                    cx,
                    c.on_action,
                )
                .into_any_element(),
            ),
        ),
    };
    div()
        .mt(px(14.0))
        .child(kit::danger_group(vec![row.into_any_element()]))
}

/// Everything the setup part of Settings shows, from agent tools down to
/// Remove Rocky. Switches and repos wait for the first answers; Remove does
/// not, because removal must work in every state.
pub fn setup_sections<T: 'static>(
    model: &SetupSettings,
    requests: &Requests,
    health: &Health,
    lang: UiLang,
    on_action: OnAction<T>,
    cx: &mut Context<T>,
) -> Div {
    let c = Ctx {
        lang,
        requests,
        model,
        on_action,
        home: std::env::home_dir().map(|p| p.to_string_lossy().into_owned()),
    };
    let mut out = div().flex().flex_col().gap_2();
    if model.shows_agent_tools() {
        let rows = harness_rows(
            model.targets(),
            model.harness_off(),
            &health.setup,
            &clock::local_hhmm,
        );
        let (tools, shell) = split_shell(rows);
        let mut cards: Vec<AnyElement> = Vec::new();
        for row in &tools {
            cards.push(tool_row(
                &c,
                harness_name(&row.harness),
                Some(row),
                row.on,
                Control::Harness(row.harness.clone()),
                SettingsAction::Harness {
                    harness: row.harness.clone(),
                    on: row.on,
                },
                cx,
            ));
        }
        if let Some(on) = model.shell_hook() {
            cards.push(tool_row(
                &c,
                text(lang, SetupMsg::SettingsShell),
                shell.as_ref(),
                on,
                Control::Shell,
                SettingsAction::Shell { on },
                cx,
            ));
        }
        let busy = Control::Reinstall.busy(requests);
        let label = if busy {
            SetupMsg::SwitchWorking
        } else {
            SetupMsg::ReinstallAll
        };
        let mut reinstall = div()
            .flex()
            .flex_col()
            .gap(px(2.0))
            .child(kit::note_line(text(lang, SetupMsg::SettingsReinstallNote)));
        if let Some(error) = model.error(&Control::Reinstall) {
            reinstall = reinstall.child(error_line(lang, error));
        }
        cards.push(
            kit::row(
                reinstall,
                None,
                Some(
                    action_button(
                        "reinstall".to_string(),
                        text(lang, label),
                        !busy,
                        SettingsAction::Reinstall,
                        cx,
                        on_action,
                    )
                    .into_any_element(),
                ),
            )
            .into_any_element(),
        );
        out = out
            .child(kit::section(
                text(lang, SetupMsg::SettingsAgentTools),
                Some(text(lang, SetupMsg::SettingsToolsNote)),
            ))
            .child(kit::group(cards));
    }
    let repos = repo_rows(model.repos(), model.pending(), &health.capture);
    if !repos.is_empty() {
        let rows: Vec<AnyElement> = repos.iter().map(|r| repo_row(&c, r, cx)).collect();
        out = out
            .child(kit::section(
                text(lang, SetupMsg::SettingsRepos),
                Some(text(lang, SetupMsg::SettingsReposNote)),
            ))
            .child(kit::group(rows));
    }
    out.child(remove_section(&c, cx))
}

/// Body lines rendered on the removal-complete screen between the heading and Close button.
pub fn removed_lines(lang: UiLang, home: &str, cleanup_errors: u32) -> Vec<String> {
    let mut lines = vec![text(
        lang,
        SetupMsg::RemovedKeptData {
            path: home.to_string(),
        },
    )];
    if cleanup_errors > 0 {
        lines.push(text(lang, SetupMsg::RemovedCardCleanupFailed));
    }
    lines.push(text(lang, SetupMsg::RemovedUninstall));
    lines.push(UNINSTALL_COMMAND.to_string());
    lines
}

/// The final screen after Remove Rocky: where the data stays and how to
/// remove the command line. Its button quits the desk.
pub fn removed_screen<T: 'static>(
    lang: UiLang,
    home: &str,
    cleanup_errors: u32,
    on_close: fn(&mut T, &mut Context<T>),
    cx: &mut Context<T>,
) -> impl IntoElement {
    let mut out = div()
        .id(SharedString::from("removed"))
        .flex()
        .flex_col()
        .gap_2()
        .p_3()
        .size_full()
        .overflow_y_scroll()
        .bg(rgb(0xF5F5F4))
        .text_color(rgb(0x1C1C1C))
        .child(heading(lang, SetupMsg::RemovedHeading));
    for line in removed_lines(lang, home, cleanup_errors) {
        out = out.child(div().text_sm().child(line));
    }
    out.child(
        div()
            .id(SharedString::from("removed-close"))
            .px_3()
            .py_1()
            .rounded_sm()
            .text_sm()
            .bg(rgb(0xD4D4D4))
            .cursor_pointer()
            .child(text(lang, SetupMsg::RemovedClose))
            .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| on_close(this, cx))),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOTICE_EN: &str = "Some change card files could not be deleted.";
    const NOTICE_ID: &str = "Sebagian file change card tidak dapat dihapus.";

    #[test]
    fn removed_lines_show_card_cleanup_notice_only_when_nonzero() {
        let zero_en = removed_lines(UiLang::En, "C:/Users/me/.rocky", 0);
        assert!(
            !zero_en.iter().any(|line| line == NOTICE_EN),
            "unexpected cleanup notice for 0 errors: {zero_en:?}"
        );
        let one_en = removed_lines(UiLang::En, "C:/Users/me/.rocky", 1);
        assert!(
            one_en.iter().any(|line| line == NOTICE_EN),
            "missing cleanup notice for 1 error: {one_en:?}"
        );

        let zero_id = removed_lines(UiLang::Id, "C:/Users/me/.rocky", 0);
        assert!(!zero_id.iter().any(|line| line == NOTICE_ID), "{zero_id:?}");
        let two_id = removed_lines(UiLang::Id, "C:/Users/me/.rocky", 2);
        assert!(two_id.iter().any(|line| line == NOTICE_ID), "{two_id:?}");
    }
}
