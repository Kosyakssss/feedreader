#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Key {
    Char(char),
    Up,
    Down,
    Left,
    Right,
    Enter,
    Escape,
    Backspace,
    PageUp,
    PageDown,
    F(u8),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Chord {
    pub key: Key,
    pub cmd: bool,
    pub shift: bool,
}

impl Chord {
    pub const fn key(key: Key) -> Self {
        Self {
            key,
            cmd: false,
            shift: false,
        }
    }

    pub const fn ch(c: char) -> Self {
        Self::key(Key::Char(c))
    }

    pub const fn cmd(c: char) -> Self {
        Self {
            key: Key::Char(c),
            cmd: true,
            shift: false,
        }
    }

    pub const fn cmd_shift(c: char) -> Self {
        Self {
            key: Key::Char(c),
            cmd: true,
            shift: true,
        }
    }

    pub fn label(&self) -> String {
        let mut s = String::new();
        if self.shift {
            s.push('\u{21E7}');
        }
        if self.cmd {
            s.push('\u{2318}');
        }
        match self.key {
            Key::Char(c) => s.extend(if self.cmd { c.to_uppercase().collect::<Vec<_>>() } else { vec![c] }),
            Key::Up => s.push('\u{2191}'),
            Key::Down => s.push('\u{2193}'),
            Key::Left => s.push('\u{2190}'),
            Key::Right => s.push('\u{2192}'),
            Key::Enter => s.push_str("enter"),
            Key::Escape => s.push_str("esc"),
            Key::Backspace => s.push_str("bksp"),
            Key::PageUp => s.push_str("pgup"),
            Key::PageDown => s.push_str("pgdn"),
            Key::F(n) => s.push_str(&format!("F{n}")),
        }
        s
    }

    fn matches(&self, other: &Chord) -> bool {
        let key = match (self.key, other.key) {
            (Key::Char(a), Key::Char(b)) => a.eq_ignore_ascii_case(&b),
            (a, b) => a == b,
        };
        key && self.cmd == other.cmd && self.shift == other.shift
    }
}

pub struct Command<C, M> {
    pub id: C,
    pub keys: Vec<Chord>,
    pub label: fn(&M) -> String,
    pub available: fn(&M) -> bool,
}

pub struct Registry<C, M> {
    pub commands: Vec<Command<C, M>>,
}

impl<C: Copy + PartialEq, M> Registry<C, M> {
    pub fn lookup(&self, model: &M, chord: &Chord) -> Option<C> {
        self.commands
            .iter()
            .find(|c| (c.available)(model) && c.keys.iter().any(|k| k.matches(chord)))
            .map(|c| c.id)
    }

    pub fn available<'a>(&'a self, model: &'a M) -> impl Iterator<Item = &'a Command<C, M>> + 'a {
        self.commands.iter().filter(move |c| (c.available)(model))
    }

    pub fn is_available(&self, model: &M, id: C) -> bool {
        self.commands
            .iter()
            .any(|c| c.id == id && (c.available)(model))
    }
}

pub fn keys_label(keys: &[Chord]) -> String {
    keys.iter().map(Chord::label).collect::<Vec<_>>().join(" ")
}
