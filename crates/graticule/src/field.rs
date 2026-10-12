use std::ops::Range;

use crate::commands::Key;

#[derive(Clone, Debug, Default)]
pub struct Field {
    pub text: String,
    pub caret: usize,
    pub anchor: usize,
    pub preedit: String,
    pub multiline: bool,
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
    Alone,
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
    Line(Line, bool),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Line {
    Up,
    Down,
    Start,
    End,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Op {
    Back,
    Forward,
    Up,
    Down,
    WordBack,
    WordForward,
    LineStart,
    LineEnd,
    ParagraphStart,
    ParagraphEnd,
    ParagraphBack,
    ParagraphForward,
    DocStart,
    DocEnd,
    DeleteBack,
    DeleteForward,
    DeleteWordBack,
    DeleteWordForward,
    DeleteToLineStart,
    Kill,
    Yank,
    Transpose,
    Newline,
    SelectAll,
    Copy,
    Cut,
    Paste,
    Undo,
    Redo,
}

fn bind(key: Key, k: Keys) -> Option<(Op, bool)> {
    let Keys { shift, alt, primary, control } = k;
    let op = match (key, primary, alt, control) {
        (Key::Char('a'), true, false, false) => Op::SelectAll,
        (Key::Char('c'), true, false, false) => Op::Copy,
        (Key::Char('x'), true, false, false) => Op::Cut,
        (Key::Char('v'), true, false, false) => Op::Paste,
        (Key::Char('z'), true, false, false) => return Some((if shift { Op::Redo } else { Op::Undo }, false)),
        (Key::Left, false, false, false) | (Key::Char('b'), false, false, true) => Op::Back,
        (Key::Right, false, false, false) | (Key::Char('f'), false, false, true) => Op::Forward,
        (Key::Left, false, true, false) | (Key::Char('b'), false, true, true) => Op::WordBack,
        (Key::Right, false, true, false) | (Key::Char('f'), false, true, true) => Op::WordForward,
        (Key::Left, true, false, false) | (Key::Left, false, false, true) => Op::LineStart,
        (Key::Right, true, false, false) | (Key::Right, false, false, true) => Op::LineEnd,
        (Key::Up, false, false, false) | (Key::Char('p'), false, false, true) => Op::Up,
        (Key::Down, false, false, false) | (Key::Char('n'), false, false, true) => Op::Down,
        (Key::Up, false, true, false) if shift => Op::ParagraphBack,
        (Key::Down, false, true, false) if shift => Op::ParagraphForward,
        (Key::Up, true, false, false) | (Key::Home, false, false, false) => Op::DocStart,
        (Key::Down, true, false, false) | (Key::End, false, false, false) => Op::DocEnd,
        (Key::Char('a'), false, false, true) => Op::ParagraphStart,
        (Key::Char('e'), false, false, true) => Op::ParagraphEnd,
        (Key::Backspace, false, false, _) | (Key::Char('h'), false, false, true) => Op::DeleteBack,
        (Key::Delete, false, false, false) | (Key::Char('d'), false, false, true) => Op::DeleteForward,
        (Key::Backspace, false, true, _) => Op::DeleteWordBack,
        (Key::Delete, false, true, false) => Op::DeleteWordForward,
        (Key::Backspace, true, false, false) => Op::DeleteToLineStart,
        (Key::Char('k'), false, false, true) => Op::Kill,
        (Key::Char('y'), false, false, true) => Op::Yank,
        (Key::Char('t'), false, false, true) => Op::Transpose,
        (Key::Enter, false, false, false) => Op::Newline,
        _ => return None,
    };
    let extend = shift && !matches!(op, Op::Newline | Op::SelectAll | Op::Copy | Op::Cut | Op::Paste);
    Some((op, extend))
}

fn word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

impl Field {
    pub fn with(text: &str) -> Self {
        Self { text: text.to_string(), caret: text.len(), anchor: text.len(), ..Self::default() }
    }

    pub fn multiline(text: &str) -> Self {
        Self { multiline: true, ..Self::with(text) }
    }

    pub fn set(&mut self, text: &str) {
        *self = Self { kill: std::mem::take(&mut self.kill), multiline: self.multiline, ..Self::with(text) };
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

    pub fn complete(&mut self, from: usize, with: &str) {
        let from = self.boundary(from).min(self.caret);
        self.replace(from..self.caret, with, Kind::Alone);
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
        self.travel(true)
    }

    pub fn redo(&mut self) -> bool {
        self.travel(false)
    }

    fn travel(&mut self, back: bool) -> bool {
        let (from, to) = if back { (&mut self.history, &mut self.future) } else { (&mut self.future, &mut self.history) };
        let Some((text, caret)) = from.pop() else { return false };
        to.push((std::mem::replace(&mut self.text, text), self.caret));
        self.caret = caret;
        self.anchor = caret;
        self.last = Kind::Moved;
        true
    }

    pub fn key(&mut self, key: Key, k: Keys) -> Edit {
        let Some((op, extend)) = bind(key, k) else { return Edit::Ignored };
        let selecting = !self.selection().is_empty();
        let to = match op {
            Op::SelectAll => {
                self.select_all();
                return Edit::Moved;
            }
            Op::Copy if selecting => return Edit::Copy(self.selected().to_string()),
            Op::Cut if selecting => {
                let cut = self.selected().to_string();
                self.replace(self.selection(), "", Kind::Alone);
                return Edit::Cut(cut);
            }
            Op::Copy | Op::Cut => return Edit::Ignored,
            Op::Paste => return Edit::Paste,
            Op::Undo => return if self.undo() { Edit::Changed } else { Edit::Ignored },
            Op::Redo => return if self.redo() { Edit::Changed } else { Edit::Ignored },
            Op::Newline if self.multiline => {
                self.replace(self.selection(), "\n", Kind::Typing);
                return Edit::Changed;
            }
            Op::Newline => return Edit::Ignored,
            Op::DeleteBack | Op::DeleteForward | Op::DeleteWordBack | Op::DeleteWordForward | Op::DeleteToLineStart if selecting => {
                return self.delete(self.selection());
            }
            Op::DeleteBack => return self.delete(self.prev(self.caret)..self.caret),
            Op::DeleteForward => return self.delete(self.caret..self.next(self.caret)),
            Op::DeleteWordBack => return self.delete(self.word_start(self.caret)..self.caret),
            Op::DeleteWordForward => return self.delete(self.caret..self.word_end(self.caret)),
            Op::DeleteToLineStart => return self.delete(self.paragraph_start(self.caret)..self.caret),
            Op::Kill => {
                let end = match self.text[self.caret..].find('\n') {
                    Some(0) => self.caret + 1,
                    Some(i) => self.caret + i,
                    None => self.text.len(),
                };
                if end == self.caret {
                    return Edit::Ignored;
                }
                self.kill = self.text[self.caret..end].to_string();
                return self.delete(self.caret..end);
            }
            Op::Yank if !self.kill.is_empty() => {
                let kill = self.kill.clone();
                self.replace(self.selection(), &kill, Kind::Alone);
                return Edit::Changed;
            }
            Op::Yank => return Edit::Ignored,
            Op::Transpose => return self.transpose(),
            Op::Back if selecting && !extend => self.selection().start,
            Op::Forward if selecting && !extend => self.selection().end,
            Op::Back => self.prev(self.caret),
            Op::Forward => self.next(self.caret),
            Op::WordBack => self.word_start(self.caret),
            Op::WordForward => self.word_end(self.caret),
            Op::LineStart if self.multiline => return Edit::Line(Line::Start, extend),
            Op::LineEnd if self.multiline => return Edit::Line(Line::End, extend),
            Op::Up if self.multiline => return Edit::Line(Line::Up, extend),
            Op::Down if self.multiline => return Edit::Line(Line::Down, extend),
            Op::Up | Op::Down => return Edit::Ignored,
            Op::LineStart | Op::DocStart => 0,
            Op::LineEnd | Op::DocEnd => self.text.len(),
            Op::ParagraphStart => self.paragraph_start(self.caret),
            Op::ParagraphEnd => self.paragraph_end(self.caret),
            Op::ParagraphBack => self.paragraph_start(self.prev(self.caret)),
            Op::ParagraphForward => self.paragraph_end(self.next(self.caret)),
        };
        self.place(to, extend);
        Edit::Moved
    }

    fn transpose(&mut self) -> Edit {
        if self.text.is_empty() || self.caret == 0 {
            return Edit::Ignored;
        }
        let at = if self.caret == self.text.len() { self.prev(self.caret) } else { self.caret };
        let before = self.prev(at);
        let end = self.next(at);
        if before == at {
            return Edit::Ignored;
        }
        let swapped = format!("{}{}", &self.text[at..end], &self.text[before..at]);
        self.replace(before..end, &swapped, Kind::Alone);
        Edit::Changed
    }

    fn paragraph_start(&self, from: usize) -> usize {
        self.text[..from].rfind('\n').map_or(0, |i| i + 1)
    }

    fn paragraph_end(&self, from: usize) -> usize {
        self.text[from..].find('\n').map_or(self.text.len(), |i| from + i)
    }

    fn delete(&mut self, range: Range<usize>) -> Edit {
        if range.is_empty() {
            return Edit::Ignored;
        }
        self.replace(range, "", Kind::Deleting);
        Edit::Changed
    }

    fn replace(&mut self, range: Range<usize>, with: &str, kind: Kind) {
        if kind != self.last || kind == Kind::Alone {
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
