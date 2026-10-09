use crate::gpu::Quad;
use crate::text::{Drawn, Face, Text, TextStyle};

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
    pub field: [f32; 4],
}

pub const LIGHT: Palette = Palette {
    bg: [0.976, 0.976, 0.969, 1.0],
    ink: [0.102, 0.102, 0.11, 1.0],
    muted: [0.45, 0.45, 0.47, 1.0],
    faint: [0.62, 0.62, 0.64, 1.0],
    rule: [0.72, 0.72, 0.73, 1.0],
    cursor: [0.905, 0.905, 0.9, 1.0],
    field: [0.935, 0.935, 0.93, 1.0],
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
            pad: [0; 3],
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
        let thumb_y = track.y + (offset / max).clamp(0.0, 1.0) * (track.h - thumb_h);
        let rule = self.palette.rule;
        let ink = self.palette.muted;
        let t = self.hair();
        let mid = (track.x + track.w / 2.0).floor();
        match self.style {
            LineStyle::Ascii => {
                let mono = self.m.mono();
                let mut y = track.y;
                while y + self.m.cell_h <= track.bottom() + 0.5 {
                    let on = y + self.m.cell_h > thumb_y && y < thumb_y + thumb_h;
                    self.text(if on { "#" } else { "." }, mono, track.x, y, None, if on { ink } else { rule });
                    y += self.m.cell_h;
                }
            }
            LineStyle::Light | LineStyle::Dotted => {
                if self.style == LineStyle::Light {
                    self.fill(Rect::new(mid, track.y, t, track.h), rule);
                } else {
                    let mut y = track.y;
                    while y < track.bottom() {
                        self.fill(Rect::new(mid, y.floor(), t, t), rule);
                        y += self.m.cell_h / 4.0;
                    }
                }
                self.fill(Rect::new(mid - t, thumb_y, t * 3.0, thumb_h), ink);
            }
            LineStyle::Heavy => {
                self.fill(Rect::new(mid - t, track.y, t * 3.0, track.h), rule);
                let w = (track.w * 0.5).round();
                self.fill(Rect::new((track.x + (track.w - w) / 2.0).floor(), thumb_y, w, thumb_h), ink);
            }
            LineStyle::Double => {
                self.fill(Rect::new(mid - t * 2.0, track.y, t, track.h), rule);
                self.fill(Rect::new(mid + t, track.y, t, track.h), rule);
                self.fill(Rect::new(mid - t * 2.0, thumb_y, t * 4.0, thumb_h), ink);
            }
        }
    }
}
