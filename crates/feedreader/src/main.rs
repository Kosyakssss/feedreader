mod app;
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
use graticule::commands::{Chord, Key, Registry};
use graticule::images::Images;
use graticule::shell::{Config, Ctx, Effect, FrameStats, Offscreen, Painted, Waker};
use graticule::ui::{DARK, LIGHT, LineStyle, Palette, Scene};

use model::{Focus, Model};

const BASE_SIZE: f32 = 13.0;

#[cfg(feature = "profile")]
#[global_allocator]
static ALLOC: tracy_client::ProfiledAllocator<std::alloc::System> = tracy_client::ProfiledAllocator::new(std::alloc::System, 0);

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
    let mut model = Model::new(graticule::images::Images::new(|| {}));
    wait_for(&rx, &mut model, Duration::from_secs(20), |_, e| matches!(e, Event::Snapshot { .. }));
    (handle, rx, model)
}


fn flush(model: &mut Model, engine: &engine::Handle) {
    app::send_all(model, engine);
    model.effects.clear();
}

fn snapshot(args: &[String]) {
    let get = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
    let out = get("--snapshot").unwrap();
    let (w, h) = get("--size")
        .and_then(|s| s.split_once('x').map(|(a, b)| (a.parse().unwrap(), b.parse().unwrap())))
        .unwrap_or((2360u32, 1520u32));
    let scale: f32 = get("--scale").map(|s| s.parse().unwrap()).unwrap_or(2.0);
    let (handle, rx, mut model) = headless();
    let mut screen = Offscreen::new(w, h, scale, BASE_SIZE);
    let registry = cmds::registry();
    let pointer = get("--pointer").and_then(|p| p.split_once(',').map(|(a, b)| (a.parse().unwrap(), b.parse().unwrap())));
    let mut quads = Vec::new();
    let paint = |model: &mut Model, screen: &mut Offscreen, quads: &mut Vec<graticule::gpu::Quad>| {
        let started = Instant::now();
        model.images.begin_frame();
        let palette = if model.settings.appearance == engine::Appearance::Dark { DARK } else { LIGHT };
        let (painted, _) = screen.paint(model.line_style(), palette, pointer, |scene| {
            view::paint(model, registry, scene, FrameStats::default());
        });
        *quads = painted;
        started.elapsed().as_secs_f32() * 1000.0
    };
    paint(&mut model, &mut screen, &mut quads);
    for k in get("--keys").unwrap_or_default().split(' ').filter(|k| !k.is_empty()) {
        match k {
            "wait" => {
                flush(&mut model, &handle);
                wait_for(&rx, &mut model, Duration::from_secs(15), |_, e| matches!(e, Event::Body(_) | Event::Discovered(..) | Event::FeedAdded(_) | Event::SearchResults(..)));
            }
            "images" => {
                let deadline = Instant::now() + Duration::from_secs(20);
                loop {
                    while let Ok(e) = rx.try_recv() {
                        model.event(e);
                    }
                    paint(&mut model, &mut screen, &mut quads);
                    flush(&mut model, &handle);
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
                        paint(&mut model, &mut screen, &mut quads);
                        continue;
                    }
                    other if other.starts_with("cmd:") => {
                        let name = other.trim_start_matches("cmd:");
                        if let Some(c) = registry.commands.iter().find(|c| format!("{:?}", c.id).eq_ignore_ascii_case(name)) {
                            cmds::exec(&mut model, c.id);
                        }
                        flush(&mut model, &handle);
                        paint(&mut model, &mut screen, &mut quads);
                        continue;
                    }
                    other => Chord::ch(other.chars().next().unwrap()),
                };
                if let Some(c) = registry.lookup(&model, &chord) {
                    cmds::exec(&mut model, c);
                }
            }
        }
        model.effects.clear();
        flush(&mut model, &handle);
        while let Ok(e) = rx.try_recv() {
            model.event(e);
        }
        paint(&mut model, &mut screen, &mut quads);
    }
    let cold = paint(&mut model, &mut screen, &mut quads);
    let warm = paint(&mut model, &mut screen, &mut quads);
    let bg = if model.settings.appearance == engine::Appearance::Dark { DARK.bg } else { LIGHT.bg };
    let pixels = screen.capture(&quads, bg, &mut model.images);
    if let Err(e) = screen.save_png(std::path::Path::new(&out), &pixels) {
        eprintln!("Couldn't write {out}: {e}");
    }
    println!("{out}: {} quads, paint {cold:.2} ms, cached {warm:.2} ms", quads.len());
    if let Some(msg) = &model.message {
        println!("message: {msg}");
    }
}


struct Probe {
    url: String,
    engine: engine::Handle,
    events: Receiver<Event>,
    waker: Waker<app::Wake>,
    extractor: extract::Extractor,
    images: Images,
    done: bool,
}

static NO_COMMANDS: Registry<(), ()> = Registry { commands: Vec::new() };

impl graticule::shell::App for Probe {
    type Model = ();
    type Command = ();
    type Hit = ();
    type Wake = app::Wake;

    fn new(waker: Waker<app::Wake>, _: &mut Ctx) -> Result<Self, String> {
        let args: Vec<String> = std::env::args().collect();
        let url = args.get(2).cloned().unwrap_or_default();
        let (tx, rx) = channel();
        let engine_waker = waker.clone();
        let emit: Arc<dyn Fn(Event) + Send + Sync> = Arc::new(move |e| {
            let _ = tx.send(e);
            engine_waker.wake(app::Wake::Engine);
        });
        let engine = engine::attach(engine::data_dir(), emit, false)?;
        if !args.iter().any(|a| a == "--local") {
            engine.send(Request::UseWebExtractor);
        }
        engine.send(Request::Probe(url.clone()));
        Ok(Probe { url, engine, events: rx, waker, extractor: extract::Extractor::new(), images: Images::new(|| {}), done: false })
    }

    fn model(&self) -> &() {
        &()
    }

    fn registry(&self) -> &'static Registry<(), ()> {
        &NO_COMMANDS
    }

    fn exec(&mut self, _: ()) {}

    fn images(&mut self) -> &mut Images {
        &mut self.images
    }

    fn style(&self, _: bool) -> (LineStyle, Palette) {
        (LineStyle::Light, LIGHT)
    }

    fn paint(&mut self, _: &mut Scene<()>, _: FrameStats) -> Painted {
        Painted::default()
    }

    fn settle(&mut self) -> Vec<Effect> {
        if self.done { vec![Effect::Quit] } else { Vec::new() }
    }

    fn wake(&mut self, wake: app::Wake, cx: &mut Ctx) -> bool {
        let mut out = Vec::new();
        match wake {
            app::Wake::Engine => {
                while let Ok(e) = self.events.try_recv() {
                    match e {
                        Event::Extract { job, url, html } => out.extend(self.extractor.push(cx.window, &self.waker, job, url, html)),
                        Event::Probed(url, r) => {
                            match r {
                                Ok((x, by)) => {
                                    println!("{}\n{url}\nextracted by {}\n", x.title, by.name());
                                    println!("{}", engine::article_text(&x.html, &url));
                                }
                                Err(e) => eprintln!("Couldn't extract {}: {e}", self.url),
                            }
                            self.done = true;
                        }
                        _ => {}
                    }
                }
            }
            app::Wake::ExtractorReady => out.extend(self.extractor.ready()),
            app::Wake::Extracted(body) => out.extend(extract::result(&body)),
            app::Wake::Theme => {}
        }
        for r in out {
            self.engine.send(r);
        }
        true
    }
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
            let config = Config { title: "Feedreader", size: (400.0, 300.0), min_size: (100.0, 100.0), font_size: BASE_SIZE, visible: false };
            if let Err(e) = graticule::shell::run::<Probe>(config) {
                eprintln!("Couldn't extract {url}: {e}");
            }
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
    let config = Config { title: "Feedreader", size: (1180.0, 760.0), min_size: (380.0, 300.0), font_size: BASE_SIZE, visible: true };
    if let Err(e) = graticule::shell::run::<app::Feed>(config) {
        eprintln!("{e}");
        std::process::exit(1);
    }
}
