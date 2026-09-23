use super::*;

pub(super) fn entries(frame: &mut Frame, app: &mut App, rect: Rect) {
    let (total, unread) = app.counts();
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
    if matches!(app.page, Page::Feed(_)) {
        label(
            frame,
            app,
            "← Feeds",
            area(rect.x, rect.y, 7, 1),
            muted(app.palette.blue),
            Hit::Nav(Page::Feeds),
        );
        text(
            frame,
            if app.complete {
                format!("/  {title}  ·  {unread} unread")
            } else {
                format!("/  {title}")
            },
            area(rect.x + 9, rect.y, rect.width.saturating_sub(9), 1),
            Style::default().add_modifier(Modifier::BOLD),
        );
    } else {
        text(
            frame,
            if app.complete {
                format!("{title}  ·  {unread} unread")
            } else {
                title
            },
            area(rect.x, rect.y, rect.width, 1),
            Style::default().add_modifier(Modifier::BOLD),
        );
    }
    if !app.complete {
        text(
            frame,
            "Loading saved entries…",
            area(rect.x, rect.y + 3, rect.width, 1),
            muted(app.palette.muted),
        );
        return;
    }

    let visible = app.visible();
    if app.page != Page::Starred {
        let filters = [
            ("All", Filter::All, total),
            ("Unread", Filter::Unread, unread),
            ("Read", Filter::Read, total - unread),
        ];
        let mut x = rect.x;
        for (name, filter, count) in filters {
            let value = format!("{name} {count}");
            let width = UnicodeWidthStr::width(value.as_str()) as u16;
            label(
                frame,
                app,
                &value,
                area(x, rect.y + 1, width, 1),
                if app.filter == filter {
                    accent(app.palette.blue)
                } else {
                    muted(app.palette.muted)
                },
                Hit::Filter(filter),
            );
            x += width + 2;
        }
    }
    let has_unread = visible.iter().any(|index| {
        let entry = &app.entries[*index];
        !app.state(entry).read.unwrap_or(false)
    });
    if has_unread && rect.width > 68 {
        label(
            frame,
            app,
            "Open unread",
            area(rect.right() - 30, rect.y + 1, 11, 1),
            muted(app.palette.blue),
            Hit::OpenUnread,
        );
        label(
            frame,
            app,
            "Mark all read",
            area(rect.right() - 15, rect.y + 1, 13, 1),
            muted(app.palette.blue),
            Hit::MarkAll,
        );
    }
    let list_top = rect.y + 3;
    let rows = (rect.bottom().saturating_sub(list_top).saturating_sub(1) as usize / 2).max(1);
    app.visible_rows = rows;
    app.scroll = app.scroll.min(visible.len().saturating_sub(rows));
    if visible.is_empty() {
        let message = match (&app.page, app.filter) {
            (Page::Starred, _) => "No starred entries yet · Press s on an entry to save it",
            (_, Filter::Unread) => "Nothing unread here",
            (_, Filter::Read) => "No read entries here",
            (Page::Feed(_), _) => "No entries in this feed",
            _ => "No entries yet · Add a feed to get started",
        };
        text(
            frame,
            message,
            area(rect.x, list_top + 1, rect.width, 1),
            muted(app.palette.muted),
        );
        return;
    }
    text(
        frame,
        "STAR READ",
        area(rect.right() - 11, rect.y + 2, 9, 1),
        muted(app.palette.muted).add_modifier(Modifier::DIM),
    );
    for (slot, entry_index) in visible.iter().skip(app.scroll).take(rows).enumerate() {
        let entry = &app.entries[*entry_index];
        let id = entry.id.clone();
        let state = app.state(entry);
        let title = if entry.title.is_empty() {
            "Untitled"
        } else {
            entry.title.as_str()
        };
        let title = fit(title, rect.width.saturating_sub(17) as usize);
        let meta = if matches!(app.page, Page::Feed(_)) {
            ago(&entry.published)
        } else {
            format!("{}  ·  {}", entry.feed_label, ago(&entry.published))
        };
        let y = list_top + slot as u16 * 2;
        hit(
            app,
            area(
                rect.x,
                y,
                rect.width,
                2.min(rect.bottom().saturating_sub(y)),
            ),
            Hit::OpenEntry(id.clone()),
        );
        let selected = app.selected.contains(&id);
        let focused = app.focused.as_deref() == Some(&id);
        let hovered = app.hovered.as_ref() == Some(&Hit::OpenEntry(id.clone()));
        if focused {
            text(frame, "▸", area(rect.x, y, 1, 1), accent(app.palette.blue));
        }
        label(
            frame,
            app,
            if selected { "[✓]" } else { "[ ]" },
            area(rect.x + 2, y, 3, 1),
            if selected {
                accent(app.palette.blue)
            } else {
                muted(app.palette.muted)
            },
            Hit::Select(id.clone()),
        );
        let mut title_style = if selected {
            accent(app.palette.blue)
        } else if state.read.unwrap_or(false) {
            muted(app.palette.muted)
        } else {
            Style::default().add_modifier(Modifier::BOLD)
        };
        if hovered {
            title_style = title_style.add_modifier(Modifier::UNDERLINED);
        }
        let title_width = UnicodeWidthStr::width(title.as_str()) as u16;
        text(
            frame,
            title,
            area(rect.x + 6, y, title_width, 1),
            title_style,
        );
        label(
            frame,
            app,
            if state.starred.unwrap_or(false) {
                "[★]"
            } else {
                "[☆]"
            },
            area(rect.right() - 9, y, 3, 1),
            if state.starred.unwrap_or(false) {
                accent(app.palette.orange)
            } else {
                muted(app.palette.muted)
            },
            Hit::Star(id.clone()),
        );
        label(
            frame,
            app,
            if state.read.unwrap_or(false) {
                "[○]"
            } else {
                "[●]"
            },
            area(rect.right() - 4, y, 3, 1),
            if state.read.unwrap_or(false) {
                muted(app.palette.muted)
            } else {
                accent(app.palette.blue)
            },
            Hit::Read(id.clone()),
        );
        text(
            frame,
            fit(&meta, rect.width.saturating_sub(17) as usize),
            area(rect.x + 6, y + 1, rect.width.saturating_sub(17), 1),
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
        frame.render_widget(
            Paragraph::new(progress)
                .style(muted(app.palette.muted))
                .alignment(Alignment::Right),
            area(rect.x, rect.bottom().saturating_sub(1), rect.width, 1),
        );
    }
}
