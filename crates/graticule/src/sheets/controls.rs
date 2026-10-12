use super::*;

pub(super) fn checkbox(s: &mut Scene<Hit>, mut a: Area, sb: &Sandbox) {
    let pal = s.palette;
    caption(s, a.take_top(1), "Click to toggle.");
    a.take_top(1);
    for (i, label) in ["Show images", "Merge duplicates", "Publish I recommend"].into_iter().enumerate() {
        let id = Id::new("sheet.checkbox").child(i as u64);
        let row = a.take_top(2).line(0);
        let r = s.rect(row.at(0, 0, 4 + label.len() as i32, 1));
        s.hover(r);
        let on = sb.on(id);
        let rr = s.rect(row);
        s.checkbox(rr.x, rr.y, on);
        s.write(row.at(4, 0, row.cols - 4, 1), label, s.m.prop(400.0), pal.ink);
        s.hit(r, Hit::Toggle(id));
    }
}

pub(super) fn field(s: &mut Scene<Hit>, mut a: Area, sb: &Sandbox) {
    caption(s, a.take_top(1), "Click a field to type; Escape leaves it.");
    a.take_top(1);
    for (i, placeholder) in ["filter: is: in: from: or words", "a feed or page address", "a name"].into_iter().enumerate() {
        let id = Id::new("sheet.field").child(i as u64);
        let row = a.take_top(2).line(0).at(0, 0, a.cols.min(48), 1);
        let r = s.rect(row);
        let empty = Field::default();
        s.field(r, sb.field(id).unwrap_or(&empty), sb.is_focused(id), placeholder);
        s.hit(r, Hit::Focus(id, None));
    }
}

const DRAFT: &str = "Dear friend,\n\nThis is a text area: it wraps at its edge, keeps a newline where you press Return, and scrolls to keep the caret in view.\n\nUp and down move by the lines you see, Home and End go to their ends, Cmd with the arrows goes to the start or end of everything, and the Emacs keys work as they do in any Mac text field.";

pub(super) fn text_area(s: &mut Scene<Hit>, mut a: Area, sb: &Sandbox) {
    caption(s, a.take_top(1), "Click to edit. Return starts a new line; Escape leaves it.");
    a.take_top(1);
    let id = Id::new("sheet.text_area");
    let seeded = Field::multiline(DRAFT);
    let f = sb.field(id).unwrap_or(&seeded);
    let r = s.rect(a.at(0, 0, a.cols.min(56), a.rows.min(12)));
    s.text_area(id, r, f, sb.is_focused(id), "write something");
    s.hit(r, Hit::Focus(id, Some(DRAFT)));
}

pub(super) fn choices(s: &mut Scene<Hit>, mut a: Area, sb: &Sandbox) {
    caption(s, a.take_top(1), "Click to change. A dropdown becomes a value that cycles in place, or a choice that opens inline.");
    a.take_top(1);
    let radio = Id::new("sheet.radio");
    caption(s, a.take_top(1), "radio");
    for (i, label) in ["Follows the system", "Light", "Dark"].into_iter().enumerate() {
        let on = sb.pick(radio).unwrap_or(0) == i;
        s.radio(a.take_top(1), label, on, Some(Hit::Pick(radio, i)));
    }
    a.take_top(1);
    caption(s, a.take_top(1), "switch");
    let sw = Id::new("sheet.switch");
    s.switch(a.take_top(1), "Publish I recommend", sb.on(sw), Some(Hit::Toggle(sw)));
    s.switch(a.take_top(1), "Disabled and off", false, None);
    a.take_top(1);
    caption(s, a.take_top(1), "cycle");
    let cy = Id::new("sheet.cycle");
    let options = ["light", "heavy", "double", "dotted", "ascii"];
    let i = sb.pick(cy).unwrap_or(0);
    s.cycle(a.take_top(1), "lines", options[i % options.len()], Some(Hit::Pick(cy, (i + 1) % options.len())));
    s.cycle(a.take_top(1), "disabled", "fixed", None);
    a.take_top(1);
    caption(s, a.take_top(1), "a choice opens into its options, pushing what's below down");
    let ch = Id::new("sheet.choice");
    let open = ch.named("open");
    let options = ["follows the system", "light", "dark", "high contrast light", "high contrast dark", "sepia"];
    let c = Choice { label: "appearance", options: &options, current: sb.pick(ch).unwrap_or(0), open: sb.on(open) };
    let rows = s.choice(a, c, Hit::Toggle(open), |i| Hit::Pick(ch, i));
    a.take_top(rows);
    a.take_top(1);
    caption(s, a.take_top(1), "this line moves down while the choice is open");
}

pub(super) fn steppers(s: &mut Scene<Hit>, mut a: Area, sb: &Sandbox) {
    caption(s, a.take_top(1), "Steppers change a number by one; progress fills from the left.");
    a.take_top(1);
    let st = Id::new("sheet.stepper");
    let n = sb.pick(st).unwrap_or(30);
    let row = a.take_top(2);
    caption(s, row.at(0, 0, 18, 1), "refresh every");
    let used = s.stepper(row.at(20, 0, 20, 1), &format!("{n:>3} min"), (n > 5).then_some(Hit::Pick(st, n.saturating_sub(5))), (n < 240).then_some(Hit::Pick(st, n + 5)));
    let _ = used;
    a.take_top(1);
    for f in [0.0, 0.13, 0.5, 0.87, 1.0] {
        let row = a.take_top(2);
        caption(s, row.at(0, 0, 18, 1), &format!("{:.0}%", f * 100.0));
        s.progress(row.at(20, 0, 40, 1), f);
    }
}
