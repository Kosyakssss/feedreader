use chrono::{DateTime, Local};
use engine::Mode;
use toolkit::commands::{Chord, Registry, keys_label};
use toolkit::ui::{Rect, Scene};

use crate::article;
use crate::cmds::Cmd;
use crate::model::{Confirm, Discovery, Focus, Model, Page, Row, Setting, Target, View, settings_rows};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scroll {
    List,
    Feeds,
    Settings,
    Help,
    Reader,
    Pane,
}

#[derive(Clone, Debug)]
pub enum Hit {
    Cmd(Cmd),
    View(View),
    Page(Page),
    Row(usize),
    Check(usize),
    Track(Rect, Scroll),
    Area(Scroll),
    Filter,
    Feed(usize),
    Setting(usize),
    Candidate(usize),
    ReadToggle(usize),
    BookmarkToggle(usize),
    Link(String),
    Media(String),
    Prompt,
}

#[derive(Clone, Copy, Default)]
pub struct FrameStats {
    pub paint: f32,
    pub gpu: f32,
    pub max_paint: f32,
    pub max_gpu: f32,
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
        }
    }
}

pub struct PaintOut {
    pub webview: Option<(Rect, String)>,
    pub ime: Option<Rect>,
}

pub fn when(ms: i64) -> String {
    let Some(t) = DateTime::from_timestamp_millis(ms) else { return String::new() };
    let t = t.with_timezone(&Local);
    let days = (Local::now().date_naive() - t.date_naive()).num_days();
    if days <= 0 {
        t.format("%H:%M").to_string()
    } else if days < 7 {
        t.format("%a").to_string()
    } else if t.format("%Y").to_string() == Local::now().format("%Y").to_string() {
        t.format("%-d %b").to_string()
    } else {
        t.format("%b %Y").to_string()
    }
}

pub fn clock(ms: i64) -> String {
    DateTime::from_timestamp_millis(ms)
        .map(|t| t.with_timezone(&Local).format("%H:%M").to_string())
        .unwrap_or_default()
}

pub fn full_date(ms: i64) -> String {
    DateTime::from_timestamp_millis(ms)
        .map(|t| t.with_timezone(&Local).format("%-d %B %Y, %H:%M").to_string())
        .unwrap_or_default()
}

fn ago(ms: Option<i64>) -> String {
    let Some(ms) = ms else { return "never".into() };
    let mins = (engine::now() - ms) / 60_000;
    match mins {
        i64::MIN..=0 => "just now".into(),
        1..=59 => format!("{mins} min ago"),
        60..=1439 => format!("{} h ago", mins / 60),
        _ => format!("{} d ago", mins / 1440),
    }
}

pub struct Part {
    key: String,
    label: String,
    color: [f32; 4],
    hit: Option<Hit>,
    optional: bool,
}

impl Part {
    fn info(label: String, color: [f32; 4]) -> Self {
        Self { key: String::new(), label, color, hit: None, optional: false }
    }

    fn button(key: String, label: String, color: [f32; 4], hit: Hit) -> Self {
        Self { key, label, color, hit: Some(hit), optional: false }
    }

    fn text(&self) -> String {
        match (&self.hit, self.key.is_empty()) {
            (None, _) => self.label.clone(),
            (Some(_), true) => format!("[{}]", self.label),
            (Some(_), false) => format!("[{} {}]", self.key, self.label),
        }
    }
}

fn button(s: &mut Scene<Hit>, p: &Part, x: f32, y: f32) -> f32 {
    let mono = s.m.mono();
    let (cw, ch) = (s.m.cell_w, s.m.cell_h);
    let pal = s.palette;
    let w = s.measure(&p.text(), mono);
    let Some(hit) = &p.hit else {
        s.text(&p.label, mono, x, y, None, p.color);
        return w;
    };
    let r = Rect::new(x - cw * 0.25, y, w + cw * 0.5, ch);
    let hovered = s.hover(r);
    let mut cx = x;
    cx += s.text("[", mono, cx, y, None, pal.faint).width;
    if !p.key.is_empty() {
        cx += s.text(&p.key, mono, cx, y, None, pal.ink).width;
        cx += cw;
    }
    let label = if hovered { pal.ink } else { p.color };
    cx += s.text(&p.label, mono, cx, y, None, label).width;
    s.text("]", mono, cx, y, None, pal.faint);
    s.hit(r, hit.clone());
    w
}

fn layout_parts(s: &mut Scene<Hit>, parts: &[Part], x0: f32, right: f32, gap: f32) -> Vec<Vec<(usize, f32)>> {
    let mono = s.m.mono();
    let mut rows: Vec<Vec<(usize, f32)>> = vec![Vec::new()];
    let mut x = x0;
    for (i, p) in parts.iter().enumerate() {
        let w = s.measure(&p.text(), mono);
        if x + w > right && x > x0 {
            if p.optional {
                continue;
            }
            rows.push(Vec::new());
            x = x0;
        }
        rows.last_mut().unwrap().push((i, x));
        x += w + gap;
    }
    rows
}

fn draw_parts(s: &mut Scene<Hit>, parts: &[Part], rows: &[Vec<(usize, f32)>], y0: f32) -> f32 {
    let ch = s.m.cell_h;
    let mut y = y0;
    for row in rows {
        for &(i, x) in row {
            button(s, &parts[i], x, y);
        }
        y += ch;
    }
    y
}

#[profiling::function]
pub fn paint(m: &mut Model, reg: &Registry<Cmd, Model>, s: &mut Scene<Hit>, stats: FrameStats) -> PaintOut {
    let mt = s.m;
    let (cw, ch) = (mt.cell_w, mt.cell_h);
    let pal = s.palette;
    let mono = mt.mono();
    let mut out = PaintOut { webview: None, ime: None };
    let hair = mt.scale.round().max(1.0);

    let refresh = if !m.ready {
        "starting".to_string()
    } else if m.refresh.running {
        format!("refreshing {}/{}", m.refresh.completed, m.refresh.total)
    } else {
        let last = m.refresh.finished_at.or_else(|| m.feeds.iter().filter_map(|f| f.last_fetched).max());
        match (last, m.refresh.next_at) {
            (Some(f), Some(n)) => format!("refreshed {}, next {}", clock(f), clock(n)),
            (Some(f), None) => format!("refreshed {}", clock(f)),
            _ => "not refreshed yet".into(),
        }
    };
    let mut parts = vec![
        Part::info("FEEDREADER".into(), pal.ink),
        Part::info(format!("{} unread", m.unread_home), pal.ink),
        Part::info(refresh, pal.muted),
    ];
    let failing = m.failing();
    if failing > 0 {
        parts.push(Part::button(
            String::new(),
            format!("{failing} {} failing", if failing == 1 { "feed" } else { "feeds" }),
            pal.danger,
            Hit::Page(Page::Feeds),
        ));
    }
    let mut perf = Part::info(
        format!("paint {:.1} ms (max {:.1}) gpu {:.1} (max {:.1})", stats.paint, stats.max_paint, stats.gpu, stats.max_gpu),
        pal.faint,
    );
    perf.optional = true;
    parts.push(perf);
    let rows = layout_parts(s, &parts, cw, mt.width - cw, cw * 3.0);
    let top = draw_parts(s, &parts, &rows, 0.0);
    s.hline(top, 0.0, mt.width);
    let body_top = top + ch;

    let mut commands: Vec<(u8, Part)> = reg
        .available(m)
        .filter(|c| c.id != Cmd::More && (m.bar_expanded || c.rank == 0))
        .map(|c| {
            let key = c.keys.first().map(|k| k.label()).unwrap_or_default();
            let color = if key.is_empty() { pal.ink } else { pal.muted };
            (c.rank, Part::button(key, (c.label)(m), color, Hit::Cmd(c.id)))
        })
        .collect();
    commands.sort_by_key(|c| c.0);
    let mut bar: Vec<Part> = commands.into_iter().map(|c| c.1).collect();
    let more = reg.is_available(m, Cmd::More);
    let total_rows = (mt.height / ch).floor() as usize;
    let max_rows = if m.bar_expanded { total_rows / 3 } else if total_rows < 22 { 1 } else { 2 };
    let mut bar_rows = layout_parts(s, &bar, cw, mt.width - cw, cw * 2.0);
    if more {
        let label = if m.bar_expanded { "less".to_string() } else { "more".to_string() };
        let more_part = Part::button(String::new(), label, pal.ink, Hit::Cmd(Cmd::More));
        let more_w = s.measure(&more_part.text(), mono);
        bar_rows.truncate(max_rows.max(1));
        let last = bar_rows.last_mut().unwrap();
        while let Some(&(i, x)) = last.last() {
            let w = s.measure(&bar[i].text(), mono);
            if x + w + cw * 2.0 + more_w <= mt.width - cw {
                break;
            }
            last.pop();
        }
        let x = last
            .last()
            .map(|&(i, x)| x + s.measure(&bar[i].text(), mono) + cw * 2.0)
            .unwrap_or(cw);
        bar.push(more_part);
        last.push((bar.len() - 1, x));
    }
    let mut rows_needed = bar_rows.len();
    if m.prompt.is_some() {
        rows_needed += 1;
    }
    if m.confirm.is_some() {
        rows_needed += 1;
    }
    let bottom_h = (rows_needed + 2) as f32 * ch;
    let body_bottom = (mt.height - bottom_h).max(body_top + ch * 2.0);
    s.hline(body_bottom, 0.0, mt.width);
    let mut y = body_bottom + ch;
    if let Some(p) = &m.prompt {
        let lw = s.text(&p.label, mono, cw, y, Some(mt.width * 0.45), pal.ink).width;
        let fx = cw * 2.0 + lw;
        let err_w = p.error.as_ref().map(|e| s.measure(e, mono) + cw * 2.0).unwrap_or(0.0);
        let fw = (mt.width - fx - cw - err_w).max(cw * 10.0);
        let field = Rect::new(fx, y, fw, ch);
        let caret = s.field(field, &p.field, m.focus == Focus::Prompt, "");
        s.hit(field, Hit::Prompt);
        if let Some(e) = &p.error {
            s.text(e, mono, field.right() + cw, y, None, pal.danger);
        }
        if m.focus == Focus::Prompt {
            out.ime = caret;
        }
        y += ch;
    }
    if let Some(Confirm::OpenAll(ids)) = &m.confirm {
        let q = format!("Open {} unread entries in the browser? They will be marked read.", ids.len());
        s.text(&q, mono, cw, y, None, pal.ink);
        y += ch;
    }
    draw_parts(s, &bar, &bar_rows, y);
    let msg_y = mt.height - ch;
    if let Some(msg) = &m.message {
        let undo = m.can_undo() && m.focus == Focus::Main;
        let undo_part = Part::button(Chord::cmd('z').label(), "undo".into(), pal.muted, Hit::Cmd(Cmd::Undo));
        let uw = if undo { s.measure(&undo_part.text(), mono) + cw * 3.0 } else { 0.0 };
        let w = s.text(msg, mt.prop(400.0), cw, msg_y, Some(mt.width - cw * 2.0 - uw), pal.ink).width;
        if undo {
            button(s, &undo_part, cw * 3.0 + w, msg_y);
        }
    }

    let wide = mt.cols() >= 100;
    let main = if wide {
        let pane_w = cw * 26.0;
        paint_pane(m, s, Rect::new(0.0, body_top, pane_w, body_bottom - body_top));
        if m.lines == toolkit::ui::LineStyle::Ascii {
            s.vline(pane_w, body_top, body_bottom);
        } else {
            s.vline(pane_w, (top + ch / 2.0).floor(), (body_bottom + ch / 2.0).floor() + hair);
        }
        Rect::new(pane_w + cw, body_top, mt.width - pane_w - cw, body_bottom - body_top)
    } else {
        paint_strip(m, s, Rect::new(0.0, body_top, mt.width, ch));
        s.hline(body_top + ch, 0.0, mt.width);
        Rect::new(0.0, body_top + ch * 2.0, mt.width, body_bottom - body_top - ch * 2.0)
    };

    if !m.ready {
        s.text("Opening the library\u{2026}", mt.prop(400.0), main.x + cw, main.y, None, pal.muted);
        return out;
    }
    if m.reader.is_some() {
        paint_reader(m, s, main, &mut out);
        return out;
    }
    match m.page {
        Page::List => paint_list(m, s, main, &mut out),
        Page::Feeds => paint_feeds(m, s, main),
        Page::Settings => paint_settings(m, s, main),
        Page::Help => paint_help(m, reg, s, main),
    }
    out
}

pub enum Nav {
    Heading(&'static str),
    Item { hit: Hit, name: String, count: String, active: bool, label: bool },
}

fn nav_items(m: &Model) -> Vec<Nav> {
    let on_list = m.page == Page::List;
    let item = |hit: Hit, name: String, count: String, active: bool, label: bool| Nav::Item { hit, name, count, active, label };
    let mut v = vec![
        Nav::Heading("VIEWS"),
        item(Hit::View(View::Home), "1 HOME".into(), String::new(), on_list && m.view == View::Home, true),
        item(Hit::View(View::Bookmarks), "2 BOOKMARKS".into(), String::new(), on_list && m.view == View::Bookmarks, true),
        item(Hit::View(View::Recommended), "  I RECOMMEND".into(), String::new(), on_list && m.view == View::Recommended, true),
    ];
    if !m.folders.is_empty() {
        v.push(Nav::Heading("FOLDERS"));
        for f in &m.folders {
            let view = View::Folder(f.id.clone());
            let n = m.unread_by_folder.get(&f.id).copied().unwrap_or(0);
            v.push(item(Hit::View(view.clone()), f.name.clone(), count(n), on_list && m.view == view, false));
        }
    }
    let pinned = m.pinned();
    if !pinned.is_empty() {
        v.push(Nav::Heading("PINNED"));
        for i in pinned {
            let f = &m.feeds[i];
            let view = View::Feed(f.id.clone());
            let n = m.unread_by_feed.get(&f.id).copied().unwrap_or(0);
            v.push(item(Hit::View(view.clone()), f.name().to_string(), count(n), on_list && m.view == view, false));
        }
    }
    v.push(Nav::Heading("LIBRARY"));
    v.push(item(Hit::Page(Page::Feeds), "3 FEEDS".into(), String::new(), m.page == Page::Feeds, true));
    v.push(item(Hit::Page(Page::Settings), "4 SETTINGS".into(), String::new(), m.page == Page::Settings, true));
    v
}

fn count(n: usize) -> String {
    if n > 0 { n.to_string() } else { String::new() }
}

#[profiling::function]
fn paint_pane(m: &mut Model, s: &mut Scene<Hit>, r: Rect) {
    let (cw, ch) = (s.m.cell_w, s.m.cell_h);
    let pal = s.palette;
    let mono = s.m.mono();
    let items = nav_items(m);
    let content = ch * (items.len() + 1) as f32;
    m.pane_scroll = m.pane_scroll.clamp(0.0, (content - r.h).max(0.0));
    s.hit(r, Hit::Area(Scroll::Pane));
    s.push_clip(r);
    let mut y = r.y - m.pane_scroll.round();
    for (n, item) in items.into_iter().enumerate() {
        if let Nav::Heading(_) = item
            && n > 0
        {
            y += ch * 0.5;
        }
        if y + ch < r.y || y > r.bottom() {
            y += ch;
            continue;
        }
        match item {
            Nav::Heading(h) => {
                s.text(h, mono, cw, y, None, pal.faint);
            }
            Nav::Item { hit, name, count, active, label } => {
                let row = Rect::new(r.x, y, r.w, ch);
                if active {
                    s.fill(row, pal.cursor);
                } else {
                    s.hover(row);
                }
                let color = if active { pal.ink } else { pal.muted };
                let cw_count = if count.is_empty() { 0.0 } else { s.measure(&count, mono) };
                let style = if label { mono } else { s.m.prop(if count.is_empty() { 400.0 } else { 600.0 }) };
                let name_color = if !label && !count.is_empty() { pal.ink } else { color };
                let x = if label { cw } else { cw * 3.0 };
                s.text(&name, style, x, y, Some(r.w - x - cw * 2.0 - cw_count), name_color);
                if !count.is_empty() {
                    s.text(&count, mono, r.right() - cw - cw_count, y, None, color);
                }
                s.hit(row, hit);
            }
        }
        y += ch;
    }
    s.pop_clip();
}

fn paint_strip(m: &mut Model, s: &mut Scene<Hit>, r: Rect) {
    let cw = s.m.cell_w;
    let pal = s.palette;
    let mono = s.m.mono();
    let items: Vec<(Hit, String, bool)> = nav_items(m)
        .into_iter()
        .filter_map(|n| match n {
            Nav::Item { hit, name, count, active, .. } => {
                let name = name.trim().to_string();
                let name: String = if name.chars().count() > 24 {
                    name.chars().take(23).collect::<String>().trim_end().to_string() + "\u{2026}"
                } else {
                    name
                };
                Some((hit, if count.is_empty() { name } else { format!("{name} {count}") }, active))
            }
            Nav::Heading(_) => None,
        })
        .collect();
    let content: f32 = items.iter().map(|(_, l, _)| s.measure(l, mono) + cw * 2.0).sum::<f32>() + cw;
    m.pane_scroll = m.pane_scroll.clamp(0.0, (content - r.w).max(0.0));
    s.hit(r, Hit::Area(Scroll::Pane));
    s.push_clip(r);
    let mut x = cw - m.pane_scroll.round();
    for (hit, label, active) in items {
        let w = s.measure(&label, mono);
        if x + w > 0.0 && x < r.right() {
            let cell = Rect::new(x - cw * 0.5, r.y, w + cw, r.h);
            if active {
                s.fill(cell, pal.cursor);
            } else {
                s.hover(cell);
            }
            s.text(&label, mono, x, r.y, None, if active { pal.ink } else { pal.muted });
            s.hit(cell, hit);
        }
        x += w + cw * 2.0;
    }
    s.pop_clip();
}

#[profiling::function]
fn paint_list(m: &mut Model, s: &mut Scene<Hit>, main: Rect, out: &mut PaintOut) {
    let mt = s.m;
    let (cw, ch) = (mt.cell_w, mt.cell_h);
    let pal = s.palette;
    let mono = mt.mono();

    let state = if !m.view.filters_read() { "newest first" } else if m.unread_only { "unread" } else { "all" };
    let title = format!("{} \u{00B7} {state}", m.view_name()).to_uppercase();
    let tw = s.text(&title, mono, main.x + cw, main.y, Some(main.w * 0.4), pal.ink).width;
    let count = if m.list.visible.is_empty() {
        String::new()
    } else {
        format!("{} of {}", m.list.cursor + 1, m.list.visible.len())
    };
    let cnt_w = s.measure(&count, mono);
    s.text(&count, mono, main.right() - cw * 2.0 - cnt_w, main.y, None, pal.muted);
    let fx = main.x + cw * 3.0 + tw;
    let fw = (main.right() - cw * 4.0 - cnt_w - fx).min(cw * 36.0);
    if fw > cw * 8.0 {
        let field = Rect::new(fx, main.y, fw, ch);
        let caret = s.field(field, &m.filter, m.focus == Focus::Filter, "filter");
        s.hit(field, Hit::Filter);
        if m.focus == Focus::Filter {
            out.ime = caret;
        }
    }

    let narrow = main.w < cw * 72.0;
    m.list.row_h = if narrow { ch * 2.0 } else { ch };
    let list = Rect::new(main.x, main.y + ch, main.w, main.h - ch);
    m.list.view_h = list.h;
    let max = (m.list.visible.len() as f32 * m.list.row_h - list.h).max(0.0);
    m.list.scroll = m.list.scroll.clamp(0.0, max);
    let track = Rect::new(main.right() - cw * 2.5, list.y, cw * 2.0, list.h);
    s.hit(list, Hit::Area(Scroll::List));
    s.scrollbar(track, m.list.scroll, m.list.visible.len() as f32 * m.list.row_h);
    s.hit(track, Hit::Track(track, Scroll::List));

    if m.list.visible.is_empty() {
        let text = if !m.filter.text.is_empty() {
            format!("Nothing here matches \u{201C}{}\u{201D}.", m.filter.text)
        } else if m.feeds.is_empty() {
            "No feeds yet. Press 3 for the Feeds page, then a to add one.".to_string()
        } else if m.view == View::Bookmarks {
            "No bookmarks yet. Press s on an entry to keep it here.".to_string()
        } else if m.view == View::Recommended {
            "Nothing recommended yet. Use recommend on an entry to share it with friends through your public link.".to_string()
        } else if m.unread_only {
            "Nothing unread here. Press h to see everything.".to_string()
        } else {
            "No entries here yet.".to_string()
        };
        s.text(&text, mt.prop(400.0), list.x + cw, list.y + ch, Some(list.w - cw * 3.0), pal.muted);
        return;
    }

    s.push_clip(Rect::new(list.x, list.y, list.w - cw * 2.5, list.h));
    let scroll = m.list.scroll.round();
    let row_h = m.list.row_h;
    let first = (scroll / row_h).floor() as usize;
    let last = (((scroll + list.h) / row_h).ceil() as usize).min(m.list.visible.len());
    for row in first..last {
        let i = m.list.visible[row];
        let e = &m.entries[i];
        let y = list.y + row as f32 * row_h - scroll;
        let r = Rect::new(list.x, y, list.w - cw * 2.5, row_h);
        let selected = m.list.selected.contains(&e.id);
        if row == m.list.cursor {
            s.fill(r, pal.cursor);
        } else {
            s.hover(r);
        }
        let mut x = list.x + cw;
        s.checkbox(x, y, selected);
        s.hit(Rect::new(list.x, y, cw * 4.5, row_h), Hit::Check(row));
        x += cw * 4.0;
        let read_cell = Rect::new(x - cw * 0.25, y, cw * 1.5, row_h);
        let mark_cell = Rect::new(x + cw * 1.25, y, cw * 1.5, row_h);
        for (cell, on, glyph) in [(read_cell, !e.read, "N"), (mark_cell, e.bookmarked, "B")] {
            let hovered = s.hovered(cell);
            if hovered {
                let c = pal.cursor;
                s.fill(cell, c);
            }
            let (t, c) = if on { (glyph, pal.ink) } else if hovered { (glyph, pal.faint) } else { ("\u{00B7}", pal.rule) };
            s.text(t, mono, cell.x + cw * 0.25, y, None, c);
        }
        s.hit(read_cell, Hit::ReadToggle(row));
        s.hit(mark_cell, Hit::BookmarkToggle(row));
        x += cw * 3.0;
        let w = when(e.published);
        let ww = s.measure(&w, mono);
        s.text(&w, mono, x + cw * 8.0 - ww, y, None, pal.muted);
        x += cw * 10.0;
        let src = m.feed_name(&e.feed_id).to_string();
        let style = mt.prop(if e.read { 400.0 } else { 600.0 });
        let color = if e.read { pal.muted } else { pal.ink };
        let title = if e.title.is_empty() { "Untitled" } else { e.title.as_str() };
        if narrow {
            s.text(&src, mono, x, y, Some(r.right() - x - cw), pal.muted);
            let tx = list.x + cw * 5.0;
            s.text(title, style, tx, y + ch, Some(r.right() - tx - cw), color);
        } else {
            s.text(&src, mono, x, y, Some(cw * 18.0), pal.muted);
            x += cw * 20.0;
            s.text(title, style, x, y, Some(r.right() - x - cw), color);
        }
        s.hit(Rect::new(list.x + cw * 7.0, y, r.w - cw * 7.0, row_h), Hit::Row(row));
    }
    if last == m.list.visible.len() {
        let y = list.y + m.list.visible.len() as f32 * row_h - scroll;
        if y + ch <= list.bottom() {
            s.text("That's everything.", mt.prop(400.0), list.x + cw * 5.0, y + ch * 0.5, None, pal.faint);
        }
    }
    s.pop_clip();
}

#[profiling::function]
fn paint_reader(m: &mut Model, s: &mut Scene<Hit>, main: Rect, out: &mut PaintOut) {
    let mt = s.m;
    let (cw, ch) = (mt.cell_w, mt.cell_h);
    let pal = s.palette;
    let mono = mt.mono();
    let target = m.reader.as_ref().map(|r| r.target().clone()).expect("reader");
    let mode = m.reader.as_ref().map(|r| r.mode).unwrap_or(Mode::Clean);
    let mut y = main.y;
    let x = main.x + cw;
    let width = main.w - cw * 3.0;
    match &target {
        Target::Page(url) => {
            s.text(url, mono, x, y, Some(width), pal.muted);
            y += ch;
            s.hline(y, main.x - cw * 0.5, main.right());
            y += ch;
            let web = Rect::new(main.x, y, main.w, main.bottom() - y);
            s.text("Loading the page\u{2026}", mono, web.x + cw, web.y, None, pal.faint);
            out.webview = Some((web, url.clone()));
            return;
        }
        Target::Entry(id) => {
            let Some(e) = m.entry(id).cloned() else {
                s.text("This entry is gone.", mt.prop(400.0), x, y, None, pal.muted);
                return;
            };
            let title = if e.title.is_empty() { "Untitled".to_string() } else { e.title.clone() };
            let mut meta = vec![m.feed_name(&e.feed_id).to_string(), full_date(e.published)];
            if let Some(a) = &e.author {
                meta.push(a.clone());
            }
            meta.push(if e.read { "read".into() } else { "unread".into() });
            if e.bookmarked {
                meta.push("bookmarked".into());
            }
            let meta = meta.join("   ");
            if mode == Mode::Original {
                s.text(&title, mt.prop(650.0), x, y, Some(width), pal.ink);
                y += ch;
                s.text(&meta, mono, x, y, Some(width), pal.muted);
                y += ch;
                s.hline(y, main.x - cw * 0.5, main.right());
                y += ch;
                let rest = Rect::new(main.x, y, main.w, main.bottom() - y);
                s.text("Loading the page\u{2026}", mono, rest.x + cw, rest.y, None, pal.faint);
                out.webview = Some((rest, e.url.clone()));
            } else {
                article::paint(m, s, main, article::Header { title, meta, url: e.url.clone() });
            }
        }
    }
}

#[profiling::function]
fn paint_feeds(m: &mut Model, s: &mut Scene<Hit>, main: Rect) {
    let mt = s.m;
    let (cw, ch) = (mt.cell_w, mt.cell_h);
    let pal = s.palette;
    let mono = mt.mono();
    let failing = m.failing();
    let mut head = format!("FEEDS \u{00B7} {} SUBSCRIBED", m.feeds.len());
    if failing > 0 {
        head.push_str(&format!(" \u{00B7} {failing} FAILING"));
    }
    s.text(&head, mono, main.x + cw, main.y, Some(main.w - cw * 2.0), pal.ink);
    let mut y = main.y + ch;

    match &m.discovery {
        Some(Discovery::Searching(q)) => {
            s.text(&format!("Looking for feeds at {q}\u{2026}"), mono, main.x + cw, y, Some(main.w - cw * 2.0), pal.muted);
            y += ch;
            s.hline(y, main.x - cw * 0.5, main.right());
            y += ch;
        }
        Some(Discovery::Failed(q, e)) => {
            s.text(&format!("Couldn't find a feed at {q}: {e}"), mono, main.x + cw, y, Some(main.w - cw * 2.0), pal.danger);
            y += ch;
            s.hline(y, main.x - cw * 0.5, main.right());
            y += ch;
        }
        Some(Discovery::Found(q, cands, cur)) => {
            let n = cands.len();
            s.text(
                &format!("Found {n} {} at {q}", if n == 1 { "feed" } else { "feeds" }),
                mono,
                main.x + cw,
                y,
                Some(main.w - cw * 2.0),
                pal.ink,
            );
            y += ch;
            for (i, c) in cands.iter().enumerate() {
                let r = Rect::new(main.x, y, main.w - cw, ch * 2.0);
                if i == *cur {
                    s.fill(r, pal.cursor);
                } else {
                    s.hover(r);
                }
                let mut line = format!("{}   {}   {} entries", c.title, c.kind, c.entries);
                if let Some(l) = c.latest {
                    line.push_str(&format!("   latest {}", when(l)));
                }
                if c.subscribed {
                    line.push_str("   already subscribed");
                }
                s.text(&line, mt.prop(600.0), main.x + cw * 2.0, y, Some(main.w - cw * 4.0), pal.ink);
                s.text(&c.url, mono, main.x + cw * 2.0, y + ch, Some(main.w - cw * 4.0), pal.muted);
                s.hit(r, Hit::Candidate(i));
                y += ch * 2.0;
            }
            s.hline(y, main.x - cw * 0.5, main.right());
            y += ch;
        }
        None => {}
    }

    let narrow = main.w < cw * 90.0;
    let list = Rect::new(main.x, y, main.w, main.bottom() - y);
    let row_h = if narrow { ch * 2.0 } else { ch };
    let p = &mut m.feeds_page;
    p.row_h = row_h;
    p.view_h = list.h;
    p.clamp(m.feeds_order.len());
    let track = Rect::new(main.right() - cw * 2.5, list.y, cw * 2.0, list.h);
    s.hit(list, Hit::Area(Scroll::Feeds));
    s.scrollbar(track, p.scroll, m.feeds_order.len() as f32 * row_h);
    s.hit(track, Hit::Track(track, Scroll::Feeds));
    if m.feeds_order.is_empty() {
        s.text(
            "No feeds yet. Press a to add one by its address, or i to import an OPML file.",
            mt.prop(400.0),
            main.x + cw,
            list.y + ch,
            Some(main.w - cw * 3.0),
            pal.muted,
        );
        return;
    }
    s.push_clip(Rect::new(list.x, list.y, list.w - cw * 2.5, list.h));
    let scroll = p.scroll.round();
    let first = (scroll / row_h).floor() as usize;
    let last = (((scroll + list.h) / row_h).ceil() as usize).min(m.feeds_order.len());
    let cursor = p.cursor;
    for row in first..last {
        let f = &m.feeds[m.feeds_order[row]];
        let y = list.y + row as f32 * row_h - scroll;
        let r = Rect::new(list.x, y, list.w - cw * 2.5, row_h);
        let armed = m.armed.as_ref() == Some(&f.id);
        if row == cursor {
            s.fill(r, pal.cursor);
        } else {
            s.hover(r);
        }
        let unread = m.unread_by_feed.get(&f.id).copied().unwrap_or(0);
        let x0 = list.x + cw;
        let status = if armed {
            ("press d again to remove".to_string(), pal.danger)
        } else if let Some(e) = &f.error {
            (e.clone(), pal.danger)
        } else {
            let mut parts = vec![format!("checked {}", ago(f.last_fetched))];
            if f.pinned {
                parts.push("pinned".into());
            }
            if f.hidden {
                parts.push("not on home".into());
            }
            let folders: Vec<&str> = m.folders_of(&f.id).iter().map(|x| x.name.as_str()).collect();
            if !folders.is_empty() {
                parts.push(format!("in {}", folders.join(", ")));
            }
            if let Some(mode) = f.mode {
                parts.push(format!("opens in {}", mode.name()));
            }
            (parts.join(" \u{00B7} "), pal.muted)
        };
        let n = if unread > 0 { unread.to_string() } else { String::new() };
        let style = mt.prop(if unread > 0 { 600.0 } else { 400.0 });
        if narrow {
            s.text(f.name(), style, x0, y, Some(r.w - cw * 8.0), pal.ink);
            let nw = s.measure(&n, mono);
            s.text(&n, mono, r.right() - cw - nw, y, None, pal.ink);
            s.text(&status.0, mono, x0 + cw * 2.0, y + ch, Some(r.w - cw * 4.0), status.1);
        } else {
            s.text(f.name(), style, x0, y, Some(cw * 30.0), pal.ink);
            let nw = s.measure(&n, mono);
            s.text(&n, mono, x0 + cw * 36.0 - nw, y, None, pal.ink);
            s.text(&status.0, mono, x0 + cw * 38.0, y, Some(cw * 56.0), status.1);
            let ux = x0 + cw * 96.0;
            if ux < r.right() - cw * 6.0 {
                s.text(&f.url, mono, ux, y, Some(r.right() - ux - cw), pal.faint);
            }
        }
        s.hit(r, Hit::Feed(row));
    }
    s.pop_clip();
}

fn setting_row(m: &Model, s: Setting) -> (&'static str, String) {
    let st = &m.settings;
    match s {
        Setting::ReadingMode => ("Open entries in", format!("{} mode", st.reading_mode.name())),
        Setting::Lines => ("Lines and borders", m.lines.name().to_string()),
        Setting::RefreshMinutes => ("Refresh every", format!("{} minutes", st.refresh_minutes)),
        Setting::MaxEntries => ("Keep at most", format!("{} entries", st.max_entries)),
        Setting::MaxAge => (
            "Delete entries older than",
            st.max_age_days.map(|d| format!("{d} days")).unwrap_or_else(|| "never".into()),
        ),
        Setting::ConfirmOver => ("Ask before opening more than", format!("{} entries", st.confirm_open_over)),
        Setting::MergeDuplicates => (
            "The same link from several feeds",
            if st.merge_duplicates { "shows once".into() } else { "shows every time".into() },
        ),
        Setting::PublicLink => (
            "I recommend, public link",
            m.public_url.clone().unwrap_or_else(|| "not available".into()),
        ),
        Setting::ImportLegacy => ("Import from the old app", "choose a file".into()),
        Setting::Mute => ("Mute a word or phrase", "add".into()),
    }
}

fn rule_text(m: &Model, r: &engine::Rule) -> (String, String) {
    let place = match &r.scope {
        engine::Scope::All => "everywhere".to_string(),
        engine::Scope::Feed(f) => format!("in {}", m.feed_name(f)),
        engine::Scope::Folder(f) => format!("in the folder {}", m.folder(f).map(|x| x.name.as_str()).unwrap_or("?")),
    };
    (format!("\u{201C}{}\u{201D}", r.word), format!("muted {place}"))
}

#[profiling::function]
fn paint_settings(m: &mut Model, s: &mut Scene<Hit>, main: Rect) {
    let mt = s.m;
    let (cw, ch) = (mt.cell_w, mt.cell_h);
    let pal = s.palette;
    let mono = mt.mono();
    s.text("SETTINGS", mono, main.x + cw, main.y, None, pal.ink);
    let area = Rect::new(main.x, main.y + ch, main.w, main.h - ch);
    let rows = settings_rows(m);
    let first_rule = rows.iter().position(|r| matches!(r, Row::Rule(_)));
    let extra = if first_rule.is_some() { 2 } else { 0 };
    m.settings_page.row_h = ch;
    m.settings_page.view_h = area.h - ch * 4.0;
    m.settings_page.clamp(rows.len() + extra);
    s.hit(area, Hit::Area(Scroll::Settings));
    s.push_clip(area);
    let mut y = area.y - m.settings_page.scroll.round();
    for (i, row) in rows.iter().enumerate() {
        if Some(i) == first_rule {
            y += ch;
            s.text("MUTED", mono, main.x + cw, y, None, pal.faint);
            y += ch;
        }
        let r = Rect::new(main.x, y, main.w - cw, ch);
        if i == m.settings_page.cursor {
            s.fill(r, pal.cursor);
        } else {
            s.hover(r);
        }
        let (label, value) = match row {
            Row::Setting(st) => {
                let (l, v) = setting_row(m, *st);
                (l.to_string(), v)
            }
            Row::Rule(k) => rule_text(m, &m.rules[*k]),
        };
        s.text(&label, mt.prop(400.0), main.x + cw, y, Some(cw * 36.0), pal.ink);
        s.text(&value, mono, main.x + cw * 40.0, y, Some(main.w - cw * 42.0), pal.muted);
        s.hit(r, Hit::Setting(i));
        y += ch;
    }
    y += ch;
    s.text(&format!("Data folder   {}", m.data_dir), mono, main.x + cw, y, Some(main.w - cw * 2.0), pal.faint);
    y += ch;
    s.text(
        "Drop an OPML file or the old app's feedreader.sqlite on this window to import it.",
        mt.prop(400.0),
        main.x + cw,
        y,
        Some(main.w - cw * 2.0),
        pal.faint,
    );
    s.pop_clip();
}

#[profiling::function]
fn paint_help(m: &mut Model, reg: &Registry<Cmd, Model>, s: &mut Scene<Hit>, main: Rect) {
    let mt = s.m;
    let (cw, ch) = (mt.cell_w, mt.cell_h);
    let pal = s.palette;
    let mono = mt.mono();
    s.text("HELP \u{00B7} EVERY COMMAND", mono, main.x + cw, main.y, None, pal.ink);
    let area = Rect::new(main.x, main.y + ch, main.w, main.h - ch);
    let mut lines: Vec<(String, String)> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for c in &reg.commands {
        let keys = keys_label(&c.keys);
        let label = (c.label)(m);
        if seen.insert((keys.clone(), format!("{:?}", c.id))) {
            lines.push((if keys.is_empty() { "click".into() } else { keys }, label));
        }
    }
    m.help.row_h = ch;
    m.help.view_h = area.h;
    m.help.clamp(lines.len());
    s.hit(area, Hit::Area(Scroll::Help));
    s.push_clip(area);
    let mut y = area.y - m.help.scroll.round();
    for (keys, label) in lines {
        s.text(&keys, mono, main.x + cw, y, Some(cw * 14.0), pal.ink);
        s.text(&label, mt.prop(400.0), main.x + cw * 16.0, y, Some(main.w - cw * 18.0), pal.muted);
        y += ch;
    }
    s.pop_clip();
}
