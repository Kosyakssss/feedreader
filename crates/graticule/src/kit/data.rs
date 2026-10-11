use crate::grid::Area;
use crate::kit::Value;
use crate::state::Id;
use crate::ui::{List, Scene};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Align {
    Left,
    Right,
}

pub struct Column<'a> {
    pub title: &'a str,
    pub cols: i32,
    pub align: Align,
}

pub struct Node<'a> {
    pub label: &'a str,
    pub depth: usize,
    pub last: bool,
    pub open: Option<bool>,
}

impl<H: Clone> Scene<'_, H> {
    pub fn spec_group(&mut self, at: Area, title: &str) {
        let (mono, muted) = (self.m.mono(), self.palette.muted);
        let cols = title.chars().count() as i32;
        self.write(at.at(0, 0, cols, 1), &title.to_uppercase(), mono, muted);
        self.rule(at.at(cols + 1, 0, (at.cols - cols - 1).max(0), 1));
    }

    pub fn spec(&mut self, at: Area, key: &str, value: Value, key_cols: i32) {
        let pal = self.palette;
        let style = self.m.prop(400.0);
        let kc = self.cols(key, style).min(key_cols);
        self.write(at.at(0, 0, kc, 1), key, style, pal.muted);
        let lead: String = std::iter::repeat_n('\u{2508}', (key_cols - kc - 1).max(0) as usize).collect();
        let mono = self.m.mono();
        self.write(at.at(kc + 1, 0, key_cols - kc - 1, 1), &lead, mono, pal.rule);
        self.value(at.at(key_cols + 1, 0, at.cols - key_cols - 1, 1), value);
    }

    pub fn table<'v>(&mut self, id: Id, at: Area, columns: &[Column], count: usize, cursor: Option<usize>, cell: impl Fn(usize, usize) -> Value<'v>, hit: impl Fn(usize) -> H) {
        let pal = self.palette;
        let mono = self.m.mono();
        let mut body = at;
        let head = body.take_top(1);
        let line = body.take_top(1);
        let mut col = 0;
        for c in columns {
            let title = c.title.to_uppercase();
            let w = title.chars().count() as i32;
            let x = if c.align == Align::Right { col + c.cols - w } else { col };
            self.write(head.at(x, 0, w.min(c.cols), 1), &title, mono, pal.muted);
            col += c.cols + 2;
        }
        self.rule(line);
        self.list(List { id, count, rows: 1, cursor }, body, |i| i as u64, |s, i, row| {
            let r = s.rect(row);
            if Some(i) == cursor {
                s.fill(r, pal.cursor);
            } else {
                s.hover(r);
            }
            let mut col = 0;
            for (j, c) in columns.iter().enumerate() {
                let v = cell(i, j);
                let w = s.value_cols(v).min(c.cols);
                let x = if c.align == Align::Right { col + c.cols - w } else { col };
                s.push_clip(s.rect(row.at(col, 0, c.cols, 1)));
                s.value(row.at(x, 0, c.cols - (x - col), 1), v);
                s.pop_clip();
                col += c.cols + 2;
            }
            s.hit(r, hit(i));
        });
    }

    pub fn tree(&mut self, at: Area, nodes: &[Node], cursor: Option<usize>, hit: impl Fn(usize) -> H) -> i32 {
        let pal = self.palette;
        let mono = self.m.mono();
        let mut open_lines: Vec<bool> = Vec::new();
        for (i, n) in nodes.iter().enumerate().take(at.rows.max(0) as usize) {
            open_lines.truncate(n.depth);
            let mut prefix = String::new();
            for &more in &open_lines {
                prefix.push_str(if more { "\u{2502}  " } else { "   " });
            }
            if n.depth > 0 || i > 0 {
                prefix.push_str(if n.last { "\u{2514}\u{2500} " } else { "\u{251C}\u{2500} " });
            }
            open_lines.push(!n.last);
            let marker = match n.open {
                Some(true) => "\u{25BE} ",
                Some(false) => "\u{25B8} ",
                None => "",
            };
            let row = at.line(i as i32);
            let r = self.rect(row);
            if Some(i) == cursor {
                self.fill(r, pal.cursor);
            } else {
                self.hover(r);
            }
            let pc = prefix.chars().count() as i32;
            self.write(row.at(0, 0, pc, 1), &prefix, mono, pal.rule);
            let mc = marker.chars().count() as i32;
            self.write(row.at(pc, 0, mc, 1), marker, mono, pal.muted);
            let style = self.m.prop(if n.open.is_some() { 600.0 } else { 400.0 });
            self.write(row.at(pc + mc, 0, row.cols - pc - mc, 1), n.label, style, pal.ink);
            self.hit(r, hit(i));
        }
        nodes.len().min(at.rows.max(0) as usize) as i32
    }
}
