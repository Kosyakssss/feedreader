use std::ops::Range;

use crate::commands::Key;

#[derive(Clone, Debug, Default)]
pub struct Field {
    pub text: String,
    pub caret: usize,
    pub anchor: usize,
    pub preedit: String,
    history: Vec<(String, usize)>,
    future: Vec<(String, usize)>,
    last: Kind,
    kill: String,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
enum Kind {
    #[default]
    Moved,
    Typing,
    Deleting,
    Whole,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Keys {
    pub shift: bool,
    pub alt: bool,
    pub primary: bool,
    pub control: bool,
}

#[derive(Debug, PartialEq)]
pub enum Edit {
    Ignored,
    Moved,
    Changed,
    Copy(String),
    Cut(String),
    Paste,
}

fn word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

impl Field {
    pub fn with(text: &str) -> Self {
        Self { text: text.to_string(), caret: text.len(), anchor: text.len(), ..Self::default() }
    }

    pub fn set(&mut self, text: &str) {
        *self = Self { kill: std::mem::take(&mut self.kill), ..Self::with(text) };
    }

    pub fn clear(&mut self) {
        self.set("");
    }

    pub fn selection(&self) -> Range<usize> {
        self.anchor.min(self.caret)..self.anchor.max(self.caret)
    }

    pub fn selected(&self) -> &str {
        &self.text[self.selection()]
    }

    pub fn insert(&mut self, s: &str) {
        self.replace(self.selection(), s, Kind::Typing);
    }

    pub fn select_all(&mut self) {
        self.anchor = 0;
        self.caret = self.text.len();
        self.last = Kind::Moved;
    }

    pub fn place(&mut self, at: usize, extend: bool) {
        self.caret = self.boundary(at);
        if !extend {
            self.anchor = self.caret;
        }
        self.last = Kind::Moved;
    }

    pub fn select_word(&mut self, at: usize) {
        let at = self.boundary(at);
        if self.text[at..].chars().next().is_some_and(word) {
            self.anchor = at - self.text[..at].chars().rev().take_while(|&c| word(c)).map(char::len_utf8).sum::<usize>();
            self.caret = at + self.text[at..].chars().take_while(|&c| word(c)).map(char::len_utf8).sum::<usize>();
        } else {
            self.anchor = at;
            self.caret = self.next(at);
        }
        self.last = Kind::Moved;
    }

    pub fn undo(&mut self) -> bool {
        let Some(state) = self.history.pop() else { return false };
        self.future.push((std::mem::replace(&mut self.text, state.0), self.caret));
        self.caret = state.1;
        self.anchor = state.1;
        self.last = Kind::Moved;
        true
    }

    pub fn redo(&mut self) -> bool {
        let Some(state) = self.future.pop() else { return false };
        self.history.push((std::mem::replace(&mut self.text, state.0), self.caret));
        self.caret = state.1;
        self.anchor = state.1;
        self.last = Kind::Moved;
        true
    }

    pub fn key(&mut self, key: Key, k: Keys) -> Edit {
        let extend = k.shift;
        let selecting = !self.selection().is_empty();
        let to = match (key, k.primary, k.alt, k.control) {
            (Key::Char('a'), true, false, false) => {
                self.select_all();
                return Edit::Moved;
            }
            (Key::Char('c'), true, false, false) if selecting => return Edit::Copy(self.selected().to_string()),
            (Key::Char('x'), true, false, false) if selecting => {
                let cut = self.selected().to_string();
                self.replace(self.selection(), "", Kind::Whole);
                return Edit::Cut(cut);
            }
            (Key::Char('v'), true, false, false) => return Edit::Paste,
            (Key::Char('z'), true, false, false) if !k.shift => return if self.undo() { Edit::Changed } else { Edit::Ignored },
            (Key::Char('z'), true, false, false) => return if self.redo() { Edit::Changed } else { Edit::Ignored },
            (Key::Backspace, _, _, _) | (Key::Char('h'), false, false, true) if selecting => return self.delete(self.selection()),
            (Key::Delete, _, _, _) | (Key::Char('d'), false, false, true) if selecting => return self.delete(self.selection()),
            (Key::Backspace, true, _, false) => return self.delete(0..self.caret),
            (Key::Backspace, false, true, false) => return self.delete(self.word_start(self.caret)..self.caret),
            (Key::Backspace, false, false, false) | (Key::Char('h'), false, false, true) => return self.delete(self.prev(self.caret)..self.caret),
            (Key::Delete, false, true, false) => return self.delete(self.caret..self.word_end(self.caret)),
            (Key::Delete, false, false, false) | (Key::Char('d'), false, false, true) => return self.delete(self.caret..self.next(self.caret)),
            (Key::Char('k'), false, false, true) if self.caret < self.text.len() => {
                self.kill = self.text[self.caret..].to_string();
                return self.delete(self.caret..self.text.len());
            }
            (Key::Char('y'), false, false, true) if !self.kill.is_empty() => {
                let kill = self.kill.clone();
                self.replace(self.selection(), &kill, Kind::Whole);
                return Edit::Changed;
            }
            (Key::Left, false, false, false) | (Key::Char('b'), false, false, true) if selecting && !extend => self.selection().start,
            (Key::Right, false, false, false) | (Key::Char('f'), false, false, true) if selecting && !extend => self.selection().end,
            (Key::Left, false, false, false) | (Key::Char('b'), false, false, true) => self.prev(self.caret),
            (Key::Right, false, false, false) | (Key::Char('f'), false, false, true) => self.next(self.caret),
            (Key::Left, false, true, false) => self.word_start(self.caret),
            (Key::Right, false, true, false) => self.word_end(self.caret),
            (Key::Left, true, false, false) | (Key::Home, false, false, false) | (Key::Char('a'), false, false, true) => 0,
            (Key::Right, true, false, false) | (Key::End, false, false, false) | (Key::Char('e'), false, false, true) => self.text.len(),
            _ => return Edit::Ignored,
        };
        self.place(to, extend);
        Edit::Moved
    }

    fn delete(&mut self, range: Range<usize>) -> Edit {
        if range.is_empty() {
            return Edit::Ignored;
        }
        self.replace(range, "", Kind::Deleting);
        Edit::Changed
    }

    fn replace(&mut self, range: Range<usize>, with: &str, kind: Kind) {
        if kind != self.last || kind == Kind::Whole {
            self.history.push((self.text.clone(), self.caret));
        }
        self.future.clear();
        self.text.replace_range(range.clone(), with);
        self.caret = range.start + with.len();
        self.anchor = self.caret;
        self.last = kind;
    }

    fn boundary(&self, at: usize) -> usize {
        let mut at = at.min(self.text.len());
        while !self.text.is_char_boundary(at) {
            at -= 1;
        }
        at
    }

    fn prev(&self, from: usize) -> usize {
        self.text[..from].char_indices().next_back().map_or(0, |(i, _)| i)
    }

    fn next(&self, from: usize) -> usize {
        self.text[from..].chars().next().map_or(from, |c| from + c.len_utf8())
    }

    fn word_start(&self, from: usize) -> usize {
        let before = &self.text[..from];
        let end = before.trim_end_matches(|c| !word(c)).len();
        before[..end].trim_end_matches(word).len()
    }

    fn word_end(&self, from: usize) -> usize {
        let after = &self.text[from..];
        let skipped = after.len() - after.trim_start_matches(|c| !word(c)).len();
        let rest = &after[skipped..];
        from + skipped + (rest.len() - rest.trim_start_matches(word).len())
    }
}
