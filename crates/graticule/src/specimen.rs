use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::OnceLock;
use std::time::Instant;

use crate::commands::{Chord, Command, Key, Registry};
use crate::field::Field;
use crate::grid::Area;
use crate::images::{Images, Slot};
use crate::proof::{Proofs, Status, Variant, file_name, lines_name, write_png};
use crate::shell::{self, App, Config, Ctx, Cursor, Effect, FrameStats, Offscreen, Painted};
use crate::state::{Id, Scrolling, State};
use crate::ui::{DARK, LIGHT, LineStyle, List, Palette, Scene};

pub type Paint = Box<dyn Fn(&mut Scene<Hit>, Area, &Sandbox)>;

pub struct Sheet {
    pub group: &'static str,
    pub name: &'static str,
    pub paint: Paint,
    pub fills: bool,
}

impl Sheet {
    pub fn new(group: &'static str, name: &'static str, paint: impl Fn(&mut Scene<Hit>, Area, &Sandbox) + 'static) -> Self {
        Self { group, name, paint: Box::new(paint), fills: false }
    }

    pub fn filling(self) -> Self {
        Self { fills: true, ..self }
    }
}

const TALL: i32 = 400;

#[derive(Clone, Debug, PartialEq)]
pub enum Hit {
    Toggle(Id),
    Pick(Id, usize),
    Bump(Id),
    Focus(Id, Option<&'static str>),
    Open(usize),
    Run(Cmd),
}

#[derive(Default)]
pub struct Sandbox {
    on: HashSet<Id>,
    picks: HashMap<Id, usize>,
    bumps: HashMap<Id, u64>,
    fields: HashMap<Id, Field>,
    pub focused: Option<Id>,
}

impl Sandbox {
    pub fn on(&self, id: Id) -> bool {
        self.on.contains(&id)
    }

    pub fn pick(&self, id: Id) -> Option<usize> {
        self.picks.get(&id).copied()
    }

    pub fn bumps(&self, id: Id) -> u64 {
        self.bumps.get(&id).copied().unwrap_or(0)
    }

    pub fn field(&self, id: Id) -> Option<&Field> {
        self.fields.get(&id)
    }

    pub fn is_focused(&self, id: Id) -> bool {
        self.focused == Some(id)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cmd {
    Next,
    Previous,
    Style,
    Appearance,
    Grid,
    Frame,
    Scrolling,
    Blur,
    Approve,
    Diff,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Appearance {
    System,
    Light,
    Dark,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Frame {
    Fit,
    Narrow,
    Wide,
}

impl Frame {
    fn cols(self) -> Option<i32> {
        match self {
            Frame::Fit => None,
            Frame::Narrow => Some(52),
            Frame::Wide => Some(132),
        }
    }
}

pub struct Bench {
    pub title: &'static str,
    pub sheets: Vec<Sheet>,
    pub current: usize,
    pub style: LineStyle,
    pub appearance: Appearance,
    pub grid: bool,
    pub frame: Frame,
    pub scrolling: Scrolling,
    pub sandbox: Sandbox,
    pub proofs: Proofs,
    diff: bool,
    variant: Option<Variant>,
    heights: HashMap<usize, f32>,
    approvals: u32,
    note: Option<String>,
    paint_ms: f32,
}

const STYLES: [LineStyle; 5] = [LineStyle::Light, LineStyle::Heavy, LineStyle::Double, LineStyle::Dotted, LineStyle::Ascii];

impl Bench {
    pub fn new(title: &'static str, sheets: Vec<Sheet>) -> Self {
        Self {
            title,
            sheets,
            current: 0,
            style: LineStyle::Light,
            appearance: Appearance::System,
            grid: false,
            frame: Frame::Fit,
            scrolling: Scrolling::Rows,
            sandbox: Sandbox::default(),
            proofs: Proofs::new(title),
            diff: false,
            variant: None,
            heights: HashMap::new(),
            approvals: 0,
            note: None,
            paint_ms: 0.0,
        }
    }

    fn variant(&self, dark: bool) -> Variant {
        Variant { lines: self.style, dark, cols: self.frame.cols().unwrap_or(100) }
    }

    fn status(&self) -> Option<Status> {
        self.variant.and_then(|v| self.proofs.status(self.current, v))
    }

    pub fn palette(&self, system_dark: bool) -> Palette {
        match self.appearance {
            Appearance::Light => LIGHT,
            Appearance::Dark => DARK,
            Appearance::System if system_dark => DARK,
            Appearance::System => LIGHT,
        }
    }

    pub fn exec(&mut self, cmd: Cmd) {
        match cmd {
            Cmd::Next => self.current = (self.current + 1).min(self.sheets.len().saturating_sub(1)),
            Cmd::Previous => self.current = self.current.saturating_sub(1),
            Cmd::Style => {
                let i = STYLES.iter().position(|s| *s == self.style).unwrap_or(0);
                self.style = STYLES[(i + 1) % STYLES.len()];
            }
            Cmd::Appearance => {
                self.appearance = match self.appearance {
                    Appearance::System => Appearance::Light,
                    Appearance::Light => Appearance::Dark,
                    Appearance::Dark => Appearance::System,
                }
            }
            Cmd::Grid => self.grid = !self.grid,
            Cmd::Frame => {
                self.frame = match self.frame {
                    Frame::Fit => Frame::Narrow,
                    Frame::Narrow => Frame::Wide,
                    Frame::Wide => Frame::Fit,
                }
            }
            Cmd::Scrolling => {
                self.scrolling = match self.scrolling {
                    Scrolling::Rows => Scrolling::Smooth,
                    Scrolling::Smooth => Scrolling::Rows,
                }
            }
            Cmd::Blur => self.sandbox.focused = None,
            Cmd::Approve => {
                if let (Some(v), Some(sheet)) = (self.variant, self.sheets.get(self.current)) {
                    self.note = Some(match self.proofs.approve(self.current, sheet, v) {
                        Ok(path) => format!("approved {}", path.display()),
                        Err(e) => format!("couldn't approve: {e}"),
                    });
                    self.approvals += 1;
                    self.diff = false;
                }
            }
            Cmd::Diff => self.diff = !self.diff,
        }
        if !matches!(cmd, Cmd::Approve | Cmd::Diff) {
            self.diff = false;
            self.note = None;
        }
    }

    pub fn press(&mut self, hit: Option<Hit>) {
        let keep_focus = matches!(hit, Some(Hit::Focus(..)));
        match hit {
            Some(Hit::Toggle(id)) => {
                if !self.sandbox.on.remove(&id) {
                    self.sandbox.on.insert(id);
                }
            }
            Some(Hit::Pick(id, i)) => {
                self.sandbox.picks.insert(id, i);
            }
            Some(Hit::Bump(id)) => *self.sandbox.bumps.entry(id).or_default() += 1,
            Some(Hit::Focus(id, seed)) => {
                self.sandbox.fields.entry(id).or_insert_with(|| seed.map(Field::multiline).unwrap_or_default());
                self.sandbox.focused = Some(id);
            }
            Some(Hit::Open(i)) => self.current = i.min(self.sheets.len().saturating_sub(1)),
            Some(Hit::Run(cmd)) => self.exec(cmd),
            None => {}
        }
        if !keep_focus {
            self.sandbox.focused = None;
        }
    }

    pub fn field(&mut self) -> Option<&mut Field> {
        let id = self.sandbox.focused?;
        self.sandbox.fields.get_mut(&id)
    }

    fn rows(&self) -> Vec<Row> {
        let mut rows = Vec::with_capacity(self.sheets.len() * 2);
        let mut group = "";
        for (i, sheet) in self.sheets.iter().enumerate() {
            if sheet.group != group {
                group = sheet.group;
                rows.push(Row::Group(group));
            }
            rows.push(Row::Sheet(i));
        }
        rows
    }

    pub fn paint(&mut self, s: &mut Scene<Hit>, images: &mut Images) {
        s.state.scrolling = self.scrolling;
        let variant = self.variant(s.palette == DARK);
        self.variant = Some(variant);
        if let Some(sheet) = self.sheets.get(self.current) {
            self.proofs.check(self.current, sheet, variant);
        }
        s.selectable = false;
        let pal = s.palette;
        let mono = s.m.mono();
        let mut screen = s.screen();
        let top = screen.take_top(1);
        let rule = screen.take_top(1);
        let status = screen.take_bottom(1);
        let status_rule = screen.take_bottom(1);
        let mut index = screen.take_left(30);
        let divider = screen.take_left(1);
        let main = screen;

        let title = top.inset(1, 0);
        let w = s.write(title, self.title, s.m.prop(600.0), pal.ink);
        let mut x = title.col + (w / s.m.cell_w).ceil() as i32 + 3;
        let controls: [(Cmd, &str, String); 5] = [
            (Cmd::Style, "lines", lines_name(self.style).into()),
            (Cmd::Appearance, "appearance", format!("{:?}", self.appearance).to_lowercase()),
            (Cmd::Frame, "frame", format!("{:?}", self.frame).to_lowercase()),
            (Cmd::Scrolling, "scrolling", format!("{:?}", self.scrolling).to_lowercase()),
            (Cmd::Grid, "grid", if self.grid { "on".into() } else { "off".into() }),
        ];
        for (cmd, label, value) in controls {
            let text = format!("{label} {value}");
            let cols = text.chars().count() as i32;
            let a = Area::new(x, top.row, cols, 1);
            let r = s.rect(a);
            s.hover(r);
            let lw = s.write(a, label, mono, pal.muted);
            let after = Area::new(x + (lw / s.m.cell_w).round() as i32 + 1, top.row, value.chars().count() as i32, 1);
            s.write(after, &value, mono, pal.ink);
            s.hit(r, Hit::Run(cmd));
            x += cols + 3;
        }
        s.rule(rule);
        s.rule(status_rule);
        s.vrule(divider);

        index.take_left(1);
        let rows = self.rows();
        let cursor = rows.iter().position(|r| *r == Row::Sheet(self.current));
        let current = self.current;
        let sheets = &self.sheets;
        s.list(List { id: Id::new("specimen.index"), count: rows.len(), rows: 1, cursor }, index, |i| i as u64, |s, i, a| match rows[i] {
            Row::Group(g) => {
                s.write(a, &g.to_uppercase(), mono, pal.muted);
            }
            Row::Sheet(n) => {
                let r = s.rect(a);
                if n == current {
                    s.fill(r, pal.cursor);
                } else {
                    s.hover(r);
                }
                s.write(a.at(2, 0, a.cols - 2, 1), sheets[n].name, s.m.prop(if n == current { 600.0 } else { 400.0 }), pal.ink);
                s.hit(r, Hit::Open(n));
            }
        });

        let mut main = main.inset(2, 1);
        let head = main.take_top(1);
        let proof_row = main.take_top(1);
        main.take_top(1);
        if let Some(sheet) = self.sheets.get(self.current) {
            let w = s.write(head, sheet.group, s.m.prop(400.0), pal.muted);
            let after = head.at((w / s.m.cell_w).ceil() as i32 + 1, 0, head.cols, 1);
            s.write(after, &format!("/ {}", sheet.name), s.m.prop(600.0), pal.ink);
            let ms = format!("paint {:.2} ms", self.paint_ms);
            let cols = ms.len() as i32;
            s.write(Area::new(head.right() - cols, head.row, cols, 1), &ms, mono, pal.muted);
            let (proof, ink) = match self.status() {
                Some(Status::Same) => ("matches its proof".to_string(), pal.muted),
                Some(Status::Changed(n)) => (format!("{n} pixels differ from its proof"), pal.warn),
                Some(Status::Missing) | None => ("no proof yet".to_string(), pal.faint),
            };
            let mut x = proof_row.col;
            let w = s.write(Area::new(x, proof_row.row, proof.chars().count() as i32, 1), &proof, mono, ink);
            x += (w / s.m.cell_w).ceil() as i32 + 3;
            let mut actions = vec![(Cmd::Approve, "approve")];
            if matches!(self.status(), Some(Status::Changed(_))) {
                actions.push((Cmd::Diff, if self.diff { "show the sheet" } else { "show what changed" }));
            }
            for (cmd, label) in actions {
                let a = Area::new(x, proof_row.row, label.len() as i32, 1);
                let r = s.rect(a);
                s.hover(r);
                s.write(a, label, mono, pal.link);
                s.hit(r, Hit::Run(cmd));
                x += label.len() as i32 + 3;
            }
            let area = match self.frame.cols() {
                Some(cols) if cols + 2 < main.cols => Area::new(main.col, main.row, cols + 2, main.rows),
                _ => main,
            };
            let inner = if self.frame == Frame::Fit {
                area
            } else {
                s.frame(area);
                area.inset(1, 1)
            };
            s.push_clip(s.rect(inner));
            if self.diff {
                let key = format!("diff:{}:{}", self.approvals, file_name(sheet, variant));
                if images.get(&key).is_none() {
                    images.load(key.clone(), self.proofs.diff_path(sheet, variant));
                }
                if let Some(Slot::Ready { id, width, height }) = images.get(&key) {
                    let k = s.m.scale / 2.0;
                    let r = s.rect(inner);
                    s.image(crate::ui::Rect::new(r.x, r.y, width as f32 * k, height as f32 * k), id);
                }
            } else if sheet.fills {
                let started = Instant::now();
                s.selectable = true;
                (sheet.paint)(s, inner, &self.sandbox);
                s.selectable = false;
                self.paint_ms = started.elapsed().as_secs_f32() * 1000.0;
            } else {
                let height = self.heights.get(&self.current).copied().unwrap_or(0.0);
                let id = Id::new("specimen.sheet").child(self.current as u64);
                let mut measured = 0.0;
                let mut ms = 0.0;
                let sandbox = &self.sandbox;
                s.scroll(id, inner, height, |s, body| {
                    let top = s.rect(body).y;
                    let from = s.quads.len();
                    let started = Instant::now();
                    s.selectable = true;
                    (sheet.paint)(s, Area { rows: TALL, ..body }, sandbox);
                    s.selectable = false;
                    ms = started.elapsed().as_secs_f32() * 1000.0;
                    let bottom = s.quads[from..].iter().map(|q| q.pos[1] + q.size[1]).fold(top, f32::max);
                    measured = (bottom - top + s.m.cell_h).ceil();
                });
                self.paint_ms = ms;
                self.heights.insert(self.current, measured);
            }
            s.pop_clip();
            if self.grid {
                grid(s, inner);
            }
        }

        let keys: Vec<String> = registry()
            .available(self)
            .filter(|c| !c.keys.is_empty())
            .map(|c| format!("{} {}", crate::commands::keys_label(&c.keys), (c.label)(self)))
            .collect();
        let line = self.note.clone().unwrap_or_else(|| keys.join("   "));
        s.write(status.inset(1, 0), &line, mono, pal.muted);
    }
}

fn grid<H>(s: &mut Scene<H>, a: Area) {
    let r = s.rect(a);
    let mut c = s.palette.rule;
    c[3] = 0.35;
    let t = s.m.scale.round().max(1.0);
    for col in 0..=a.cols {
        let x = r.x + col as f32 * s.m.cell_w;
        s.fill(crate::ui::Rect::new(x, r.y, t, r.h), c);
    }
    for row in 0..=a.rows {
        let y = r.y + row as f32 * s.m.cell_h;
        s.fill(crate::ui::Rect::new(r.x, y, r.w, t), c);
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Row {
    Group(&'static str),
    Sheet(usize),
}

fn idle(b: &Bench) -> bool {
    b.sandbox.focused.is_none()
}

pub fn registry() -> &'static Registry<Cmd, Bench> {
    static REGISTRY: OnceLock<Registry<Cmd, Bench>> = OnceLock::new();
    REGISTRY.get_or_init(|| {
        let c = |id, keys: Vec<Chord>, label: fn(&Bench) -> String, available: fn(&Bench) -> bool| Command { id, keys, label, available, rank: 0 };
        Registry {
            commands: vec![
                c(Cmd::Next, vec![Chord::ch('j'), Chord::key(Key::Down)], |_| "next sheet".into(), idle),
                c(Cmd::Previous, vec![Chord::ch('k'), Chord::key(Key::Up)], |_| "previous sheet".into(), idle),
                c(Cmd::Blur, vec![Chord::key(Key::Escape)], |_| "leave the field".into(), |b| !idle(b)),
                c(Cmd::Style, vec![], |_| "next line style".into(), |_| true),
                c(Cmd::Appearance, vec![], |_| "next appearance".into(), |_| true),
                c(Cmd::Frame, vec![], |_| "next frame".into(), |_| true),
                c(Cmd::Scrolling, vec![], |_| "switch scrolling".into(), |_| true),
                c(Cmd::Grid, vec![], |_| "show or hide the grid".into(), |_| true),
                c(Cmd::Approve, vec![], |_| "approve this sheet as its proof".into(), |_| true),
                c(Cmd::Diff, vec![], |_| "show what changed from the proof".into(), |b| matches!(b.status(), Some(Status::Changed(_)))),
            ],
        }
    })
}

struct Runner {
    bench: Bench,
    images: Images,
}

impl App for Runner {
    type Model = Bench;
    type Command = Cmd;
    type Hit = Hit;
    type Wake = ();

    fn model(&self) -> &Bench {
        &self.bench
    }

    fn registry(&self) -> &'static Registry<Cmd, Bench> {
        registry()
    }

    fn exec(&mut self, command: Cmd, _: &State) {
        self.bench.exec(command);
    }

    fn images(&mut self) -> &mut Images {
        &mut self.images
    }

    fn style(&self, system_dark: bool) -> (LineStyle, Palette) {
        (self.bench.style, self.bench.palette(system_dark))
    }

    fn paint(&mut self, scene: &mut Scene<Hit>, _: FrameStats) -> Painted {
        self.bench.paint(scene, &mut self.images);
        Painted::default()
    }

    fn settle(&mut self) -> Vec<Effect> {
        Vec::new()
    }

    fn wake(&mut self, _: (), _: &mut Ctx) -> bool {
        false
    }

    fn field(&mut self) -> Option<&mut Field> {
        self.bench.field()
    }

    fn cursor(&mut self, hit: Option<&Hit>, _: &mut Ctx) -> Cursor {
        match hit {
            Some(Hit::Focus(..)) => Cursor::Text,
            Some(_) => Cursor::Pointer,
            None => Cursor::Default,
        }
    }

    fn press(&mut self, hit: Option<Hit>, _: &mut Ctx) {
        self.bench.press(hit);
    }
}

pub fn main(title: &'static str, sheets: impl Fn() -> Vec<Sheet> + 'static) {
    let args: Vec<String> = std::env::args().collect();
    let arg = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
    let result = if let Some(out) = arg("--snapshot") {
        snapshot(title, sheets(), &args, Path::new(&out))
    } else if let Some(out) = arg("--out") {
        export(title, sheets(), Path::new(&out))
    } else {
        shell::run(
            Config { title, size: (1280.0, 820.0), min_size: (640.0, 400.0), font_size: 13.0, visible: true },
            move |_, _| Ok(Runner { bench: Bench::new(title, sheets()), images: Images::new(|| {}) }),
        )
    };
    if let Err(e) = result {
        eprintln!("{e}");
        std::process::exit(1);
    }
}

fn snapshot(title: &'static str, sheets: Vec<Sheet>, args: &[String], out: &Path) -> Result<(), String> {
    let arg = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
    let (w, h) = arg("--size")
        .and_then(|s| s.split_once('x').and_then(|(w, h)| Some((w.parse().ok()?, h.parse().ok()?))))
        .unwrap_or((1280u32, 820u32));
    let scale: f32 = arg("--scale").and_then(|s| s.parse().ok()).unwrap_or(2.0);
    let mut bench = Bench::new(title, sheets);
    if let Some(name) = arg("--sheet") {
        let name = name.to_lowercase();
        bench.current = bench.sheets.iter().position(|s| s.name.to_lowercase() == name).ok_or(format!("no sheet named {name}"))?;
    }
    if args.iter().any(|a| a == "--dark") {
        bench.appearance = Appearance::Dark;
    }
    if let Some(style) = arg("--lines") {
        bench.style = STYLES.into_iter().find(|s| lines_name(*s) == style).ok_or(format!("no line style {style}"))?;
    }
    if args.iter().any(|a| a == "--grid") {
        bench.grid = true;
    }
    if args.iter().any(|a| a == "--approve")
        && let Some(sheet) = bench.sheets.get(bench.current)
    {
        let v = bench.variant(bench.appearance == Appearance::Dark);
        bench.proofs.approve(bench.current, sheet, v)?;
    }
    let pointer = arg("--pointer").and_then(|s| s.split_once(',').and_then(|(x, y)| Some((x.parse().ok()?, y.parse().ok()?))));
    let mut screen = Offscreen::new(w * scale as u32, h * scale as u32, scale, 13.0);
    let palette = bench.palette(false);
    let drag = arg("--drag").and_then(|s| {
        let n: Vec<f32> = s.split([',', ':']).filter_map(|v| v.parse().ok()).collect();
        (n.len() == 4).then(|| ((n[0] * scale, n[1] * scale), (n[2] * scale, n[3] * scale)))
    });
    let mut images = Images::new(|| {});
    let mut frames = Vec::new();
    for i in 0..3 {
        let (quads, ms) = screen.paint(bench.style, palette, pointer, |s| bench.paint(s, &mut images));
        frames.push((quads, ms));
        if let (0, Some((from, to))) = (i, drag) {
            screen.select(from, to);
        }
    }
    let (quads, ms) = frames.pop().unwrap_or_default();
    if args.iter().any(|a| a == "--access") {
        let frame = crate::access::Frame { title, hits: &screen.hits, runs: &screen.runs, fields: &screen.fields, pictures: &screen.pictures, focused: None };
        for (_, node) in crate::access::tree(frame, &screen.text).nodes {
            println!("{:?} {:?}", node.role(), node.label().or(node.value()).unwrap_or_default());
        }
    }
    let pixels = screen.capture(&quads, palette.bg, &mut images);
    screen.save_png(out, &pixels)?;
    println!("{} paint {ms:.2} ms, sheet {:.2} ms", out.display(), bench.paint_ms);
    Ok(())
}

fn export(title: &'static str, sheets: Vec<Sheet>, dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let mut proofs = Proofs::new(title);
    let mut html = format!("<!doctype html><html><head><meta charset=\"utf-8\"><title>{title}</title><style>{EXPORT_STYLE}</style></head><body><h1>{title}</h1>");
    for (i, sheet) in sheets.iter().enumerate() {
        html.push_str(&format!("<h2>{} / {}</h2><table><tr><th></th><th>light</th><th>dark</th></tr>", sheet.group, sheet.name));
        for lines in STYLES {
            html.push_str(&format!("<tr><th>{}</th>", lines_name(lines)));
            for dark in [false, true] {
                let v = Variant { lines, dark, cols: 100 };
                let render = proofs.render(sheet, v);
                let file = file_name(sheet, v);
                write_png(&dir.join(&file), &render)?;
                let status = match proofs.check(i, sheet, v) {
                    Status::Same => "matches its proof".to_string(),
                    Status::Changed(n) => format!("<b>{n} pixels differ from its proof</b>"),
                    Status::Missing => "no proof".to_string(),
                };
                html.push_str(&format!("<td><a href=\"{file}\"><img src=\"{file}\"></a><br>{:.2} ms, {status}</td>", render.ms));
            }
            html.push_str("</tr>");
        }
        html.push_str("</table>");
        println!("{} / {}", sheet.group, sheet.name);
    }
    html.push_str("</body></html>");
    let index = dir.join("index.html");
    std::fs::write(&index, html).map_err(|e| format!("{}: {e}", index.display()))?;
    println!("{}", index.display());
    Ok(())
}

const EXPORT_STYLE: &str = "body{font:13px/1.5 ui-monospace,monospace;margin:2rem;background:#f9f9f7;color:#1a1a1c}h1,h2{font-size:13px;font-weight:600;letter-spacing:.04em;border-bottom:1px solid #b8b8ba;padding-bottom:.3rem;margin-top:2.5rem}table{border-collapse:collapse}th{font-weight:400;color:#737377;text-align:left;padding:.3rem .6rem;vertical-align:top}td{padding:.3rem .6rem;vertical-align:top;color:#737377}img{width:520px;border:1px solid #b8b8ba;display:block}b{color:#9e6b0d;font-weight:400}";
