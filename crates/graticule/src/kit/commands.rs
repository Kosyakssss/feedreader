use crate::commands::Registry;
use crate::grid::Area;
use crate::ui::Scene;

impl<H: Clone> Scene<'_, H> {
    pub fn action_bar<C: Copy + PartialEq, M>(&mut self, at: Area, reg: &Registry<C, M>, model: &M, hit: impl Fn(C) -> H) -> i32 {
        let style = self.m.prop(400.0);
        let mut commands: Vec<_> = reg.available(model).collect();
        commands.sort_by_key(|c| c.rank);
        let items: Vec<(String, i32)> = commands
            .iter()
            .map(|c| {
                let label = (c.label)(model);
                let keys = c.keys.iter().take(2).map(|k| k.label().chars().count() as i32 + 2).sum::<i32>();
                let cols = keys + self.cols(&label, style);
                (label, cols)
            })
            .collect();
        let place = |reserve: i32| {
            let (mut col, mut line, mut spots) = (0, 0, Vec::new());
            for (_, need) in &items {
                let width = if line + 1 == at.rows { at.cols - reserve } else { at.cols };
                if col > 0 && col + need > width {
                    col = 0;
                    line += 1;
                }
                let width = if line + 1 == at.rows { at.cols - reserve } else { at.cols };
                if line >= at.rows || col + need > width {
                    break;
                }
                spots.push((col, line));
                col += need + 3;
            }
            spots
        };
        let mut spots = place(0);
        let note = |shown: usize| format!("{} more in the palette", items.len() - shown);
        if spots.len() < items.len() {
            spots = place(note(0).len() as i32 + 2);
        }
        for ((c, (label, _)), (col, line)) in commands.iter().zip(&items).zip(&spots) {
            let keys = &c.keys[..c.keys.len().min(2)];
            self.action(at.at(*col, *line, at.cols - col, 1), keys, label, Some(hit(c.id)));
        }
        if spots.len() < items.len() {
            let text = note(spots.len());
            let (mono, muted) = (self.m.mono(), self.palette.muted);
            let w = text.len() as i32;
            self.write(at.at(at.cols - w, at.rows - 1, w, 1), &text, mono, muted);
        }
        spots.last().map_or(0, |(_, line)| line + 1)
    }

    pub fn help<C: Copy + PartialEq, M>(&mut self, at: Area, reg: &Registry<C, M>, model: &M, hit: impl Fn(C) -> H) -> i32 {
        let pal = self.palette;
        let mut row = 0;
        for c in &reg.commands {
            if row >= at.rows {
                break;
            }
            let label = (c.label)(model);
            let available = (c.available)(model);
            let line = at.line(row);
            let mut col = 0;
            for k in c.keys.iter().take(3) {
                col += self.key_label(line.at(col, 0, line.cols - col, 1), k) + 1;
            }
            let style = self.m.prop(400.0);
            let a = line.at(16, 0, line.cols - 16, 1);
            let r = self.rect(line);
            if available && self.hovered(r) {
                self.fill(r, pal.hover);
            }
            self.write(a, &label, style, if available { pal.ink } else { pal.faint });
            if available {
                self.hit(r, hit(c.id));
            }
            row += 1;
        }
        row
    }
}
