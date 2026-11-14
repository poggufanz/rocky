//! Render trees for the Settings setup sections and the final removed screen.
//! Every decision comes from `setup_settings`; buttons only name an action.

use gpui::prelude::*;
use gpui::{ClickEvent, Context, Div, IntoElement, SharedString, Stateful, div, rgb};
use rocky_proto::pipe::Health;

use crate::clock;
use crate::i18n::{Msg, SetupMsg, UiLang, tr};
use crate::requests::Requests;
use crate::settings_view::toggle_row;
use crate::setup_settings::{
    Control, HarnessRow, RemoveFlow, RepoRow, SetupSettings, UNINSTALL_COMMAND, harness_rows,
    repo_rows,
};

const ERROR_COLOR: u32 = 0xD92B2B;
const MUTED_COLOR: u32 = 0x6B6B6B;

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
    div().text_xs().text_color(rgb(ERROR_COLOR)).child(text(
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
    let mut b = div()
        .id(SharedString::from(id))
        .px_3()
        .py_1()
        .rounded_sm()
        .text_sm()
        .bg(rgb(if enabled { 0xD4D4D4 } else { 0xEDEDEC }))
        .child(label);
    if enabled {
        b = b.cursor_pointer().on_click(
            cx.listener(move |this, _: &ClickEvent, _, cx| on_action(this, action.clone(), cx)),
        );
    }
    b
}

fn heading(lang: UiLang, m: SetupMsg) -> Div {
    div().text_base().child(text(lang, m))
}

struct Ctx<'a, T: 'static> {
    lang: UiLang,
    requests: &'a Requests,
    model: &'a SetupSettings,
    on_action: OnAction<T>,
}

fn harness_row<T: 'static>(c: &Ctx<'_, T>, row: &HarnessRow, cx: &mut Context<T>) -> Div {
    let control = Control::Harness(row.harness.clone());
    let busy = control.busy(c.requests);
    let state = if busy {
        text(c.lang, SetupMsg::SwitchWorking)
    } else {
        tr(c.lang, &row.state)
    };
    let action = SettingsAction::Harness {
        harness: row.harness.clone(),
        on: row.on,
    };
    let on_action = c.on_action;
    let mut out = div().flex_col().gap_1().child(toggle_row(
        SharedString::from(format!("harness:{}", row.harness)),
        format!("{} \u{b7} {state}", row.harness),
        row.on,
        !busy,
        cx.listener(move |this, _: &ClickEvent, _, cx| on_action(this, action.clone(), cx)),
    ));
    for path in &row.paths {
        out = out.child(
            div()
                .pl_4()
                .text_xs()
                .text_color(rgb(MUTED_COLOR))
                .child(path.clone()),
        );
    }
    if let Some(error) = c.model.error(&control) {
        out = out.child(error_line(c.lang, error));
    }
    out
}

fn shell_row<T: 'static>(c: &Ctx<'_, T>, on: bool, cx: &mut Context<T>) -> Div {
    let control = Control::Shell;
    let busy = control.busy(c.requests);
    let mut label = text(c.lang, SetupMsg::SettingsShell);
    if busy {
        label = format!("{label} \u{b7} {}", text(c.lang, SetupMsg::SwitchWorking));
    }
    let on_action = c.on_action;
    let mut out = div().flex_col().gap_1().child(toggle_row(
        SharedString::from("shell-hook"),
        label,
        on,
        !busy,
        cx.listener(move |this, _: &ClickEvent, _, cx| {
            on_action(this, SettingsAction::Shell { on }, cx)
        }),
    ));
    if let Some(error) = c.model.error(&control) {
        out = out.child(error_line(c.lang, error));
    }
    out
}

fn confirm_buttons<T: 'static>(
    c: &Ctx<'_, T>,
    id: &str,
    yes: (SetupMsg, SettingsAction),
    no: (SetupMsg, SettingsAction),
    cx: &mut Context<T>,
) -> Div {
    div()
        .flex()
        .gap_2()
        .child(action_button(
            format!("{id}-yes"),
            text(c.lang, yes.0),
            true,
            yes.1,
            cx,
            c.on_action,
        ))
        .child(action_button(
            format!("{id}-no"),
            text(c.lang, no.0),
            true,
            no.1,
            cx,
            c.on_action,
        ))
}

/// Delete history for one root, with its inline two-step confirmation.
fn purge_control<T: 'static>(c: &Ctx<'_, T>, root: &str, name: &str, cx: &mut Context<T>) -> Div {
    let control = Control::Purge(root.to_string());
    let busy = control.busy(c.requests);
    let mut out = div().flex_col().gap_1();
    if c.model.purge_asked() == Some(root) {
        out = out
            .child(div().text_xs().child(text(
                c.lang,
                SetupMsg::DeleteHistoryAsk {
                    name: name.to_string(),
                },
            )))
            .child(confirm_buttons(
                c,
                &format!("purge:{root}"),
                (
                    SetupMsg::DeleteConfirm,
                    SettingsAction::PurgeConfirm(root.to_string()),
                ),
                (SetupMsg::DeleteCancel, SettingsAction::PurgeCancel),
                cx,
            ));
    } else {
        let label = if busy {
            SetupMsg::SwitchWorking
        } else {
            SetupMsg::DeleteHistory
        };
        out = out.child(action_button(
            format!("purge-ask:{root}"),
            text(c.lang, label),
            !busy,
            SettingsAction::PurgeAsk(root.to_string()),
            cx,
            c.on_action,
        ));
    }
    if let Some(error) = c.model.error(&control) {
        out = out.child(error_line(c.lang, error));
    }
    out
}

fn repo_block<T: 'static>(c: &Ctx<'_, T>, row: &RepoRow, cx: &mut Context<T>) -> Div {
    let control = Control::Repo(row.main.clone());
    let busy = control.busy(c.requests);
    let buttons = row.buttons();
    let mut out = div().flex_col().gap_1().child(
        div()
            .flex()
            .gap_2()
            .text_sm()
            .child(row.name.clone())
            .child(div().text_color(rgb(MUTED_COLOR)).child(format!(
                "{} \u{b7} {}",
                tr(c.lang, &row.decision),
                row.size
            ))),
    );
    out = out.child(
        div()
            .text_xs()
            .text_color(rgb(MUTED_COLOR))
            .child(row.main.clone()),
    );
    if let Some(capture) = &row.capture {
        out = out.child(div().text_xs().child(tr(c.lang, capture)));
    }
    let (allow_label, revoke_label) = if busy {
        (SetupMsg::SwitchWorking, SetupMsg::SwitchWorking)
    } else {
        (SetupMsg::RepoAllow, buttons.second)
    };
    out = out.child(
        div()
            .flex()
            .gap_2()
            .child(action_button(
                format!("repo-allow:{}", row.main),
                text(c.lang, allow_label),
                !busy && buttons.allow_enabled,
                SettingsAction::RepoAllow(row.main.clone()),
                cx,
                c.on_action,
            ))
            .child(action_button(
                format!("repo-revoke:{}", row.main),
                text(c.lang, revoke_label),
                !busy && buttons.second_enabled,
                SettingsAction::RepoRevoke(row.main.clone()),
                cx,
                c.on_action,
            )),
    );
    if let Some(error) = c.model.error(&control) {
        out = out.child(error_line(c.lang, error));
    }
    if row.offers_delete() {
        out = out.child(purge_control(c, &row.main, &row.name, cx));
    }
    for wt in &row.worktrees {
        let mut line = div().flex_col().pl_3().child(
            div()
                .text_xs()
                .child(format!("{} \u{b7} {}", wt.root, wt.size)),
        );
        if wt.offers_delete() {
            line = line
                .child(
                    div()
                        .text_xs()
                        .text_color(rgb(MUTED_COLOR))
                        .child(text(c.lang, SetupMsg::WorktreeMissing)),
                )
                .child(purge_control(c, &wt.root, &wt.root, cx));
        }
        out = out.child(line);
    }
    out
}

fn remove_section<T: 'static>(c: &Ctx<'_, T>, cx: &mut Context<T>) -> Div {
    let mut out = div().flex_col().gap_1();
    match &c.model.remove {
        RemoveFlow::Idle => {
            out = out.child(action_button(
                "remove-ask".to_string(),
                text(c.lang, SetupMsg::RemoveRocky),
                true,
                SettingsAction::RemoveAsk,
                cx,
                c.on_action,
            ));
        }
        RemoveFlow::Confirm => {
            out = out
                .child(div().text_sm().child(text(c.lang, SetupMsg::RemoveAsk)))
                .child(confirm_buttons(
                    c,
                    "remove",
                    (SetupMsg::RemoveConfirm, SettingsAction::RemoveConfirm),
                    (SetupMsg::RemoveCancel, SettingsAction::RemoveCancel),
                    cx,
                ));
        }
        RemoveFlow::Removing => {
            out = out.child(div().text_sm().child(text(c.lang, SetupMsg::RemoveWorking)));
        }
        RemoveFlow::Failed(error) => {
            out = out
                .child(div().text_sm().text_color(rgb(ERROR_COLOR)).child(text(
                    c.lang,
                    SetupMsg::RemoveFailed {
                        error: error.clone(),
                    },
                )))
                .child(action_button(
                    "remove-retry".to_string(),
                    text(c.lang, SetupMsg::RemoveRetry),
                    true,
                    SettingsAction::RemoveConfirm,
                    cx,
                    c.on_action,
                ));
        }
    }
    out
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
    };
    let mut out = div().flex().flex_col().gap_2();
    if model.shows_agent_tools() {
        out = out.child(heading(lang, SetupMsg::SettingsAgentTools));
        let rows = harness_rows(
            model.targets(),
            model.harness_off(),
            &health.setup,
            &clock::local_hhmm,
        );
        for row in &rows {
            out = out.child(harness_row(&c, row, cx));
        }
        if let Some(on) = model.shell_hook() {
            out = out.child(shell_row(&c, on, cx));
        }
        let busy = Control::Reinstall.busy(requests);
        let label = if busy {
            SetupMsg::SwitchWorking
        } else {
            SetupMsg::ReinstallAll
        };
        out = out.child(action_button(
            "reinstall".to_string(),
            text(lang, label),
            !busy,
            SettingsAction::Reinstall,
            cx,
            on_action,
        ));
        if let Some(error) = model.error(&Control::Reinstall) {
            out = out.child(error_line(lang, error));
        }
    }
    let repos = repo_rows(model.repos(), model.pending(), &health.capture);
    if !repos.is_empty() {
        out = out.child(heading(lang, SetupMsg::SettingsRepos));
        for row in &repos {
            out = out.child(repo_block(&c, row, cx));
        }
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
