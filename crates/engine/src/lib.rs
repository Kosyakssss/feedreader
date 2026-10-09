mod net;
mod parse;
mod store;
mod types;
mod work;

use std::collections::HashSet;
use std::path::PathBuf;
use std::time::Duration;

use futures::StreamExt;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};
use tokio::time::Instant;
use url::Url;

pub use types::*;

use parse::ParsedFeed;
use store::Store;

pub struct Handle {
    tx: UnboundedSender<Request>,
}

impl Handle {
    pub fn send(&self, request: Request) {
        let _ = self.tx.send(request);
    }
}

pub fn data_dir() -> PathBuf {
    match std::env::var_os("FEEDREADER_HOME") {
        Some(d) => PathBuf::from(d),
        None => dirs::data_dir().unwrap_or_else(std::env::temp_dir).join("Feedreader"),
    }
}

pub fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub fn start(dir: PathBuf, emit: impl Fn(Event) + Send + 'static) -> Handle {
    let (tx, rx) = unbounded_channel();
    std::thread::Builder::new()
        .name("engine".into())
        .spawn(move || {
            let rt = tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()
                .expect("runtime");
            rt.block_on(async move {
                match Engine::new(dir, Box::new(emit)) {
                    Ok(engine) => engine.run(rx).await,
                    Err(e) => eprintln!("engine failed to start: {e}"),
                }
            });
        })
        .expect("engine thread");
    Handle { tx }
}

enum Fetch {
    NotModified,
    Parsed(ParsedFeed, (Option<String>, Option<String>)),
}

enum Internal {
    Fetched(FeedId, Result<Fetch, String>),
    RefreshDone(u64),
    Discovered(String, Result<Vec<Candidate>, String>),
    Extracted(EntryId, Result<String, String>),
    Added(FeedId, Result<Fetch, String>),
}

struct Engine {
    dir: PathBuf,
    store: Store,
    client: reqwest::Client,
    emit: Box<dyn Fn(Event) + Send>,
    settings: Settings,
    status: RefreshStatus,
    next: Instant,
    itx: Option<UnboundedSender<Internal>>,
}

async fn fetch_feed(client: &reqwest::Client, url: &str, validators: (Option<String>, Option<String>)) -> Result<Fetch, String> {
    let u = Url::parse(url).map_err(|e| e.to_string())?;
    let f = net::fetch(client, &u, work::FEED_ACCEPT, Some(validators), Duration::from_secs(8), 10_000_000).await?;
    if f.status == 304 {
        return Ok(Fetch::NotModified);
    }
    if f.status >= 400 {
        return Err(format!("HTTP {}", f.status));
    }
    let base = f.url.to_string();
    let validators = (f.etag, f.last_modified);
    let parsed = tokio::task::spawn_blocking(move || parse::parse_feed(&f.body, &base))
        .await
        .map_err(|e| e.to_string())??;
    Ok(Fetch::Parsed(parsed, validators))
}

impl Engine {
    fn new(dir: PathBuf, emit: Box<dyn Fn(Event) + Send>) -> Result<Self, String> {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let store = Store::open(&dir.join("feedreader.sqlite")).map_err(|e| e.to_string())?;
        let settings = store.settings();
        Ok(Self {
            dir,
            store,
            client: net::client(),
            emit,
            settings,
            status: RefreshStatus::default(),
            next: Instant::now() + Duration::from_millis(800),
            itx: None,
        })
    }

    fn snapshot(&self) {
        (self.emit)(Event::Snapshot {
            feeds: self.store.feeds(),
            entries: self.store.entries(),
            settings: self.settings.clone(),
            data_dir: self.dir.display().to_string(),
        });
    }

    async fn run(mut self, mut rx: UnboundedReceiver<Request>) {
        let (itx, mut irx) = unbounded_channel();
        self.itx = Some(itx);
        self.snapshot();
        loop {
            tokio::select! {
                r = rx.recv() => match r {
                    Some(r) => self.request(r),
                    None => break,
                },
                Some(i) = irx.recv() => self.internal(i),
                _ = tokio::time::sleep_until(self.next) => self.start_refresh(),
            }
        }
    }

    fn spawn<F>(&self, fut: F)
    where
        F: Future<Output = Internal> + Send + 'static,
    {
        let tx = self.itx.clone().expect("running");
        tokio::spawn(async move {
            let _ = tx.send(fut.await);
        });
    }

    fn known(&self) -> HashSet<String> {
        self.store.feeds().into_iter().map(|f| f.id).collect()
    }

    fn start_refresh(&mut self) {
        if self.status.running {
            return;
        }
        let feeds = self.store.feeds();
        self.status = RefreshStatus {
            run: self.status.run + 1,
            running: true,
            total: feeds.len(),
            started_at: now(),
            ..Default::default()
        };
        self.next = Instant::now() + Duration::from_secs(24 * 3600);
        (self.emit)(Event::Refresh(self.status.clone()));
        let list: Vec<_> = feeds
            .into_iter()
            .map(|f| {
                let v = self.store.validators(&f.id);
                (f.id, f.url, v)
            })
            .collect();
        let client = self.client.clone();
        let tx = self.itx.clone().expect("running");
        let run = self.status.run;
        tokio::spawn(async move {
            futures::stream::iter(list)
                .map(|(id, url, v)| {
                    let c = client.clone();
                    async move { (id, fetch_feed(&c, &url, v).await) }
                })
                .buffer_unordered(8)
                .for_each(|(id, r)| {
                    let _ = tx.send(Internal::Fetched(id, r));
                    async {}
                })
                .await;
            let _ = tx.send(Internal::RefreshDone(run));
        });
    }

    fn apply_fetch(&mut self, id: &str, result: Result<Fetch, String>) -> Result<Vec<Entry>, String> {
        let t = now();
        match result {
            Ok(Fetch::NotModified) => {
                self.store.set_fetch_result(id, None, None, None, None, t);
                Ok(Vec::new())
            }
            Ok(Fetch::Parsed(parsed, validators)) => {
                let error = parsed.entries.is_empty().then_some("Feed returned no entries");
                self.store.set_fetch_result(
                    id,
                    Some(&parsed.title),
                    parsed.site_url.as_deref(),
                    Some(validators),
                    error,
                    t,
                );
                Ok(self.store.insert_entries(id, parsed.entries, t))
            }
            Err(e) => {
                self.store.set_fetch_result(id, None, None, None, Some(&e), t);
                Err(e)
            }
        }
    }

    fn internal(&mut self, i: Internal) {
        match i {
            Internal::Fetched(id, result) => {
                self.status.completed += 1;
                match self.apply_fetch(&id, result) {
                    Ok(added) => {
                        self.status.added += added.len();
                        if !added.is_empty() {
                            (self.emit)(Event::EntriesAdded(added));
                        }
                    }
                    Err(_) => self.status.failed += 1,
                }
                (self.emit)(Event::Refresh(self.status.clone()));
            }
            Internal::RefreshDone(run) if run == self.status.run => {
                let removed = self.store.prune(&self.settings, now());
                if !removed.is_empty() {
                    (self.emit)(Event::EntriesRemoved(removed));
                }
                self.store.purge_removed(now() - 24 * 3600 * 1000);
                let wait = Duration::from_secs(self.settings.refresh_minutes.max(1) as u64 * 60);
                self.next = Instant::now() + wait;
                self.status.running = false;
                self.status.finished_at = Some(now());
                self.status.next_at = Some(now() + wait.as_millis() as i64);
                (self.emit)(Event::Feeds(self.store.feeds()));
                (self.emit)(Event::Refresh(self.status.clone()));
            }
            Internal::RefreshDone(_) => {}
            Internal::Discovered(q, r) => (self.emit)(Event::Discovered(q, r)),
            Internal::Extracted(id, r) => {
                let url = self.store.entry(&id).map(|(e, _, _)| e.url).unwrap_or_default();
                let blocks = r.map(|html| {
                    self.store.set_clean_body(&id, &html, now());
                    parse::blocks(&html, Some(&url))
                });
                (self.emit)(Event::Body(Body {
                    entry: id,
                    mode: Mode::Clean,
                    blocks,
                }));
            }
            Internal::Added(id, r) => {
                let result = self.apply_fetch(&id, r);
                (self.emit)(Event::Feeds(self.store.feeds()));
                match result {
                    Ok(added) => {
                        let n = added.len();
                        if !added.is_empty() {
                            (self.emit)(Event::EntriesAdded(added));
                        }
                        if let Some(f) = self.store.feed(&id) {
                            (self.emit)(Event::FeedAdded(Ok((f, n))));
                        }
                    }
                    Err(e) => (self.emit)(Event::FeedAdded(Err(e))),
                }
            }
        }
    }

    fn request(&mut self, r: Request) {
        match r {
            Request::SetRead(ids, v) => self.store.set_read(&ids, v, now()),
            Request::SetBookmarked(ids, v) => self.store.set_bookmarked(&ids, v, now()),
            Request::Refresh => self.start_refresh(),
            Request::Discover(q) => {
                let client = self.client.clone();
                let known = self.known();
                self.spawn(async move {
                    let r = work::discover(&client, &q, &known).await;
                    Internal::Discovered(q, r)
                });
            }
            Request::AddFeed(url, title) => {
                let feed = match self.store.add_feed(&url, &title) {
                    Ok(f) => f,
                    Err(e) => {
                        (self.emit)(Event::FeedAdded(Err(e.to_string())));
                        return;
                    }
                };
                (self.emit)(Event::Feeds(self.store.feeds()));
                (self.emit)(Event::EntriesAdded(self.store.removed_entries(&feed.id)));
                let client = self.client.clone();
                let v = self.store.validators(&feed.id);
                self.spawn(async move {
                    let r = fetch_feed(&client, &feed.url, v).await;
                    Internal::Added(feed.id, r)
                });
            }
            Request::RemoveFeed(id) => {
                self.store.remove_feed(&id, now());
                (self.emit)(Event::Feeds(self.store.feeds()));
            }
            Request::RestoreFeed(id) => {
                self.store.restore_feed(&id);
                (self.emit)(Event::Feeds(self.store.feeds()));
            }
            Request::RenameFeed(id, label) => {
                self.store.rename_feed(&id, label.as_deref().filter(|l| !l.trim().is_empty()));
                (self.emit)(Event::Feeds(self.store.feeds()));
            }
            Request::ImportOpml(path) => {
                let text = match std::fs::read_to_string(&path) {
                    Ok(t) => t,
                    Err(e) => {
                        (self.emit)(Event::Message(format!("Couldn't read {}: {e}", path.display())));
                        return;
                    }
                };
                let known = self.known();
                let mut added = 0;
                let mut skipped = 0;
                for (url, title) in work::read_opml(&text) {
                    match net::parse_url(&url) {
                        Ok(u) if !known.contains(&store::feed_id(u.as_str())) => {
                            if self.store.add_feed(u.as_str(), &title).is_ok() {
                                added += 1;
                            }
                        }
                        Ok(_) => {}
                        Err(_) => skipped += 1,
                    }
                }
                (self.emit)(Event::Feeds(self.store.feeds()));
                let skipped = if skipped > 0 { format!(", skipped {skipped} unsafe links") } else { String::new() };
                (self.emit)(Event::Message(format!("Imported {added} new feeds{skipped}")));
                if added > 0 {
                    self.start_refresh();
                }
            }
            Request::ExportOpml(path) => {
                let text = work::write_opml(&self.store.feeds());
                let msg = match std::fs::write(&path, text) {
                    Ok(()) => format!("Exported {} feeds to {}", self.store.feeds().len(), path.display()),
                    Err(e) => format!("Couldn't write {}: {e}", path.display()),
                };
                (self.emit)(Event::Message(msg));
            }
            Request::ImportLegacy(path) => {
                let msg = match self.store.import_legacy(&path) {
                    Ok((f, e)) => format!("Imported {f} feeds and {e} entries from {}", path.display()),
                    Err(e) => format!("Import failed: {e}"),
                };
                self.snapshot();
                (self.emit)(Event::Message(msg));
            }
            Request::LoadBody(id, mode) => {
                let Some((entry, content, summary)) = self.store.entry(&id) else { return };
                match mode {
                    Mode::Feed | Mode::Original => {
                        let html = content.or(summary).unwrap_or_default();
                        let blocks = if html.trim().is_empty() {
                            Err("This feed doesn't include the text of its entries.".into())
                        } else {
                            Ok(parse::blocks(&html, Some(&entry.url)))
                        };
                        (self.emit)(Event::Body(Body { entry: id, mode, blocks }));
                    }
                    Mode::Clean => {
                        if let Some(html) = self.store.clean_body(&id) {
                            (self.emit)(Event::Body(Body {
                                entry: id,
                                mode,
                                blocks: Ok(parse::blocks(&html, Some(&entry.url))),
                            }));
                            return;
                        }
                        if entry.url.is_empty() {
                            (self.emit)(Event::Body(Body {
                                entry: id,
                                mode,
                                blocks: Err("This entry has no link to extract.".into()),
                            }));
                            return;
                        }
                        let client = self.client.clone();
                        self.spawn(async move {
                            let r = work::extract(&client, &entry.url).await;
                            Internal::Extracted(id, r)
                        });
                    }
                }
            }
            Request::SetSettings(s) => {
                let interval_changed = s.refresh_minutes != self.settings.refresh_minutes;
                let retention_changed = s.max_entries != self.settings.max_entries || s.max_age_days != self.settings.max_age_days;
                self.store.save_settings(&s);
                self.settings = s;
                if interval_changed && !self.status.running {
                    let wait = Duration::from_secs(self.settings.refresh_minutes.max(1) as u64 * 60);
                    self.next = Instant::now() + wait;
                    self.status.next_at = Some(now() + wait.as_millis() as i64);
                    (self.emit)(Event::Refresh(self.status.clone()));
                }
                if retention_changed {
                    let removed = self.store.prune(&self.settings, now());
                    if !removed.is_empty() {
                        (self.emit)(Event::EntriesRemoved(removed));
                    }
                }
                (self.emit)(Event::Settings(self.settings.clone()));
            }
        }
    }
}
