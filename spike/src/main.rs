mod app;
mod commands;
mod data;
mod gpu;
mod text;
mod ui;

use std::sync::Arc;
use std::time::Instant;

use winit::application::ApplicationHandler;
use winit::dpi::{LogicalSize, PhysicalPosition, PhysicalSize};
use winit::event::{ElementState, Ime, MouseButton, MouseScrollDelta, WindowEvent};
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop};
use winit::keyboard::{Key as WKey, ModifiersState, NamedKey};
use winit::window::{CursorIcon, Window, WindowId};

use app::{Cmd, Focus, Hit, Model};
use commands::{Chord, Key, Registry};
use gpu::Gpu;
use text::Text;
use ui::{LIGHT, Metrics, Rect, Scene};

const BASE_SIZE: f32 = 13.0;

enum Drag {
    None,
    Paint { anchor: usize, on: bool },
    Track(Rect),
}

struct State {
    window: Arc<Window>,
    gpu: Gpu,
    text: Text,
    model: Model,
    registry: Registry<Cmd, Model>,
    hits: Vec<(Rect, Hit)>,
    webview: Option<wry::WebView>,
    web_url: Option<String>,
    metrics: Metrics,
    mouse: (f32, f32),
    modifiers: ModifiersState,
    drag: Drag,
    frames: Vec<[f32; 3]>,
    ime_on: bool,
}

#[derive(Default)]
struct App {
    state: Option<State>,
}

fn metrics(text: &mut Text, scale: f32, size: PhysicalSize<u32>) -> Metrics {
    let font = BASE_SIZE * scale;
    let cell_h = (font * 1.6).round();
    let probe = text::TextStyle {
        face: text::Face::Mono,
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

impl State {
    fn render(&mut self) {
        let started = Instant::now();
        self.text.begin_frame();
        let stats = app::FrameStats::from(&self.frames);
        let mut scene = Scene::new(&mut self.text, self.metrics, self.model.lines, LIGHT);
        let out = app::paint(&mut self.model, &self.registry, &mut scene, stats);
        let quads = std::mem::take(&mut scene.quads);
        self.hits = std::mem::take(&mut scene.hits);
        drop(scene);
        for u in self.text.uploads.drain(..) {
            self.gpu.upload(u.x, u.y, u.w, u.h, &u.data);
        }
        let painted = Instant::now();
        self.gpu.render(&quads, LIGHT.bg);
        let presented = Instant::now();
        self.sync_webview(out.webview);
        self.sync_ime(out.ime);
        let ms = |a: Instant, b: Instant| (b - a).as_secs_f32() * 1000.0;
        self.frames.push([ms(started, painted), ms(painted, presented), ms(presented, Instant::now())]);
        if self.frames.len() > 240 {
            self.frames.remove(0);
        }
    }

    fn sync_webview(&mut self, rect: Option<Rect>) {
        let Some(r) = rect else {
            if let Some(w) = &self.webview {
                let _ = w.set_visible(false);
            }
            return;
        };
        let s = self.metrics.scale as f64;
        let bounds = wry::Rect {
            position: wry::dpi::LogicalPosition::new(r.x as f64 / s, r.y as f64 / s).into(),
            size: wry::dpi::LogicalSize::new(r.w as f64 / s, r.h as f64 / s).into(),
        };
        let url = self.model.reader.map(|i| self.model.entries[i].url.clone());
        match &self.webview {
            Some(w) => {
                let _ = w.set_bounds(bounds);
                let _ = w.set_visible(true);
                if url != self.web_url {
                    if let Some(u) = &url {
                        let _ = w.load_url(u);
                    }
                }
            }
            None => {
                self.webview = wry::WebViewBuilder::new()
                    .with_url(url.clone().unwrap_or_default())
                    .with_bounds(bounds)
                    .build_as_child(&*self.window)
                    .ok();
            }
        }
        self.web_url = url;
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
        self.hits
            .iter()
            .rev()
            .find(|(r, _)| r.contains(x, y))
            .map(|(_, h)| *h)
    }

    fn exec(&mut self, cmd: Cmd) {
        self.model.exec(cmd);
        if let Some(url) = self.model.browser_request.take() {
            let _ = std::process::Command::new("open").arg(url).spawn();
        }
    }

    fn key(&mut self, event: &winit::event::KeyEvent) -> bool {
        let cmd = self.modifiers.super_key();
        let shift = self.modifiers.shift_key();
        let key = match &event.logical_key {
            WKey::Named(NamedKey::ArrowDown) => Some(Key::Down),
            WKey::Named(NamedKey::ArrowUp) => Some(Key::Up),
            WKey::Named(NamedKey::ArrowLeft) => Some(Key::Left),
            WKey::Named(NamedKey::ArrowRight) => Some(Key::Right),
            WKey::Named(NamedKey::Enter) => Some(Key::Enter),
            WKey::Named(NamedKey::Escape) => Some(Key::Escape),
            WKey::Named(NamedKey::Backspace) => Some(Key::Backspace),
            WKey::Named(NamedKey::PageDown) => Some(Key::PageDown),
            WKey::Named(NamedKey::PageUp) => Some(Key::PageUp),
            WKey::Named(NamedKey::F9) => Some(Key::F(9)),
            WKey::Character(s) => s.chars().next().map(Key::Char),
            _ => None,
        };
        let Some(key) = key else { return false };
        let chord = Chord {
            key,
            cmd,
            shift: shift && (cmd || !matches!(key, Key::Char(_))),
        };
        if let Some(c) = self.registry.lookup(&self.model, &chord) {
            self.exec(c);
            return true;
        }
        if self.model.focus == Focus::Filter && !cmd {
            match key {
                Key::Backspace => self.model.backspace(),
                Key::Left => self.model.caret_left(),
                Key::Right => self.model.caret_right(),
                _ => {
                    if let Some(t) = &event.text
                        && self.model.preedit.is_empty()
                        && !t.chars().any(char::is_control)
                    {
                        self.model.insert(t);
                    } else {
                        return false;
                    }
                }
            }
            return true;
        }
        false
    }

    fn press(&mut self) {
        let (x, y) = self.mouse;
        match self.hit_at(x, y) {
            Some(Hit::Cmd(c)) => self.exec(c),
            Some(Hit::View(v)) => {
                self.model.view = v;
                self.model.reader = None;
                self.model.recompute();
            }
            Some(Hit::Row(row)) => {
                self.model.cursor = row;
                if self.modifiers.super_key() {
                    let url = self.model.entries[self.model.visible[row]].url.clone();
                    let _ = std::process::Command::new("open").arg(url).spawn();
                } else {
                    let i = self.model.visible[row];
                    self.model.open(i);
                }
            }
            Some(Hit::Check(row)) => {
                let i = self.model.visible[row];
                let on = !self.model.selected.contains(&i);
                self.model.paint_select(row, row, on);
                self.drag = Drag::Paint { anchor: row, on };
            }
            Some(Hit::Track(t)) => {
                self.drag = Drag::Track(t);
                self.track(t);
            }
            Some(Hit::Field) => {
                self.model.focus = Focus::Filter;
                self.model.caret = self.model.filter.len();
            }
            None => {}
        }
    }

    fn track(&mut self, t: Rect) {
        let content = self.model.visible.len() as f32 * self.model.row_h;
        let ratio = ((self.mouse.1 - t.y) / t.h).clamp(0.0, 1.0);
        self.model.scroll = ratio * content - self.model.list_h / 2.0;
        self.model.clamp_scroll();
    }

    fn moved(&mut self) -> bool {
        match self.drag {
            Drag::Paint { anchor, on } => {
                if let Some(Hit::Row(row) | Hit::Check(row)) = self.hit_at(self.mouse.0, self.mouse.1) {
                    self.model.paint_select(anchor, row, on);
                    return true;
                }
                false
            }
            Drag::Track(t) => {
                self.track(t);
                true
            }
            Drag::None => {
                let icon = match self.hit_at(self.mouse.0, self.mouse.1) {
                    Some(Hit::Field) => CursorIcon::Text,
                    Some(_) => CursorIcon::Pointer,
                    None => CursorIcon::Default,
                };
                self.window.set_cursor(icon);
                false
            }
        }
    }
}

impl ApplicationHandler for App {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.state.is_some() {
            return;
        }
        let window = Arc::new(
            event_loop
                .create_window(
                    Window::default_attributes()
                        .with_title("Feedreader spike")
                        .with_inner_size(LogicalSize::new(1180.0, 760.0))
                        .with_min_inner_size(LogicalSize::new(420.0, 320.0)),
                )
                .expect("window"),
        );
        let size = window.inner_size();
        let gpu = Gpu::new(Some(window.clone()), (size.width, size.height));
        let mut text = Text::new();
        let metrics = metrics(&mut text, window.scale_factor() as f32, window.inner_size());
        let mut state = State {
            window,
            gpu,
            text,
            model: Model::new(),
            registry: app::registry(),
            hits: Vec::new(),
            webview: None,
            web_url: None,
            metrics,
            mouse: (0.0, 0.0),
            modifiers: ModifiersState::empty(),
            drag: Drag::None,
            frames: Vec::new(),
            ime_on: false,
        };
        state.render();
        self.state = Some(state);
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, _: WindowId, event: WindowEvent) {
        let Some(s) = self.state.as_mut() else { return };
        let redraw = match event {
            WindowEvent::CloseRequested => {
                event_loop.exit();
                false
            }
            WindowEvent::Resized(size) => {
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
            WindowEvent::KeyboardInput { event, .. } if event.state == ElementState::Pressed => {
                s.key(&event)
            }
            WindowEvent::Ime(ime) => match ime {
                Ime::Preedit(text, _) => {
                    s.model.preedit = text;
                    true
                }
                Ime::Commit(text) => {
                    s.model.preedit.clear();
                    s.model.insert(&text);
                    true
                }
                _ => false,
            },
            WindowEvent::CursorMoved { position, .. } => {
                s.mouse = (position.x as f32, position.y as f32);
                s.moved()
            }
            WindowEvent::MouseInput { state: ElementState::Pressed, button: MouseButton::Left, .. } => {
                s.press();
                true
            }
            WindowEvent::MouseInput { state: ElementState::Released, button: MouseButton::Left, .. } => {
                s.drag = Drag::None;
                false
            }
            WindowEvent::MouseWheel { delta, .. } => {
                let dy = match delta {
                    MouseScrollDelta::LineDelta(_, y) => y * s.metrics.cell_h * 3.0,
                    MouseScrollDelta::PixelDelta(p) => p.y as f32,
                };
                if s.model.pane.contains(s.mouse.0, s.mouse.1) {
                    let dx = match delta {
                        MouseScrollDelta::LineDelta(x, _) => x * s.metrics.cell_w * 3.0,
                        MouseScrollDelta::PixelDelta(p) => p.x as f32,
                    };
                    let before = s.model.pane_scroll;
                    s.model.pane_scroll -= if s.model.pane_horizontal && dx != 0.0 { dx } else { dy };
                    s.model.pane_scroll != before
                } else {
                    let before = s.model.scroll;
                    s.model.scroll -= dy;
                    s.model.clamp_scroll();
                    s.model.scroll != before
                }
            }
            _ => false,
        };
        if redraw {
            s.window.request_redraw();
        }
    }
}

fn snapshot(args: &[String]) {
    let get = |name: &str| {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    let out = get("--snapshot").unwrap();
    let (w, h) = get("--size")
        .and_then(|s| s.split_once('x').map(|(a, b)| (a.parse().unwrap(), b.parse().unwrap())))
        .unwrap_or((2360u32, 1520u32));
    let scale: f32 = get("--scale").map(|s| s.parse().unwrap()).unwrap_or(2.0);
    let mut gpu = Gpu::new(None, (w, h));
    let mut text = Text::new();
    let m = metrics(&mut text, scale, PhysicalSize::new(w, h));
    let mut model = Model::new();
    let registry = app::registry();
    let mut quads = Vec::new();
    let paint = |model: &mut Model, text: &mut Text, quads: &mut Vec<gpu::Quad>| {
        let started = Instant::now();
        text.begin_frame();
        let mut scene = Scene::new(text, m, model.lines, LIGHT);
        app::paint(model, &registry, &mut scene, app::FrameStats::default());
        *quads = std::mem::take(&mut scene.quads);
        started.elapsed().as_secs_f32() * 1000.0
    };
    paint(&mut model, &mut text, &mut quads);
    for k in get("--keys").unwrap_or_default().split(' ').filter(|k| !k.is_empty()) {
        let chord = match k {
            "down" => Chord::key(Key::Down),
            "enter" => Chord::key(Key::Enter),
            "esc" => Chord::key(Key::Escape),
            "undo" => Chord::cmd('z'),
            "lines" => Chord::cmd('l'),
            other => Chord::ch(other.chars().next().unwrap()),
        };
        if let Some(c) = registry.lookup(&model, &chord) {
            model.exec(c);
        } else if model.focus == Focus::Filter {
            model.insert(k);
        }
        paint(&mut model, &mut text, &mut quads);
    }
    let cold = paint(&mut model, &mut text, &mut quads);
    let warm = paint(&mut model, &mut text, &mut quads);
    for u in text.uploads.drain(..) {
        gpu.upload(u.x, u.y, u.w, u.h, &u.data);
    }
    let pixels = gpu.snapshot(&quads, LIGHT.bg);
    let file = std::fs::File::create(&out).unwrap();
    let mut enc = png::Encoder::new(std::io::BufWriter::new(file), w, h);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    enc.write_header().unwrap().write_image_data(&pixels).unwrap();
    println!("{out}: {} quads, paint {cold:.2} ms, cached {warm:.2} ms", quads.len());
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--snapshot") {
        snapshot(&args);
        return;
    }
    let event_loop = EventLoop::new().expect("event loop");
    event_loop.set_control_flow(ControlFlow::Wait);
    let mut app = App::default();
    event_loop.run_app(&mut app).expect("run");
}
