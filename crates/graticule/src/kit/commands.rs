use std::ops::Range;

use crate::commands::Registry;
use crate::field::Field;
use crate::grid::Area;
use crate::state::Id;
use crate::text::{Block, Face, SpanStyle};
use crate::ui::{List, Scene};

pub struct Palette<'a> {
    pub id: Id,
    pub field: &'a Field,
    pub focused: bool,
    pub found: &'a [Found<'a>],
    pub cursor: Option<usize>,
}

pub struct Found<'a> {
    pub label: &'a str,
    pub detail: &'a str,
    pub matched: &'a [Range<usize>],
}

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

    pub fn palette(&mut self, p: Palette, at: Area, hit: impl Fn(usize) -> H) {
        let Palette { id, field, focused, found, cursor } = p;
        let pal = self.palette;
        let mut body = at;
        let input = body.take_top(1);
        let r = self.rect(input);
        self.field(r, field, focused, "type to search entries, feeds, places and commands");
        body.take_top(1);
        let size = self.m.size;
        let line = self.m.cell_h;
        self.list(List { id, count: found.len(), rows: 1, cursor }, body, |i| i as u64, |s, i, row| {
            let f = &found[i];
            let r = s.rect(row);
            if Some(i) == cursor {
                s.fill(r, pal.cursor);
            } else {
                s.hover(r);
            }
            let mut spans: Vec<(&str, SpanStyle)> = Vec::new();
            let mut at = 0;
            let plain = SpanStyle::plain(Face::Prop);
            let strong = SpanStyle { weight: 600, color: 1, ..plain };
            for m in f.matched {
                if m.start < at || m.end > f.label.len() || !f.label.is_char_boundary(m.start) || !f.label.is_char_boundary(m.end) {
                    continue;
                }
                spans.push((&f.label[at..m.start], plain));
                spans.push((&f.label[m.clone()], strong));
                at = m.end;
            }
            spans.push((&f.label[at..], plain));
            let lr = s.rect(row.at(1, 0, row.cols * 2 / 3, 1));
            s.spans(Block { spans: &spans, size, line, wrap: None }, (lr.x, lr.y), Some(lr.w), &[pal.muted, pal.ink]);
            let dc = f.detail.chars().count() as i32;
            let mono = s.m.mono();
            s.write(row.at(row.cols - dc - 1, 0, dc, 1), f.detail, mono, pal.faint);
            s.hit(r, hit(i));
        });
    }
}
