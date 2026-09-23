mod entries;
mod feeds;
mod modal;
mod settings;

use crate::common::ago;
use crate::state::{App, Filter, InputKind, Modal, Page};
use ratatui::{
    Frame,
    layout::{Alignment, Rect},
    style::{Color, Modifier, Style},
    widgets::{Block, Borders, Clear, Paragraph, Wrap},
};
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

#[derive(Clone, PartialEq, Eq)]
pub enum Hit {
    Nav(Page),
    Filter(Filter),
    Refresh,
    Help,
    Failures,
    OpenEntry(String),
    Select(String),
    Star(String),
    Read(String),
    MarkAll,
    OpenUnread,
    Bulk(&'static str),
    ClearSelection,
    Feed(String),
    DeleteFeed(String),
    AddFeed,
    Import,
    Export,
    Setting(usize),
    ModalConfirm,
    ModalCancel,
}

#[derive(Clone, Copy)]
pub struct Palette {
    pub blue: Color,
    pub orange: Color,
    pub yellow: Color,
    pub red: Color,
    pub green: Color,
    pub muted: Color,
}

impl Palette {
    pub fn new(light: bool) -> Self {
        let rgb = |r, g, b| Color::Rgb(r, g, b);
        if light {
            Self {
                blue: rgb(32, 94, 166),
                orange: rgb(188, 82, 21),
                yellow: rgb(173, 131, 1),
                red: rgb(175, 48, 41),
                green: rgb(102, 128, 11),
                muted: rgb(111, 110, 105),
            }
        } else {
            Self {
                blue: rgb(67, 133, 190),
                orange: rgb(218, 112, 44),
                yellow: rgb(208, 162, 21),
                red: rgb(209, 77, 65),
                green: rgb(135, 154, 57),
                muted: rgb(159, 157, 150),
            }
        }
    }
}

pub(super) fn area(x: u16, y: u16, width: u16, height: u16) -> Rect {
    Rect::new(x, y, width, height)
}
pub(super) fn text(frame: &mut Frame, value: impl ToString, rect: Rect, style: Style) {
    if rect.width > 0 && rect.height > 0 {
        frame.render_widget(Paragraph::new(value.to_string()).style(style), rect);
    }
}
pub(super) fn fit(value: &str, width: usize) -> String {
    if UnicodeWidthStr::width(value) <= width {
        return value.to_owned();
    }
    if width == 0 {
        return String::new();
    }
    let mut output = String::new();
    let mut used = 0;
    for ch in value.chars() {
        let cells = ch.width().unwrap_or(0);
        if used + cells >= width {
            break;
        }
        output.push(ch);
        used += cells;
    }
    output.push('…');
    output
}
pub(super) fn hit(app: &mut App, rect: Rect, target: Hit) {
    if rect.width > 0 && rect.height > 0 {
        app.hits.push((rect, target));
    }
}
pub(super) fn muted(color: Color) -> Style {
    Style::default().fg(color)
}
pub(super) fn accent(color: Color) -> Style {
    Style::default().fg(color).add_modifier(Modifier::BOLD)
}
pub(super) fn label(
    frame: &mut Frame,
    app: &mut App,
    value: &str,
    rect: Rect,
    style: Style,
    target: Hit,
) {
    let value = fit(value, rect.width as usize);
    let width = UnicodeWidthStr::width(value.as_str()) as u16;
    let style = if app.hovered.as_ref() == Some(&target) {
        style.add_modifier(Modifier::UNDERLINED)
    } else {
        style
    };
    text(frame, value, area(rect.x, rect.y, width, 1), style);
    hit(app, area(rect.x, rect.y, width, 1), target);
}

pub fn draw(frame: &mut Frame, app: &mut App) {
    let root = frame.area();
    if root.width < 38 || root.height < 12 {
        text(
            frame,
            "Feedreader needs at least 38 × 12",
            root,
            accent(app.palette.blue),
        );
        return;
    }
    let width = root.width.saturating_sub(4).min(96);
    let x = root.x + (root.width - width) / 2;
    let top = root.y;
    let footer = root.bottom().saturating_sub(2);
    let content = area(x, top + 3, width, footer.saturating_sub(top + 3));
    header(frame, app, area(x, top, width, 3));
    match app.page {
        Page::Feeds => feeds::feeds(frame, app, content),
        Page::Settings => settings::settings(frame, app, content),
        _ => entries::entries(frame, app, content),
    }
    footer_bar(frame, app, area(x, footer, width, 2));
    if app.modal.is_some() {
        frame.render_widget(
            Block::default().style(Style::default().add_modifier(Modifier::DIM)),
            root,
        );
        app.hits.clear();
        modal::modal(frame, app, root);
    }
}

fn header(frame: &mut Frame, app: &mut App, rect: Rect) {
    text(
        frame,
        "◆  Feedreader",
        area(rect.x, rect.y, 25.min(rect.width), 1),
        accent(app.palette.blue),
    );
    let status = if !app.online {
        "connecting…".to_owned()
    } else if app.status.refreshing {
        format!(
            "checking {}/{} · {} new",
            app.status.completed, app.status.total, app.status.count
        )
    } else if app.status.error.is_some() {
        "refresh failed".into()
    } else if app.status.failed > 0 {
        format!("{} feeds failing", app.status.failed)
    } else {
        "up to date".into()
    };
    let status_width = (status.chars().count() as u16 + 2).min(rect.width / 2);
    let status_rect = area(rect.right() - status_width, rect.y, status_width, 1);
    let status_style = if app.status.error.is_some() {
        accent(app.palette.red)
    } else if app.status.failed > 0 {
        accent(app.palette.yellow)
    } else if app.online && !app.status.refreshing {
        muted(app.palette.green)
    } else {
        muted(app.palette.muted)
    };
    frame.render_widget(
        Paragraph::new(status)
            .style(status_style)
            .alignment(Alignment::Right),
        status_rect,
    );
    if app.status.error.is_some() || app.status.failed > 0 {
        hit(app, status_rect, Hit::Failures);
    }

    let tabs = if rect.width < 60 {
        [
            ("1 Time", Page::Timeline),
            ("2 Star", Page::Starred),
            ("3 Feed", Page::Feeds),
            ("4 Set", Page::Settings),
        ]
    } else {
        [
            ("1 Timeline", Page::Timeline),
            ("2 Starred", Page::Starred),
            ("3 Feeds", Page::Feeds),
            ("4 Settings", Page::Settings),
        ]
    };
    let mut tab_x = rect.x;
    for (name, page) in tabs {
        let width = name.len() as u16 + 2;
        let active = std::mem::discriminant(&app.page) == std::mem::discriminant(&page)
            || matches!((&app.page, &page), (Page::Feed(_), Page::Feeds));
        label(
            frame,
            app,
            name,
            area(
                tab_x,
                rect.y + 1,
                width.min(rect.right().saturating_sub(tab_x)),
                1,
            ),
            if active {
                accent(app.palette.blue)
            } else {
                muted(app.palette.muted)
            },
            Hit::Nav(page),
        );
        tab_x += width + 1;
    }
    if rect.width > 81 {
        label(
            frame,
            app,
            "r Refresh",
            area(rect.right() - 20, rect.y + 1, 10, 1),
            muted(app.palette.muted),
            Hit::Refresh,
        );
        label(
            frame,
            app,
            "? Help",
            area(rect.right() - 9, rect.y + 1, 8, 1),
            muted(app.palette.muted),
            Hit::Help,
        );
    }
    text(
        frame,
        "─".repeat(rect.width as usize),
        area(rect.x, rect.y + 2, rect.width, 1),
        muted(app.palette.muted).add_modifier(Modifier::DIM),
    );
}

fn footer_bar(frame: &mut Frame, app: &mut App, rect: Rect) {
    text(
        frame,
        "─".repeat(rect.width as usize),
        area(rect.x, rect.y, rect.width, 1),
        muted(app.palette.muted).add_modifier(Modifier::DIM),
    );
    let y = rect.y + 1;
    if !app.selected.is_empty() {
        let count = format!("{} selected", app.selected.len());
        let compact = rect.width < 70;
        let count_width = (UnicodeWidthStr::width(count.as_str()) as u16 + 2).min(14);
        text(
            frame,
            count,
            area(rect.x, y, count_width, 1),
            accent(app.palette.blue),
        );
        let actions = if compact {
            [
                ("[M]", "read"),
                ("[U]", "unread"),
                ("[O]", "open"),
                ("[S]", "star"),
            ]
        } else {
            [
                ("[M] Read", "read"),
                ("[U] Unread", "unread"),
                ("[O] Open", "open"),
                ("[S] Star", "star"),
            ]
        };
        let mut x = rect.x + count_width;
        for (name, action) in actions {
            let width = if compact { 4 } else { 11 };
            label(
                frame,
                app,
                name,
                area(x, y, width.min(rect.right().saturating_sub(x)), 1),
                muted(app.palette.blue),
                Hit::Bulk(action),
            );
            x += width;
        }
        label(
            frame,
            app,
            if compact { "[Esc]" } else { "[Esc] Clear" },
            area(x, y, 11.min(rect.right().saturating_sub(x)), 1),
            muted(app.palette.muted),
            Hit::ClearSelection,
        );
    } else if let Some(notice) = &app.notice {
        text(
            frame,
            notice.clone(),
            area(rect.x, y, rect.width, 1),
            muted(app.palette.yellow),
        );
    } else {
        let hint = match app.hovered.as_ref() {
            Some(Hit::Star(_)) => "Star or unstar this entry  ·  s",
            Some(Hit::Read(_)) => "Mark this entry read or unread  ·  m",
            Some(Hit::Select(_)) => "Select this entry for bulk actions  ·  x",
            Some(Hit::DeleteFeed(_)) => "Remove this feed and its entries  ·  d",
            _ => match app.page {
                Page::Feeds => "j/k move · Enter open · a add · d remove · ? help · q quit",
                Page::Settings => "j/k move · Enter edit · ? help · q quit",
                _ => "j/k move · Enter open · x select · m read · s star · ? help · q quit",
            },
        };
        let hint = if rect.width < 45 {
            match app.page {
                Page::Feeds => "j/k move · a add · ? help",
                Page::Settings => "j/k move · ↵ edit · ? help",
                _ => "j/k move · ↵ open · ? help",
            }
        } else if rect.width < 60 && app.hovered.is_none() {
            match app.page {
                Page::Feeds => "j/k move · ↵ open · a add · d remove · ? help",
                Page::Settings => "j/k move · ↵ edit · ? help · q quit",
                _ => "j/k move · ↵ open · x select · m read · s star · ?",
            }
        } else {
            hint
        };
        text(
            frame,
            fit(hint, rect.width as usize),
            area(rect.x, y, rect.width, 1),
            muted(app.palette.muted),
        );
    }
}
