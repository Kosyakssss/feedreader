use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use winit::application::ApplicationHandler;
use winit::dpi::{LogicalSize, PhysicalPosition, PhysicalSize};
use winit::event::{ElementState, Ime, MouseButton, MouseScrollDelta, WindowEvent};
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop, EventLoopProxy};
use winit::keyboard::{Key as WKey, ModifiersState, NamedKey};
use winit::window::WindowId;

pub use winit::window::{CursorIcon as Cursor, Window};

use crate::commands::{Chord, Key, Registry};
use crate::field::{Edit, Field, Keys};
use crate::ui::Focused;
use crate::gpu::{Gpu, Quad};
use crate::images::Images;
use crate::menu;
use crate::state::{Id, State};
use crate::text::{Face, Text, TextStyle};
use crate::ui::{LineStyle, Metrics, Palette, Rect, Scene};

pub struct Config {
    pub title: &'static str,
    pub size: (f64, f64),
    pub min_size: (f64, f64),
    pub font_size: f32,
    pub visible: bool,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Mods {
    pub shift: bool,
    pub alt: bool,
    pub primary: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Effect {
    Open(String),
    Copy(String),
    Choose(Choose),
    Quit,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Choose {
    pub id: u32,
    pub title: String,
    pub save_as: Option<String>,
    pub kinds: Vec<(String, Vec<String>)>,
}

fn choose(window: &Window, c: &Choose) -> Option<PathBuf> {
    let mut dialog = rfd::FileDialog::new().set_title(&c.title).set_parent(window);
    if let Some(dir) = std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Downloads")).filter(|d| d.is_dir()) {
        dialog = dialog.set_directory(dir);
    }
    for (name, extensions) in &c.kinds {
        dialog = dialog.add_filter(name, extensions);
    }
    match &c.save_as {
        Some(name) => dialog.set_file_name(name).save_file(),
        None => dialog.pick_file(),
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Web {
    Url(String),
    Html { key: String, html: String },
}

impl Web {
    fn key(&self) -> &str {
        match self {
            Web::Url(u) => u,
            Web::Html { key, .. } => key,
        }
    }
}

#[derive(Default)]
pub struct Painted {
    pub web: Option<(Rect, Web)>,
}

#[derive(Clone, Copy, Default)]
pub struct FrameStats {
    pub paint: f32,
    pub gpu: f32,
    pub max_paint: f32,
    pub max_gpu: f32,
}

impl FrameStats {
    fn from(frames: &[[f32; 3]]) -> Self {
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

enum Signal<W> {
    App(W),
    WebClose,
    Images,
}

pub struct Waker<W: 'static> {
    proxy: EventLoopProxy<Signal<W>>,
}

impl<W: 'static> Clone for Waker<W> {
    fn clone(&self) -> Self {
        Self { proxy: self.proxy.clone() }
    }
}

impl<W: Send + 'static> Waker<W> {
    pub fn wake(&self, w: W) {
        let _ = self.proxy.send_event(Signal::App(w));
    }

    pub fn images(&self) -> impl Fn() + Send + Sync + 'static {
        let proxy = self.proxy.clone();
        move || {
            let _ = proxy.send_event(Signal::Images);
        }
    }
}

pub struct Ctx<'a> {
    pub window: &'a Window,
    pub text: &'a mut Text,
    pub metrics: Metrics,
    pub mouse: (f32, f32),
    pub mods: Mods,
    pub clicks: u32,
}

pub trait App: Sized + 'static {
    type Model: 'static;
    type Command: Copy + PartialEq + 'static;
    type Hit: Clone + 'static;
    type Wake: Send + 'static;

    fn model(&self) -> &Self::Model;
    fn registry(&self) -> &'static Registry<Self::Command, Self::Model>;
    fn exec(&mut self, command: Self::Command, state: &State);
    fn images(&mut self) -> &mut Images;
    fn style(&self, system_dark: bool) -> (LineStyle, Palette);
    fn paint(&mut self, scene: &mut Scene<Self::Hit>, stats: FrameStats) -> Painted;
    fn painted(&mut self) {}
    fn settle(&mut self) -> Vec<Effect>;
    fn wake(&mut self, wake: Self::Wake, cx: &mut Ctx) -> bool;
    fn field(&mut self) -> Option<&mut Field> {
        None
    }
    fn field_changed(&mut self) {}
    fn hoverable(_: &Self::Hit) -> bool {
        true
    }
    fn cursor(&mut self, _: Option<&Self::Hit>, _: &mut Ctx) -> Cursor {
        Cursor::Default
    }
    fn press(&mut self, _: Option<Self::Hit>, _: &mut Ctx) {}
    fn middle(&mut self, _: Option<Self::Hit>, _: &mut Ctx) {}
    fn context(&mut self, _: Option<Self::Hit>, _: &mut Ctx) -> Vec<(u32, String, Option<Chord>)> {
        Vec::new()
    }
    fn context_chosen(&mut self, _: u32) {}
    fn drag(&mut self, _: Option<Self::Hit>, _: &mut Ctx) -> Option<bool> {
        None
    }
    fn release(&mut self) {}
    fn wheel(&mut self, _: &[&Self::Hit], _: f32, _: f32, _: &mut Ctx) -> bool {
        false
    }
    fn dropped(&mut self, _: PathBuf) {}
    fn chosen(&mut self, _: u32, _: Option<PathBuf>) {}
    fn web_closed(&mut self) {}
    fn exiting(self) {}
}

pub fn metrics(text: &mut Text, font_size: f32, scale: f32, width: u32, height: u32) -> Metrics {
    let base = font_size * scale;
    let probe = TextStyle {
        face: Face::Mono,
        size: base,
        weight: 400.0,
    };
    let advance = text.measure("0000000000", probe, base) / 10.0;
    let cell_w = advance.round().max(1.0);
    let font = base * cell_w / advance;
    let cell_h = (font * 1.6).round();
    Metrics {
        scale,
        size: font,
        cell_w,
        cell_h,
        width: width as f32,
        height: height as f32,
    }
}

pub fn open_external(target: &str) {
    let opener = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    let _ = std::process::Command::new(opener).arg(target).spawn();
}

type Make<A> = Box<dyn FnOnce(Waker<<A as App>::Wake>, &mut Ctx) -> Result<A, String>>;

pub fn run<A: App>(config: Config, make: impl FnOnce(Waker<A::Wake>, &mut Ctx) -> Result<A, String> + 'static) -> Result<(), String> {
    let fonts = std::thread::Builder::new().name("fonts".into()).spawn(Text::new).ok();
    let event_loop = EventLoop::<Signal<A::Wake>>::with_user_event().build().map_err(|e| e.to_string())?;
    event_loop.set_control_flow(ControlFlow::Wait);
    let proxy = event_loop.create_proxy();
    let mut shell = Shell::<A> { config, proxy, running: None, failed: None, fonts, make: Some(Box::new(make)) };
    event_loop.run_app(&mut shell).map_err(|e| e.to_string())?;
    match shell.failed {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

struct Shell<A: App> {
    config: Config,
    proxy: EventLoopProxy<Signal<A::Wake>>,
    running: Option<Running<A>>,
    failed: Option<String>,
    fonts: Option<std::thread::JoinHandle<Text>>,
    make: Option<Make<A>>,
}

struct Running<A: App> {
    app: A,
    window: Arc<Window>,
    gpu: Gpu,
    text: Text,
    metrics: Metrics,
    font_size: f32,
    hits: Vec<(Rect, A::Hit)>,
    state: State,
    scrollables: Vec<(Rect, Id)>,
    tracks: Vec<(Rect, Id)>,
    thumb: Option<(Id, Rect, f32)>,
    web: Option<wry::WebView>,
    web_key: Option<String>,
    web_visible: bool,
    mouse: (f32, f32),
    pointer_inside: bool,
    hover: Option<Rect>,
    modifiers: ModifiersState,
    left_down: bool,
    last_click: Option<(Instant, f32, f32)>,
    clicks: u32,
    frames: Vec<[f32; 3]>,
    ime_on: bool,
    focused: Option<Focused>,
    fields: Vec<Rect>,
    selecting: bool,
    clipboard: Option<arboard::Clipboard>,
    system_dark: bool,
    proxy: EventLoopProxy<Signal<A::Wake>>,
    quit: bool,
    visible: bool,
    _menu: Option<menu::Menu>,
}

fn mods(m: ModifiersState) -> Mods {
    Mods {
        shift: m.shift_key(),
        alt: m.alt_key(),
        primary: if cfg!(target_os = "macos") { m.super_key() } else { m.control_key() },
    }
}

fn foreign(m: ModifiersState) -> bool {
    if cfg!(target_os = "macos") { m.control_key() } else { m.super_key() }
}

macro_rules! cx {
    ($r:expr) => {
        Ctx {
            window: &$r.window,
            text: &mut $r.text,
            metrics: $r.metrics,
            mouse: $r.mouse,
            mods: mods($r.modifiers),
            clicks: $r.clicks,
        }
    };
}

impl<A: App> Running<A> {
    #[profiling::function]
    fn render(&mut self) {
        let started = Instant::now();
        self.text.begin_frame();
        self.app.images().begin_frame();
        let stats = FrameStats::from(&self.frames);
        let (style, palette) = self.app.style(self.system_dark);
        self.state.begin_frame();
        let mut scene = Scene::new(&mut self.text, &mut self.state, self.metrics, style, palette);
        scene.pointer = self.pointer_inside.then_some(self.mouse);
        scene.pressed = self.left_down;
        let painted = self.app.paint(&mut scene, stats);
        let quads = std::mem::take(&mut scene.quads);
        self.hits = std::mem::take(&mut scene.hits);
        self.scrollables = std::mem::take(&mut scene.scrollables);
        self.tracks = std::mem::take(&mut scene.tracks);
        self.focused = scene.focused.take();
        self.fields = std::mem::take(&mut scene.fields);
        drop(scene);
        for u in self.text.uploads.drain(..) {
            self.gpu.upload(u.x, u.y, u.w, u.h, &u.data);
        }
        let images = self.app.images();
        for (id, d) in images.take_uploads() {
            self.gpu.add_image(id, d.width, d.height, &d.rgba);
        }
        for id in images.take_evicted() {
            self.gpu.remove_image(id);
        }
        self.app.painted();
        let done = Instant::now();
        self.gpu.render(&quads, palette.bg);
        let presented = Instant::now();
        self.sync_web(painted.web, palette.bg);
        self.sync_ime(self.focused.map(|f| f.caret));
        let ms = |a: Instant, b: Instant| (b - a).as_secs_f32() * 1000.0;
        self.frames.push([ms(started, done), ms(done, presented), ms(presented, Instant::now())]);
        profiling::finish_frame!();
        if self.frames.len() > 240 {
            self.frames.remove(0);
        }
    }

    fn sync_web(&mut self, web: Option<(Rect, Web)>, bg: [f32; 4]) {
        let Some((r, content)) = web else {
            if let Some(w) = &self.web
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
        match &self.web {
            Some(w) => {
                let _ = w.set_bounds(bounds);
                let _ = w.set_visible(true);
                if self.web_key.as_deref() != Some(content.key()) {
                    let _ = match &content {
                        Web::Url(u) => w.load_url(u),
                        Web::Html { html, .. } => w.load_html(html),
                    };
                }
            }
            None => {
                let proxy = self.proxy.clone();
                let builder = match &content {
                    Web::Url(u) => wry::WebViewBuilder::new().with_url(u.clone()),
                    Web::Html { html, .. } => wry::WebViewBuilder::new().with_html(html.clone()),
                };
                self.web = builder
                    .with_bounds(bounds)
                    .with_background_color(((bg[0] * 255.0) as u8, (bg[1] * 255.0) as u8, (bg[2] * 255.0) as u8, 255))
                    .with_initialization_script(format!(
                        "document.addEventListener('keydown', e => {{ if (e.key === 'Escape' || (e.{}Key && e.key === 'w')) {{ e.preventDefault(); window.ipc.postMessage('close'); }} }}, true);",
                        if cfg!(target_os = "macos") { "meta" } else { "ctrl" }
                    ))
                    .with_ipc_handler(move |_| {
                        let _ = proxy.send_event(Signal::WebClose);
                    })
                    .build_as_child(&*self.window)
                    .ok();
            }
        }
        self.web_key = Some(content.key().to_string());
    }

    fn sync_ime(&mut self, caret: Option<Rect>) {
        let want = caret.is_some();
        if want != self.ime_on {
            self.window.set_ime_allowed(want);
            self.ime_on = want;
        }
        if let Some(c) = caret {
            self.window.set_ime_cursor_area(PhysicalPosition::new(c.x as f64, c.y as f64), PhysicalSize::new(c.w as f64, c.h as f64));
        }
    }

    fn hit_at(&self, x: f32, y: f32) -> Option<A::Hit> {
        self.hits.iter().rev().find(|(r, _)| r.contains(x, y)).map(|(_, h)| h.clone())
    }

    fn settle(&mut self) {
        let mut effects = self.app.settle();
        while !effects.is_empty() {
            let mut chose = false;
            for effect in effects {
                match effect {
                    Effect::Open(target) => open_external(&target),
                    Effect::Copy(text) => {
                        if let Some(c) = &mut self.clipboard {
                            let _ = c.set_text(text);
                        }
                    }
                    Effect::Choose(c) => {
                        let path = choose(&self.window, &c);
                        self.app.chosen(c.id, path);
                        chose = true;
                    }
                    Effect::Quit => self.quit = true,
                }
            }
            effects = if chose { self.app.settle() } else { Vec::new() };
        }
        if self.visible {
            self.window.request_redraw();
        }
    }

    #[profiling::function]
    fn key(&mut self, event: &winit::event::KeyEvent) -> bool {
        let control = foreign(self.modifiers);
        let m = mods(self.modifiers);
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
            WKey::Character(s) => s
                .chars()
                .next()
                .map(|c| match c {
                    '{' => '[',
                    '}' => ']',
                    c => c,
                })
                .map(Key::Char),
            _ => None,
        };
        let Some(key) = key else { return false };
        let plain = match key {
            Key::Char(c) => Key::Char(c.to_ascii_lowercase()),
            k => k,
        };
        if !m.primary
            && !control
            && matches!(key, Key::Char(_))
            && let Some(t) = event.text.as_ref().map(|t| t.to_string())
            && !t.chars().any(char::is_control)
            && let Some(f) = self.app.field()
            && f.preedit.is_empty()
        {
            f.insert(&t);
            self.app.field_changed();
            return true;
        }
        if let Some(f) = self.app.field()
            && f.preedit.is_empty()
        {
            let keys = Keys { shift: m.shift, alt: m.alt, primary: m.primary, control };
            match f.key(plain, keys) {
                Edit::Ignored => {}
                Edit::Moved => return true,
                Edit::Changed => {
                    self.app.field_changed();
                    return true;
                }
                Edit::Copy(text) => {
                    if let Some(c) = &mut self.clipboard {
                        let _ = c.set_text(text);
                    }
                    return true;
                }
                Edit::Cut(text) => {
                    if let Some(c) = &mut self.clipboard {
                        let _ = c.set_text(text);
                    }
                    self.app.field_changed();
                    return true;
                }
                Edit::Line(to, extend) => {
                    let (Some(focused), Some(f)) = (self.focused, self.app.field()) else { return true };
                    let Some(wrap) = focused.wrap else { return true };
                    let mono = self.metrics.mono();
                    let span = crate::text::SpanStyle::plain(Face::Mono);
                    let at = self.text.line_move(&[(&f.text, span)], mono.size, self.metrics.cell_h, wrap, f.caret, to);
                    f.place(at, extend);
                    return true;
                }
                Edit::Paste => {
                    let multiline = self.app.field().is_some_and(|f| f.multiline);
                    let pasted = self
                        .clipboard
                        .as_mut()
                        .and_then(|c| c.get_text().ok())
                        .map(|t| if multiline { t.replace("\r\n", "\n") } else { t.replace(['\n', '\r'], " ") });
                    if let Some(t) = pasted
                        && let Some(f) = self.app.field()
                    {
                        f.insert(&t);
                        self.app.field_changed();
                        return true;
                    }
                }
            }
        }
        if control {
            return false;
        }
        let shift_matters = m.primary || !matches!(key, Key::Char(c) if !c.is_ascii_alphabetic());
        let chord = Chord { key: plain, cmd: m.primary, shift: m.shift && shift_matters };
        if let Some(c) = self.app.registry().lookup(self.app.model(), &chord) {
            self.app.exec(c, &self.state);
            return true;
        }
        false
    }

    #[profiling::function]
    fn press(&mut self) {
        if let Some(w) = &self.web
            && self.web_visible
        {
            let _ = w.focus_parent();
        }
        let (x, y) = self.mouse;
        if let Some(&(track, id)) = self.tracks.iter().rev().find(|(r, _)| r.contains(x, y)) {
            self.left_down = true;
            let min = self.metrics.cell_h;
            if let Some(s) = self.state.scroll(id) {
                let (top, h) = s.thumb(track.h, min);
                let grab = if y >= track.y + top && y < track.y + top + h { y - track.y - top } else { h / 2.0 };
                self.thumb = Some((id, track, grab));
                self.drag_thumb();
            }
            return;
        }
        let now = Instant::now();
        let double = self.last_click.is_some_and(|(t, px, py)| now - t < Duration::from_millis(400) && (px - x).abs() < 6.0 && (py - y).abs() < 6.0);
        self.last_click = Some((now, x, y));
        self.clicks = if double { 2 } else { 1 };
        self.left_down = true;
        let hit = self.hit_at(x, y);
        let mut cx = cx!(self);
        self.app.press(hit, &mut cx);
        self.selecting = false;
        if self.app.field().is_none() || !self.fields.iter().any(|r| r.contains(x, y)) {
            return;
        }
        if !self.focused.is_some_and(|f| f.rect.contains(x, y)) {
            self.render();
        }
        let Some(at) = self.caret_at(x, y) else { return };
        let (shift, clicks) = (self.modifiers.shift_key(), self.clicks);
        if let Some(f) = self.app.field() {
            if clicks == 2 { f.select_word(at) } else { f.place(at, shift) }
            self.selecting = true;
        }
    }

    fn caret_at(&mut self, x: f32, y: f32) -> Option<usize> {
        let focused = self.focused.filter(|f| f.rect.contains(x, y) || self.selecting)?;
        let f = self.app.field()?;
        let mono = self.metrics.mono();
        let (dx, dy) = (x - focused.origin.0, y - focused.origin.1);
        Some(match focused.wrap {
            Some(wrap) => self.text.byte_at(&[(&f.text, crate::text::SpanStyle::plain(Face::Mono))], mono.size, self.metrics.cell_h, wrap, dx, dy),
            None => self.text.index_at(&f.text, mono, self.metrics.cell_h, dx),
        })
    }

    fn middle(&mut self) {
        let hit = self.hit_at(self.mouse.0, self.mouse.1);
        let mut cx = cx!(self);
        self.app.middle(hit, &mut cx);
    }

    fn context(&mut self) {
        let hit = self.hit_at(self.mouse.0, self.mouse.1);
        let mut cx = cx!(self);
        let items = self.app.context(hit, &mut cx);
        if items.is_empty() {
            return;
        }
        self.settle();
        self.render();
        if let Some(id) = menu::popup(&self.window, &items) {
            self.app.context_chosen(id);
        }
    }

    fn drag_thumb(&mut self) {
        let Some((id, track, grab)) = self.thumb else { return };
        let min = self.metrics.cell_h;
        let s = self.state.scroll_mut(id);
        let (_, h) = s.thumb(track.h, min);
        let room = (track.h - h).max(1.0);
        let at = ((self.mouse.1 - track.y - grab) / room).clamp(0.0, 1.0) * s.max();
        let step = self.state.step(self.metrics.cell_h);
        let at = step.map_or(at, |st| (at / st).round() * st);
        self.state.scroll_to(id, at);
    }

    #[profiling::function]
    fn wheel(&mut self, dx: f32, dy: f32) -> bool {
        let (x, y) = self.mouse;
        if let Some(&(_, id)) = self.scrollables.iter().rev().find(|(r, _)| r.contains(x, y)) {
            return self.state.wheel(id, dy, self.metrics.cell_h);
        }
        let under: Vec<&A::Hit> = self.hits.iter().rev().filter(|(r, _)| r.contains(x, y)).map(|(_, h)| h).collect();
        let mut cx = Ctx {
            window: &self.window,
            text: &mut self.text,
            metrics: self.metrics,
            mouse: self.mouse,
            mods: mods(self.modifiers),
            clicks: self.clicks,
        };
        self.app.wheel(&under, dx, dy, &mut cx)
    }

    fn moved(&mut self) -> bool {
        if self.left_down && self.thumb.is_some() {
            self.drag_thumb();
            return true;
        }
        if self.left_down && self.selecting {
            let (x, y) = self.mouse;
            if let Some(at) = self.caret_at(x, y)
                && let Some(f) = self.app.field()
            {
                f.place(at, true);
            }
            return true;
        }
        if self.left_down {
            let hit = self.hit_at(self.mouse.0, self.mouse.1);
            let mut cx = cx!(self);
            if let Some(redraw) = self.app.drag(hit, &mut cx) {
                return redraw;
            }
        }
        let (x, y) = self.mouse;
        let hover = self.hits.iter().rev().find(|(r, h)| r.contains(x, y) && A::hoverable(h)).map(|(r, _)| *r);
        let changed = hover != self.hover;
        self.hover = hover;
        let hit = self.hit_at(x, y);
        let mut cx = cx!(self);
        let cursor = self.app.cursor(hit.as_ref(), &mut cx);
        self.window.set_cursor(cursor);
        changed
    }
}

impl<A: App> ApplicationHandler<Signal<A::Wake>> for Shell<A> {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.running.is_some() {
            return;
        }
        let attributes = Window::default_attributes()
            .with_title(self.config.title)
            .with_inner_size(LogicalSize::new(self.config.size.0, self.config.size.1))
            .with_min_inner_size(LogicalSize::new(self.config.min_size.0, self.config.min_size.1))
            .with_visible(self.config.visible);
        let window = match event_loop.create_window(attributes) {
            Ok(w) => Arc::new(w),
            Err(e) => {
                self.failed = Some(e.to_string());
                event_loop.exit();
                return;
            }
        };
        let size = window.inner_size();
        let gpu = Gpu::new(Some(window.clone()), (size.width, size.height));
        let mut text = self.fonts.take().and_then(|t| t.join().ok()).unwrap_or_default();
        let font_size = self.config.font_size;
        let metrics = metrics(&mut text, font_size, window.scale_factor() as f32, size.width, size.height);
        let system_dark = window.theme() == Some(winit::window::Theme::Dark);
        let menu = if self.config.visible { menu::install(event_loop, self.config.title) } else { None };
        let waker = Waker { proxy: self.proxy.clone() };
        let mut cx = Ctx {
            window: &window,
            text: &mut text,
            metrics,
            mouse: (0.0, 0.0),
            mods: Mods::default(),
            clicks: 0,
        };
        let Some(make) = self.make.take() else { return };
        let app = match make(waker, &mut cx) {
            Ok(app) => app,
            Err(e) => {
                if self.config.visible {
                    rfd::MessageDialog::new().set_level(rfd::MessageLevel::Error).set_title(self.config.title).set_description(&e).show();
                }
                self.failed = Some(e);
                event_loop.exit();
                return;
            }
        };
        let mut running = Running {
            app,
            window,
            gpu,
            text,
            metrics,
            font_size,
            hits: Vec::new(),
            state: State::default(),
            scrollables: Vec::new(),
            tracks: Vec::new(),
            thumb: None,
            web: None,
            web_key: None,
            web_visible: false,
            mouse: (0.0, 0.0),
            pointer_inside: false,
            hover: None,
            modifiers: ModifiersState::empty(),
            left_down: false,
            last_click: None,
            clicks: 0,
            frames: Vec::new(),
            ime_on: false,
            focused: None,
            fields: Vec::new(),
            selecting: false,
            clipboard: arboard::Clipboard::new().ok(),
            system_dark,
            proxy: self.proxy.clone(),
            quit: false,
            visible: self.config.visible,
            _menu: menu,
        };
        running.settle();
        if self.config.visible {
            running.render();
        }
        self.running = Some(running);
    }

    fn user_event(&mut self, event_loop: &ActiveEventLoop, signal: Signal<A::Wake>) {
        let Some(r) = self.running.as_mut() else { return };
        let redraw = match signal {
            Signal::App(w) => {
                let mut cx = cx!(r);
                r.app.wake(w, &mut cx)
            }
            Signal::WebClose => {
                r.app.web_closed();
                r.window.focus_window();
                true
            }
            Signal::Images => true,
        };
        if redraw {
            r.settle();
        }
        if r.quit {
            event_loop.exit();
        }
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, _: WindowId, event: WindowEvent) {
        let Some(r) = self.running.as_mut() else { return };
        let redraw = match event {
            WindowEvent::CloseRequested => {
                event_loop.exit();
                false
            }
            WindowEvent::Resized(size) => {
                r.pointer_inside = false;
                r.hover = None;
                r.gpu.resize(size.width, size.height);
                r.metrics = metrics(&mut r.text, r.font_size, r.metrics.scale, size.width, size.height);
                r.render();
                false
            }
            WindowEvent::ScaleFactorChanged { scale_factor, .. } => {
                r.text.clear();
                let size = r.window.inner_size();
                r.metrics = metrics(&mut r.text, r.font_size, scale_factor as f32, size.width, size.height);
                true
            }
            WindowEvent::RedrawRequested => {
                if r.visible {
                    r.render();
                }
                false
            }
            WindowEvent::ModifiersChanged(m) => {
                r.modifiers = m.state();
                false
            }
            WindowEvent::KeyboardInput { event, .. } if event.state == ElementState::Pressed => r.key(&event),
            WindowEvent::Ime(ime) => match ime {
                Ime::Preedit(text, _) => {
                    if let Some(f) = r.app.field() {
                        f.preedit = text;
                    }
                    true
                }
                Ime::Commit(text) => {
                    if let Some(f) = r.app.field() {
                        f.preedit.clear();
                        f.insert(&text);
                    }
                    r.app.field_changed();
                    true
                }
                _ => false,
            },
            WindowEvent::DroppedFile(path) => {
                r.app.dropped(path);
                true
            }
            WindowEvent::CursorMoved { position, .. } => {
                r.mouse = (position.x as f32, position.y as f32);
                r.pointer_inside = true;
                r.moved()
            }
            WindowEvent::CursorLeft { .. } => {
                r.pointer_inside = false;
                r.hover = None;
                true
            }
            WindowEvent::Occluded(false) => true,
            WindowEvent::ThemeChanged(t) => {
                r.system_dark = t == winit::window::Theme::Dark;
                true
            }
            WindowEvent::MouseInput { state: ElementState::Pressed, button: MouseButton::Left, .. } => {
                r.press();
                true
            }
            WindowEvent::MouseInput { state: ElementState::Pressed, button: MouseButton::Middle, .. } => {
                r.middle();
                true
            }
            WindowEvent::MouseInput { state: ElementState::Pressed, button: MouseButton::Right, .. } => {
                r.context();
                true
            }
            WindowEvent::MouseInput { state: ElementState::Released, button: MouseButton::Left, .. } => {
                r.left_down = false;
                r.selecting = false;
                r.app.release();
                r.thumb.take().is_some()
            }
            WindowEvent::MouseWheel { delta, .. } => {
                let (dx, dy) = match delta {
                    MouseScrollDelta::LineDelta(x, y) => (x * r.metrics.cell_w * 3.0, y * r.metrics.cell_h * 3.0),
                    MouseScrollDelta::PixelDelta(p) => (p.x as f32, p.y as f32),
                };
                r.wheel(dx, dy)
            }
            _ => false,
        };
        if redraw {
            r.settle();
        }
        if r.quit {
            event_loop.exit();
        }
    }

    fn exiting(&mut self, _: &ActiveEventLoop) {
        if let Some(r) = self.running.take() {
            r.app.exiting();
        }
    }
}

pub struct Offscreen {
    gpu: Gpu,
    pub text: Text,
    pub state: State,
    pub metrics: Metrics,
    width: u32,
    height: u32,
}

impl Offscreen {
    pub fn new(width: u32, height: u32, scale: f32, font_size: f32) -> Self {
        let mut text = Text::new();
        let metrics = metrics(&mut text, font_size, scale, width, height);
        Self { gpu: Gpu::new(None, (width, height)), text, state: State::default(), metrics, width, height }
    }

    pub fn paint<H>(&mut self, style: LineStyle, palette: Palette, pointer: Option<(f32, f32)>, f: impl FnOnce(&mut Scene<H>)) -> (Vec<Quad>, f32) {
        let started = Instant::now();
        self.text.begin_frame();
        self.state.begin_frame();
        let mut scene = Scene::new(&mut self.text, &mut self.state, self.metrics, style, palette);
        scene.pointer = pointer;
        f(&mut scene);
        let quads = std::mem::take(&mut scene.quads);
        (quads, started.elapsed().as_secs_f32() * 1000.0)
    }

    pub fn capture(&mut self, quads: &[Quad], bg: [f32; 4], images: &mut Images) -> Vec<u8> {
        for u in self.text.uploads.drain(..) {
            self.gpu.upload(u.x, u.y, u.w, u.h, &u.data);
        }
        for (id, d) in images.take_uploads() {
            self.gpu.add_image(id, d.width, d.height, &d.rgba);
        }
        self.gpu.snapshot(quads, bg)
    }

    pub fn save_png(&self, path: &Path, pixels: &[u8]) -> Result<(), String> {
        let file = std::fs::File::create(path).map_err(|e| e.to_string())?;
        let mut enc = png::Encoder::new(std::io::BufWriter::new(file), self.width, self.height);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.write_header().and_then(|mut w| w.write_image_data(pixels)).map_err(|e| e.to_string())
    }
}
