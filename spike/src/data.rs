use chrono::{DateTime, Local};

pub struct Feed {
    pub label: String,
}

pub struct Entry {
    pub title: String,
    pub feed: usize,
    pub published: i64,
    pub read: bool,
    pub bookmarked: bool,
    pub url: String,
}

pub fn load() -> (Vec<Feed>, Vec<Entry>) {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/data/feedreader.sqlite");
    let db = rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .expect("copy the current app's database to data/feedreader.sqlite");
    let mut ids = Vec::new();
    let feeds = db
        .prepare("select id, label from feeds order by position")
        .unwrap()
        .query_map([], |r| {
            Ok((r.get::<_, String>(0)?, Feed { label: r.get(1)? }))
        })
        .unwrap()
        .map(|r| {
            let (id, feed) = r.unwrap();
            ids.push(id);
            feed
        })
        .collect();
    let entries = db
        .prepare(
            "select e.feedId, e.title, e.url, e.publishedTime, coalesce(s.read, 0), coalesce(s.starred, 0)
             from entries e left join states s on s.id = e.id order by e.publishedTime desc",
        )
        .unwrap()
        .query_map([], |r| {
            let feed_id: String = r.get(0)?;
            Ok(Entry {
                feed: ids.iter().position(|id| *id == feed_id).unwrap_or(0),
                title: r.get(1)?,
                url: r.get(2)?,
                published: r.get::<_, f64>(3)? as i64,
                read: r.get::<_, i64>(4)? == 1,
                bookmarked: r.get::<_, i64>(5)? == 1,
            })
        })
        .unwrap()
        .map(Result::unwrap)
        .collect();
    (feeds, entries)
}

pub fn when(published_ms: i64) -> String {
    let Some(t) = DateTime::from_timestamp_millis(published_ms) else {
        return String::new();
    };
    let t = t.with_timezone(&Local);
    let now = Local::now();
    let days = (now.date_naive() - t.date_naive()).num_days();
    if days <= 0 {
        t.format("%H:%M").to_string()
    } else if days < 7 {
        t.format("%a").to_string()
    } else {
        t.format("%-d %b").to_string()
    }
}
