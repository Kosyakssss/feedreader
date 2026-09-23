use super::*;

pub(super) fn settings(frame: &mut Frame, app: &mut App, rect: Rect) {
    text(
        frame,
        "Settings",
        area(rect.x, rect.y, rect.width, 1),
        Style::default().add_modifier(Modifier::BOLD),
    );
    text(
        frame,
        fit(
            "Server settings · terminal colors follow your emulator",
            rect.width as usize,
        ),
        area(rect.x, rect.y + 1, rect.width, 1),
        muted(app.palette.muted),
    );
    let Some(config) = &app.config else {
        return;
    };
    let values = [
        ("Web theme", config.theme.clone()),
        ("Web appearance", config.appearance.clone()),
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
        let hovered = app.hovered == Some(Hit::Setting(index));
        let compact = rect.width < 65;
        hit(
            app,
            area(rect.x, y, rect.width.min(65), if compact { 2 } else { 1 }),
            Hit::Setting(index),
        );
        if focused {
            text(frame, "▸", area(rect.x, y, 1, 1), accent(app.palette.blue));
        }
        text(
            frame,
            name,
            area(rect.x + 2, y, rect.width.saturating_sub(6), 1),
            if hovered {
                Style::default().add_modifier(Modifier::UNDERLINED)
            } else {
                Style::default()
            },
        );
        text(
            frame,
            fit(&value, 25),
            if compact {
                area(rect.x + 2, y + 1, rect.width.saturating_sub(5), 1)
            } else {
                area(rect.x + 32, y, 25, 1)
            },
            muted(app.palette.muted),
        );
        text(
            frame,
            "›",
            area(
                if compact {
                    rect.right() - 2
                } else {
                    rect.x + 61
                },
                y,
                1,
                1,
            ),
            muted(app.palette.blue),
        );
    }
    if rows < 5 {
        let progress = format!(
            "{}–{} / 5 settings",
            app.scroll + 1,
            (app.scroll + rows).min(5)
        );
        frame.render_widget(
            Paragraph::new(progress)
                .style(muted(app.palette.muted))
                .alignment(Alignment::Right),
            area(rect.x, rect.bottom().saturating_sub(1), rect.width, 1),
        );
    }
}
