use crate::grid::Area;
use crate::specimen::{Hit, Sandbox, Sheet};
use crate::state::Id;
use crate::text::{Face, SpanStyle, TextStyle};
use crate::ui::{List, Scene};

const PROSE: &str = "A graticule is the grid ruled on an instrument's screen, so that what it shows can be read against it. Everything here sits on one: boxes, rules, columns and controls start and end on cell edges, and text in either face shares a baseline on a row. Proportional text flows inside its box; only the box is on the grid.";

pub fn all() -> Vec<Sheet> {
    vec![
        Sheet::new("Foundations", "Grid", grid),
        Sheet::new("Foundations", "Ink", ink),
        Sheet::new("Foundations", "Type", type_sheet),
        Sheet::new("Foundations", "Lines", lines),
        Sheet::new("Controls", "Checkbox", checkbox),
        Sheet::new("Controls", "Field", field),
        Sheet::new("Scrolling", "List", list),
        Sheet::new("Scrolling", "Scroll area", scroll_area),
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
        s.spans(&[("The quick brown fox jumps over the lazy dog 0123456789", span)], size, line, r.x, r.y, None, Some(r.w), &[pal.ink]);
    }
    a.take_top(1);
    caption(s, a.take_top(1), "Prose wraps inside its box:");
    let r = s.rect(a.at(0, 0, a.cols.min(72), a.rows));
    s.paragraph(PROSE, TextStyle { face: Face::Prop, size, weight: 400.0 }, s.m.cell_h, r.x, r.y, r.w, pal.ink);
}

fn lines(s: &mut Scene<Hit>, mut a: Area, _: &Sandbox) {
    caption(s, a.take_top(1), "Rules and boxes in the current line style; switch it with \"lines\" above.");
    a.take_top(1);
    let r = s.rect(a.take_top(1).at(0, 0, a.cols.min(60), 1));
    s.hline(r.y, r.x, r.right());
    a.take_top(1);
    let [left, mid, right] = a.take_top(8).columns([1, 1, 1], 2);
    s.frame(left);
    s.frame(mid.at(0, 0, mid.cols, 5));
    s.frame(right.at(0, 0, 6, 3));
    let r = s.rect(a.take_top(6).at(4, 0, 1, 6));
    s.vline(r.x, r.y, r.bottom());
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
        s.field(r, sb.field(id), sb.is_focused(id), placeholder);
        s.hit(r, Hit::Focus(id));
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
        s.paragraph(&text, style, s.m.cell_h, r.x, r.y, r.w.min(s.m.cell_w * 72.0), pal.ink);
    });
}
