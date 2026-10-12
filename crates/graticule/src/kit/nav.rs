use crate::grid::Area;
use crate::ui::{Rect, Scene};

pub struct Place<'a> {
    pub label: &'a str,
    pub count: Option<usize>,
}

impl<H: Clone> Scene<'_, H> {
    pub fn tabs(&mut self, at: Area, tabs: &[&str], current: usize, hit: impl Fn(usize) -> H) {
        let pal = self.palette;
        let t = self.hair();
        let row = self.rect(at.line(0));
        let base = row.bottom() - t;
        self.fill(Rect::new(row.x, base, row.w, t), pal.rule);
        let mut col = 0;
        for (i, label) in tabs.iter().enumerate() {
            let style = self.m.prop(if i == current { 600.0 } else { 400.0 });
            let cols = self.cols(label, style) + 2;
            if col + cols > at.cols {
                break;
            }
            let a = at.at(col, 0, cols, 1);
            let r = self.rect(a);
            if i == current {
                self.fill(Rect::new(r.x, base - t, r.w, t * 2.0), pal.ink);
            } else if self.hovered(r) {
                self.fill(Rect::new(r.x, r.y, r.w, r.h - t), pal.hover);
            }
            self.write(a.at(1, 0, cols - 1, 1), label, style, if i == current { pal.ink } else { pal.muted });
            self.hit(r, hit(i));
            col += cols + 1;
        }
    }

    pub fn places(&mut self, at: Area, places: &[Place], current: usize, hit: impl Fn(usize) -> H) {
        let pal = self.palette;
        let mono = self.m.mono();
        let mut col = 0;
        for (i, p) in places.iter().enumerate() {
            let style = self.m.prop(if i == current { 600.0 } else { 400.0 });
            let label_cols = self.cols(p.label, style);
            let count = p.count.map(|n| n.to_string());
            let count_cols = count.as_ref().map_or(0, |c| c.len() as i32 + 1);
            let cols = 2 + label_cols + count_cols;
            if col + cols > at.cols {
                break;
            }
            let a = at.at(col, 0, cols, 1);
            let r = self.rect(a);
            if i != current && self.hovered(r) {
                self.fill(r, pal.hover);
            }
            if i == current {
                let d = (self.m.cell_w * 0.5).round();
                let cell = self.rect(a.at(0, 0, 1, 1));
                self.fill(Rect::new((cell.x + (cell.w - d) / 2.0).round(), (cell.y + (cell.h - d) / 2.0).round(), d, d), pal.ink);
            }
            self.write(a.at(2, 0, label_cols, 1), p.label, style, pal.ink);
            if let Some(c) = &count {
                self.write(a.at(2 + label_cols + 1, 0, c.len() as i32, 1), c, mono, pal.muted);
            }
            self.hit(r, hit(i));
            col += cols + 2;
        }
    }

    pub fn breadcrumb(&mut self, at: Area, parts: &[&str], hit: impl Fn(usize) -> Option<H>) {
        let pal = self.palette;
        let mut col = 0;
        for (i, part) in parts.iter().enumerate() {
            let last = i + 1 == parts.len();
            if i > 0 {
                let mono = self.m.mono();
                self.write(at.at(col, 0, 1, 1), "/", mono, pal.faint);
                col += 2;
            }
            match (last, hit(i)) {
                (false, Some(h)) => col += self.link(at.at(col, 0, at.cols - col, 1), part, Some(h)),
                _ => {
                    let style = self.m.prop(if last { 600.0 } else { 400.0 });
                    let cols = self.cols(part, style);
                    self.write(at.at(col, 0, cols, 1), part, style, if last { pal.ink } else { pal.muted });
                    col += cols;
                }
            }
            col += 1;
        }
    }
}
