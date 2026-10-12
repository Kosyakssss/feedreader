use super::*;

pub(super) const PROSE: &str = "A graticule is the grid ruled on an instrument's screen, so that what it shows can be read against it. Everything here sits on one: boxes, rules, columns and controls start and end on cell edges, and text in either face shares a baseline on a row. Proportional text flows inside its box; only the box is on the grid.";

pub(super) fn grid(s: &mut Scene<Hit>, mut a: Area, _: &Sandbox) {
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

pub(super) fn ink(s: &mut Scene<Hit>, mut a: Area, _: &Sandbox) {
    let pal = s.palette;
    let mono = s.m.mono();
    let prop = s.m.prop(400.0);
    let lch = |c: [f32; 4]| {
        let (l, c, h) = to_oklch(c);
        if c < 0.001 { format!("{l:.3} {c:.3}    -") } else { format!("{l:.3} {c:.3} {h:>4.0}") }
    };
    let verdict = |ratio: f32, target: f32| if ratio >= target { ("passes", pal.ok) } else { ("fails", pal.danger) };
    caption(s, a.take_top(1), "Inks are defined in OKLCH: lightness, chroma, hue. Accents share one lightness and differ only in hue.");
    caption(s, a.take_top(1), "Contrast on the background and on the cursor row: text needs 4.5:1, faint (hints, disabled) 3:1.");
    a.take_top(1);
    let head = a.take_top(2);
    s.write(head.at(16, 0, 18, 1), "L     C      H", mono, pal.muted);
    s.write(head.at(84, 0, 20, 1), "bg · cursor", mono, pal.muted);
    let texts = [("ink", pal.ink, 4.5), ("muted", pal.muted, 4.5), ("faint", pal.faint, 3.0), ("link", pal.link, 4.5), ("visited", pal.visited, 4.5), ("danger", pal.danger, 4.5), ("warn", pal.warn, 4.5), ("ok", pal.ok, 4.5)];
    for (name, color, target) in texts {
        let row = a.take_top(2);
        let swatch = s.rect(row.at(0, 0, 4, 1));
        s.fill(swatch, color);
        s.write(row.at(6, 0, 10, 1), name, mono, pal.ink);
        s.write(row.at(16, 0, 18, 1), &lch(color), mono, pal.muted);
        s.write(row.at(35, 0, 24, 1), "Sample text in this ink", prop, color);
        let cursor = s.rect(row.at(60, 0, 22, 1));
        s.fill(cursor, pal.cursor);
        s.write(row.at(60, 0, 22, 1), "on the cursor row", prop, color);
        let (on_bg, on_cursor) = (contrast(color, pal.bg), contrast(color, pal.cursor));
        let (word, tone) = verdict(on_bg.min(on_cursor), target);
        s.write(row.at(84, 0, 16, 1), &format!("{on_bg:.1} · {on_cursor:.1}"), mono, pal.ink);
        s.write(row.at(100, 0, 8, 1), word, mono, tone);
    }
    caption(s, a.take_top(1), "Lines");
    a.take_top(1);
    let row = a.take_top(2);
    s.write(row.at(6, 0, 10, 1), "rule", mono, pal.ink);
    s.write(row.at(16, 0, 18, 1), &lch(pal.rule), mono, pal.muted);
    s.rule(row.at(35, 0, 47, 1));
    s.write(row.at(84, 0, 16, 1), &format!("{:.1}", contrast(pal.rule, pal.bg)), mono, pal.ink);
    caption(s, a.take_top(1), "Surfaces sit behind ink; each shows ink and muted text on it.");
    a.take_top(1);
    let surfaces = [("cursor", pal.cursor), ("hover", pal.hover), ("selection", pal.selection), ("field", pal.field), ("background", pal.bg)];
    for (name, color) in surfaces {
        let row = a.take_top(2);
        let swatch = s.rect(row.at(0, 0, 4, 1));
        s.fill(swatch, color);
        s.frame(row.at(0, 0, 4, 1));
        s.write(row.at(6, 0, 10, 1), name, mono, pal.ink);
        s.write(row.at(16, 0, 18, 1), &lch(color), mono, pal.muted);
        let r = s.rect(row.at(35, 0, 47, 1));
        s.fill(r, color);
        s.write(row.at(36, 0, 14, 1), "Ink on it", prop, pal.ink);
        s.write(row.at(52, 0, 20, 1), "muted on it", prop, pal.muted);
        let (word, tone) = verdict(contrast(pal.muted, color), 4.5);
        s.write(row.at(84, 0, 16, 1), &format!("{:.1} · {:.1}", contrast(pal.ink, color), contrast(pal.muted, color)), mono, pal.ink);
        s.write(row.at(100, 0, 8, 1), word, mono, tone);
    }
}

pub(super) fn type_sheet(s: &mut Scene<Hit>, mut a: Area, _: &Sandbox) {
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
    let row = a.take_top(2);
    caption(s, row.at(0, 0, 24, 1), "other scripts");
    let r = s.rect(row.at(26, 0, row.cols - 26, 1));
    let style = s.m.prop(400.0);
    s.text("Привет · Γειά σου · مرحبا · שלום · नमस्ते · สวัสดี · ∑ ∫ ⊕", style, r.x, r.y, Some(r.w), pal.ink);
    let row = a.take_top(2);
    caption(s, row.at(0, 0, 24, 1), "East Asian scripts");
    for (i, sample) in ["你好，世界", "こんにちは、世界", "안녕하세요"].into_iter().enumerate() {
        let r = s.rect(row.at(26 + i as i32 * 18, 0, 17, 1));
        s.text(sample, style, r.x, r.y, Some(r.w), pal.ink);
    }
    a.take_top(1);
    caption(s, a.take_top(1), "Prose wraps inside its box:");
    let r = s.rect(a.at(0, 0, a.cols.min(72), a.rows));
    s.paragraph(PROSE, TextStyle { face: Face::Prop, size, weight: 400.0 }, s.m.cell_h, (r.x, r.y), r.w, pal.ink);
}

pub(super) fn lines(s: &mut Scene<Hit>, mut a: Area, _: &Sandbox) {
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

pub(super) fn characters(s: &mut Scene<Hit>, mut a: Area, _: &Sandbox) {
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

pub(super) fn values(s: &mut Scene<Hit>, mut a: Area, _: &Sandbox) {
    caption(s, a.take_top(1), "Each kind of value has one look everywhere; a badge says what something is, never what to do.");
    a.take_top(1);
    let rows: [(&str, Value); 12] = [
        ("text", Value::Text("Plain facts are plain text")),
        ("count", Value::Count("1,284")),
        ("date", Value::Date(Moment(s.now.0 - 7_200))),
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
    for v in [Value::Product("SP-01"), Value::State("prod", Tone::Ok), Value::Version("v0.1.0"), Value::Date(Moment(s.now.0 - 90_000)), Value::Count("3 feeds")] {
        col += s.value(row.at(col, 0, row.cols - col, 1), v) + 1;
    }
    a.take_top(1);
    caption(s, a.take_top(1), "Dates in every form; \"date\" and \"time\" above choose the one used everywhere.");
    let forms = [
        ("date and time", Dates { date: DateForm::Absolute, time: TimeForm::Absolute }),
        ("date only", Dates { date: DateForm::Absolute, time: TimeForm::Off }),
        ("relative date, time", Dates { date: DateForm::Relative, time: TimeForm::Absolute }),
        ("relative date", Dates { date: DateForm::Relative, time: TimeForm::Off }),
        ("relative", Dates { date: DateForm::Relative, time: TimeForm::Relative }),
    ];
    let head = a.take_top(1);
    for (j, (name, _)) in forms.iter().enumerate() {
        caption(s, head.at(j as i32 * 22, 0, 21, 1), name);
    }
    let mono = s.m.mono();
    let ink = s.palette.ink;
    for ago in [20, 1_500, 18_000, 86_400, 345_600, 1_814_400, 13_000_000, 70_000_000] {
        let row = a.take_top(1);
        for (j, (_, form)) in forms.iter().enumerate() {
            let text = form.format(Moment(s.now.0 - ago), s.now);
            s.write(row.at(j as i32 * 22, 0, 21, 1), &text, mono, ink);
        }
    }
}

pub(super) fn pictures(s: &mut Scene<Hit>, mut a: Area, _: &Sandbox) {
    caption(s, a.take_top(1), "Pictures are SVG compiled by EN-01 Engraver into shapes in semantic ink; each has a label, shown in the ASCII style.");
    a.take_top(1);
    let all: [&'static crate::picture::Picture; 4] = [&crate::picture::GRATICULE, &crate::picture::FEED, &crate::picture::FOLDER, &crate::picture::WARNING];
    for (rows, cols) in [(1, 2), (2, 4), (4, 8), (8, 16)] {
        caption(s, a.take_top(1), &format!("{rows} rows"));
        let row = a.take_top(rows);
        let mut col = 0;
        for p in all {
            s.picture(row.at(col, 0, cols, rows), p);
            col += cols + 2;
        }
        a.take_top(1);
    }
    let row = a.take_top(1);
    let mut col = 0;
    for p in all {
        let mono = s.m.mono();
        let muted = s.palette.muted;
        let w = p.label.len() as i32;
        s.write(row.at(col, 0, w, 1), p.label, mono, muted);
        col += 18;
    }
}

const POSTS: [f32; 24] = [2.0, 3.0, 1.0, 4.0, 6.0, 5.0, 3.0, 7.0, 9.0, 6.0, 4.0, 5.0, 8.0, 11.0, 9.0, 7.0, 6.0, 8.0, 10.0, 12.0, 9.0, 8.0, 11.0, 13.0];

pub(super) fn canvas(s: &mut Scene<Hit>, mut a: Area, sb: &Sandbox) {
    use crate::canvas::{Canvas, Label, Mark, Path, Shape, Weight};
    use crate::picture::Ink;
    caption(s, a.take_top(1), "A canvas holds shapes in its own coordinates, in semantic ink and weights; points can be hovered and clicked.");
    a.take_top(1);
    let id = Id::new("sheet.canvas");
    let (w, h) = (240.0, 100.0);
    let n = (POSTS.len() - 1) as f32;
    let at = |i: usize| (10.0 + i as f32 / n * (w - 20.0), h - 10.0 - POSTS[i] / 14.0 * (h - 20.0));
    let line: Vec<(f32, f32)> = (0..POSTS.len()).map(at).collect();
    let mut area = Path::new().move_to(10.0, h - 10.0);
    for (x, y) in &line {
        area = area.line_to(*x, *y);
    }
    area = area.line_to(w - 10.0, h - 10.0).close();
    let mut marks = vec![
        Mark { shape: Shape::Path(area), ink: Ink::Field, stroke: None, id: None },
        Mark { shape: Shape::Path(Path::polyline(&[(10.0, 10.0), (10.0, h - 10.0), (w - 10.0, h - 10.0)])), ink: Ink::Muted, stroke: Some(Weight::Thin), id: None },
    ];
    for y in [30.0, 50.0, 70.0] {
        marks.push(Mark { shape: Shape::Path(Path::polyline(&[(10.0, y), (w - 10.0, y)])), ink: Ink::Rule, stroke: Some(Weight::Thin), id: None });
    }
    marks.push(Mark { shape: Shape::Path(Path::polyline(&line)), ink: Ink::Ink, stroke: Some(Weight::Regular), id: None });
    let picked = sb.pick(id);
    for (i, (x, y)) in line.iter().enumerate() {
        let ink = if picked == Some(i) { Ink::Danger } else { Ink::Link };
        marks.push(Mark { shape: Shape::Dot(*x, *y), ink, stroke: None, id: Some(i as u64) });
    }
    let value = picked.map(|i| format!("week {}: {} posts", i + 1, POSTS[i]));
    let mut labels = vec![Label { x: 12.0, y: 6.0, text: "posts a week", ink: Ink::Muted }];
    if let Some(v) = &value {
        labels.push(Label { x: 120.0, y: 6.0, text: v, ink: Ink::Danger });
    }
    let chart = a.take_top(14).at(0, 0, a.cols.min(80), 14);
    s.canvas(chart, Canvas { width: w, height: h, marks: &marks, labels: &labels, live: false }, |under| under.map(|i| Hit::Pick(id, i as usize)));
    a.take_top(1);
    caption(s, a.take_top(1), "sparklines, a canvas one row tall");
    for (name, ink) in [("Robin's notes", Ink::Ink), ("Ars Technica", Ink::Link), ("A feed that fails", Ink::Danger)] {
        let row = a.take_top(1);
        let style = s.m.prop(400.0);
        let ink_color = s.palette.ink;
        s.write(row.at(0, 0, 20, 1), name, style, ink_color);
        s.sparkline(row.at(22, 0, 24, 1), &POSTS, ink);
    }
    a.take_top(1);
    let live = Id::new("sheet.live");
    let on = sb.on(live);
    s.switch(a.take_top(1), "Live: a canvas may ask for frames only while it moves", on, Some(Hit::Toggle(live)));
    let clock = a.take_top(8).at(0, 0, 16, 8);
    let t = if on { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f32()) } else { 0.0 };
    let (cx, cy, r) = (50.0, 50.0, 40.0);
    let angle = t * std::f32::consts::TAU / 60.0;
    let hand = Path::polyline(&[(cx, cy), (cx + angle.sin() * r * 0.85, cy - angle.cos() * r * 0.85)]);
    let face = [
        Mark { shape: Shape::Path(Path::circle(cx, cy, r)), ink: Ink::Rule, stroke: Some(Weight::Regular), id: None },
        Mark { shape: Shape::Path(hand), ink: Ink::Danger, stroke: Some(Weight::Heavy), id: None },
    ];
    s.canvas(clock, Canvas { width: 100.0, height: 100.0, marks: &face, labels: &[], live: on }, |_| None);
}
