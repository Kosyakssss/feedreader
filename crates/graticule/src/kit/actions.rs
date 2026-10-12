use crate::commands::Chord;
use crate::grid::Area;
use crate::ui::{LineStyle, Rect, Scene};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Normal,
    Primary,
    Danger,
}

impl<H: Clone> Scene<'_, H> {
    pub fn button(&mut self, at: Area, label: &str, kind: Kind, hit: Option<H>) -> i32 {
        let pal = self.palette;
        let mono = self.m.mono();
        let cols = label.chars().count() as i32 + 3;
        let a = at.at(0, 0, cols, 1);
        let outer = self.rect(a);
        if self.style == LineStyle::Ascii {
            let ink = if hit.is_none() { pal.faint } else if kind == Kind::Danger { pal.danger } else { pal.ink };
            if hit.is_some() && self.hovered(outer) {
                self.fill(outer, pal.hover);
            }
            self.write(a, &format!("[ {label} ]"), mono, ink);
            if let Some(h) = hit {
                self.hit(outer, h);
            }
            return cols + 1;
        }
        let d = self.shadow();
        let i = (d / 2.0).round();
        let body = Rect::new(outer.x, outer.y + i, outer.w - d, outer.h - i * 2.0 - d);
        let hovered = hit.is_some() && self.hovered(outer);
        let pressed = hovered && self.pressed;
        let r = if pressed { Rect::new(body.x + d, body.y + d, body.w, body.h) } else { body };
        let (edge, fill, ink) = match (hit.is_some(), kind) {
            (false, _) => (pal.rule, pal.bg, pal.faint),
            (true, Kind::Normal) => (pal.ink, if hovered { pal.hover } else { pal.bg }, pal.ink),
            (true, Kind::Primary) => (pal.ink, pal.ink, pal.bg),
            (true, Kind::Danger) => (pal.danger, if hovered { pal.hover } else { pal.bg }, pal.danger),
        };
        if hit.is_some() && !pressed {
            self.fill(Rect::new(body.x + d, body.y + d, body.w, body.h), edge);
        }
        self.fill(r, fill);
        self.outline(r, edge);
        self.centered(r, label, mono, ink);
        if let Some(h) = hit {
            self.hit(outer, h);
        }
        cols + 1
    }

    pub fn key_label(&mut self, at: Area, chord: &Chord) -> i32 {
        let label = chord.label();
        let pal = self.palette;
        let cols = label.chars().count() as i32 + 1;
        let a = at.at(0, 0, cols, 1);
        let r = self.chip(a);
        self.fill(r, pal.field);
        let t = self.hair();
        self.border(r, t, pal.rule);
        let mono = self.m.mono();
        let y = (r.y + (r.h - self.m.cell_h) / 2.0).round();
        self.text(&label, mono, (r.x + self.m.cell_w / 2.0).round(), y, Some(r.w), pal.ink);
        cols
    }

    pub fn link(&mut self, at: Area, label: &str, hit: Option<H>) -> i32 {
        let pal = self.palette;
        let style = self.m.prop(400.0);
        let cols = self.cols(label, style).min(at.cols);
        let a = at.at(0, 0, cols, 1);
        let r = self.rect(a);
        let hovered = hit.is_some() && self.hovered(r);
        let pressed = hovered && self.pressed;
        let ink = match (hit.is_some(), pressed) {
            (false, _) => pal.faint,
            (true, true) => pal.visited,
            (true, false) => pal.link,
        };
        if hovered {
            self.fill(r, pal.hover);
        }
        self.write(a, label, style, ink);
        if hit.is_some() {
            let t = if hovered { self.hair() * 2.0 } else { self.hair() };
            let y = (r.y + self.m.cell_h * 0.82).round();
            let w = self.measure(label, style).min(r.w);
            self.fill(Rect::new(r.x, y, w, t), ink);
        }
        if let Some(h) = hit {
            self.hit(r, h);
        }
        cols
    }

    pub fn action(&mut self, at: Area, keys: &[Chord], label: &str, hit: Option<H>) -> i32 {
        let pal = self.palette;
        let keys = &keys[..keys.len().min(2)];
        let key_cols: i32 = keys.iter().map(|k| k.label().chars().count() as i32 + 2).sum();
        let style = self.m.prop(400.0);
        let cols = self.cols(label, style).min((at.cols - key_cols).max(0));
        let whole = at.at(0, 0, key_cols + cols, 1);
        let r = self.rect(whole);
        let enabled = hit.is_some();
        if enabled && self.hovered(r) {
            self.fill(r, pal.hover);
        }
        let mut col = 0;
        for k in keys {
            col += self.key_label(at.at(col, 0, at.cols - col, 1), k) + 1;
        }
        self.write(at.at(col, 0, cols, 1), label, style, if enabled { pal.ink } else { pal.faint });
        if let Some(h) = hit {
            self.hit(r, h);
        }
        key_cols + cols
    }
}
