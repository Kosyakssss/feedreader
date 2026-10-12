use super::*;

pub(super) fn spec_sheet(s: &mut Scene<Hit>, mut a: Area, _: &Sandbox) {
    caption(s, a.take_top(1), "A spec sheet is the whole running system as key and value, grouped.");
    a.take_top(1);
    let width = a.cols.min(72);
    let now = s.now;
    let groups: [(&str, &[(&str, Value)]); 3] = [
        ("Software", &[("Graticule", Value::Product("DK-01")), ("Version", Value::Version("v0.1.0")), ("Build", Value::Code("2026-10-11 f9750b4"))]),
        ("Engine", &[("Role", Value::State("hub", Tone::Neutral)), ("Paired devices", Value::Count("2")), ("Publishing", Value::State("public", Tone::Ok)), ("Last refresh", Value::Date(Moment(now.0 - 420)))]),
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

const FEEDS: [(&str, &str, i64, &str); 8] = [
    ("Robin's notes", "12", 600, "ok"),
    ("Ars Technica", "148", 1_320, "ok"),
    ("The Old New Thing", "3", 259_200, "ok"),
    ("A channel that moved", "0", 3_456_000, "moved"),
    ("Low-tech Magazine", "1", 345_600, "ok"),
    ("Hacker News: Front", "88", 60, "ok"),
    ("A feed that fails", "0", 6_048_000, "failing"),
    ("Julia Evans", "5", 432_000, "ok"),
];

pub(super) fn table(s: &mut Scene<Hit>, mut a: Area, sb: &Sandbox) {
    caption(s, a.take_top(1), "A table is a list with columns: titles over a rule, values in their own look, numbers to the right.");
    a.take_top(1);
    let id = Id::new("sheet.table");
    let columns = [
        Column { title: "Feed", cols: 28, align: Align::Left },
        Column { title: "Unread", cols: 8, align: Align::Right },
        Column { title: "Updated", cols: 18, align: Align::Left },
        Column { title: "State", cols: 10, align: Align::Left },
    ];
    let rows = 60;
    let now = s.now;
    s.table(Table { id, columns: &columns, count: rows, cursor: sb.pick(id) }, a, |i, j| {
        let f = FEEDS[i % FEEDS.len()];
        match j {
            0 => Value::Text(f.0),
            1 => Value::Count(f.1),
            2 => Value::Date(Moment(now.0 - f.2)),
            _ => match f.3 {
                "ok" => Value::State("ok", Tone::Ok),
                "moved" => Value::State("moved", Tone::Warn),
                _ => Value::State("failing", Tone::Danger),
            },
        }
    }, |i| Hit::Pick(id, i));
}

pub(super) fn tree(s: &mut Scene<Hit>, mut a: Area, sb: &Sandbox) {
    caption(s, a.take_top(1), "Which nodes fold is the app's choice: here the root stays put, places and folders fold.");
    a.take_top(1);
    let id = Id::new("sheet.tree");
    let items: [(&str, usize, Option<bool>); 12] = [
        ("Feedreader", 0, None),
        ("Places", 1, Some(true)),
        ("Home", 2, None),
        ("Bookmarks", 2, None),
        ("I recommend", 2, None),
        ("Folders", 1, Some(true)),
        ("Friends", 2, None),
        ("Work", 2, Some(false)),
        ("Clients", 3, None),
        ("Industry news", 3, None),
        ("Reading list", 2, None),
        ("Settings", 1, None),
    ];
    let nodes: Vec<Node> = items
        .iter()
        .enumerate()
        .map(|(i, (label, depth, open))| Node { label, depth: *depth, open: open.map(|o| o != sb.on(id.child(i as u64))) })
        .collect();
    let foldable: Vec<bool> = items.iter().map(|(_, _, open)| open.is_some()).collect();
    s.tree(a, &nodes, sb.pick(id), |i| if foldable[i] { Hit::Toggle(id.child(i as u64)) } else { Hit::Pick(id, i) });
}
