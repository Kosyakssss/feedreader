use super::*;

pub(super) fn spec_sheet(s: &mut Scene<Hit>, mut a: Area, _: &Sandbox) {
    caption(s, a.take_top(1), "A spec sheet is the whole running system as key and value, grouped.");
    a.take_top(1);
    let width = a.cols.min(72);
    let groups: [(&str, &[(&str, Value)]); 3] = [
        ("Software", &[("Graticule", Value::Product("DK-01")), ("Version", Value::Version("v0.1.0")), ("Build", Value::Code("2026-10-11 f9750b4"))]),
        ("Engine", &[("Role", Value::State("hub", Tone::Neutral)), ("Paired devices", Value::Count("2")), ("Publishing", Value::State("public", Tone::Ok)), ("Last refresh", Value::Date("10:52"))]),
        ("Frames", &[("Paint", Value::Count("0.31 ms")), ("Budget", Value::Count("1.00 ms")), ("Scrolling", Value::Mode("rows"))]),
    ];
    for (title, rows) in groups {
        s.spec_group(a.take_top(1).at(0, 0, width, 1), title);
        for (k, v) in rows {
            s.spec(a.take_top(1).at(0, 0, width, 1), k, *v, 24);
        }
        a.take_top(1);
    }
}

const FEEDS: [(&str, &str, &str, &str); 8] = [
    ("Robin's notes", "12", "10:52", "ok"),
    ("Ars Technica", "148", "10:40", "ok"),
    ("The Old New Thing", "3", "Fri", "ok"),
    ("A channel that moved", "0", "Sep 2026", "moved"),
    ("Low-tech Magazine", "1", "Thu", "ok"),
    ("Hacker News: Front", "88", "10:51", "ok"),
    ("A feed that fails", "0", "Aug 2026", "failing"),
    ("Julia Evans", "5", "Wed", "ok"),
];

pub(super) fn table(s: &mut Scene<Hit>, mut a: Area, sb: &Sandbox) {
    caption(s, a.take_top(1), "A table is a list with columns: titles over a rule, values in their own look, numbers to the right.");
    a.take_top(1);
    let id = Id::new("sheet.table");
    let columns = [
        Column { title: "Feed", cols: 28, align: Align::Left },
        Column { title: "Unread", cols: 8, align: Align::Right },
        Column { title: "Updated", cols: 10, align: Align::Left },
        Column { title: "State", cols: 10, align: Align::Left },
    ];
    let rows = 60;
    s.table(Table { id, columns: &columns, count: rows, cursor: sb.pick(id) }, a, |i, j| {
        let f = FEEDS[i % FEEDS.len()];
        match j {
            0 => Value::Text(f.0),
            1 => Value::Count(f.1),
            2 => Value::Date(f.2),
            _ => match f.3 {
                "ok" => Value::State("ok", Tone::Ok),
                "moved" => Value::State("moved", Tone::Warn),
                _ => Value::State("failing", Tone::Danger),
            },
        }
    }, |i| Hit::Pick(id, i));
}

pub(super) fn tree(s: &mut Scene<Hit>, mut a: Area, sb: &Sandbox) {
    caption(s, a.take_top(1), "A tree draws everything at once, like a sitemap; the help page and the folder tree can be one.");
    a.take_top(1);
    let id = Id::new("sheet.tree");
    let nodes = [
        Node { label: "Feedreader", depth: 0, last: true, open: Some(true) },
        Node { label: "Places", depth: 1, last: false, open: Some(true) },
        Node { label: "Home", depth: 2, last: false, open: None },
        Node { label: "Bookmarks", depth: 2, last: false, open: None },
        Node { label: "I recommend", depth: 2, last: true, open: None },
        Node { label: "Folders", depth: 1, last: false, open: Some(true) },
        Node { label: "Friends", depth: 2, last: false, open: None },
        Node { label: "Work", depth: 2, last: true, open: Some(false) },
        Node { label: "Settings", depth: 1, last: true, open: None },
    ];
    s.tree(a, &nodes, sb.pick(id), |i| Hit::Pick(id, i));
}
