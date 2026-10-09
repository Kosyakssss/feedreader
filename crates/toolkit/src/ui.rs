use crate::gpu::Quad;
use crate::field::Field;
use crate::text::{Drawn, Face, Paint, SpanStyle, Text, TextStyle};

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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LineStyle {
    Ascii,
    Light,
    Heavy,
    Double,
    Dotted,
}

impl LineStyle {
    pub fn next(self) -> Self {
        match self {
            Self::Ascii => Self::Light,
            Self::Light => Self::Heavy,
            Self::Heavy => Self::Double,
            Self::Double => Self::Dotted,
            Self::Dotted => Self::Ascii,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Ascii => "ascii",
            Self::Light => "light",
            Self::Heavy => "heavy",
            Self::Double => "double",
            Self::Dotted => "dotted",
        }
    }
}

#[derive(Clone, Copy)]
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
    pub danger: [f32; 4],
    pub warn: [f32; 4],
}

pub const LIGHT: Palette = Palette {
    bg: [0.976, 0.976, 0.969, 1.0],
    ink: [0.102, 0.102, 0.11, 1.0],
    muted: [0.45, 0.45, 0.47, 1.0],
    faint: [0.62, 0.62, 0.64, 1.0],
    rule: [0.72, 0.72, 0.73, 1.0],
    cursor: [0.905, 0.905, 0.9, 1.0],
    hover: [0.94, 0.94, 0.935, 1.0],
    selection: [0.8, 0.86, 0.97, 1.0],
    field: [0.935, 0.935, 0.93, 1.0],
    link: [0.13, 0.32, 0.66, 1.0],
    danger: [0.72, 0.16, 0.13, 1.0],
    warn: [0.62, 0.42, 0.05, 1.0],
};

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
    pub m: Metrics,
    pub style: LineStyle,
    pub palette: Palette,
    pub hits: Vec<(Rect, H)>,
    pub pointer: Option<(f32, f32)>,
    clips: Vec<[f32; 4]>,
}

impl<'a, H> Scene<'a, H> {
    pub fn new(text: &'a mut Text, m: Metrics, style: LineStyle, palette: Palette) -> Self {
        Self {
            quads: Vec::with_capacity(8192),
            text,
            m,
            style,
            palette,
            hits: Vec::new(),
            pointer: None,
            clips: vec![[0.0, 0.0, m.width, m.height]],
        }
    }

    fn clip(&self) -> [f32; 4] {
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

    pub fn text(
        &mut self,
        s: &str,
        style: TextStyle,
        x: f32,
        y: f32,
        limit: Option<f32>,
        color: [f32; 4],
    ) -> Drawn {
        let clip = self.clip();
        let line = self.m.cell_h;
        self.text
            .draw(&mut self.quads, s, style, line, (x, y), limit, None, color, clip)
    }

    pub fn paragraph(
        &mut self,
        s: &str,
        style: TextStyle,
        line: f32,
        x: f32,
        y: f32,
        width: f32,
        color: [f32; 4],
    ) -> Drawn {
        let clip = self.clip();
        self.text
            .draw(&mut self.quads, s, style, line, (x, y), None, Some(width), color, clip)
    }

    pub fn spans(
        &mut self,
        spans: &[(&str, SpanStyle)],
        size: f32,
        line: f32,
        x: f32,
        y: f32,
        wrap: Option<f32>,
        limit: Option<f32>,
        colors: &[[f32; 4]],
    ) -> Drawn {
        let clip = self.clip();
        self.text.draw_spans(
            &mut self.quads,
            spans,
            size,
            line,
            wrap,
            Paint {
                origin: (x, y),
                limit,
                colors,
                clip,
            },
        )
    }

    pub fn field(&mut self, r: Rect, f: &Field, focused: bool, placeholder: &str) -> Option<Rect> {
        let mono = self.m.mono();
        let pal = self.palette;
        self.fill(r, pal.field);
        if focused {
            let t = self.m.scale.round().max(1.0);
            self.fill(Rect::new(r.x, r.bottom() - t, r.w, t), pal.ink);
        }
        self.push_clip(r);
        let tx = r.x + self.m.cell_w * 0.5;
        let mut caret = None;
        if f.text.is_empty() && f.preedit.is_empty() && !focused {
            self.text(placeholder, mono, tx, r.y, None, pal.faint);
        } else {
            let before = &f.text[..f.caret];
            let bw = self.measure(before, mono);
            let room = r.w - self.m.cell_w * 1.5;
            let shift = (bw - room).max(0.0);
            let x0 = tx - shift;
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
                self.fill(c, pal.ink);
                caret = Some(c);
            }
        }
        self.pop_clip();
        caret
    }

    pub fn measure(&mut self, s: &str, style: TextStyle) -> f32 {
        let line = self.m.cell_h;
        self.text.measure(s, style, line)
    }

    fn hair(&self) -> f32 {
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
        let thumb_w = (track.w * 0.4).round().max(t * 3.0);
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
