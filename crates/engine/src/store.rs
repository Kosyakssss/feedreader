use std::path::Path;

use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};

use crate::parse::NewEntry;
use crate::types::{Entry, EntryId, Feed, FeedId, Folder, Mode, Recommendation, Rule, SAVED, Scope, Settings};

const SCHEMA: &str = "
create table if not exists feeds (
  id text primary key,
  url text not null unique,
  title text not null default '',
  label text,
  site_url text,
  position integer not null,
  etag text,
  last_modified text,
  last_fetched integer,
  error text,
  removed_at integer
) strict;
create table if not exists entries (
  id text primary key,
  feed_id text not null references feeds(id) on delete cascade,
  source_id text not null,
  url text not null,
  title text not null,
  author text,
  published integer not null,
  first_seen integer not null,
  summary text,
  content text
) strict;
create index if not exists entries_order on entries(published desc, id);
create index if not exists entries_feed on entries(feed_id);
create unique index if not exists entries_url on entries(feed_id, url) where url <> '';
create table if not exists states (
  entry_id text primary key,
  read integer not null default 0,
  read_at integer,
  bookmarked integer not null default 0,
  bookmarked_at integer
) strict;
create table if not exists bodies (
  entry_id text primary key,
  clean text not null,
  extracted_at integer not null
) strict;
create table if not exists settings (
  key text primary key,
  value text not null
) strict;
create table if not exists folders (
  id text primary key,
  name text not null,
  position integer not null default 0
) strict;
create table if not exists folder_feeds (
  folder_id text not null references folders(id) on delete cascade,
  feed_id text not null,
  primary key (folder_id, feed_id)
) strict;
create table if not exists rules (
  id text primary key,
  word text not null,
  scope text not null
) strict;
create table if not exists recommendations (
  entry_id text primary key,
  note text not null default '',
  title text not null,
  url text not null,
  source text not null,
  published integer not null,
  content text,
  at integer not null,
  removed_at integer
) strict;
create virtual table if not exists entries_fts using fts5(title, body);
create table if not exists media (
  url text primary key,
  file text not null,
  kind text not null default '',
  bytes integer not null default 0,
  error text,
  fetched_at integer not null,
  used_at integer not null
) strict;
create table if not exists entry_media (
  entry_id text not null,
  url text not null,
  primary key (entry_id, url)
) strict;
create index if not exists entry_media_url on entry_media(url);
";

pub struct Store {
    db: Connection,
}

pub fn feed_id(url: &str) -> FeedId {
    let key = match url::Url::parse(url) {
        Ok(u) => {
            let host = u.host_str().unwrap_or("").trim_start_matches("www.").to_ascii_lowercase();
            let port = u.port().map(|p| format!(":{p}")).unwrap_or_default();
            let mut path = u.path().to_string();
            while path.len() > 1 && path.ends_with('/') {
                path.pop();
            }
            let query = u.query().map(|q| format!("?{q}")).unwrap_or_default();
            format!("{host}{port}{path}{query}")
        }
        Err(_) => url.to_string(),
    };
    let digest = Sha256::digest(key.as_bytes());
    digest[..8].iter().map(|b| format!("{b:02x}")).collect()
}

pub fn new_id() -> String {
    let mut bytes = [0u8; 8];
    getrandom::fill(&mut bytes).expect("system randomness");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn entry_id(feed: &str, source: &str) -> EntryId {
    let encoded: String = url::form_urlencoded::byte_serialize(source.as_bytes()).collect();
    format!("{feed}:{encoded}")
}

fn feed_row(r: &rusqlite::Row) -> rusqlite::Result<Feed> {
    Ok(Feed {
        id: r.get(0)?,
        url: r.get(1)?,
        title: r.get(2)?,
        label: r.get(3)?,
        site_url: r.get(4)?,
        position: r.get(5)?,
        last_fetched: r.get(6)?,
        error: r.get(7)?,
        pinned: r.get::<_, i64>(8)? == 1,
        hidden: r.get::<_, i64>(9)? == 1,
        mode: r.get::<_, Option<String>>(10)?.and_then(|m| Mode::parse(&m)),
    })
}

fn scope_text(s: &Scope) -> String {
    match s {
        Scope::All => "all".into(),
        Scope::Feed(f) => format!("feed:{f}"),
        Scope::Folder(f) => format!("folder:{f}"),
    }
}

fn scope_parse(s: &str) -> Scope {
    if let Some(f) = s.strip_prefix("feed:") {
        Scope::Feed(f.to_string())
    } else if let Some(f) = s.strip_prefix("folder:") {
        Scope::Folder(f.to_string())
    } else {
        Scope::All
    }
}

fn fts_query(q: &str) -> String {
    q.split_whitespace()
        .map(|t| t.chars().filter(|c| c.is_alphanumeric()).collect::<String>())
        .filter(|t| !t.is_empty())
        .map(|t| format!("\"{t}\"*"))
        .collect::<Vec<_>>()
        .join(" ")
}

const FEED_COLS: &str = "id, url, title, label, site_url, position, last_fetched, error, pinned, hidden, mode";
const ENTRY_COLS: &str = "e.id, e.feed_id, e.url, e.title, e.author, e.published, coalesce(s.read, 0), coalesce(s.bookmarked, 0)";

fn entry_row(r: &rusqlite::Row) -> rusqlite::Result<Entry> {
    Ok(Entry {
        id: r.get(0)?,
        feed_id: r.get(1)?,
        url: r.get(2)?,
        title: r.get(3)?,
        author: r.get(4)?,
        published: r.get(5)?,
        read: r.get::<_, i64>(6)? == 1,
        bookmarked: r.get::<_, i64>(7)? == 1,
    })
}

impl Store {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let db = Connection::open(path)?;
        db.pragma_update(None, "journal_mode", "wal")?;
        db.pragma_update(None, "foreign_keys", "on")?;
        db.pragma_update(None, "synchronous", "full")?;
        db.busy_timeout(std::time::Duration::from_secs(5))?;
        db.execute_batch(SCHEMA)?;
        let cols: Vec<String> = db
            .prepare("select name from pragma_table_info('feeds')")?
            .query_map([], |r| r.get(0))?
            .filter_map(Result::ok)
            .collect();
        for (col, def) in [("pinned", "integer not null default 0"), ("hidden", "integer not null default 0"), ("mode", "text")] {
            if !cols.iter().any(|c| c == col) {
                db.execute_batch(&format!("alter table feeds add column {col} {def}"))?;
            }
        }
        let version: i64 = db.pragma_query_value(None, "user_version", |r| r.get(0))?;
        if version < 3 {
            db.execute_batch(
                "drop table if exists entries_fts;
                 create virtual table entries_fts using fts5(title, body);
                 insert into entries_fts (rowid, title, body) select rowid, title, coalesce(content, summary, '') from entries;",
            )?;
        }
        db.pragma_update(None, "user_version", 3)?;
        db.execute(
            "insert or ignore into feeds (id, url, title, position, hidden) values (?1, 'feedreader:saved', 'Saved links', 1000000, 1)",
            [SAVED],
        )?;
        Ok(Self { db })
    }

    pub fn feeds(&self) -> Vec<Feed> {
        let mut st = self
            .db
            .prepare_cached(&format!("select {FEED_COLS} from feeds where removed_at is null order by position, id"))
            .unwrap();
        st.query_map([], feed_row).unwrap().filter_map(Result::ok).collect()
    }

    pub fn feed(&self, id: &str) -> Option<Feed> {
        self.db
            .query_row(&format!("select {FEED_COLS} from feeds where id = ?1"), [id], feed_row)
            .optional()
            .ok()
            .flatten()
    }

    pub fn validators(&self, id: &str) -> (Option<String>, Option<String>) {
        self.db
            .query_row("select etag, last_modified from feeds where id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap_or((None, None))
    }

    #[profiling::function]
    pub fn entries(&self) -> Vec<Entry> {
        let mut st = self
            .db
            .prepare_cached(&format!(
                "select {ENTRY_COLS} from entries e left join states s on s.entry_id = e.id
                 order by e.published desc, e.id"
            ))
            .unwrap();
        st.query_map([], entry_row).unwrap().filter_map(Result::ok).collect()
    }

    pub fn entry(&self, id: &str) -> Option<(Entry, Option<String>, Option<String>)> {
        self.db
            .query_row(
                &format!(
                    "select {ENTRY_COLS}, e.content, e.summary from entries e left join states s on s.entry_id = e.id where e.id = ?1"
                ),
                [id],
                |r| Ok((entry_row(r)?, r.get(8)?, r.get(9)?)),
            )
            .optional()
            .ok()
            .flatten()
    }

    pub fn add_feed(&self, url: &str, title: &str) -> rusqlite::Result<Feed> {
        let id = feed_id(url);
        let position: i64 = self
            .db
            .query_row("select coalesce(min(position), 0) - 1 from feeds", [], |r| r.get(0))?;
        self.db.execute(
            "insert into feeds (id, url, title, position) values (?1, ?2, ?3, ?4)
             on conflict(id) do update set removed_at = null",
            params![id, url, title, position],
        )?;
        Ok(self.feed(&id).expect("feed just added"))
    }

    pub fn set_fetch_result(
        &self,
        id: &str,
        title: Option<&str>,
        site_url: Option<&str>,
        validators: Option<(Option<String>, Option<String>)>,
        error: Option<&str>,
        now: i64,
    ) {
        let _ = self.db.execute(
            "update feeds set title = coalesce(?2, title), site_url = coalesce(?3, site_url), last_fetched = ?4, error = ?5 where id = ?1",
            params![id, title.filter(|t| !t.is_empty()), site_url, now, error],
        );
        if let Some((etag, lm)) = validators {
            let _ = self.db.execute(
                "update feeds set etag = ?2, last_modified = ?3 where id = ?1",
                params![id, etag, lm],
            );
        }
    }

    #[profiling::function]
    pub fn insert_entries(&mut self, feed: &str, items: Vec<NewEntry>, now: i64) -> Inserted {
        let tx = self.db.transaction().unwrap();
        let mut added = Vec::new();
        let mut updated = Vec::new();
        let mut images = Vec::new();
        {
            let mut insert = tx
                .prepare_cached(
                    "insert or ignore into entries (id, feed_id, source_id, url, title, author, published, first_seen, summary, content)
                     values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                )
                .unwrap();
            let mut current = tx.prepare_cached("select title, published from entries where id = ?1").unwrap();
            let mut fill = tx
                .prepare_cached(
                    "update entries set content = coalesce(content, ?2), summary = coalesce(summary, ?3), author = coalesce(author, ?4),
                     title = case when title in ('', 'Untitled', 'untitled') then ?5 else title end,
                     published = case when published < 631152000000 then ?6 else published end where id = ?1",
                )
                .unwrap();
            for (i, item) in items.into_iter().enumerate() {
                let source = if item.source_id.is_empty() {
                    if item.url.is_empty() { item.title.clone() } else { item.url.clone() }
                } else {
                    item.source_id.clone()
                };
                if source.is_empty() {
                    continue;
                }
                let id = entry_id(feed, &source);
                let published = item.published.unwrap_or(now - i as i64);
                let n = insert
                    .execute(params![
                        id,
                        feed,
                        source,
                        item.url,
                        item.title,
                        item.author,
                        published,
                        now,
                        item.summary,
                        item.content
                    ])
                    .unwrap_or(0);
                if n == 1 {
                    let _ = tx.execute(
                        "insert into entries_fts (rowid, title, body) select rowid, ?2, ?3 from entries where id = ?1",
                        params![id, item.title, item.content.as_deref().or(item.summary.as_deref()).unwrap_or("")],
                    );
                    for img in &item.images {
                        let _ = tx.execute("insert or ignore into entry_media (entry_id, url) values (?1, ?2)", params![id, img]);
                        images.push(img.clone());
                    }
                    added.push(Entry {
                        id,
                        feed_id: feed.to_string(),
                        url: item.url,
                        title: item.title,
                        author: item.author,
                        published,
                        read: false,
                        bookmarked: false,
                    });
                } else {
                    let before: Option<(String, i64)> = current.query_row([&id], |r| Ok((r.get(0)?, r.get(1)?))).ok();
                    let _ = fill.execute(params![id, item.content, item.summary, item.author, item.title, published]);
                    if let Some(body) = item.content.as_deref().or(item.summary.as_deref()) {
                        let _ = tx.execute(
                            "update entries_fts set body = ?2 where rowid = (select rowid from entries where id = ?1) and body = ''",
                            params![id, body],
                        );
                    }
                    let after: Option<(String, i64)> = current.query_row([&id], |r| Ok((r.get(0)?, r.get(1)?))).ok();
                    if let (Some(b), Some(a)) = (before, after)
                        && b != a
                    {
                        updated.push((id, a.0, a.1));
                    }
                }
            }
        }
        tx.commit().unwrap();
        Inserted { added, updated, images }
    }

    pub fn set_read(&mut self, ids: &[EntryId], read: bool, now: i64) {
        let tx = self.db.transaction().unwrap();
        {
            let mut st = tx
                .prepare_cached(
                    "insert into states (entry_id, read, read_at) values (?1, ?2, ?3)
                     on conflict(entry_id) do update set read = excluded.read, read_at = excluded.read_at",
                )
                .unwrap();
            for id in ids {
                let _ = st.execute(params![id, read as i64, now]);
            }
        }
        tx.commit().unwrap();
    }

    pub fn set_bookmarked(&mut self, ids: &[EntryId], on: bool, now: i64) {
        let tx = self.db.transaction().unwrap();
        {
            let mut st = tx
                .prepare_cached(
                    "insert into states (entry_id, bookmarked, bookmarked_at) values (?1, ?2, ?3)
                     on conflict(entry_id) do update set bookmarked = excluded.bookmarked, bookmarked_at = excluded.bookmarked_at",
                )
                .unwrap();
            for id in ids {
                let _ = st.execute(params![id, on as i64, now]);
            }
        }
        tx.commit().unwrap();
    }

    pub fn remove_feed(&self, id: &str, now: i64) {
        let _ = self.db.execute("update feeds set removed_at = ?2 where id = ?1", params![id, now]);
    }

    pub fn restore_feed(&self, id: &str) {
        let _ = self.db.execute("update feeds set removed_at = null where id = ?1", [id]);
    }

    pub fn removed_entries(&self, feed: &str) -> Vec<Entry> {
        let mut st = self
            .db
            .prepare_cached(&format!(
                "select {ENTRY_COLS} from entries e left join states s on s.entry_id = e.id where e.feed_id = ?1 order by e.published desc"
            ))
            .unwrap();
        st.query_map([feed], entry_row).unwrap().filter_map(Result::ok).collect()
    }

    pub fn rename_feed(&self, id: &str, label: Option<&str>) {
        let _ = self.db.execute("update feeds set label = ?2 where id = ?1", params![id, label]);
    }

    pub fn purge_removed(&self, before: i64) {
        let _ = self.db.execute(
            "delete from entries_fts where rowid in (select e.rowid from entries e join feeds f on f.id = e.feed_id
             where f.removed_at is not null and f.removed_at < ?1)",
            [before],
        );
        let _ = self.db.execute("delete from feeds where removed_at is not null and removed_at < ?1", [before]);
    }

    #[profiling::function]
    pub fn prune(&mut self, settings: &Settings, now: i64) -> Vec<EntryId> {
        let cutoff = settings.max_age_days.map(|d| now - d as i64 * 86_400_000).unwrap_or(i64::MIN);
        let mut st = self
            .db
            .prepare_cached(
                "select e.id, e.published, coalesce(s.bookmarked, 0) or exists (select 1 from recommendations r where r.entry_id = e.id and r.removed_at is null)
                 from entries e
                 join feeds f on f.id = e.feed_id and f.removed_at is null and f.id <> 'saved'
                 left join states s on s.entry_id = e.id order by e.published desc, e.id",
            )
            .unwrap();
        let rows: Vec<(String, i64, bool)> = st
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, i64>(2)? == 1)))
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        drop(st);
        let mut kept = 0u32;
        let mut doomed = Vec::new();
        for (id, published, bookmarked) in rows {
            if bookmarked {
                continue;
            }
            if kept < settings.max_entries && published >= cutoff {
                kept += 1;
            } else {
                doomed.push(id);
            }
        }
        let tx = self.db.transaction().unwrap();
        for id in &doomed {
            let _ = tx.execute("delete from entries_fts where rowid = (select rowid from entries where id = ?1)", [id]);
            let _ = tx.execute("delete from entries where id = ?1", [id]);
            let _ = tx.execute("delete from states where entry_id = ?1", [id]);
            let _ = tx.execute("delete from bodies where entry_id = ?1", [id]);
            let _ = tx.execute("delete from entry_media where entry_id = ?1", [id]);
        }
        tx.commit().unwrap();
        doomed
    }

    pub fn clean_body(&self, id: &str) -> Option<String> {
        self.db
            .query_row("select clean from bodies where entry_id = ?1", [id], |r| r.get(0))
            .optional()
            .ok()
            .flatten()
    }

    pub fn set_clean_body(&self, id: &str, html: &str, now: i64) {
        let _ = self.db.execute(
            "insert or replace into bodies (entry_id, clean, extracted_at) values (?1, ?2, ?3)",
            params![id, html, now],
        );
    }

    pub fn settings(&self) -> Settings {
        let mut s = Settings::default();
        let mut st = self.db.prepare("select key, value from settings").unwrap();
        let rows: Vec<(String, String)> = st
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        for (k, v) in rows {
            match k.as_str() {
                "max_entries" => s.max_entries = v.parse().unwrap_or(s.max_entries),
                "max_age_days" => s.max_age_days = v.parse().ok(),
                "refresh_minutes" => s.refresh_minutes = v.parse().unwrap_or(s.refresh_minutes),
                "confirm_open_over" => s.confirm_open_over = v.parse().unwrap_or(s.confirm_open_over),
                "reading_mode" => s.reading_mode = Mode::parse(&v).unwrap_or(s.reading_mode),
                "lines" => s.lines = v,
                "merge_duplicates" => s.merge_duplicates = v == "1",
                "public_port" => s.public_port = v.parse().unwrap_or(s.public_port),
                _ => {}
            }
        }
        s
    }

    pub fn save_settings(&self, s: &Settings) {
        let pairs = [
            ("max_entries", s.max_entries.to_string()),
            ("max_age_days", s.max_age_days.map(|d| d.to_string()).unwrap_or_default()),
            ("refresh_minutes", s.refresh_minutes.to_string()),
            ("confirm_open_over", s.confirm_open_over.to_string()),
            ("reading_mode", s.reading_mode.name().to_string()),
            ("lines", s.lines.clone()),
            ("merge_duplicates", if s.merge_duplicates { "1".into() } else { "0".into() }),
            ("public_port", s.public_port.to_string()),
        ];
        for (k, v) in pairs {
            let _ = self.db.execute(
                "insert into settings (key, value) values (?1, ?2) on conflict(key) do update set value = excluded.value",
                params![k, v],
            );
        }
    }

    pub fn token(&self) -> String {
        if let Ok(t) = self.db.query_row("select value from settings where key = 'public_token'", [], |r| r.get::<_, String>(0)) {
            return t;
        }
        let mut bytes = [0u8; 24];
        getrandom::fill(&mut bytes).expect("system randomness");
        let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        let _ = self.db.execute("insert into settings (key, value) values ('public_token', ?1)", [&token]);
        token
    }

    pub fn folders(&self) -> Vec<Folder> {
        let mut st = self.db.prepare_cached("select id, name from folders order by position, name collate nocase").unwrap();
        let list: Vec<(String, String)> = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().filter_map(Result::ok).collect();
        let mut members = self.db.prepare_cached("select feed_id from folder_feeds where folder_id = ?1").unwrap();
        list.into_iter()
            .map(|(id, name)| {
                let feeds = members.query_map([&id], |r| r.get(0)).unwrap().filter_map(Result::ok).collect();
                Folder { id, name, feeds }
            })
            .collect()
    }

    pub fn add_to_folders(&mut self, feed: &str, names: &[String]) {
        let mut all: Vec<String> = self.folders().into_iter().filter(|f| f.feeds.iter().any(|x| x == feed)).map(|f| f.name).collect();
        for n in names {
            if !all.iter().any(|a| a.eq_ignore_ascii_case(n.trim())) {
                all.push(n.trim().to_string());
            }
        }
        self.set_feed_folders(feed, &all);
    }

    pub fn offered(&self, host: &str) -> bool {
        let key = format!("offered:{host}");
        let seen = self.db.query_row("select 1 from settings where key = ?1", [&key], |_| Ok(())).is_ok();
        if !seen {
            let _ = self.db.execute("insert into settings (key, value) values (?1, '1')", [&key]);
        }
        seen
    }

    pub fn set_feed_folders(&mut self, feed: &str, names: &[String]) {
        let tx = self.db.transaction().unwrap();
        let _ = tx.execute("delete from folder_feeds where feed_id = ?1", [feed]);
        for name in names.iter().map(|n| n.trim()).filter(|n| !n.is_empty()) {
            let existing: Option<String> = tx
                .query_row("select id from folders where name = ?1 collate nocase", [name], |r| r.get(0))
                .optional()
                .unwrap_or(None);
            let id = existing.unwrap_or_else(|| {
                let id = new_id();
                let _ = tx.execute("insert into folders (id, name) values (?1, ?2)", params![id, name]);
                id
            });
            let _ = tx.execute("insert or ignore into folder_feeds (folder_id, feed_id) values (?1, ?2)", params![id, feed]);
        }
        tx.commit().unwrap();
    }

    pub fn rename_folder(&self, id: &str, name: &str) {
        let _ = self.db.execute("update folders set name = ?2 where id = ?1", params![id, name]);
    }

    pub fn delete_folder(&self, id: &str) {
        let _ = self.db.execute("delete from folders where id = ?1", [id]);
    }

    pub fn restore_folder(&mut self, f: &Folder) {
        let tx = self.db.transaction().unwrap();
        let _ = tx.execute("insert or replace into folders (id, name) values (?1, ?2)", params![f.id, f.name]);
        for feed in &f.feeds {
            let _ = tx.execute("insert or ignore into folder_feeds (folder_id, feed_id) values (?1, ?2)", params![f.id, feed]);
        }
        tx.commit().unwrap();
    }

    pub fn set_feed_flag(&self, id: &str, column: &str, on: bool) {
        let sql = format!("update feeds set {column} = ?2 where id = ?1");
        let _ = self.db.execute(&sql, params![id, on as i64]);
    }

    pub fn set_feed_mode(&self, id: &str, mode: Option<Mode>) {
        let _ = self.db.execute("update feeds set mode = ?2 where id = ?1", params![id, mode.map(|m| m.name())]);
    }

    pub fn rules(&self) -> Vec<Rule> {
        let mut st = self.db.prepare_cached("select id, word, scope from rules order by rowid").unwrap();
        st.query_map([], |r| {
            Ok(Rule {
                id: r.get(0)?,
                word: r.get(1)?,
                scope: scope_parse(&r.get::<_, String>(2)?),
            })
        })
        .unwrap()
        .filter_map(Result::ok)
        .collect()
    }

    pub fn add_rule(&self, rule: &Rule) {
        let _ = self.db.execute(
            "insert or replace into rules (id, word, scope) values (?1, ?2, ?3)",
            params![rule.id, rule.word, scope_text(&rule.scope)],
        );
    }

    pub fn remove_rule(&self, id: &str) {
        let _ = self.db.execute("delete from rules where id = ?1", [id]);
    }

    pub fn recommendations(&self) -> Vec<Recommendation> {
        let mut st = self
            .db
            .prepare_cached("select entry_id, note, at from recommendations where removed_at is null order by at desc")
            .unwrap();
        st.query_map([], |r| Ok(Recommendation { entry: r.get(0)?, note: r.get(1)?, at: r.get(2)? }))
            .unwrap()
            .filter_map(Result::ok)
            .collect()
    }

    pub fn recommend(&self, id: &str, note: &str, now: i64) -> bool {
        let Some((e, content, summary)) = self.entry(id) else { return false };
        let source = self.feed(&e.feed_id).map(|f| f.name().to_string()).unwrap_or_default();
        let body = self.clean_body(id).or(content).or(summary);
        self.db
            .execute(
                "insert into recommendations (entry_id, note, title, url, source, published, content, at, removed_at)
                 values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, null)
                 on conflict(entry_id) do update set note = excluded.note, at = excluded.at, removed_at = null",
                params![id, note, e.title, e.url, source, e.published, body, now],
            )
            .is_ok()
    }

    pub fn unrecommend(&self, id: &str, now: i64) {
        let _ = self.db.execute("update recommendations set removed_at = ?2 where entry_id = ?1", params![id, now]);
    }

    pub fn public_items(&self) -> Vec<PublicItem> {
        let mut st = self
            .db
            .prepare_cached(
                "select entry_id, note, title, url, source, published, content, at, removed_at from recommendations
                 where removed_at is null or removed_at > ?1 order by at desc limit 200",
            )
            .unwrap();
        let since = crate::now() - 60 * 86_400_000;
        st.query_map([since], |r| {
            Ok(PublicItem {
                entry: r.get(0)?,
                note: r.get(1)?,
                title: r.get(2)?,
                url: r.get(3)?,
                source: r.get(4)?,
                published: r.get(5)?,
                content: r.get(6)?,
                at: r.get(7)?,
                removed_at: r.get(8)?,
            })
        })
        .unwrap()
        .filter_map(Result::ok)
        .collect()
    }

    #[profiling::function]
    pub fn search(&self, q: &str) -> Vec<EntryId> {
        let fq = fts_query(q);
        if fq.is_empty() {
            return Vec::new();
        }
        let Ok(mut st) = self.db.prepare_cached("select e.id from entries_fts f join entries e on e.rowid = f.rowid where entries_fts match ?1 limit 2000") else {
            return Vec::new();
        };
        st.query_map([fq], |r| r.get(0))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    pub fn save_link(&mut self, url: &str, title: &str, html: &str, now: i64) -> Entry {
        let id = entry_id(SAVED, url);
        let _ = self.db.execute(
            "insert into entries (id, feed_id, source_id, url, title, published, first_seen, content)
             values (?1, ?2, ?3, ?3, ?4, ?5, ?5, ?6)
             on conflict(id) do update set content = excluded.content, title = excluded.title",
            params![id, SAVED, url, title, now, html],
        );
        let _ = self.db.execute("delete from entries_fts where rowid = (select rowid from entries where id = ?1)", [&id]);
        let _ = self.db.execute(
            "insert into entries_fts (rowid, title, body) select rowid, ?2, ?3 from entries where id = ?1",
            params![id, title, html],
        );
        self.set_clean_body(&id, html, now);
        self.set_bookmarked(std::slice::from_ref(&id), true, now);
        self.set_read(std::slice::from_ref(&id), true, now);
        Entry {
            id,
            feed_id: SAVED.into(),
            url: url.into(),
            title: title.into(),
            author: None,
            published: now,
            read: true,
            bookmarked: true,
        }
    }

    pub fn import_legacy(&mut self, path: &Path) -> Result<(usize, usize), String> {
        let old = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| e.to_string())?;
        let feeds: Vec<(String, String, String, i64, Option<String>, Option<String>, Option<i64>, Option<String>)> = old
            .prepare("select id, url, label, position, etag, lastModified, lastFetched, error from feeds order by position")
            .map_err(|e| e.to_string())?
            .query_map([], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?))
            })
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect();
        let tx = self.db.transaction().map_err(|e| e.to_string())?;
        let mut ids = std::collections::HashMap::new();
        for (old_id, url, label, position, etag, lm, fetched, error) in &feeds {
            let id = feed_id(url);
            tx.execute(
                "insert or ignore into feeds (id, url, title, position, etag, last_modified, last_fetched, error)
                 values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![id, url, label, position, etag, lm, fetched, error],
            )
            .map_err(|e| e.to_string())?;
            ids.insert(old_id.clone(), id);
        }
        let mut count = 0;
        {
            let mut st = old
                .prepare(
                    "select e.feedId, e.sourceId, e.url, e.title, e.publishedTime, s.read, s.readAt, s.starred, s.starredAt
                     from entries e left join states s on s.id = e.id",
                )
                .map_err(|e| e.to_string())?;
            let rows = st
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, f64>(4)?,
                        r.get::<_, Option<i64>>(5)?,
                        r.get::<_, Option<f64>>(6)?,
                        r.get::<_, Option<i64>>(7)?,
                        r.get::<_, Option<f64>>(8)?,
                    ))
                })
                .map_err(|e| e.to_string())?;
            for row in rows.filter_map(Result::ok) {
                let (old_feed, source, url, title, published, read, read_at, starred, starred_at) = row;
                let Some(feed) = ids.get(&old_feed) else { continue };
                let source = if source.is_empty() { if url.is_empty() { title.clone() } else { url.clone() } } else { source };
                let id = entry_id(feed, &source);
                let n = tx
                    .execute(
                        "insert or ignore into entries (id, feed_id, source_id, url, title, published, first_seen)
                         values (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
                        params![id, feed, source, url, title, published as i64],
                    )
                    .unwrap_or(0);
                count += n;
                if n == 1 {
                    let _ = tx.execute(
                        "insert into entries_fts (rowid, title, body) select rowid, ?2, '' from entries where id = ?1",
                        params![id, title],
                    );
                }
                if read.is_some() || starred.is_some() {
                    let _ = tx.execute(
                        "insert or replace into states (entry_id, read, read_at, bookmarked, bookmarked_at) values (?1, ?2, ?3, ?4, ?5)",
                        params![
                            id,
                            read.unwrap_or(0),
                            read_at.map(|t| t as i64),
                            starred.unwrap_or(0),
                            starred_at.map(|t| t as i64)
                        ],
                    );
                }
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok((feeds.len(), count))
    }
}

pub struct Inserted {
    pub added: Vec<Entry>,
    pub updated: Vec<(EntryId, String, i64)>,
    pub images: Vec<String>,
}

pub struct MediaRow {
    pub file: String,
    pub error: Option<String>,
    pub fetched_at: i64,
}

impl Store {
    pub fn tabs(&self) -> Vec<crate::types::TabState> {
        self.db
            .query_row("select value from settings where key = 'tabs'", [], |r| r.get::<_, String>(0))
            .ok()
            .and_then(|v| serde_json::from_str(&v).ok())
            .unwrap_or_default()
    }

    pub fn set_tabs(&self, tabs: &[crate::types::TabState]) {
        if let Ok(v) = serde_json::to_string(tabs) {
            let _ = self.db.execute(
                "insert into settings (key, value) values ('tabs', ?1) on conflict(key) do update set value = excluded.value",
                [v],
            );
        }
    }

    pub fn media(&self, url: &str) -> Option<MediaRow> {
        self.db
            .query_row("select file, error, fetched_at from media where url = ?1", [url], |r| {
                Ok(MediaRow { file: r.get(0)?, error: r.get(1)?, fetched_at: r.get(2)? })
            })
            .optional()
            .ok()
            .flatten()
    }

    pub fn touch_media(&self, url: &str, now: i64) {
        let _ = self.db.execute("update media set used_at = ?2 where url = ?1", params![url, now]);
    }

    pub fn set_media(&self, url: &str, file: &str, kind: &str, bytes: i64, error: Option<&str>, now: i64) {
        let _ = self.db.execute(
            "insert into media (url, file, kind, bytes, error, fetched_at, used_at) values (?1, ?2, ?3, ?4, ?5, ?6, ?6)
             on conflict(url) do update set file = excluded.file, kind = excluded.kind, bytes = excluded.bytes,
             error = excluded.error, fetched_at = excluded.fetched_at, used_at = excluded.used_at",
            params![url, file, kind, bytes, error, now],
        );
    }

    pub fn link_media(&mut self, links: &[(EntryId, String)]) {
        let tx = self.db.transaction().unwrap();
        for (entry, url) in links {
            let _ = tx.execute("insert or ignore into entry_media (entry_id, url) values (?1, ?2)", params![entry, url]);
        }
        tx.commit().unwrap();
    }

    #[profiling::function]
    pub fn prune_media(&mut self, now: i64, budget: i64) -> Vec<String> {
        let week = now - 7 * 86_400_000;
        let kept = "exists (select 1 from entry_media m join entries e on e.id = m.entry_id
                     left join states s on s.entry_id = e.id
                     where m.url = media.url and (coalesce(s.read, 0) = 0 or coalesce(s.read_at, 0) > ?1 or coalesce(s.bookmarked, 0) = 1
                       or e.feed_id = 'saved'
                       or exists (select 1 from recommendations r where r.entry_id = e.id and r.removed_at is null)))";
        let mut doomed: Vec<String> = self
            .db
            .prepare(&format!("select file from media where used_at < ?1 and not {kept}"))
            .and_then(|mut st| st.query_map([week], |r| r.get::<_, String>(0)).map(|rows| rows.filter_map(Result::ok).collect()))
            .unwrap_or_default();
        let _ = self.db.execute(&format!("delete from media where used_at < ?1 and not {kept}"), [week]);
        let total: i64 = self.db.query_row("select coalesce(sum(bytes), 0) from media", [], |r| r.get(0)).unwrap_or(0);
        if total > budget {
            let rows: Vec<(String, String, i64)> = self
                .db
                .prepare("select url, file, bytes from media order by used_at")
                .and_then(|mut st| st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).map(|rows| rows.filter_map(Result::ok).collect()))
                .unwrap_or_default();
            let mut over = total - budget;
            for (url, file, bytes) in rows {
                if over <= 0 {
                    break;
                }
                let _ = self.db.execute("delete from media where url = ?1", [&url]);
                doomed.push(file);
                over -= bytes;
            }
        }
        let _ = self.db.execute("delete from entry_media where entry_id not in (select id from entries)", []);
        doomed.retain(|f| !f.is_empty());
        doomed
    }
}

pub struct PublicItem {
    pub entry: String,
    pub note: String,
    pub title: String,
    pub url: String,
    pub source: String,
    pub published: i64,
    pub content: Option<String>,
    pub at: i64,
    pub removed_at: Option<i64>,
}
