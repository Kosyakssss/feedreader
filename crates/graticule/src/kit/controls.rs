use crate::grid::Area;
use crate::ui::{LineStyle, Rect, Scene};

impl<H: Clone> Scene<'_, H> {
    fn labelled(&mut self, at: Area, lead: i32, label: &str, enabled: bool, hit: Option<H>) -> (Rect, i32) {
        let style = self.m.prop(400.0);
        let cols = lead + 1 + self.cols(label, style);
        let a = at.at(0, 0, cols.min(at.cols), 1);
        let r = self.rect(a);
        if hit.is_some() && self.hovered(r) {
            let hover = self.palette.hover;
            self.fill(r, hover);
        }
        let ink = if enabled { self.palette.ink } else { self.palette.faint };
        self.write(at.at(lead + 1, 0, at.cols - lead - 1, 1), label, style, ink);
        if let Some(h) = hit {
            self.hit(r, h);
        }
        (self.rect(at.at(0, 0, lead, 1)), cols)
    }

    pub fn check(&mut self, at: Area, label: &str, on: bool, hit: Option<H>) -> i32 {
        let enabled = hit.is_some();
        let (lead, cols) = self.labelled(at, 3, label, enabled, hit);
        self.checkbox(lead.x, lead.y, on);
        cols
    }

    pub fn radio(&mut self, at: Area, label: &str, on: bool, hit: Option<H>) -> i32 {
        let enabled = hit.is_some();
        let (lead, cols) = self.labelled(at, 3, label, enabled, hit);
        let pal = self.palette;
        let ink = if on { pal.ink } else { pal.muted };
        if self.style == LineStyle::Ascii {
            let mono = self.m.mono();
            self.text(if on { "(*)" } else { "( )" }, mono, lead.x, lead.y, None, ink);
            return cols;
        }
        let d = (self.m.cell_h * 0.55).round();
        let (cx, cy) = ((lead.x + lead.w / 2.0).round(), (lead.y + lead.h / 2.0).round());
        let t = self.hair();
        let ring = format!("M {} {} m {} 0 a {r} {r} 0 1 0 {} 0 a {r} {r} 0 1 0 {} 0", 0.0, d / 2.0, 0.0, d, -d, r = d / 2.0 - t / 2.0);
        let key = (d.to_bits() as u64) << 8 | 1;
        let clip = self.clip();
        self.text.shape(&mut self.quads, key, crate::text::Outline { path: crate::text::Data::Svg(&ring), stroke: Some(t), even_odd: false, scale: 1.0 }, crate::text::Paint { origin: (cx - d / 2.0, cy - d / 2.0), limit: None, colors: &[ink], clip });
        if on {
            let dot = (d * 0.5).round();
            let path = format!("M 0 {h} a {h} {h} 0 1 0 {dot} 0 a {h} {h} 0 1 0 {} 0", -dot, h = dot / 2.0);
            let key = (dot.to_bits() as u64) << 8 | 2;
            self.text.shape(&mut self.quads, key, crate::text::Outline { path: crate::text::Data::Svg(&path), stroke: None, even_odd: false, scale: 1.0 }, crate::text::Paint { origin: (cx - dot / 2.0, cy - dot / 2.0), limit: None, colors: &[ink], clip });
        }
        cols
    }

    pub fn switch(&mut self, at: Area, label: &str, on: bool, hit: Option<H>) -> i32 {
        let enabled = hit.is_some();
        let (lead, cols) = self.labelled(at, 4, label, enabled, hit);
        let pal = self.palette;
        if self.style == LineStyle::Ascii {
            let mono = self.m.mono();
            self.text(if on { "[on]" } else { "[  ]" }, mono, lead.x, lead.y, None, if on { pal.ink } else { pal.muted });
            return cols;
        }
        let i = (self.m.cell_h * 0.22).round();
        let track = Rect::new(lead.x, lead.y + i, lead.w - self.m.cell_w * 0.5, lead.h - i * 2.0);
        let t = self.hair();
        let k = track.h - t * 4.0;
        if on {
            self.fill(track, pal.ink);
            self.fill(Rect::new(track.right() - t * 2.0 - k, track.y + t * 2.0, k, k), pal.bg);
        } else {
            self.border(track, t, pal.muted);
            self.fill(Rect::new(track.x + t * 2.0, track.y + t * 2.0, k, k), pal.muted);
        }
        cols
    }

    pub fn cycle(&mut self, at: Area, label: &str, value: &str, hit: Option<H>) -> i32 {
        let pal = self.palette;
        let mono = self.m.mono();
        let lc = label.chars().count() as i32;
        let vc = value.chars().count() as i32 + 2;
        let a = at.at(0, 0, lc + 1 + vc, 1);
        let r = self.rect(a);
        if hit.is_some() && self.hovered(r) {
            self.fill(r, pal.hover);
        }
        self.write(at.at(0, 0, lc, 1), label, mono, pal.muted);
        let chip = self.chip(at.at(lc + 1, 0, vc, 1));
        let t = self.hair();
        self.fill(Rect::new(chip.x, chip.bottom() - t, chip.w, t), if hit.is_some() { pal.ink } else { pal.rule });
        let shown = format!("{value} \u{203A}");
        self.text(&shown, mono, chip.x, (chip.y + (chip.h - self.m.cell_h) / 2.0).round(), None, if hit.is_some() { pal.ink } else { pal.faint });
        if let Some(h) = hit {
            self.hit(r, h);
        }
        a.cols
    }

    pub fn stepper(&mut self, at: Area, value: &str, less: Option<H>, more: Option<H>) -> i32 {
        let pal = self.palette;
        let mono = self.m.mono();
        let mut col = 0;
        let vc = value.chars().count() as i32;
        for (glyph, hit, after) in [("\u{2212}", less, false), ("+", more, true)] {
            if after {
                self.write(at.at(col, 0, vc, 1), value, mono, pal.ink);
                col += vc + 1;
            }
            let a = at.at(col, 0, 3, 1);
            let r = self.chip(a);
            let enabled = hit.is_some();
            if enabled && self.hovered(r) {
                self.fill(r, pal.hover);
            }
            let t = self.hair();
            self.border(r, t, if enabled { pal.ink } else { pal.rule });
            self.centered(r, glyph, mono, if enabled { pal.ink } else { pal.faint });
            if let Some(h) = hit {
                self.hit(r, h);
            }
            col += 4;
        }
        col - 1
    }

    pub fn progress(&mut self, at: Area, fraction: f32) {
        let pal = self.palette;
        let r = self.chip(at);
        let f = fraction.clamp(0.0, 1.0);
        if self.style == LineStyle::Ascii {
            let n = at.cols.max(0) as usize;
            let done = (f * n as f32).round() as usize;
            let bar: String = "#".repeat(done) + &".".repeat(n - done);
            let mono = self.m.mono();
            self.write(at, &bar, mono, pal.ink);
            return;
        }
        let i = (r.h * 0.25).round();
        let track = Rect::new(r.x, r.y + i, r.w, r.h - i * 2.0);
        self.fill(track, pal.field);
        self.fill(Rect::new(track.x, track.y, (track.w * f).round(), track.h), pal.ink);
    }
}
