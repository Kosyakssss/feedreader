use crate::{App, Filter, InputKind, Modal, Page, ago};
use ratatui::{
    Frame,
    layout::{Alignment, Rect},
    style::{Color, Modifier, Style},
    widgets::{Block, Borders, Clear, Paragraph, Wrap},
};

#[derive(Clone, PartialEq, Eq)]
pub enum Hit {
    Nav(Page),
    Filter(Filter),
    Refresh,
    Help,
    Failures,
    Entry(String),
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

fn area(x: u16, y: u16, width: u16, height: u16) -> Rect {
    Rect::new(x, y, width, height)
}
fn text(frame: &mut Frame, value: impl ToString, rect: Rect, style: Style) {
    if rect.width > 0 && rect.height > 0 {
        frame.render_widget(Paragraph::new(value.to_string()).style(style), rect);
    }
}
fn hit(app: &mut App, rect: Rect, target: Hit) {
    if rect.width > 0 && rect.height > 0 {
        app.hits.push((rect, target));
    }
}
fn muted(color: Color) -> Style {
    Style::default().fg(color)
}
fn accent(color: Color) -> Style {
    Style::default().fg(color).add_modifier(Modifier::BOLD)
}
fn label(frame: &mut Frame, app: &mut App, value: &str, rect: Rect, style: Style, target: Hit) {
    let style = if app.hovered.as_ref() == Some(&target) {
        style.add_modifier(Modifier::UNDERLINED | Modifier::BOLD)
    } else {
        style
    };
    text(frame, value.to_owned(), rect, style);
    hit(app, rect, target);
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
    let width = root.width.saturating_sub(2).min(104);
    let x = root.x + (root.width - width) / 2;
    let top = root.y;
    let footer = root.bottom().saturating_sub(2);
    let content = area(x, top + 4, width, footer.saturating_sub(top + 4));
    header(frame, app, area(x, top, width, 4));
    match app.page {
        Page::Feeds => feeds(frame, app, content),
        Page::Settings => settings(frame, app, content),
        _ => entries(frame, app, content),
    }
    footer_bar(frame, app, area(x, footer, width, 2));
    if app.modal.is_some() {
        modal(frame, app, root);
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
    hit(app, status_rect, Hit::Failures);

    let tabs = [
        ("1 Timeline", Page::Timeline),
        ("2 Starred", Page::Starred),
        ("3 Feeds", Page::Feeds),
        ("4 Settings", Page::Settings),
    ];
    let mut tab_x = rect.x;
    for (name, page) in tabs {
        let width = name.len() as u16 + 2;
        let active = std::mem::discriminant(&app.page) == std::mem::discriminant(&page);
        label(
            frame,
            app,
            name,
            area(
                tab_x,
                rect.y + 2,
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
            area(rect.right() - 20, rect.y + 2, 10, 1),
            muted(app.palette.muted),
            Hit::Refresh,
        );
        label(
            frame,
            app,
            "? Help",
            area(rect.right() - 9, rect.y + 2, 8, 1),
            muted(app.palette.muted),
            Hit::Help,
        );
    }
    text(
        frame,
        "─".repeat(rect.width as usize),
        area(rect.x, rect.y + 3, rect.width, 1),
        muted(app.palette.muted).add_modifier(Modifier::DIM),
    );
}

fn entries(frame: &mut Frame, app: &mut App, rect: Rect) {
    let title = match &app.page {
        Page::Timeline => "Timeline".to_owned(),
        Page::Starred => "Starred".to_owned(),
        Page::Feed(id) => app
            .feeds
            .feeds
            .iter()
            .find(|feed| &feed.id == id)
            .map_or("Feed".into(), |feed| feed.label.clone()),
        _ => String::new(),
    };
    let (total, unread) = app.counts();
    text(
        frame,
        format!("{title}  ·  {unread} unread"),
        area(rect.x, rect.y, rect.width, 1),
        Style::default().add_modifier(Modifier::BOLD),
    );
    let actions_y = rect.y + 2;
    if app.page != Page::Starred {
        let filters = [
            ("All", Filter::All, total),
            ("Unread", Filter::Unread, unread),
            ("Read", Filter::Read, total - unread),
        ];
        let mut x = rect.x;
        for (name, filter, count) in filters {
            let label_text = format!("{name} {count}");
            let width = label_text.chars().count() as u16 + 3;
            label(
                frame,
                app,
                &label_text,
                area(x, actions_y, width.min(rect.right().saturating_sub(x)), 1),
                if app.filter == filter {
                    accent(app.palette.blue)
                } else {
                    muted(app.palette.muted)
                },
                Hit::Filter(filter),
            );
            x += width;
        }
    }
    if rect.width > 72 {
        label(
            frame,
            app,
            "Open unread",
            area(rect.right() - 32, actions_y, 12, 1),
            muted(app.palette.blue),
            Hit::OpenUnread,
        );
        label(
            frame,
            app,
            "Mark all read",
            area(rect.right() - 17, actions_y, 15, 1),
            muted(app.palette.blue),
            Hit::MarkAll,
        );
    }
    let list_top = rect.y + 4;
    let list_height = rect.bottom().saturating_sub(list_top) as usize;
    let rows = (list_height / 2).max(1);
    app.visible_rows = rows;
    let visible = app.visible();
    app.scroll = app.scroll.min(visible.len().saturating_sub(rows));
    if visible.is_empty() {
        text(
            frame,
            if app.complete {
                "No entries"
            } else {
                "Loading saved entries…"
            },
            area(rect.x, list_top + 2, rect.width, 1),
            muted(app.palette.muted),
        );
        return;
    }
    for (slot, entry_index) in visible.iter().skip(app.scroll).take(rows).enumerate() {
        let entry = &app.entries[*entry_index];
        let id = entry.id.clone();
        let state = app.state(entry);
        let title = if entry.title.is_empty() {
            "Untitled".to_owned()
        } else {
            entry.title.clone()
        };
        let meta = format!("{}  ·  {}", entry.feed_label, ago(&entry.published));
        let y = list_top + slot as u16 * 2;
        let row = area(
            rect.x,
            y,
            rect.width,
            2.min(rect.bottom().saturating_sub(y)),
        );
        hit(app, row, Hit::Entry(id.clone()));
        let checked = app.selected.contains(&id);
        let focused = app.focused.as_deref() == Some(&id);
        let check = if checked { "☑" } else { "□" };
        label(
            frame,
            app,
            check,
            area(rect.x, y, 3, 1),
            if checked {
                accent(app.palette.blue)
            } else {
                muted(app.palette.muted)
            },
            Hit::Select(id.clone()),
        );
        let title_width = rect.width.saturating_sub(14);
        let hovered = app.hovered.as_ref() == Some(&Hit::Entry(id.clone()));
        let title_style = if focused || hovered {
            accent(app.palette.blue)
        } else if state.read.unwrap_or(false) {
            muted(app.palette.muted)
        } else {
            Style::default().add_modifier(Modifier::BOLD)
        };
        label(
            frame,
            app,
            &title,
            area(rect.x + 4, y, title_width, 1),
            title_style,
            Hit::OpenEntry(id.clone()),
        );
        let star = if state.starred.unwrap_or(false) {
            "★"
        } else {
            "☆"
        };
        label(
            frame,
            app,
            star,
            area(rect.right() - 7, y, 3, 1),
            if state.starred.unwrap_or(false) {
                accent(app.palette.orange)
            } else {
                muted(app.palette.muted)
            },
            Hit::Star(id.clone()),
        );
        let mark = if state.read.unwrap_or(false) {
            "○"
        } else {
            "●"
        };
        label(
            frame,
            app,
            mark,
            area(rect.right() - 3, y, 3, 1),
            if state.read.unwrap_or(false) {
                muted(app.palette.muted)
            } else {
                accent(app.palette.blue)
            },
            Hit::Read(id.clone()),
        );
        text(
            frame,
            meta,
            area(rect.x + 4, y + 1, rect.width.saturating_sub(4), 1),
            muted(app.palette.muted),
        );
    }
    if visible.len() > rows {
        let progress = format!(
            "{}–{} / {}",
            app.scroll + 1,
            (app.scroll + rows).min(visible.len()),
            visible.len()
        );
        let width = progress.len() as u16;
        frame.render_widget(
            Paragraph::new(progress)
                .style(muted(app.palette.muted))
                .alignment(Alignment::Right),
            area(
                rect.right().saturating_sub(width),
                rect.bottom().saturating_sub(1),
                width,
                1,
            ),
        );
    }
}

fn feeds(frame: &mut Frame, app: &mut App, rect: Rect) {
    let unread = app
        .entries
        .iter()
        .filter(|entry| !app.state(entry).read.unwrap_or(false))
        .count();
    let issues = app
        .feeds
        .health
        .values()
        .filter(|health| health.error.is_some())
        .count();
    text(
        frame,
        "Feeds",
        area(rect.x, rect.y, rect.width, 1),
        Style::default().add_modifier(Modifier::BOLD),
    );
    text(
        frame,
        format!(
            "{} sources · {unread} unread{}",
            app.feeds.feeds.len(),
            if issues > 0 {
                format!(" · {issues} issues")
            } else {
                String::new()
            }
        ),
        area(rect.x, rect.y + 1, rect.width, 1),
        muted(app.palette.muted),
    );
    label(
        frame,
        app,
        "＋ Add feed",
        area(rect.x, rect.y + 3, 14, 1),
        accent(app.palette.blue),
        Hit::AddFeed,
    );
    label(
        frame,
        app,
        "Import OPML",
        area(rect.x + 16, rect.y + 3, 15, 1),
        muted(app.palette.blue),
        Hit::Import,
    );
    label(
        frame,
        app,
        "Export OPML",
        area(rect.x + 33, rect.y + 3, 15, 1),
        muted(app.palette.blue),
        Hit::Export,
    );
    let top = rect.y + 5;
    let rows = (rect.bottom().saturating_sub(top) as usize / 2).max(1);
    app.visible_rows = rows;
    app.scroll = app.scroll.min(app.feeds.feeds.len().saturating_sub(rows));
    if app.feeds.feeds.is_empty() {
        text(
            frame,
            "No feeds yet. Add one above.",
            area(rect.x, top + 2, rect.width, 1),
            muted(app.palette.muted),
        );
    }
    let mut unread_by_feed = std::collections::HashMap::<String, usize>::new();
    for entry in &app.entries {
        if !app.state(entry).read.unwrap_or(false) {
            *unread_by_feed.entry(entry.feed_id.clone()).or_default() += 1;
        }
    }
    let visible_feeds: Vec<_> = app
        .feeds
        .feeds
        .iter()
        .skip(app.scroll)
        .take(rows)
        .cloned()
        .collect();
    for (slot, feed) in visible_feeds.into_iter().enumerate() {
        let y = top + slot as u16 * 2;
        let id = feed.id.clone();
        let focused = app.focused.as_deref() == Some(&id);
        let unread = unread_by_feed.get(id.as_str()).copied().unwrap_or_default();
        let health = app.feeds.health.get(&id).cloned();
        let has_error = health
            .as_ref()
            .and_then(|health| health.error.as_ref())
            .is_some();
        let health_text = health
            .as_ref()
            .and_then(|health| health.error.as_deref())
            .map_or_else(
                || {
                    health
                        .as_ref()
                        .and_then(|health| health.last_fetched)
                        .map_or("Not checked".into(), |time| {
                            ago(&chrono::DateTime::from_timestamp_millis(time)
                                .unwrap_or_default()
                                .to_rfc3339())
                        })
                },
                |_| "Error".into(),
            );
        hit(app, area(rect.x, y, rect.width, 2), Hit::Feed(id.clone()));
        label(
            frame,
            app,
            &feed.label,
            area(rect.x + 1, y, rect.width.saturating_sub(24), 1),
            if focused || app.hovered.as_ref() == Some(&Hit::Feed(id.clone())) {
                accent(app.palette.blue)
            } else {
                Style::default().add_modifier(Modifier::BOLD)
            },
            Hit::Feed(id.clone()),
        );
        let count = if unread == 0 {
            "—".into()
        } else {
            unread.to_string()
        };
        text(
            frame,
            count,
            area(rect.right() - 20, y, 6, 1),
            if unread > 0 {
                accent(app.palette.blue)
            } else {
                muted(app.palette.muted)
            },
        );
        text(
            frame,
            health_text,
            area(rect.right() - 13, y, 9, 1),
            if has_error {
                accent(app.palette.red)
            } else {
                muted(app.palette.muted)
            },
        );
        label(
            frame,
            app,
            "×",
            area(rect.right() - 2, y, 2, 1),
            muted(app.palette.red),
            Hit::DeleteFeed(id.clone()),
        );
        text(
            frame,
            &feed.url,
            area(rect.x + 1, y + 1, rect.width.saturating_sub(1), 1),
            muted(app.palette.muted),
        );
    }
}

fn settings(frame: &mut Frame, app: &mut App, rect: Rect) {
    text(
        frame,
        "Settings",
        area(rect.x, rect.y, rect.width, 1),
        Style::default().add_modifier(Modifier::BOLD),
    );
    text(
        frame,
        "Press Enter or click a setting to edit",
        area(rect.x, rect.y + 1, rect.width, 1),
        muted(app.palette.muted),
    );
    let Some(config) = &app.config else {
        return;
    };
    let values = [
        ("Theme", config.theme.clone()),
        ("Appearance", config.appearance.clone()),
        ("Max bulk open tabs", config.max_bulk_open.to_string()),
        (
            "Max entries to keep",
            config.retention.max_entries.to_string(),
        ),
        (
            "Max entry age (days)",
            config
                .retention
                .max_days
                .map_or("No limit".into(), |value| value.to_string()),
        ),
    ];
    let rows = (rect.height.saturating_sub(4) as usize / 2).max(1);
    app.visible_rows = rows;
    app.scroll = app.scroll.min(5usize.saturating_sub(rows));
    for (index, (name, value)) in values.into_iter().enumerate().skip(app.scroll).take(rows) {
        let y = rect.y + 4 + (index - app.scroll) as u16 * 2;
        if y >= rect.bottom() {
            break;
        }
        let focused = app.focused.as_deref() == Some(&index.to_string());
        label(
            frame,
            app,
            name,
            area(rect.x + 1, y, rect.width / 2, 1),
            if focused {
                accent(app.palette.blue)
            } else {
                Style::default()
            },
            Hit::Setting(index),
        );
        label(
            frame,
            app,
            &value,
            area(rect.x + rect.width / 2, y, rect.width / 2, 1),
            muted(app.palette.muted),
            Hit::Setting(index),
        );
    }
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
        text(
            frame,
            count,
            area(rect.x, y, 14, 1),
            accent(app.palette.blue),
        );
        let actions = [
            ("M Read", "read"),
            ("U Unread", "unread"),
            ("O Open", "open"),
            ("S Star", "star"),
        ];
        let mut x = rect.x + 15;
        for (name, action) in actions {
            label(
                frame,
                app,
                name,
                area(x, y, 10.min(rect.right().saturating_sub(x)), 1),
                muted(app.palette.blue),
                Hit::Bulk(action),
            );
            x += 10;
        }
        label(
            frame,
            app,
            "Cancel",
            area(x, y, 8.min(rect.right().saturating_sub(x)), 1),
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
        let hint = match app.page {
            Page::Feeds => {
                "j/k move  ·  Enter open  ·  a add  ·  d remove  ·  i/e OPML  ·  ? help  ·  q quit"
            }
            Page::Settings => "j/k move  ·  Enter edit  ·  1–4 navigate  ·  ? help  ·  q quit",
            _ => {
                "j/k move  ·  o open  ·  m read  ·  s star  ·  x select  ·  h/l filter  ·  ? help  ·  q quit"
            }
        };
        text(
            frame,
            hint,
            area(rect.x, y, rect.width, 1),
            muted(app.palette.muted),
        );
    }
}

fn modal(frame: &mut Frame, app: &mut App, root: Rect) {
    let width = root.width.saturating_sub(4).min(72);
    let height = match app.modal {
        Some(Modal::Help) => 14,
        Some(Modal::Failures) => 12,
        _ => 7,
    }
    .min(root.height.saturating_sub(2));
    let rect = area(
        root.x + (root.width - width) / 2,
        root.y + (root.height - height) / 2,
        width,
        height,
    );
    frame.render_widget(Clear, rect);
    let title = match app.modal {
        Some(Modal::Help) => "Shortcuts",
        Some(Modal::Failures) => "Feed status",
        Some(Modal::Remove(_)) => "Remove feed",
        Some(Modal::Open(_)) => "Open entries",
        Some(Modal::Input(InputKind::AddFeed, _)) => "Add feed",
        Some(Modal::Input(InputKind::Import, _)) => "Import OPML",
        Some(Modal::Input(InputKind::Export, _)) => "Export OPML",
        Some(Modal::Input(InputKind::Setting(_), _)) => "Edit setting",
        None => "",
    };
    frame.render_widget(
        Block::default()
            .borders(Borders::ALL)
            .border_style(muted(app.palette.blue))
            .title(title),
        rect,
    );
    let inner = area(
        rect.x + 2,
        rect.y + 2,
        rect.width.saturating_sub(4),
        rect.height.saturating_sub(3),
    );
    match &app.modal {
        Some(Modal::Help) => {
            let help = "1–4  Timeline / Starred / Feeds / Settings\nj/k or ↑/↓  Move focus       h/l  Change filter\no or Enter  Open entry      m  Toggle read\ns  Toggle star             x  Select entry\nShift+j/k  Extend selection  a  Mark all read\nShift+o  Open unread       r  Refresh\nSelected: M read · U unread · O open · S star\nFeeds: a add · d remove · i import · e export\nMouse: click actions · wheel scroll · drag select\nEsc  Close / clear          q  Quit";
            frame.render_widget(Paragraph::new(help).style(muted(app.palette.muted)), inner);
        }
        Some(Modal::Failures) => {
            let failures = if app.status.failures.is_empty() {
                "No feed failures".into()
            } else {
                app.status
                    .failures
                    .iter()
                    .map(|item| format!("{}: {}", item.label, item.error))
                    .collect::<Vec<_>>()
                    .join("\n")
            };
            frame.render_widget(
                Paragraph::new(failures)
                    .style(muted(app.palette.red))
                    .wrap(Wrap { trim: true }),
                inner,
            );
        }
        Some(Modal::Remove(id)) => {
            let name = app
                .feeds
                .feeds
                .iter()
                .find(|feed| &feed.id == id)
                .map_or("this feed", |feed| &feed.label);
            text(
                frame,
                format!("Remove {name} and its entries?"),
                area(inner.x, inner.y, inner.width, 1),
                Style::default(),
            );
        }
        Some(Modal::Open(ids)) => {
            let limit = app
                .config
                .as_ref()
                .map_or(20, |config| config.max_bulk_open);
            text(
                frame,
                format!("{} entries selected. Open first {limit}?", ids.len()),
                area(inner.x, inner.y, inner.width, 1),
                Style::default(),
            );
        }
        Some(Modal::Input(kind, value)) => {
            let instruction = match kind {
                InputKind::AddFeed => "Feed or site URL",
                InputKind::Import => "Path to OPML file",
                InputKind::Export => "Save OPML to path",
                InputKind::Setting(0) => "Theme name",
                InputKind::Setting(1) => "system, light, or dark",
                InputKind::Setting(4) => "Days; empty means no limit",
                InputKind::Setting(_) => "Number",
            };
            text(
                frame,
                instruction,
                area(inner.x, inner.y, inner.width, 1),
                muted(app.palette.muted),
            );
            let byte = value
                .char_indices()
                .nth(app.input_cursor)
                .map_or(value.len(), |(index, _)| index);
            text(
                frame,
                format!("› {}▏{}", &value[..byte], &value[byte..]),
                area(inner.x, inner.y + 2, inner.width, 1),
                accent(app.palette.blue),
            );
        }
        None => {}
    }
    if !matches!(app.modal.as_ref(), Some(Modal::Help | Modal::Failures)) {
        label(
            frame,
            app,
            "Enter Confirm",
            area(rect.x + 2, rect.bottom() - 2, 17, 1),
            accent(app.palette.blue),
            Hit::ModalConfirm,
        );
    }
    label(
        frame,
        app,
        "Esc Cancel",
        area(rect.right() - 14, rect.bottom() - 2, 12, 1),
        muted(app.palette.muted),
        Hit::ModalCancel,
    );
}
