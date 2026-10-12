use std::collections::HashMap;
use std::ops::Range;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Id(pub u64);

impl Id {
    pub const fn new(name: &str) -> Self {
        Self(0xcbf2_9ce4_8422_2325).mix(name.as_bytes())
    }

    pub const fn child(self, n: u64) -> Self {
        Self(self.0.rotate_left(5) ^ n.wrapping_mul(0x9e37_79b9_7f4a_7c15)).mix(&[0xff])
    }

    pub const fn named(self, name: &str) -> Self {
        self.mix(&[0xfe]).mix(name.as_bytes())
    }

    const fn mix(self, bytes: &[u8]) -> Self {
        let mut h = self.0;
        let mut i = 0;
        while i < bytes.len() {
            h = (h ^ bytes[i] as u64).wrapping_mul(0x0100_0000_01b3);
            i += 1;
        }
        Self(h)
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Scrolling {
    #[default]
    Smooth,
    Rows,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Scroll {
    pub top: usize,
    pub offset: f32,
    pub item: f32,
    pub count: usize,
    pub view: f32,
    pub above: usize,
    pub(crate) key: Option<u64>,
    pub(crate) cursor: Option<u64>,
    pending: f32,
    used: u64,
}

pub struct Layout {
    pub count: usize,
    pub item: f32,
    pub view: f32,
    pub cursor: Option<usize>,
    pub step: Option<f32>,
}

impl Scroll {
    pub fn layout(&mut self, l: Layout, key: impl Fn(usize) -> u64) {
        self.item = l.item;
        self.count = l.count;
        self.view = l.view;
        if let Some(k) = self.key
            && !(self.top < l.count && key(self.top) == k)
            && let Some(i) = (0..l.count).find(|&i| key(i) == k)
        {
            if i > self.top {
                self.above += i - self.top;
            }
            self.top = i;
        }
        let cursor = l.cursor.filter(|&c| c < l.count);
        let cursor_key = cursor.map(&key);
        if cursor_key != self.cursor {
            if let Some(c) = cursor {
                self.reveal(c, l.step);
            }
            self.cursor = cursor_key;
        }
        if self.top >= l.count || self.total() > self.max() {
            self.set_total(self.total());
        }
        self.key = (l.count > 0).then(|| key(self.top));
        self.above = self.above.min(self.top);
    }

    pub fn total(&self) -> f32 {
        self.top as f32 * self.item + self.offset
    }

    pub fn content(&self) -> f32 {
        self.count as f32 * self.item
    }

    pub fn max(&self) -> f32 {
        (self.content() - self.view).max(0.0)
    }

    pub fn set_total(&mut self, total: f32) {
        let total = total.clamp(0.0, self.max());
        if self.item > 0.0 {
            self.top = ((total / self.item).floor() as usize).min(self.count.saturating_sub(1));
            self.offset = total - self.top as f32 * self.item;
        } else {
            self.top = 0;
            self.offset = 0.0;
        }
        self.key = None;
    }

    pub fn visible(&self) -> Range<usize> {
        if self.item <= 0.0 {
            return 0..self.count;
        }
        let end = ((self.total() + self.view) / self.item).ceil() as usize;
        self.top..end.min(self.count)
    }

    pub fn page(&self) -> usize {
        if self.item <= 0.0 { 1 } else { ((self.view / self.item).floor() as usize).max(1) }
    }

    pub fn wheel(&mut self, dy: f32, step: Option<f32>) -> bool {
        let before = self.total();
        let Some(step) = step.filter(|s| *s > 0.0) else {
            self.set_total(before - dy);
            return self.total() != before;
        };
        if self.pending * dy > 0.0 {
            self.pending = 0.0;
        }
        self.pending -= dy;
        let steps = (self.pending / step).trunc();
        if steps == 0.0 {
            return false;
        }
        self.pending -= steps * step;
        self.set_total(((before / step).round() + steps) * step);
        let moved = self.total() != before;
        if !moved {
            self.pending = 0.0;
        }
        moved
    }

    pub(crate) fn reveal(&mut self, index: usize, step: Option<f32>) {
        let top = index as f32 * self.item;
        let bottom = top + self.item;
        if top < self.total() {
            self.set_total(top);
        } else if bottom > self.total() + self.view {
            let want = bottom - self.view;
            self.set_total(match step {
                Some(s) if s > 0.0 => (want / s).ceil() * s,
                _ => want,
            });
        }
    }

    pub fn thumb(&self, track: f32, min: f32) -> (f32, f32) {
        let content = self.content();
        if content <= self.view || content <= 0.0 {
            return (0.0, track);
        }
        let h = (self.view / content * track).max(min).min(track);
        let max = self.max().max(1.0);
        ((self.total() / max).clamp(0.0, 1.0) * (track - h), h)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Spot {
    pub key: u64,
    pub order: usize,
    pub byte: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Selected {
    pub anchor: Spot,
    pub focus: Spot,
}

impl Selected {
    pub fn ordered(&self) -> (Spot, Spot) {
        let (a, f) = (self.anchor, self.focus);
        if (a.order, a.byte) <= (f.order, f.byte) { (a, f) } else { (f, a) }
    }

    pub fn is_empty(&self) -> bool {
        self.anchor.order == self.focus.order && self.anchor.byte == self.focus.byte
    }
}

#[derive(Default)]
pub struct State {
    scrolls: HashMap<Id, Scroll>,
    pub selection: Option<Selected>,
    pub scrolling: Scrolling,
    frame: u64,
}

impl State {
    pub fn scroll(&self, id: Id) -> Option<&Scroll> {
        self.scrolls.get(&id)
    }

    pub fn scroll_mut(&mut self, id: Id) -> &mut Scroll {
        let frame = self.frame;
        let s = self.scrolls.entry(id).or_default();
        s.used = frame;
        s
    }

    pub(crate) fn begin_frame(&mut self) {
        self.frame += 1;
        if self.scrolls.len() > 4096 {
            let mut used: Vec<u64> = self.scrolls.values().map(|s| s.used).collect();
            used.sort_unstable();
            let cut = used[used.len() / 2];
            self.scrolls.retain(|_, s| s.used > cut);
        }
    }

    pub(crate) fn step(&self, cell_h: f32) -> Option<f32> {
        (self.scrolling == Scrolling::Rows).then_some(cell_h)
    }

    pub fn wheel(&mut self, id: Id, dy: f32, cell_h: f32) -> bool {
        let step = self.step(cell_h);
        self.scrolls.get_mut(&id).is_some_and(|s| s.wheel(dy, step))
    }

    pub fn scroll_to(&mut self, id: Id, total: f32) {
        self.scroll_mut(id).set_total(total);
    }

    pub(crate) fn keep(&self, out: &mut String) {
        let key = |k: Option<u64>| k.map_or("-".to_string(), |k| k.to_string());
        for (id, s) in &self.scrolls {
            out.push_str(&format!("scroll {} {} {} {} {}\n", id.0, s.top, s.offset, key(s.key), key(s.cursor)));
        }
    }

    pub(crate) fn restore(&mut self, scroll: &str) {
        let mut parts = scroll.split(' ');
        let mut next = || parts.next().unwrap_or_default();
        let (Ok(id), Ok(top), Ok(offset)) = (next().parse(), next().parse(), next().parse()) else { return };
        let (key, cursor) = (next().parse().ok(), next().parse().ok());
        self.scrolls.insert(Id(id), Scroll { top, offset, key, cursor, ..Scroll::default() });
    }
}
