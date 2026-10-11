use super::*;

pub(super) fn list(s: &mut Scene<Hit>, mut a: Area, sb: &Sandbox) {
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

pub(super) fn scroll_area(s: &mut Scene<Hit>, mut a: Area, _: &Sandbox) {
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
