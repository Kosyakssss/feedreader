use std::collections::{BTreeSet, HashMap, HashSet};

use engine::{Block, Candidate, Entry, EntryId, Event, Feed, FeedId, Folder, Mode, Recommendation, RefreshStatus, Request, Rule, SAVED, Settings, TabState};

pub use engine::Target;
use toolkit::field::Field;
use toolkit::images::Images;
use toolkit::text::SpanStyle;
use toolkit::ui::LineStyle;

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum View {
    Home,
    Bookmarks,
    Recommended,
    Folder(String),
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
    Palette,
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub struct SelPoint {
    pub block: usize,
    pub byte: usize,
}

#[derive(Clone)]
pub struct Geom {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    pub size: f32,
    pub line: f32,
    pub spans: Vec<(String, SpanStyle)>,
}

impl Geom {
    pub fn text(&self) -> String {
        self.spans.iter().map(|(t, _)| t.as_str()).collect()
    }

    pub fn borrowed(&self) -> Vec<(&str, SpanStyle)> {
        self.spans.iter().map(|(t, s)| (t.as_str(), *s)).collect()
    }
}

pub struct Reader {
    pub id: u64,
    pub opener: Option<u64>,
    pub kept: bool,
    pub seen: bool,
    pub history: Vec<Target>,
    pub mode: Mode,
    pub body: Option<Result<Vec<Block>, String>>,
    pub note: Option<String>,
    pub scroll: f32,
    pub content_h: f32,
    pub view_h: f32,
    pub geom: Vec<Geom>,
    pub sel: Option<(SelPoint, SelPoint)>,
}

impl Reader {
    pub fn target(&self) -> &Target {
        self.history.last().expect("reader has a target")
    }

    pub fn ordered(&self) -> Option<(SelPoint, SelPoint)> {
        let (a, b) = self.sel?;
        if a == b {
            return None;
        }
        Some(if a <= b { (a, b) } else { (b, a) })
    }

    pub fn range_in(&self, block: usize) -> Option<std::ops::Range<usize>> {
        let (a, b) = self.ordered()?;
        if block < a.block || block > b.block {
            return None;
        }
        let len = self.geom.get(block)?.text().len();
        let start = if block == a.block { a.byte } else { 0 };
        let end = if block == b.block { b.byte } else { len };
        (start < end).then_some(start..end)
    }

    pub fn selected_text(&self) -> Option<String> {
        let (a, b) = self.ordered()?;
        let parts: Vec<String> = (a.block..=b.block)
            .filter_map(|i| {
                let r = self.range_in(i)?;
                self.geom[i].text().get(r).map(str::to_string)
            })
            .collect();
        (!parts.is_empty()).then(|| parts.join("\n\n"))
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
    MergeDuplicates,
    PublicLink,
    Mute,
    Appearance,
    ReadingSize,
    ReadingWidth,
    ThemeFile,
}

pub const SETTINGS: &[Setting] = &[
    Setting::ReadingMode,
    Setting::Appearance,
    Setting::Lines,
    Setting::ReadingSize,
    Setting::ReadingWidth,
    Setting::ThemeFile,
    Setting::RefreshMinutes,
    Setting::MaxEntries,
    Setting::MaxAge,
    Setting::ConfirmOver,
    Setting::MergeDuplicates,
    Setting::PublicLink,
    Setting::ImportLegacy,
    Setting::Mute,
];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Row {
    Setting(Setting),
    Rule(usize),
}

pub fn settings_rows(m: &Model) -> Vec<Row> {
    SETTINGS
        .iter()
        .map(|&s| Row::Setting(s))
        .chain((0..m.rules.len()).map(Row::Rule))
        .collect()
}

#[derive(Clone, PartialEq, Debug)]
pub enum PromptKind {
    AddFeed,
    SaveLink,
    PickFolders(String, String),
    Rename(FeedId),
    Folders(FeedId),
    RenameFolder(String),
    Mute,
    Recommend(Vec<EntryId>),
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
    Pin(FeedId, bool),
    Hide(FeedId, bool),
    FeedMode(FeedId, Option<Mode>),
    Folders(FeedId, Vec<String>),
    RenameFolder(String, String),
    DeleteFolder(Folder),
    RestoreFolder(Folder),
    AddRule(Rule),
    RemoveRule(Rule),
    Recommend(Vec<(EntryId, Option<String>)>),
    CloseTab(u64),
    Reopen,
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
    pub anchor: Option<usize>,
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
    pub folders: Vec<Folder>,
    pub rules: Vec<Rule>,
    pub recommendations: Vec<Recommendation>,
    pub recommended: HashMap<EntryId, String>,
    pub public_url: Option<String>,
    pub hidden: HashSet<EntryId>,
    pub unread_by_folder: HashMap<String, usize>,
    pub refresh: RefreshStatus,
    pub page: Page,
    pub view: View,
    pub unread_only: bool,
    pub list: ListState,
    pub filter: Field,
    pub focus: Focus,
    pub reader: Option<Reader>,
    pub tabs: Vec<Option<Reader>>,
    pub active: usize,
    pub closed: Vec<Reader>,
    pub next_tab: u64,
    pub saved_tabs: Vec<TabState>,
    pub palette: Option<crate::palette::Palette>,
    pub feeds_order: Vec<usize>,
    pub feeds_page: Scroller,
    pub settings_page: Scroller,
    pub help: Scroller,
    pub pane_scroll: f32,
    pub armed: Option<FeedId>,
    pub discovery: Option<Discovery>,
    pub offer: Option<(String, Vec<Candidate>)>,
    pub prompt: Option<Prompt>,
    pub confirm: Option<Confirm>,
    pub message: Option<String>,
    pub bar_expanded: bool,
    pub lines: LineStyle,
    pub out: Vec<Request>,
    pub images: Images,
    pub open: Vec<String>,
    pub copy: Option<String>,
    pub edit_theme: bool,
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

impl View {
    pub fn filters_read(&self) -> bool {
        !matches!(self, View::Bookmarks | View::Recommended)
    }
}

impl Model {
    pub fn new(images: Images) -> Self {
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
            folders: Vec::new(),
            rules: Vec::new(),
            recommendations: Vec::new(),
            recommended: HashMap::new(),
            public_url: None,
            hidden: HashSet::new(),
            unread_by_folder: HashMap::new(),
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
            tabs: Vec::new(),
            active: 0,
            closed: Vec::new(),
            next_tab: 0,
            saved_tabs: Vec::new(),
            palette: None,
            feeds_order: Vec::new(),
            feeds_page: Scroller { row_h: 1.0, ..Default::default() },
            settings_page: Scroller { row_h: 1.0, ..Default::default() },
            help: Scroller { row_h: 1.0, ..Default::default() },
            pane_scroll: 0.0,
            armed: None,
            discovery: None,
            offer: None,
            prompt: None,
            confirm: None,
            message: None,
            bar_expanded: false,
            lines: LineStyle::Light,
            out: Vec::new(),
            images,
            open: Vec::new(),
            copy: None,
            edit_theme: false,
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
            View::Recommended => "I recommend".into(),
            View::Folder(id) => self.folder(id).map(|f| f.name.clone()).unwrap_or_else(|| "removed folder".into()),
            View::Feed(id) => self.feed_name(id).to_string(),
        }
    }

    pub fn folder(&self, id: &str) -> Option<&Folder> {
        self.folders.iter().find(|f| f.id == id)
    }

    pub fn folders_of(&self, feed: &str) -> Vec<&Folder> {
        self.folders.iter().filter(|f| f.feeds.iter().any(|x| x == feed)).collect()
    }

    pub fn subscriptions(&self) -> impl Iterator<Item = &Feed> {
        self.feeds.iter().filter(|f| f.id != SAVED)
    }

    pub fn failing(&self) -> usize {
        self.subscriptions().filter(|f| f.error.is_some()).count()
    }

    pub fn pinned(&self) -> Vec<usize> {
        let mut v: Vec<usize> = (0..self.feeds.len()).filter(|&i| self.feeds[i].pinned).collect();
        v.sort_by_key(|&i| self.feeds[i].name().to_lowercase());
        v
    }

    #[profiling::function]
    fn rehide(&mut self) {
        let mut folder_of: HashMap<&str, Vec<&str>> = HashMap::new();
        for f in &self.folders {
            for feed in &f.feeds {
                folder_of.entry(feed.as_str()).or_default().push(f.id.as_str());
            }
        }
        let mut hidden = HashSet::new();
        if !self.rules.is_empty() {
            for e in &self.entries {
                let folders = folder_of.get(e.feed_id.as_str()).map(Vec::as_slice).unwrap_or(&[]);
                if engine::rules::muted(&e.title, &e.feed_id, folders, &self.rules) {
                    hidden.insert(e.id.clone());
                }
            }
        }
        if self.settings.merge_duplicates {
            let mut seen: HashMap<String, &str> = HashMap::new();
            for e in self.entries.iter().rev() {
                if e.url.is_empty() || e.feed_id == SAVED {
                    continue;
                }
                let key = engine::rules::link_key(&e.url);
                match seen.get(&key) {
                    Some(first) if *first != e.feed_id => {
                        hidden.insert(e.id.clone());
                    }
                    Some(_) => {}
                    None => {
                        seen.insert(key, &e.feed_id);
                    }
                }
            }
        }
        self.hidden = hidden;
    }

    #[profiling::function]
    fn reindex_entries(&mut self) {
        self.entries
            .sort_by(|a, b| b.published.cmp(&a.published).then_with(|| a.id.cmp(&b.id)));
        self.entry_index = self.entries.iter().enumerate().map(|(i, e)| (e.id.clone(), i)).collect();
    }

    fn reindex_feeds(&mut self) {
        self.feed_index = self.feeds.iter().enumerate().map(|(i, f)| (f.id.clone(), i)).collect();
    }

    #[profiling::function]
    fn recount(&mut self) {
        let mut by_feed: HashMap<FeedId, usize> = HashMap::new();
        let (mut home, mut bookmarks) = (0, 0);
        for e in &self.entries {
            let Some(feed) = self.feed(&e.feed_id) else { continue };
            if e.bookmarked {
                bookmarks += 1;
            }
            if e.read || self.hidden.contains(&e.id) {
                continue;
            }
            if !feed.hidden {
                home += 1;
            }
            *by_feed.entry(e.feed_id.clone()).or_default() += 1;
        }
        self.unread_by_feed = by_feed;
        self.unread_home = home;
        self.bookmarks = bookmarks;
        self.unread_by_folder.clear();
        for f in &self.folders {
            let n = f.feeds.iter().map(|id| self.unread_by_feed.get(id).copied().unwrap_or(0)).sum();
            self.unread_by_folder.insert(f.id.clone(), n);
        }
    }

    fn refold(&mut self) {
        self.rehide();
        self.recount();
        self.rebuild();
    }

    pub fn sort_feeds(&mut self) {
        let keep = self.feeds_order.get(self.feeds_page.cursor).and_then(|&i| self.feeds.get(i)).map(|f| f.id.clone());
        let mut order: Vec<usize> = (0..self.feeds.len()).filter(|&i| self.feeds[i].id != SAVED).collect();
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

    fn matches(&self, e: &Entry, needle: &str) -> bool {
        let Some(feed) = self.feed(&e.feed_id) else { return false };
        let in_view = match &self.view {
            View::Home => !feed.hidden && !self.hidden.contains(&e.id),
            View::Bookmarks => e.bookmarked,
            View::Recommended => self.recommended.contains_key(&e.id),
            View::Folder(id) => {
                !self.hidden.contains(&e.id) && self.folder(id).is_some_and(|f| f.feeds.contains(&e.feed_id))
            }
            View::Feed(id) => &e.feed_id == id && !self.hidden.contains(&e.id),
        };
        let state_ok = !self.unread_only
            || !e.read
            || !self.view.filters_read()
            || self.list.sticky.contains(&e.id);
        let text_ok = needle.is_empty()
            || e.title.to_lowercase().contains(needle)
            || self.feed_name(&e.feed_id).to_lowercase().contains(needle);
        in_view && state_ok && text_ok
    }

    #[profiling::function]
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
        self.list.anchor = None;
        self.list.cursor = 0;
        self.list.scroll = 0.0;
        self.list.visible.clear();
        self.rebuild();
    }

    pub fn go(&mut self, page: Page) {
        if page == Page::Feeds && self.page != Page::Feeds {
            self.sort_feeds();
        }
        self.activate(0);
        self.page = page;
        self.armed = None;
        self.focus = Focus::Main;
    }

    pub fn show(&mut self, view: View) {
        self.view = view;
        self.go(Page::List);
        self.reset_list();
    }

    #[profiling::function]
    pub fn event(&mut self, event: Event) {
        match event {
            Event::Snapshot {
                feeds,
                entries,
                settings,
                data_dir,
                folders,
                rules,
                recommendations,
                public_url,
                tabs,
            } => {
                self.restore_tabs(tabs);
                self.ready = true;
                self.data_dir = data_dir;
                self.feeds = feeds;
                self.entries = entries;
                self.lines = lines_from(&settings.lines);
                self.settings = settings;
                self.folders = folders;
                self.rules = rules;
                self.set_recommendations(recommendations);
                self.public_url = public_url;
                self.reindex_feeds();
                self.reindex_entries();
                self.sort_feeds();
                self.refold();
            }
            Event::Folders(folders) => {
                self.folders = folders;
                if let View::Folder(id) = &self.view
                    && self.folder(id).is_none()
                {
                    self.view = View::Home;
                    self.reset_list();
                }
                self.refold();
            }
            Event::Rules(rules) => {
                self.rules = rules;
                self.refold();
            }
            Event::Recommendations(list) => {
                self.set_recommendations(list);
                self.rebuild();
            }
            Event::PublicUrl(url) => self.public_url = url,
            Event::SearchResults(q, ids) => crate::palette::results(self, q, ids),
            Event::Feeds(feeds) => {
                self.feeds = feeds;
                self.reindex_feeds();
                if let View::Feed(id) = &self.view
                    && !self.feed_index.contains_key(id)
                {
                    self.view = View::Home;
                    self.reset_list();
                }
                self.sort_feeds();
                self.refold();
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
                self.refold();
            }
            Event::EntriesUpdated(list) => {
                for (id, title, published) in list {
                    if let Some(&i) = self.entry_index.get(&id) {
                        self.entries[i].title = title;
                        self.entries[i].published = published;
                    }
                }
                self.reindex_entries();
                self.rebuild();
            }
            Event::EntriesRemoved(ids) => {
                let gone: HashSet<EntryId> = ids.into_iter().collect();
                self.entries.retain(|e| !gone.contains(&e.id));
                self.reindex_entries();
                self.refold();
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
                let target = Target::Entry(b.entry.clone());
                for r in self.reader.iter_mut().chain(self.tabs.iter_mut().flatten()) {
                    if *r.target() == target && r.mode == b.mode {
                        r.body = Some(b.blocks.clone());
                        r.note = b.note.clone();
                        r.sel = None;
                    }
                }
            }
            Event::Settings(s) => {
                let merge = s.merge_duplicates != self.settings.merge_duplicates;
                self.lines = lines_from(&s.lines);
                self.settings = s;
                if merge {
                    self.refold();
                }
            }
            Event::Message(m) => self.message = Some(m),
            Event::Extract { .. } | Event::Probed(..) => {}
            Event::Media(url, Ok(path)) => self.images.load(url, path),
            Event::FollowOffer(host, cands) => {
                self.message = Some(match cands.as_slice() {
                    [one] => format!("{host} has a feed: {}. Follow it?", one.title),
                    many => format!("{host} has {} feeds. Follow one?", many.len()),
                });
                self.offer = Some((host, cands));
            }
            Event::Media(url, Err(_)) => self.images.fail(url),
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
                let merge = s.merge_duplicates != old.merge_duplicates;
                self.lines = lines_from(&s.lines);
                self.settings = s.clone();
                self.out.push(Request::SetSettings(s));
                if merge {
                    self.refold();
                }
                Op::Settings(old)
            }
            Op::Pin(id, on) => {
                self.set_feed(&id, |f| f.pinned = on);
                self.out.push(Request::SetPinned(id.clone(), on));
                Op::Pin(id, !on)
            }
            Op::Hide(id, on) => {
                self.set_feed(&id, |f| f.hidden = on);
                self.out.push(Request::SetHidden(id.clone(), on));
                self.refold();
                Op::Hide(id, !on)
            }
            Op::FeedMode(id, mode) => {
                let old = self.feed(&id).and_then(|f| f.mode);
                self.set_feed(&id, |f| f.mode = mode);
                self.out.push(Request::SetFeedMode(id.clone(), mode));
                Op::FeedMode(id, old)
            }
            Op::Folders(id, names) => {
                let old = self.folders_of(&id).iter().map(|f| f.name.clone()).collect();
                self.out.push(Request::SetFeedFolders(id.clone(), names));
                Op::Folders(id, old)
            }
            Op::RenameFolder(id, name) => {
                let old = self.folder(&id).map(|f| f.name.clone()).unwrap_or_default();
                if let Some(f) = self.folders.iter_mut().find(|f| f.id == id) {
                    f.name = name.clone();
                }
                self.out.push(Request::RenameFolder(id.clone(), name));
                Op::RenameFolder(id, old)
            }
            Op::DeleteFolder(f) => {
                self.folders.retain(|x| x.id != f.id);
                self.out.push(Request::DeleteFolder(f.id.clone()));
                if self.view == View::Folder(f.id.clone()) {
                    self.show(View::Home);
                }
                self.refold();
                Op::RestoreFolder(f)
            }
            Op::RestoreFolder(f) => {
                self.out.push(Request::RestoreFolder(f.clone()));
                Op::DeleteFolder(f)
            }
            Op::AddRule(r) => {
                self.rules.push(r.clone());
                self.out.push(Request::AddRule(r.clone()));
                self.refold();
                Op::RemoveRule(r)
            }
            Op::RemoveRule(r) => {
                self.rules.retain(|x| x.id != r.id);
                self.out.push(Request::RemoveRule(r.id.clone()));
                self.refold();
                Op::AddRule(r)
            }
            Op::CloseTab(id) => {
                self.close_tab(id);
                Op::Reopen
            }
            Op::Reopen => Op::CloseTab(self.reopen().unwrap_or(0)),
            Op::Recommend(list) => {
                let mut inverse = Vec::new();
                for (id, note) in list {
                    inverse.push((id.clone(), self.recommended.get(&id).cloned()));
                    match note {
                        Some(n) => {
                            self.recommended.insert(id.clone(), n.clone());
                            self.out.push(Request::Recommend(id, n));
                        }
                        None => {
                            self.recommended.remove(&id);
                            self.out.push(Request::Unrecommend(id));
                        }
                    }
                }
                Op::Recommend(inverse)
            }
        }
    }

    fn set_feed(&mut self, id: &str, f: impl FnOnce(&mut Feed)) {
        if let Some(&i) = self.feed_index.get(id) {
            f(&mut self.feeds[i]);
        }
    }

    fn set_recommendations(&mut self, list: Vec<Recommendation>) {
        self.recommended = list.iter().map(|r| (r.entry.clone(), r.note.clone())).collect();
        self.recommendations = list;
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
            Some(Target::Page(_) | Target::Play(..)) => None,
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

    pub fn open_page(&mut self, url: String) {
        self.open_target(Target::Page(url));
    }

    pub fn set_mode(&mut self, mode: Mode) {
        let Some(r) = &mut self.reader else { return };
        if r.mode == mode {
            return;
        }
        r.mode = mode;
        r.body = None;
        r.note = None;
        r.sel = None;
        r.scroll = 0.0;
        if let Target::Entry(id) = r.target().clone() {
            if mode != Mode::Original {
                self.out.push(Request::LoadBody(id.clone(), mode));
            }
            if let Some(feed) = self.entry(&id).map(|e| e.feed_id.clone())
                && feed != SAVED
            {
                let remembered = (mode != self.settings.reading_mode).then_some(mode);
                if self.feed(&feed).map(|f| f.mode) != Some(remembered) {
                    self.set_feed(&feed, |f| f.mode = remembered);
                    self.out.push(Request::SetFeedMode(feed, remembered));
                }
            }
        }
    }

    pub fn step_entry(&mut self, forward: bool) {
        let Some(Target::Entry(id)) = self.reader.as_ref().map(|r| r.target().clone()) else { return };
        let Some(row) = self.list.visible.iter().position(|&i| self.entries[i].id == id) else { return };
        let next = if forward { row + 1 } else { row.wrapping_sub(1) };
        if let Some(&i) = self.list.visible.get(next) {
            let nid = self.entries[i].id.clone();
            self.replace_entry(nid);
        } else {
            self.message = Some(if forward { "That's the last entry in this view." } else { "That's the first entry in this view." }.into());
        }
    }
}

impl Model {
    pub fn select_rows(&mut self, from: usize, to: usize, on: bool) {
        let (a, b) = if from <= to { (from, to) } else { (to, from) };
        for row in a..=b.min(self.list.visible.len().saturating_sub(1)) {
            let id = self.entries[self.list.visible[row]].id.clone();
            if on {
                self.list.selected.insert(id);
            } else {
                self.list.selected.remove(&id);
            }
        }
    }

    pub fn extend(&mut self, down: bool) {
        let len = self.list.visible.len();
        if len == 0 {
            return;
        }
        let cur = self.list.cursor;
        let anchor = *self.list.anchor.get_or_insert(cur);
        if self.list.selected.is_empty() {
            self.select_rows(cur, cur, true);
        }
        let next = if down { (cur + 1).min(len - 1) } else { cur.saturating_sub(1) };
        if next == cur {
            return;
        }
        let away = if down { next > anchor } else { next < anchor };
        if away {
            self.select_rows(next, next, true);
        } else if cur != anchor {
            self.select_rows(cur, cur, false);
        }
        self.list.cursor = next;
        self.list.reveal_cursor();
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
