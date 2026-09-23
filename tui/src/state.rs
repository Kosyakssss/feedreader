use crate::api::{
    Api, Config, Entry, EntryState, EventPayload, Feeds, Message, RefreshStatus, Snapshot,
    StatePatch, Theme,
};
use crate::common::merge_state;
use crate::ui::{Hit, Palette};
use ratatui::layout::Rect;
use std::collections::{HashMap, HashSet, VecDeque};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

#[derive(Clone, PartialEq, Eq)]
pub(crate) enum Page {
    Timeline,
    Starred,
    Feeds,
    Settings,
    Feed(String),
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Filter {
    All,
    Unread,
    Read,
}

#[derive(Clone)]
pub(crate) enum InputKind {
    AddFeed,
    Import,
    Export,
    Setting(usize),
}

pub(crate) enum Modal {
    Help,
    Input(InputKind, String),
    Remove(String),
    Open(Vec<String>),
    Failures,
}

pub(crate) struct Pending {
    updates: HashMap<String, StatePatch>,
}

pub(crate) struct App {
    pub(crate) api: Api,
    pub(crate) tx: mpsc::UnboundedSender<Message>,
    pub(crate) entries: Vec<Entry>,
    pub(crate) feeds: Feeds,
    pub(crate) config: Option<Config>,
    pub(crate) themes: Vec<Theme>,
    pub(crate) status: RefreshStatus,
    pub(crate) sequence: u64,
    pub(crate) complete: bool,
    pub(crate) online: bool,
    pub(crate) started: bool,
    pub(crate) page: Page,
    pub(crate) filter: Filter,
    pub(crate) focused: Option<String>,
    pub(crate) selected: HashSet<String>,
    pub(crate) scroll: usize,
    pub(crate) visible_rows: usize,
    pub(crate) modal: Option<Modal>,
    pub(crate) notice: Option<String>,
    pub(crate) notice_at: Instant,
    pub(crate) hovered: Option<Hit>,
    pub(crate) pointer: Option<(u16, u16)>,
    pub(crate) input_cursor: usize,
    pub(crate) pending: VecDeque<Pending>,
    pub(crate) overrides: HashMap<String, StatePatch>,
    pub(crate) writing: bool,
    pub(crate) busy: bool,
    pub(crate) hits: Vec<(Rect, Hit)>,
    pub(crate) drag_anchor: Option<usize>,
    pub(crate) palette: Palette,
    pub(crate) quit: bool,
}

impl App {
    pub(crate) fn new(api: Api, tx: mpsc::UnboundedSender<Message>, palette: Palette) -> Self {
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
            pointer: None,
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

    pub(crate) fn state(&self, entry: &Entry) -> EntryState {
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

    pub(crate) fn rebuild_overrides(&mut self) {
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

    pub(crate) fn visible(&self) -> Vec<usize> {
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

    pub(crate) fn counts(&self) -> (usize, usize) {
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

    pub(crate) fn change_page(&mut self, page: Page) {
        self.page = page;
        self.filter = Filter::All;
        self.focused = None;
        self.selected.clear();
        self.scroll = 0;
        self.modal = None;
        self.hovered = None;
    }

    pub(crate) fn notify(&mut self, message: impl Into<String>) {
        self.notice = Some(message.into());
        self.notice_at = Instant::now();
    }

    pub(crate) fn input(&mut self, kind: InputKind, value: String) {
        self.input_cursor = value.chars().count();
        self.modal = Some(Modal::Input(kind, value));
    }

    pub(crate) fn paste(&mut self, pasted: &str) {
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

    pub(crate) fn expire_notice(&mut self) -> bool {
        if self.notice.is_some() && self.notice_at.elapsed() >= Duration::from_secs(4) {
            self.notice = None;
            return true;
        }
        false
    }

    pub(crate) fn top_visible_id(&self) -> Option<String> {
        if self.scroll == 0 {
            return None;
        }
        self.visible()
            .get(self.scroll)
            .map(|index| self.entries[*index].id.clone())
    }

    pub(crate) fn restore_top(&mut self, id: Option<String>) {
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

    pub(crate) fn apply_snapshot(&mut self, snapshot: Snapshot) {
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
        let focus_exists = match &self.page {
            Page::Feeds => self
                .focused
                .as_ref()
                .is_none_or(|id| self.feeds.feeds.iter().any(|feed| &feed.id == id)),
            Page::Settings => self
                .focused
                .as_ref()
                .is_none_or(|id| id.parse::<usize>().is_ok_and(|index| index < 5)),
            _ => self
                .focused
                .as_ref()
                .is_none_or(|id| self.entries.iter().any(|entry| &entry.id == id)),
        };
        if !focus_exists {
            self.focused = None;
        }
        self.restore_top(anchor);
    }

    pub(crate) fn receive_status(&mut self, incoming: RefreshStatus) {
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

    pub(crate) fn apply_event(&mut self, id: u64, event: EventPayload) {
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

    pub(crate) fn handle_message(&mut self, message: Message) {
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

    pub(crate) fn sync(&self) {
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

    pub(crate) fn queue_mark(&mut self, ids: Vec<String>, patch: StatePatch) {
        if ids.is_empty() {
            return;
        }
        self.pending.push_back(Pending {
            updates: ids.into_iter().map(|id| (id, patch.clone())).collect(),
        });
        self.rebuild_overrides();
        self.start_write();
    }

    pub(crate) fn start_write(&mut self) {
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
}
