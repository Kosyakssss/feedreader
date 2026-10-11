use crate::ui::{Rect, Scene};

pub const BUDGET_MS: f32 = 1.0;

pub struct Probe<'a> {
    pub frames: &'a [[f32; 3]],
}

fn outline<H: Clone>(s: &mut Scene<H>, r: Rect, mut color: [f32; 4], alpha: f32) {
    color[3] = alpha;
    let t = s.hair();
    s.border(r, t, color);
}

impl<H: Clone> Scene<'_, H> {
    pub fn scope(&mut self, probe: Probe) {
        let pal = self.palette;
        self.push_clip(Rect::new(0.0, 0.0, self.m.width, self.m.height));
        let screen = self.screen();
        let t = self.hair();
        let mut grid = pal.link;
        for col in 0..=screen.cols {
            grid[3] = if col % 10 == 0 { 0.35 } else { 0.12 };
            self.fill(Rect::new(col as f32 * self.m.cell_w, 0.0, t, self.m.height), grid);
        }
        for row in 0..=screen.rows {
            grid[3] = if row % 5 == 0 { 0.35 } else { 0.12 };
            self.fill(Rect::new(0.0, row as f32 * self.m.cell_h, self.m.width, t), grid);
        }
        let runs: Vec<Rect> = self.runs.iter().map(|r| r.rect).collect();
        for r in runs {
            outline(self, r, pal.ok, 0.6);
        }
        let hits: Vec<Rect> = self.hits.iter().map(|(r, _)| *r).collect();
        for r in &hits {
            outline(self, *r, pal.link, 0.8);
        }
        let fields = self.fields.clone();
        for r in fields {
            outline(self, r, pal.warn, 0.9);
        }
        let scrolls: Vec<Rect> = self.scrollables.iter().map(|(r, _)| *r).collect();
        for r in scrolls {
            outline(self, r, pal.danger, 0.5);
        }
        let mut lines = Vec::new();
        if let Some((x, y)) = self.pointer {
            let (col, row) = ((x / self.m.cell_w) as i32, (y / self.m.cell_h) as i32);
            let mut cross = pal.danger;
            cross[3] = 0.5;
            self.fill(Rect::new(x.floor(), 0.0, t, self.m.height), cross);
            self.fill(Rect::new(0.0, y.floor(), self.m.width, t), cross);
            lines.push(format!("cell {col}, {row}   px {:.0}, {:.0}", x, y));
            let hit = hits.iter().rposition(|r| r.contains(x, y));
            lines.push(match hit {
                Some(i) => format!("hit #{i} of {}", hits.len()),
                None => format!("no hit ({} on screen)", hits.len()),
            });
            if let Some(run) = self.runs.iter().rev().find(|r| r.rect.contains(x, y)) {
                let text: String = self.text.source(run.key).unwrap_or("").chars().take(36).collect();
                lines.push(format!("text \u{201C}{text}\u{201D}"));
            }
        }
        let paint: Vec<f32> = probe.frames.iter().map(|f| f[0]).collect();
        let gpu: Vec<f32> = probe.frames.iter().map(|f| f[1]).collect();
        let last = probe.frames.last().copied().unwrap_or_default();
        let worst = paint.iter().copied().fold(0.0, f32::max);
        lines.push(format!("paint {:.2} ms  gpu {:.2} ms  present {:.2} ms", last[0], last[1], last[2]));
        lines.push(format!("worst paint {worst:.2} ms of {} frames, budget {BUDGET_MS:.2} ms", paint.len()));
        lines.push(format!("{} quads  {} runs  {} hits", self.quads.len(), self.runs.len(), hits.len()));
        let cols = 50;
        let rows = lines.len() as i32 + 6;
        let mut panel = crate::grid::Area::new(screen.cols - cols - 1, screen.rows - rows - 1, cols, rows);
        if self.pointer.is_some_and(|(x, y)| self.rect(panel).contains(x, y)) {
            panel.row = 1;
        }
        let r = self.rect(panel);
        self.fill(r, pal.bg);
        outline(self, r, pal.ink, 1.0);
        let mono = self.m.mono();
        let selectable = std::mem::replace(&mut self.selectable, false);
        self.write(panel.at(1, 0, cols - 2, 1), "SC-01 SCOPE", crate::text::TextStyle { weight: 600.0, ..mono }, pal.ink);
        for (i, line) in lines.iter().enumerate() {
            self.write(panel.at(1, 1 + i as i32, cols - 2, 1), line, mono, pal.ink);
        }
        let chart = panel.at(1, lines.len() as i32 + 2, cols - 2, 3);
        let cr = self.rect(chart);
        let scale = cr.h / (BUDGET_MS * 2.0);
        let budget_y = cr.bottom() - BUDGET_MS * scale;
        self.fill(Rect::new(cr.x, budget_y.round(), cr.w, t), pal.danger);
        let n = paint.len().max(1);
        let bar = (cr.w / n as f32).max(1.0);
        for (i, (p, g)) in paint.iter().zip(&gpu).enumerate() {
            let x = cr.x + i as f32 * bar;
            let hp = (p * scale).min(cr.h);
            let hg = (g * scale).min(cr.h - hp);
            self.fill(Rect::new(x, cr.bottom() - hp, bar.max(t), hp), if *p > BUDGET_MS { pal.danger } else { pal.ink });
            self.fill(Rect::new(x, cr.bottom() - hp - hg, bar.max(t), hg), pal.faint);
        }
        self.write(panel.at(1, rows - 1, cols - 2, 1), "paint ink, gpu faint, budget red", mono, pal.muted);
        self.selectable = selectable;
        self.pop_clip();
    }
}
