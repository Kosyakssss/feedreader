mod net;
mod parse;
mod public;
pub mod rules;
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

const MEDIA_BUDGET: i64 = 1_000_000_000;

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

pub fn article_text(html: &str, base: &str) -> String {
    let mut out = Vec::new();
    for b in parse::blocks(html, Some(base)) {
        let inline = |i: &[Inline]| {
            i.iter()
                .map(|x| match x {
                    Inline::Text(t) | Inline::Bold(t) | Inline::Italic(t) | Inline::Code(t) | Inline::Link(t, _) => t.as_str(),
                    Inline::Break => "\n",
                })
                .collect::<String>()
        };
        out.push(match b {
            Block::Heading(_, i) => format!("## {}", inline(&i)),
            Block::Paragraph(i) => inline(&i),
            Block::Quote(i) => format!("> {}", inline(&i)),
            Block::Item(depth, n, i) => format!(
                "{}{} {}",
                "  ".repeat(depth.saturating_sub(1) as usize),
                n.map(|n| format!("{n}.")).unwrap_or_else(|| "-".into()),
                inline(&i)
            ),
            Block::Code(c) => format!("```\n{c}\n```"),
            Block::Image(src, alt, _) => format!("[image: {}] {src}", alt),
            Block::Media(src, kind) => format!("[{kind}] {src}"),
            Block::Rule => "---".into(),
        });
    }
    out.join("\n\n")
}

pub fn check_input(input: &str) -> Result<(), String> {
    net::parse_url(input).map(|_| ())
}

pub fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub fn start(dir: PathBuf, emit: impl Fn(Event) + Send + 'static) -> Handle {
    let (tx, rx) = unbounded_channel();
    std::thread::Builder::new()
        .name("engine".into())
        .spawn(move || {
            profiling::register_thread!("engine");
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

#[derive(Clone)]
enum Job {
    Entry(EntryId),
    Save(String),
    Probe(String),
}

enum Internal {
    Page(Job, Result<(String, String), String>),
    MediaFetched(String, Result<(String, String, i64), String>),
    Read(Job, Result<Extracted, String>, Extractor),
    Fetched(FeedId, Result<Fetch, String>),
    RefreshDone(u64),
    Discovered(String, Result<Vec<Candidate>, String>),
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
    published: public::Shared,
    public_url: Option<String>,
    web_extractor: bool,
    media_inflight: HashSet<String>,
    media_waiting: HashSet<String>,
    media_gate: std::sync::Arc<tokio::sync::Semaphore>,
    jobs: std::collections::HashMap<u64, (Job, String, String)>,
    next_job: u64,
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
            published: Default::default(),
            public_url: None,
            web_extractor: false,
            media_inflight: HashSet::new(),
            media_waiting: HashSet::new(),
            media_gate: std::sync::Arc::new(tokio::sync::Semaphore::new(4)),
            jobs: Default::default(),
            next_job: 0,
        })
    }

    #[profiling::function]
    fn snapshot(&self) {
        (self.emit)(Event::Snapshot {
            feeds: self.store.feeds(),
            entries: self.store.entries(),
            settings: self.settings.clone(),
            data_dir: self.dir.display().to_string(),
            folders: self.store.folders(),
            rules: self.store.rules(),
            recommendations: self.store.recommendations(),
            public_url: self.public_url.clone(),
        });
    }

    #[profiling::function]
    fn publish(&mut self) {
        let token = self.store.token();
        let base = format!("http://127.0.0.1:{}/{token}/", self.settings.public_port);
        let items = self.store.public_items();
        let mut p = self.published.write().unwrap();
        p.atom = public::atom(&token, &base, &items);
        p.html = public::page(&base, &items);
        p.token = token;
    }

    async fn run(mut self, mut rx: UnboundedReceiver<Request>) {
        let (itx, mut irx) = unbounded_channel();
        self.itx = Some(itx);
        self.publish();
        let port = self.settings.public_port;
        match std::net::TcpListener::bind(("127.0.0.1", port)) {
            Ok(probe) => {
                drop(probe);
                let shared = self.published.clone();
                tokio::spawn(async move {
                    let _ = public::serve(port, shared).await;
                });
                self.public_url = Some(format!("http://127.0.0.1:{port}/{}/", self.store.token()));
            }
            Err(_) => self.public_url = None,
        }
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

    fn fetch_page(&self, job: Job, url: String) {
        let client = self.client.clone();
        self.spawn(async move {
            let r = work::fetch_page(&client, &url).await;
            Internal::Page(job, r)
        });
    }

    fn read_locally(&self, job: Job, url: String, html: String) {
        self.spawn(async move {
            let r = tokio::task::spawn_blocking(move || work::readability(&url, html))
                .await
                .map_err(|e| e.to_string())
                .and_then(|r| r);
            Internal::Read(job, r, Extractor::Readability)
        });
    }

    fn page(&mut self, job: Job, r: Result<(String, String), String>) {
        match r {
            Err(e) => self.read(job, Err(e), Extractor::Readability),
            Ok((url, html)) if self.web_extractor => {
                self.next_job += 1;
                let id = self.next_job;
                self.jobs.insert(id, (job, url.clone(), html.clone()));
                (self.emit)(Event::Extract { job: id, url, html });
            }
            Ok((url, html)) => self.read_locally(job, url, html),
        }
    }

    fn read(&mut self, job: Job, r: Result<Extracted, String>, by: Extractor) {
        match job {
            Job::Entry(id) => self.extracted(id, r.map(|x| x.html)),
            Job::Save(url) => match r {
                Ok(x) => {
                    let title = if x.title.is_empty() {
                        url::Url::parse(&url).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_else(|| url.clone())
                    } else {
                        x.title
                    };
                    let e = self.store.save_link(&url, &title, &x.html, now());
                    (self.emit)(Event::EntriesAdded(vec![e]));
                    (self.emit)(Event::Message(format!("Saved \u{201C}{title}\u{201D} to Bookmarks.")));
                }
                Err(e) => (self.emit)(Event::Message(format!("Couldn't save {url}: {e}"))),
            },
            Job::Probe(url) => (self.emit)(Event::Probed(url, r.map(|x| (x, by)))),
        }
    }

    fn extracted(&mut self, id: EntryId, r: Result<String, String>) {
        let Some((entry, content, summary)) = self.store.entry(&id) else { return };
        let feed_html = content.or(summary).unwrap_or_default();
        let feed_text = parse::text_of(&feed_html, true).len();
        let extracted = r.as_ref().map(|html| parse::text_of(html, true).len()).unwrap_or(0);
        let use_feed = feed_text > 200 && extracted * 2 < feed_text;
        let (blocks, note) = match r {
            Ok(html) if !use_feed => {
                self.store.set_clean_body(&id, &html, now());
                let base = url::Url::parse(&entry.url).ok();
                let links: Vec<(EntryId, String)> = parse::image_urls(&html, base.as_ref(), 40).into_iter().map(|u| (id.clone(), u)).collect();
                self.store.link_media(&links);
                (Ok(parse::blocks(&html, Some(&entry.url))), None)
            }
            Ok(_) => (
                Ok(parse::blocks(&feed_html, Some(&entry.url))),
                Some("The page had less text than the feed, so this is the feed's own text.".to_string()),
            ),
            Err(e) if feed_text > 0 => (
                Ok(parse::blocks(&feed_html, Some(&entry.url))),
                Some(format!("The page couldn't be extracted ({e}), so this is the feed's own text.")),
            ),
            Err(e) => (Err(e), None),
        };
        (self.emit)(Event::Body(Body {
            entry: id,
            mode: Mode::Clean,
            blocks,
            note,
        }));
    }

    fn known(&self) -> HashSet<String> {
        self.store.feeds().into_iter().filter(|f| f.id != SAVED).map(|f| f.id).collect()
    }

    fn start_refresh(&mut self) {
        if self.status.running {
            return;
        }
        let feeds: Vec<Feed> = self.store.feeds().into_iter().filter(|f| f.id != SAVED).collect();
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
        let r = self.apply_fetch_inner(id, result);
        r.map(|ins| {
            if !ins.updated.is_empty() {
                (self.emit)(Event::EntriesUpdated(ins.updated));
            }
            self.want_media(ins.images, false);
            ins.added
        })
    }

    fn want_media(&mut self, urls: Vec<String>, reply: bool) {
        let t = now();
        for url in urls {
            if let Some(row) = self.store.media(&url) {
                let path = self.dir.join("media").join(&row.file);
                if row.error.is_none() && !row.file.is_empty() && path.is_file() {
                    self.store.touch_media(&url, t);
                    if reply {
                        (self.emit)(Event::Media(url, Ok(path)));
                    }
                    continue;
                }
                if let Some(e) = row.error.filter(|_| t - row.fetched_at < 86_400_000) {
                    if reply {
                        (self.emit)(Event::Media(url, Err(e)));
                    }
                    continue;
                }
            }
            if reply {
                self.media_waiting.insert(url.clone());
            }
            if !self.media_inflight.insert(url.clone()) {
                continue;
            }
            let client = self.client.clone();
            let dir = self.dir.join("media");
            let gate = self.media_gate.clone();
            self.spawn(async move {
                let _permit = gate.acquire_owned().await;
                let r = work::fetch_media(&client, &url, &dir).await;
                Internal::MediaFetched(url, r)
            });
        }
    }

    fn apply_fetch_inner(&mut self, id: &str, result: Result<Fetch, String>) -> Result<store::Inserted, String> {
        let t = now();
        match result {
            Ok(Fetch::NotModified) => {
                self.store.set_fetch_result(id, None, None, None, None, t);
                Ok(store::Inserted { added: Vec::new(), updated: Vec::new(), images: Vec::new() })
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

    #[profiling::function]
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
                for file in self.store.prune_media(now(), MEDIA_BUDGET) {
                    let _ = std::fs::remove_file(self.dir.join("media").join(file));
                }
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
            Internal::Page(job, r) => self.page(job, r),
            Internal::MediaFetched(url, r) => {
                self.media_inflight.remove(&url);
                let t = now();
                let reply = match r {
                    Ok((file, kind, bytes)) => {
                        self.store.set_media(&url, &file, &kind, bytes, None, t);
                        Ok(self.dir.join("media").join(file))
                    }
                    Err(e) => {
                        self.store.set_media(&url, "", "", 0, Some(&e), t);
                        Err(e)
                    }
                };
                if self.media_waiting.remove(&url) {
                    (self.emit)(Event::Media(url, reply));
                }
            }
            Internal::Read(job, r, by) => self.read(job, r, by),
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

    #[profiling::function]
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
                let feeds: Vec<Feed> = self.store.feeds().into_iter().filter(|f| f.id != SAVED).collect();
                let text = work::write_opml(&feeds);
                let msg = match std::fs::write(&path, text) {
                    Ok(()) => format!("Exported {} feeds to {}", feeds.len(), path.display()),
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
                        (self.emit)(Event::Body(Body { entry: id, mode, blocks, note: None }));
                    }
                    Mode::Clean => {
                        if let Some(html) = self.store.clean_body(&id) {
                            (self.emit)(Event::Body(Body {
                                entry: id,
                                mode,
                                blocks: Ok(parse::blocks(&html, Some(&entry.url))),
                                note: None,
                            }));
                            return;
                        }
                        if entry.url.is_empty() {
                            (self.emit)(Event::Body(Body {
                                entry: id,
                                mode,
                                blocks: Err("This entry has no link to extract.".into()),
                                note: None,
                            }));
                            return;
                        }
                        self.fetch_page(Job::Entry(id), entry.url.clone());
                    }
                }
            }
            Request::SetFeedFolders(feed, names) => {
                self.store.set_feed_folders(&feed, &names, now());
                (self.emit)(Event::Folders(self.store.folders()));
            }
            Request::RenameFolder(id, name) => {
                self.store.rename_folder(&id, &name);
                (self.emit)(Event::Folders(self.store.folders()));
            }
            Request::DeleteFolder(id) => {
                self.store.delete_folder(&id);
                (self.emit)(Event::Folders(self.store.folders()));
            }
            Request::RestoreFolder(f) => {
                self.store.restore_folder(&f);
                (self.emit)(Event::Folders(self.store.folders()));
            }
            Request::SetPinned(id, on) => {
                self.store.set_feed_flag(&id, "pinned", on);
                (self.emit)(Event::Feeds(self.store.feeds()));
            }
            Request::SetHidden(id, on) => {
                self.store.set_feed_flag(&id, "hidden", on);
                (self.emit)(Event::Feeds(self.store.feeds()));
            }
            Request::SetFeedMode(id, mode) => {
                self.store.set_feed_mode(&id, mode);
                (self.emit)(Event::Feeds(self.store.feeds()));
            }
            Request::AddRule(rule) => {
                self.store.add_rule(&rule);
                (self.emit)(Event::Rules(self.store.rules()));
            }
            Request::RemoveRule(id) => {
                self.store.remove_rule(&id);
                (self.emit)(Event::Rules(self.store.rules()));
            }
            Request::Recommend(id, note) => {
                if self.store.recommend(&id, &note, now()) {
                    self.publish();
                }
                (self.emit)(Event::Recommendations(self.store.recommendations()));
            }
            Request::Unrecommend(id) => {
                self.store.unrecommend(&id, now());
                self.publish();
                (self.emit)(Event::Recommendations(self.store.recommendations()));
            }
            Request::Search(q) => {
                let ids = self.store.search(&q);
                (self.emit)(Event::SearchResults(q, ids));
            }
            Request::SaveLink(input) => match net::parse_url(&input) {
                Ok(u) => self.fetch_page(Job::Save(u.to_string()), u.to_string()),
                Err(e) => (self.emit)(Event::Message(format!("Couldn't save {input}: {e}"))),
            },
            Request::Probe(input) => match net::parse_url(&input) {
                Ok(u) => self.fetch_page(Job::Probe(u.to_string()), u.to_string()),
                Err(e) => (self.emit)(Event::Probed(input, Err(e))),
            },
            Request::UseWebExtractor => self.web_extractor = true,
            Request::Media(urls) => self.want_media(urls, true),
            Request::Extracted(id, r) => {
                let Some((job, url, html)) = self.jobs.remove(&id) else { return };
                match r {
                    Ok(x) if !x.html.trim().is_empty() => self.read(job, Ok(x), Extractor::Defuddle),
                    _ => self.read_locally(job, url, html),
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
