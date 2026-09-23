use super::*;

pub(super) fn feeds(frame: &mut Frame, app: &mut App, rect: Rect) {
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
    if !app.complete {
        text(
            frame,
            "Loading saved feeds…",
            area(rect.x, rect.y + 2, rect.width, 1),
            muted(app.palette.muted),
        );
        return;
    }
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
    let compact = rect.width < 58;
    label(
        frame,
        app,
        if compact { "+ Add" } else { "＋ Add feed" },
        area(rect.x, rect.y + 2, if compact { 5 } else { 11 }, 1),
        accent(app.palette.blue),
        Hit::AddFeed,
    );
    label(
        frame,
        app,
        if compact { "Import" } else { "Import OPML" },
        area(
            rect.x + if compact { 7 } else { 14 },
            rect.y + 2,
            if compact { 6 } else { 11 },
            1,
        ),
        muted(app.palette.blue),
        Hit::Import,
    );
    label(
        frame,
        app,
        if compact { "Export" } else { "Export OPML" },
        area(
            rect.x + if compact { 16 } else { 28 },
            rect.y + 2,
            if compact { 6 } else { 11 },
            1,
        ),
        muted(app.palette.blue),
        Hit::Export,
    );
    text(
        frame,
        "FEED",
        area(rect.x + 2, rect.y + 4, 8, 1),
        muted(app.palette.muted).add_modifier(Modifier::DIM),
    );
    text(
        frame,
        if compact {
            "NEW  DEL"
        } else {
            "UNREAD  CHECKED  DEL"
        },
        area(
            rect.right() - if compact { 12 } else { 23 },
            rect.y + 4,
            if compact { 8 } else { 21 },
            1,
        ),
        muted(app.palette.muted).add_modifier(Modifier::DIM),
    );
    let top = rect.y + 5;
    let rows = (rect.bottom().saturating_sub(top).saturating_sub(1) as usize / 2).max(1);
    app.visible_rows = rows;
    app.scroll = app.scroll.min(app.feeds.feeds.len().saturating_sub(rows));
    if app.feeds.feeds.is_empty() {
        text(
            frame,
            "No feeds yet. Add one above.",
            area(rect.x, top + 1, rect.width, 1),
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
        if focused {
            text(frame, "▸", area(rect.x, y, 1, 1), accent(app.palette.blue));
        }
        label(
            frame,
            app,
            &feed.label,
            area(
                rect.x + 2,
                y,
                rect.width.saturating_sub(if compact { 17 } else { 28 }),
                1,
            ),
            Style::default().add_modifier(Modifier::BOLD),
            Hit::Feed(id.clone()),
        );
        frame.render_widget(
            Paragraph::new(unread.to_string())
                .style(if unread > 0 {
                    accent(app.palette.blue)
                } else {
                    muted(app.palette.muted)
                })
                .alignment(Alignment::Right),
            area(
                rect.right() - if compact { 12 } else { 23 },
                y,
                if compact { 4 } else { 6 },
                1,
            ),
        );
        if !compact {
            text(
                frame,
                health_text,
                area(rect.right() - 15, y, 11, 1),
                if has_error {
                    accent(app.palette.red)
                } else {
                    muted(app.palette.muted)
                },
            );
        }
        label(
            frame,
            app,
            "[×]",
            area(rect.right() - 4, y, 3, 1),
            if app.hovered == Some(Hit::DeleteFeed(id.clone())) {
                accent(app.palette.red)
            } else {
                muted(app.palette.muted)
            },
            Hit::DeleteFeed(id.clone()),
        );
        text(
            frame,
            fit(
                if compact && has_error {
                    "Check failed"
                } else {
                    &feed.url
                },
                rect.width.saturating_sub(if compact { 4 } else { 28 }) as usize,
            ),
            area(
                rect.x + 2,
                y + 1,
                rect.width.saturating_sub(if compact { 4 } else { 28 }),
                1,
            ),
            if compact && has_error {
                accent(app.palette.red)
            } else {
                muted(app.palette.muted)
            },
        );
    }
    if app.feeds.feeds.len() > rows {
        let progress = format!(
            "{}–{} / {} feeds",
            app.scroll + 1,
            (app.scroll + rows).min(app.feeds.feeds.len()),
            app.feeds.feeds.len()
        );
        frame.render_widget(
            Paragraph::new(progress)
                .style(muted(app.palette.muted))
                .alignment(Alignment::Right),
            area(rect.x, rect.bottom().saturating_sub(1), rect.width, 1),
        );
    }
}
