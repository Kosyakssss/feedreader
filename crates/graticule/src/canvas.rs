use std::hash::{Hash, Hasher};

use swash::zeno::{Command, Point, Stroke, Style};

use crate::grid::Area;
use crate::picture::Ink;
use crate::text::{Data, Outline, Paint};
use crate::ui::{LineStyle, Rect, Scene};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Weight {
    Thin,
    Regular,
    Heavy,
}

#[derive(Clone, Debug, Default)]
pub struct Path {
    commands: Vec<Command>,
}

impl Path {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn move_to(mut self, x: f32, y: f32) -> Self {
        self.commands.push(Command::MoveTo(Point::new(x, y)));
        self
    }

    pub fn line_to(mut self, x: f32, y: f32) -> Self {
        self.commands.push(Command::LineTo(Point::new(x, y)));
        self
    }

    pub fn quad_to(mut self, cx: f32, cy: f32, x: f32, y: f32) -> Self {
        self.commands.push(Command::QuadTo(Point::new(cx, cy), Point::new(x, y)));
        self
    }

    pub fn curve_to(mut self, c1: (f32, f32), c2: (f32, f32), to: (f32, f32)) -> Self {
        self.commands.push(Command::CurveTo(Point::new(c1.0, c1.1), Point::new(c2.0, c2.1), Point::new(to.0, to.1)));
        self
    }

    pub fn close(mut self) -> Self {
        self.commands.push(Command::Close);
        self
    }

    pub fn rect(x: f32, y: f32, w: f32, h: f32) -> Self {
        Self::new().move_to(x, y).line_to(x + w, y).line_to(x + w, y + h).line_to(x, y + h).close()
    }

    pub fn circle(cx: f32, cy: f32, r: f32) -> Self {
        let k = r * 0.552_284_8;
        Self::new()
            .move_to(cx + r, cy)
            .curve_to((cx + r, cy + k), (cx + k, cy + r), (cx, cy + r))
            .curve_to((cx - k, cy + r), (cx - r, cy + k), (cx - r, cy))
            .curve_to((cx - r, cy - k), (cx - k, cy - r), (cx, cy - r))
            .curve_to((cx + k, cy - r), (cx + r, cy - k), (cx + r, cy))
            .close()
    }

    pub fn polyline(points: &[(f32, f32)]) -> Self {
        let mut p = Self::new();
        for (i, (x, y)) in points.iter().enumerate() {
            p = if i == 0 { p.move_to(*x, *y) } else { p.line_to(*x, *y) };
        }
        p
    }

    fn mapped(&self, f: impl Fn(Point) -> Point) -> Vec<Command> {
        self.commands
            .iter()
            .map(|c| match *c {
                Command::MoveTo(p) => Command::MoveTo(f(p)),
                Command::LineTo(p) => Command::LineTo(f(p)),
                Command::QuadTo(a, p) => Command::QuadTo(f(a), f(p)),
                Command::CurveTo(a, b, p) => Command::CurveTo(f(a), f(b), f(p)),
                Command::Close => Command::Close,
            })
            .collect()
    }
}

pub enum Shape {
    Path(Path),
    Dot(f32, f32),
}

pub struct Mark {
    pub shape: Shape,
    pub ink: Ink,
    pub stroke: Option<Weight>,
    pub id: Option<u64>,
}

pub struct Label<'a> {
    pub x: f32,
    pub y: f32,
    pub text: &'a str,
    pub ink: Ink,
}

pub struct Canvas<'a> {
    pub width: f32,
    pub height: f32,
    pub marks: &'a [Mark],
    pub labels: &'a [Label<'a>],
    pub live: bool,
}

fn key(commands: &[Command], stroke: Option<f32>) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    for c in commands {
        let (tag, points) = match *c {
            Command::MoveTo(p) => (0u8, [Some(p), None, None]),
            Command::LineTo(p) => (1, [Some(p), None, None]),
            Command::QuadTo(a, p) => (2, [Some(a), Some(p), None]),
            Command::CurveTo(a, b, p) => (3, [Some(a), Some(b), Some(p)]),
            Command::Close => (4, [None; 3]),
        };
        tag.hash(&mut h);
        for p in points.into_iter().flatten() {
            (p.x.to_bits(), p.y.to_bits()).hash(&mut h);
        }
    }
    stroke.map(f32::to_bits).hash(&mut h);
    h.finish()
}

fn flatten(commands: &[Command]) -> Vec<Vec<Point>> {
    let mut lines: Vec<Vec<Point>> = Vec::new();
    let mut start = Point::new(0.0, 0.0);
    let mut at = start;
    let curve = |lines: &mut Vec<Vec<Point>>, f: &dyn Fn(f32) -> Point| {
        if let Some(line) = lines.last_mut() {
            for i in 1..=12 {
                line.push(f(i as f32 / 12.0));
            }
        }
    };
    for c in commands {
        match *c {
            Command::MoveTo(p) => {
                lines.push(vec![p]);
                start = p;
                at = p;
            }
            Command::LineTo(p) => {
                if let Some(line) = lines.last_mut() {
                    line.push(p);
                }
                at = p;
            }
            Command::QuadTo(c1, p) => {
                let a = at;
                curve(&mut lines, &|t| {
                    let u = 1.0 - t;
                    Point::new(u * u * a.x + 2.0 * u * t * c1.x + t * t * p.x, u * u * a.y + 2.0 * u * t * c1.y + t * t * p.y)
                });
                at = p;
            }
            Command::CurveTo(c1, c2, p) => {
                let a = at;
                curve(&mut lines, &|t| {
                    let u = 1.0 - t;
                    let (b0, b1, b2, b3) = (u * u * u, 3.0 * u * u * t, 3.0 * u * t * t, t * t * t);
                    Point::new(b0 * a.x + b1 * c1.x + b2 * c2.x + b3 * p.x, b0 * a.y + b1 * c1.y + b2 * c2.y + b3 * p.y)
                });
                at = p;
            }
            Command::Close => {
                if let Some(line) = lines.last_mut() {
                    line.push(start);
                }
                at = start;
            }
        }
    }
    lines
}

impl<H: Clone> Scene<'_, H> {
    fn commands(&self, shape: &Shape, sx: f32, sy: f32, dot: f32) -> Vec<Command> {
        match shape {
            Shape::Path(p) => p.mapped(|q| Point::new(q.x * sx, q.y * sy)),
            Shape::Dot(x, y) => Path::circle((x * sx).round(), (y * sy).round(), dot).commands,
        }
    }

    fn weight(&self, w: Weight) -> f32 {
        let t = self.hair();
        match w {
            Weight::Thin => t,
            Weight::Regular => t * 2.0,
            Weight::Heavy => t * 3.0,
        }
    }

    pub fn canvas(&mut self, at: Area, c: Canvas, hit: impl Fn(Option<u64>) -> Option<H>) -> Option<u64> {
        let r = self.rect(at);
        if c.live {
            self.live = true;
        }
        let (sx, sy) = (r.w / c.width.max(1e-6), r.h / c.height.max(1e-6));
        let dot = self.hair() * 3.0;
        let under = self.pointer.filter(|(x, y)| r.contains(*x, *y)).and_then(|(x, y)| {
            c.marks.iter().rev().filter(|m| m.id.is_some()).find_map(|m| {
                let cmds = self.commands(&m.shape, sx, sy, dot);
                let style: Style = match m.stroke {
                    Some(w) => Stroke::new(self.weight(w).max(self.hair() * 4.0)).into(),
                    None => Style::default(),
                };
                let mut test = swash::zeno::HitTest::new(cmds.as_slice());
                test.style(style);
                test.test(Point::new(x - r.x, y - r.y)).then_some(m.id).flatten()
            })
        });
        if self.style == LineStyle::Ascii {
            self.braille(at, &c, under);
        } else {
            let clip = self.clip();
            for m in c.marks {
                let cmds = self.commands(&m.shape, sx, sy, dot);
                let stroke = m.stroke.map(|w| self.weight(w));
                let mut color = self.palette.of(m.ink);
                if under.is_some() && m.id == under {
                    color = self.palette.ink;
                }
                let outline = Outline { path: Data::Commands(&cmds), stroke, even_odd: false, scale: 1.0 };
                self.text.shape(&mut self.quads, key(&cmds, stroke), outline, Paint { origin: (r.x, r.y), limit: None, colors: &[color], clip });
            }
            let mono = self.m.mono();
            for l in c.labels {
                let color = self.palette.of(l.ink);
                self.text(l.text, mono, (r.x + l.x * sx).round(), (r.y + l.y * sy - self.m.cell_h / 2.0).round(), None, color);
            }
        }
        self.sensitive.push(r);
        if let Some(h) = hit(under) {
            self.hit(r, h);
        }
        under
    }

    fn braille(&mut self, at: Area, c: &Canvas, under: Option<u64>) {
        let (cols, rows) = (at.cols.max(0) as usize, at.rows.max(0) as usize);
        let (w, h) = (cols * 2, rows * 4);
        if w == 0 || h == 0 {
            return;
        }
        let mut dots = vec![0u8; w * h];
        let mut inks: Vec<Option<Ink>> = vec![None; cols * rows];
        let (sx, sy) = ((w - 1) as f32 / c.width.max(1e-6), (h - 1) as f32 / c.height.max(1e-6));
        let mut set = |x: f32, y: f32, ink: Ink| {
            let (x, y) = (x.round(), y.round());
            if x < 0.0 || y < 0.0 || x >= w as f32 || y >= h as f32 {
                return;
            }
            let (x, y) = (x as usize, y as usize);
            dots[y * w + x] = 1;
            let cell = &mut inks[(y / 4) * cols + x / 2];
            if ink != Ink::Rule || cell.is_none() {
                *cell = Some(ink);
            }
        };
        for m in c.marks {
            let ink = if under.is_some() && m.id == under { Ink::Ink } else { m.ink };
            match &m.shape {
                Shape::Dot(x, y) => set(x * sx, y * sy, ink),
                Shape::Path(p) if m.stroke.is_some() => {
                    for line in flatten(&p.mapped(|q| Point::new(q.x * sx, q.y * sy))) {
                        for pair in line.windows(2) {
                            let (a, b) = (pair[0], pair[1]);
                            let steps = (b.x - a.x).abs().max((b.y - a.y).abs()).ceil().max(1.0) as usize;
                            for i in 0..=steps {
                                let t = i as f32 / steps as f32;
                                set(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, ink);
                            }
                        }
                    }
                }
                Shape::Path(_) => {}
            }
        }
        const BITS: [[u32; 2]; 4] = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]];
        let mono = self.m.mono();
        for row in 0..rows {
            for col in 0..cols {
                let mut bits = 0;
                for (dy, line) in BITS.iter().enumerate() {
                    for (dx, bit) in line.iter().enumerate() {
                        if dots[(row * 4 + dy) * w + col * 2 + dx] != 0 {
                            bits |= bit;
                        }
                    }
                }
                if bits == 0 {
                    continue;
                }
                let ch = char::from_u32(0x2800 + bits).unwrap_or(' ');
                let color = self.palette.of(inks[row * cols + col].unwrap_or(Ink::Ink));
                let r = self.rect(at.at(col as i32, row as i32, 1, 1));
                self.cell(ch, Rect::new(r.x, r.y, r.w, r.h), color);
            }
        }
        for l in c.labels {
            let col = (l.x / c.width * cols as f32) as i32;
            let row = (l.y / c.height * rows as f32) as i32;
            let n = l.text.chars().count() as i32;
            let color = self.palette.of(l.ink);
            self.write(at.at(col.min(at.cols - n).max(0), row.min(at.rows - 1).max(0), n, 1), l.text, mono, color);
        }
    }

    pub fn sparkline(&mut self, at: Area, values: &[f32], ink: Ink) {
        if values.len() < 2 {
            return;
        }
        let (lo, hi) = values.iter().fold((f32::MAX, f32::MIN), |(lo, hi), v| (lo.min(*v), hi.max(*v)));
        let span = (hi - lo).max(1e-6);
        let n = (values.len() - 1) as f32;
        let points: Vec<(f32, f32)> = values.iter().enumerate().map(|(i, v)| (i as f32 / n * 100.0, 2.0 + (1.0 - (v - lo) / span) * 16.0)).collect();
        let marks = [Mark { shape: Shape::Path(Path::polyline(&points)), ink, stroke: Some(Weight::Regular), id: None }];
        self.canvas(at, Canvas { width: 100.0, height: 20.0, marks: &marks, labels: &[], live: false }, |_| None);
    }
}
