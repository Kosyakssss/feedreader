use engine::{EntryId, Mode, Request, TabState, Target};

use crate::model::{Model, Op, Page, Reader};

impl Model {
    pub fn tab(&self, n: usize) -> Option<&Reader> {
        if n == self.active {
            self.reader.as_ref()
        } else {
            self.tabs.get(n.checked_sub(1)?)?.as_ref()
        }
    }

    fn stash(&mut self) {
        if self.active > 0
            && let Some(r) = self.reader.take()
        {
            self.tabs[self.active - 1] = Some(r);
        }
    }

    fn load(&mut self) {
        let Some(r) = self.reader.as_mut() else { return };
        if r.body.is_none()
            && r.mode != Mode::Original
            && let Target::Entry(id) = r.target().clone()
        {
            self.out.push(Request::LoadBody(id, r.mode));
        }
    }

    pub fn activate(&mut self, n: usize) {
        if n > self.tabs.len() {
            return;
        }
        if n == self.active {
            if n > 0 {
                self.page = Page::List;
            }
            return;
        }
        self.stash();
        self.active = n;
        if n > 0 {
            self.reader = self.tabs[n - 1].take();
            if let Some(r) = self.reader.as_mut()
                && r.seen
            {
                r.kept = true;
            }
            if let Some(r) = self.reader.as_mut() {
                r.seen = true;
            }
            self.page = Page::List;
            self.load();
        }
        self.palette = None;
        self.persist_tabs();
    }

    fn new_reader(&mut self, target: Target, mode: Mode, kept: bool) -> Reader {
        self.next_tab += 1;
        Reader {
            id: self.next_tab,
            opener: (self.active > 0).then(|| self.reader.as_ref().map(|r| r.id)).flatten(),
            kept,
            seen: !kept,
            history: vec![target],
            mode,
            body: None,
            note: None,
            scroll: 0.0,
            content_h: 0.0,
            view_h: 0.0,
            geom: Vec::new(),
            sel: None,
        }
    }

    fn mode_for(&self, id: &str, mode: Option<Mode>) -> Mode {
        mode.or_else(|| self.entry(id).and_then(|e| self.feed(&e.feed_id)).and_then(|f| f.mode))
            .unwrap_or(self.settings.reading_mode)
    }

    pub fn open_entry(&mut self, id: EntryId, mode: Option<Mode>) {
        let Some(e) = self.entry(&id).cloned() else { return };
        let mode = self.mode_for(&id, mode);
        let r = self.new_reader(Target::Entry(id.clone()), mode, false);
        let at = self.active;
        self.stash();
        self.tabs.insert(at, None);
        self.active = at + 1;
        self.reader = Some(r);
        self.page = Page::List;
        self.palette = None;
        self.load();
        if let Some(row) = self.list.visible.iter().position(|&i| self.entries[i].id == id) {
            self.list.cursor = row;
        }
        if !e.read {
            self.act(format!("Opened \u{201C}{}\u{201D} and marked it read", e.title), Op::Read(vec![(id, true)]));
        }
        self.persist_tabs();
    }

    pub fn open_background(&mut self, ids: Vec<EntryId>) {
        let mut read = Vec::new();
        let mut at = self.active;
        while at < self.tabs.len() && self.tabs[at].as_ref().is_some_and(|r| r.kept && !r.seen) {
            at += 1;
        }
        for id in ids {
            let Some(e) = self.entry(&id).cloned() else { continue };
            let mode = self.mode_for(&id, None);
            let r = self.new_reader(Target::Entry(id.clone()), mode, true);
            self.tabs.insert(at, Some(r));
            at += 1;
            if !e.read {
                read.push((id, true));
            }
        }
        if !read.is_empty() {
            let n = read.len();
            self.act(format!("Opened {n} in background tabs and marked {} read", if n == 1 { "it" } else { "them" }), Op::Read(read));
        }
        self.persist_tabs();
    }

    pub fn replace_entry(&mut self, id: EntryId) {
        let Some(e) = self.entry(&id).cloned() else { return };
        let Some(r) = self.reader.as_mut() else { return };
        if let Some(last) = r.history.last_mut() {
            *last = Target::Entry(id.clone());
        }
        r.body = None;
        r.note = None;
        r.sel = None;
        r.scroll = 0.0;
        r.geom.clear();
        self.load();
        if let Some(row) = self.list.visible.iter().position(|&i| self.entries[i].id == id) {
            self.list.cursor = row;
        }
        if !e.read {
            self.act(format!("Opened \u{201C}{}\u{201D} and marked it read", e.title), Op::Read(vec![(id, true)]));
        }
        self.persist_tabs();
    }

    pub fn open_target(&mut self, t: Target) {
        if let Some(r) = &mut self.reader {
            r.history.push(t);
            r.scroll = 0.0;
            r.kept = true;
        }
        self.persist_tabs();
    }

    pub fn back(&mut self) {
        let Some(r) = self.reader.as_mut() else { return };
        if r.history.len() > 1 {
            r.history.pop();
            r.scroll = 0.0;
            r.body = None;
            self.load();
            self.persist_tabs();
        } else if r.kept {
            self.activate(0);
        } else {
            let id = r.id;
            let title = self.tab_title(self.active);
            self.act(format!("Closed \u{201C}{title}\u{201D}"), Op::CloseTab(id));
            self.list.reveal_cursor();
        }
    }

    pub fn close_active(&mut self) {
        if let Some(id) = self.reader.as_ref().map(|r| r.id) {
            let title = self.tab_title(self.active);
            self.act(format!("Closed \u{201C}{title}\u{201D}"), Op::CloseTab(id));
        }
    }

    pub fn close_tab(&mut self, id: u64) {
        self.stash();
        let Some(pos) = self.tabs.iter().position(|t| t.as_ref().is_some_and(|r| r.id == id)) else { return };
        let Some(r) = self.tabs.remove(pos) else { return };
        let opener = r.opener;
        self.closed.push(r);
        if self.closed.len() > 30 {
            self.closed.remove(0);
        }
        let was_active = self.active == pos + 1;
        if self.active > pos + 1 {
            self.active -= 1;
        }
        if was_active {
            self.active = 0;
            self.reader = None;
            let back = opener.and_then(|o| self.tabs.iter().position(|t| t.as_ref().is_some_and(|r| r.id == o)));
            if let Some(i) = back {
                self.activate(i + 1);
            }
        } else if self.active > 0 {
            self.reader = self.tabs[self.active - 1].take();
        }
        self.persist_tabs();
    }

    pub fn reopen(&mut self) -> Option<u64> {
        let mut r = self.closed.pop()?;
        r.seen = true;
        let id = r.id;
        let at = self.active;
        self.stash();
        self.tabs.insert(at, None);
        self.active = at + 1;
        self.reader = Some(r);
        self.page = Page::List;
        self.load();
        self.persist_tabs();
        Some(id)
    }

    pub fn cycle_tab(&mut self, forward: bool) {
        let n = self.tabs.len() + 1;
        let next = if forward { (self.active + 1) % n } else { (self.active + n - 1) % n };
        self.activate(next);
    }

    pub fn tab_title(&self, n: usize) -> String {
        if n == 0 {
            return self.view_name();
        }
        let Some(r) = self.tab(n) else { return String::new() };
        match r.target() {
            Target::Entry(id) => self.entry(id).map(|e| e.title.clone()).unwrap_or_else(|| "Gone".into()),
            Target::Page(u) | Target::Play(u, _) => url::Url::parse(u).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_else(|| u.clone()),
        }
    }

    pub fn persist_tabs(&mut self) {
        let states: Vec<TabState> = (1..=self.tabs.len())
            .filter_map(|n| self.tab(n))
            .map(|r| TabState { history: r.history.clone(), mode: r.mode, scroll: r.scroll, kept: r.kept })
            .collect();
        if states != self.saved_tabs {
            self.saved_tabs = states.clone();
            self.out.push(Request::SetTabs(states));
        }
    }

    pub fn restore_tabs(&mut self, states: Vec<TabState>) {
        self.tabs.clear();
        self.active = 0;
        self.reader = None;
        for st in states {
            if st.history.is_empty() {
                continue;
            }
            self.next_tab += 1;
            self.tabs.push(Some(Reader {
                id: self.next_tab,
                opener: None,
                kept: true,
                seen: true,
                history: st.history,
                mode: st.mode,
                body: None,
                note: None,
                scroll: st.scroll,
                content_h: 0.0,
                view_h: 0.0,
                geom: Vec::new(),
                sel: None,
            }));
        }
        self.saved_tabs = (1..=self.tabs.len())
            .filter_map(|n| self.tab(n))
            .map(|r| TabState { history: r.history.clone(), mode: r.mode, scroll: r.scroll, kept: r.kept })
            .collect();
    }
}
