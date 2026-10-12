use super::*;

pub(super) fn navigation(s: &mut Scene<Hit>, mut a: Area, sb: &Sandbox) {
    caption(s, a.take_top(1), "Tabs are documents you opened; places are where lists live, the current one marked by a dot.");
    a.take_top(1);
    let tabs = Id::new("sheet.tabs");
    caption(s, a.take_top(1), "tabs");
    s.tabs(a.take_top(1), &["New tab", "How the grid works", "Release notes 0.1", "A very long article title that keeps going"], sb.pick(tabs).unwrap_or(1), |i| Hit::Pick(tabs, i));
    a.take_top(2);
    let places = Id::new("sheet.places");
    caption(s, a.take_top(1), "places");
    let list = [
        Place { label: "Home", count: Some(42) },
        Place { label: "Bookmarks", count: Some(7) },
        Place { label: "I recommend", count: None },
        Place { label: "Friends", count: Some(3) },
        Place { label: "Feeds", count: None },
        Place { label: "Settings", count: None },
    ];
    s.places(a.take_top(1), &list, sb.pick(places).unwrap_or(0), |i| Hit::Pick(places, i));
    a.take_top(2);
    caption(s, a.take_top(1), "breadcrumb");
    let crumbs = Id::new("sheet.crumbs");
    s.breadcrumb(a.take_top(1), &["Feeds", "Friends", "Robin's notes"], |i| Some(Hit::Pick(crumbs, i)));
}

pub(super) fn feedback(s: &mut Scene<Hit>, mut a: Area, sb: &Sandbox) {
    caption(s, a.take_top(1), "Nothing floats: a toast is the message line, a dialog an inline confirm row, a tooltip the status line's hint.");
    a.take_top(1);
    caption(s, a.take_top(1), "status line");
    let line = a.take_top(1);
    s.status_line(line, &[Value::State("hub", Tone::Neutral), Value::Count("1,284 entries")], "j k move   / filter", &[Value::Date(Moment(s.now.0 - 420)), Value::Product("DK-01")]);
    a.take_top(2);
    caption(s, a.take_top(1), "message line");
    let msg = Id::new("sheet.message");
    for (text, tone) in [
        ("Your I recommend feed is public.", Tone::Ok),
        ("Three feeds haven't answered for a week.", Tone::Warn),
        ("Couldn't save a change, so it was undone.", Tone::Danger),
        ("Marked 12 entries read.", Tone::Neutral),
    ] {
        s.message(a.take_top(1).at(0, 0, 72, 1), text, tone, Some(Hit::Bump(msg)));
    }
    a.take_top(1);
    caption(s, a.take_top(1), "confirm row");
    let c = Id::new("sheet.confirm");
    if sb.pick(c).is_none() {
        s.confirm(a.take_top(1), "Remove 3 feeds and their entries?", ("Remove", Kind::Danger, Hit::Pick(c, 1)), ("Keep them", Hit::Pick(c, 0)));
    } else {
        s.message(a.take_top(1).at(0, 0, 72, 1), "Answered. Click the sheet again to reset it.", Tone::Neutral, None);
    }
}
