use std::collections::BTreeSet;

use crate::commands::{Chord, Command, Key, Registry, keys_label};
use crate::data::{self, Entry, Feed};
use crate::ui::{LineStyle, Rect, Scene};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum View {
    Home,
    Bookmarks,
    Feed(usize),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Focus {
    List,
    Filter,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cmd {
    Down,
    Up,
    PageDown,
    PageUp,
    Select,
    Open,
    ToggleRead,
    Bookmark,
    MarkAllRead,
    UnreadAll,
    Filter,
    FilterDone,
    FilterClear,
    Cancel,
    Close,
    Browser,
    Undo,
    Redo,
    Lines,
}

#[derive(Clone, Copy, Debug)]
pub enum Hit {
    Cmd(Cmd),
    View(View),
    Row(usize),
    Check(usize),
    Track(Rect),
    Field,
}

#[derive(Clone, Copy)]
enum Edit {
    Read(usize, bool),
    Bookmark(usize, bool),
}

struct Change {
    label: String,
    edits: Vec<Edit>,
}

pub struct Model {
    pub feeds: Vec<Feed>,
    pub entries: Vec<Entry>,
    pub view: View,
    pub unread_only: bool,
    pub filter: String,
    pub caret: usize,
    pub preedit: String,
    pub visible: Vec<usize>,
    pub cursor: usize,
    pub selected: BTreeSet<usize>,
    pub scroll: f32,
    pub list_h: f32,
    pub pane: Rect,
    pub pane_scroll: f32,
    pub pane_horizontal: bool,
    pub row_h: f32,
    pub focus: Focus,
    pub reader: Option<usize>,
    pub lines: LineStyle,
    pub message: Option<String>,
    pub browser_request: Option<String>,
    undo: Vec<Change>,
    redo: Vec<Change>,
}

pub struct PaintOut {
    pub webview: Option<Rect>,
    pub ime: Option<Rect>,
}

impl Model {
    pub fn new() -> Self {
        let (feeds, entries) = data::load();
        let mut m = Self {
            feeds,
            entries,
            view: View::Home,
            unread_only: false,
            filter: String::new(),
            caret: 0,
            preedit: String::new(),
            visible: Vec::new(),
            cursor: 0,
            selected: BTreeSet::new(),
            scroll: 0.0,
            list_h: 0.0,
            pane: Rect::default(),
            pane_scroll: 0.0,
            pane_horizontal: false,
            row_h: 1.0,
            focus: Focus::List,
            reader: None,
            lines: LineStyle::Light,
            message: None,
            browser_request: None,
            undo: Vec::new(),
            redo: Vec::new(),
        };
        m.recompute();
        m
    }

    fn in_view(&self, e: &Entry) -> bool {
        match self.view {
            View::Home => true,
            View::Bookmarks => e.bookmarked,
            View::Feed(f) => e.feed == f,
        }
    }

    fn unread_in(&self, view: View) -> usize {
        self.entries
            .iter()
            .filter(|e| {
                !e.read
                    && match view {
                        View::Home => true,
                        View::Bookmarks => e.bookmarked,
                        View::Feed(f) => e.feed == f,
                    }
            })
            .count()
    }

    pub fn recompute(&mut self) {
        let needle = self.filter.to_lowercase();
        self.visible = (0..self.entries.len())
            .filter(|&i| {
                let e = &self.entries[i];
                self.in_view(e)
                    && (!self.unread_only || !e.read || self.view == View::Bookmarks)
                    && (needle.is_empty()
                        || e.title.to_lowercase().contains(&needle)
                        || self.feeds[e.feed].label.to_lowercase().contains(&needle))
            })
            .collect();
        self.cursor = 0;
        self.scroll = 0.0;
        self.selected.clear();
    }

    fn current(&self) -> Option<usize> {
        self.reader.or_else(|| self.visible.get(self.cursor).copied())
    }

    fn targets(&self) -> Vec<usize> {
        if self.reader.is_none() && !self.selected.is_empty() {
            self.selected.iter().copied().collect()
        } else {
            self.current().into_iter().collect()
        }
    }

    fn view_name(&self) -> String {
        match self.view {
            View::Home => "Home".into(),
            View::Bookmarks => "Bookmarks".into(),
            View::Feed(f) => self.feeds[f].label.clone(),
        }
    }

    fn apply(&mut self, label: String, edits: Vec<Edit>) {
        if edits.is_empty() {
            self.message = Some("Nothing to change.".into());
            return;
        }
        let inverse = edits.iter().map(|e| self.run(*e)).collect();
        self.message = Some(format!("{label}."));
        self.undo.push(Change {
            label,
            edits: inverse,
        });
        self.redo.clear();
    }

    fn run(&mut self, edit: Edit) -> Edit {
        match edit {
            Edit::Read(i, v) => {
                let old = self.entries[i].read;
                self.entries[i].read = v;
                Edit::Read(i, old)
            }
            Edit::Bookmark(i, v) => {
                let old = self.entries[i].bookmarked;
                self.entries[i].bookmarked = v;
                Edit::Bookmark(i, old)
            }
        }
    }

    fn step(&mut self, from_undo: bool) {
        let (source, label) = if from_undo { (&mut self.undo, "Undid") } else { (&mut self.redo, "Redid") };
        let Some(change) = source.pop() else { return };
        let inverse: Vec<Edit> = change.edits.iter().rev().map(|e| self.run(*e)).collect();
        self.message = Some(format!("{label}: {}.", change.label));
        let back = Change {
            label: change.label,
            edits: inverse,
        };
        if from_undo {
            self.redo.push(back);
        } else {
            self.undo.push(back);
        }
    }

    pub fn ensure_visible(&mut self) {
        let top = self.cursor as f32 * self.row_h;
        if top < self.scroll {
            self.scroll = top;
        } else if top + self.row_h > self.scroll + self.list_h {
            self.scroll = top + self.row_h - self.list_h;
        }
        self.clamp_scroll();
    }

    pub fn clamp_scroll(&mut self) {
        let max = (self.visible.len() as f32 * self.row_h - self.list_h).max(0.0);
        self.scroll = self.scroll.clamp(0.0, max);
    }

    pub fn open(&mut self, i: usize) {
        self.reader = Some(i);
        if !self.entries[i].read {
            self.apply(
                format!("Opened \"{}\" and marked it read", self.entries[i].title),
                vec![Edit::Read(i, true)],
            );
        }
    }

    pub fn exec(&mut self, cmd: Cmd) {
        let page = (self.list_h / self.row_h).floor().max(1.0) as usize;
        match cmd {
            Cmd::Down => {
                self.cursor = (self.cursor + 1).min(self.visible.len().saturating_sub(1));
                self.ensure_visible();
            }
            Cmd::Up => {
                self.cursor = self.cursor.saturating_sub(1);
                self.ensure_visible();
            }
            Cmd::PageDown => {
                self.cursor = (self.cursor + page).min(self.visible.len().saturating_sub(1));
                self.ensure_visible();
            }
            Cmd::PageUp => {
                self.cursor = self.cursor.saturating_sub(page);
                self.ensure_visible();
            }
            Cmd::Select => {
                if let Some(&i) = self.visible.get(self.cursor) {
                    if !self.selected.remove(&i) {
                        self.selected.insert(i);
                    }
                    self.cursor = (self.cursor + 1).min(self.visible.len().saturating_sub(1));
                    self.ensure_visible();
                }
            }
            Cmd::Open => {
                if let Some(i) = self.targets().first().copied() {
                    let rest: Vec<Edit> = self.targets().iter().skip(1).map(|&j| Edit::Read(j, true)).collect();
                    if !rest.is_empty() {
                        self.apply(format!("Marked {} read", rest.len()), rest);
                    }
                    self.selected.clear();
                    self.open(i);
                }
            }
            Cmd::ToggleRead => {
                let t = self.targets();
                let to = t.iter().any(|&i| !self.entries[i].read);
                let edits = t.iter().map(|&i| Edit::Read(i, to)).collect();
                let what = if to { "read" } else { "unread" };
                self.apply(format!("Marked {} {what}", plural(t.len())), edits);
            }
            Cmd::Bookmark => {
                let t = self.targets();
                let to = t.iter().any(|&i| !self.entries[i].bookmarked);
                let edits = t.iter().map(|&i| Edit::Bookmark(i, to)).collect();
                let what = if to { "Bookmarked" } else { "Removed bookmark from" };
                self.apply(format!("{what} {}", plural(t.len())), edits);
            }
            Cmd::MarkAllRead => {
                let edits: Vec<Edit> = self
                    .visible
                    .iter()
                    .filter(|&&i| !self.entries[i].read)
                    .map(|&i| Edit::Read(i, true))
                    .collect();
                let n = edits.len();
                let view = self.view_name();
                self.apply(format!("Marked {} read in {view}", plural(n)), edits);
            }
            Cmd::UnreadAll => {
                self.unread_only = !self.unread_only;
                self.recompute();
            }
            Cmd::Filter => {
                self.focus = Focus::Filter;
                self.caret = self.filter.len();
            }
            Cmd::FilterDone => self.focus = Focus::List,
            Cmd::FilterClear => {
                self.filter.clear();
                self.caret = 0;
                self.preedit.clear();
                self.focus = Focus::List;
                self.recompute();
            }
            Cmd::Cancel => self.selected.clear(),
            Cmd::Close => self.reader = None,
            Cmd::Browser => {
                if let Some(i) = self.reader {
                    self.browser_request = Some(self.entries[i].url.clone());
                }
            }
            Cmd::Undo => self.step(true),
            Cmd::Redo => self.step(false),
            Cmd::Lines => self.lines = self.lines.next(),
        }
    }

    pub fn insert(&mut self, s: &str) {
        self.filter.insert_str(self.caret, s);
        self.caret += s.len();
        self.recompute();
    }

    pub fn backspace(&mut self) {
        if let Some((i, _)) = self.filter[..self.caret].char_indices().last() {
            self.filter.replace_range(i..self.caret, "");
            self.caret = i;
            self.recompute();
        }
    }

    pub fn caret_left(&mut self) {
        if let Some((i, _)) = self.filter[..self.caret].char_indices().last() {
            self.caret = i;
        }
    }

    pub fn caret_right(&mut self) {
        if let Some(c) = self.filter[self.caret..].chars().next() {
            self.caret += c.len_utf8();
        }
    }

    pub fn paint_select(&mut self, from: usize, to: usize, on: bool) {
        let (a, b) = if from <= to { (from, to) } else { (to, from) };
        for row in a..=b.min(self.visible.len().saturating_sub(1)) {
            let i = self.visible[row];
            if on {
                self.selected.insert(i);
            } else {
                self.selected.remove(&i);
            }
        }
    }
}

fn plural(n: usize) -> String {
    if n == 1 { "1 entry".into() } else { format!("{n} entries") }
}

fn list_mode(m: &Model) -> bool {
    m.reader.is_none() && m.focus == Focus::List
}

pub fn registry() -> Registry<Cmd, Model> {
    fn c(
        id: Cmd,
        keys: Vec<Chord>,
        label: fn(&Model) -> String,
        available: fn(&Model) -> bool,
    ) -> Command<Cmd, Model> {
        Command { id, keys, label, available }
    }
    Registry {
        commands: vec![
            c(Cmd::FilterDone, vec![Chord::key(Key::Enter)], |_| "done".into(), |m| m.focus == Focus::Filter),
            c(Cmd::FilterClear, vec![Chord::key(Key::Escape)], |_| "clear filter".into(), |m| m.focus == Focus::Filter),
            c(Cmd::Close, vec![Chord::key(Key::Escape)], |_| "back to list".into(), |m| m.reader.is_some()),
            c(Cmd::Down, vec![Chord::ch('j'), Chord::key(Key::Down)], |_| "down".into(), list_mode),
            c(Cmd::Up, vec![Chord::ch('k'), Chord::key(Key::Up)], |_| "up".into(), list_mode),
            c(Cmd::PageDown, vec![Chord::key(Key::PageDown)], |_| "page down".into(), list_mode),
            c(Cmd::PageUp, vec![Chord::key(Key::PageUp)], |_| "page up".into(), list_mode),
            c(Cmd::Select, vec![Chord::ch('x')], |_| "select".into(), list_mode),
            c(
                Cmd::Open,
                vec![Chord::ch('o'), Chord::key(Key::Enter)],
                |m| if m.selected.len() > 1 { format!("open first, mark {} read", m.selected.len()) } else { "open".into() },
                list_mode,
            ),
            c(
                Cmd::ToggleRead,
                vec![Chord::ch('m')],
                |m| {
                    let t = m.targets();
                    let to = t.iter().any(|&i| !m.entries[i].read);
                    let n = if t.len() > 1 { format!(" {}", t.len()) } else { String::new() };
                    format!("mark{n} {}", if to { "read" } else { "unread" })
                },
                |m| m.focus == Focus::List && m.current().is_some(),
            ),
            c(
                Cmd::Bookmark,
                vec![Chord::ch('s')],
                |m| {
                    let t = m.targets();
                    let to = t.iter().any(|&i| !m.entries[i].bookmarked);
                    let n = if t.len() > 1 { format!(" {}", t.len()) } else { String::new() };
                    format!("{}{n}", if to { "bookmark" } else { "unbookmark" })
                },
                |m| m.focus == Focus::List && m.current().is_some(),
            ),
            c(Cmd::Cancel, vec![Chord::key(Key::Escape)], |m| format!("deselect {}", m.selected.len()), |m| list_mode(m) && !m.selected.is_empty()),
            c(Cmd::Browser, vec![Chord::ch('b')], |_| "system browser".into(), |m| m.reader.is_some()),
            c(Cmd::UnreadAll, vec![Chord::ch('h')], |m| if m.unread_only { "show all".into() } else { "show unread".into() }, list_mode),
            c(Cmd::MarkAllRead, vec![], |_| "mark all read".into(), |m| list_mode(m) && m.selected.is_empty()),
            c(Cmd::Filter, vec![Chord::ch('/')], |_| "filter".into(), list_mode),
            c(Cmd::Undo, vec![Chord::cmd('z')], |_| "undo".into(), |m| !m.undo.is_empty()),
            c(Cmd::Redo, vec![Chord::cmd_shift('z')], |_| "redo".into(), |m| !m.redo.is_empty()),
            c(Cmd::Lines, vec![Chord::cmd('l')], |m| format!("lines: {}", m.lines.name()), |_| true),
        ],
    }
}

#[derive(Clone, Copy, Default)]
pub struct FrameStats {
    pub paint: f32,
    pub gpu: f32,
    pub max_paint: f32,
    pub max_gpu: f32,
    pub max_web: f32,
}

impl FrameStats {
    pub fn from(frames: &[[f32; 3]]) -> Self {
        let last = frames.last().copied().unwrap_or_default();
        let max = |i: usize| frames.iter().map(|f| f[i]).fold(0.0, f32::max);
        Self {
            paint: last[0],
            gpu: last[1],
            max_paint: max(0),
            max_gpu: max(1),
            max_web: max(2),
        }
    }
}

pub fn paint(m: &mut Model, reg: &Registry<Cmd, Model>, s: &mut Scene<Hit>, stats: FrameStats) -> PaintOut {
    let mt = s.m;
    let (cw, ch) = (mt.cell_w, mt.cell_h);
    let pal = s.palette;
    let mono = mt.mono();
    let mut out = PaintOut { webview: None, ime: None };

    let unread = m.entries.iter().filter(|e| !e.read).count();
    let status = [
        "FEEDREADER SPIKE".to_string(),
        "hub local ok".to_string(),
        format!("unread {unread} of {}", m.entries.len()),
        format!("{}x{} cells", mt.cols(), mt.rows()),
        format!("lines {}", m.lines.name()),
        format!("paint {:.2} ms (max {:.2})", stats.paint, stats.max_paint),
        format!("gpu {:.1} ms (max {:.1})", stats.gpu, stats.max_gpu),
        format!("web max {:.0} ms", stats.max_web),
    ];
    let (mut x, mut y) = (cw, 0.0);
    for part in &status {
        let w = s.measure(part, mono);
        if x + w > mt.width - cw && x > cw {
            x = cw;
            y += ch;
        }
        s.text(part, mono, x, y, None, pal.ink);
        x += w + cw * 3.0;
    }
    s.hline(y + ch, 0.0, mt.width);
    let body_top = y + ch * 2.0;

    let items: Vec<(Cmd, String, String)> = reg
        .available(m)
        .map(|c| (c.id, keys_label(&c.keys), (c.label)(m)))
        .collect();
    let mut bar: Vec<Vec<(Cmd, String, String, f32, f32)>> = vec![Vec::new()];
    let mut x = cw;
    for (id, keys, label) in items {
        let label = if keys.is_empty() { format!("[{label}]") } else { label };
        let kw = if keys.is_empty() { 0.0 } else { s.measure(&keys, mono) + cw };
        let w = kw + s.measure(&label, mono);
        if x + w > mt.width - cw && !bar.last().unwrap().is_empty() {
            bar.push(Vec::new());
            x = cw;
        }
        bar.last_mut().unwrap().push((id, keys, label, kw, w));
        x += w + cw * 3.0;
    }
    let bottom_rows = bar.len() + 2;
    let body_bottom = mt.height - bottom_rows as f32 * ch;
    s.hline(body_bottom, 0.0, mt.width);
    for (r, row) in bar.iter().enumerate() {
        let y = body_bottom + (r + 1) as f32 * ch;
        let mut x = cw;
        for (id, keys, label, kw, w) in row {
            if keys.is_empty() {
                s.text(label, mono, x, y, None, pal.ink);
            } else {
                s.text(keys, mono, x, y, None, pal.ink);
                s.text(label, mono, x + kw, y, None, pal.muted);
            }
            s.hit(Rect::new(x, y, *w, ch), Hit::Cmd(*id));
            x += w + cw * 3.0;
        }
    }
    let msg_y = mt.height - ch;
    if let Some(msg) = &m.message {
        let w = s.text(msg, mt.prop(400.0), cw, msg_y, Some(mt.width * 0.7), pal.ink).width;
        if reg.is_available(m, Cmd::Undo) {
            let label = format!("{} undo", Chord::cmd('z').label());
            let x = cw * 3.0 + w;
            let uw = s.text(&label, mono, x, msg_y, None, pal.muted).width;
            s.hit(Rect::new(x, msg_y, uw, ch), Hit::Cmd(Cmd::Undo));
        }
    }

    let wide = mt.cols() >= 100;
    let views: Vec<(View, String)> = std::iter::once((View::Home, "Home".to_string()))
        .chain(std::iter::once((View::Bookmarks, "Bookmarks".to_string())))
        .chain(m.feeds.iter().enumerate().map(|(i, f)| (View::Feed(i), f.label.clone())))
        .collect();
    let main = if wide {
        let pane_w = cw * 22.0;
        m.pane = Rect::new(0.0, body_top, pane_w, body_bottom - body_top);
        m.pane_horizontal = false;
        let content = ch * (views.len() + 2) as f32;
        m.pane_scroll = m.pane_scroll.clamp(0.0, (content - m.pane.h).max(0.0));
        s.push_clip(m.pane);
        let mut y = body_top - m.pane_scroll.round();
        for (n, (view, name)) in views.iter().enumerate() {
            if n == 2 {
                s.text("FEEDS", mono, cw, y, None, pal.faint);
                y += ch;
            }
            let row = Rect::new(0.0, y, pane_w, ch);
            if *view == m.view {
                s.fill(row, pal.cursor);
            }
            let count = m.unread_in(*view);
            let color = if *view == m.view { pal.ink } else { pal.muted };
            s.text(name, mono, cw, y, Some(cw * 14.0), color);
            let c = count.to_string();
            let w = s.measure(&c, mono);
            s.text(&c, mono, pane_w - cw - w, y, None, color);
            s.hit(row, Hit::View(*view));
            y += ch;
            if n == 1 {
                y += ch;
            }
        }
        s.pop_clip();
        s.vline(pane_w, body_top, body_bottom);
        Rect::new(pane_w + cw, body_top, mt.width - pane_w - cw, body_bottom - body_top)
    } else {
        let y = body_top;
        m.pane = Rect::new(0.0, y, mt.width, ch);
        m.pane_horizontal = true;
        let labels: Vec<String> = views.iter().map(|(v, n)| format!("{n} {}", m.unread_in(*v))).collect();
        let content: f32 = labels.iter().map(|l| s.measure(l, mono) + cw * 2.0).sum::<f32>() + cw;
        m.pane_scroll = m.pane_scroll.clamp(0.0, (content - mt.width).max(0.0));
        s.push_clip(m.pane);
        let mut x = cw - m.pane_scroll.round();
        for ((view, _), label) in views.iter().zip(&labels) {
            let label = label.as_str();
            let w = s.measure(label, mono);
            let r = Rect::new(x - cw * 0.5, y, w + cw, ch);
            if *view == m.view {
                s.fill(r, pal.cursor);
            }
            s.text(label, mono, x, y, None, if *view == m.view { pal.ink } else { pal.muted });
            s.hit(r, Hit::View(*view));
            x += w + cw * 2.0;
        }
        s.pop_clip();
        let y = y + ch;
        s.hline(y, 0.0, mt.width);
        Rect::new(0.0, y + ch, mt.width, body_bottom - y - ch)
    };

    if let Some(i) = m.reader {
        paint_reader(m, s, main, i, &mut out);
    } else {
        paint_list(m, s, main, &mut out);
    }
    out
}

fn paint_list(m: &mut Model, s: &mut Scene<Hit>, main: Rect, out: &mut PaintOut) {
    let mt = s.m;
    let (cw, ch) = (mt.cell_w, mt.cell_h);
    let pal = s.palette;
    let mono = mt.mono();

    let title = format!(
        "{} / {}",
        m.view_name().to_uppercase(),
        if m.unread_only { "unread" } else { "all" }
    );
    let tw = s.text(&title, mono, main.x + cw, main.y, None, pal.ink).width;
    let count = if m.visible.is_empty() {
        "nothing here".to_string()
    } else {
        format!("{} of {}", m.cursor + 1, m.visible.len())
    };
    let cnt_w = s.measure(&count, mono);
    s.text(&count, mono, main.right() - cw * 2.0 - cnt_w, main.y, None, pal.muted);

    let field_x = main.x + cw * 2.0 + tw + cw * 2.0;
    let field_w = (main.right() - cw * 4.0 - cnt_w - field_x).min(cw * 36.0);
    if field_w > cw * 8.0 {
        let field = Rect::new(field_x, main.y, field_w, ch);
        s.fill(field, pal.field);
        s.hit(field, Hit::Field);
        s.push_clip(field);
        let tx = field.x + cw * 0.5;
        if m.filter.is_empty() && m.preedit.is_empty() && m.focus != Focus::Filter {
            s.text("/ filter", mono, tx, main.y, None, pal.faint);
        } else {
            let before = &m.filter[..m.caret];
            let bw = s.text(before, mono, tx, main.y, None, pal.ink).width;
            let mut cx = tx + bw;
            if !m.preedit.is_empty() {
                let pw = s.text(&m.preedit, mono, cx, main.y, None, pal.ink).width;
                s.fill(Rect::new(cx, main.y + ch - 3.0 * mt.scale, pw, mt.scale.round()), pal.ink);
                cx += pw;
            }
            s.text(&m.filter[m.caret..], mono, cx, main.y, None, pal.ink);
            if m.focus == Focus::Filter {
                let caret = Rect::new(cx.floor(), main.y + ch * 0.15, mt.scale.round().max(1.0) * 2.0, ch * 0.7);
                s.fill(caret, pal.ink);
                out.ime = Some(caret);
            }
        }
        s.pop_clip();
    }

    let narrow = main.w < cw * 70.0;
    m.row_h = if narrow { ch * 2.0 } else { ch };
    let list = Rect::new(main.x, main.y + ch, main.w, main.h - ch);
    m.list_h = list.h;
    m.clamp_scroll();
    let track = Rect::new(main.right() - cw * 1.5, list.y, cw, list.h);
    let content = m.visible.len() as f32 * m.row_h;
    s.scrollbar(track, m.scroll, content);
    s.hit(track, Hit::Track(track));

    s.push_clip(Rect::new(list.x, list.y, list.w - cw * 1.5, list.h));
    let scroll = m.scroll.round();
    let first = (scroll / m.row_h).floor() as usize;
    let last = (((scroll + list.h) / m.row_h).ceil() as usize).min(m.visible.len());
    for row in first..last {
        let i = m.visible[row];
        let e = &m.entries[i];
        let y = list.y + row as f32 * m.row_h - scroll;
        let r = Rect::new(list.x, y, list.w - cw * 1.5, m.row_h);
        if row == m.cursor {
            s.fill(r, pal.cursor);
        }
        let mut x = list.x + cw;
        s.checkbox(x, y, m.selected.contains(&i));
        s.hit(Rect::new(list.x, y, cw * 4.5, m.row_h), Hit::Check(row));
        x += cw * 4.0;
        let flags = format!("{}{}", if e.read { ' ' } else { 'N' }, if e.bookmarked { 'B' } else { ' ' });
        s.text(&flags, mono, x, y, None, pal.ink);
        x += cw * 3.0;
        let when = data::when(e.published);
        let ww = s.measure(&when, mono);
        s.text(&when, mono, x + cw * 6.0 - ww, y, None, pal.muted);
        x += cw * 8.0;
        let src = m.feeds[e.feed].label.as_str();
        let title_style = if e.read { mt.prop(400.0) } else { mt.prop(600.0) };
        let title_color = if e.read { pal.muted } else { pal.ink };
        if narrow {
            s.text(src, mono, x, y, Some(r.right() - x - cw), pal.muted);
            let tx = list.x + cw * 5.0;
            s.text(&e.title, title_style, tx, y + ch, Some(r.right() - tx - cw), title_color);
        } else {
            s.text(src, mono, x, y, Some(cw * 18.0), pal.muted);
            x += cw * 20.0;
            s.text(&e.title, title_style, x, y, Some(r.right() - x - cw), title_color);
        }
        s.hit(Rect::new(list.x + cw * 4.5, y, r.w - cw * 4.5, m.row_h), Hit::Row(row));
    }
    if last == m.visible.len() {
        let y = list.y + m.visible.len() as f32 * m.row_h - scroll;
        if y + ch <= list.bottom() {
            s.text("That's everything.", mt.prop(400.0), list.x + cw * 5.0, y + ch * 0.5, None, pal.faint);
        }
    }
    s.pop_clip();
}

fn paint_reader(m: &mut Model, s: &mut Scene<Hit>, main: Rect, i: usize, out: &mut PaintOut) {
    let mt = s.m;
    let (cw, ch) = (mt.cell_w, mt.cell_h);
    let pal = s.palette;
    let mono = mt.mono();
    let e = &m.entries[i];
    let mut big = mt.prop(600.0);
    big.size *= 1.5;
    let h = s
        .paragraph(&e.title, big, ch * 1.5, main.x + cw, main.y + ch * 0.25, main.w - cw * 3.0, pal.ink)
        .height;
    let mut y = main.y + (h / ch).ceil() * ch;
    let meta = format!(
        "{}   {}   {}   {}{}",
        m.feeds[e.feed].label,
        data::when(e.published),
        e.url,
        if e.read { "read" } else { "unread" },
        if e.bookmarked { "   bookmarked" } else { "" }
    );
    s.text(&meta, mono, main.x + cw, y, Some(main.w - cw * 3.0), pal.muted);
    y += ch;
    s.hline(y, main.x, main.right());
    y += ch;
    let web = Rect::new(main.x, y, main.w, main.bottom() - y);
    s.text(&format!("loading {} in the web pane", e.url), mono, web.x + cw, web.y, None, pal.faint);
    out.webview = Some(web);
}
