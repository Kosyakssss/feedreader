use crate::common::inside;
use crate::state::{App, Filter, Modal, Page};
use crate::ui::Hit;
use crossterm::event::{
    KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
};

impl App {
    pub(crate) fn hit_at(&self, x: u16, y: u16) -> Option<Hit> {
        self.hits
            .iter()
            .rev()
            .find(|(rect, _)| inside(*rect, x, y))
            .map(|(_, hit)| hit.clone())
    }

    pub(crate) fn refresh_hover(&mut self) -> bool {
        let next = self.pointer.and_then(|(x, y)| self.hit_at(x, y));
        if self.hovered == next {
            return false;
        }
        self.hovered = next;
        true
    }

    pub(crate) fn key(&mut self, key: KeyEvent) {
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

    pub(crate) fn shift_filter(&mut self, direction: i32) {
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

    pub(crate) fn mouse(&mut self, mouse: MouseEvent) -> bool {
        self.pointer = Some((mouse.column, mouse.row));
        match mouse.kind {
            MouseEventKind::Moved => self.refresh_hover(),
            MouseEventKind::ScrollDown => {
                if self.modal.is_some() {
                    return self.refresh_hover();
                }
                let before = self.scroll;
                self.scroll += 3;
                self.clamp_scroll();
                self.scroll != before || self.refresh_hover()
            }
            MouseEventKind::ScrollUp => {
                if self.modal.is_some() {
                    return self.refresh_hover();
                }
                let before = self.scroll;
                self.scroll = self.scroll.saturating_sub(3);
                self.scroll != before || self.refresh_hover()
            }
            MouseEventKind::Down(MouseButton::Left) => {
                let hit = self.hit_at(mouse.column, mouse.row);
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
                    true
                } else {
                    self.refresh_hover()
                }
            }
            MouseEventKind::Drag(MouseButton::Left) => {
                let mut changed = false;
                if let Some(anchor) = self.drag_anchor {
                    let hit = self.hit_at(mouse.column, mouse.row);
                    if let Some(Hit::Select(id) | Hit::OpenEntry(id)) = hit {
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
                                changed |=
                                    self.selected.insert(self.entries[*entry_index].id.clone());
                            }
                        }
                    }
                }
                changed || self.refresh_hover()
            }
            MouseEventKind::Up(MouseButton::Left) => {
                self.drag_anchor = None;
                self.refresh_hover()
            }
            _ => self.refresh_hover(),
        }
    }
}
