use crate::api::EntryState;
use chrono::{DateTime, Utc};
use ratatui::layout::Rect;
use std::path::PathBuf;

pub(crate) fn merge_state(current: &mut EntryState, incoming: &EntryState) {
    if let Some(value) = incoming.read
        && (current.read_at.is_none() || incoming.read_at >= current.read_at)
    {
        current.read = Some(value);
        current.read_at = incoming.read_at;
    }
    if let Some(value) = incoming.starred
        && (current.starred_at.is_none() || incoming.starred_at >= current.starred_at)
    {
        current.starred = Some(value);
        current.starred_at = incoming.starred_at;
    }
}

pub(crate) fn inside(rect: Rect, x: u16, y: u16) -> bool {
    x >= rect.x && x < rect.right() && y >= rect.y && y < rect.bottom()
}

pub(crate) fn resolve_path(value: &str) -> PathBuf {
    if let Some(rest) = value.strip_prefix("~/")
        && let Some(home) = std::env::var_os("HOME")
    {
        return PathBuf::from(home).join(rest);
    }
    PathBuf::from(value)
}

pub(crate) fn ago(value: &str) -> String {
    let Ok(date) = DateTime::parse_from_rfc3339(value) else {
        return "Unknown date".into();
    };
    let seconds = Utc::now().signed_duration_since(date).num_seconds();
    if seconds < 60 {
        "just now".into()
    } else if seconds < 3600 {
        format!("{}m ago", seconds / 60)
    } else if seconds < 86400 {
        format!("{}h ago", seconds / 3600)
    } else if seconds < 172800 {
        "yesterday".into()
    } else if seconds < 604800 {
        format!("{}d ago", seconds / 86400)
    } else {
        date.format("%b %-d").to_string()
    }
}
