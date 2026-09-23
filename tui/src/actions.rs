use crate::api::{Message, StatePatch};
use crate::common::resolve_path;
use crate::state::{App, InputKind, Modal, Page};
use crate::ui::Hit;
use std::process::Command;

impl App {
    pub(crate) fn toggle(&mut self, id: String, key: &str) {
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

    pub(crate) fn refresh(&mut self) {
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

    pub(crate) fn open_ids(&mut self, ids: Vec<String>) {
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

    pub(crate) fn open_now(&mut self, ids: Vec<String>) {
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

    pub(crate) fn mark_visible_unread(&mut self) {
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

    pub(crate) fn selected_action(&mut self, action: &str) {
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

    pub(crate) fn move_focus(&mut self, direction: i32, extend: bool) {
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

    pub(crate) fn jump_feed(&mut self, last: bool) {
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

    pub(crate) fn clamp_scroll(&mut self) {
        let total = match self.page {
            Page::Feeds => self.feeds.feeds.len(),
            Page::Settings => 5,
            _ => self.visible().len(),
        };
        self.scroll = self.scroll.min(total.saturating_sub(self.visible_rows));
    }

    pub(crate) fn activate(&mut self, hit: Hit) {
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

    pub(crate) fn edit_setting(&mut self, index: usize) {
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

    pub(crate) fn confirm_modal(&mut self) {
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

    pub(crate) fn submit_input(&mut self, kind: InputKind, value: String) {
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
}
