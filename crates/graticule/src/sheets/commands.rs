use super::*;

#[derive(Clone, Copy, PartialEq)]
enum Demo {
    Next,
    Previous,
    Open,
    Read,
    Bookmark,
    Select,
    Refresh,
    Filter,
    Help,
    Palette,
    Undo,
}

fn demo() -> &'static Registry<Demo, ()> {
    static REGISTRY: std::sync::OnceLock<Registry<Demo, ()>> = std::sync::OnceLock::new();
    REGISTRY.get_or_init(|| {
        let make = |id, keys: Vec<Chord>, label: fn(&()) -> String, available: fn(&()) -> bool, rank| Command { id, keys, label, available, rank };
        Registry {
            commands: vec![
                make(Demo::Next, vec![Chord::ch('j'), Chord::key(Key::Down)], |_| "next".into(), |_| true, 0),
                make(Demo::Previous, vec![Chord::ch('k'), Chord::key(Key::Up)], |_| "previous".into(), |_| true, 0),
                make(Demo::Open, vec![Chord::ch('o')], |_| "open".into(), |_| true, 1),
                make(Demo::Read, vec![Chord::ch('m')], |_| "mark read".into(), |_| true, 1),
                make(Demo::Bookmark, vec![Chord::ch('s')], |_| "bookmark".into(), |_| true, 1),
                make(Demo::Select, vec![Chord::ch('x')], |_| "select".into(), |_| true, 2),
                make(Demo::Refresh, vec![Chord::ch('r')], |_| "refresh".into(), |_| true, 3),
                make(Demo::Filter, vec![Chord::ch('/')], |_| "filter".into(), |_| true, 3),
                make(Demo::Undo, vec![Chord::cmd('z')], |_| "undo".into(), |_| false, 3),
                make(Demo::Palette, vec![Chord::cmd('k')], |_| "palette".into(), |_| true, 4),
                make(Demo::Help, vec![Chord::ch('?')], |_| "help".into(), |_| true, 4),
            ],
        }
    })
}

pub(super) fn commands(s: &mut Scene<Hit>, mut a: Area, _: &Sandbox) {
    caption(s, a.take_top(1), "The action bar and help are generated from the command registry, so every available action is on screen.");
    a.take_top(1);
    let id = Id::new("sheet.commands");
    caption(s, a.take_top(1), "action bar, wide");
    s.action_bar(a.take_top(3), demo(), &(), |_| Hit::Bump(id));
    caption(s, a.take_top(1), "action bar, narrow (36 columns, two rows)");
    s.action_bar(a.take_top(3).at(0, 0, 36, 2), demo(), &(), |_| Hit::Bump(id));
    caption(s, a.take_top(1), "help: every command, unavailable ones faint");
    s.help(a.take_top(12), demo(), &(), |_| Hit::Bump(id));
}

const ITEMS: [(&str, &str); 14] = [
    ("How the grid works", "entry"),
    ("Robin's notes", "feed"),
    ("Release notes 0.1", "entry"),
    ("Refresh all feeds", "command"),
    ("Bookmarks", "place"),
    ("Mark all read in this list", "command"),
    ("Friends", "folder"),
    ("Graticule, a framework for native apps", "entry"),
    ("Remove this feed", "command"),
    ("I recommend", "place"),
    ("Settings", "place"),
    ("The quiet web, again", "entry"),
    ("Show the grid", "command"),
    ("Hacker News: Front", "feed"),
];

fn subsequence(query: &str, label: &str) -> Option<Vec<std::ops::Range<usize>>> {
    let mut want = query.chars().filter(|c| !c.is_whitespace()).map(|c| c.to_ascii_lowercase()).peekable();
    let mut out: Vec<std::ops::Range<usize>> = Vec::new();
    for (i, c) in label.char_indices() {
        if want.peek().is_some_and(|w| *w == c.to_ascii_lowercase()) {
            want.next();
            let end = i + c.len_utf8();
            match out.last_mut() {
                Some(last) if last.end == i => last.end = end,
                _ => out.push(i..end),
            }
        }
    }
    want.peek().is_none().then_some(out)
}

pub(super) fn palette(s: &mut Scene<Hit>, mut a: Area, sb: &Sandbox) {
    caption(s, a.take_top(1), "The palette finds entries, feeds, places and commands by the letters you type, in order.");
    a.take_top(1);
    let id = Id::new("sheet.palette");
    let field = sb.field(id).cloned().unwrap_or_else(|| Field::with("re"));
    let matches: Vec<(usize, Vec<std::ops::Range<usize>>)> = ITEMS.iter().enumerate().filter_map(|(i, (label, _))| subsequence(&field.text, label).map(|m| (i, m))).collect();
    let found: Vec<Found> = matches.iter().map(|(i, m)| Found { label: ITEMS[*i].0, detail: ITEMS[*i].1, matched: m }).collect();
    let r = a.at(0, 0, a.cols.min(80), a.rows.min(16));
    let p = Palette { id: id.named("list"), field: &field, focused: sb.is_focused(id), found: &found, cursor: sb.pick(id.named("cursor")).or(Some(0)) };
    s.palette(p, r, |i| Hit::Pick(id.named("cursor"), i));
    s.hit(s.rect(r.line(0)), Hit::Focus(id, None));
}
