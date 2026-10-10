mod article;
mod cmds;
mod extract;
mod model;
mod palette;
mod tabs;
mod service;
mod theme;
mod view;

use std::sync::Arc;
use std::sync::mpsc::{Receiver, channel};
use std::time::{Duration, Instant};

use engine::{Event, Request};
use toolkit::commands::{Chord, Key, Registry};
use toolkit::gpu::Gpu;
use toolkit::text::{Face, Text, TextStyle};
use toolkit::ui::{DARK, LIGHT, Metrics, Palette, Rect, Scene};
use winit::application::ApplicationHandler;
use winit::dpi::{LogicalSize, PhysicalPosition, PhysicalSize};
use winit::event::{ElementState, Ime, MouseButton, MouseScrollDelta, WindowEvent};
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop, EventLoopProxy};
use winit::keyboard::{Key as WKey, ModifiersState, NamedKey};
use winit::window::{CursorIcon, Window, WindowId};

use cmds::Cmd;
use model::{Focus, Model};
use view::{FrameStats, Hit, Scroll, Web};

const BASE_SIZE: f32 = 13.0;

#[cfg(feature = "profile")]
#[global_allocator]
static ALLOC: tracy_client::ProfiledAllocator<std::alloc::System> = tracy_client::ProfiledAllocator::new(std::alloc::System, 0);

#[derive(Debug)]
enum Wake {
    Engine,
    WebClose,
    ExtractorReady,
    Extracted(String),
    Images,
    Theme,
}

enum Drag {
    None,
    Paint { anchor: usize, on: bool },
    Track(Rect, Scroll, f32),
    Select,
}

struct State {
    window: Arc<Window>,
    gpu: Gpu,
    text: Text,
    model: Model,
    registry: Registry<Cmd, Model>,
    engine: engine::Handle,
    emit: Arc<dyn Fn(Event) + Send + Sync>,
    background: bool,
    events: Receiver<Event>,
    proxy: EventLoopProxy<Wake>,
    hits: Vec<(Rect, Hit)>,
    webview: Option<wry::WebView>,
    web_url: Option<String>,
    web_visible: bool,
    metrics: Metrics,
    mouse: (f32, f32),
    pointer_inside: bool,
    hover: Option<Rect>,
    modifiers: ModifiersState,
    drag: Drag,
    last_click: Option<(Instant, f32, f32)>,
    frames: Vec<[f32; 3]>,
    ime_on: bool,
    clipboard: Option<arboard::Clipboard>,
    extractor: extract::Extractor,
    theme: theme::Theme,
    system_dark: bool,
    _watcher: Option<notify::RecommendedWatcher>,
}

struct App {
    state: Option<State>,
    proxy: EventLoopProxy<Wake>,
}

fn metrics(text: &mut Text, scale: f32, size: PhysicalSize<u32>) -> Metrics {
    let font = BASE_SIZE * scale;
    let cell_h = (font * 1.6).round();
    let probe = TextStyle {
        face: Face::Mono,
        size: font,
        weight: 400.0,
    };
    let cell_w = text.measure("0000000000", probe, cell_h) / 10.0;
    Metrics {
        scale,
        size: font,
        cell_w,
        cell_h,
        width: size.width as f32,
        height: size.height as f32,
    }
}

fn player(src: &str, kind: &str) -> String {
    let tag = if kind == "audio" { "audio" } else { "video" };
    let src = src.replace('&', "&amp;").replace('"', "&quot;").replace('<', "&lt;");
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><style>:root{{color-scheme:light dark}}html,body{{margin:0;height:100%;background:transparent}}body{{display:flex;align-items:center;justify-content:center}}video,audio{{max-width:92%;max-height:92%}}audio{{width:80%}}</style></head><body><{tag} controls autoplay preload=\"metadata\" src=\"{src}\"></{tag}></body></html>"
    )
}

pub fn host_name() -> String {
    std::process::Command::new("scutil")
        .args(["--get", "ComputerName"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .or_else(|| std::process::Command::new("hostname").output().ok())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "this device".into())
}

fn qr_text(text: &str) -> String {
    let Ok(code) = qrcode::QrCode::new(text.as_bytes()) else { return String::new() };
    let n = code.width();
    let colors = code.to_colors();
    let dark = |x: isize, y: isize| x >= 0 && y >= 0 && (x as usize) < n && (y as usize) < n && colors[y as usize * n + x as usize] == qrcode::Color::Dark;
    let mut out = String::new();
    let mut y = -2isize;
    while y < n as isize + 2 {
        for x in -2..n as isize + 2 {
            out.push(match (dark(x, y), dark(x, y + 1)) {
                (true, true) => ' ',
                (true, false) => '\u{2584}',
                (false, true) => '\u{2580}',
                (false, false) => '\u{2588}',
            });
        }
        out.push('\n');
        y += 2;
    }
    out
}

fn open_external(url: &str) {
    #[cfg(target_os = "macos")]
    let opener = "open";
    #[cfg(not(target_os = "macos"))]
    let opener = "xdg-open";
    let _ = std::process::Command::new(opener).arg(url).spawn();
}

fn flush(model: &mut Model, engine: &engine::Handle, clipboard: &mut Option<arboard::Clipboard>) {
    for r in model.out.drain(..) {
        engine.send(r);
    }
    for url in model.open.drain(..) {
        open_external(&url);
    }
    if let Some(text) = model.copy.take()
        && let Some(c) = clipboard
    {
        let _ = c.set_text(text);
    }
}

fn watch(dir: &std::path::Path, proxy: EventLoopProxy<Wake>) -> Option<notify::RecommendedWatcher> {
    use notify::Watcher;
    let mut w = notify::recommended_watcher(move |r: notify::Result<notify::Event>| {
        if let Ok(e) = r
            && e.paths.iter().any(|p| p.file_name().is_some_and(|n| n == "theme.toml"))
        {
            let _ = proxy.send_event(Wake::Theme);
        }
    })
    .ok()?;
    w.watch(dir, notify::RecursiveMode::NonRecursive).ok()?;
    Some(w)
}

impl State {
    fn palette(&self) -> Palette {
        let dark = match self.model.settings.appearance.as_str() {
            "dark" => true,
            "light" => false,
            _ => self.system_dark,
        };
        if dark { self.theme.dark } else { self.theme.light }
    }

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
        open_external(&self.theme.path.display().to_string());
        self.model.message = Some(format!("Opened {}; saving it applies the colors.", self.theme.path.display()));
    }

    #[profiling::function]
    fn render(&mut self) {
        let started = Instant::now();
        self.text.begin_frame();
        self.model.images.begin_frame();
        let stats = FrameStats::from(&self.frames);
        let palette = self.palette();
        let mut scene = Scene::new(&mut self.text, self.metrics, self.model.lines, palette);
        scene.pointer = self.pointer_inside.then_some(self.mouse);
        let out = view::paint(&mut self.model, &self.registry, &mut scene, stats);
        let quads = std::mem::take(&mut scene.quads);
        self.hits = std::mem::take(&mut scene.hits);
        drop(scene);
        for u in self.text.uploads.drain(..) {
            self.gpu.upload(u.x, u.y, u.w, u.h, &u.data);
        }
        for (id, d) in self.model.images.take_uploads() {
            self.gpu.add_image(id, d.width, d.height, &d.rgba);
        }
        for id in self.model.images.take_evicted() {
            self.gpu.remove_image(id);
        }
        for r in self.model.out.drain(..) {
            self.engine.send(r);
        }
        let painted = Instant::now();
        self.gpu.render(&quads, palette.bg);
        let presented = Instant::now();
        self.sync_webview(out.webview);
        self.sync_ime(out.ime);
        let ms = |a: Instant, b: Instant| (b - a).as_secs_f32() * 1000.0;
        self.frames.push([ms(started, painted), ms(painted, presented), ms(presented, Instant::now())]);
        profiling::finish_frame!();
        if self.frames.len() > 240 {
            self.frames.remove(0);
        }
    }

    fn sync_webview(&mut self, web: Option<(Rect, Web)>) {
        let Some((r, content)) = web else {
            if let Some(w) = &self.webview
                && self.web_visible
            {
                let _ = w.set_visible(false);
                let _ = w.focus_parent();
                self.web_visible = false;
            }
            return;
        };
        self.web_visible = true;
        let s = self.metrics.scale as f64;
        let bounds = wry::Rect {
            position: wry::dpi::LogicalPosition::new(r.x as f64 / s, r.y as f64 / s).into(),
            size: wry::dpi::LogicalSize::new(r.w as f64 / s, r.h as f64 / s).into(),
        };
        let key = content.key();
        match &self.webview {
            Some(w) => {
                let _ = w.set_bounds(bounds);
                let _ = w.set_visible(true);
                if self.web_url.as_deref() != Some(key.as_str()) {
                    let _ = match &content {
                        Web::Url(u) => w.load_url(u),
                        Web::Player(src, kind) => w.load_html(&player(src, kind)),
                    };
                }
            }
            None => {
                let proxy = self.proxy.clone();
                let builder = match &content {
                    Web::Url(u) => wry::WebViewBuilder::new().with_url(u.clone()),
                    Web::Player(src, kind) => wry::WebViewBuilder::new().with_html(player(src, kind)),
                };
                self.webview = builder
                    .with_bounds(bounds)
                    .with_background_color({
                        let bg = self.palette().bg;
                        ((bg[0] * 255.0) as u8, (bg[1] * 255.0) as u8, (bg[2] * 255.0) as u8, 255)
                    })
                    .with_initialization_script(
                        "document.addEventListener('keydown', e => { if (e.key === 'Escape' || (e.metaKey && e.key === 'w')) { e.preventDefault(); window.ipc.postMessage('close'); } }, true);",
                    )
                    .with_ipc_handler(move |_| {
                        let _ = proxy.send_event(Wake::WebClose);
                    })
                    .build_as_child(&*self.window)
                    .ok();
            }
        }
        self.web_url = Some(key);
    }

    fn sync_ime(&mut self, caret: Option<Rect>) {
        let want = caret.is_some();
        if want != self.ime_on {
            self.window.set_ime_allowed(want);
            self.ime_on = want;
        }
        if let Some(c) = caret {
            self.window.set_ime_cursor_area(
                PhysicalPosition::new(c.x as f64, c.y as f64),
                PhysicalSize::new(c.w as f64, c.h as f64),
            );
        }
    }

    fn hit_at(&self, x: f32, y: f32) -> Option<Hit> {
        self.hits.iter().rev().find(|(r, _)| r.contains(x, y)).map(|(_, h)| h.clone())
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

    fn after(&mut self) {
        self.save_history();
        if std::mem::take(&mut self.model.restart_engine) {
            self.engine.send(Request::Shutdown);
        }
        if std::mem::take(&mut self.model.edit_theme) {
            self.edit_theme();
        }
        flush(&mut self.model, &self.engine, &mut self.clipboard);
        if self.model.quitting {
            std::thread::sleep(Duration::from_millis(150));
            std::process::exit(0);
        }
        self.window.request_redraw();
    }

    fn field(&mut self) -> Option<&mut toolkit::field::Field> {
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

    #[profiling::function]
    fn key(&mut self, event: &winit::event::KeyEvent) -> bool {
        let cmd = self.modifiers.super_key();
        let shift = self.modifiers.shift_key();
        let alt = self.modifiers.alt_key();
        let key = match &event.logical_key {
            WKey::Named(NamedKey::ArrowDown) => Some(Key::Down),
            WKey::Named(NamedKey::ArrowUp) => Some(Key::Up),
            WKey::Named(NamedKey::ArrowLeft) => Some(Key::Left),
            WKey::Named(NamedKey::ArrowRight) => Some(Key::Right),
            WKey::Named(NamedKey::Enter) => Some(Key::Enter),
            WKey::Named(NamedKey::Escape) => Some(Key::Escape),
            WKey::Named(NamedKey::Backspace) => Some(Key::Backspace),
            WKey::Named(NamedKey::Delete) => Some(Key::Delete),
            WKey::Named(NamedKey::PageDown) => Some(Key::PageDown),
            WKey::Named(NamedKey::PageUp) => Some(Key::PageUp),
            WKey::Named(NamedKey::Home) => Some(Key::Home),
            WKey::Named(NamedKey::End) => Some(Key::End),
            WKey::Named(NamedKey::Space) => Some(Key::Char(' ')),
            WKey::Character(s) => s.chars().next().map(|c| match c {
                '{' => '[',
                '}' => ']',
                c => c,
            }).map(Key::Char),
            _ => None,
        };
        let Some(key) = key else { return false };
        let shift_matters = cmd || !matches!(key, Key::Char(c) if !c.is_ascii_alphabetic());
        let chord = Chord {
            key: match key {
                Key::Char(c) => Key::Char(c.to_ascii_lowercase()),
                k => k,
            },
            cmd,
            shift: shift && shift_matters,
        };
        if self.model.focus != Focus::Main && !cmd && matches!(key, Key::Char(_)) && !self.model.confirm.is_some() {
            if let Some(t) = event.text.as_ref().map(|t| t.to_string())
                && self.field().is_some_and(|f| f.preedit.is_empty())
                && !t.chars().any(char::is_control)
            {
                if let Some(f) = self.field() {
                    f.insert(&t);
                }
                self.field_changed();
                return true;
            }
        }
        if let Some(c) = self.registry.lookup(&self.model, &chord) {
            cmds::exec(&mut self.model, c);
            return true;
        }
        if self.model.focus != Focus::Main {
            let changed = {
                let Some(f) = self.field() else { return false };
                match key {
                    Key::Backspace if cmd => f.delete_to_start(),
                    Key::Backspace if alt => f.delete_word(),
                    Key::Backspace => f.backspace(),
                    Key::Delete => f.delete(),
                    Key::Left if cmd => {
                        f.home();
                        false
                    }
                    Key::Right if cmd => {
                        f.end();
                        false
                    }
                    Key::Left => {
                        f.left();
                        false
                    }
                    Key::Right => {
                        f.right();
                        false
                    }
                    Key::Home => {
                        f.home();
                        false
                    }
                    Key::End => {
                        f.end();
                        false
                    }
                    Key::Char('v') if cmd => {
                        let pasted = self
                            .clipboard
                            .as_mut()
                            .and_then(|c| c.get_text().ok())
                            .map(|t| t.replace(['\n', '\r'], " "));
                        let Some(t) = pasted else { return false };
                        let Some(f) = self.field() else { return false };
                        f.insert(&t);
                        true
                    }
                    _ => return false,
                }
            };
            if changed {
                self.field_changed();
            }
            return true;
        }
        false
    }

    #[profiling::function]
    fn press(&mut self) {
        if let Some(w) = &self.webview
            && self.web_visible
        {
            let _ = w.focus_parent();
        }
        let (x, y) = self.mouse;
        let hit = self.hit_at(x, y);
        let shift = self.modifiers.shift_key();
        let now = Instant::now();
        let double = self.last_click.is_some_and(|(t, px, py)| {
            now - t < Duration::from_millis(400) && (px - x).abs() < 6.0 && (py - y).abs() < 6.0
        });
        self.last_click = Some((now, x, y));
        if matches!(hit, Some(Hit::Area(Scroll::Reader))) {
            if let Some(point) = self.text_point(x, y) {
                let word = if double { self.word_at(point) } else { None };
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
        let m = &mut self.model;
        if !matches!(hit, Some(Hit::Filter) | Some(Hit::Prompt) | Some(Hit::Cmd(_))) && m.focus == Focus::Filter {
            m.focus = Focus::Main;
        }
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
                if self.modifiers.super_key() {
                    let url = m.entries[m.list.visible[row]].url.clone();
                    m.open.push(url);
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
            Some(Hit::Track(t, which)) => {
                let grab = self.thumb(t, which).map(|(top, h)| {
                    let into = self.mouse.1 - top;
                    if (0.0..=h).contains(&into) { into } else { h / 2.0 }
                });
                let grab = grab.unwrap_or(0.0);
                self.drag = Drag::Track(t, which, grab);
                self.track(t, which, grab);
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
                if self.modifiers.super_key() {
                    m.open.push(src);
                } else {
                    m.open_target(model::Target::Play(src, kind));
                }
            }
            Some(Hit::Link(url)) | Some(Hit::Media(url)) => {
                if self.modifiers.super_key() {
                    m.open.push(url);
                } else {
                    m.open_page(url);
                }
            }
            Some(Hit::Area(_)) | None => {}
        }
    }

    fn middle(&mut self) {
        let (x, y) = self.mouse;
        let m = &mut self.model;
        match self.hits.iter().rev().find(|(r, _)| r.contains(x, y)).map(|(_, h)| h.clone()) {
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

    fn thumb(&mut self, t: Rect, which: Scroll) -> Option<(f32, f32)> {
        let ch = self.metrics.cell_h;
        let (scroll, content, view) = self.scroll_of(which)?;
        let scroll = *scroll;
        let h = if content <= view { t.h } else { (view / content * t.h).max(ch) };
        let max = (content - view).max(1.0);
        Some((t.y + (scroll / max).clamp(0.0, 1.0) * (t.h - h), h))
    }

    fn track(&mut self, t: Rect, which: Scroll, grab: f32) {
        let Some((_, h)) = self.thumb(t, which) else { return };
        let mouse = self.mouse.1;
        if let Some((scroll, content, view)) = self.scroll_of(which) {
            let max = (content - view).max(0.0);
            let room = (t.h - h).max(1.0);
            *scroll = (((mouse - grab - t.y) / room) * max).clamp(0.0, max);
        }
    }

    #[profiling::function]
    fn wheel(&mut self, dx: f32, dy: f32) -> bool {
        let area = self.hits.iter().rev().find_map(|(r, h)| match h {
            Hit::Area(a) | Hit::Track(_, a) if r.contains(self.mouse.0, self.mouse.1) => Some(*a),
            _ => None,
        });
        let Some(area) = area else { return false };
        let horizontal = area == Scroll::Pane && self.metrics.cols() < 100;
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

    fn moved(&mut self) -> bool {
        match self.drag {
            Drag::Paint { anchor, on } => {
                if let Some(Hit::Row(row) | Hit::Check(row)) = self.hit_at(self.mouse.0, self.mouse.1) {
                    self.model.select_rows(anchor, row, on);
                    return true;
                }
                false
            }
            Drag::Track(t, which, grab) => {
                self.track(t, which, grab);
                true
            }
            Drag::Select => {
                if let Some(point) = self.text_point(self.mouse.0, self.mouse.1)
                    && let Some(r) = self.model.reader.as_mut()
                    && let Some((a, _)) = r.sel
                {
                    r.sel = Some((a, point));
                    return true;
                }
                false
            }
            Drag::None => {
                let hover = self
                    .hits
                    .iter()
                    .rev()
                    .find(|(r, h)| r.contains(self.mouse.0, self.mouse.1) && !matches!(h, Hit::Area(_)))
                    .map(|(r, _)| *r);
                let changed = hover != self.hover;
                self.hover = hover;
                let icon = match self.hit_at(self.mouse.0, self.mouse.1) {
                    Some(Hit::Filter | Hit::Prompt) => CursorIcon::Text,
                    Some(Hit::Area(Scroll::Reader)) if self.text_point(self.mouse.0, self.mouse.1).is_some() => CursorIcon::Text,
                    Some(Hit::Area(_)) | None => CursorIcon::Default,
                    Some(_) => CursorIcon::Pointer,
                };
                self.window.set_cursor(icon);
                changed
            }
        }
    }

    fn text_point(&mut self, x: f32, y: f32) -> Option<model::SelPoint> {
        let r = self.model.reader.as_ref()?;
        if r.geom.is_empty() {
            return None;
        }
        let i = r
            .geom
            .iter()
            .position(|g| y < g.y + g.h)
            .unwrap_or(r.geom.len() - 1);
        let g = &r.geom[i];
        let spans = g.borrowed();
        let ly = (y - g.y).clamp(0.0, g.h - 1.0);
        let byte = self.text.byte_at(&spans, g.size, g.line, g.w, x - g.x, ly);
        Some(model::SelPoint { block: i, byte })
    }

    fn word_at(&mut self, p: model::SelPoint) -> Option<(model::SelPoint, model::SelPoint)> {
        let r = self.model.reader.as_ref()?;
        let g = r.geom.get(p.block)?;
        let spans = g.borrowed();
        let (x, y) = (self.mouse.0 - g.x, (self.mouse.1 - g.y).clamp(0.0, g.h - 1.0));
        let w = self.text.word_at(&spans, g.size, g.line, g.w, x, y);
        Some((model::SelPoint { block: p.block, byte: w.start }, model::SelPoint { block: p.block, byte: w.end }))
    }

    fn drain_events(&mut self) {
        while let Ok(e) = self.events.try_recv() {
            match e {
                Event::Extract { job, url, html } => {
                    for r in self.extractor.push(&self.window, &self.proxy, job, url, html) {
                        self.engine.send(r);
                    }
                }
                Event::Disconnected => self.reattach(),
                e => self.model.event(e),
            }
        }
    }
}

impl ApplicationHandler<Wake> for App {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.state.is_some() {
            return;
        }
        let window = Arc::new(
            event_loop
                .create_window(
                    Window::default_attributes()
                        .with_title("Feedreader")
                        .with_inner_size(LogicalSize::new(1180.0, 760.0))
                        .with_min_inner_size(LogicalSize::new(380.0, 300.0)),
                )
                .expect("window"),
        );
        let size = window.inner_size();
        let gpu = Gpu::new(Some(window.clone()), (size.width, size.height));
        let mut text = Text::new();
        let metrics = metrics(&mut text, window.scale_factor() as f32, size);
        let (tx, rx) = channel();
        let proxy = self.proxy.clone();
        let emit: Arc<dyn Fn(Event) + Send + Sync> = Arc::new(move |e| {
            let _ = tx.send(e);
            let _ = proxy.send_event(Wake::Engine);
        });
        let background = !std::env::args().any(|a| a == "--in-process");
        let engine = match engine::attach(engine::data_dir(), emit.clone(), background) {
            Ok(h) => h,
            Err(e) => {
                eprintln!("{e}");
                event_loop.exit();
                return;
            }
        };
        let mut state = State {
            window,
            gpu,
            text,
            model: Model::new(toolkit::images::Images::new({
                let proxy = self.proxy.clone();
                move || {
                    let _ = proxy.send_event(Wake::Images);
                }
            })),
            registry: cmds::registry(),
            engine,
            emit,
            background,
            events: rx,
            proxy: self.proxy.clone(),
            hits: Vec::new(),
            webview: None,
            web_url: None,
            web_visible: false,
            metrics,
            mouse: (0.0, 0.0),
            pointer_inside: false,
            hover: None,
            modifiers: ModifiersState::empty(),
            drag: Drag::None,
            last_click: None,
            frames: Vec::new(),
            ime_on: false,
            clipboard: arboard::Clipboard::new().ok(),
            extractor: extract::Extractor::new(),
            theme: theme::Theme::new(&engine::data_dir()),
            system_dark: false,
            _watcher: watch(&engine::data_dir(), self.proxy.clone()),
        };
        state.system_dark = state.window.theme() == Some(winit::window::Theme::Dark);
        state.reload_theme();
        state.model.message = None;
        if let Ok(bytes) = std::fs::read(engine::data_dir().join("undo.json"))
            && let Ok(h) = serde_json::from_slice(&bytes)
        {
            state.model.restore_history(h);
        }
        state.engine.send(Request::UseWebExtractor);
        state.model.attached = state.engine.attached();
        state.render();
        self.state = Some(state);
    }

    fn user_event(&mut self, _: &ActiveEventLoop, wake: Wake) {
        let Some(s) = self.state.as_mut() else { return };
        match wake {
            Wake::Engine => s.drain_events(),
            Wake::WebClose => {
                s.model.back();
                s.window.focus_window();
            }
            Wake::ExtractorReady => {
                for r in s.extractor.ready() {
                    s.engine.send(r);
                }
                return;
            }
            Wake::Extracted(body) => {
                if let Some(r) = extract::result(&body) {
                    s.engine.send(r);
                }
                return;
            }
            Wake::Images => {}
            Wake::Theme => s.reload_theme(),
        }
        s.after();
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, _: WindowId, event: WindowEvent) {
        let Some(s) = self.state.as_mut() else { return };
        let redraw = match event {
            WindowEvent::CloseRequested => {
                event_loop.exit();
                false
            }
            WindowEvent::Resized(size) => {
                s.pointer_inside = false;
                s.hover = None;
                s.gpu.resize(size.width, size.height);
                s.metrics = metrics(&mut s.text, s.metrics.scale, size);
                s.render();
                false
            }
            WindowEvent::ScaleFactorChanged { scale_factor, .. } => {
                s.text.clear();
                s.metrics = metrics(&mut s.text, scale_factor as f32, s.window.inner_size());
                true
            }
            WindowEvent::RedrawRequested => {
                s.render();
                false
            }
            WindowEvent::ModifiersChanged(m) => {
                s.modifiers = m.state();
                false
            }
            WindowEvent::KeyboardInput { event, .. } if event.state == ElementState::Pressed => s.key(&event),
            WindowEvent::Ime(ime) => match ime {
                Ime::Preedit(text, _) => {
                    if let Some(f) = s.field() {
                        f.preedit = text;
                    }
                    true
                }
                Ime::Commit(text) => {
                    if let Some(f) = s.field() {
                        f.preedit.clear();
                        f.insert(&text);
                    }
                    s.field_changed();
                    true
                }
                _ => false,
            },
            WindowEvent::DroppedFile(path) => {
                let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
                if ext == "sqlite" || ext == "db" {
                    s.model.out.push(Request::ImportLegacy(path));
                } else {
                    s.model.out.push(Request::ImportOpml(path));
                }
                s.model.message = Some("Importing\u{2026}".into());
                true
            }
            WindowEvent::CursorMoved { position, .. } => {
                s.mouse = (position.x as f32, position.y as f32);
                s.pointer_inside = true;
                s.moved()
            }
            WindowEvent::CursorLeft { .. } => {
                s.pointer_inside = false;
                s.hover = None;
                true
            }
            WindowEvent::Occluded(false) => true,
            WindowEvent::ThemeChanged(t) => {
                s.system_dark = t == winit::window::Theme::Dark;
                true
            }
            WindowEvent::MouseInput {
                state: ElementState::Pressed,
                button: MouseButton::Left,
                ..
            } => {
                s.press();
                true
            }
            WindowEvent::MouseInput {
                state: ElementState::Pressed,
                button: MouseButton::Middle,
                ..
            } => {
                s.middle();
                true
            }
            WindowEvent::MouseInput {
                state: ElementState::Released,
                button: MouseButton::Left,
                ..
            } => {
                s.drag = Drag::None;
                false
            }
            WindowEvent::MouseWheel { delta, .. } => {
                let (dx, dy) = match delta {
                    MouseScrollDelta::LineDelta(x, y) => (x * s.metrics.cell_w * 3.0, y * s.metrics.cell_h * 3.0),
                    MouseScrollDelta::PixelDelta(p) => (p.x as f32, p.y as f32),
                };
                s.wheel(dx, dy)
            }
            _ => false,
        };
        if redraw {
            s.after();
        }
    }
}

fn wait_for(rx: &Receiver<Event>, model: &mut Model, timeout: Duration, done: impl Fn(&Model, &Event) -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(left) {
            Ok(e) => {
                let stop = done(model, &e);
                model.event(e);
                if stop {
                    return true;
                }
            }
            Err(_) => return false,
        }
    }
}

fn headless() -> (engine::Handle, Receiver<Event>, Model) {
    let (tx, rx) = channel();
    let emit: Arc<dyn Fn(Event) + Send + Sync> = Arc::new(move |e| {
        let _ = tx.send(e);
    });
    let handle = match engine::attach(engine::data_dir(), emit, false) {
        Ok(h) => h,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    };
    let mut model = Model::new(toolkit::images::Images::new(|| {}));
    wait_for(&rx, &mut model, Duration::from_secs(20), |_, e| matches!(e, Event::Snapshot { .. }));
    (handle, rx, model)
}

fn snapshot(args: &[String]) {
    let get = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
    let out = get("--snapshot").unwrap();
    let (w, h) = get("--size")
        .and_then(|s| s.split_once('x').map(|(a, b)| (a.parse().unwrap(), b.parse().unwrap())))
        .unwrap_or((2360u32, 1520u32));
    let scale: f32 = get("--scale").map(|s| s.parse().unwrap()).unwrap_or(2.0);
    let (handle, rx, mut model) = headless();
    let mut gpu = Gpu::new(None, (w, h));
    let mut text = Text::new();
    let mt = metrics(&mut text, scale, PhysicalSize::new(w, h));
    let registry = cmds::registry();
    let pointer = get("--pointer").and_then(|p| p.split_once(',').map(|(a, b)| (a.parse().unwrap(), b.parse().unwrap())));
    let mut quads = Vec::new();
    let paint = |model: &mut Model, text: &mut Text, quads: &mut Vec<toolkit::gpu::Quad>| {
        let started = Instant::now();
        text.begin_frame();
        model.images.begin_frame();
        let mut scene = Scene::new(text, mt, model.lines, if model.settings.appearance == "dark" { DARK } else { LIGHT });
        scene.pointer = pointer;
        view::paint(model, &registry, &mut scene, FrameStats::default());
        *quads = std::mem::take(&mut scene.quads);
        started.elapsed().as_secs_f32() * 1000.0
    };
    paint(&mut model, &mut text, &mut quads);
    let mut clipboard = None;
    for k in get("--keys").unwrap_or_default().split(' ').filter(|k| !k.is_empty()) {
        match k {
            "wait" => {
                flush(&mut model, &handle, &mut clipboard);
                wait_for(&rx, &mut model, Duration::from_secs(15), |_, e| matches!(e, Event::Body(_) | Event::Discovered(..) | Event::FeedAdded(_) | Event::SearchResults(..)));
            }
            "images" => {
                let deadline = Instant::now() + Duration::from_secs(20);
                loop {
                    while let Ok(e) = rx.try_recv() {
                        model.event(e);
                    }
                    paint(&mut model, &mut text, &mut quads);
                    flush(&mut model, &handle, &mut clipboard);
                    if model.images.pending() == 0 || Instant::now() > deadline {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
            "refreshed" => {
                wait_for(&rx, &mut model, Duration::from_secs(60), |_, e| matches!(e, Event::Refresh(s) if !s.running));
            }
            _ => {
                let chord = match k {
                    "down" => Chord::key(Key::Down),
                    "pgdn" => Chord::key(Key::PageDown),
                    "enter" => Chord::key(Key::Enter),
                    "esc" => Chord::key(Key::Escape),
                    "undo" => Chord::cmd('z'),
                    "O" => Chord { key: Key::Char('o'), cmd: false, shift: true },
                    other if other.starts_with("type:") => {
                        let t = other.trim_start_matches("type:").replace('_', " ");
                        match model.focus {
                            Focus::Filter => {
                                model.filter.insert(&t);
                                model.reset_list();
                            }
                            Focus::Prompt => {
                                if let Some(p) = model.prompt.as_mut() {
                                    p.field.insert(&t);
                                }
                            }
                            Focus::Palette => {
                                if let Some(p) = model.palette.as_mut() {
                                    p.field.insert(&t);
                                }
                                palette::refresh(&mut model);
                            }
                            Focus::Main => {}
                        }
                        continue;
                    }
                    other if other.starts_with("feed:") => {
                        let q = other.trim_start_matches("feed:").replace('_', " ").to_lowercase();
                        if let Some(f) = model.feeds.iter().find(|f| f.name().to_lowercase().contains(&q)) {
                            let id = f.id.clone();
                            model.show(model::View::Feed(id));
                        }
                        paint(&mut model, &mut text, &mut quads);
                        continue;
                    }
                    other if other.starts_with("cmd:") => {
                        let name = other.trim_start_matches("cmd:");
                        if let Some(c) = registry.commands.iter().find(|c| format!("{:?}", c.id).eq_ignore_ascii_case(name)) {
                            cmds::exec(&mut model, c.id);
                        }
                        flush(&mut model, &handle, &mut clipboard);
                        paint(&mut model, &mut text, &mut quads);
                        continue;
                    }
                    other => Chord::ch(other.chars().next().unwrap()),
                };
                if let Some(c) = registry.lookup(&model, &chord) {
                    cmds::exec(&mut model, c);
                }
            }
        }
        model.open.clear();
        flush(&mut model, &handle, &mut clipboard);
        while let Ok(e) = rx.try_recv() {
            model.event(e);
        }
        paint(&mut model, &mut text, &mut quads);
    }
    let cold = paint(&mut model, &mut text, &mut quads);
    let warm = paint(&mut model, &mut text, &mut quads);
    for u in text.uploads.drain(..) {
        gpu.upload(u.x, u.y, u.w, u.h, &u.data);
    }
    for (id, d) in model.images.take_uploads() {
        gpu.add_image(id, d.width, d.height, &d.rgba);
    }
    let pixels = gpu.snapshot(&quads, if model.settings.appearance == "dark" { DARK.bg } else { LIGHT.bg });
    let file = std::fs::File::create(&out).unwrap();
    let mut enc = png::Encoder::new(std::io::BufWriter::new(file), w, h);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    enc.write_header().unwrap().write_image_data(&pixels).unwrap();
    println!("{out}: {} quads, paint {cold:.2} ms, cached {warm:.2} ms", quads.len());
    if let Some(msg) = &model.message {
        println!("message: {msg}");
    }
}

struct Probe {
    url: String,
    local: bool,
    proxy: EventLoopProxy<Wake>,
    run: Option<(Arc<Window>, engine::Handle, Receiver<Event>, extract::Extractor)>,
}

impl ApplicationHandler<Wake> for Probe {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.run.is_some() {
            return;
        }
        let window = Arc::new(event_loop.create_window(Window::default_attributes().with_visible(false)).expect("window"));
        let (tx, rx) = channel();
        let proxy = self.proxy.clone();
        let emit: Arc<dyn Fn(Event) + Send + Sync> = Arc::new(move |e| {
            let _ = tx.send(e);
            let _ = proxy.send_event(Wake::Engine);
        });
        let Ok(handle) = engine::attach(engine::data_dir(), emit, false) else {
            event_loop.exit();
            return;
        };
        if !self.local {
            handle.send(Request::UseWebExtractor);
        }
        handle.send(Request::Probe(self.url.clone()));
        self.run = Some((window, handle, rx, extract::Extractor::new()));
    }

    fn user_event(&mut self, event_loop: &ActiveEventLoop, wake: Wake) {
        let Some((window, handle, rx, ex)) = self.run.as_mut() else { return };
        let mut out = Vec::new();
        match wake {
            Wake::Engine => {
                while let Ok(e) = rx.try_recv() {
                    match e {
                        Event::Extract { job, url, html } => out.extend(ex.push(window, &self.proxy, job, url, html)),
                        Event::Probed(url, r) => {
                            match r {
                                Ok((x, by)) => {
                                    println!("{}\n{url}\nextracted by {}\n", x.title, by.name());
                                    println!("{}", engine::article_text(&x.html, &url));
                                }
                                Err(e) => eprintln!("Couldn't extract {url}: {e}"),
                            }
                            event_loop.exit();
                        }
                        _ => {}
                    }
                }
            }
            Wake::ExtractorReady => out.extend(ex.ready()),
            Wake::Extracted(body) => out.extend(extract::result(&body)),
            Wake::WebClose | Wake::Images | Wake::Theme => {}
        }
        for r in out {
            handle.send(r);
        }
    }

    fn window_event(&mut self, _: &ActiveEventLoop, _: WindowId, _: WindowEvent) {}
}

fn cli(args: &[String]) -> bool {
    match args.get(1).map(String::as_str) {
        Some("service") => {
            let r = match args.get(2).map(String::as_str) {
                Some("install") => service::install(),
                Some("uninstall") => service::uninstall(),
                _ => Err("usage: feedreader service install | uninstall".into()),
            };
            match r {
                Ok(m) => println!("{m}"),
                Err(e) => {
                    eprintln!("{e}");
                    std::process::exit(1);
                }
            }
            true
        }
        Some("pair") => {
            let (handle, rx, mut model) = headless();
            match args.get(2) {
                Some(link) => {
                    handle.send(Request::Pair(link.clone(), host_name()));
                    wait_for(&rx, &mut model, Duration::from_secs(30), |_, e| matches!(e, Event::Message(_)));
                    println!("{}", model.message.unwrap_or_default());
                }
                None => {
                    handle.send(Request::PairCode);
                    wait_for(&rx, &mut model, Duration::from_secs(10), |_, e| matches!(e, Event::Pairing(_) | Event::Message(_)));
                    match model.pairing {
                        Some(link) => println!("Open this on the other device within 15 minutes, or run feedreader pair '<link>' there:\n\n{link}\n\n{}", qr_text(&link)),
                        None => println!("{}", model.message.unwrap_or_default()),
                    }
                }
            }
            true
        }
        Some("serve") => {
            if let Err(e) = engine::serve::serve(engine::data_dir()) {
                eprintln!("{e}");
                std::process::exit(1);
            }
            true
        }
        Some("extract") => {
            let Some(url) = args.get(2).filter(|a| !a.starts_with("--")) else {
                eprintln!("usage: feedreader extract <url> [--local]");
                return true;
            };
            let event_loop = EventLoop::<Wake>::with_user_event().build().expect("event loop");
            let proxy = event_loop.create_proxy();
            let mut probe = Probe {
                url: url.clone(),
                local: args.iter().any(|a| a == "--local"),
                proxy,
                run: None,
            };
            let _ = event_loop.run_app(&mut probe);
            true
        }
        Some("import") => {
            let Some(path) = args.get(2) else {
                eprintln!("usage: feedreader import <file.opml | feedreader.sqlite>");
                return true;
            };
            let path = cmds::expand(path);
            let (handle, rx, mut model) = headless();
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
            handle.send(if ext == "sqlite" || ext == "db" { Request::ImportLegacy(path) } else { Request::ImportOpml(path) });
            wait_for(&rx, &mut model, Duration::from_secs(60), |_, e| matches!(e, Event::Message(_)));
            println!("{}", model.message.unwrap_or_default());
            true
        }
        Some("export") => {
            let Some(path) = args.get(2) else {
                eprintln!("usage: feedreader export <file.opml>");
                return true;
            };
            let path = cmds::expand(path);
            if path.exists() {
                eprintln!("{} already exists; choose a new file name", path.display());
                return true;
            }
            let (handle, rx, mut model) = headless();
            handle.send(Request::ExportOpml(path));
            wait_for(&rx, &mut model, Duration::from_secs(30), |_, e| matches!(e, Event::Message(_)));
            println!("{}", model.message.unwrap_or_default());
            true
        }
        Some("refresh") => {
            let (handle, rx, mut model) = headless();
            handle.send(Request::Refresh);
            wait_for(&rx, &mut model, Duration::from_secs(120), |_, e| matches!(e, Event::Refresh(s) if !s.running && s.run > 0));
            let r = &model.refresh;
            println!("{} feeds, {} failed, {} new entries", r.total, r.failed, r.added);
            for f in model.feeds.iter().filter(|f| f.error.is_some()) {
                println!("  {}: {}", f.name(), f.error.as_deref().unwrap_or(""));
            }
            true
        }
        Some("unread") => {
            let limit = args
                .iter()
                .position(|a| a == "--limit")
                .and_then(|i| args.get(i + 1))
                .and_then(|n| n.parse().ok())
                .unwrap_or(usize::MAX);
            let (_handle, _rx, model) = headless();
            let esc = |s: &str| s.replace('[', "\\[").replace(']', "\\]");
            for e in model.entries.iter().filter(|e| !e.read && model.feed(&e.feed_id).is_some()).take(limit) {
                println!("- [{}]({}) - {}", esc(&e.title), e.url, esc(model.feed_name(&e.feed_id)));
            }
            true
        }
        _ => false,
    }
}

fn main() {
    #[cfg(feature = "profile")]
    tracy_client::Client::start();
    profiling::register_thread!("main");
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--snapshot") {
        snapshot(&args);
        return;
    }
    if cli(&args) {
        return;
    }
    let event_loop = EventLoop::<Wake>::with_user_event().build().expect("event loop");
    event_loop.set_control_flow(ControlFlow::Wait);
    let proxy = event_loop.create_proxy();
    let mut app = App { state: None, proxy };
    event_loop.run_app(&mut app).expect("run");
}
