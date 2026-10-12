use std::path::Path;

use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};

use crate::parse::NewEntry;
use crate::types::{Appearance, Attachment, Entry, Lines, EntryId, Feed, FeedId, Folder, Mode, Recommendation, Rule, SAVED, Scope, Settings};

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
create table if not exists devices (
  token_hash text primary key,
  device text not null,
  name text not null,
  created integer not null,
  seen integer
) strict;
create table if not exists pair_codes (
  code_hash text primary key,
  expires integer not null
) strict;
create table if not exists clock (
  key text primary key,
  at integer not null,
  device text not null
) strict;
create table if not exists changes (
  seq integer primary key autoincrement,
  id text not null unique,
  device text not null,
  at integer not null,
  command text not null
) strict;
create table if not exists media (
  url text primary key,
  file text not null,
  kind text not null default '',
  bytes integer not null default 0,
  error text,
  fetched_at integer not null,
  used_at integer not null
) strict;
create table if not exists extract_failed (
  entry_id text primary key,
  at integer not null,
  error text not null
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
    failure: Failure,
}

#[derive(Default)]
struct Failure(std::cell::RefCell<Option<String>>);

impl Failure {
    fn note<T>(&self, r: rusqlite::Result<T>) {
        self.keep(r);
    }

    fn keep<T>(&self, r: rusqlite::Result<T>) -> Option<T> {
        r.inspect_err(|e| {
            self.0.borrow_mut().get_or_insert(e.to_string());
        })
        .ok()
    }

    fn take(&self) -> Option<String> {
        self.0.borrow_mut().take()
    }
}

type LegacyFeed = (String, String, String, i64, Option<String>, Option<String>, Option<i64>, Option<String>);

type FeedState = (String, String, String, Option<String>, bool, bool, Option<String>);

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

pub fn folder_id(name: &str) -> String {
    let digest = Sha256::digest(format!("folder:{}", name.trim().to_lowercase()).as_bytes());
    digest[..8].iter().map(|b| format!("{b:02x}")).collect()
}

pub fn legacy_folders(names: &[String]) -> Vec<(String, String)> {
    names.iter().map(|n| n.trim()).filter(|n| !n.is_empty()).map(|n| (folder_id(n), n.to_string())).collect()
}

fn pick_folder_id(name: &str, holder: impl Fn(&str) -> Option<String>) -> String {
    let mut n = 0;
    loop {
        let id = if n == 0 { folder_id(name) } else { folder_id(&format!("{name}\u{0}{n}")) };
        match holder(&id) {
            None => return id,
            Some(existing) if existing.eq_ignore_ascii_case(name.trim()) => return id,
            Some(_) => n += 1,
        }
    }
}

fn free_folder_id(db: &Connection, name: &str) -> String {
    pick_folder_id(name, |id| db.query_row("select name from folders where id = ?1", [id], |r| r.get(0)).optional().ok().flatten())
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
const ENTRY_COLS: &str = "e.id, e.feed_id, e.url, e.title, e.author, e.published, coalesce(s.read, 0), coalesce(s.bookmarked, 0), e.attachments";

fn attachments_of(json: Option<String>) -> Vec<Attachment> {
    json.and_then(|j| serde_json::from_str(&j).ok()).unwrap_or_default()
}

fn attachments_json(list: &[Attachment]) -> Option<String> {
    if list.is_empty() { None } else { serde_json::to_string(list).ok() }
}

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
        attachments: attachments_of(r.get(8)?),
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
        for (col, def) in [
            ("pinned", "integer not null default 0"),
            ("hidden", "integer not null default 0"),
            ("mode", "text"),
            ("next_at", "integer"),
            ("fails", "integer not null default 0"),
            ("interval", "integer not null default 0"),
        ] {
            if !cols.iter().any(|c| c == col) {
                db.execute_batch(&format!("alter table feeds add column {col} {def}"))?;
            }
        }
        let version: i64 = db.pragma_query_value(None, "user_version", |r| r.get(0))?;
        let ecols: Vec<String> = db
            .prepare("select name from pragma_table_info('entries')")?
            .query_map([], |r| r.get(0))?
            .filter_map(Result::ok)
            .collect();
        if !ecols.iter().any(|c| c == "attachments") {
            db.execute_batch("alter table entries add column attachments text")?;
        }
        if !ecols.iter().any(|c| c == "cseq") {
            db.execute_batch("alter table entries add column cseq integer not null default 0; update entries set cseq = rowid;")?;
        }
        db.execute_batch("create index if not exists entries_cseq on entries(cseq)")?;
        if version < 3 {
            db.execute_batch(
                "drop table if exists entries_fts;
                 create virtual table entries_fts using fts5(title, body);
                 insert into entries_fts (rowid, title, body) select rowid, title, coalesce(content, summary, '') from entries;",
            )?;
        }
        let clock_cols: Vec<String> = db
            .prepare("select name from pragma_table_info('clock')")?
            .query_map([], |r| r.get(0))?
            .filter_map(Result::ok)
            .collect();
        if !clock_cols.iter().any(|c| c == "value") {
            db.execute_batch("alter table clock add column value text")?;
        }
        if version < 4 {
            if version > 0 {
                db.query_row("pragma wal_checkpoint(truncate)", [], |_| Ok(()))?;
                std::fs::copy(path, path.with_extension(format!("sqlite.v{version}.bak"))).map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
            }
            db.execute_batch("begin")?;
            let folders: Vec<(String, String)> = db
                .prepare("select id, name from folders order by rowid")?
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .filter_map(Result::ok)
                .collect();
            for (old, name) in folders {
                let new = free_folder_id(&db, &name);
                if new != old {
                    db.execute("insert into folders (id, name, position) select ?2, name, position from folders where id = ?1", params![old, new])?;
                    db.execute("update folder_feeds set folder_id = ?2 where folder_id = ?1", params![old, new])?;
                    db.execute("delete from folders where id = ?1", params![old])?;
                    db.execute("update rules set scope = ?2 where scope = ?1", params![format!("folder:{old}"), format!("folder:{new}")])?;
                    db.execute("update clock set key = ?2 where key = ?1", params![format!("folder:{old}"), format!("folder:{new}")])?;
                }
            }
            db.execute_batch(
                "insert into clock (key, at, device, value) select 'folder:' || id, 0, '', '+' || name from folders where true
                   on conflict(key) do update set value = excluded.value where clock.value is null;
                 insert into clock (key, at, device, value)
                   select 'folders:' || feed_id, 0, '', json_group_array(folder_id) from folder_feeds where true group by feed_id
                   on conflict(key) do update set value = excluded.value where clock.value is null;
                 update clock set value = '-' where key like 'folder:%' and value is null;
                 commit;",
            )?;
        }
        db.pragma_update(None, "user_version", 4)?;
        db.execute(
            "insert or ignore into feeds (id, url, title, position, hidden) values (?1, 'feedreader:saved', 'Saved links', 1000000, 1)",
            [SAVED],
        )?;
        Ok(Self { db, failure: Default::default() })
    }

    pub fn begin(&self) {
        self.failure.take();
        self.failure.note(self.db.execute_batch("begin"));
    }

    pub fn commit(&self) -> Result<(), String> {
        match self.failure.take() {
            Some(e) => {
                self.failure.note(self.db.execute_batch("rollback"));
                self.failure.take();
                Err(e)
            }
            None => self.db.execute_batch("commit").map_err(|e| e.to_string()),
        }
    }

    fn rows<T>(&self, sql: &str, params: impl rusqlite::Params, map: impl FnMut(&rusqlite::Row) -> rusqlite::Result<T>) -> Vec<T> {
        let found = self.db.prepare_cached(sql).and_then(|mut st| st.query_map(params, map).map(|rows| rows.filter_map(Result::ok).collect()));
        self.failure.keep(found).unwrap_or_default()
    }

    pub fn feeds(&self) -> Vec<Feed> {
        self.rows(&format!("select {FEED_COLS} from feeds where removed_at is null order by position, id"), [], feed_row)
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
        self.rows(&format!("select {ENTRY_COLS} from entries e left join states s on s.entry_id = e.id order by e.published desc, e.id"), [], entry_row)
    }

    pub fn entry(&self, id: &str) -> Option<(Entry, Option<String>, Option<String>)> {
        self.db
            .query_row(
                &format!(
                    "select {ENTRY_COLS}, e.content, e.summary from entries e left join states s on s.entry_id = e.id where e.id = ?1"
                ),
                [id],
                |r| Ok((entry_row(r)?, r.get(9)?, r.get(10)?)),
            )
            .optional()
            .ok()
            .flatten()
    }

    pub fn ensure_feed(&self, url: &str, title: &str) -> rusqlite::Result<Feed> {
        let id = feed_id(url);
        let position: i64 = self.db.query_row("select coalesce(min(position), 0) - 1 from feeds", [], |r| r.get(0))?;
        self.db.execute(
            "insert or ignore into feeds (id, url, title, position) values (?1, ?2, ?3, ?4)",
            params![id, url, title, position],
        )?;
        self.db.query_row(&format!("select {FEED_COLS} from feeds where id = ?1"), [&id], feed_row)
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
        self.failure.note(self.db.execute(
            "update feeds set title = coalesce(?2, title), site_url = coalesce(?3, site_url), last_fetched = ?4, error = ?5 where id = ?1",
            params![id, title.filter(|t| !t.is_empty()), site_url, now, error],
        ));
        if let Some((etag, lm)) = validators {
            self.failure.note(self.db.execute(
                "update feeds set etag = ?2, last_modified = ?3 where id = ?1",
                params![id, etag, lm],
            ));
        }
    }

    #[profiling::function]
    pub fn insert_entries(&mut self, feed: &str, items: Vec<NewEntry>, now: i64) -> Inserted {
        let mut added = Vec::new();
        let mut updated = Vec::new();
        let mut images = Vec::new();
        let mut refilled = Vec::new();
        {
            let Some(mut insert) = self.failure.keep(self.db.prepare_cached(
                "insert or ignore into entries (id, feed_id, source_id, url, title, author, published, first_seen, summary, content, attachments, cseq)
                 values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, (select coalesce(max(cseq), 0) + 1 from entries))",
            )) else {
                return Inserted::default();
            };
            let Some(mut current) = self.failure.keep(self.db.prepare_cached("select title, published from entries where id = ?1")) else {
                return Inserted::default();
            };
            let Some(mut fill) = self.failure.keep(self.db.prepare_cached(
                "update entries set content = coalesce(content, ?2), summary = coalesce(summary, ?3), author = coalesce(author, ?4),
                 title = case when title in ('', 'Untitled', 'untitled') then ?5 else title end,
                 published = case when published < 631152000000 then ?6 else published end,
                 cseq = case when content is null and ?2 is not null or title in ('', 'Untitled', 'untitled') or published < 631152000000
                   or attachments is null and ?7 is not null
                   then (select coalesce(max(cseq), 0) + 1 from entries) else cseq end,
                 attachments = coalesce(attachments, ?7)
                 where id = ?1",
            )) else {
                return Inserted::default();
            };
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
                        item.content,
                        attachments_json(&item.attachments)
                    ])
                    .unwrap_or(0);
                if n == 1 {
                    self.failure.note(self.db.execute(
                        "insert into entries_fts (rowid, title, body) select rowid, ?2, ?3 from entries where id = ?1",
                        params![id, item.title, item.content.as_deref().or(item.summary.as_deref()).unwrap_or("")],
                    ));
                    for img in &item.images {
                        self.failure.note(self.db.execute("insert or ignore into entry_media (entry_id, url) values (?1, ?2)", params![id, img]));
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
                        attachments: item.attachments,
                    });
                } else {
                    let before: Option<(String, i64)> = current.query_row([&id], |r| Ok((r.get(0)?, r.get(1)?))).ok();
                    let had: bool = self.db.query_row("select attachments is not null from entries where id = ?1", [&id], |r| r.get(0)).unwrap_or(true);
                    self.failure.note(fill.execute(params![id, item.content, item.summary, item.author, item.title, published, attachments_json(&item.attachments)]));
                    if !had && !item.attachments.is_empty() {
                        refilled.push(id.clone());
                    }
                    if let Some(body) = item.content.as_deref().or(item.summary.as_deref()) {
                        self.failure.note(self.db.execute(
                            "update entries_fts set body = ?2 where rowid = (select rowid from entries where id = ?1) and body = ''",
                            params![id, body],
                        ));
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
        let refilled = refilled.iter().filter_map(|id| self.entry(id).map(|x| x.0)).collect();
        Inserted { added, updated, images, refilled }
    }

    pub fn set_read(&mut self, ids: &[EntryId], read: bool, now: i64) {
        let Some(mut st) = self.failure.keep(self.db.prepare_cached(
            "insert into states (entry_id, read, read_at) values (?1, ?2, ?3)
             on conflict(entry_id) do update set read = excluded.read, read_at = excluded.read_at",
        )) else {
            return;
        };
        for id in ids {
            self.failure.note(st.execute(params![id, read as i64, now]));
        }
    }

    pub fn set_bookmarked(&mut self, ids: &[EntryId], on: bool, now: i64) {
        let Some(mut st) = self.failure.keep(self.db.prepare_cached(
            "insert into states (entry_id, bookmarked, bookmarked_at) values (?1, ?2, ?3)
             on conflict(entry_id) do update set bookmarked = excluded.bookmarked, bookmarked_at = excluded.bookmarked_at",
        )) else {
            return;
        };
        for id in ids {
            self.failure.note(st.execute(params![id, on as i64, now]));
        }
    }

    pub fn remove_feed(&self, id: &str, now: i64) {
        self.failure.note(self.db.execute("update feeds set removed_at = ?2 where id = ?1", params![id, now]));
    }

    pub fn restore_feed(&self, id: &str) {
        self.failure.note(self.db.execute("update feeds set removed_at = null where id = ?1", [id]));
    }

    pub fn removed_entries(&self, feed: &str) -> Vec<Entry> {
        self.rows(
            &format!("select {ENTRY_COLS} from entries e left join states s on s.entry_id = e.id where e.feed_id = ?1 order by e.published desc"),
            [feed],
            entry_row,
        )
    }

    pub fn rename_feed(&self, id: &str, label: Option<&str>) {
        self.failure.note(self.db.execute("update feeds set label = ?2 where id = ?1", params![id, label]));
    }

    pub fn purge_removed(&self, before: i64) {
        self.failure.note(self.db.execute(
            "delete from entries_fts where rowid in (select e.rowid from entries e join feeds f on f.id = e.feed_id
             where f.removed_at is not null and f.removed_at < ?1)",
            [before],
        ));
        self.failure.note(self.db.execute("delete from feeds where removed_at is not null and removed_at < ?1", [before]));
    }

    #[profiling::function]
    pub fn prune(&mut self, settings: &Settings, now: i64) -> Vec<EntryId> {
        let cutoff = settings.max_age_days.map(|d| now - d as i64 * 86_400_000).unwrap_or(i64::MIN);
        let rows: Vec<(String, i64, bool)> = self.rows(
            "select e.id, e.published, coalesce(s.bookmarked, 0) or exists (select 1 from recommendations r where r.entry_id = e.id and r.removed_at is null)
             from entries e
             join feeds f on f.id = e.feed_id and f.removed_at is null and f.id <> 'saved'
             left join states s on s.entry_id = e.id order by e.published desc, e.id",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, i64>(2)? == 1)),
        );
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
        for id in &doomed {
            self.failure.note(self.db.execute("delete from entries_fts where rowid = (select rowid from entries where id = ?1)", [id]));
            self.failure.note(self.db.execute("delete from entries where id = ?1", [id]));
            self.failure.note(self.db.execute("delete from states where entry_id = ?1", [id]));
            self.failure.note(self.db.execute("delete from bodies where entry_id = ?1", [id]));
            self.failure.note(self.db.execute("delete from extract_failed where entry_id = ?1", [id]));
            self.failure.note(self.db.execute("delete from entry_media where entry_id = ?1", [id]));
        }
        doomed
    }

    pub fn named_hosts(&self) -> std::collections::HashSet<String> {
        let Ok(mut q) = self.db.prepare("select url from feeds where removed_at is null union all select url from entries where feed_id = ?1") else {
            return Default::default();
        };
        q.query_map([SAVED], |r| r.get::<_, String>(0))
            .map(|rows| rows.filter_map(Result::ok).filter_map(|u| url::Url::parse(&u).ok().as_ref().and_then(crate::net::host_key)).collect())
            .unwrap_or_default()
    }

    pub fn next_prefetch(&self, since: i64, retry_before: i64) -> Option<(EntryId, String)> {
        self.db
            .query_row(
                "select e.id, e.url from entries e
                 left join states s on s.entry_id = e.id
                 left join bodies b on b.entry_id = e.id
                 left join extract_failed f on f.entry_id = e.id
                 where coalesce(s.read, 0) = 0 and e.url <> '' and e.feed_id <> 'saved' and e.published >= ?1
                   and b.entry_id is null and (f.entry_id is null or f.at < ?2)
                 order by e.published desc limit 1",
                params![since, retry_before],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .ok()
            .flatten()
    }

    pub fn extract_failed(&self, id: &str, error: &str, now: i64) {
        self.failure.note(self.db.execute(
            "insert into extract_failed (entry_id, at, error) values (?1, ?2, ?3) on conflict(entry_id) do update set at = excluded.at, error = excluded.error",
            params![id, now, error],
        ));
    }

    pub fn clean_body(&self, id: &str) -> Option<String> {
        self.db
            .query_row("select clean from bodies where entry_id = ?1", [id], |r| r.get(0))
            .optional()
            .ok()
            .flatten()
    }

    pub fn set_clean_body(&self, id: &str, html: &str, now: i64) {
        self.failure.note(self.db.execute(
            "insert or replace into bodies (entry_id, clean, extracted_at) values (?1, ?2, ?3)",
            params![id, html, now],
        ));
    }

    pub fn settings(&self) -> Settings {
        let mut s = Settings::default();
        let rows: Vec<(String, String)> = self.rows("select key, value from settings", [], |r| Ok((r.get(0)?, r.get(1)?)));
        for (k, v) in rows {
            match k.as_str() {
                "max_entries" => s.max_entries = v.parse().unwrap_or(s.max_entries),
                "max_age_days" => s.max_age_days = v.parse().ok(),
                "refresh_minutes" => s.refresh_minutes = v.parse().unwrap_or(s.refresh_minutes),
                "confirm_open_over" => s.confirm_open_over = v.parse().unwrap_or(s.confirm_open_over),
                "reading_mode" => s.reading_mode = Mode::parse(&v).unwrap_or(s.reading_mode),
                "lines" => s.lines = Lines::parse(&v).unwrap_or_default(),
                "merge_duplicates" => s.merge_duplicates = v == "1",
                "appearance" => s.appearance = Appearance::parse(&v).unwrap_or_default(),
                "reading_size" => s.reading_size = v.parse().unwrap_or(s.reading_size),
                "reading_width" => s.reading_width = v.parse().unwrap_or(s.reading_width),
                "publish" => s.publish = v == "1",
                "prefetch_days" => s.prefetch_days = v.parse().unwrap_or(s.prefetch_days),
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
            ("lines", s.lines.name().to_string()),
            ("merge_duplicates", if s.merge_duplicates { "1".into() } else { "0".into() }),
            ("appearance", s.appearance.name().to_string()),
            ("reading_size", s.reading_size.to_string()),
            ("reading_width", s.reading_width.to_string()),
            ("publish", if s.publish { "1".into() } else { "0".into() }),
            ("prefetch_days", s.prefetch_days.to_string()),
        ];
        for (k, v) in pairs {
            self.failure.note(self.db.execute(
                "insert into settings (key, value) values (?1, ?2) on conflict(key) do update set value = excluded.value",
                params![k, v],
            ));
        }
    }

    pub fn token(&self) -> String {
        if let Ok(t) = self.db.query_row("select value from settings where key = 'public_token'", [], |r| r.get::<_, String>(0)) {
            return t;
        }
        let mut bytes = [0u8; 24];
        getrandom::fill(&mut bytes).expect("system randomness");
        let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        self.failure.note(self.db.execute("insert into settings (key, value) values ('public_token', ?1)", [&token]));
        token
    }

    pub fn folders(&self) -> Vec<Folder> {
        let list: Vec<(String, String)> = self.rows("select id, name from folders order by position, name collate nocase", [], |r| Ok((r.get(0)?, r.get(1)?)));
        list.into_iter()
            .map(|(id, name)| {
                let feeds = self.rows("select feed_id from folder_feeds where folder_id = ?1", [&id], |r| r.get(0));
                Folder { id, name, feeds }
            })
            .collect()
    }

    pub fn offered(&self, host: &str) -> bool {
        let key = format!("offered:{host}");
        let seen = self.db.query_row("select 1 from settings where key = ?1", [&key], |_| Ok(())).is_ok();
        if !seen {
            self.failure.note(self.db.execute("insert into settings (key, value) values (?1, '1')", [&key]));
        }
        seen
    }

    pub fn new_folder_id(&self, name: &str) -> String {
        pick_folder_id(name, |id| self.register(&format!("folder:{id}")).map(|(_, v)| v.strip_prefix('+').unwrap_or_default().to_string()))
    }

    pub fn membership_feeds(&self) -> Vec<String> {
        self.db
            .prepare("select substr(key, 9) from clock where key like 'folders:%' union select feed_id from folder_feeds")
            .and_then(|mut st| st.query_map([], |r| r.get(0)).map(|rows| rows.filter_map(Result::ok).collect()))
            .unwrap_or_default()
    }

    pub fn rebuild_folders(&mut self) {
        let named: Vec<(String, String)> = self
            .db
            .prepare("select substr(key, 8), substr(value, 2) from clock where key like 'folder:%' and value like '+%' order by key")
            .and_then(|mut st| st.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).map(|rows| rows.filter_map(Result::ok).collect()))
            .unwrap_or_default();
        let members: Vec<(String, String)> = self
            .db
            .prepare("select substr(key, 9), value from clock where key like 'folders:%' and value is not null")
            .and_then(|mut st| st.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).map(|rows| rows.filter_map(Result::ok).collect()))
            .unwrap_or_default();
        self.failure.note(self.db.execute("delete from folder_feeds", []));
        self.failure.note(self.db.execute("delete from folders", []));
        for (id, name) in &named {
            self.failure.note(self.db.execute("insert into folders (id, name) values (?1, ?2)", params![id, name]));
        }
        for (feed, ids) in members {
            for id in serde_json::from_str::<Vec<String>>(&ids).unwrap_or_default() {
                self.failure.note(self.db.execute(
                    "insert or ignore into folder_feeds (folder_id, feed_id) select ?1, ?2 where exists (select 1 from folders where id = ?1)",
                    params![id, feed],
                ));
            }
        }
    }

    pub fn set_feed_flag(&self, id: &str, column: &str, on: bool) {
        let sql = format!("update feeds set {column} = ?2 where id = ?1");
        self.failure.note(self.db.execute(&sql, params![id, on as i64]));
    }

    pub fn set_feed_mode(&self, id: &str, mode: Option<Mode>) {
        self.failure.note(self.db.execute("update feeds set mode = ?2 where id = ?1", params![id, mode.map(|m| m.name())]));
    }

    pub fn rules(&self) -> Vec<Rule> {
        self.rows("select id, word, scope from rules order by rowid", [], |r| {
            Ok(Rule { id: r.get(0)?, word: r.get(1)?, scope: scope_parse(&r.get::<_, String>(2)?) })
        })
    }

    pub fn add_rule(&self, rule: &Rule) {
        self.failure.note(self.db.execute(
            "insert or replace into rules (id, word, scope) values (?1, ?2, ?3)",
            params![rule.id, rule.word, scope_text(&rule.scope)],
        ));
    }

    pub fn remove_rule(&self, id: &str) {
        self.failure.note(self.db.execute("delete from rules where id = ?1", [id]));
    }

    pub fn recommendations(&self) -> Vec<Recommendation> {
        self.rows("select entry_id, note, at from recommendations where removed_at is null order by at desc", [], |r| {
            Ok(Recommendation { entry: r.get(0)?, note: r.get(1)?, at: r.get(2)? })
        })
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
        self.failure.note(self.db.execute("update recommendations set removed_at = ?2 where entry_id = ?1", params![id, now]));
    }

    pub fn public_items(&self) -> Vec<PublicItem> {
        let since = crate::now() - 60 * 86_400_000;
        self.rows(
            "select entry_id, note, title, url, source, published, content, at, removed_at,
             (select attachments from entries where id = entry_id) from recommendations
             where removed_at is null or removed_at > ?1 order by at desc limit 200",
            [since],
            |r| {
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
                    attachments: attachments_of(r.get(9)?),
                })
            },
        )
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
        self.failure.note(self.db.execute(
            "insert into entries (id, feed_id, source_id, url, title, published, first_seen, content, cseq)
             values (?1, ?2, ?3, ?3, ?4, ?5, ?5, ?6, (select coalesce(max(cseq), 0) + 1 from entries))
             on conflict(id) do update set content = excluded.content, title = excluded.title, cseq = excluded.cseq",
            params![id, SAVED, url, title, now, html],
        ));
        self.failure.note(self.db.execute("delete from entries_fts where rowid = (select rowid from entries where id = ?1)", [&id]));
        self.failure.note(self.db.execute(
            "insert into entries_fts (rowid, title, body) select rowid, ?2, ?3 from entries where id = ?1",
            params![id, title, html],
        ));
        self.set_clean_body(&id, html, now);
        self.entry(&id).map(|x| x.0).unwrap_or(Entry {
            id,
            feed_id: SAVED.into(),
            url: url.into(),
            title: title.into(),
            author: None,
            published: now,
            read: true,
            bookmarked: true,
            attachments: Vec::new(),
        })
    }

    pub fn import_legacy(&mut self, path: &Path) -> Result<(usize, usize), String> {
        let old = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| e.to_string())?;
        let feeds: Vec<LegacyFeed> = old
            .prepare("select id, url, label, position, etag, lastModified, lastFetched, error from feeds order by position")
            .map_err(|e| e.to_string())?
            .query_map([], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?))
            })
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect();
        let tx = self.db.savepoint().map_err(|e| e.to_string())?;
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
                    self.failure.note(tx.execute(
                        "insert into entries_fts (rowid, title, body) select rowid, ?2, '' from entries where id = ?1",
                        params![id, title],
                    ));
                }
                if read.is_some() || starred.is_some() {
                    self.failure.note(tx.execute(
                        "insert or replace into states (entry_id, read, read_at, bookmarked, bookmarked_at) values (?1, ?2, ?3, ?4, ?5)",
                        params![
                            id,
                            read.unwrap_or(0),
                            read_at.map(|t| t as i64),
                            starred.unwrap_or(0),
                            starred_at.map(|t| t as i64)
                        ],
                    ));
                }
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok((feeds.len(), count))
    }
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct WireEntry {
    pub id: String,
    pub feed_id: String,
    pub source_id: String,
    pub url: String,
    pub title: String,
    pub author: Option<String>,
    pub published: i64,
    pub first_seen: i64,
    pub summary: Option<String>,
    pub content: Option<String>,
    #[serde(default)]
    pub attachments: Vec<Attachment>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct WireFeed {
    pub id: String,
    pub url: String,
    pub title: String,
    pub site_url: Option<String>,
    pub last_fetched: Option<i64>,
    pub error: Option<String>,
}

impl Store {
    pub fn content_since(&self, cursor: i64, limit: usize) -> (Vec<WireFeed>, Vec<WireEntry>, i64) {
        let feeds = self
            .db
            .prepare_cached("select id, url, title, site_url, last_fetched, error from feeds where removed_at is null")
            .and_then(|mut st| {
                st.query_map([], |r| {
                    Ok(WireFeed { id: r.get(0)?, url: r.get(1)?, title: r.get(2)?, site_url: r.get(3)?, last_fetched: r.get(4)?, error: r.get(5)? })
                })
                .map(|rows| rows.filter_map(Result::ok).collect())
            })
            .unwrap_or_default();
        let mut next = cursor;
        let entries = self
            .db
            .prepare_cached(
                "select id, feed_id, source_id, url, title, author, published, first_seen, summary, content, cseq, attachments
                 from entries where cseq > ?1 order by cseq limit ?2",
            )
            .and_then(|mut st| {
                st.query_map(params![cursor, limit as i64], |r| {
                    Ok((
                        WireEntry {
                            id: r.get(0)?,
                            feed_id: r.get(1)?,
                            source_id: r.get(2)?,
                            url: r.get(3)?,
                            title: r.get(4)?,
                            author: r.get(5)?,
                            published: r.get(6)?,
                            first_seen: r.get(7)?,
                            summary: r.get(8)?,
                            content: r.get(9)?,
                            attachments: attachments_of(r.get(11)?),
                        },
                        r.get::<_, i64>(10)?,
                    ))
                })
                .map(|rows| rows.filter_map(Result::ok).collect::<Vec<_>>())
            })
            .unwrap_or_default()
            .into_iter()
            .map(|(e, c)| {
                next = next.max(c);
                e
            })
            .collect();
        (feeds, entries, next)
    }

    pub fn take_content(&mut self, feeds: &[WireFeed], entries: &[WireEntry]) -> Vec<Entry> {
        for f in feeds {
            self.failure.note(self.db.execute(
                "insert into feeds (id, url, title, site_url, position, last_fetched, error)
                 values (?1, ?2, ?3, ?4, 0, ?5, ?6)
                 on conflict(id) do update set title = excluded.title, site_url = excluded.site_url,
                 last_fetched = excluded.last_fetched, error = excluded.error",
                params![f.id, f.url, f.title, f.site_url, f.last_fetched, f.error],
            ));
        }
        let mut added = Vec::new();
        for e in entries {
            let n = self
                .db
                .execute(
                    "insert into entries (id, feed_id, source_id, url, title, author, published, first_seen, summary, content, attachments, cseq)
                     values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, (select coalesce(max(cseq), 0) + 1 from entries))
                     on conflict(id) do update set title = excluded.title, published = excluded.published,
                     summary = coalesce(excluded.summary, entries.summary), content = coalesce(excluded.content, entries.content),
                     attachments = coalesce(excluded.attachments, entries.attachments)",
                    params![e.id, e.feed_id, e.source_id, e.url, e.title, e.author, e.published, e.first_seen, e.summary, e.content, attachments_json(&e.attachments)],
                )
                .unwrap_or(0);
            if n > 0 {
                self.failure.note(self.db.execute("delete from entries_fts where rowid = (select rowid from entries where id = ?1)", [&e.id]));
                self.failure.note(self.db.execute(
                    "insert into entries_fts (rowid, title, body) select rowid, ?2, ?3 from entries where id = ?1",
                    params![e.id, e.title, e.content.as_deref().or(e.summary.as_deref()).unwrap_or("")],
                ));
            }
        }
        for e in entries {
            if let Some((entry, _, _)) = self.entry(&e.id) {
                added.push(entry);
            }
        }
        added
    }

    pub fn issue_code(&self, now: i64) -> String {
        let mut bytes = [0u8; 5];
        getrandom::fill(&mut bytes).expect("system randomness");
        const ALPHA: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        let mut n = u64::from_be_bytes([0, 0, 0, bytes[0], bytes[1], bytes[2], bytes[3], bytes[4]]);
        let mut code = String::new();
        for _ in 0..8 {
            code.push(ALPHA[(n % 32) as usize] as char);
            n /= 32;
        }
        self.failure.note(self.db.execute("delete from pair_codes where expires < ?1", [now]));
        self.failure.note(self.db.execute("insert into pair_codes (code_hash, expires) values (?1, ?2)", params![hash(&code), now + 15 * 60_000]));
        code
    }

    pub fn redeem_code(&self, code: &str, device: &str, name: &str, now: i64) -> Option<String> {
        let n = self
            .db
            .execute("delete from pair_codes where code_hash = ?1 and expires >= ?2", params![hash(&code.trim().to_uppercase()), now])
            .unwrap_or(0);
        if n == 0 {
            return None;
        }
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).expect("system randomness");
        let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        self.failure.note(self.db.execute(
            "insert into devices (token_hash, device, name, created) values (?1, ?2, ?3, ?4)",
            params![hash(&token), device, name, now],
        ));
        Some(token)
    }

    pub fn device_for(&self, token: &str, now: i64) -> Option<String> {
        let h = hash(token);
        let d = self.db.query_row("select device from devices where token_hash = ?1", [&h], |r| r.get::<_, String>(0)).ok()?;
        self.failure.note(self.db.execute("update devices set seen = ?2 where token_hash = ?1", params![h, now]));
        Some(d)
    }

    pub fn devices(&self) -> Vec<(String, String, Option<i64>)> {
        self.db
            .prepare("select device, name, seen from devices order by created")
            .and_then(|mut st| st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).map(|rows| rows.filter_map(Result::ok).collect()))
            .unwrap_or_default()
    }

    pub fn forget_device(&self, device: &str) {
        self.failure.note(self.db.execute("delete from devices where device = ?1", [device]));
    }

    pub fn get(&self, key: &str) -> Option<String> {
        self.db.query_row("select value from settings where key = ?1", [key], |r| r.get(0)).ok()
    }

    pub fn put(&self, key: &str, value: &str) {
        self.failure.note(self.db.execute(
            "insert into settings (key, value) values (?1, ?2) on conflict(key) do update set value = excluded.value",
            params![key, value],
        ));
    }

    pub fn outbox(&self, device: &str, after: i64, limit: usize) -> Vec<(i64, crate::types::Change)> {
        self.rows(
            "select seq, id, device, at, command from changes where seq > ?1 and device = ?2 order by seq limit ?3",
            params![after, device, limit as i64],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, i64>(3)?, r.get::<_, String>(4)?)),
        )
        .into_iter()
        .filter_map(|(seq, id, device, at, cmd)| serde_json::from_str(&cmd).ok().map(|command| (seq, crate::types::Change { id, device, at, command })))
        .collect()
    }
}

fn hash(s: &str) -> String {
    Sha256::digest(s.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

#[derive(Default)]
pub struct Inserted {
    pub added: Vec<Entry>,
    pub updated: Vec<(EntryId, String, i64)>,
    pub images: Vec<String>,
    pub refilled: Vec<Entry>,
}

pub struct MediaRow {
    pub file: String,
    pub error: Option<String>,
    pub fetched_at: i64,
}

impl Store {
    pub fn device(&self) -> String {
        if let Ok(d) = self.db.query_row("select value from settings where key = 'device_id'", [], |r| r.get::<_, String>(0)) {
            return d;
        }
        let d = new_id();
        self.failure.note(self.db.execute("insert into settings (key, value) values ('device_id', ?1)", [&d]));
        d
    }

    pub fn state_commands(&self) -> Vec<crate::types::Command> {
        use crate::types::Command;
        let mut out = Vec::new();
        let feeds: Vec<FeedState> = self
            .db
            .prepare("select id, url, title, label, pinned, hidden, mode from feeds where removed_at is null and id <> 'saved'")
            .and_then(|mut st| {
                st.query_map([], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get::<_, i64>(4)? == 1, r.get::<_, i64>(5)? == 1, r.get(6)?))
                })
                .map(|rows| rows.filter_map(Result::ok).collect())
            })
            .unwrap_or_default();
        let folders = self.folders();
        for f in &folders {
            out.push(Command::RenameFolder(f.id.clone(), f.name.clone()));
        }
        for (id, url, title, label, pinned, hidden, mode) in feeds {
            out.push(Command::Subscribe(url, title, Vec::new()));
            let pairs: Vec<(String, String)> = folders.iter().filter(|f| f.feeds.contains(&id)).map(|f| (f.id.clone(), f.name.clone())).collect();
            if !pairs.is_empty() {
                out.push(Command::Membership(id.clone(), pairs));
            }
            if label.is_some() {
                out.push(Command::Rename(id.clone(), label));
            }
            if pinned {
                out.push(Command::Pin(id.clone(), true));
            }
            if hidden {
                out.push(Command::Hide(id.clone(), true));
            }
            if let Some(m) = mode.and_then(|m| crate::types::Mode::parse(&m)) {
                out.push(Command::FeedMode(id, Some(m)));
            }
        }
        for r in self.rules() {
            out.push(Command::AddRule(r));
        }
        for r in self.recommendations() {
            out.push(Command::Recommend(r.entry, r.note));
        }
        let ids = |sql: &str| -> Vec<String> {
            self.db
                .prepare(sql)
                .and_then(|mut st| st.query_map([], |r| r.get(0)).map(|rows| rows.filter_map(Result::ok).collect()))
                .unwrap_or_default()
        };
        for chunk in ids("select entry_id from states where read = 1").chunks(500) {
            out.push(Command::Read(chunk.to_vec(), true));
        }
        for chunk in ids("select entry_id from states where bookmarked = 1").chunks(500) {
            out.push(Command::Bookmark(chunk.to_vec(), true));
        }
        out.push(Command::Settings(self.settings()));
        let tabs = self.tabs();
        if !tabs.is_empty() {
            out.push(Command::Tabs(tabs));
        }
        out
    }

    pub fn has_change(&self, id: &str) -> bool {
        self.db.query_row("select 1 from changes where id = ?1", [id], |_| Ok(())).is_ok()
    }

    pub fn log_change(&self, c: &crate::types::Change) -> i64 {
        let cmd = serde_json::to_string(&c.command).unwrap_or_default();
        self.failure.note(self.db.execute(
            "insert or ignore into changes (id, device, at, command) values (?1, ?2, ?3, ?4)",
            params![c.id, c.device, c.at, cmd],
        ));
        self.db.last_insert_rowid()
    }

    pub fn last_seq(&self) -> i64 {
        self.db.query_row("select coalesce(max(seq), 0) from changes", [], |r| r.get(0)).unwrap_or(0)
    }

    pub fn max_clock(&self) -> i64 {
        self.db.query_row("select coalesce(max(at), 0) from changes", [], |r| r.get(0)).unwrap_or(0)
    }

    pub fn changes_since(&self, seq: i64, skip_device: &str, limit: usize) -> Vec<(i64, crate::types::Change)> {
        self.rows(
            "select seq, id, device, at, command from changes where seq > ?1 and device <> ?2 order by seq limit ?3",
            params![seq, skip_device, limit as i64],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, i64>(3)?, r.get::<_, String>(4)?)),
        )
        .into_iter()
        .filter_map(|(seq, id, device, at, cmd)| {
            serde_json::from_str(&cmd).ok().map(|command| (seq, crate::types::Change { id, device, at, command }))
        })
        .collect()
    }

    pub fn claim(&self, key: &str, at: i64, device: &str, value: &str) -> bool {
        let won = self.newer(key, at, device);
        if won {
            self.failure.note(self.db.execute("update clock set value = ?2 where key = ?1", params![key, value]));
        }
        won
    }

    pub fn register(&self, key: &str) -> Option<(i64, String)> {
        self.db
            .query_row("select at, value from clock where key = ?1 and value is not null", [key], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()
            .ok()
            .flatten()
    }

    pub fn newer(&self, key: &str, at: i64, device: &str) -> bool {
        let current: Option<(i64, String)> = self
            .db
            .query_row("select at, device from clock where key = ?1", [key], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()
            .unwrap_or(None);
        let win = match current {
            None => true,
            Some((a, d)) => at > a || (at == a && device > d.as_str()),
        };
        if win {
            self.failure.note(self.db.execute(
                "insert into clock (key, at, device) values (?1, ?2, ?3) on conflict(key) do update set at = excluded.at, device = excluded.device",
                params![key, at, device],
            ));
        }
        win
    }

    pub fn due(&self, now: i64) -> std::collections::HashSet<String> {
        self.db
            .prepare("select id from feeds where removed_at is null and (next_at is null or next_at <= ?1)")
            .and_then(|mut st| st.query_map([now + 30_000], |r| r.get::<_, String>(0)).map(|rows| rows.filter_map(Result::ok).collect()))
            .unwrap_or_default()
    }

    pub fn reschedule(&self, id: &str, ok: bool, fresh: bool, hint: Option<i64>, base: i64, now: i64) {
        let (fails, interval): (i64, i64) = self
            .db
            .query_row("select fails, interval from feeds where id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap_or((0, 0));
        let (fails, interval) = crate::schedule::next(ok, fresh, fails, interval, base);
        let wait = if ok { interval } else { crate::schedule::backoff(fails, base) };
        let next = now + wait.max(hint.unwrap_or(0));
        self.failure.note(self.db.execute(
            "update feeds set next_at = ?2, fails = ?3, interval = ?4 where id = ?1",
            params![id, next, fails, interval],
        ));
    }

    pub fn tabs(&self) -> Vec<crate::types::TabState> {
        self.db
            .query_row("select value from settings where key = 'tabs'", [], |r| r.get::<_, String>(0))
            .ok()
            .and_then(|v| serde_json::from_str(&v).ok())
            .unwrap_or_default()
    }

    pub fn set_tabs(&self, tabs: &[crate::types::TabState]) {
        if let Ok(v) = serde_json::to_string(tabs) {
            self.failure.note(self.db.execute(
                "insert into settings (key, value) values ('tabs', ?1) on conflict(key) do update set value = excluded.value",
                [v],
            ));
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
        self.failure.note(self.db.execute("update media set used_at = ?2 where url = ?1", params![url, now]));
    }

    pub fn set_media(&self, url: &str, file: &str, kind: &str, bytes: i64, error: Option<&str>, now: i64) {
        self.failure.note(self.db.execute(
            "insert into media (url, file, kind, bytes, error, fetched_at, used_at) values (?1, ?2, ?3, ?4, ?5, ?6, ?6)
             on conflict(url) do update set file = excluded.file, kind = excluded.kind, bytes = excluded.bytes,
             error = excluded.error, fetched_at = excluded.fetched_at, used_at = excluded.used_at",
            params![url, file, kind, bytes, error, now],
        ));
    }

    pub fn link_media(&mut self, links: &[(EntryId, String)]) {
        for (entry, url) in links {
            self.failure.note(self.db.execute("insert or ignore into entry_media (entry_id, url) values (?1, ?2)", params![entry, url]));
        }
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
        self.failure.note(self.db.execute(&format!("delete from media where used_at < ?1 and not {kept}"), [week]));
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
                self.failure.note(self.db.execute("delete from media where url = ?1", [&url]));
                doomed.push(file);
                over -= bytes;
            }
        }
        self.failure.note(self.db.execute("delete from entry_media where entry_id not in (select id from entries)", []));
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
    pub attachments: Vec<Attachment>,
}
