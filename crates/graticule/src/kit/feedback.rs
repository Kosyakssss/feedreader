use crate::grid::Area;
use crate::kit::{Kind, Tone, Value};
use crate::ui::{Rect, Scene};

impl<H: Clone> Scene<'_, H> {
    pub fn status_line(&mut self, at: Area, left: &[Value], hint: &str, right: &[Value]) {
        let mut col = 0;
        for v in left {
            col += self.value(at.at(col, 0, at.cols - col, 1), *v) + 2;
        }
        let right_cols: i32 = right.iter().map(|v| self.value_cols(*v)).sum::<i32>() + 2 * right.len().saturating_sub(1) as i32;
        let room = at.cols - col - right_cols - 2;
        if room > 0 && !hint.is_empty() {
            let (style, muted) = (self.m.prop(400.0), self.palette.muted);
            self.write(at.at(col, 0, room, 1), hint, style, muted);
        }
        let mut x = at.cols - right_cols;
        for v in right {
            x += self.value(at.at(x, 0, at.cols - x, 1), *v) + 2;
        }
    }

    pub fn value_cols(&mut self, v: Value) -> i32 {
        match v {
            Value::Text(t) | Value::Error(t) => {
                let style = self.m.prop(400.0);
                self.cols(t, style)
            }
            Value::Count(t) => t.chars().count() as i32,
            Value::Date(m) => self.dates.format(m, self.now).chars().count() as i32 + 1,
            Value::Version(t) | Value::State(t, _) | Value::Product(t) | Value::Code(t) | Value::Mode(t) => t.chars().count() as i32 + 1,
        }
    }

    pub fn message(&mut self, at: Area, text: &str, tone: Tone, dismiss: Option<H>) {
        let pal = self.palette;
        let ink = match tone {
            Tone::Neutral => pal.ink,
            Tone::Ok => pal.ok,
            Tone::Warn => pal.warn,
            Tone::Danger => pal.danger,
        };
        let mark = self.rect(at.at(0, 0, 1, 1));
        let d = (self.m.cell_w * 0.6).round();
        self.fill(Rect::new(mark.x, (mark.y + (mark.h - d) / 2.0).round(), d, d), ink);
        let style = self.m.prop(400.0);
        let label = "dismiss";
        let room = if dismiss.is_some() { at.cols - 2 - label.len() as i32 - 3 } else { at.cols - 2 };
        self.write(at.at(2, 0, room, 1), text, style, pal.ink);
        if let Some(h) = dismiss {
            let col = at.cols - label.len() as i32;
            self.link(at.at(col, 0, label.len() as i32, 1), label, Some(h));
        }
    }

    pub fn confirm(&mut self, at: Area, question: &str, yes: (&str, Kind, H), no: (&str, H)) {
        let pal = self.palette;
        let style = self.m.prop(600.0);
        let cols = self.cols(question, style);
        self.write(at.at(0, 0, cols, 1), question, style, pal.ink);
        let mut col = cols + 2;
        col += self.button(at.at(col, 0, at.cols - col, 1), yes.0, yes.1, Some(yes.2)) + 1;
        self.button(at.at(col, 0, at.cols - col, 1), no.0, Kind::Normal, Some(no.1));
    }
}
