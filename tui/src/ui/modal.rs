use super::*;

pub(super) fn modal(frame: &mut Frame, app: &mut App, root: Rect) {
    let width = root.width.saturating_sub(4).min(match app.modal {
        Some(Modal::Help | Modal::Failures) => 72,
        Some(Modal::Input(_, _)) => 60,
        _ => 54,
    });
    let height = match app.modal {
        Some(Modal::Help) => 14,
        Some(Modal::Failures) => 12,
        Some(Modal::Input(_, _)) => 8,
        _ => 6,
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
        rect.height.saturating_sub(4),
    );
    match &app.modal {
        Some(Modal::Help) => {
            let help = if rect.height < 14 {
                "1–4 Pages · j/k Move\nEnter Open · x Select\nm Read · s Star · h/l Filter\nr Refresh · ? Help\nFeeds: a Add · d Remove\nEsc Close · q Quit"
            } else if rect.width < 60 {
                "1–4 Pages · j/k Move\nEnter Open · h/l Filter\nx Select · m Read · s Star\nShift+j/k Extend · a Read all\nShift+o Open unread · r Refresh\nSelected: M/U/O/S Actions\nFeeds: a Add · d Remove\ni Import · e Export\nMouse: click / scroll / drag\nEsc Close · q Quit"
            } else {
                "1–4  Timeline / Starred / Feeds / Settings\nj/k or ↑/↓  Move focus       h/l  Change filter\no or Enter  Open entry      m  Toggle read\ns  Toggle star             x  Select entry\nShift+j/k  Extend selection  a  Mark visible read\nShift+o  Open unread       r  Refresh\nSelected: M read · U unread · O open · S star\nFeeds: a add · d remove · i import · e export\nMouse: click rows · wheel scroll · drag from checkbox\nEsc  Close / clear          q  Quit"
            };
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
            let field = area(inner.x, inner.y + 1, inner.width, 3);
            frame.render_widget(
                Block::default()
                    .borders(Borders::ALL)
                    .border_style(muted(app.palette.muted)),
                field,
            );
            text(
                frame,
                input_view(
                    value,
                    app.input_cursor,
                    field.width.saturating_sub(2) as usize,
                ),
                area(field.x + 1, field.y + 1, field.width.saturating_sub(2), 1),
                Style::default(),
            );
        }
        None => {}
    }
    if !matches!(app.modal.as_ref(), Some(Modal::Help | Modal::Failures)) {
        label(
            frame,
            app,
            "[ Confirm ↵ ]",
            area(rect.right() - 17, rect.bottom() - 2, 13, 1),
            if matches!(app.modal, Some(Modal::Remove(_))) {
                accent(app.palette.red)
            } else {
                accent(app.palette.blue)
            },
            Hit::ModalConfirm,
        );
    }
    label(
        frame,
        app,
        if matches!(app.modal, Some(Modal::Help | Modal::Failures)) {
            "[ Close Esc ]"
        } else {
            "[ Cancel Esc ]"
        },
        area(
            rect.right()
                - if matches!(app.modal, Some(Modal::Help | Modal::Failures)) {
                    16
                } else {
                    32
                },
            rect.bottom() - 2,
            14,
            1,
        ),
        muted(app.palette.muted),
        Hit::ModalCancel,
    );
}

fn input_view(value: &str, cursor: usize, width: usize) -> String {
    if width == 0 {
        return String::new();
    }
    let chars: Vec<char> = value.chars().collect();
    let cursor = cursor.min(chars.len());
    let mut start = 0;
    while start < cursor {
        let before = chars[start..cursor]
            .iter()
            .map(|ch| ch.width().unwrap_or(0))
            .sum::<usize>();
        if before + usize::from(start > 0) < width {
            break;
        }
        start += 1;
    }
    let mut view = String::new();
    if start > 0 {
        view.push('…');
    }
    view.extend(chars[start..cursor].iter());
    view.push('▏');
    view.extend(chars[cursor..].iter());
    fit(&view, width)
}
