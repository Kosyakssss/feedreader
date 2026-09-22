#![forbid(unsafe_code)]

mod api;
mod ui;

use api::{
    Api, Config, Entry, EntryState, EventPayload, Feeds, Message, RefreshStatus, Snapshot,
    StatePatch, Theme,
};
use chrono::{DateTime, Utc};
use crossterm::event::{
    DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture, Event,
    EventStream, KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEvent,
    MouseEventKind,
};
use futures_util::StreamExt;
use ratatui::layout::Rect;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    io,
    path::PathBuf,
    process::Command,
    time::{Duration, Instant},
};
use tokio::sync::mpsc;
use ui::{Hit, Palette};

#[derive(Clone, PartialEq, Eq)]
enum Page {
    Timeline,
    Starred,
    Feeds,
    Settings,
    Feed(String),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Filter {
    All,
    Unread,
    Read,
}

#[derive(Clone)]
enum InputKind {
    AddFeed,
    Import,
    Export,
    Setting(usize),
}

enum Modal {
    Help,
    Input(InputKind, String),
    Remove(String),
    Open(Vec<String>),
    Failures,
}

struct Pending {
    updates: HashMap<String, StatePatch>,
}

struct App {
    api: Api,
    tx: mpsc::UnboundedSender<Message>,
    entries: Vec<Entry>,
    feeds: Feeds,
    config: Option<Config>,
    themes: Vec<Theme>,
    status: RefreshStatus,
    sequence: u64,
    complete: bool,
    online: bool,
    started: bool,
    page: Page,
    filter: Filter,
    focused: Option<String>,
    selected: HashSet<String>,
    scroll: usize,
    visible_rows: usize,
    modal: Option<Modal>,
    notice: Option<String>,
    notice_at: Instant,
    hovered: Option<Hit>,
    input_cursor: usize,
    pending: VecDeque<Pending>,
    overrides: HashMap<String, StatePatch>,
    writing: bool,
    busy: bool,
    hits: Vec<(Rect, Hit)>,
    drag_anchor: Option<usize>,
    palette: Palette,
    quit: bool,
}

impl App {
    fn new(api: Api, tx: mpsc::UnboundedSender<Message>, palette: Palette) -> Self {
        Self {
            api,
            tx,
            entries: Vec::new(),
            feeds: Feeds::default(),
            config: None,
            themes: Vec::new(),
            status: RefreshStatus::default(),
            sequence: 0,
            complete: false,
            online: false,
            started: false,
            page: Page::Timeline,
            filter: Filter::All,
            focused: None,
            selected: HashSet::new(),
            scroll: 0,
            visible_rows: 1,
            modal: None,
            notice: None,
            notice_at: Instant::now(),
            hovered: None,
            input_cursor: 0,
            pending: VecDeque::new(),
            overrides: HashMap::new(),
            writing: false,
            busy: false,
            hits: Vec::new(),
            drag_anchor: None,
            palette,
            quit: false,
        }
    }

    fn state(&self, entry: &Entry) -> EntryState {
        let mut state = entry.state.clone();
        if let Some(patch) = self.overrides.get(&entry.id) {
            if let Some(read) = patch.read {
                state.read = Some(read);
            }
            if let Some(starred) = patch.starred {
                state.starred = Some(starred);
            }
        }
        state
    }

    fn rebuild_overrides(&mut self) {
        self.overrides.clear();
        for pending in &self.pending {
            for (id, patch) in &pending.updates {
                let entry = self.overrides.entry(id.clone()).or_insert(StatePatch {
                    read: None,
                    starred: None,
                });
                if patch.read.is_some() {
                    entry.read = patch.read;
                }
                if patch.starred.is_some() {
                    entry.starred = patch.starred;
                }
            }
        }
    }

    fn visible(&self) -> Vec<usize> {
        self.entries
            .iter()
            .enumerate()
            .filter_map(|(index, entry)| {
                let state = self.state(entry);
                let on_page = match &self.page {
                    Page::Timeline => true,
                    Page::Starred => state.starred.unwrap_or(false),
                    Page::Feed(id) => &entry.feed_id == id,
                    _ => false,
                };
                let in_filter = self.page == Page::Starred
                    || match self.filter {
                        Filter::All => true,
                        Filter::Unread => !state.read.unwrap_or(false),
                        Filter::Read => state.read.unwrap_or(false),
                    };
                (on_page && in_filter).then_some(index)
            })
            .collect()
    }

    fn counts(&self) -> (usize, usize) {
        self.entries
            .iter()
            .filter(|entry| match &self.page {
                Page::Timeline => true,
                Page::Starred => self.state(entry).starred.unwrap_or(false),
                Page::Feed(id) => &entry.feed_id == id,
                _ => false,
            })
            .fold((0, 0), |(total, unread), entry| {
                (
                    total + 1,
                    unread + usize::from(!self.state(entry).read.unwrap_or(false)),
                )
            })
    }

    fn change_page(&mut self, page: Page) {
        self.page = page;
        self.filter = Filter::All;
        self.focused = None;
        self.selected.clear();
        self.scroll = 0;
        self.modal = None;
        self.hovered = None;
    }

    fn notify(&mut self, message: impl Into<String>) {
        self.notice = Some(message.into());
        self.notice_at = Instant::now();
    }

    fn input(&mut self, kind: InputKind, value: String) {
        self.input_cursor = value.chars().count();
        self.modal = Some(Modal::Input(kind, value));
    }

    fn paste(&mut self, pasted: &str) {
        if let Some(Modal::Input(_, value)) = &mut self.modal {
            let pasted = pasted.replace(['\r', '\n'], "");
            let byte = value
                .char_indices()
                .nth(self.input_cursor)
                .map_or(value.len(), |(index, _)| index);
            value.insert_str(byte, &pasted);
            self.input_cursor += pasted.chars().count();
        }
    }

    fn expire_notice(&mut self) -> bool {
        if self.notice.is_some() && self.notice_at.elapsed() >= Duration::from_secs(4) {
            self.notice = None;
            return true;
        }
        false
    }

    fn top_visible_id(&self) -> Option<String> {
        if self.scroll == 0 {
            return None;
        }
        self.visible()
            .get(self.scroll)
            .map(|index| self.entries[*index].id.clone())
    }

    fn restore_top(&mut self, id: Option<String>) {
        if let Some(id) = id
            && let Some(index) = self
                .visible()
                .iter()
                .position(|entry| self.entries[*entry].id == id)
        {
            self.scroll = index;
        }
        self.clamp_scroll();
    }

    fn apply_snapshot(&mut self, snapshot: Snapshot) {
        if self.complete && snapshot.event_id < self.sequence {
            return;
        }
        let anchor = self.top_visible_id();
        self.entries = snapshot.entries;
        self.feeds = snapshot.feeds;
        self.config = Some(snapshot.config);
        self.themes = snapshot.themes;
        self.receive_status(snapshot.status);
        self.sequence = snapshot.event_id;
        self.complete = true;
        self.online = true;
        if !self.started {
            self.started = true;
            self.refresh();
        }
        self.selected
            .retain(|id| self.entries.iter().any(|entry| &entry.id == id));
        if self
            .focused
            .as_ref()
            .is_some_and(|id| !self.entries.iter().any(|entry| &entry.id == id))
        {
            self.focused = None;
        }
        self.restore_top(anchor);
    }

    fn receive_status(&mut self, incoming: RefreshStatus) {
        if let (Some(current), Some(next)) = (&self.status.run_id, &incoming.run_id) {
            if current == next
                && (incoming.completed < self.status.completed
                    || (self.status.finished_at.is_some() && incoming.finished_at.is_none()))
            {
                return;
            }
            if incoming.started_at < self.status.started_at {
                return;
            }
        }
        self.status = incoming;
    }

    fn apply_event(&mut self, id: u64, event: EventPayload) {
        if id <= self.sequence {
            return;
        }
        self.sequence = id;
        let changed_entries = !event.entries.is_empty();
        let anchor = if changed_entries || !event.removed_ids.is_empty() {
            self.top_visible_id()
        } else {
            None
        };
        let mut positions: HashMap<String, usize> =
            if changed_entries || !event.entry_states.is_empty() {
                self.entries
                    .iter()
                    .enumerate()
                    .map(|(index, entry)| (entry.id.clone(), index))
                    .collect()
            } else {
                HashMap::new()
            };
        for entry in event.entries {
            if let Some(index) = positions.get(&entry.id) {
                self.entries[*index] = entry;
            } else {
                positions.insert(entry.id.clone(), self.entries.len());
                self.entries.push(entry);
            }
        }
        if !event.removed_ids.is_empty() {
            let removed: HashSet<_> = event.removed_ids.into_iter().collect();
            self.entries.retain(|entry| !removed.contains(&entry.id));
            self.selected.retain(|id| !removed.contains(id));
            positions = self
                .entries
                .iter()
                .enumerate()
                .map(|(index, entry)| (entry.id.clone(), index))
                .collect();
        }
        for (id, state) in event.entry_states {
            if let Some(index) = positions.get(&id) {
                merge_state(&mut self.entries[*index].state, &state);
            }
        }
        for result in event.feed_results {
            if let Some(health) = self.feeds.health.get_mut(&result.feed_id) {
                health.last_fetched = Some(result.completed_at);
                health.error = result.error;
            }
        }
        if let Some(status) = event.refresh {
            self.receive_status(status);
        }
        if changed_entries {
            self.entries
                .sort_by(|a, b| b.published.cmp(&a.published).then(a.id.cmp(&b.id)));
        }
        self.restore_top(anchor);
    }

    fn handle_message(&mut self, message: Message) {
        match message {
            Message::Snapshot(snapshot) => self.apply_snapshot(snapshot),
            Message::Event(id, event) => self.apply_event(id, event),
            Message::Saved(states) => {
                self.pending.pop_front();
                self.rebuild_overrides();
                self.writing = false;
                let positions: HashMap<String, usize> = self
                    .entries
                    .iter()
                    .enumerate()
                    .map(|(index, entry)| (entry.id.clone(), index))
                    .collect();
                for (id, state) in states {
                    if let Some(index) = positions.get(&id) {
                        merge_state(&mut self.entries[*index].state, &state);
                    }
                }
                self.start_write();
            }
            Message::Refreshed(status) => {
                self.receive_status(status);
                self.busy = false;
            }
            Message::FeedAdded(address) => {
                self.notify(format!("Added {address}"));
                self.busy = false;
                self.sync();
            }
            Message::FeedRemoved(id) => {
                self.notify("Feed removed");
                self.busy = false;
                self.feeds.feeds.retain(|feed| feed.id != id);
                self.entries.retain(|entry| entry.feed_id != id);
                self.sync();
            }
            Message::Imported(result) => {
                self.notify(format!(
                    "{} feeds added · {} skipped",
                    result.added, result.skipped
                ));
                self.busy = false;
                self.sync();
            }
            Message::Exported(path) => {
                self.notify(format!("Exported to {path}"));
                self.busy = false;
            }
            Message::ConfigSaved(config) => {
                self.config = Some(config);
                self.notify("Settings saved");
                self.busy = false;
                self.sync();
            }
            Message::Error(error) => {
                self.notify(error);
                self.busy = false;
            }
            Message::WriteFailed(error) => {
                self.notify(format!("Could not save state: {error}"));
                self.pending.pop_front();
                self.rebuild_overrides();
                self.writing = false;
                self.start_write();
                self.sync();
            }
            Message::Offline => {
                if self.online {
                    self.notify("Connection lost · reconnecting");
                }
                self.online = false;
                self.sequence = 0;
            }
        }
    }

    fn sync(&self) {
        let api = self.api.clone();
        let tx = self.tx.clone();
        tokio::spawn(async move {
            match api.sync().await {
                Ok(snapshot) => {
                    let _ = tx.send(Message::Snapshot(snapshot));
                }
                Err(error) => {
                    let _ = tx.send(Message::Error(error));
                }
            }
        });
    }

    fn queue_mark(&mut self, ids: Vec<String>, patch: StatePatch) {
        if ids.is_empty() {
            return;
        }
        self.pending.push_back(Pending {
            updates: ids.into_iter().map(|id| (id, patch.clone())).collect(),
        });
        self.rebuild_overrides();
        self.start_write();
    }

    fn start_write(&mut self) {
        if self.writing {
            return;
        }
        let Some(pending) = self.pending.front() else {
            return;
        };
        self.writing = true;
        let updates = pending.updates.clone();
        let api = self.api.clone();
        let tx = self.tx.clone();
        tokio::spawn(async move {
            match api.mark(updates).await {
                Ok(states) => {
                    let _ = tx.send(Message::Saved(states));
                }
                Err(error) => {
                    let _ = tx.send(Message::WriteFailed(error));
                }
            }
        });
    }

    fn toggle(&mut self, id: String, key: &str) {
        if let Some(entry) = self.entries.iter().find(|entry| entry.id == id) {
            let state = self.state(entry);
            let patch = if key == "read" {
                StatePatch {
                    read: Some(!state.read.unwrap_or(false)),
                    starred: None,
                }
            } else {
                StatePatch {
                    read: None,
                    starred: Some(!state.starred.unwrap_or(false)),
                }
            };
            self.queue_mark(vec![id], patch);
        }
    }

    fn refresh(&mut self) {
        if self.busy || self.status.refreshing {
            return;
        }
        self.busy = true;
        let api = self.api.clone();
        let tx = self.tx.clone();
        tokio::spawn(async move {
            match api.refresh().await {
                Ok(status) => {
                    let _ = tx.send(Message::Refreshed(status));
                }
                Err(error) => {
                    let _ = tx.send(Message::Error(format!("Refresh failed: {error}")));
                }
            }
        });
    }

    fn open_ids(&mut self, ids: Vec<String>) {
        let limit = self
            .config
            .as_ref()
            .map_or(20, |config| config.max_bulk_open as usize);
        if ids.len() > limit {
            self.modal = Some(Modal::Open(ids));
            return;
        }
        self.open_now(ids);
    }

    fn open_now(&mut self, ids: Vec<String>) {
        let limit = self
            .config
            .as_ref()
            .map_or(20, |config| config.max_bulk_open as usize);
        let chosen: Vec<_> = ids.into_iter().take(limit).collect();
        let mut opened = Vec::new();
        for id in &chosen {
            if let Some(entry) = self.entries.iter().find(|entry| &entry.id == id)
                && matches!(reqwest::Url::parse(&entry.url), Ok(url) if matches!(url.scheme(), "http" | "https"))
            {
                let program = if cfg!(target_os = "macos") {
                    "open"
                } else if cfg!(target_os = "windows") {
                    "explorer.exe"
                } else {
                    "xdg-open"
                };
                let mut command = Command::new(program);
                if command.arg(&entry.url).spawn().is_ok() {
                    opened.push(id.clone());
                }
            }
        }
        if opened.is_empty() {
            self.notify("No links opened");
        }
        self.queue_mark(
            opened,
            StatePatch {
                read: Some(true),
                starred: None,
            },
        );
        self.selected.clear();
    }

    fn mark_visible_unread(&mut self) {
        let ids = self
            .visible()
            .into_iter()
            .filter_map(|index| {
                let entry = &self.entries[index];
                (!self.state(entry).read.unwrap_or(false)).then(|| entry.id.clone())
            })
            .collect();
        self.queue_mark(
            ids,
            StatePatch {
                read: Some(true),
                starred: None,
            },
        );
    }

    fn selected_action(&mut self, action: &str) {
        let ids: Vec<_> = self
            .entries
            .iter()
            .filter(|entry| self.selected.contains(&entry.id))
            .map(|entry| entry.id.clone())
            .collect();
        match action {
            "open" => self.open_ids(ids),
            "read" => self.queue_mark(
                ids,
                StatePatch {
                    read: Some(true),
                    starred: None,
                },
            ),
            "unread" => self.queue_mark(
                ids,
                StatePatch {
                    read: Some(false),
                    starred: None,
                },
            ),
            "star" => self.queue_mark(
                ids,
                StatePatch {
                    read: None,
                    starred: Some(true),
                },
            ),
            _ => {}
        }
        if action != "open" {
            self.selected.clear();
        }
    }

    fn move_focus(&mut self, direction: i32, extend: bool) {
        let ids: Vec<String> = match self.page {
            Page::Feeds => self
                .feeds
                .feeds
                .iter()
                .map(|feed| feed.id.clone())
                .collect(),
            Page::Settings => (0..5).map(|index| index.to_string()).collect(),
            _ => self
                .visible()
                .iter()
                .map(|index| self.entries[*index].id.clone())
                .collect(),
        };
        if ids.is_empty() {
            return;
        }
        let current = self
            .focused
            .as_ref()
            .and_then(|id| ids.iter().position(|item| item == id));
        let next = match current {
            Some(index) => index
                .saturating_add_signed(direction as isize)
                .min(ids.len() - 1),
            None => {
                if direction < 0 {
                    ids.len() - 1
                } else {
                    0
                }
            }
        };
        if extend && !matches!(self.page, Page::Feeds | Page::Settings) {
            if let Some(index) = current {
                self.selected.insert(ids[index].clone());
            }
            self.selected.insert(ids[next].clone());
        }
        self.focused = Some(ids[next].clone());
        if next < self.scroll {
            self.scroll = next;
        }
        if next >= self.scroll + self.visible_rows {
            self.scroll = next + 1 - self.visible_rows;
        }
    }

    fn jump_feed(&mut self, last: bool) {
        let index = if last {
            self.feeds.feeds.len().checked_sub(1)
        } else if self.feeds.feeds.is_empty() {
            None
        } else {
            Some(0)
        };
        if let Some(index) = index {
            self.focused = Some(self.feeds.feeds[index].id.clone());
            self.scroll = if last {
                index.saturating_sub(self.visible_rows.saturating_sub(1))
            } else {
                0
            };
        }
    }

    fn clamp_scroll(&mut self) {
        let total = match self.page {
            Page::Feeds => self.feeds.feeds.len(),
            Page::Settings => 5,
            _ => self.visible().len(),
        };
        self.scroll = self.scroll.min(total.saturating_sub(self.visible_rows));
    }

    fn activate(&mut self, hit: Hit) {
        if self.modal.is_some() {
            match hit {
                Hit::ModalConfirm => self.confirm_modal(),
                Hit::ModalCancel => self.modal = None,
                _ => {}
            }
            return;
        }
        match hit {
            Hit::Nav(page) => self.change_page(page),
            Hit::Filter(filter) => {
                self.filter = filter;
                self.scroll = 0;
                self.focused = None;
                self.selected.clear();
            }
            Hit::Refresh => self.refresh(),
            Hit::Help => self.modal = Some(Modal::Help),
            Hit::Failures => self.modal = Some(Modal::Failures),
            Hit::Entry(id) => {
                self.focused = Some(id);
            }
            Hit::OpenEntry(id) => self.open_ids(vec![id]),
            Hit::Select(id) => {
                if !self.selected.insert(id.clone()) {
                    self.selected.remove(&id);
                }
                self.focused = Some(id);
            }
            Hit::Star(id) => self.toggle(id, "starred"),
            Hit::Read(id) => self.toggle(id, "read"),
            Hit::MarkAll => self.mark_visible_unread(),
            Hit::OpenUnread => {
                let ids = self
                    .visible()
                    .into_iter()
                    .filter_map(|index| {
                        let entry = &self.entries[index];
                        (!self.state(entry).read.unwrap_or(false)).then(|| entry.id.clone())
                    })
                    .collect();
                self.open_ids(ids);
            }
            Hit::Bulk(action) => self.selected_action(action),
            Hit::ClearSelection => self.selected.clear(),
            Hit::Feed(id) => self.change_page(Page::Feed(id)),
            Hit::DeleteFeed(id) => self.modal = Some(Modal::Remove(id)),
            Hit::AddFeed => self.input(InputKind::AddFeed, String::new()),
            Hit::Import => self.input(InputKind::Import, String::new()),
            Hit::Export => self.input(InputKind::Export, "feedreader.opml".into()),
            Hit::Setting(index) => self.edit_setting(index),
            Hit::ModalConfirm | Hit::ModalCancel => {}
        }
    }

    fn edit_setting(&mut self, index: usize) {
        let Some(config) = &self.config else {
            return;
        };
        let value = match index {
            0 => config.theme.clone(),
            1 => config.appearance.clone(),
            2 => config.max_bulk_open.to_string(),
            3 => config.retention.max_entries.to_string(),
            _ => config
                .retention
                .max_days
                .map_or(String::new(), |value| value.to_string()),
        };
        self.input(InputKind::Setting(index), value);
    }

    fn confirm_modal(&mut self) {
        let Some(modal) = self.modal.take() else {
            return;
        };
        match modal {
            Modal::Remove(id) => {
                if self.busy {
                    return;
                }
                self.busy = true;
                let api = self.api.clone();
                let tx = self.tx.clone();
                tokio::spawn(async move {
                    match api.remove_feed(id.clone()).await {
                        Ok(()) => {
                            let _ = tx.send(Message::FeedRemoved(id));
                        }
                        Err(error) => {
                            let _ = tx.send(Message::Error(error));
                        }
                    }
                });
            }
            Modal::Open(ids) => self.open_now(ids),
            Modal::Input(kind, value) => self.submit_input(kind, value),
            Modal::Help | Modal::Failures => {}
        }
    }

    fn submit_input(&mut self, kind: InputKind, value: String) {
        let value = value.trim().to_owned();
        if value.is_empty() && !matches!(kind, InputKind::Setting(4)) {
            self.notify("A value is required");
            self.input(kind, value);
            return;
        }
        if self.busy {
            self.input(kind, value);
            return;
        }
        match kind {
            InputKind::AddFeed => {
                self.busy = true;
                let api = self.api.clone();
                let tx = self.tx.clone();
                tokio::spawn(async move {
                    match api.add_feed(value.clone()).await {
                        Ok(()) => {
                            let _ = tx.send(Message::FeedAdded(value));
                        }
                        Err(error) => {
                            let _ = tx.send(Message::Error(error));
                        }
                    }
                });
            }
            InputKind::Import => {
                self.busy = true;
                let api = self.api.clone();
                let tx = self.tx.clone();
                tokio::spawn(async move {
                    match api.import(&resolve_path(&value)).await {
                        Ok(result) => {
                            let _ = tx.send(Message::Imported(result));
                        }
                        Err(error) => {
                            let _ = tx.send(Message::Error(error));
                        }
                    }
                });
            }
            InputKind::Export => {
                self.busy = true;
                let api = self.api.clone();
                let tx = self.tx.clone();
                tokio::spawn(async move {
                    match api.export(&resolve_path(&value)).await {
                        Ok(()) => {
                            let _ = tx.send(Message::Exported(value));
                        }
                        Err(error) => {
                            let _ = tx.send(Message::Error(error));
                        }
                    }
                });
            }
            InputKind::Setting(index) => {
                let Some(mut config) = self.config.clone() else {
                    return;
                };
                let invalid = match index {
                    0 => {
                        if self.themes.iter().any(|theme| theme.name == value) {
                            config.theme = value.clone();
                            false
                        } else {
                            true
                        }
                    }
                    1 => {
                        if ["system", "light", "dark"].contains(&value.as_str())
                            && self
                                .themes
                                .iter()
                                .find(|theme| theme.name == config.theme)
                                .is_some_and(|theme| {
                                    value == "system" || theme.appearances.contains(&value)
                                })
                        {
                            config.appearance = value.clone();
                            false
                        } else {
                            true
                        }
                    }
                    2 => match value.parse::<u32>() {
                        Ok(n) if (1..=500).contains(&n) => {
                            config.max_bulk_open = n;
                            false
                        }
                        _ => true,
                    },
                    3 => match value.parse::<u32>() {
                        Ok(n) if (100..=100000).contains(&n) => {
                            config.retention.max_entries = n;
                            false
                        }
                        _ => true,
                    },
                    _ => {
                        if value.is_empty() {
                            config.retention.max_days = None;
                            false
                        } else {
                            match value.parse::<u32>() {
                                Ok(n) if (1..=36500).contains(&n) => {
                                    config.retention.max_days = Some(n);
                                    false
                                }
                                _ => true,
                            }
                        }
                    }
                };
                if invalid {
                    self.notify("Invalid setting value");
                    self.input(InputKind::Setting(index), value);
                    return;
                }
                self.busy = true;
                let api = self.api.clone();
                let tx = self.tx.clone();
                tokio::spawn(async move {
                    match api.save_config(config).await {
                        Ok(config) => {
                            let _ = tx.send(Message::ConfigSaved(config));
                        }
                        Err(error) => {
                            let _ = tx.send(Message::Error(error));
                        }
                    }
                });
            }
        }
    }

    fn key(&mut self, key: KeyEvent) {
        if key.kind == KeyEventKind::Release {
            return;
        }
        if let Some(Modal::Input(_, value)) = &mut self.modal {
            match key.code {
                KeyCode::Esc => self.modal = None,
                KeyCode::Enter => self.confirm_modal(),
                KeyCode::Left => self.input_cursor = self.input_cursor.saturating_sub(1),
                KeyCode::Right => {
                    self.input_cursor = (self.input_cursor + 1).min(value.chars().count())
                }
                KeyCode::Home => self.input_cursor = 0,
                KeyCode::End => self.input_cursor = value.chars().count(),
                KeyCode::Backspace if self.input_cursor > 0 => {
                    let end = value
                        .char_indices()
                        .nth(self.input_cursor)
                        .map_or(value.len(), |(index, _)| index);
                    let start = value
                        .char_indices()
                        .nth(self.input_cursor - 1)
                        .map_or(0, |(index, _)| index);
                    value.replace_range(start..end, "");
                    self.input_cursor -= 1;
                }
                KeyCode::Delete if self.input_cursor < value.chars().count() => {
                    let start = value
                        .char_indices()
                        .nth(self.input_cursor)
                        .map_or(value.len(), |(index, _)| index);
                    let end = value
                        .char_indices()
                        .nth(self.input_cursor + 1)
                        .map_or(value.len(), |(index, _)| index);
                    value.replace_range(start..end, "");
                }
                KeyCode::Char('u') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                    value.clear();
                    self.input_cursor = 0;
                }
                KeyCode::Char(ch)
                    if !key
                        .modifiers
                        .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
                {
                    let byte = value
                        .char_indices()
                        .nth(self.input_cursor)
                        .map_or(value.len(), |(index, _)| index);
                    value.insert(byte, ch);
                    self.input_cursor += 1;
                }
                _ => {}
            }
            return;
        }
        if self.modal.is_some() {
            match key.code {
                KeyCode::Esc => self.modal = None,
                KeyCode::Enter => self.confirm_modal(),
                _ => {}
            }
            return;
        }
        if key
            .modifiers
            .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
        {
            return;
        }
        match key.code {
            KeyCode::Char('q') => self.quit = true,
            KeyCode::Char('?') => self.modal = Some(Modal::Help),
            KeyCode::Char('1') => self.change_page(Page::Timeline),
            KeyCode::Char('2') => self.change_page(Page::Starred),
            KeyCode::Char('3') => self.change_page(Page::Feeds),
            KeyCode::Char('4') => self.change_page(Page::Settings),
            KeyCode::Char('r') => self.refresh(),
            KeyCode::Esc => {
                if !self.selected.is_empty() {
                    self.selected.clear();
                } else {
                    self.focused = None;
                    self.notice = None;
                }
            }
            KeyCode::Char('J') => {
                if self.page == Page::Feeds {
                    self.jump_feed(true);
                } else {
                    self.move_focus(1, true);
                }
            }
            KeyCode::Char('K') => {
                if self.page == Page::Feeds {
                    self.jump_feed(false);
                } else {
                    self.move_focus(-1, true);
                }
            }
            KeyCode::Char('j') | KeyCode::Down => {
                if self.page == Page::Feeds && key.modifiers.contains(KeyModifiers::SHIFT) {
                    self.jump_feed(true);
                } else {
                    self.move_focus(1, key.modifiers.contains(KeyModifiers::SHIFT));
                }
            }
            KeyCode::Char('k') | KeyCode::Up => {
                if self.page == Page::Feeds && key.modifiers.contains(KeyModifiers::SHIFT) {
                    self.jump_feed(false);
                } else {
                    self.move_focus(-1, key.modifiers.contains(KeyModifiers::SHIFT));
                }
            }
            KeyCode::PageDown => {
                self.scroll += self.visible_rows;
                self.clamp_scroll();
            }
            KeyCode::PageUp => self.scroll = self.scroll.saturating_sub(self.visible_rows),
            KeyCode::Char('h')
                if !matches!(self.page, Page::Starred | Page::Feeds | Page::Settings) =>
            {
                self.shift_filter(-1)
            }
            KeyCode::Char('l')
                if !matches!(self.page, Page::Starred | Page::Feeds | Page::Settings) =>
            {
                self.shift_filter(1)
            }
            KeyCode::Char('a') if self.page == Page::Feeds => self.activate(Hit::AddFeed),
            KeyCode::Char('i') if self.page == Page::Feeds => self.activate(Hit::Import),
            KeyCode::Char('e') if self.page == Page::Feeds => self.activate(Hit::Export),
            KeyCode::Char('d') if self.page == Page::Feeds => {
                if let Some(id) = self.focused.clone() {
                    self.activate(Hit::DeleteFeed(id));
                }
            }
            KeyCode::Char('a') if !matches!(self.page, Page::Settings) => {
                self.mark_visible_unread()
            }
            KeyCode::Char('M') if !self.selected.is_empty() => self.selected_action("read"),
            KeyCode::Char('U') if !self.selected.is_empty() => self.selected_action("unread"),
            KeyCode::Char('S') if !self.selected.is_empty() => self.selected_action("star"),
            KeyCode::Char('O') if !self.selected.is_empty() => self.selected_action("open"),
            KeyCode::Char('O')
                if !matches!(self.page, Page::Feeds | Page::Settings | Page::Starred) =>
            {
                self.activate(Hit::OpenUnread)
            }
            KeyCode::Char('x') if !matches!(self.page, Page::Feeds | Page::Settings) => {
                if let Some(id) = self.focused.clone() {
                    self.activate(Hit::Select(id));
                }
            }
            KeyCode::Char('m') if !matches!(self.page, Page::Feeds | Page::Settings) => {
                if let Some(id) = self.focused.clone() {
                    self.toggle(id, "read");
                }
            }
            KeyCode::Char('s') if !matches!(self.page, Page::Feeds | Page::Settings) => {
                if let Some(id) = self.focused.clone() {
                    self.toggle(id, "starred");
                }
            }
            KeyCode::Char('o') | KeyCode::Enter => match self.page {
                Page::Feeds => {
                    if let Some(id) = self.focused.clone() {
                        self.change_page(Page::Feed(id));
                    }
                }
                Page::Settings => {
                    if let Some(index) = self.focused.as_ref().and_then(|id| id.parse().ok()) {
                        self.edit_setting(index);
                    }
                }
                _ => {
                    if let Some(id) = self.focused.clone() {
                        self.open_ids(vec![id]);
                    }
                }
            },
            _ => {}
        }
    }

    fn shift_filter(&mut self, direction: i32) {
        let index: usize = match self.filter {
            Filter::All => 0,
            Filter::Unread => 1,
            Filter::Read => 2,
        };
        let next = index.saturating_add_signed(direction as isize).min(2);
        self.filter = [Filter::All, Filter::Unread, Filter::Read][next];
        self.scroll = 0;
        self.focused = None;
        self.selected.clear();
    }

    fn mouse(&mut self, mouse: MouseEvent) -> bool {
        match mouse.kind {
            MouseEventKind::Moved => {
                let next = self
                    .hits
                    .iter()
                    .rev()
                    .find(|(rect, _)| inside(*rect, mouse.column, mouse.row))
                    .map(|(_, hit)| hit.clone());
                if self.hovered != next {
                    self.hovered = next;
                    return true;
                }
                false
            }
            MouseEventKind::ScrollDown => {
                if self.modal.is_some() {
                    return false;
                }
                self.scroll += 3;
                self.clamp_scroll();
                true
            }
            MouseEventKind::ScrollUp => {
                if self.modal.is_some() {
                    return false;
                }
                self.scroll = self.scroll.saturating_sub(3);
                true
            }
            MouseEventKind::Down(MouseButton::Left) => {
                let hit = self
                    .hits
                    .iter()
                    .rev()
                    .find(|(rect, _)| inside(*rect, mouse.column, mouse.row))
                    .map(|(_, hit)| hit.clone());
                if let Some(Hit::Select(ref id)) = hit {
                    self.drag_anchor = self
                        .visible()
                        .iter()
                        .position(|index| &self.entries[*index].id == id);
                } else {
                    self.drag_anchor = None;
                }
                if let Some(hit) = hit {
                    self.activate(hit);
                }
                true
            }
            MouseEventKind::Drag(MouseButton::Left) => {
                if let Some(anchor) = self.drag_anchor {
                    let hit = self
                        .hits
                        .iter()
                        .rev()
                        .find(|(rect, _)| inside(*rect, mouse.column, mouse.row))
                        .map(|(_, hit)| hit.clone());
                    if let Some(Hit::Entry(id) | Hit::Select(id) | Hit::OpenEntry(id)) = hit {
                        let visible = self.visible();
                        if let Some(index) = visible
                            .iter()
                            .position(|entry| self.entries[*entry].id == id)
                        {
                            for entry_index in visible
                                .iter()
                                .take(anchor.max(index) + 1)
                                .skip(anchor.min(index))
                            {
                                self.selected.insert(self.entries[*entry_index].id.clone());
                            }
                        }
                    }
                }
                self.drag_anchor.is_some()
            }
            MouseEventKind::Up(MouseButton::Left) => {
                self.drag_anchor = None;
                false
            }
            _ => false,
        }
    }
}

fn merge_state(current: &mut EntryState, incoming: &EntryState) {
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

fn inside(rect: Rect, x: u16, y: u16) -> bool {
    x >= rect.x && x < rect.right() && y >= rect.y && y < rect.bottom()
}

fn resolve_path(value: &str) -> PathBuf {
    if let Some(rest) = value.strip_prefix("~/")
        && let Some(home) = std::env::var_os("HOME")
    {
        return PathBuf::from(home).join(rest);
    }
    PathBuf::from(value)
}

fn ago(value: &str) -> String {
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

fn light_mode() -> bool {
    if let Ok(value) = std::env::var("COLORFGBG")
        && let Some(number) = value
            .split(';')
            .next_back()
            .and_then(|part| part.parse::<u8>().ok())
    {
        return number >= 7;
    }
    if cfg!(target_os = "macos") {
        return !Command::new("defaults")
            .args(["read", "-g", "AppleInterfaceStyle"])
            .output()
            .is_ok_and(|output| {
                output.status.success() && String::from_utf8_lossy(&output.stdout).trim() == "Dark"
            });
    }
    false
}

fn args() -> Result<(String, bool, bool), String> {
    let mut address = std::env::var("FEEDREADER_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:8787/feedreader".into());
    let mut light = light_mode();
    let mut check = false;
    let mut items = std::env::args().skip(1);
    while let Some(item) = items.next() {
        match item.as_str() {
            "--server" => address = items.next().ok_or("--server needs a URL")?,
            "--light" => light = true,
            "--dark" => light = false,
            "--check" => check = true,
            "--help" | "-h" => {
                println!(
                    "Usage: feedreader-tui [--server URL] [--light|--dark] [--check]\n\nDefault server: http://127.0.0.1:8787/feedreader\nFEEDREADER_URL sets the server URL. --check verifies the connection without opening the TUI."
                );
                std::process::exit(0);
            }
            _ => return Err(format!("Unknown argument: {item}")),
        }
    }
    Ok((address, light, check))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let (address, light, check) = args()?;
    let api = Api::new(&address)?;
    if check {
        let snapshot = api.sync().await?;
        println!(
            "Connected: {} feeds, {} entries",
            snapshot.feeds.feeds.len(),
            snapshot.entries.len()
        );
        return Ok(());
    }
    let (tx, mut rx) = mpsc::unbounded_channel();
    let mut app = App::new(api.clone(), tx.clone(), Palette::new(light));
    app.sync();
    tokio::spawn(async move { api.events(tx).await });
    let mut terminal = ratatui::init();
    crossterm::execute!(io::stdout(), EnableMouseCapture, EnableBracketedPaste)?;
    let mut events = EventStream::new();
    let mut tick = tokio::time::interval(Duration::from_millis(250));
    let mut last_age_update = Instant::now();
    let result = async {
        let mut dirty = true;
        loop {
            if dirty {
                app.hits.clear();
                terminal.draw(|frame| ui::draw(frame, &mut app))?;
                dirty = false;
            }
            if app.quit {
                break;
            }
            tokio::select! {
                Some(message) = rx.recv() => { app.handle_message(message); dirty = true; },
                event = events.next() => match event {
                    Some(Ok(Event::Key(key))) => { app.key(key); dirty = true; },
                    Some(Ok(Event::Mouse(mouse))) => dirty = app.mouse(mouse),
                    Some(Ok(Event::Paste(text))) => { app.paste(&text); dirty = true; },
                    Some(Ok(Event::Resize(_, _))) => { app.clamp_scroll(); dirty = true; },
                    Some(Err(error)) => return Err(error),
                    None => break,
                    _ => {}
                },
                _ = tick.tick() => {
                    dirty = app.expire_notice();
                    if last_age_update.elapsed() >= Duration::from_secs(30) { dirty = true; last_age_update = Instant::now(); }
                },
            }
        }
        Ok::<(), io::Error>(())
    }
    .await;
    crossterm::execute!(io::stdout(), DisableBracketedPaste, DisableMouseCapture)?;
    ratatui::restore();
    result?;
    Ok(())
}
