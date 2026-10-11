use crate::grid::Area;
use crate::text::{Outline, Paint};
use crate::ui::{LineStyle, Palette, Rect, Scene};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Ink {
    Ink,
    Muted,
    Faint,
    Rule,
    Link,
    Danger,
    Warn,
    Ok,
    Background,
}

#[derive(Debug)]
pub struct Layer {
    pub ink: Ink,
    pub path: &'static str,
    pub stroke: Option<f32>,
    pub even_odd: bool,
}

#[derive(Debug)]
pub struct Picture {
    pub label: &'static str,
    pub width: f32,
    pub height: f32,
    pub layers: &'static [Layer],
}

impl Palette {
    pub fn of(&self, ink: Ink) -> [f32; 4] {
        match ink {
            Ink::Ink => self.ink,
            Ink::Muted => self.muted,
            Ink::Faint => self.faint,
            Ink::Rule => self.rule,
            Ink::Link => self.link,
            Ink::Danger => self.danger,
            Ink::Warn => self.warn,
            Ink::Ok => self.ok,
            Ink::Background => self.bg,
        }
    }
}

impl<H> Scene<'_, H> {
    pub fn picture(&mut self, at: Area, p: &'static Picture) -> Rect {
        let r = self.rect(at);
        self.pictures.push((r, p.label));
        if self.style == LineStyle::Ascii {
            let (mono, muted) = (self.m.mono(), self.palette.muted);
            self.text(&format!("[{}]", p.label), mono, r.x, r.y, Some(r.w), muted);
            return r;
        }
        let scale = (r.w / p.width).min(r.h / p.height);
        let (w, h) = (p.width * scale, p.height * scale);
        let origin = ((r.x + (r.w - w) / 2.0).round(), (r.y + (r.h - h) / 2.0).round());
        let clip = self.clip();
        for (i, layer) in p.layers.iter().enumerate() {
            let key = (p as *const Picture as u64).rotate_left(17) ^ (i as u64) << 48 ^ scale.to_bits() as u64;
            let color = self.palette.of(layer.ink);
            let outline = Outline { path: layer.path, stroke: layer.stroke, even_odd: layer.even_odd, scale };
            self.text.shape(&mut self.quads, key, outline, Paint { origin, limit: None, colors: &[color], clip });
        }
        Rect::new(origin.0, origin.1, w, h)
    }
}

include!(concat!(env!("OUT_DIR"), "/pictures.rs"));
