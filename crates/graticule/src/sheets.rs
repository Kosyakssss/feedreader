use crate::commands::{Chord, Key};
use crate::field::Field;
use crate::kit::{Kind, Tone, Value};
use crate::grid::Area;
use crate::specimen::{Hit, Sandbox, Sheet};
use crate::state::Id;
use crate::text::{Block, Face, SpanStyle, TextStyle};
use crate::ui::{List, Scene};

const PROSE: &str = "A graticule is the grid ruled on an instrument's screen, so that what it shows can be read against it. Everything here sits on one: boxes, rules, columns and controls start and end on cell edges, and text in either face shares a baseline on a row. Proportional text flows inside its box; only the box is on the grid.";

pub fn all() -> Vec<Sheet> {
    vec![
        Sheet::new("Foundations", "Grid", grid),
        Sheet::new("Foundations", "Ink", ink),
        Sheet::new("Foundations", "Type", type_sheet),
        Sheet::new("Foundations", "Lines", lines),
        Sheet::new("Foundations", "Characters", characters),
        Sheet::new("Foundations", "Values", values),
        Sheet::new("Actions", "Button", buttons),
        Sheet::new("Actions", "Keys and actions", actions),
        Sheet::new("Actions", "Link", links),
        Sheet::new("Controls", "Checkbox", checkbox),
        Sheet::new("Controls", "Radio, switch and cycle", choices),
        Sheet::new("Controls", "Stepper and progress", steppers),
        Sheet::new("Controls", "Field", field),
        Sheet::new("Controls", "Text area", text_area),
        Sheet::new("Scrolling", "List", list).filling(),
        Sheet::new("Scrolling", "Scroll area", scroll_area).filling(),
    ]
}

fn caption(s: &mut Scene<Hit>, a: Area, text: &str) {
    let muted = s.palette.muted;
    let mono = s.m.mono();
    s.write(a, text, mono, muted);
}

fn grid(s: &mut Scene<Hit>, mut a: Area, _: &Sandbox) {
    let (pal, mono) = (s.palette, s.m.mono());
    let facts = format!(
        "cell {} x {} px at scale {}, font {:.2} px, this sheet {} x {} cells",
        s.m.cell_w, s.m.cell_h, s.m.scale, s.m.size, a.cols, a.rows
    );
    caption(s, a.take_top(1), &facts);
    a.take_top(1);
    let ruler = a.take_top(1);
    let digits: String = (0..ruler.cols).map(|i| char::from_digit((i % 10) as u32, 10).unwrap_or(' ')).collect();
    s.write(ruler, &digits, mono, pal.faint);
    let tens: String = (0..ruler.cols).map(|i| if i % 10 == 0 { char::from_digit((i / 10 % 10) as u32, 10).unwrap_or(' ') } else { ' ' }).collect();
    s.write(a.take_top(1), &tens, mono, pal.muted);
    a.take_top(1);
    let row = a.take_top(1);
    let w = s.write(row, "Mono 0123456789", mono, pal.ink);
    let after = row.at((w / s.m.cell_w).ceil() as i32 + 1, 0, row.cols, 1);
    s.write(after, "and Sans share the row's baseline", s.m.prop(400.0), pal.ink);
    a.take_top(1);
    for (i, cols) in [1, 2, 4, 8, 16, 32].into_iter().enumerate() {
        let r = s.rect(Area::new(a.col, a.row + i as i32 * 2, cols, 1));
        s.fill(r, pal.ink);
        s.write(Area::new(a.col + 34, a.row + i as i32 * 2, 20, 1), &format!("{cols} cells"), mono, pal.muted);
    }
}

fn ink(s: &mut Scene<Hit>, mut a: Area, _: &Sandbox) {
    let pal = s.palette;
    let mono = s.m.mono();
    let inks = [
        ("ink", pal.ink),
        ("muted", pal.muted),
        ("faint", pal.faint),
        ("rule", pal.rule),
        ("link", pal.link),
        ("danger", pal.danger),
        ("warn", pal.warn),
        ("ok", pal.ok),
        ("cursor", pal.cursor),
        ("hover", pal.hover),
        ("selection", pal.selection),
        ("field", pal.field),
        ("background", pal.bg),
    ];
    for (name, color) in inks {
        let row = a.take_top(2);
        let swatch = s.rect(row.at(0, 0, 6, 1));
        s.fill(swatch, color);
        s.frame(row.at(0, 0, 6, 1));
        s.write(row.at(8, 0, 14, 1), name, mono, pal.ink);
        let hex: String = color[..3].iter().map(|c| format!("{:02x}", (c * 255.0).round() as u8)).collect();
        s.write(row.at(22, 0, 10, 1), &format!("#{hex}"), mono, pal.muted);
        s.write(row.at(34, 0, 30, 1), "Sample text in this ink", s.m.prop(400.0), color);
    }
}

fn type_sheet(s: &mut Scene<Hit>, mut a: Area, _: &Sandbox) {
    let pal = s.palette;
    let size = s.m.size;
    let samples: [(&str, Face, f32, bool); 8] = [
        ("Plex Mono 400", Face::Mono, 400.0, false),
        ("Plex Mono 600", Face::Mono, 600.0, false),
        ("Plex Mono 400 italic", Face::Mono, 400.0, true),
        ("Plex Sans 400", Face::Prop, 400.0, false),
        ("Plex Sans 500", Face::Prop, 500.0, false),
        ("Plex Sans 600", Face::Prop, 600.0, false),
        ("Plex Sans 700", Face::Prop, 700.0, false),
        ("Plex Sans 400 italic", Face::Prop, 400.0, true),
    ];
    for (name, face, weight, italic) in samples {
        let row = a.take_top(2);
        caption(s, row.at(0, 0, 24, 1), name);
        let r = s.rect(row.at(26, 0, row.cols - 26, 1));
        let span = SpanStyle { weight: weight as u16, italic, ..SpanStyle::plain(face) };
        let line = s.m.cell_h;
        s.spans(Block { spans: &[("The quick brown fox jumps over the lazy dog 0123456789", span)], size, line, wrap: None }, (r.x, r.y), Some(r.w), &[pal.ink]);
    }
    a.take_top(1);
    caption(s, a.take_top(1), "Prose wraps inside its box:");
    let r = s.rect(a.at(0, 0, a.cols.min(72), a.rows));
    s.paragraph(PROSE, TextStyle { face: Face::Prop, size, weight: 400.0 }, s.m.cell_h, (r.x, r.y), r.w, pal.ink);
}

fn lines(s: &mut Scene<Hit>, mut a: Area, _: &Sandbox) {
    caption(s, a.take_top(1), "Rules and boxes in the current line style; switch it with \"lines\" above.");
    a.take_top(1);
    let rule = a.take_top(1);
    s.rule(rule.at(0, 0, rule.cols.min(60), 1));
    a.take_top(1);
    let [left, mid, right] = a.take_top(8).columns([1, 1, 1], 2);
    s.frame(left);
    s.frame(mid.at(0, 0, mid.cols, 5));
    s.frame(right.at(0, 0, 6, 3));
    s.vrule(a.take_top(6).at(4, 0, 1, 6));
}

fn checkbox(s: &mut Scene<Hit>, mut a: Area, sb: &Sandbox) {
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

fn field(s: &mut Scene<Hit>, mut a: Area, sb: &Sandbox) {
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

fn list(s: &mut Scene<Hit>, mut a: Area, sb: &Sandbox) {
    let pal = s.palette;
    let mono = s.m.mono();
    let id = Id::new("sheet.list");
    let added = sb.bumps(id) * 3;
    let count = 500 + added as usize;
    let head = a.take_top(1);
    let label = "add 3 entries at the top";
    let button = head.at(0, 0, label.len() as i32 + 2, 1);
    let r = s.rect(button);
    s.hover(r);
    s.frame(Area::new(button.col - 1, button.row - 1, button.cols + 2, 3));
    s.write(button.at(1, 0, button.cols, 1), label, mono, pal.ink);
    s.hit(r, Hit::Bump(id));
    let note = "what you're looking at stays put; click a row to move the cursor";
    s.write(head.at(button.cols + 3, 0, head.cols - button.cols - 3, 1), note, mono, pal.muted);
    a.take_top(2);
    let cursor = sb.pick(id).map(|k| (added as usize + 499).saturating_sub(k)).filter(|&i| i < count);
    let key = |i: usize| (added + 499).saturating_sub(i as u64);
    s.list(List { id, count, rows: 2, cursor }, a, key, |s, i, row| {
        let k = key(i);
        let r = s.rect(row);
        if Some(i) == cursor {
            s.fill(r, pal.cursor);
        } else {
            s.hover(r);
        }
        s.write(row.at(1, 0, 8, 1), &format!("#{k}"), mono, pal.muted);
        s.write(row.at(10, 0, row.cols - 10, 1), &format!("Entry number {k}, two rows tall"), s.m.prop(500.0), pal.ink);
        s.write(row.at(10, 1, row.cols - 10, 1), "the second row holds the feed and the date", s.m.prop(400.0), pal.muted);
        s.hit(r, Hit::Pick(id, k as usize));
    });
}

fn scroll_area(s: &mut Scene<Hit>, mut a: Area, _: &Sandbox) {
    let pal = s.palette;
    caption(s, a.take_top(1), "A scroll area holds content of any height; the wheel and the scrollbar move it.");
    a.take_top(1);
    let text: String = (1..=12).map(|i| format!("{i}. {PROSE}\n\n")).collect();
    let width = s.rect(a).w - s.m.cell_w * 4.0;
    let size = s.m.size;
    let style = TextStyle { face: Face::Prop, size, weight: 400.0 };
    let span = SpanStyle::plain(Face::Prop);
    let height = s.text.height(&[(&text, span)], size, s.m.cell_h, width.min(s.m.cell_w * 72.0));
    s.scroll(Id::new("sheet.scroll"), a, height, |s, body| {
        let r = s.rect(body);
        s.paragraph(&text, style, s.m.cell_h, (r.x, r.y), r.w.min(s.m.cell_w * 72.0), pal.ink);
    });
}

fn characters(s: &mut Scene<Hit>, mut a: Area, _: &Sandbox) {
    let pal = s.palette;
    let mono = s.m.mono();
    caption(s, a.take_top(1), "Box drawing, blocks and braille are drawn by Graticule, so they meet at cell edges in any font.");
    a.take_top(1);
    for (title, from, to) in [("box drawing", 0x2500u32, 0x257F), ("blocks", 0x2580, 0x259F)] {
        caption(s, a.take_top(1), title);
        let mut line = String::new();
        for code in from..=to {
            line.push(char::from_u32(code).unwrap_or(' '));
            line.push(' ');
            if (code - from) % 32 == 31 || code == to {
                s.write(a.take_top(1), &line, mono, pal.ink);
                line.clear();
            }
        }
        a.take_top(1);
    }
    caption(s, a.take_top(1), "braille, two by four dots per cell");
    let braille: String = (0x2800u32..0x2840).filter_map(char::from_u32).collect();
    s.write(a.take_top(1), &braille, mono, pal.ink);
    a.take_top(1);
    caption(s, a.take_top(1), "joined, with no gaps between cells");
    for line in ["┌──┬──┐ ┏━━┳━━┓ ╔══╦══╗ ╭──┬──╮ ▛▀▀▜ ░▒▓█", "├──┼──┤ ┣━━╋━━┫ ╠══╬══╣ │  │  │ ▌  ▐ ▁▂▃▄▅▆▇█", "└──┴──┘ ┗━━┻━━┛ ╚══╩══╝ ╰──┴──╯ ▙▄▄▟ ╱╲╳"] {
        s.write(a.take_top(1), line, mono, pal.ink);
    }
}

const DRAFT: &str = "Dear friend,\n\nThis is a text area: it wraps at its edge, keeps a newline where you press Return, and scrolls to keep the caret in view.\n\nUp and down move by the lines you see, Home and End go to their ends, Cmd with the arrows goes to the start or end of everything, and the Emacs keys work as they do in any Mac text field.";

fn text_area(s: &mut Scene<Hit>, mut a: Area, sb: &Sandbox) {
    caption(s, a.take_top(1), "Click to edit. Return starts a new line; Escape leaves it.");
    a.take_top(1);
    let id = Id::new("sheet.text_area");
    let seeded = Field::multiline(DRAFT);
    let f = sb.field(id).unwrap_or(&seeded);
    let r = s.rect(a.at(0, 0, a.cols.min(56), a.rows.min(12)));
    s.text_area(id, r, f, sb.is_focused(id), "write something");
    s.hit(r, Hit::Focus(id, Some(DRAFT)));
}

fn forced<R>(s: &mut Scene<Hit>, a: Area, hover: bool, press: bool, f: impl FnOnce(&mut Scene<Hit>) -> R) -> R {
    let (pointer, pressed) = (s.pointer, s.pressed);
    let r = s.rect(a.at(0, 0, 2, 1));
    s.pointer = hover.then_some((r.x + r.w / 2.0, r.y + r.h / 2.0));
    s.pressed = press;
    let out = f(s);
    (s.pointer, s.pressed) = (pointer, pressed);
    out
}

const STATES: [(&str, bool, bool, bool); 4] = [("normal", false, false, true), ("hover", true, false, true), ("pressed", true, true, true), ("disabled", false, false, false)];

fn state_rows(s: &mut Scene<Hit>, a: &mut Area, title: &str, mut draw: impl FnMut(&mut Scene<Hit>, Area, bool)) {
    caption(s, a.take_top(1), title);
    let row = a.take_top(2);
    let mut col = 0;
    for (name, hover, press, enabled) in STATES {
        let cell = row.at(col, 0, 24, 2);
        caption(s, cell.line(1), name);
        forced(s, cell.line(0), hover, press, |s| draw(s, cell.line(0), enabled));
        col += 26;
    }
    a.take_top(1);
}

fn values(s: &mut Scene<Hit>, mut a: Area, _: &Sandbox) {
    caption(s, a.take_top(1), "Each kind of value has one look everywhere; a badge says what something is, never what to do.");
    a.take_top(1);
    let rows: [(&str, Value); 12] = [
        ("text", Value::Text("Plain facts are plain text")),
        ("count", Value::Count("1,284")),
        ("date", Value::Date("2026-10-11")),
        ("version", Value::Version("v0.1.0")),
        ("state, ok", Value::State("prod", Tone::Ok)),
        ("state, neutral", Value::State("hub", Tone::Neutral)),
        ("state, warn", Value::State("stale", Tone::Warn)),
        ("state, danger", Value::State("offline", Tone::Danger)),
        ("product", Value::Product("DK-01")),
        ("code", Value::Code("is:unread")),
        ("mode", Value::Mode("rows")),
        ("error", Value::Error("Couldn't reach the hub")),
    ];
    for (name, v) in rows {
        let row = a.take_top(2);
        caption(s, row.at(0, 0, 18, 1), name);
        s.value(row.at(20, 0, row.cols - 20, 1), v);
    }
    let row = a.take_top(2);
    caption(s, row.at(0, 0, 18, 1), "in a line");
    let mut col = 20;
    for v in [Value::Product("SP-01"), Value::State("prod", Tone::Ok), Value::Version("v0.1.0"), Value::Date("2026-10-11"), Value::Count("3 feeds")] {
        col += s.value(row.at(col, 0, row.cols - col, 1), v) + 1;
    }
}

fn buttons(s: &mut Scene<Hit>, mut a: Area, _: &Sandbox) {
    caption(s, a.take_top(1), "What you can act on is boxed, with a hard shadow, so it reads as actionable without hovering.");
    a.take_top(1);
    let id = Id::new("sheet.buttons");
    for (title, kind, label) in [("normal", Kind::Normal, "Refresh"), ("primary", Kind::Primary, "Subscribe"), ("danger", Kind::Danger, "Remove feed")] {
        state_rows(s, &mut a, title, |s, at, enabled| {
            s.button(at, label, kind, enabled.then_some(Hit::Bump(id)));
        });
    }
}

fn actions(s: &mut Scene<Hit>, mut a: Area, _: &Sandbox) {
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

fn links(s: &mut Scene<Hit>, mut a: Area, _: &Sandbox) {
    caption(s, a.take_top(1), "Links go somewhere; they are underlined in the link ink.");
    a.take_top(1);
    let id = Id::new("sheet.links");
    state_rows(s, &mut a, "a link", |s, at, _| {
        s.link(at, "usgraphics.com", Hit::Bump(id));
    });
}

fn choices(s: &mut Scene<Hit>, mut a: Area, sb: &Sandbox) {
    caption(s, a.take_top(1), "Click to change. A dropdown becomes a value that cycles in place.");
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
}

fn steppers(s: &mut Scene<Hit>, mut a: Area, sb: &Sandbox) {
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
