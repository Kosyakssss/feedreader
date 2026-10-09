use std::collections::{BTreeSet, HashMap, HashSet};

use engine::{Block, Candidate, Entry, EntryId, Event, Feed, FeedId, Mode, RefreshStatus, Request, Settings};
use toolkit::field::Field;
use toolkit::ui::LineStyle;

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum View {
    Home,
    Bookmarks,
    Feed(FeedId),
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Page {
    List,
    Feeds,
    Settings,
    Help,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Focus {
    Main,
    Filter,
    Prompt,
}

#[derive(Clone, PartialEq, Debug)]
pub enum Target {
    Entry(EntryId),
    Page(String),
}

pub struct Reader {
    pub history: Vec<Target>,
    pub mode: Mode,
    pub body: Option<Result<Vec<Block>, String>>,
    pub scroll: f32,
    pub content_h: f32,
    pub view_h: f32,
}

impl Reader {
    pub fn target(&self) -> &Target {
        self.history.last().expect("reader has a target")
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Setting {
    ReadingMode,
    Lines,
    MaxEntries,
    MaxAge,
    RefreshMinutes,
    ConfirmOver,
    ImportLegacy,
}

pub const SETTINGS: &[Setting] = &[
    Setting::ReadingMode,
    Setting::Lines,
    Setting::RefreshMinutes,
    Setting::MaxEntries,
    Setting::MaxAge,
    Setting::ConfirmOver,
    Setting::ImportLegacy,
];

#[derive(Clone, PartialEq, Debug)]
pub enum PromptKind {
    AddFeed,
    Rename(FeedId),
    ImportOpml,
    ExportOpml,
    ImportLegacy,
    Setting(Setting),
}

pub struct Prompt {
    pub kind: PromptKind,
    pub label: String,
    pub field: Field,
    pub error: Option<String>,
}

#[derive(Clone, Debug)]
pub enum Confirm {
    OpenAll(Vec<EntryId>),
}

pub enum Discovery {
    Searching(String),
    Found(String, Vec<Candidate>, usize),
    Failed(String, String),
}

#[derive(Clone, Debug)]
pub enum Op {
    Read(Vec<(EntryId, bool)>),
    Bookmark(Vec<(EntryId, bool)>),
    RemoveFeed(FeedId),
    RestoreFeed(FeedId),
    Rename(FeedId, Option<String>),
    Settings(Settings),
}

struct Change {
    label: String,
    op: Op,
}

#[derive(Default)]
pub struct ListState {
    pub visible: Vec<usize>,
    pub cursor: usize,
    pub scroll: f32,
    pub view_h: f32,
    pub row_h: f32,
    pub selected: BTreeSet<EntryId>,
    pub sticky: HashSet<EntryId>,
}

#[derive(Default)]
pub struct Scroller {
    pub cursor: usize,
    pub scroll: f32,
    pub view_h: f32,
    pub row_h: f32,
}

impl Scroller {
    pub fn reveal(&mut self, len: usize) {
        self.cursor = self.cursor.min(len.saturating_sub(1));
        let top = self.cursor as f32 * self.row_h;
        if top < self.scroll {
            self.scroll = top;
        } else if top + self.row_h > self.scroll + self.view_h {
            self.scroll = top + self.row_h - self.view_h;
        }
        self.clamp(len);
    }

    pub fn clamp(&mut self, len: usize) {
        let max = (len as f32 * self.row_h - self.view_h).max(0.0);
        self.scroll = self.scroll.clamp(0.0, max);
    }
}

pub struct Model {
    pub ready: bool,
    pub data_dir: String,
    pub feeds: Vec<Feed>,
    pub feed_index: HashMap<FeedId, usize>,
    pub entries: Vec<Entry>,
    pub entry_index: HashMap<EntryId, usize>,
    pub unread_by_feed: HashMap<FeedId, usize>,
    pub unread_home: usize,
    pub bookmarks: usize,
    pub settings: Settings,
    pub refresh: RefreshStatus,
    pub page: Page,
    pub view: View,
    pub unread_only: bool,
    pub list: ListState,
    pub filter: Field,
    pub focus: Focus,
    pub reader: Option<Reader>,
    pub feeds_order: Vec<usize>,
    pub feeds_page: Scroller,
    pub settings_page: Scroller,
    pub help: Scroller,
    pub pane_scroll: f32,
    pub armed: Option<FeedId>,
    pub discovery: Option<Discovery>,
    pub prompt: Option<Prompt>,
    pub confirm: Option<Confirm>,
    pub message: Option<String>,
    pub lines: LineStyle,
    pub out: Vec<Request>,
    pub open: Vec<String>,
    pub copy: Option<String>,
    undo: Vec<Change>,
    redo: Vec<Change>,
}

pub fn lines_from(name: &str) -> LineStyle {
    match name {
        "ascii" => LineStyle::Ascii,
        "heavy" => LineStyle::Heavy,
        "double" => LineStyle::Double,
        "dotted" => LineStyle::Dotted,
        _ => LineStyle::Light,
    }
}

impl Model {
    pub fn new() -> Self {
        Self {
            ready: false,
            data_dir: String::new(),
            feeds: Vec::new(),
            feed_index: HashMap::new(),
            entries: Vec::new(),
            entry_index: HashMap::new(),
            unread_by_feed: HashMap::new(),
            unread_home: 0,
            bookmarks: 0,
            settings: Settings::default(),
            refresh: RefreshStatus::default(),
            page: Page::List,
            view: View::Home,
            unread_only: true,
            list: ListState {
                row_h: 1.0,
                ..Default::default()
            },
            filter: Field::default(),
            focus: Focus::Main,
            reader: None,
            feeds_order: Vec::new(),
            feeds_page: Scroller { row_h: 1.0, ..Default::default() },
            settings_page: Scroller { row_h: 1.0, ..Default::default() },
            help: Scroller { row_h: 1.0, ..Default::default() },
            pane_scroll: 0.0,
            armed: None,
            discovery: None,
            prompt: None,
            confirm: None,
            message: None,
            lines: LineStyle::Light,
            out: Vec::new(),
            open: Vec::new(),
            copy: None,
            undo: Vec::new(),
            redo: Vec::new(),
        }
    }

    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }

    pub fn feed(&self, id: &str) -> Option<&Feed> {
        self.feed_index.get(id).map(|&i| &self.feeds[i])
    }

    pub fn feed_name(&self, id: &str) -> &str {
        self.feed(id).map(|f| f.name()).unwrap_or("removed feed")
    }

    pub fn entry(&self, id: &str) -> Option<&Entry> {
        self.entry_index.get(id).map(|&i| &self.entries[i])
    }

    pub fn view_name(&self) -> String {
        match &self.view {
            View::Home => "Home".into(),
            View::Bookmarks => "Bookmarks".into(),
            View::Feed(id) => self.feed_name(id).to_string(),
        }
    }

    pub fn failing(&self) -> usize {
        self.feeds.iter().filter(|f| f.error.is_some()).count()
    }

    fn reindex_entries(&mut self) {
        self.entries
            .sort_by(|a, b| b.published.cmp(&a.published).then_with(|| a.id.cmp(&b.id)));
        self.entry_index = self.entries.iter().enumerate().map(|(i, e)| (e.id.clone(), i)).collect();
    }

    fn reindex_feeds(&mut self) {
        self.feed_index = self.feeds.iter().enumerate().map(|(i, f)| (f.id.clone(), i)).collect();
    }

    fn recount(&mut self) {
        self.unread_by_feed.clear();
        self.unread_home = 0;
        self.bookmarks = 0;
        for e in &self.entries {
            if !self.feed_index.contains_key(&e.feed_id) {
                continue;
            }
            if !e.read {
                self.unread_home += 1;
                *self.unread_by_feed.entry(e.feed_id.clone()).or_default() += 1;
            }
            if e.bookmarked {
                self.bookmarks += 1;
            }
        }
    }

    pub fn sort_feeds(&mut self) {
        let keep = self.feeds_order.get(self.feeds_page.cursor).and_then(|&i| self.feeds.get(i)).map(|f| f.id.clone());
        let mut order: Vec<usize> = (0..self.feeds.len()).collect();
        order.sort_by(|&a, &b| {
            let (fa, fb) = (&self.feeds[a], &self.feeds[b]);
            let ua = self.unread_by_feed.get(&fa.id).copied().unwrap_or(0);
            let ub = self.unread_by_feed.get(&fb.id).copied().unwrap_or(0);
            ub.cmp(&ua).then_with(|| fa.name().to_lowercase().cmp(&fb.name().to_lowercase()))
        });
        self.feeds_order = order;
        if let Some(id) = keep
            && let Some(row) = self.feeds_order.iter().position(|&i| self.feeds[i].id == id)
        {
            self.feeds_page.cursor = row;
        }
    }

    pub fn alphabetical(&self) -> Vec<usize> {
        let mut order: Vec<usize> = (0..self.feeds.len()).collect();
        order.sort_by_key(|&i| self.feeds[i].name().to_lowercase());
        order
    }

    fn matches(&self, e: &Entry, needle: &str) -> bool {
        if !self.feed_index.contains_key(&e.feed_id) {
            return false;
        }
        let in_view = match &self.view {
            View::Home => true,
            View::Bookmarks => e.bookmarked,
            View::Feed(id) => &e.feed_id == id,
        };
        let state_ok = !self.unread_only
            || !e.read
            || self.view == View::Bookmarks
            || self.list.sticky.contains(&e.id);
        let text_ok = needle.is_empty()
            || e.title.to_lowercase().contains(needle)
            || self.feed_name(&e.feed_id).to_lowercase().contains(needle);
        in_view && state_ok && text_ok
    }

    pub fn rebuild(&mut self) {
        let row_h = self.list.row_h;
        let first = (self.list.scroll / row_h).floor() as usize;
        let anchor = self.list.visible.get(first).map(|&i| self.entries.get(i).map(|e| e.id.clone()));
        let offset = self.list.scroll - first as f32 * row_h;
        let cursor_id = self
            .list
            .visible
            .get(self.list.cursor)
            .and_then(|&i| self.entries.get(i).map(|e| e.id.clone()));
        let needle = self.filter.text.to_lowercase();
        let visible: Vec<usize> = (0..self.entries.len())
            .filter(|&i| self.matches(&self.entries[i], &needle))
            .collect();
        self.list.visible = visible;
        let position = |id: &Option<String>, list: &[usize], entries: &[Entry]| {
            id.as_ref()
                .and_then(|id| list.iter().position(|&i| &entries[i].id == id))
        };
        if let Some(c) = position(&cursor_id, &self.list.visible, &self.entries) {
            self.list.cursor = c;
        }
        if let Some(Some(a)) = anchor.map(|a| position(&a, &self.list.visible, &self.entries)) {
            self.list.scroll = a as f32 * row_h + offset;
        }
        self.list.cursor = self.list.cursor.min(self.list.visible.len().saturating_sub(1));
        let max = (self.list.visible.len() as f32 * row_h - self.list.view_h).max(0.0);
        self.list.scroll = self.list.scroll.clamp(0.0, max);
        let live: HashSet<&EntryId> = self.list.visible.iter().map(|&i| &self.entries[i].id).collect();
        self.list.selected.retain(|id| live.contains(id));
    }

    pub fn reset_list(&mut self) {
        self.list.sticky.clear();
        self.list.selected.clear();
        self.list.cursor = 0;
        self.list.scroll = 0.0;
        self.list.visible.clear();
        self.rebuild();
    }

    pub fn go(&mut self, page: Page) {
        if page == Page::Feeds && self.page != Page::Feeds {
            self.sort_feeds();
        }
        self.page = page;
        self.reader = None;
        self.armed = None;
        self.focus = Focus::Main;
    }

    pub fn show(&mut self, view: View) {
        self.view = view;
        self.go(Page::List);
        self.reset_list();
    }

    pub fn event(&mut self, event: Event) {
        match event {
            Event::Snapshot {
                feeds,
                entries,
                settings,
                data_dir,
            } => {
                self.ready = true;
                self.data_dir = data_dir;
                self.feeds = feeds;
                self.entries = entries;
                self.lines = lines_from(&settings.lines);
                self.settings = settings;
                self.reindex_feeds();
                self.reindex_entries();
                self.recount();
                self.sort_feeds();
                self.rebuild();
            }
            Event::Feeds(feeds) => {
                self.feeds = feeds;
                self.reindex_feeds();
                if let View::Feed(id) = &self.view
                    && !self.feed_index.contains_key(id)
                {
                    self.view = View::Home;
                    self.reset_list();
                }
                self.recount();
                self.sort_feeds();
                self.rebuild();
                let n = self.feeds_order.len();
                self.feeds_page.reveal(n);
            }
            Event::EntriesAdded(added) => {
                for e in added {
                    if let Some(&i) = self.entry_index.get(&e.id) {
                        self.entries[i] = e;
                    } else {
                        self.entries.push(e);
                    }
                }
                self.reindex_entries();
                self.recount();
                self.rebuild();
            }
            Event::EntriesRemoved(ids) => {
                let gone: HashSet<EntryId> = ids.into_iter().collect();
                self.entries.retain(|e| !gone.contains(&e.id));
                self.reindex_entries();
                self.recount();
                self.rebuild();
            }
            Event::Refresh(status) => {
                let finished = self.refresh.running && !status.running;
                self.refresh = status;
                if finished && self.refresh.failed > 0 {
                    self.message = Some(format!(
                        "Refreshed. {} of {} feeds failed; details on the Feeds page.",
                        self.refresh.failed, self.refresh.total
                    ));
                }
            }
            Event::Discovered(q, r) => {
                if matches!(&self.discovery, Some(Discovery::Searching(s)) if *s == q) {
                    self.discovery = Some(match r {
                        Ok(c) => Discovery::Found(q, c, 0),
                        Err(e) => Discovery::Failed(q, e),
                    });
                }
            }
            Event::FeedAdded(r) => {
                self.discovery = None;
                self.message = Some(match r {
                    Ok((f, n)) => format!("Added {} with {} entries.", f.name(), n),
                    Err(e) => format!("Couldn't add the feed: {e}"),
                });
            }
            Event::Body(b) => {
                if let Some(r) = &mut self.reader
                    && *r.target() == Target::Entry(b.entry.clone())
                    && r.mode == b.mode
                {
                    r.body = Some(b.blocks);
                }
            }
            Event::Settings(s) => {
                self.lines = lines_from(&s.lines);
                self.settings = s;
            }
            Event::Message(m) => self.message = Some(m),
        }
    }

    fn perform(&mut self, op: Op) -> Op {
        match op {
            Op::Read(list) => {
                let mut inverse = Vec::new();
                let (mut on, mut off) = (Vec::new(), Vec::new());
                for (id, v) in list {
                    if let Some(&i) = self.entry_index.get(&id) {
                        inverse.push((id.clone(), self.entries[i].read));
                        self.entries[i].read = v;
                        if v && self.unread_only {
                            self.list.sticky.insert(id.clone());
                        }
                        if v { on.push(id) } else { off.push(id) }
                    }
                }
                if !on.is_empty() {
                    self.out.push(Request::SetRead(on, true));
                }
                if !off.is_empty() {
                    self.out.push(Request::SetRead(off, false));
                }
                self.recount();
                Op::Read(inverse)
            }
            Op::Bookmark(list) => {
                let mut inverse = Vec::new();
                let (mut on, mut off) = (Vec::new(), Vec::new());
                for (id, v) in list {
                    if let Some(&i) = self.entry_index.get(&id) {
                        inverse.push((id.clone(), self.entries[i].bookmarked));
                        self.entries[i].bookmarked = v;
                        if v { on.push(id) } else { off.push(id) }
                    }
                }
                if !on.is_empty() {
                    self.out.push(Request::SetBookmarked(on, true));
                }
                if !off.is_empty() {
                    self.out.push(Request::SetBookmarked(off, false));
                }
                self.recount();
                Op::Bookmark(inverse)
            }
            Op::RemoveFeed(id) => {
                self.out.push(Request::RemoveFeed(id.clone()));
                Op::RestoreFeed(id)
            }
            Op::RestoreFeed(id) => {
                self.out.push(Request::RestoreFeed(id.clone()));
                Op::RemoveFeed(id)
            }
            Op::Rename(id, label) => {
                let old = self.feed(&id).and_then(|f| f.label.clone());
                self.out.push(Request::RenameFeed(id.clone(), label));
                Op::Rename(id, old)
            }
            Op::Settings(s) => {
                let old = self.settings.clone();
                self.lines = lines_from(&s.lines);
                self.settings = s.clone();
                self.out.push(Request::SetSettings(s));
                Op::Settings(old)
            }
        }
    }

    pub fn act(&mut self, label: String, op: Op) {
        let inverse = self.perform(op);
        self.message = Some(format!("{label}."));
        self.undo.push(Change { label, op: inverse });
        if self.undo.len() > 500 {
            self.undo.remove(0);
        }
        self.redo.clear();
    }

    pub fn undo(&mut self) {
        if let Some(c) = self.undo.pop() {
            let inverse = self.perform(c.op);
            self.message = Some(format!("Undid: {}.", c.label));
            self.redo.push(Change { label: c.label, op: inverse });
        }
    }

    pub fn redo(&mut self) {
        if let Some(c) = self.redo.pop() {
            let inverse = self.perform(c.op);
            self.message = Some(format!("Redid: {}.", c.label));
            self.undo.push(Change { label: c.label, op: inverse });
        }
    }

    pub fn current_entry(&self) -> Option<&Entry> {
        match self.reader.as_ref().map(|r| r.target()) {
            Some(Target::Entry(id)) => self.entry(id),
            Some(Target::Page(_)) => None,
            None if self.page == Page::List => self.list.visible.get(self.list.cursor).map(|&i| &self.entries[i]),
            None => None,
        }
    }

    pub fn targets(&self) -> Vec<EntryId> {
        if self.reader.is_none() && !self.list.selected.is_empty() {
            self.list
                .visible
                .iter()
                .map(|&i| &self.entries[i].id)
                .filter(|id| self.list.selected.contains(*id))
                .cloned()
                .collect()
        } else {
            self.current_entry().map(|e| e.id.clone()).into_iter().collect()
        }
    }

    pub fn open_entry(&mut self, id: EntryId, mode: Option<Mode>) {
        let Some(e) = self.entry(&id).cloned() else { return };
        let mode = mode.unwrap_or(self.settings.reading_mode);
        if mode != Mode::Original {
            self.out.push(Request::LoadBody(id.clone(), mode));
        }
        self.reader = Some(Reader {
            history: vec![Target::Entry(id.clone())],
            mode,
            body: None,
            scroll: 0.0,
            content_h: 0.0,
            view_h: 0.0,
        });
        self.page = Page::List;
        if let Some(row) = self.list.visible.iter().position(|&i| self.entries[i].id == id) {
            self.list.cursor = row;
        }
        if !e.read {
            self.act(format!("Opened \u{201C}{}\u{201D} and marked it read", e.title), Op::Read(vec![(id, true)]));
        }
    }

    pub fn open_page(&mut self, url: String) {
        if let Some(r) = &mut self.reader {
            r.history.push(Target::Page(url));
            r.scroll = 0.0;
        }
    }

    pub fn set_mode(&mut self, mode: Mode) {
        let Some(r) = &mut self.reader else { return };
        if r.mode == mode {
            return;
        }
        r.mode = mode;
        r.body = None;
        r.scroll = 0.0;
        if let Target::Entry(id) = r.target().clone()
            && mode != Mode::Original
        {
            self.out.push(Request::LoadBody(id, mode));
        }
    }

    pub fn back(&mut self) {
        if let Some(r) = &mut self.reader {
            if r.history.len() > 1 {
                r.history.pop();
                r.scroll = 0.0;
            } else {
                self.reader = None;
            }
        }
        self.list.reveal_cursor();
    }

    pub fn step_entry(&mut self, forward: bool) {
        let Some(Target::Entry(id)) = self.reader.as_ref().map(|r| r.target().clone()) else { return };
        let Some(row) = self.list.visible.iter().position(|&i| self.entries[i].id == id) else { return };
        let next = if forward { row + 1 } else { row.wrapping_sub(1) };
        if let Some(&i) = self.list.visible.get(next) {
            let mode = self.reader.as_ref().map(|r| r.mode);
            let nid = self.entries[i].id.clone();
            self.open_entry(nid, mode);
        } else {
            self.message = Some(if forward { "That's the last entry in this view." } else { "That's the first entry in this view." }.into());
        }
    }
}

impl ListState {
    pub fn reveal_cursor(&mut self) {
        let top = self.cursor as f32 * self.row_h;
        if top < self.scroll {
            self.scroll = top;
        } else if top + self.row_h > self.scroll + self.view_h {
            self.scroll = top + self.row_h - self.view_h;
        }
        let max = (self.visible.len() as f32 * self.row_h - self.view_h).max(0.0);
        self.scroll = self.scroll.clamp(0.0, max);
    }
}
