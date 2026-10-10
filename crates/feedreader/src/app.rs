use std::path::PathBuf;
use std::sync::Arc;
use std::sync::mpsc::{Receiver, channel};

use engine::{Event, Request};
use graticule::commands::Registry;
use graticule::field::Field;
use graticule::images::Images;
use graticule::shell::{Ctx, Cursor, Effect, FrameStats, Painted, Waker, Web};
use graticule::ui::{LineStyle, Palette, Rect, Scene};

use crate::cmds::{self, Cmd};
use crate::extract;
use crate::model::{self, Focus, Model};
use crate::palette;
use crate::theme;
use crate::view::{self, Hit, Scroll};

#[derive(Debug)]
pub enum Wake {
    Engine,
    ExtractorReady,
    Extracted(String),
    Theme,
}

enum Drag {
    None,
    Paint { anchor: usize, on: bool },
    Track(Rect, Scroll, f32),
    Select,
}

pub struct Feed {
    model: Model,
    engine: engine::Handle,
    emit: Arc<dyn Fn(Event) + Send + Sync>,
    background: bool,
    events: Receiver<Event>,
    waker: Waker<Wake>,
    extractor: extract::Extractor,
    theme: theme::Theme,
    drag: Drag,
    _watcher: Option<notify::RecommendedWatcher>,
}

fn player(src: &str, kind: &str) -> String {
    let tag = if kind == "audio" { "audio" } else { "video" };
    let src = src.replace('&', "&amp;").replace('"', "&quot;").replace('<', "&lt;");
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><style>:root{{color-scheme:light dark}}html,body{{margin:0;height:100%;background:transparent}}body{{display:flex;align-items:center;justify-content:center}}video,audio{{max-width:92%;max-height:92%}}audio{{width:80%}}</style></head><body><{tag} controls autoplay preload=\"metadata\" src=\"{src}\"></{tag}></body></html>"
    )
}

fn watch(dir: &std::path::Path, waker: Waker<Wake>) -> Option<notify::RecommendedWatcher> {
    use notify::Watcher;
    let mut w = notify::recommended_watcher(move |r: notify::Result<notify::Event>| {
        if let Ok(e) = r
            && e.paths.iter().any(|p| p.file_name().is_some_and(|n| n == "theme.toml"))
        {
            waker.wake(Wake::Theme);
        }
    })
    .ok()?;
    w.watch(dir, notify::RecursiveMode::NonRecursive).ok()?;
    Some(w)
}

pub fn send_all(model: &mut Model, engine: &engine::Handle) {
    for r in model.out.drain(..) {
        engine.send(r);
    }
}

impl Feed {
    fn reload_theme(&mut self) {
        match self.theme.reload() {
            Ok(true) => self.model.message = Some("Theme updated.".into()),
            Ok(false) => {}
            Err(e) => self.model.message = Some(format!("{e}. Keeping the last good colors.")),
        }
    }

    fn edit_theme(&mut self) {
        if !self.theme.path.exists() {
            let _ = std::fs::write(&self.theme.path, self.theme.template());
        }
        self.model.effects.push(Effect::Open(self.theme.path.display().to_string()));
        self.model.message = Some(format!("Opened {}; saving it applies the colors.", self.theme.path.display()));
    }

    fn reattach(&mut self) {
        if self.model.quitting {
            return;
        }
        match engine::attach(engine::data_dir(), self.emit.clone(), self.background) {
            Ok(h) => {
                self.engine = h;
                self.engine.send(Request::UseWebExtractor);
                self.model.attached = self.engine.attached();
                self.model.message = Some("Reconnected to the engine.".into());
            }
            Err(e) => self.model.message = Some(format!("The engine stopped and couldn't restart: {e}")),
        }
    }

    fn save_history(&mut self) {
        if !std::mem::take(&mut self.model.history_dirty) {
            return;
        }
        if let Ok(json) = serde_json::to_vec(&self.model.history()) {
            let path = engine::data_dir().join("undo.json");
            let tmp = path.with_extension("json.part");
            if std::fs::write(&tmp, json).is_ok() {
                let _ = std::fs::rename(&tmp, &path);
            }
        }
    }

    fn drain_events(&mut self, cx: &mut Ctx) {
        while let Ok(e) = self.events.try_recv() {
            match e {
                Event::Extract { job, url, html } => {
                    for r in self.extractor.push(cx.window, &self.waker, job, url, html) {
                        self.engine.send(r);
                    }
                }
                Event::Disconnected => self.reattach(),
                e => self.model.event(e),
            }
        }
    }

    fn scroll_of(&mut self, which: Scroll) -> Option<(&mut f32, f32, f32)> {
        let m = &mut self.model;
        match which {
            Scroll::Palette => m.palette.as_mut().map(|p| (&mut p.scroll, p.items.len() as f32 * p.row_h, p.view_h)),
            Scroll::List => Some((&mut m.list.scroll, m.list.visible.len() as f32 * m.list.row_h, m.list.view_h)),
            Scroll::Feeds => Some((&mut m.feeds_page.scroll, m.feeds_order.len() as f32 * m.feeds_page.row_h, m.feeds_page.view_h)),
            Scroll::Help => Some((&mut m.help.scroll, f32::MAX, m.help.view_h)),
            Scroll::Settings => Some((&mut m.settings_page.scroll, f32::MAX, m.settings_page.view_h)),
            Scroll::Reader => m.reader.as_mut().map(|r| (&mut r.scroll, r.content_h, r.view_h)),
            Scroll::Pane => Some((&mut m.pane_scroll, f32::MAX, 0.0)),
        }
    }

    fn thumb(&mut self, t: Rect, which: Scroll, cell_h: f32) -> Option<(f32, f32)> {
        let (scroll, content, view) = self.scroll_of(which)?;
        let scroll = *scroll;
        let h = if content <= view { t.h } else { (view / content * t.h).max(cell_h) };
        let max = (content - view).max(1.0);
        Some((t.y + (scroll / max).clamp(0.0, 1.0) * (t.h - h), h))
    }

    fn track(&mut self, t: Rect, which: Scroll, grab: f32, cx: &Ctx) {
        let Some((_, h)) = self.thumb(t, which, cx.metrics.cell_h) else { return };
        let mouse = cx.mouse.1;
        if let Some((scroll, content, view)) = self.scroll_of(which) {
            let max = (content - view).max(0.0);
            let room = (t.h - h).max(1.0);
            *scroll = (((mouse - grab - t.y) / room) * max).clamp(0.0, max);
        }
    }

    fn text_point(&self, x: f32, y: f32, cx: &mut Ctx) -> Option<model::SelPoint> {
        let r = self.model.reader.as_ref()?;
        if r.geom.is_empty() {
            return None;
        }
        let i = r.geom.iter().position(|g| y < g.y + g.h).unwrap_or(r.geom.len() - 1);
        let g = &r.geom[i];
        let spans = g.borrowed();
        let ly = (y - g.y).clamp(0.0, g.h - 1.0);
        let byte = cx.text.byte_at(&spans, g.size, g.line, g.w, x - g.x, ly);
        Some(model::SelPoint { block: i, byte })
    }

    fn word_at(&self, p: model::SelPoint, cx: &mut Ctx) -> Option<(model::SelPoint, model::SelPoint)> {
        let r = self.model.reader.as_ref()?;
        let g = r.geom.get(p.block)?;
        let spans = g.borrowed();
        let (x, y) = (cx.mouse.0 - g.x, (cx.mouse.1 - g.y).clamp(0.0, g.h - 1.0));
        let w = cx.text.word_at(&spans, g.size, g.line, g.w, x, y);
        Some((model::SelPoint { block: p.block, byte: w.start }, model::SelPoint { block: p.block, byte: w.end }))
    }
}

impl graticule::shell::App for Feed {
    type Model = Model;
    type Command = Cmd;
    type Hit = Hit;
    type Wake = Wake;

    fn new(waker: Waker<Wake>, _: &mut Ctx) -> Result<Self, String> {
        let (tx, rx) = channel();
        let engine_waker = waker.clone();
        let emit: Arc<dyn Fn(Event) + Send + Sync> = Arc::new(move |e| {
            let _ = tx.send(e);
            engine_waker.wake(Wake::Engine);
        });
        let background = !std::env::args().any(|a| a == "--in-process");
        let engine = engine::attach(engine::data_dir(), emit.clone(), background)?;
        let mut feed = Feed {
            model: Model::new(Images::new(waker.images())),
            engine,
            emit,
            background,
            events: rx,
            extractor: extract::Extractor::new(),
            theme: theme::Theme::new(&engine::data_dir()),
            drag: Drag::None,
            _watcher: watch(&engine::data_dir(), waker.clone()),
            waker,
        };
        feed.reload_theme();
        feed.model.message = None;
        if let Ok(bytes) = std::fs::read(engine::data_dir().join("undo.json"))
            && let Ok(h) = serde_json::from_slice(&bytes)
        {
            feed.model.restore_history(h);
        }
        feed.engine.send(Request::UseWebExtractor);
        feed.model.attached = feed.engine.attached();
        Ok(feed)
    }

    fn model(&self) -> &Model {
        &self.model
    }

    fn registry(&self) -> &'static Registry<Cmd, Model> {
        cmds::registry()
    }

    fn exec(&mut self, command: Cmd) {
        cmds::exec(&mut self.model, command);
    }

    fn images(&mut self) -> &mut Images {
        &mut self.model.images
    }

    fn style(&self, system_dark: bool) -> (LineStyle, Palette) {
        let dark = match self.model.settings.appearance {
            engine::Appearance::Dark => true,
            engine::Appearance::Light => false,
            engine::Appearance::System => system_dark,
        };
        (self.model.line_style(), if dark { self.theme.dark } else { self.theme.light })
    }

    fn paint(&mut self, scene: &mut Scene<Hit>, stats: FrameStats) -> Painted {
        let out = view::paint(&mut self.model, cmds::registry(), scene, stats);
        Painted {
            web: out.webview.map(|(r, w)| {
                (
                    r,
                    match w {
                        view::Web::Url(u) => Web::Url(u),
                        view::Web::Player(src, kind) => Web::Html { key: format!("player:{src}"), html: player(&src, &kind) },
                    },
                )
            }),
            ime: out.ime,
        }
    }

    fn painted(&mut self) {
        send_all(&mut self.model, &self.engine);
    }

    fn settle(&mut self) -> Vec<Effect> {
        self.save_history();
        if std::mem::take(&mut self.model.edit_theme) {
            self.edit_theme();
        }
        send_all(&mut self.model, &self.engine);
        std::mem::take(&mut self.model.effects)
    }

    fn wake(&mut self, wake: Wake, cx: &mut Ctx) -> bool {
        match wake {
            Wake::Engine => self.drain_events(cx),
            Wake::ExtractorReady => {
                for r in self.extractor.ready() {
                    self.engine.send(r);
                }
                return false;
            }
            Wake::Extracted(body) => {
                if let Some(r) = extract::result(&body) {
                    self.engine.send(r);
                }
                return false;
            }
            Wake::Theme => self.reload_theme(),
        }
        true
    }

    fn field(&mut self) -> Option<&mut Field> {
        match self.model.focus {
            Focus::Filter => Some(&mut self.model.filter),
            Focus::Prompt => self.model.prompt.as_mut().map(|p| &mut p.field),
            Focus::Palette => self.model.palette.as_mut().map(|p| &mut p.field),
            Focus::Main => None,
        }
    }

    fn field_changed(&mut self) {
        if self.model.focus == Focus::Palette {
            if let Some(p) = self.model.palette.as_mut() {
                p.cursor = 0;
                p.scroll = 0.0;
            }
            palette::refresh(&mut self.model);
        } else if self.model.focus == Focus::Filter {
            self.model.reset_list();
        } else if let Some(p) = &mut self.model.prompt {
            p.error = None;
        }
    }

    fn hoverable(hit: &Hit) -> bool {
        !matches!(hit, Hit::Area(_))
    }

    fn cursor(&mut self, hit: Option<&Hit>, cx: &mut Ctx) -> Cursor {
        match hit {
            Some(Hit::Filter | Hit::Prompt) => Cursor::Text,
            Some(Hit::Area(Scroll::Reader)) if self.text_point(cx.mouse.0, cx.mouse.1, cx).is_some() => Cursor::Text,
            Some(Hit::Area(_)) | None => Cursor::Default,
            Some(_) => Cursor::Pointer,
        }
    }

    #[profiling::function]
    fn press(&mut self, hit: Option<Hit>, cx: &mut Ctx) {
        let (x, y) = cx.mouse;
        let shift = cx.mods.shift;
        let primary = cx.mods.primary;
        if matches!(hit, Some(Hit::Area(Scroll::Reader))) {
            if let Some(point) = self.text_point(x, y, cx) {
                let word = if cx.clicks > 1 { self.word_at(point, cx) } else { None };
                if let Some(r) = self.model.reader.as_mut() {
                    r.sel = Some(word.unwrap_or((point, point)));
                }
                self.drag = Drag::Select;
            }
            return;
        }
        if let Some(r) = self.model.reader.as_mut() {
            r.sel = None;
        }
        if !matches!(hit, Some(Hit::Filter) | Some(Hit::Prompt) | Some(Hit::Cmd(_))) && self.model.focus == Focus::Filter {
            self.model.focus = Focus::Main;
        }
        if let Some(Hit::Track(t, which)) = hit {
            let grab = self
                .thumb(t, which, cx.metrics.cell_h)
                .map(|(top, h)| {
                    let into = y - top;
                    if (0.0..=h).contains(&into) { into } else { h / 2.0 }
                })
                .unwrap_or(0.0);
            self.drag = Drag::Track(t, which, grab);
            self.track(t, which, grab, cx);
            return;
        }
        let m = &mut self.model;
        match hit {
            Some(Hit::Cmd(c)) => cmds::exec(m, c),
            Some(Hit::View(v)) => m.show(v),
            Some(Hit::Page(p)) => m.go(p),
            Some(Hit::Row(row) | Hit::Check(row)) if shift => {
                let anchor = m.list.anchor.unwrap_or(m.list.cursor);
                m.select_rows(anchor, row, true);
                m.list.cursor = row;
            }
            Some(Hit::ReadToggle(row)) => {
                let e = &m.entries[m.list.visible[row]];
                let (id, to) = (e.id.clone(), !e.read);
                let label = format!("Marked \u{201C}{}\u{201D} {}", e.title, if to { "read" } else { "unread" });
                m.act(label, model::Op::Read(vec![(id, to)]));
            }
            Some(Hit::BookmarkToggle(row)) => {
                let e = &m.entries[m.list.visible[row]];
                let (id, to) = (e.id.clone(), !e.bookmarked);
                let label = format!("{} \u{201C}{}\u{201D}", if to { "Bookmarked" } else { "Removed the bookmark from" }, e.title);
                m.act(label, model::Op::Bookmark(vec![(id, to)]));
            }
            Some(Hit::Row(row)) => {
                m.list.cursor = row;
                let id = m.entries[m.list.visible[row]].id.clone();
                if primary {
                    let url = m.entries[m.list.visible[row]].url.clone();
                    m.effects.push(Effect::Open(url));
                    m.act("Opened in the browser and marked read".into(), model::Op::Read(vec![(id, true)]));
                } else {
                    m.open_entry(id, None);
                }
            }
            Some(Hit::Check(row)) => {
                let id = m.entries[m.list.visible[row]].id.clone();
                let on = !m.list.selected.contains(&id);
                m.list.anchor = Some(row);
                m.select_rows(row, row, on);
                self.drag = Drag::Paint { anchor: row, on };
            }
            Some(Hit::Filter) => {
                m.focus = Focus::Filter;
                m.filter.end();
            }
            Some(Hit::Prompt) => m.focus = Focus::Prompt,
            Some(Hit::Feed(row)) => {
                if m.feeds_page.cursor == row {
                    cmds::exec(m, Cmd::Open);
                } else {
                    m.feeds_page.cursor = row;
                    m.armed = None;
                }
            }
            Some(Hit::Setting(i)) => {
                if m.settings_page.cursor == i {
                    cmds::exec(m, Cmd::Edit);
                } else {
                    m.settings_page.cursor = i;
                }
            }
            Some(Hit::Candidate(i)) => {
                if let Some(model::Discovery::Found(_, _, cur)) = &mut m.discovery {
                    if *cur == i {
                        cmds::exec(m, Cmd::Pick);
                    } else {
                        *cur = i;
                    }
                }
            }
            Some(Hit::Tab(n)) => m.activate(n),
            Some(Hit::CloseTab(n)) => {
                if let Some(id) = m.tab(n).map(|r| r.id) {
                    let title = m.tab_title(n);
                    m.act(format!("Closed \u{201C}{title}\u{201D}"), model::Op::CloseTab(id));
                }
            }
            Some(Hit::Palette(i)) => {
                if i != usize::MAX {
                    palette::activate(m, i);
                }
            }
            Some(Hit::Play(src, kind)) => {
                if primary {
                    m.effects.push(Effect::Open(src));
                } else {
                    m.open_target(model::Target::Play(src, kind));
                }
            }
            Some(Hit::Link(url)) | Some(Hit::Media(url)) => {
                if primary {
                    m.effects.push(Effect::Open(url));
                } else {
                    m.open_page(url);
                }
            }
            Some(Hit::Track(..)) | Some(Hit::Area(_)) | None => {}
        }
    }

    fn middle(&mut self, hit: Option<Hit>, _: &mut Ctx) {
        let m = &mut self.model;
        match hit {
            Some(Hit::Row(row) | Hit::Check(row)) => {
                if let Some(&i) = m.list.visible.get(row) {
                    let id = m.entries[i].id.clone();
                    m.open_background(vec![id]);
                }
            }
            Some(Hit::Tab(n) | Hit::CloseTab(n)) if n > 0 => {
                if let Some(id) = m.tab(n).map(|r| r.id) {
                    let title = m.tab_title(n);
                    m.act(format!("Closed \u{201C}{title}\u{201D}"), model::Op::CloseTab(id));
                }
            }
            _ => {}
        }
    }

    fn drag(&mut self, hit: Option<Hit>, cx: &mut Ctx) -> Option<bool> {
        match self.drag {
            Drag::None => None,
            Drag::Paint { anchor, on } => match hit {
                Some(Hit::Row(row) | Hit::Check(row)) => {
                    self.model.select_rows(anchor, row, on);
                    Some(true)
                }
                _ => Some(false),
            },
            Drag::Track(t, which, grab) => {
                self.track(t, which, grab, cx);
                Some(true)
            }
            Drag::Select => {
                if let Some(point) = self.text_point(cx.mouse.0, cx.mouse.1, cx)
                    && let Some(r) = self.model.reader.as_mut()
                    && let Some((a, _)) = r.sel
                {
                    r.sel = Some((a, point));
                    return Some(true);
                }
                Some(false)
            }
        }
    }

    fn release(&mut self) {
        self.drag = Drag::None;
    }

    #[profiling::function]
    fn wheel(&mut self, under: &[&Hit], dx: f32, dy: f32, cx: &mut Ctx) -> bool {
        let area = under.iter().find_map(|h| match h {
            Hit::Area(a) | Hit::Track(_, a) => Some(*a),
            _ => None,
        });
        let Some(area) = area else { return false };
        let horizontal = area == Scroll::Pane && cx.metrics.cols() < 100;
        let delta = if horizontal { if dx != 0.0 { dx } else { dy } } else { dy };
        let Some((scroll, content, view)) = self.scroll_of(area) else { return false };
        let before = *scroll;
        *scroll -= delta;
        if content != f32::MAX {
            *scroll = scroll.clamp(0.0, (content - view).max(0.0));
        } else {
            *scroll = scroll.max(0.0);
        }
        *scroll != before
    }

    fn dropped(&mut self, path: PathBuf) {
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
        if ext == "sqlite" || ext == "db" {
            self.model.out.push(Request::ImportLegacy(path));
        } else {
            self.model.out.push(Request::ImportOpml(path));
        }
        self.model.message = Some("Importing\u{2026}".into());
    }

    fn web_closed(&mut self) {
        self.model.back();
    }

    fn exiting(mut self) {
        self.save_history();
        send_all(&mut self.model, &self.engine);
        self.engine.close();
    }
}
