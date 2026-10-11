use proptest::prelude::*;

use crate::commands::Key;
use crate::field::{Edit, Field, Keys};
use crate::state::{Layout, Scroll};

fn key() -> impl Strategy<Value = (Key, Keys)> {
    let keys = prop_oneof![
        Just(Key::Left),
        Just(Key::Right),
        Just(Key::Home),
        Just(Key::End),
        Just(Key::Backspace),
        Just(Key::Delete),
        Just(Key::Char('a')),
        Just(Key::Char('e')),
        Just(Key::Char('k')),
        Just(Key::Char('y')),
        Just(Key::Char('x')),
        Just(Key::Char('d')),
    ];
    (keys, any::<(bool, bool, bool, bool)>()).prop_map(|(k, (shift, alt, primary, control))| (k, Keys { shift, alt, primary, control }))
}

#[derive(Clone, Debug)]
enum Step {
    Type(String),
    Press(Key, Keys),
    Click(usize, bool),
    Word(usize),
}

fn step() -> impl Strategy<Value = Step> {
    prop_oneof![
        "[a-z é_.]{1,4}".prop_map(Step::Type),
        key().prop_map(|(k, m)| Step::Press(k, m)),
        (0usize..40, any::<bool>()).prop_map(|(at, extend)| Step::Click(at, extend)),
        (0usize..40).prop_map(Step::Word),
    ]
}

fn apply(f: &mut Field, step: &Step) {
    match step {
        Step::Type(t) => f.insert(t),
        Step::Press(k, m) => {
            if f.key(*k, *m) == Edit::Paste {
                f.insert("pasted");
            }
        }
        Step::Click(at, extend) => f.place(*at, *extend),
        Step::Word(at) => f.select_word(*at),
    }
}

fn valid(f: &Field) -> bool {
    [f.caret, f.anchor].iter().all(|&i| i <= f.text.len() && f.text.is_char_boundary(i))
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    #[test]
    fn field_undo_returns_to_the_start_and_redo_to_the_end(start in "[a-z é]{0,12}", steps in prop::collection::vec(step(), 0..40)) {
        let mut f = Field::with(&start);
        for s in &steps {
            apply(&mut f, s);
            prop_assert!(valid(&f), "caret {} anchor {} in {:?}", f.caret, f.anchor, f.text);
        }
        let end = f.text.clone();
        while f.undo() {
            prop_assert!(valid(&f));
        }
        prop_assert_eq!(&f.text, &start);
        while f.redo() {
            prop_assert!(valid(&f));
        }
        prop_assert_eq!(&f.text, &end);
    }
}

#[derive(Clone, Debug)]
enum Change {
    Insert(usize, usize),
    Remove(usize),
    Wheel(f32),
    Cursor(usize),
}

fn change() -> impl Strategy<Value = Change> {
    prop_oneof![
        (0usize..300, 1usize..6).prop_map(|(at, n)| Change::Insert(at, n)),
        (0usize..300).prop_map(Change::Remove),
        (-400.0f32..400.0).prop_map(Change::Wheel),
        (0usize..300).prop_map(Change::Cursor),
    ]
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    #[test]
    fn a_list_keeps_what_you_are_looking_at(start in 1usize..120, rows in 1usize..4, view in 3usize..30, smooth: bool, changes in prop::collection::vec(change(), 0..40)) {
        let item = rows as f32 * 10.0;
        let step = (!smooth).then_some(10.0);
        let mut keys: Vec<u64> = (0..start as u64).collect();
        let mut next = start as u64;
        let mut cursor: Option<usize> = None;
        let mut s = Scroll::default();
        let lay = |s: &mut Scroll, keys: &[u64], cursor: Option<usize>| {
            s.layout(Layout { count: keys.len(), item, view: view as f32 * 10.0, cursor, step }, |i| keys[i]);
        };
        lay(&mut s, &keys, cursor);
        for c in &changes {
            let before = (s.key, s.offset, s.total() >= s.max());
            match c {
                Change::Insert(at, n) => {
                    let at = (*at).min(keys.len());
                    for _ in 0..*n {
                        keys.insert(at, next);
                        next += 1;
                    }
                    cursor = cursor.map(|c| if c >= at { c + n } else { c });
                    lay(&mut s, &keys, cursor);
                    if !before.2 {
                        prop_assert_eq!(s.key, before.0, "the top entry moved");
                        prop_assert_eq!(s.offset, before.1, "the top entry shifted");
                    }
                }
                Change::Remove(at) => {
                    if keys.len() > 1 {
                        let at = at % keys.len();
                        keys.remove(at);
                        cursor = cursor.and_then(|c| if c == at { None } else if c > at { Some(c - 1) } else { Some(c) });
                        lay(&mut s, &keys, cursor);
                    }
                }
                Change::Wheel(dy) => {
                    s.wheel(*dy, step);
                    lay(&mut s, &keys, cursor);
                }
                Change::Cursor(c) => {
                    let moved = cursor != Some(c % keys.len());
                    cursor = Some(c % keys.len());
                    lay(&mut s, &keys, cursor);
                    let c = cursor.unwrap_or(0) as f32 * item;
                    if moved && item <= s.view {
                        prop_assert!(c >= s.total() - 0.01 && c + item <= s.total() + s.view + 0.01, "the cursor is out of view");
                    }
                }
            }
            prop_assert!(s.total() >= 0.0 && s.total() <= s.max() + 0.01);
        }
    }
}
