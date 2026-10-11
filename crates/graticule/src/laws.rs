use proptest::prelude::*;

use crate::commands::Key;
use crate::field::{Edit, Field, Keys};

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
