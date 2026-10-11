mod actions;
mod controls;
mod values;

pub use actions::Kind;
pub use values::{Tone, Value};

use crate::grid::Area;
use crate::text::TextStyle;
use crate::ui::{LineStyle, Rect, Scene};

impl<H: Clone> Scene<'_, H> {
    pub fn cols(&mut self, text: &str, style: TextStyle) -> i32 {
        let w = self.measure(text, style);
        (w / self.m.cell_w).ceil() as i32
    }

    pub fn shadow(&self) -> f32 {
        (self.m.cell_h * 0.12).round().max(self.hair() * 2.0)
    }

    pub fn outline(&mut self, r: Rect, color: [f32; 4]) {
        let t = self.hair();
        match self.style {
            LineStyle::Heavy => self.border(r, t * 2.0, color),
            LineStyle::Double => {
                self.border(r, t, color);
                let i = t * 2.0;
                self.border(Rect::new(r.x + i, r.y + i, r.w - i * 2.0, r.h - i * 2.0), t, color);
            }
            LineStyle::Dotted => self.dotted(r, color),
            LineStyle::Light | LineStyle::Ascii => self.border(r, t, color),
        }
    }

    pub fn border(&mut self, r: Rect, t: f32, color: [f32; 4]) {
        self.fill(Rect::new(r.x, r.y, r.w, t), color);
        self.fill(Rect::new(r.x, r.bottom() - t, r.w, t), color);
        self.fill(Rect::new(r.x, r.y, t, r.h), color);
        self.fill(Rect::new(r.right() - t, r.y, t, r.h), color);
    }

    pub fn dotted(&mut self, r: Rect, color: [f32; 4]) {
        let t = self.hair();
        let step = t * 3.0;
        let mut x = r.x;
        while x < r.right() - t * 0.5 {
            self.fill(Rect::new(x.floor(), r.y, t, t), color);
            self.fill(Rect::new(x.floor(), r.bottom() - t, t, t), color);
            x += step;
        }
        let mut y = r.y;
        while y < r.bottom() - t * 0.5 {
            self.fill(Rect::new(r.x, y.floor(), t, t), color);
            self.fill(Rect::new(r.right() - t, y.floor(), t, t), color);
            y += step;
        }
    }

    pub fn chip(&self, a: Area) -> Rect {
        let r = self.rect(a);
        let i = (self.m.cell_h * 0.1).round();
        Rect::new(r.x, r.y + i, r.w, r.h - i * 2.0)
    }

    pub fn centered(&mut self, r: Rect, text: &str, style: TextStyle, color: [f32; 4]) {
        let w = self.measure(text, style);
        let x = (r.x + (r.w - w) / 2.0).round();
        let y = (r.y + (r.h - self.m.cell_h) / 2.0).round();
        self.text(text, style, x, y, Some(r.w), color);
    }
}
