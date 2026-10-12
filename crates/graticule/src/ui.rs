use std::sync::LazyLock;
use crate::chars::{self, Pen, Shape};
use crate::gpu::Quad;
use crate::field::Field;
use crate::grid::Area;
use crate::state::{Id, Layout, Selected, Spot, State};
use crate::text::{Block, Drawn, Face, Outline, Paint, SpanStyle, Text, TextStyle};

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

impl Rect {
    pub fn new(x: f32, y: f32, w: f32, h: f32) -> Self {
        Self { x, y, w, h }
    }

    pub fn contains(&self, x: f32, y: f32) -> bool {
        x >= self.x && y >= self.y && x < self.x + self.w && y < self.y + self.h
    }

    pub fn right(&self) -> f32 {
        self.x + self.w
    }

    pub fn bottom(&self) -> f32 {
        self.y + self.h
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum LineStyle {
    Ascii,
    Light,
    Heavy,
    Double,
    Dotted,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Palette {
    pub bg: [f32; 4],
    pub ink: [f32; 4],
    pub muted: [f32; 4],
    pub faint: [f32; 4],
    pub rule: [f32; 4],
    pub cursor: [f32; 4],
    pub hover: [f32; 4],
    pub selection: [f32; 4],
    pub field: [f32; 4],
    pub link: [f32; 4],
    pub visited: [f32; 4],
    pub danger: [f32; 4],
    pub warn: [f32; 4],
    pub ok: [f32; 4],
}

pub static LIGHT: LazyLock<Palette> = LazyLock::new(|| Palette {
    bg: oklch(0.98, 0.003, 100.0),
    ink: oklch(0.22, 0.005, 285.0),
    muted: oklch(0.5, 0.008, 285.0),
    faint: oklch(0.6, 0.008, 285.0),
    rule: oklch(0.78, 0.005, 285.0),
    cursor: oklch(0.925, 0.003, 100.0),
    hover: oklch(0.955, 0.003, 100.0),
    selection: oklch(0.92, 0.035, 262.0),
    field: oklch(0.95, 0.003, 100.0),
    link: oklch(0.48, 0.15, 262.0),
    visited: oklch(0.48, 0.15, 305.0),
    danger: oklch(0.48, 0.17, 28.0),
    warn: oklch(0.48, 0.11, 70.0),
    ok: oklch(0.48, 0.12, 150.0),
});

pub static DARK: LazyLock<Palette> = LazyLock::new(|| Palette {
    bg: oklch(0.2, 0.004, 285.0),
    ink: oklch(0.925, 0.004, 100.0),
    muted: oklch(0.7, 0.006, 285.0),
    faint: oklch(0.58, 0.008, 285.0),
    rule: oklch(0.41, 0.007, 285.0),
    cursor: oklch(0.285, 0.007, 285.0),
    hover: oklch(0.25, 0.006, 285.0),
    selection: oklch(0.32, 0.055, 262.0),
    field: oklch(0.25, 0.006, 285.0),
    link: oklch(0.77, 0.11, 260.0),
    visited: oklch(0.77, 0.12, 305.0),
    danger: oklch(0.77, 0.13, 26.0),
    warn: oklch(0.77, 0.12, 80.0),
    ok: oklch(0.77, 0.13, 151.0),
});

fn oklab_to_linear(l: f32, a: f32, b: f32) -> [f32; 3] {
    let l_ = (l + 0.396_337_78 * a + 0.215_803_76 * b).powi(3);
    let m_ = (l - 0.105_561_346 * a - 0.063_854_17 * b).powi(3);
    let s_ = (l - 0.089_484_18 * a - 1.291_485_5 * b).powi(3);
    [
        4.076_741_7 * l_ - 3.307_711_6 * m_ + 0.230_969_94 * s_,
        -1.268_438 * l_ + 2.609_757_4 * m_ - 0.341_319_38 * s_,
        -0.004_196_086_3 * l_ - 0.703_418_6 * m_ + 1.707_614_7 * s_,
    ]
}

pub fn oklch(l: f32, c: f32, h: f32) -> [f32; 4] {
    let (sin, cos) = h.to_radians().sin_cos();
    let mut chroma = c;
    let mut rgb = oklab_to_linear(l, chroma * cos, chroma * sin);
    while chroma > 0.0 && rgb.iter().any(|v| !(-0.0001..=1.0001).contains(v)) {
        chroma = (chroma - 0.002).max(0.0);
        rgb = oklab_to_linear(l, chroma * cos, chroma * sin);
    }
    let encode = |v: f32| {
        let v = v.clamp(0.0, 1.0);
        if v <= 0.003_130_8 { v * 12.92 } else { 1.055 * v.powf(1.0 / 2.4) - 0.055 }
    };
    [encode(rgb[0]), encode(rgb[1]), encode(rgb[2]), 1.0]
}

pub fn to_oklch(c: [f32; 4]) -> (f32, f32, f32) {
    let f = |v: f32| if v <= 0.04045 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) };
    let (r, g, b) = (f(c[0]), f(c[1]), f(c[2]));
    let l = (0.412_221_46 * r + 0.536_332_55 * g + 0.051_445_995 * b).cbrt();
    let m = (0.211_903_5 * r + 0.680_699_5 * g + 0.107_396_96 * b).cbrt();
    let s = (0.088_302_46 * r + 0.281_718_85 * g + 0.629_978_7 * b).cbrt();
    let lightness = 0.210_454_26 * l + 0.793_617_8 * m - 0.004_072_047 * s;
    let a = 1.977_998_5 * l - 2.428_592_2 * m + 0.450_593_7 * s;
    let bb = 0.025_904_037 * l + 0.782_771_77 * m - 0.808_675_77 * s;
    (lightness, a.hypot(bb), bb.atan2(a).to_degrees().rem_euclid(360.0))
}

pub fn contrast(a: [f32; 4], b: [f32; 4]) -> f32 {
    let lum = |c: [f32; 4]| {
        let f = |v: f32| if v <= 0.04045 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) };
        0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2])
    };
    let (x, y) = (lum(a), lum(b));
    (x.max(y) + 0.05) / (x.min(y) + 0.05)
}

#[derive(Clone, Copy, Debug)]
pub struct Metrics {
    pub scale: f32,
    pub size: f32,
    pub cell_w: f32,
    pub cell_h: f32,
    pub width: f32,
    pub height: f32,
}

impl Metrics {
    pub fn cols(&self) -> usize {
        (self.width / self.cell_w).floor() as usize
    }

    pub fn rows(&self) -> usize {
        (self.height / self.cell_h).floor() as usize
    }

    pub fn mono(&self) -> TextStyle {
        TextStyle {
            face: Face::Mono,
            size: self.size,
            weight: 400.0,
        }
    }

    pub fn prop(&self, weight: f32) -> TextStyle {
        TextStyle {
            face: Face::Prop,
            size: self.size,
            weight,
        }
    }
}

pub struct Scene<'a, H> {
    pub quads: Vec<Quad>,
    pub text: &'a mut Text,
    pub state: &'a mut State,
    pub m: Metrics,
    pub style: LineStyle,
    pub palette: Palette,
    pub hits: Vec<(Rect, H)>,
    pub pointer: Option<(f32, f32)>,
    pub focused: Option<Focused>,
    pub fields: Vec<Rect>,
    pub scrollables: Vec<(Rect, Id)>,
    pub tracks: Vec<(Rect, Id)>,
    pub pressed: bool,
    pub selectable: bool,
    pub runs: Vec<Run>,
    pub pictures: Vec<(Rect, &'static str)>,
    pub sensitive: Vec<Rect>,
    pub live: bool,
    shift: (f32, f32),
    clips: Vec<[f32; 4]>,
    pen: Vec<Rect>,
}

#[derive(Clone, Copy, Debug)]
pub struct Run {
    pub key: u64,
    pub selectable: bool,
    pub origin: (f32, f32),
    pub rect: Rect,
    clip: [f32; 4],
    quad: usize,
}

pub fn spot(runs: &[Run], text: &Text, (x, y): (f32, f32), reach: Option<f32>, clicks: u32) -> Option<(Spot, Spot)> {
    let distance = |r: &Run| {
        let dy = if y < r.rect.y { r.rect.y - y } else if y >= r.rect.bottom() { y - r.rect.bottom() + 1.0 } else { 0.0 };
        let dx = if x < r.rect.x { r.rect.x - x } else if x >= r.rect.right() { x - r.rect.right() + 1.0 } else { 0.0 };
        (dy, dx)
    };
    let inside = runs.iter().enumerate().rev().find(|(_, r)| r.selectable && r.rect.contains(x, y));
    let (order, run) = match inside {
        Some(found) => found,
        None => {
            let reach = reach?;
            let near = runs.iter().enumerate().filter(|(_, r)| r.selectable).min_by(|(_, a), (_, b)| distance(a).partial_cmp(&distance(b)).unwrap_or(std::cmp::Ordering::Equal))?;
            if distance(near.1).0 > reach {
                return None;
            }
            near
        }
    };
    let range = text.pick(run.key, x - run.origin.0, y - run.origin.1, clicks)?;
    Some((Spot { key: run.key, order, byte: range.start }, Spot { key: run.key, order, byte: range.end }))
}

pub struct Lines {
    pub h: char,
    pub v: char,
    pub top_left: char,
    pub top_right: char,
    pub bottom_left: char,
    pub bottom_right: char,
}

pub struct List {
    pub id: Id,
    pub count: usize,
    pub rows: i32,
    pub cursor: Option<usize>,
}

#[derive(Clone, Copy, Debug)]
pub struct Focused {
    pub rect: Rect,
    pub origin: (f32, f32),
    pub wrap: Option<f32>,
    pub caret: Rect,
}

impl<'a, H> Scene<'a, H> {
    pub fn new(text: &'a mut Text, state: &'a mut State, m: Metrics, style: LineStyle, palette: Palette) -> Self {
        Self {
            quads: Vec::with_capacity(8192),
            text,
            state,
            m,
            style,
            palette,
            hits: Vec::new(),
            pointer: None,
            focused: None,
            fields: Vec::new(),
            scrollables: Vec::new(),
            tracks: Vec::new(),
            pressed: false,
            selectable: true,
            runs: Vec::new(),
            pictures: Vec::new(),
            sensitive: Vec::new(),
            live: false,
            shift: (0.0, 0.0),
            clips: vec![[0.0, 0.0, m.width, m.height]],
            pen: Vec::new(),
        }
    }

    pub fn lines(&self) -> Lines {
        let (h, v, [top_left, top_right, bottom_left, bottom_right]) = match self.style {
            LineStyle::Ascii => ('-', '|', ['+'; 4]),
            LineStyle::Light => ('─', '│', ['┌', '┐', '└', '┘']),
            LineStyle::Heavy => ('━', '┃', ['┏', '┓', '┗', '┛']),
            LineStyle::Double => ('═', '║', ['╔', '╗', '╚', '╝']),
            LineStyle::Dotted => ('┈', '┊', ['┌', '┐', '└', '┘']),
        };
        Lines { h, v, top_left, top_right, bottom_left, bottom_right }
    }

    pub fn cell(&mut self, c: char, r: Rect, color: [f32; 4]) -> bool {
        let mut pen = Pen { t: self.hair(), rects: std::mem::take(&mut self.pen), alpha: 1.0 };
        pen.rects.clear();
        let drawn = match chars::draw(c, r, &mut pen) {
            None => false,
            Some(Shape::Rects) => {
                let mut color = color;
                color[3] *= pen.alpha;
                for q in &pen.rects {
                    self.fill(*q, color);
                }
                true
            }
            Some(Shape::Path(path, stroke)) => {
                let key = {
                    use std::hash::{Hash, Hasher};
                    let mut h = std::collections::hash_map::DefaultHasher::new();
                    (c, r.w.to_bits(), r.h.to_bits(), pen.t.to_bits()).hash(&mut h);
                    h.finish()
                };
                let clip = self.clip();
                self.text.shape(&mut self.quads, key, Outline { path: crate::text::Data::Svg(&path), stroke, even_odd: false, scale: 1.0 }, Paint { origin: (r.x, r.y), limit: None, colors: &[color], clip });
                true
            }
        };
        self.pen = pen.rects;
        drawn
    }

    pub fn cells(&mut self, a: Area, s: &str, style: TextStyle, color: [f32; 4]) -> f32 {
        let r = self.rect(a);
        self.cells_at((r.x, r.y), a.cols, s, style, color)
    }

    fn cells_at(&mut self, at: (f32, f32), cols: i32, s: &str, style: TextStyle, color: [f32; 4]) -> f32 {
        let r = Rect::new(at.0, at.1, 0.0, 0.0);
        let a = Area::new(0, 0, cols, 1);
        let (cw, ch) = (self.m.cell_w, self.m.cell_h);
        let mut run: Option<(usize, i32)> = None;
        let mut col = 0;
        let mut end = s.len();
        for (i, c) in s.char_indices() {
            if col >= a.cols {
                end = i;
                break;
            }
            if chars::drawn(c) || !c.is_ascii() {
                if let Some((from, at)) = run.take() {
                    self.plain_text(&s[from..i], style, r.x + at as f32 * cw, r.y, None, color);
                }
                let x = r.x + col as f32 * cw;
                if chars::drawn(c) {
                    self.cell(c, Rect::new(x, r.y, cw, ch), color);
                } else {
                    let one = &s[i..i + c.len_utf8()];
                    let w = self.measure(one, style);
                    self.plain_text(one, style, (x + (cw - w) / 2.0).round(), r.y, None, color);
                }
            } else if run.is_none() {
                run = Some((i, col));
            }
            col += 1;
        }
        if let Some((from, at)) = run {
            self.plain_text(&s[from..end], style, r.x + at as f32 * cw, r.y, None, color);
        }
        col as f32 * cw
    }

    pub fn screen(&self) -> Area {
        Area::new(0, 0, self.m.cols() as i32, self.m.rows() as i32)
    }

    pub fn rect(&self, a: Area) -> Rect {
        Rect::new(
            a.col as f32 * self.m.cell_w + self.shift.0,
            a.row as f32 * self.m.cell_h + self.shift.1,
            a.cols.max(0) as f32 * self.m.cell_w,
            a.rows.max(0) as f32 * self.m.cell_h,
        )
    }

    pub fn write(&mut self, a: Area, s: &str, style: TextStyle, color: [f32; 4]) -> f32 {
        if style.face == Face::Mono && s.chars().any(chars::drawn) {
            return self.cells(a, s, style, color);
        }
        let r = self.rect(a);
        self.text(s, style, r.x, r.y, Some(r.w), color).width
    }

    pub fn frame(&mut self, a: Area) {
        if a.cols < 2 || a.rows < 2 {
            return;
        }
        let l = self.lines();
        let (mono, c) = (self.m.mono(), self.palette.rule);
        let inner = (a.cols - 2) as usize;
        let top: String = std::iter::once(l.top_left).chain(std::iter::repeat_n(l.h, inner)).chain(std::iter::once(l.top_right)).collect();
        let bottom: String = std::iter::once(l.bottom_left).chain(std::iter::repeat_n(l.h, inner)).chain(std::iter::once(l.bottom_right)).collect();
        let side = l.v.to_string();
        self.cells(a.line(0), &top, mono, c);
        self.cells(a.line(a.rows - 1), &bottom, mono, c);
        for row in 1..a.rows - 1 {
            self.cells(Area::new(a.col, a.row + row, 1, 1), &side, mono, c);
            self.cells(Area::new(a.right() - 1, a.row + row, 1, 1), &side, mono, c);
        }
    }

    pub fn rule(&mut self, a: Area) {
        let l = self.lines();
        let line: String = std::iter::repeat_n(l.h, a.cols.max(0) as usize).collect();
        let (mono, c) = (self.m.mono(), self.palette.rule);
        self.cells(a.line(0), &line, mono, c);
    }

    pub fn vrule(&mut self, a: Area) {
        let v = self.lines().v.to_string();
        let (mono, c) = (self.m.mono(), self.palette.rule);
        for row in 0..a.rows {
            self.cells(Area::new(a.col, a.row + row, 1, 1), &v, mono, c);
        }
    }

    pub fn foreign<G>(&mut self, f: impl FnOnce(&mut Scene<G>)) {
        let clip = self.clip();
        let mut sub = Scene::new(&mut *self.text, &mut *self.state, self.m, self.style, self.palette);
        sub.clips = vec![clip];
        sub.shift = self.shift;
        f(&mut sub);
        let quads = std::mem::take(&mut sub.quads);
        drop(sub);
        self.quads.extend(quads);
    }

    pub fn list(&mut self, list: List, area: Area, key: impl Fn(usize) -> u64, mut item: impl FnMut(&mut Self, usize, Area)) {
        let mut body = area;
        let bar = body.take_right(2);
        let rect = self.rect(body);
        let step = self.state.step(self.m.cell_h);
        let height = list.rows.max(1) as f32 * self.m.cell_h;
        let s = self.state.scroll_mut(list.id);
        s.layout(Layout { count: list.count, item: height, view: rect.h, cursor: list.cursor, step }, &key);
        let s = *s;
        self.scrollables.push((rect, list.id));
        self.push_clip(rect);
        let shift = self.shift;
        self.shift.1 -= s.offset;
        for i in s.visible() {
            let a = Area::new(body.col, body.row + (i - s.top) as i32 * list.rows.max(1), body.cols, list.rows.max(1));
            item(self, i, a);
        }
        self.shift = shift;
        self.pop_clip();
        let track = self.rect(bar);
        self.scrollbar(track, s.total(), s.content());
        self.tracks.push((track, list.id));
    }

    pub fn scroll(&mut self, id: Id, area: Area, content: f32, f: impl FnOnce(&mut Self, Area)) {
        let mut body = area;
        let bar = body.take_right(2);
        let rect = self.rect(body);
        let s = self.state.scroll_mut(id);
        s.item = content.max(0.0);
        s.count = 1;
        s.view = rect.h;
        s.set_total(s.total());
        let s = *s;
        self.scrollables.push((rect, id));
        self.push_clip(rect);
        let shift = self.shift;
        self.shift.1 -= s.total();
        f(self, body);
        self.shift = shift;
        self.pop_clip();
        let track = self.rect(bar);
        self.scrollbar(track, s.total(), s.content());
        self.tracks.push((track, id));
    }

    pub fn clip(&self) -> [f32; 4] {
        *self.clips.last().unwrap()
    }

    pub fn push_clip(&mut self, r: Rect) {
        let c = self.clip();
        self.clips.push([
            c[0].max(r.x),
            c[1].max(r.y),
            c[2].min(r.right()),
            c[3].min(r.bottom()),
        ]);
    }

    pub fn pop_clip(&mut self) {
        self.clips.pop();
    }

    pub fn hovered(&self, r: Rect) -> bool {
        let c = self.clip();
        self.pointer.is_some_and(|(x, y)| r.contains(x, y) && x >= c[0] && y >= c[1] && x < c[2] && y < c[3])
    }

    pub fn hover(&mut self, r: Rect) -> bool {
        let on = self.hovered(r);
        if on {
            let color = self.palette.hover;
            self.fill(r, color);
        }
        on
    }

    pub fn hit(&mut self, r: Rect, h: H) {
        self.hits.push((r, h));
    }

    pub fn fill(&mut self, r: Rect, color: [f32; 4]) {
        self.quads.push(Quad {
            pos: [r.x, r.y],
            size: [r.w, r.h],
            uv: [0.0; 4],
            color,
            clip: self.clip(),
            kind: 0,
            image: 0,
                pad: [0; 2],
        });
    }

    pub fn image(&mut self, r: Rect, id: u32) {
        self.quads.push(Quad {
            pos: [r.x, r.y],
            size: [r.w, r.h],
            uv: [0.0, 0.0, 1.0, 1.0],
            color: [1.0, 1.0, 1.0, 1.0],
            clip: self.clip(),
            kind: 2,
            image: id,
            pad: [0; 2],
        });
    }

    pub fn text(&mut self, s: &str, style: TextStyle, x: f32, y: f32, limit: Option<f32>, color: [f32; 4]) -> Drawn {
        if style.face == Face::Mono && s.chars().any(chars::drawn) {
            let cols = limit.map_or(i32::MAX, |l| (l / self.m.cell_w).floor() as i32);
            let width = self.cells_at((x, y), cols, s, style, color);
            return Drawn { key: 0, width, height: self.m.cell_h, underlines: Vec::new() };
        }
        self.plain_text(s, style, x, y, limit, color)
    }

    fn plain_text(&mut self, s: &str, style: TextStyle, x: f32, y: f32, limit: Option<f32>, color: [f32; 4]) -> Drawn {
        let span = SpanStyle { weight: style.weight as u16, ..SpanStyle::plain(style.face) };
        let line = self.m.cell_h;
        self.spans(Block { spans: &[(s, span)], size: style.size, line, wrap: None }, (x, y), limit, &[color])
    }

    pub fn paragraph(&mut self, s: &str, style: TextStyle, line: f32, at: (f32, f32), width: f32, color: [f32; 4]) -> Drawn {
        let span = SpanStyle { weight: style.weight as u16, ..SpanStyle::plain(style.face) };
        self.spans(Block { spans: &[(s, span)], size: style.size, line, wrap: Some(width) }, at, None, &[color])
    }

    pub fn spans(&mut self, block: Block, at: (f32, f32), limit: Option<f32>, colors: &[[f32; 4]]) -> Drawn {
        let clip = self.clip();
        let quad = self.quads.len();
        let drawn = self.text.draw_spans(&mut self.quads, block, Paint { origin: at, limit, colors, clip });
        let x0 = at.0.max(clip[0]);
        let y0 = at.1.max(clip[1]);
        let x1 = (at.0 + drawn.width).min(clip[2]);
        let y1 = (at.1 + drawn.height).min(clip[3]);
        if x1 > x0 && y1 > y0 {
            let selectable = self.selectable;
            self.runs.push(Run { key: drawn.key, selectable, origin: at, rect: Rect::new(x0, y0, x1 - x0, y1 - y0), clip, quad });
        }
        drawn
    }

    fn find_run(&self, spot: Spot) -> Option<usize> {
        self.runs.iter().enumerate().filter(|(_, r)| r.selectable && r.key == spot.key).min_by_key(|(i, _)| i.abs_diff(spot.order)).map(|(i, _)| i)
    }

    pub fn finish(&mut self) {
        let Some(sel) = self.state.selection else { return };
        let (Some(a), Some(f)) = (self.find_run(sel.anchor), self.find_run(sel.focus)) else {
            self.state.selection = None;
            return;
        };
        let sel = Selected { anchor: Spot { order: a, ..sel.anchor }, focus: Spot { order: f, ..sel.focus } };
        self.state.selection = Some(sel);
        if sel.is_empty() {
            return;
        }
        let (start, end) = sel.ordered();
        let color = self.palette.selection;
        for i in (start.order..=end.order).rev() {
            let run = self.runs[i];
            if !run.selectable {
                continue;
            }
            let len = self.text.source(run.key).map_or(0, str::len);
            let from = if i == start.order { start.byte } else { 0 };
            let to = if i == end.order { end.byte } else { len };
            let quads: Vec<Quad> = self
                .text
                .rects_in(run.key, from..to)
                .into_iter()
                .map(|q| Quad {
                    pos: [run.origin.0 + q[0], run.origin.1 + q[1]],
                    size: [q[2].max(1.0), q[3]],
                    uv: [0.0; 4],
                    color,
                    clip: run.clip,
                    kind: 0,
                    image: 0,
                    pad: [0; 2],
                })
                .collect();
            self.quads.splice(run.quad..run.quad, quads);
        }
    }

    pub fn field(&mut self, r: Rect, f: &Field, focused: bool, placeholder: &str) {
        let selectable = std::mem::replace(&mut self.selectable, false);
        self.paint_field(r, f, focused, placeholder);
        self.selectable = selectable;
    }

    fn paint_field(&mut self, r: Rect, f: &Field, focused: bool, placeholder: &str) {
        let mono = self.m.mono();
        let pal = self.palette;
        self.fill(r, pal.field);
        self.fields.push(r);
        self.push_clip(r);
        let tx = r.x + self.m.cell_w * 0.5;
        if f.text.is_empty() && f.preedit.is_empty() && !focused {
            self.text(placeholder, mono, tx, r.y, None, pal.faint);
        } else {
            let before = &f.text[..f.caret];
            let bw = self.measure(before, mono);
            let room = r.w - self.m.cell_w * 1.5;
            let shift = (bw - room).max(0.0);
            let x0 = tx - shift;
            let sel = f.selection();
            if focused && !sel.is_empty() && f.preedit.is_empty() {
                let sx = x0 + self.measure(&f.text[..sel.start], mono);
                let ex = x0 + self.measure(&f.text[..sel.end], mono);
                self.fill(Rect::new(sx, r.y, ex - sx, r.h), pal.selection);
            }
            self.text(before, mono, x0, r.y, None, pal.ink);
            let mut cx = x0 + bw;
            if !f.preedit.is_empty() {
                let pw = self.text(&f.preedit, mono, cx, r.y, None, pal.ink).width;
                let t = self.m.scale.round().max(1.0);
                self.fill(Rect::new(cx, r.y + self.m.cell_h * 0.85, pw, t), pal.ink);
                cx += pw;
            }
            self.text(&f.text[f.caret..], mono, cx, r.y, None, pal.ink);
            if focused {
                let c = Rect::new(cx.floor(), r.y + self.m.cell_h * 0.15, (self.m.scale * 2.0).round().max(1.0), self.m.cell_h * 0.7);
                if sel.is_empty() {
                    self.fill(c, pal.ink);
                }
                self.focused = Some(Focused { rect: r, origin: (x0, r.y), wrap: None, caret: c });
            }
        }
        self.pop_clip();
        if focused {
            let t = self.hair();
            self.fill(Rect::new(r.x, r.bottom() - t, r.w, t), pal.ink);
        }
    }

    pub fn text_area(&mut self, id: Id, r: Rect, f: &Field, focused: bool, placeholder: &str) {
        let selectable = std::mem::replace(&mut self.selectable, false);
        self.paint_text_area(id, r, f, focused, placeholder);
        self.selectable = selectable;
    }

    fn paint_text_area(&mut self, id: Id, r: Rect, f: &Field, focused: bool, placeholder: &str) {
        let pal = self.palette;
        let mono = self.m.mono();
        let (size, line) = (mono.size, self.m.cell_h);
        let pad = self.m.cell_w * 0.5;
        let wrap = (r.w - pad * 2.0).max(self.m.cell_w);
        self.fill(r, pal.field);
        self.fields.push(r);
        self.scrollables.push((r, id));
        let composing = !f.preedit.is_empty();
        let shown = if composing { format!("{}{}{}", &f.text[..f.caret], f.preedit, &f.text[f.caret..]) } else { String::new() };
        let text = if composing { shown.as_str() } else { f.text.as_str() };
        let span = SpanStyle::plain(Face::Mono);
        let spans = [(text, span)];
        let content = self.text.height(&spans, size, line, wrap).max(line);
        let caret_at = f.caret + f.preedit.len();
        let c = self.text.caret(&spans, size, line, wrap, caret_at);
        let s = self.state.scroll_mut(id);
        s.item = content;
        s.count = 1;
        s.view = r.h;
        if focused {
            let total = s.total();
            if c[1] < total {
                s.set_total(c[1]);
            } else if c[1] + line > total + r.h {
                s.set_total(c[1] + line - r.h);
            }
        }
        s.set_total(s.total());
        let scroll = s.total();
        let origin = (r.x + pad, r.y - scroll);
        self.push_clip(r);
        if text.is_empty() && !focused {
            self.text(placeholder, mono, origin.0, origin.1, None, pal.faint);
        } else {
            let sel = f.selection();
            if focused && !sel.is_empty() && !composing {
                for q in self.text.range_rects(&spans, size, line, wrap, sel) {
                    self.fill(Rect::new(origin.0 + q[0], origin.1 + q[1], q[2].max(self.m.cell_w * 0.5), q[3]), pal.selection);
                }
            }
            if composing {
                let t = self.hair();
                for q in self.text.range_rects(&spans, size, line, wrap, f.caret..caret_at) {
                    self.fill(Rect::new(origin.0 + q[0], origin.1 + q[1] + line * 0.85, q[2], t), pal.ink);
                }
            }
            self.spans(Block { spans: &spans, size, line, wrap: Some(wrap) }, origin, None, &[pal.ink]);
        }
        if focused {
            let caret = Rect::new((origin.0 + c[0]).floor(), origin.1 + c[1] + line * 0.15, (self.m.scale * 2.0).round().max(1.0), line * 0.7);
            if f.selection().is_empty() {
                self.fill(caret, pal.ink);
            }
            self.focused = Some(Focused { rect: r, origin, wrap: Some(wrap), caret });
        }
        self.pop_clip();
        if focused {
            let t = self.hair();
            self.fill(Rect::new(r.x, r.bottom() - t, r.w, t), pal.ink);
        }
    }

    pub fn measure(&mut self, s: &str, style: TextStyle) -> f32 {
        let line = self.m.cell_h;
        self.text.measure(s, style, line)
    }

    pub fn hair(&self) -> f32 {
        self.m.scale.round().max(1.0)
    }

    pub fn hline(&mut self, y: f32, x0: f32, x1: f32) {
        let c = self.palette.rule;
        let mid = (y + self.m.cell_h / 2.0).floor();
        let t = self.hair();
        match self.style {
            LineStyle::Ascii => {
                let mono = self.m.mono();
                let mut x = x0;
                while x + self.m.cell_w <= x1 + 0.5 {
                    self.text("-", mono, x, y, None, c);
                    x += self.m.cell_w;
                }
            }
            LineStyle::Light => self.fill(Rect::new(x0, mid, x1 - x0, t), c),
            LineStyle::Heavy => self.fill(Rect::new(x0, mid - t, x1 - x0, t * 3.0), c),
            LineStyle::Double => {
                self.fill(Rect::new(x0, mid - t * 2.0, x1 - x0, t), c);
                self.fill(Rect::new(x0, mid + t, x1 - x0, t), c);
            }
            LineStyle::Dotted => {
                let step = self.m.cell_w / 2.0;
                let mut x = x0;
                while x < x1 {
                    self.fill(Rect::new(x.floor(), mid, t, t), c);
                    x += step;
                }
            }
        }
    }

    pub fn vline(&mut self, x: f32, y0: f32, y1: f32) {
        let c = self.palette.rule;
        let mid = (x + self.m.cell_w / 2.0).floor();
        let t = self.hair();
        match self.style {
            LineStyle::Ascii => {
                let mono = self.m.mono();
                let mut y = y0;
                while y + self.m.cell_h <= y1 + 0.5 {
                    self.text("|", mono, x, y, None, c);
                    y += self.m.cell_h;
                }
            }
            LineStyle::Light => self.fill(Rect::new(mid, y0, t, y1 - y0), c),
            LineStyle::Heavy => self.fill(Rect::new(mid - t, y0, t * 3.0, y1 - y0), c),
            LineStyle::Double => {
                self.fill(Rect::new(mid - t * 2.0, y0, t, y1 - y0), c);
                self.fill(Rect::new(mid + t, y0, t, y1 - y0), c);
            }
            LineStyle::Dotted => {
                let step = self.m.cell_h / 4.0;
                let mut y = y0;
                while y < y1 {
                    self.fill(Rect::new(mid, y.floor(), t, t), c);
                    y += step;
                }
            }
        }
    }

    pub fn checkbox(&mut self, x: f32, y: f32, on: bool) {
        let ink = self.palette.ink;
        let rule = self.palette.muted;
        if self.style == LineStyle::Ascii {
            let mono = self.m.mono();
            self.text(if on { "[x]" } else { "[ ]" }, mono, x, y, None, if on { ink } else { rule });
            return;
        }
        let t = self.hair();
        let side = (self.m.cell_h * 0.55).round();
        let bx = (x + (self.m.cell_w * 3.0 - side) / 2.0).floor();
        let by = (y + (self.m.cell_h - side) / 2.0).floor();
        let edge = match self.style {
            LineStyle::Heavy => t * 2.0,
            _ => t,
        };
        let frame = if on { ink } else { rule };
        self.fill(Rect::new(bx, by, side, edge), frame);
        self.fill(Rect::new(bx, by + side - edge, side, edge), frame);
        self.fill(Rect::new(bx, by, edge, side), frame);
        self.fill(Rect::new(bx + side - edge, by, edge, side), frame);
        if self.style == LineStyle::Double {
            let i = edge * 2.0;
            self.fill(Rect::new(bx + i, by + i, side - i * 2.0, edge), frame);
            self.fill(Rect::new(bx + i, by + side - i - edge, side - i * 2.0, edge), frame);
            self.fill(Rect::new(bx + i, by + i, edge, side - i * 2.0), frame);
            self.fill(Rect::new(bx + side - i - edge, by + i, edge, side - i * 2.0), frame);
        }
        if on {
            let inset = (side * 0.25).round();
            self.fill(
                Rect::new(bx + inset, by + inset, side - inset * 2.0, side - inset * 2.0),
                ink,
            );
        }
    }

    pub fn scrollbar(&mut self, track: Rect, offset: f32, content: f32) {
        let view = track.h;
        let thumb_h = if content <= view {
            track.h
        } else {
            (view / content * track.h).max(self.m.cell_h)
        };
        let max = (content - view).max(1.0);
        let thumb_y = (track.y + (offset / max).clamp(0.0, 1.0) * (track.h - thumb_h)).round();
        let rule = self.palette.rule;
        let ink = if self.hovered(track) { self.palette.ink } else { self.palette.muted };
        let t = self.hair();
        let mid = (track.x + track.w / 2.0).floor();
        if content <= view {
            return;
        }
        let thumb_w = if self.style == LineStyle::Heavy { t * 5.0 } else { t * 3.0 };
        let thumb_x = (track.x + (track.w - thumb_w) / 2.0).round();
        match self.style {
            LineStyle::Ascii => {
                let mono = self.m.mono();
                let mut y = track.y;
                while y + self.m.cell_h <= track.bottom() + 0.5 {
                    let on = y + self.m.cell_h > thumb_y && y < thumb_y + thumb_h;
                    let x = track.x + (track.w - self.m.cell_w * 2.0) / 2.0;
                    self.text(if on { "##" } else { ".." }, mono, x, y, None, if on { ink } else { rule });
                    y += self.m.cell_h;
                }
            }
            LineStyle::Light => {
                self.fill(Rect::new(mid, track.y, t, track.h), rule);
                self.fill(Rect::new(thumb_x, thumb_y, thumb_w, thumb_h), ink);
            }
            LineStyle::Dotted => {
                let mut y = track.y;
                while y < track.bottom() {
                    self.fill(Rect::new(mid, y.floor(), t, t), rule);
                    y += self.m.cell_h / 4.0;
                }
                self.fill(Rect::new(thumb_x, thumb_y, thumb_w, thumb_h), ink);
            }
            LineStyle::Heavy => {
                self.fill(Rect::new(mid - t, track.y, t * 3.0, track.h), rule);
                self.fill(Rect::new(thumb_x, thumb_y, thumb_w, thumb_h), ink);
            }
            LineStyle::Double => {
                self.fill(Rect::new(thumb_x - t * 2.0, track.y, t, track.h), rule);
                self.fill(Rect::new(thumb_x + thumb_w + t, track.y, t, track.h), rule);
                self.fill(Rect::new(thumb_x, thumb_y, thumb_w, thumb_h), ink);
            }
        }
    }
}
