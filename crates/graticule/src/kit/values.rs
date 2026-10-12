use crate::dates::Moment;
use crate::grid::Area;
use crate::ui::{Rect, Scene};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tone {
    Neutral,
    Ok,
    Warn,
    Danger,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Value<'a> {
    Text(&'a str),
    Count(&'a str),
    Date(Moment),
    Version(&'a str),
    State(&'a str, Tone),
    Product(&'a str),
    Code(&'a str),
    Mode(&'a str),
    Error(&'a str),
}

impl<H: Clone> Scene<'_, H> {
    fn tone(&self, tone: Tone) -> [f32; 4] {
        match tone {
            Tone::Neutral => self.palette.ink,
            Tone::Ok => self.palette.ok,
            Tone::Warn => self.palette.warn,
            Tone::Danger => self.palette.danger,
        }
    }

    pub fn value(&mut self, at: Area, v: Value) -> i32 {
        let pal = self.palette;
        let mono = self.m.mono();
        let strong = crate::text::TextStyle { weight: 600.0, ..mono };
        let boxed = |text: &str| text.chars().count() as i32 + 1;
        match v {
            Value::Text(t) => {
                let cols = self.cols(t, self.m.prop(400.0)).min(at.cols);
                self.write(at.at(0, 0, cols, 1), t, self.m.prop(400.0), pal.ink);
                cols
            }
            Value::Count(t) => {
                let cols = t.chars().count() as i32;
                self.write(at.at(0, 0, cols, 1), t, mono, pal.ink);
                cols
            }
            Value::Error(t) => {
                let cols = self.cols(t, self.m.prop(400.0)).min(at.cols);
                self.write(at.at(0, 0, cols, 1), t, self.m.prop(400.0), pal.danger);
                cols
            }
            Value::Date(m) => {
                let t = self.dates.format(m, self.now);
                let a = at.at(0, 0, boxed(&t), 1);
                let r = self.chip(a);
                self.fill(r, pal.link);
                self.centered(r, &t, mono, pal.bg);
                a.cols
            }
            Value::State(t, tone) => {
                let a = at.at(0, 0, boxed(t), 1);
                let r = self.chip(a);
                let ink = self.tone(tone);
                self.fill(r, ink);
                self.centered(r, &t.to_uppercase(), strong, pal.bg);
                a.cols
            }
            Value::Version(t) => {
                let a = at.at(0, 0, boxed(t), 1);
                let r = self.chip(a);
                self.dotted(r, pal.muted);
                self.centered(r, t, mono, pal.ink);
                a.cols
            }
            Value::Product(t) => {
                let a = at.at(0, 0, boxed(t), 1);
                let r = self.chip(a);
                let t2 = self.hair() * 2.0;
                self.border(r, t2, pal.ink);
                self.centered(r, &t.to_uppercase(), strong, pal.ink);
                a.cols
            }
            Value::Code(t) => {
                let a = at.at(0, 0, boxed(t), 1);
                let r = self.chip(a);
                self.fill(r, pal.field);
                self.centered(r, t, mono, pal.ink);
                a.cols
            }
            Value::Mode(t) => {
                let a = at.at(0, 0, boxed(t), 1);
                let r = self.chip(a);
                let h = self.hair();
                self.fill(Rect::new(r.x, r.bottom() - h, r.w, h), pal.muted);
                self.centered(r, t, mono, pal.muted);
                a.cols
            }
        }
    }
}
