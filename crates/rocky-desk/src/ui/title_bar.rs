//! The desk's own title bar: mark, view tabs, and on Windows the caption
//! buttons. Windows opens the window without the system bar
//! (`appears_transparent`), so there this row is also the drag handle and
//! double-click maximizes. Elsewhere the system bar stays and this row only
//! carries the tabs.

use std::sync::{Arc, OnceLock};

use gpui::prelude::*;
use gpui::{
    Context, Div, FontWeight, Image, ImageFormat, SharedString, Stateful, Window,
    WindowControlArea, div, img, px, rgb,
};

use crate::i18n::{Msg, UiLang, tr};
use crate::ui::tooltip::{BORDER_SUBTLE, CARD_BG, LINK, SURFACE_SUBTLE, TEXT_DARK, TEXT_SUBTLE};

/// Bar height; also the caption button height, as in the system bar.
pub const TITLE_BAR_H: f32 = 34.0;

const CAPTION_W: f32 = 46.0;
const CAPTION_HOVER_BG: u32 = 0xE7E5E4;
/// Windows' own close-hover red; white glyph on it is 5.7:1.
const CLOSE_HOVER_BG: u32 = 0xC42B1C;
const TAB_HOVER_BG: u32 = 0xEBEAE8;

/// The pages the tabs switch between.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Tab {
    #[default]
    Agents,
    Flow,
    Settings,
}

impl Tab {
    pub const ALL: [Tab; 3] = [Tab::Agents, Tab::Flow, Tab::Settings];

    fn label(self) -> Msg {
        match self {
            Tab::Agents => Msg::ViewAgents,
            Tab::Flow => Msg::ViewFlow,
            Tab::Settings => Msg::ViewSettings,
        }
    }
}

/// Called when a tab is chosen.
pub type OnTab<T> = fn(&mut T, Tab, &mut Window, &mut Context<T>);

/// Whether the desk draws the caption itself (drag area and window buttons).
pub const fn custom_caption() -> bool {
    cfg!(windows)
}

/// The mark from the app icon, decoded once.
fn mark() -> Arc<Image> {
    static MARK: OnceLock<Arc<Image>> = OnceLock::new();
    MARK.get_or_init(|| {
        Arc::new(Image::from_bytes(
            ImageFormat::Png,
            include_bytes!("../../assets/rocky-mark.png").to_vec(),
        ))
    })
    .clone()
}

/// Title bar. `active` is `None` on screens without tabs (consent, removed).
pub fn title_bar<T: 'static>(
    lang: UiLang,
    active: Option<Tab>,
    window: &Window,
    cx: &mut Context<T>,
    on_tab: OnTab<T>,
) -> Div {
    let caption = custom_caption();
    let mut bar = div()
        .flex()
        .flex_none()
        .items_center()
        .w_full()
        .h(px(TITLE_BAR_H))
        .bg(rgb(SURFACE_SUBTLE))
        .border_b_1()
        .border_color(rgb(BORDER_SUBTLE));

    let brand = div()
        .id(SharedString::from("title-brand"))
        .flex()
        .flex_none()
        .items_center()
        .gap(px(7.0))
        .h_full()
        .pl(px(12.0))
        .pr(px(12.0))
        .child(img(mark()).size(px(16.0)).flex_none())
        .child(
            div()
                .text_size(px(13.0))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(rgb(TEXT_DARK))
                .child("rocky"),
        );
    bar = bar.child(drag(brand, caption));

    if let Some(active) = active {
        let mut tabs = div().flex().flex_none().items_center().gap(px(2.0));
        for tab in Tab::ALL {
            tabs = tabs.child(tab_button(lang, tab, tab == active, cx, on_tab));
        }
        bar = bar.child(tabs);
    }

    bar = bar.child(drag(
        div().id(SharedString::from("title-drag")).flex_1().h_full(),
        caption,
    ));

    if caption {
        bar = bar.child(caption_buttons(window));
    }
    bar
}

/// Marks a bar segment as the window's drag handle. Only segments without
/// controls get it: Windows treats the whole hit area as caption, so a tab
/// inside it would never receive the click.
fn drag(el: Stateful<Div>, caption: bool) -> Stateful<Div> {
    if caption {
        el.window_control_area(WindowControlArea::Drag)
    } else {
        el
    }
}

fn tab_button<T: 'static>(
    lang: UiLang,
    tab: Tab,
    selected: bool,
    cx: &mut Context<T>,
    on_tab: OnTab<T>,
) -> Stateful<Div> {
    let button = div()
        .id(SharedString::from(format!("tab-{tab:?}")))
        .tab_index(0)
        .px(px(10.0))
        .py(px(3.0))
        .rounded(px(6.0))
        .border_1()
        .text_size(px(12.5))
        .cursor_pointer()
        .focus(|s| s.border_color(rgb(LINK)))
        .on_click(cx.listener(move |this, _, window, cx| on_tab(this, tab, window, cx)))
        .child(tr(lang, &tab.label()));
    if selected {
        button
            .bg(rgb(CARD_BG))
            .border_color(rgb(BORDER_SUBTLE))
            .font_weight(FontWeight::MEDIUM)
            .text_color(rgb(TEXT_DARK))
    } else {
        button
            .border_color(gpui::transparent_black())
            .text_color(rgb(TEXT_SUBTLE))
            .hover(|s| s.bg(rgb(TAB_HOVER_BG)).text_color(rgb(TEXT_DARK)))
            .active(|s| s.bg(rgb(BORDER_SUBTLE)))
    }
}

/// Minimize, maximize or restore, and close. Windows handles the clicks as
/// its own caption buttons, so close still goes through the desk's close
/// handler (hide to tray) and snap layouts still show on maximize hover.
fn caption_buttons(window: &Window) -> Div {
    // Segoe MDL2 Assets ships with Windows 10 and 11; these are its caption glyphs.
    let max_glyph = if window.is_maximized() {
        "\u{E923}"
    } else {
        "\u{E922}"
    };
    div()
        .flex()
        .flex_none()
        .h_full()
        .child(caption_button(
            "caption-min",
            "\u{E921}",
            WindowControlArea::Min,
            false,
        ))
        .child(caption_button(
            "caption-max",
            max_glyph,
            WindowControlArea::Max,
            false,
        ))
        .child(caption_button(
            "caption-close",
            "\u{E8BB}",
            WindowControlArea::Close,
            true,
        ))
}

fn caption_button(
    id: &'static str,
    glyph: &'static str,
    area: WindowControlArea,
    close: bool,
) -> Stateful<Div> {
    let button = div()
        .id(SharedString::from(id))
        .flex()
        .items_center()
        .justify_center()
        .w(px(CAPTION_W))
        .h_full()
        .font_family("Segoe MDL2 Assets")
        .text_size(px(10.0))
        .text_color(rgb(TEXT_DARK))
        .window_control_area(area)
        .child(glyph);
    if close {
        button.hover(|s| s.bg(rgb(CLOSE_HOVER_BG)).text_color(gpui::white()))
    } else {
        button.hover(|s| s.bg(rgb(CAPTION_HOVER_BG)))
    }
}
