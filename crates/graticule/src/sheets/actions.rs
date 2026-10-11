use super::*;

pub(super) fn buttons(s: &mut Scene<Hit>, mut a: Area, _: &Sandbox) {
    caption(s, a.take_top(1), "What you can act on is boxed, with a hard shadow, so it reads as actionable without hovering.");
    a.take_top(1);
    let id = Id::new("sheet.buttons");
    for (title, kind, label) in [("normal", Kind::Normal, "Refresh"), ("primary", Kind::Primary, "Subscribe"), ("danger", Kind::Danger, "Remove feed")] {
        state_rows(s, &mut a, title, |s, at, enabled| {
            s.button(at, label, kind, enabled.then_some(Hit::Bump(id)));
        });
    }
}

pub(super) fn actions(s: &mut Scene<Hit>, mut a: Area, _: &Sandbox) {
    caption(s, a.take_top(1), "Key labels name a key; an action is its keys and its label, clickable as a whole.");
    a.take_top(1);
    let row = a.take_top(2);
    let mut col = 0;
    for chord in [Chord::ch('j'), Chord::ch('/'), Chord::cmd('k'), Chord::cmd_shift('z'), Chord::key(Key::Escape), Chord::key(Key::Enter), Chord::key(Key::Up)] {
        col += s.key_label(row.at(col, 0, row.cols - col, 1), &chord) + 2;
    }
    let id = Id::new("sheet.actions");
    state_rows(s, &mut a, "an action", |s, at, enabled| {
        s.action(at, &[Chord::ch('m')], "mark read", enabled.then_some(Hit::Bump(id)));
    });
    caption(s, a.take_top(1), "an action bar wraps instead of hiding anything");
    let bar = a.take_top(3);
    let items: [(&[Chord], &str); 8] = [
        (&[Chord::ch('j'), Chord::ch('k')], "next, previous"),
        (&[Chord::ch('o')], "open"),
        (&[Chord::ch('m')], "mark read"),
        (&[Chord::ch('s')], "bookmark"),
        (&[Chord::ch('x')], "select"),
        (&[Chord::ch('r')], "refresh"),
        (&[Chord::ch('/')], "filter"),
        (&[Chord::ch('?')], "help"),
    ];
    let (mut col, mut line) = (0, 0);
    for (keys, label) in items {
        let need = keys.iter().map(|k| k.label().chars().count() as i32 + 2).sum::<i32>() + label.len() as i32 + 3;
        if col + need > bar.cols.min(64) {
            col = 0;
            line += 1;
        }
        col += s.action(bar.at(col, line, bar.cols - col, 1), keys, label, Some(Hit::Bump(id))) + 3;
    }
}

pub(super) fn links(s: &mut Scene<Hit>, mut a: Area, _: &Sandbox) {
    caption(s, a.take_top(1), "Links go somewhere; they are underlined in the link ink.");
    a.take_top(1);
    let id = Id::new("sheet.links");
    state_rows(s, &mut a, "a link", |s, at, _| {
        s.link(at, "usgraphics.com", Hit::Bump(id));
    });
}
