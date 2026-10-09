use std::collections::HashSet;

use engine::{EntryId, FeedId, Request};
use toolkit::commands::Registry;
use toolkit::field::Field;
use toolkit::ui::{Rect, Scene};

use crate::cmds::{self, Cmd};
use crate::model::{Focus, Model, View};
use crate::view::{Hit, Scroll};

#[derive(Clone, Debug, PartialEq)]
pub enum Item {
    Command(Cmd),
    View(View),
    Feed(FeedId),
    Entry(EntryId),
}

pub struct Palette {
    pub field: Field,
    pub items: Vec<Item>,
    pub cursor: usize,
    pub scroll: f32,
    pub view_h: f32,
    pub row_h: f32,
    pub hits: Option<(String, HashSet<EntryId>)>,
}

impl Palette {
    pub fn new() -> Self {
        Self {
            field: Field::default(),
            items: Vec::new(),
            cursor: 0,
            scroll: 0.0,
            view_h: 0.0,
            row_h: 1.0,
            hits: None,
        }
    }

    pub fn reveal(&mut self) {
        let top = self.cursor as f32 * self.row_h;
        if top < self.scroll {
            self.scroll = top;
        } else if top + self.row_h > self.scroll + self.view_h {
            self.scroll = top + self.row_h - self.view_h;
        }
        let max = (self.items.len() as f32 * self.row_h - self.view_h).max(0.0);
        self.scroll = self.scroll.clamp(0.0, max);
    }
}

#[derive(Default)]
struct Query {
    words: Vec<String>,
    read: Option<bool>,
    bookmarked: bool,
    folder: Option<String>,
    feed: Option<FeedId>,
    error: Option<String>,
}

fn parse(m: &Model, text: &str) -> Query {
    let mut q = Query::default();
    for token in text.split_whitespace() {
        let lower = token.to_lowercase();
        if let Some(v) = lower.strip_prefix("is:") {
            match v {
                "unread" => q.read = Some(false),
                "read" => q.read = Some(true),
                "bookmarked" | "saved" => q.bookmarked = true,
                _ => q.error = Some(format!("is:{v} isn't a filter; use is:unread, is:read or is:bookmarked")),
            }
        } else if let Some(v) = lower.strip_prefix("in:") {
            let v = v.replace('_', " ");
            match m.folders.iter().find(|f| f.name.to_lowercase() == v).or_else(|| m.folders.iter().find(|f| f.name.to_lowercase().contains(&v))) {
                Some(f) => q.folder = Some(f.id.clone()),
                None => q.error = Some(format!("No folder matches \u{201C}{v}\u{201D}")),
            }
        } else if let Some(v) = lower.strip_prefix("from:") {
            let v = v.replace('_', " ");
            match m.subscriptions().find(|f| f.name().to_lowercase() == v).or_else(|| m.subscriptions().find(|f| f.name().to_lowercase().contains(&v))) {
                Some(f) => q.feed = Some(f.id.clone()),
                None => q.error = Some(format!("No feed matches \u{201C}{v}\u{201D}")),
            }
        } else {
            q.words.push(lower);
        }
    }
    q
}

pub fn fuzzy(hay: &str, needle: &str) -> bool {
    let mut chars = hay.chars().flat_map(char::to_lowercase);
    needle.chars().all(|n| chars.any(|c| c == n))
}

pub fn text_query(text: &str) -> String {
    text.split_whitespace().filter(|t| !t.contains(':')).collect::<Vec<_>>().join(" ")
}

pub fn refresh(m: &mut Model) {
    let Some(p) = m.palette.as_ref() else { return };
    let text = p.field.text.clone();
    let q = parse(m, &text);
    let joined = q.words.join(" ");
    let filtered = q.read.is_some() || q.bookmarked || q.folder.is_some() || q.feed.is_some();
    let mut items = Vec::new();
    if !filtered {
        let focus = std::mem::replace(&mut m.focus, Focus::Main);
        let palette = m.palette.take();
        let reg = cmds::registry();
        let mut seen = HashSet::new();
        for c in reg.available(m) {
            if c.id == Cmd::Palette || !seen.insert(c.id) {
                continue;
            }
            let label = (c.label)(m);
            if joined.is_empty() || fuzzy(&label, &joined.replace(' ', "")) {
                items.push(Item::Command(c.id));
            }
        }
        m.palette = palette;
        m.focus = focus;
        let mut views = vec![View::Home, View::Bookmarks, View::Recommended];
        views.extend(m.folders.iter().map(|f| View::Folder(f.id.clone())));
        for v in views {
            let name = match &v {
                View::Folder(id) => m.folder(id).map(|f| f.name.clone()).unwrap_or_default(),
                View::Home => "Home".into(),
                View::Bookmarks => "Bookmarks".into(),
                View::Recommended => "I recommend".into(),
                View::Feed(_) => String::new(),
            };
            if joined.is_empty() || fuzzy(&name, &joined.replace(' ', "")) {
                items.push(Item::View(v));
            }
        }
        if !joined.is_empty() {
            let mut feeds: Vec<&engine::Feed> = m.subscriptions().filter(|f| fuzzy(f.name(), &joined.replace(' ', ""))).collect();
            feeds.sort_by_key(|f| f.name().to_lowercase());
            items.extend(feeds.into_iter().map(|f| Item::Feed(f.id.clone())));
        }
    }
    if q.error.is_none() && (filtered || !joined.is_empty()) {
        let body_hits = p_hits(m, &text_query(&text));
        let folder_feeds: Option<HashSet<&str>> = q
            .folder
            .as_ref()
            .and_then(|id| m.folder(id))
            .map(|f| f.feeds.iter().map(String::as_str).collect());
        let mut n = 0;
        for e in &m.entries {
            if m.feed(&e.feed_id).is_none() {
                continue;
            }
            if q.read.is_some_and(|r| r != e.read) || (q.bookmarked && !e.bookmarked) {
                continue;
            }
            if q.feed.as_ref().is_some_and(|f| *f != e.feed_id) {
                continue;
            }
            if folder_feeds.as_ref().is_some_and(|set| !set.contains(e.feed_id.as_str())) {
                continue;
            }
            if !q.words.is_empty() {
                let title = e.title.to_lowercase();
                let in_title = q.words.iter().all(|w| title.contains(w.as_str()));
                let in_body = body_hits.is_some_and(|h| h.contains(&e.id));
                if !in_title && !in_body {
                    continue;
                }
            }
            items.push(Item::Entry(e.id.clone()));
            n += 1;
            if n >= 500 {
                break;
            }
        }
    }
    if let Some(p) = m.palette.as_mut() {
        p.items = items;
        p.cursor = p.cursor.min(p.items.len().saturating_sub(1));
        p.reveal();
    }
    if !joined.is_empty() {
        let fts = text_query(&text);
        if m.palette.as_ref().and_then(|p| p.hits.as_ref()).is_none_or(|(q, _)| *q != fts) {
            m.out.push(Request::Search(fts));
        }
    }
}

fn p_hits<'a>(m: &'a Model, fts: &str) -> Option<&'a HashSet<EntryId>> {
    m.palette.as_ref()?.hits.as_ref().filter(|(q, _)| q == fts).map(|(_, h)| h)
}

pub fn open(m: &mut Model) {
    m.palette = Some(Palette::new());
    m.focus = Focus::Palette;
    refresh(m);
}

pub fn close(m: &mut Model) {
    m.palette = None;
    m.focus = Focus::Main;
}

pub fn activate(m: &mut Model, i: usize) {
    let Some(item) = m.palette.as_ref().and_then(|p| p.items.get(i).cloned()) else { return };
    close(m);
    match item {
        Item::Command(c) => cmds::exec(m, c),
        Item::View(v) => m.show(v),
        Item::Feed(id) => m.show(View::Feed(id)),
        Item::Entry(id) => m.open_entry(id, None),
    }
}

pub fn results(m: &mut Model, q: String, ids: Vec<EntryId>) {
    if let Some(p) = m.palette.as_mut() {
        p.hits = Some((q, ids.into_iter().collect()));
    }
    refresh(m);
}

fn describe(m: &Model, reg: &Registry<Cmd, Model>, item: &Item) -> (String, String, &'static str) {
    match item {
        Item::Command(c) => {
            let cmd = reg.commands.iter().find(|x| x.id == *c);
            let label = cmd.map(|x| (x.label)(m)).unwrap_or_default();
            let keys = cmd.map(|x| toolkit::commands::keys_label(&x.keys)).unwrap_or_default();
            (label, keys, "command")
        }
        Item::View(v) => {
            let name = match v {
                View::Home => "Home".into(),
                View::Bookmarks => "Bookmarks".into(),
                View::Recommended => "I recommend".into(),
                View::Folder(id) => m.folder(id).map(|f| f.name.clone()).unwrap_or_default(),
                View::Feed(id) => m.feed_name(id).to_string(),
            };
            (name, String::new(), if matches!(v, View::Folder(_)) { "folder" } else { "view" })
        }
        Item::Feed(id) => (m.feed_name(id).to_string(), String::new(), "feed"),
        Item::Entry(id) => {
            let e = m.entry(id);
            let title = e.map(|e| e.title.clone()).unwrap_or_default();
            let meta = e.map(|e| format!("{}  {}", crate::view::when(e.published), m.feed_name(&e.feed_id))).unwrap_or_default();
            (title, meta, "entry")
        }
    }
}

#[profiling::function]
pub fn paint(m: &mut Model, reg: &Registry<Cmd, Model>, s: &mut Scene<Hit>, main: Rect) -> Option<Rect> {
    let mt = s.m;
    let (cw, ch) = (mt.cell_w, mt.cell_h);
    let pal = s.palette;
    let mono = mt.mono();
    let text = m.palette.as_ref().map(|p| p.field.text.clone()).unwrap_or_default();
    let error = parse(m, &text).error;
    let title = "SEARCH AND COMMANDS";
    let tw = s.text(title, mono, main.x + cw, main.y, None, pal.ink).width;
    let fx = main.x + cw * 3.0 + tw;
    let field = Rect::new(fx, main.y, (main.right() - fx - cw * 2.0).max(cw * 10.0), ch);
    let current = m.palette.as_ref().map(|p| p.field.clone()).unwrap_or_default();
    let caret = s.field(field, &current, true, "type to search; is:unread in:folder from:feed");
    s.hit(field, Hit::Palette(usize::MAX));
    let mut y = main.y + ch;
    if let Some(e) = &error {
        s.text(e, mono, main.x + cw, y, Some(main.w - cw * 2.0), pal.danger);
        y += ch;
    }
    let list = Rect::new(main.x, y, main.w, main.bottom() - y);
    let Some(p) = m.palette.as_mut() else { return caret };
    p.row_h = ch;
    p.view_h = list.h;
    let max = (p.items.len() as f32 * ch - list.h).max(0.0);
    p.scroll = p.scroll.clamp(0.0, max);
    let scroll = p.scroll.round();
    let cursor = p.cursor;
    let items = p.items.clone();
    let track = Rect::new(main.right() - cw * 2.5, list.y, cw * 2.0, list.h);
    s.hit(list, Hit::Area(Scroll::Palette));
    s.scrollbar(track, scroll, items.len() as f32 * ch);
    s.hit(track, Hit::Track(track, Scroll::Palette));
    if items.is_empty() {
        let msg = if text.trim().is_empty() { "Nothing to show." } else { "Nothing matches." };
        s.text(msg, mt.prop(400.0), main.x + cw, list.y, None, pal.muted);
        return caret;
    }
    s.push_clip(Rect::new(list.x, list.y, list.w - cw * 2.5, list.h));
    let first = (scroll / ch).floor() as usize;
    let last = (((scroll + list.h) / ch).ceil() as usize).min(items.len());
    for row in first..last {
        let y = list.y + row as f32 * ch - scroll;
        let r = Rect::new(list.x, y, list.w - cw * 2.5, ch);
        if row == cursor {
            s.fill(r, pal.cursor);
        } else {
            s.hover(r);
        }
        let (name, meta, kind) = describe(m, reg, &items[row]);
        s.text(kind, mono, main.x + cw, y, None, pal.faint);
        let nx = main.x + cw * 10.0;
        let mw = if meta.is_empty() { 0.0 } else { s.measure(&meta, mono).min(main.w * 0.35) };
        let style = if kind == "entry" && m.entry(match &items[row] { Item::Entry(id) => id, _ => "" }).is_some_and(|e| !e.read) { mt.prop(600.0) } else { mt.prop(400.0) };
        s.text(&name, style, nx, y, Some(r.right() - nx - mw - cw * 3.0), pal.ink);
        if !meta.is_empty() {
            s.text(&meta, mono, r.right() - cw - mw, y, Some(mw), pal.muted);
        }
        s.hit(r, Hit::Palette(row));
    }
    s.pop_clip();
    caret
}
