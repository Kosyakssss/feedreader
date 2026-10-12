mod config;
mod net;
mod parse;
mod public;
pub mod rules;
pub mod serve;
mod hub;
mod limit;
#[cfg(test)]
mod laws;
mod sat;
mod schedule;
mod store;
mod tailscale;
mod types;
mod work;

use std::collections::HashSet;
use std::path::PathBuf;
use std::time::Duration;

use futures::StreamExt;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};
use tokio::time::Instant;
use url::Url;

pub use config::Config;
pub use net::may_navigate;
pub use types::*;

use parse::ParsedFeed;
use store::Store;

pub const PROTOCOL: u32 = 3;

fn lan_ip() -> Option<std::net::IpAddr> {
    let s = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("192.0.2.1:9").ok()?;
    s.local_addr().ok().map(|a| a.ip()).filter(|ip| !ip.is_loopback() && !ip.is_unspecified())
}

enum Link {
    Local(UnboundedSender<(Client, Request)>),
    Socket(std::sync::mpsc::Sender<Request>, std::thread::JoinHandle<()>),
}

pub struct Handle {
    link: Link,
}

impl Handle {
    pub fn send(&self, request: Request) {
        self.send_as(0, request);
    }

    fn send_as(&self, client: Client, request: Request) {
        match &self.link {
            Link::Local(tx) => {
                let _ = tx.send((client, request));
            }
            Link::Socket(tx, _) => {
                let _ = tx.send(request);
            }
        }
    }

    pub fn attached(&self) -> bool {
        matches!(self.link, Link::Socket(..))
    }

    pub fn close(self) {
        if let Link::Socket(tx, writer) = self.link {
            drop(tx);
            let _ = writer.join();
        }
    }
}

pub fn log_dir() -> PathBuf {
    if cfg!(target_os = "macos") {
        dirs::home_dir().unwrap_or_else(std::env::temp_dir).join("Library/Logs/feedreader")
    } else {
        dirs::state_dir().or_else(dirs::data_local_dir).unwrap_or_else(std::env::temp_dir).join("feedreader")
    }
}

pub fn attach(dir: PathBuf, emit: std::sync::Arc<dyn Fn(Event) + Send + Sync>, background: bool) -> Result<Handle, String> {
    if serve::running(&dir) && serve::protocol(&dir) != Some(PROTOCOL) {
        serve::stop(&dir);
    }
    if let Some(h) = serve::connect(&dir, emit.clone()) {
        return Ok(h);
    }
    if background
        && serve::spawn_background(&dir)
        && let Some(h) = serve::connect(&dir, emit.clone())
    {
        return Ok(h);
    }
    start(dir, move |e, _| emit(e))
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

pub fn check_pairing_link(link: &str) -> Result<(), String> {
    sat::parse_link(link).map(|_| ())
}

pub fn check_input(input: &str) -> Result<(), String> {
    net::parse_url(input).map(|_| ())
}

pub fn new_id() -> String {
    store::new_id()
}

pub fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub fn start(dir: PathBuf, emit: impl Fn(Event, Audience) + Send + 'static) -> Result<Handle, String> {
    launch(dir, emit).map(|(handle, _, _)| handle)
}

type Launched = (Handle, tokio::runtime::Handle, tokio::sync::oneshot::Receiver<()>);

fn launch(dir: PathBuf, emit: impl Fn(Event, Audience) + Send + 'static) -> Result<Launched, String> {
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let lock = std::fs::File::options()
        .create(true)
        .truncate(false)
        .write(true)
        .open(dir.join("engine.lock"))
        .map_err(|e| e.to_string())?;
    lock.try_lock().map_err(|_| format!("Another Feedreader engine is using {}", dir.display()))?;
    let engine = Engine::new(dir, Box::new(emit))?;
    let (tx, rx) = unbounded_channel();
    let (stopped, on_stop) = tokio::sync::oneshot::channel();
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().map_err(|e| e.to_string())?;
    let runtime = rt.handle().clone();
    std::thread::Builder::new()
        .name("engine".into())
        .spawn(move || {
            profiling::register_thread!("engine");
            rt.block_on(async move {
                let _lock = lock;
                engine.run(rx).await;
            });
            let _ = stopped.send(());
        })
        .map_err(|e| e.to_string())?;
    Ok((Handle { link: Link::Local(tx) }, runtime, on_stop))
}

enum Fetch {
    NotModified,
    Parsed(ParsedFeed, (Option<String>, Option<String>)),
}

#[derive(Clone)]
enum Job {
    Entry(EntryId),
    Prefetch(EntryId),
    Save(String),
    Probe(String, Client),
}

pub(crate) enum Funnel {
    Public(String, Option<i64>),
    Private,
    Unchanged,
    Failed(bool, String),
}

pub(crate) enum Internal {
    Api(hub::Api),
    Ask(sat::Ask),
    Pulled(i64, hub::Pulled),
    Content(hub::Content),
    HubOnline(bool, String),
    HubVersion(String, u64),
    Paired(Result<sat::HubLink, String>),
    Pairing(Client, String),
    Funnel(Funnel),
    Outside(u64, u32, Result<(), String>),
    Page(Job, Result<(String, String), String>),
    MediaFetched(String, Result<(String, String, i64), String>),
    Offer(String, Result<Vec<Candidate>, String>),
    Read(Job, Result<Extracted, String>, Extractor),
    Fetched(FeedId, Result<Fetch, String>, Option<i64>),
    RefreshDone(u64),
    Discovered(Client, String, Result<Vec<Candidate>, String>),
    Added(FeedId, Result<Fetch, String>),
}

#[derive(Clone, Copy, PartialEq)]
enum Reach {
    Offline,
    Online,
    Mismatch,
}

struct Engine {
    dir: PathBuf,
    config: Config,
    store: Store,
    net: net::Net,
    out: Box<dyn Fn(Event, Audience) + Send>,
    settings: Settings,
    status: RefreshStatus,
    next: Instant,
    itx: Option<UnboundedSender<Internal>>,
    published: public::Shared,
    public_url: Option<String>,
    public_bound: bool,
    outside: Outside,
    checks: u64,
    extractors: Vec<Client>,
    prefetching: Option<EntryId>,
    media_inflight: HashSet<String>,
    media_waiting: HashSet<String>,
    media_gate: std::sync::Arc<tokio::sync::Semaphore>,
    jobs: std::collections::HashMap<u64, (Job, String, String, Client)>,
    next_job: u64,
    device: String,
    hlc: i64,
    batching: bool,
    changed: tokio::sync::watch::Sender<i64>,
    hub: Option<sat::HubLink>,
    reach: Reach,
    hub_address: String,
    hub_task: Option<tokio::task::JoinHandle<()>>,
    listener: Option<tokio::task::JoinHandle<()>>,
}

fn wait_hint(f: &net::Fetched) -> Option<i64> {
    let retry = f.retry_after.as_deref().and_then(|v| {
        v.trim().parse::<i64>().ok().map(|s| s * 1000).or_else(|| {
            chrono::DateTime::parse_from_rfc2822(v.trim()).ok().map(|d| d.timestamp_millis() - now())
        })
    });
    let max_age = f.cache_control.as_deref().and_then(|v| {
        v.split(',')
            .filter_map(|p| p.trim().strip_prefix("max-age="))
            .find_map(|n| n.trim().parse::<i64>().ok())
            .map(|s| (s * 1000).min(3_600_000))
    });
    retry.map(|ms| ms.min(24 * 3_600_000)).or(max_age).filter(|&ms| ms > 0)
}

async fn fetch_feed(net: &net::Net, url: &str, validators: (Option<String>, Option<String>)) -> (Result<Fetch, String>, Option<i64>) {
    let u = match Url::parse(url) {
        Ok(u) => u,
        Err(e) => return (Err(e.to_string()), None),
    };
    let f = match net::fetch(net, &u, net::Zone::Local, work::FEED_ACCEPT, Some(validators), Duration::from_secs(8), 10_000_000).await {
        Ok(f) => f,
        Err(e) => return (Err(e), None),
    };
    let hint = wait_hint(&f);
    (parse_fetched(f).await, hint)
}

async fn parse_fetched(f: net::Fetched) -> Result<Fetch, String> {
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
    fn new(dir: PathBuf, out: Box<dyn Fn(Event, Audience) + Send>) -> Result<Self, String> {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let config = Config::load(&dir)?;
        let store = Store::open(&dir.join("feedreader.sqlite")).map_err(|e| e.to_string())?;
        let settings = store.settings();
        let device = store.device();
        let hlc = store.max_clock();
        let changed = tokio::sync::watch::channel(store.last_seq()).0;
        let hub = std::fs::read(dir.join("secrets/hub.json")).ok().and_then(|b| serde_json::from_slice(&b).ok());
        Ok(Self {
            dir,
            config,
            store,
            net: net::Net::default(),
            out,
            settings,
            status: RefreshStatus::default(),
            next: Instant::now() + Duration::from_millis(800),
            itx: None,
            published: Default::default(),
            public_url: None,
            public_bound: false,
            outside: Outside::Unchecked,
            checks: 0,
            extractors: Vec::new(),
            prefetching: None,
            media_inflight: HashSet::new(),
            media_waiting: HashSet::new(),
            media_gate: std::sync::Arc::new(tokio::sync::Semaphore::new(4)),
            jobs: Default::default(),
            next_job: 0,
            device,
            hlc,
            changed,
            batching: false,
            hub,
            reach: Reach::Offline,
            hub_address: String::new(),
            hub_task: None,
            listener: None,
        })
    }

    fn emit(&self, event: Event) {
        (self.out)(event, Audience::All);
    }

    fn reply(&self, client: Client, event: Event) {
        (self.out)(event, Audience::Client(client));
    }

    #[profiling::function]
    fn snapshot(&self, to: Audience) {
        (self.out)(Event::Snapshot {
            feeds: self.store.feeds(),
            entries: self.store.entries(),
            settings: self.settings.clone(),
            data_dir: self.dir.display().to_string(),
            config: self.config.clone(),
            folders: self.store.folders(),
            rules: self.store.rules(),
            recommendations: self.store.recommendations(),
            public_url: self.public_url.clone(),
            outside: self.outside.clone(),
            tabs: self.store.tabs(),
        }, to);
    }

    #[profiling::function]
    fn publish(&mut self) {
        let token = self.store.token();
        let base = self.public_url.clone().unwrap_or_else(|| format!("http://127.0.0.1:{}/{token}/", self.config.public_port));
        let items = self.store.public_items();
        let (atom, html) = (public::atom(&token, &base, &items), public::page(&base, &items));
        self.published.write().unwrap_or_else(|e| e.into_inner()).set(token, atom, html);
    }

    fn within(&mut self, work: impl FnOnce(&mut Self)) {
        self.store.begin();
        work(self);
        self.saved();
    }

    fn saved(&mut self) {
        if let Err(e) = self.store.commit() {
            eprintln!("couldn't save a change: {e}");
            self.emit(Event::Message(format!("Couldn't save a change, so it was undone: {e}")));
            self.snapshot(Audience::All);
        }
    }

    async fn run(mut self, mut rx: UnboundedReceiver<(Client, Request)>) {
        let (itx, mut irx) = unbounded_channel();
        self.itx = Some(itx);
        self.store.begin();
        self.publish();
        let port = self.config.public_port;
        match std::net::TcpListener::bind(("127.0.0.1", port)) {
            Ok(listener) => {
                let shared = self.published.clone();
                tokio::spawn(async move {
                    if let Err(e) = public::serve(listener, shared).await {
                        eprintln!("public listener on port {port}: {e}");
                    }
                });
                self.public_url = Some(format!("http://127.0.0.1:{port}/{}/", self.store.token()));
                self.public_bound = true;
            }
            Err(e) => {
                eprintln!("public listener on port {port}: {e}");
                self.public_url = None;
            }
        }
        if self.hub.is_none() {
            self.funnel(self.settings.publish);
        }
        if self.hub.is_none() && self.store.get("log_seeded").is_none() {
            self.seed_log();
        }
        if self.hub.is_none() && self.store.get("folders_reseeded").is_none() {
            self.reseed_folders();
        }
        match self.hub.clone() {
            Some(link) => self.start_satellite(link),
            None => {
                let api = self.itx.clone().expect("running");
                let changed = self.changed.subscribe();
                let (port, hosts) = (self.config.sync_port, self.config.hosts.clone());
                self.listener = Some(tokio::spawn(async move {
                    if let Err(e) = hub::serve(port, hosts, api, changed).await {
                        eprintln!("sync listener on port {port}: {e}");
                    }
                }));
            }
        }
        self.snapshot(Audience::All);
        self.sync_status();
        self.saved();
        loop {
            tokio::select! {
                r = rx.recv() => match r {
                    Some((_, Request::Shutdown)) | None => break,
                    Some((from, r)) => self.within(|e| e.request(from, r)),
                },
                Some(i) = irx.recv() => self.within(|e| e.internal(i)),
                _ = tokio::time::sleep_until(self.next) => self.within(|e| e.start_refresh(false)),
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
        let bound = match &job {
            Job::Save(_) | Job::Probe(..) => net::Zone::Local,
            Job::Entry(_) | Job::Prefetch(_) => net::bound(&url, &self.store.named_hosts()),
        };
        let net = self.net.clone();
        self.spawn(async move {
            let r = work::fetch_page(&net, &url, bound).await;
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
            Ok((url, html)) => match self.extractors.first().copied() {
                Some(client) => {
                    self.next_job += 1;
                    let id = self.next_job;
                    self.jobs.insert(id, (job, url.clone(), html.clone(), client));
                    self.reply(client, Event::Extract { job: id, url, html });
                }
                None => self.read_locally(job, url, html),
            },
        }
    }

    fn read(&mut self, job: Job, r: Result<Extracted, String>, by: Extractor) {
        match job {
            Job::Entry(id) => {
                let (blocks, note) = self.keep_extracted(&id, r.map(|x| x.html));
                self.emit(Event::Body(Body { entry: id, mode: Mode::Clean, blocks, note }));
            }
            Job::Prefetch(id) => {
                let (blocks, _) = self.keep_extracted(&id, r.map(|x| x.html));
                if self.store.clean_body(&id).is_none() {
                    let why = blocks.err().unwrap_or_else(|| "the feed's own text is fuller".into());
                    self.store.extract_failed(&id, &why, now());
                }
                self.prefetching = None;
                self.prefetch_next();
            }
            Job::Save(url) => match r {
                Ok(x) => {
                    let title = if x.title.is_empty() {
                        url::Url::parse(&url).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_else(|| url.clone())
                    } else {
                        x.title
                    };
                    let e = self.store.save_link(&url, &title, &x.html, now());
                    self.emit(Event::EntriesAdded(vec![e]));
                    self.emit(Event::Message(format!("Saved \u{201C}{title}\u{201D} to Bookmarks.")));
                    if let Some(host) = url::Url::parse(&url).ok().and_then(|u| u.host_str().map(str::to_string))
                        && !self.store.offered(&host)
                    {
                        let net = self.net.clone();
                        let known = self.known();
                        let root = format!("https://{host}/");
                        self.spawn(async move {
                            let r = work::discover(&net, &root, &known).await;
                            Internal::Offer(host, r)
                        });
                    }
                }
                Err(e) => self.emit(Event::Message(format!("Couldn't save {url}: {e}"))),
            },
            Job::Probe(url, to) => self.reply(to, Event::Probed(url, r.map(|x| (x, by)))),
        }
    }

    fn prefetch_next(&mut self) {
        if self.prefetching.is_some() || self.extractors.is_empty() || self.settings.prefetch_days == 0 {
            return;
        }
        let t = now();
        let since = t - self.settings.prefetch_days as i64 * 86_400_000;
        let Some((id, url)) = self.store.next_prefetch(since, t - 7 * 86_400_000) else { return };
        self.prefetching = Some(id.clone());
        self.fetch_page(Job::Prefetch(id), url);
    }

    fn keep_extracted(&mut self, id: &EntryId, r: Result<String, String>) -> (Result<Vec<Block>, String>, Option<String>) {
        let Some((entry, content, summary)) = self.store.entry(id) else { return (Err("This entry is gone.".into()), None) };
        let feed_html = content.or(summary).unwrap_or_default();
        let feed_text = parse::text_of(&feed_html, true).len();
        let extracted = r.as_ref().map(|html| parse::text_of(html, true).len()).unwrap_or(0);
        let use_feed = feed_text > 200 && extracted * 2 < feed_text;
        let (blocks, note) = match r {
            Ok(html) if !use_feed => {
                self.store.set_clean_body(id, &html, now());
                let base = url::Url::parse(&entry.url).ok();
                let images = parse::image_urls(&html, base.as_ref(), 40);
                let links: Vec<(EntryId, String)> = images.iter().map(|u| (id.clone(), u.clone())).collect();
                self.store.link_media(&links);
                self.want_media(images, false);
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
        (blocks, note)
    }

    fn seed_log(&mut self) {
        for (n, command) in self.store.state_commands().into_iter().enumerate() {
            let change = Change { id: store::new_id(), device: self.device.clone(), at: 1 + n as i64, command };
            let seq = self.store.log_change(&change);
            self.changed.send_replace(seq);
        }
        self.store.put("log_seeded", "1");
        self.store.put("folders_reseeded", "1");
    }

    fn reseed_folders(&mut self) {
        let folders = self.store.folders();
        for f in &folders {
            self.local(Command::RenameFolder(f.id.clone(), f.name.clone()));
        }
        for feed in self.store.membership_feeds() {
            let pairs = folders.iter().filter(|f| f.feeds.contains(&feed)).map(|f| (f.id.clone(), f.name.clone())).collect();
            self.local(Command::Membership(feed, pairs));
        }
        self.store.put("folders_reseeded", "1");
    }

    fn tick(&mut self) -> i64 {
        self.hlc = (now() * 1000).max(self.hlc + 1);
        self.hlc
    }

    fn local(&mut self, command: Command) {
        let change = Change { id: store::new_id(), device: self.device.clone(), at: self.tick(), command };
        self.commit(change);
    }

    fn commit(&mut self, change: Change) -> bool {
        if self.store.has_change(&change.id) {
            return false;
        }
        self.hlc = self.hlc.max(change.at);
        self.apply(&change);
        let seq = self.store.log_change(&change);
        self.changed.send_replace(seq);
        true
    }

    fn feeds_changed(&self) {
        self.emit(Event::Feeds(self.store.feeds()));
    }

    fn folders_changed(&self) {
        self.emit(Event::Folders(self.store.folders()));
    }

    #[profiling::function]
    fn apply(&mut self, change: &Change) {
        let (at, dev) = (change.at, change.device.as_str());
        let t = at / 1000;
        let fresh = |store: &Store, key: String| store.newer(&key, at, dev);
        match &change.command {
            Command::Read(ids, v) => {
                let ids: Vec<EntryId> = ids.iter().filter(|id| fresh(&self.store, format!("read:{id}"))).cloned().collect();
                self.store.set_read(&ids, *v, t);
                if change.device != self.device && !ids.is_empty() {
                    self.emit(Event::States(ids.into_iter().map(|id| (id, Some(*v), None)).collect()));
                }
            }
            Command::Bookmark(ids, v) => {
                let ids: Vec<EntryId> = ids.iter().filter(|id| fresh(&self.store, format!("bookmark:{id}"))).cloned().collect();
                self.store.set_bookmarked(&ids, *v, t);
                if change.device != self.device && !ids.is_empty() {
                    self.emit(Event::States(ids.into_iter().map(|id| (id, None, Some(*v))).collect()));
                }
            }
            Command::Subscribe(url, title, folders) => {
                let id = store::feed_id(url);
                let subscribed = self.store.claim(&format!("sub:{id}"), at, dev, "1");
                let feed = match self.store.ensure_feed(url, title) {
                    Ok(f) => f,
                    Err(e) => {
                        self.emit(Event::FeedAdded(Err(e.to_string())));
                        return;
                    }
                };
                if !folders.is_empty() {
                    self.membership(&id, &store::legacy_folders(folders), at, dev);
                }
                self.materialize(&id);
                if self.batching {
                    return;
                }
                self.feeds_changed();
                if !subscribed {
                    return;
                }
                self.emit(Event::EntriesAdded(self.store.removed_entries(&feed.id)));
                if self.fetches() {
                    let net = self.net.clone();
                    let v = self.store.validators(&feed.id);
                    self.spawn(async move {
                        let (r, _) = fetch_feed(&net, &feed.url, v).await;
                        Internal::Added(feed.id, r)
                    });
                }
            }
            Command::Unsubscribe(id) => {
                if self.store.claim(&format!("sub:{id}"), at, dev, "0") {
                    self.store.remove_feed(id, t);
                    self.feeds_changed();
                }
            }
            Command::Resubscribe(id) => {
                if self.store.claim(&format!("sub:{id}"), at, dev, "1") {
                    self.store.restore_feed(id);
                    self.feeds_changed();
                    self.emit(Event::EntriesAdded(self.store.removed_entries(id)));
                }
            }
            Command::Rename(id, label) => {
                if self.store.claim(&format!("label:{id}"), at, dev, &serde_json::to_string(label).unwrap_or_default()) {
                    self.store.rename_feed(id, label.as_deref().filter(|l| !l.trim().is_empty()));
                    self.feeds_changed();
                }
            }
            Command::Folders(feed, names) => self.membership(feed, &store::legacy_folders(names), at, dev),
            Command::Membership(feed, pairs) => self.membership(feed, pairs, at, dev),
            Command::RenameFolder(id, name) => {
                if self.store.claim(&format!("folder:{id}"), at, dev, &format!("+{name}")) {
                    self.folders_rebuilt();
                }
            }
            Command::DeleteFolder(id) => {
                if self.store.claim(&format!("folder:{id}"), at, dev, "-") {
                    self.folders_rebuilt();
                }
            }
            Command::RestoreFolder(f) => {
                if self.store.claim(&format!("folder:{}", f.id), at, dev, &format!("+{}", f.name)) {
                    self.folders_rebuilt();
                }
            }
            Command::Pin(id, on) => {
                if self.store.claim(&format!("pin:{id}"), at, dev, if *on { "1" } else { "0" }) {
                    self.store.set_feed_flag(id, "pinned", *on);
                    self.feeds_changed();
                }
            }
            Command::Hide(id, on) => {
                if self.store.claim(&format!("hide:{id}"), at, dev, if *on { "1" } else { "0" }) {
                    self.store.set_feed_flag(id, "hidden", *on);
                    self.feeds_changed();
                }
            }
            Command::FeedMode(id, mode) => {
                if self.store.claim(&format!("mode:{id}"), at, dev, mode.map(Mode::name).unwrap_or("")) {
                    self.store.set_feed_mode(id, *mode);
                    self.feeds_changed();
                }
            }
            Command::AddRule(rule) => {
                if fresh(&self.store, format!("rule:{}", rule.id)) {
                    self.store.add_rule(rule);
                    self.emit(Event::Rules(self.store.rules()));
                }
            }
            Command::RemoveRule(id) => {
                if fresh(&self.store, format!("rule:{id}")) {
                    self.store.remove_rule(id);
                    self.emit(Event::Rules(self.store.rules()));
                }
            }
            Command::Recommend(id, note) => {
                if self.store.claim(&format!("rec:{id}"), at, dev, &format!("+{note}")) {
                    if self.store.recommend(id, note, t) {
                        self.publish();
                    }
                    self.emit(Event::Recommendations(self.store.recommendations()));
                }
            }
            Command::Unrecommend(id) => {
                if self.store.claim(&format!("rec:{id}"), at, dev, "-") {
                    self.store.unrecommend(id, t);
                    self.publish();
                    self.emit(Event::Recommendations(self.store.recommendations()));
                }
            }
            Command::SaveLink(url) => {
                let id = store::entry_id(SAVED, url);
                if fresh(&self.store, format!("bookmark:{id}")) {
                    self.store.set_bookmarked(std::slice::from_ref(&id), true, t);
                }
                if fresh(&self.store, format!("read:{id}")) {
                    self.store.set_read(std::slice::from_ref(&id), true, t);
                }
                if self.fetches() || change.device == self.device {
                    self.fetch_page(Job::Save(url.clone()), url.clone());
                }
            }
            Command::Tabs(tabs) => {
                if fresh(&self.store, "tabs".into()) {
                    self.store.set_tabs(tabs);
                    if change.device != self.device {
                        self.emit(Event::Tabs(tabs.clone()));
                    }
                }
            }
            Command::Settings(st) => {
                if !fresh(&self.store, "settings".into()) {
                    return;
                }
                let st = st.clone();
                if st.publish != self.settings.publish && self.hub.is_none() {
                    self.funnel(st.publish);
                }
                let interval_changed = st.refresh_minutes != self.settings.refresh_minutes;
                let retention_changed = st.max_entries != self.settings.max_entries || st.max_age_days != self.settings.max_age_days;
                self.store.save_settings(&st);
                self.settings = st;
                if interval_changed && !self.status.running {
                    let wait = Duration::from_secs(self.settings.refresh_minutes.max(1) as u64 * 60);
                    self.next = Instant::now() + wait;
                    self.status.next_at = Some(now() + wait.as_millis() as i64);
                    self.emit(Event::Refresh(self.status.clone()));
                }
                if retention_changed {
                    let removed = self.store.prune(&self.settings, now());
                    if !removed.is_empty() {
                        self.emit(Event::EntriesRemoved(removed));
                    }
                }
                self.emit(Event::Settings(self.settings.clone()));
            }
        }
    }

    fn materialize(&mut self, feed: &str) {
        match self.store.register(&format!("sub:{feed}")) {
            Some((at, v)) if v == "0" => self.store.remove_feed(feed, at / 1000),
            _ => self.store.restore_feed(feed),
        }
        if let Some((_, v)) = self.store.register(&format!("label:{feed}")) {
            let label: Option<String> = serde_json::from_str(&v).unwrap_or(None);
            self.store.rename_feed(feed, label.as_deref().filter(|l| !l.trim().is_empty()));
        }
        for (key, column) in [("pin", "pinned"), ("hide", "hidden")] {
            if let Some((_, v)) = self.store.register(&format!("{key}:{feed}")) {
                self.store.set_feed_flag(feed, column, v == "1");
            }
        }
        if let Some((_, v)) = self.store.register(&format!("mode:{feed}")) {
            self.store.set_feed_mode(feed, Mode::parse(&v));
        }
    }

    fn pending_recommendations(&mut self, arrived: &[Entry]) {
        let mut changed = false;
        for e in arrived {
            if let Some((at, v)) = self.store.register(&format!("rec:{}", e.id))
                && let Some(note) = v.strip_prefix('+')
                && !self.store.recommendations().iter().any(|r| r.entry == e.id)
            {
                changed |= self.store.recommend(&e.id, note, at / 1000);
            }
        }
        if changed {
            self.publish();
            self.emit(Event::Recommendations(self.store.recommendations()));
        }
    }

    fn membership(&mut self, feed: &str, pairs: &[(String, String)], at: i64, dev: &str) {
        for (id, name) in pairs {
            self.store.claim(&format!("folder:{id}"), 0, "", &format!("+{name}"));
        }
        let ids: Vec<&String> = pairs.iter().map(|(id, _)| id).collect();
        self.store.claim(&format!("folders:{feed}"), at, dev, &serde_json::to_string(&ids).unwrap_or_default());
        self.folders_rebuilt();
    }

    fn folders_rebuilt(&mut self) {
        self.store.rebuild_folders();
        if !self.batching {
            self.folders_changed();
        }
    }

    fn resolve_folders(&self, names: &[String]) -> Vec<(String, String)> {
        let existing = self.store.folders();
        let mut out: Vec<(String, String)> = Vec::new();
        for n in names.iter().map(|n| n.trim()).filter(|n| !n.is_empty()) {
            if out.iter().any(|(_, x)| x.eq_ignore_ascii_case(n)) {
                continue;
            }
            let id = match existing.iter().find(|f| f.name.eq_ignore_ascii_case(n)) {
                Some(f) => f.id.clone(),
                None => self.store.new_folder_id(n),
            };
            out.push((id, n.to_string()));
        }
        out
    }

    fn funnel(&mut self, on: bool) {
        let (port, funnel) = (self.config.public_port, self.config.funnel_port);
        if !self.public_bound {
            if on {
                self.emit(Event::Message(format!("Couldn't publish: another program holds port {port}, so Tailscale Funnel would serve it instead of this engine.")));
            }
            return;
        }
        let ours = self.store.get("funnel_dir").as_deref() == Some(&*self.dir.to_string_lossy());
        let token = self.store.token();
        self.spawn(async move {
            let outcome = if on {
                match tailscale::publish(funnel, port).await {
                    Ok(node) => Funnel::Public(format!("https://{}:{funnel}/{token}/", node.name), node.key_expiry),
                    Err(e) => Funnel::Failed(true, e),
                }
            } else if ours && tailscale::published(funnel, port).await {
                match tailscale::unpublish(funnel).await {
                    Ok(()) => Funnel::Private,
                    Err(e) => Funnel::Failed(false, e),
                }
            } else {
                Funnel::Unchanged
            };
            Internal::Funnel(outcome)
        });
    }

    fn check_outside(&mut self, after: Duration, tries: u32) {
        self.checks += 1;
        let Some(url) = self.public_url.clone().filter(|u| u.starts_with("https://")) else { return };
        let check = self.checks;
        let net = self.net.clone();
        self.spawn(async move {
            tokio::time::sleep(after).await;
            Internal::Outside(check, tries, tailscale::reachable(&net, &url).await)
        });
    }

    fn set_outside(&mut self, outside: Outside) {
        if self.outside != outside {
            self.outside = outside.clone();
            self.emit(Event::Outside(outside));
        }
    }

    fn fetches(&self) -> bool {
        self.hub.is_none() || self.reach != Reach::Online
    }

    fn start_satellite(&mut self, link: sat::HubLink) {
        if let Some(t) = self.hub_task.take() {
            t.abort();
        }
        let tx = self.itx.clone().expect("running");
        let changed = self.changed.subscribe();
        self.hub_task = Some(tokio::spawn(sat::run(link, tx, changed)));
    }

    fn sync_status(&self) {
        let status = match &self.hub {
            Some(link) => SyncStatus::Satellite {
                online: self.reach == Reach::Online,
                address: if self.hub_address.is_empty() { link.addresses.first().cloned().unwrap_or_default() } else { self.hub_address.clone() },
            },
            None => SyncStatus::Hub { devices: self.store.devices().into_iter().map(|(_, name, seen)| (name, seen)).collect() },
        };
        self.emit(Event::Sync(status));
    }

    fn pairing_link(&self, to: Client, code: String) {
        let port = self.config.sync_port;
        self.spawn(async move {
            let mut hubs = Vec::new();
            if let Some(name) = tailscale::name().await {
                hubs.push(format!("http://{name}:{port}"));
            }
            if let Some(ip) = lan_ip() {
                hubs.push(format!("http://{ip}:{port}"));
            }
            hubs.push(format!("http://127.0.0.1:{port}"));
            Internal::Pairing(to, format!("feedreader://pair?code={code}&hub={}", hubs.join(",")))
        });
    }

    fn api(&mut self, call: hub::Api) {
        let t = now();
        match call {
            hub::Api::Pair { code, device, name, reply } => {
                let token = self.store.redeem_code(&code, &device, &name, t);
                if token.is_some() {
                    self.emit(Event::Message(format!("Paired {name}.")));
                    self.sync_status();
                }
                let _ = reply.send(token);
            }
            hub::Api::Auth { token, reply } => {
                let _ = reply.send(self.store.device_for(&token, t));
            }
            hub::Api::Sync { device, since, changes, reply } => {
                for c in changes {
                    self.commit(c);
                }
                let list = self.store.changes_since(since, &device, 500);
                let more = list.len() == 500;
                let seq = if more { list.last().map(|(s, _)| *s).unwrap_or(since) } else { self.store.last_seq() };
                let _ = reply.send(hub::Pulled { seq, changes: list, more });
            }
            hub::Api::Content { since, reply } => {
                let (feeds, entries, next) = self.store.content_since(since, 300);
                let more = entries.len() == 300;
                let _ = reply.send(hub::Content { feeds, entries, next, more });
            }
            hub::Api::Media { url, reply } => {
                let path = self
                    .store
                    .media(&url)
                    .filter(|m| m.error.is_none() && !m.file.is_empty())
                    .map(|m| self.dir.join("media").join(m.file))
                    .filter(|p| p.is_file());
                if path.is_none() {
                    self.want_media(vec![url], false);
                }
                let _ = reply.send(path);
            }
        }
    }

    fn known(&self) -> HashSet<String> {
        let mut known = HashSet::new();
        for f in self.store.feeds().into_iter().filter(|f| f.id != SAVED) {
            if !f.title.is_empty() {
                known.insert(work::fingerprint(&f.title, &f.url));
                if let Some(site) = &f.site_url {
                    known.insert(work::fingerprint(&f.title, site));
                }
            }
            known.insert(f.id);
        }
        known
    }

    fn start_refresh(&mut self, all: bool) {
        if self.status.running {
            return;
        }
        let due = self.store.due(now());
        let feeds: Vec<Feed> = self.store.feeds().into_iter().filter(|f| f.id != SAVED && (all || due.contains(&f.id))).collect();
        if feeds.is_empty() {
            let wait = Duration::from_secs(self.settings.refresh_minutes.max(1) as u64 * 60);
            self.next = Instant::now() + wait;
            self.status.next_at = Some(now() + wait.as_millis() as i64);
            self.emit(Event::Refresh(self.status.clone()));
            return;
        }
        self.status = RefreshStatus {
            run: self.status.run + 1,
            running: true,
            total: feeds.len(),
            started_at: now(),
            ..Default::default()
        };
        self.next = Instant::now() + Duration::from_secs(24 * 3600);
        self.emit(Event::Refresh(self.status.clone()));
        let list: Vec<_> = feeds
            .into_iter()
            .map(|f| {
                let v = self.store.validators(&f.id);
                (f.id, f.url, v)
            })
            .collect();
        let net = self.net.clone();
        let tx = self.itx.clone().expect("running");
        let run = self.status.run;
        tokio::spawn(async move {
            let hosts: std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<tokio::sync::Semaphore>>> = Default::default();
            futures::stream::iter(list)
                .map(|(id, url, v)| {
                    let c = net.clone();
                    let host = Url::parse(&url).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_default();
                    let gate = hosts.lock().unwrap_or_else(|e| e.into_inner()).entry(host).or_insert_with(|| std::sync::Arc::new(tokio::sync::Semaphore::new(2))).clone();
                    async move {
                        let _permit = gate.acquire_owned().await;
                        let (r, hint) = fetch_feed(&c, &url, v).await;
                        (id, r, hint)
                    }
                })
                .buffer_unordered(8)
                .for_each(|(id, r, hint)| {
                    let _ = tx.send(Internal::Fetched(id, r, hint));
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
                self.emit(Event::EntriesUpdated(ins.updated));
            }
            if !ins.refilled.is_empty() {
                self.emit(Event::EntriesAdded(ins.refilled));
            }
            self.want_media(ins.images, false);
            self.pending_recommendations(&ins.added);
            ins.added
        })
    }

    fn want_media(&mut self, urls: Vec<String>, reply: bool) {
        let t = now();
        let named = self.store.named_hosts();
        for url in urls {
            if let Some(row) = self.store.media(&url) {
                let path = self.dir.join("media").join(&row.file);
                if row.error.is_none() && !row.file.is_empty() && path.is_file() {
                    self.store.touch_media(&url, t);
                    if reply {
                        self.emit(Event::Media(url, Ok(path)));
                    }
                    continue;
                }
                if let Some(e) = row.error.filter(|_| t - row.fetched_at < 86_400_000) {
                    if reply {
                        self.emit(Event::Media(url, Err(e)));
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
            let net = self.net.clone();
            let bound = net::bound(&url, &named);
            let dir = self.dir.join("media");
            let gate = self.media_gate.clone();
            let hub = self.hub.clone().filter(|_| self.reach == Reach::Online);
            self.spawn(async move {
                let _permit = gate.acquire_owned().await;
                if let Some(link) = hub
                    && let Some(bytes) = sat::fetch_media(&sat::client(), &link, &url).await
                {
                    return Internal::MediaFetched(url.clone(), work::store_media(&dir, &url, &bytes, "").await);
                }
                let r = work::fetch_media(&net, &url, bound, &dir).await;
                Internal::MediaFetched(url, r)
            });
        }
    }

    fn apply_fetch_inner(&mut self, id: &str, result: Result<Fetch, String>) -> Result<store::Inserted, String> {
        let t = now();
        match result {
            Ok(Fetch::NotModified) => {
                self.store.set_fetch_result(id, None, None, None, None, t);
                Ok(store::Inserted { added: Vec::new(), updated: Vec::new(), images: Vec::new(), refilled: Vec::new() })
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
            Internal::Fetched(id, result, hint) => {
                self.status.completed += 1;
                let ok = result.is_ok();
                let r = self.apply_fetch(&id, result);
                let fresh = r.as_ref().map(|a| !a.is_empty()).unwrap_or(false);
                self.store.reschedule(&id, ok, fresh, hint, self.settings.refresh_minutes.max(1) as i64 * 60_000, now());
                match r {
                    Ok(added) => {
                        self.status.added += added.len();
                        if !added.is_empty() {
                            self.emit(Event::EntriesAdded(added));
                        }
                    }
                    Err(_) => self.status.failed += 1,
                }
                self.emit(Event::Refresh(self.status.clone()));
            }
            Internal::RefreshDone(run) if run == self.status.run => {
                self.prefetch_next();
                let removed = self.store.prune(&self.settings, now());
                if !removed.is_empty() {
                    self.emit(Event::EntriesRemoved(removed));
                }
                self.store.purge_removed(now() - 24 * 3600 * 1000);
                for file in self.store.prune_media(now(), self.config.media_budget()) {
                    let _ = std::fs::remove_file(self.dir.join("media").join(file));
                }
                let wait = Duration::from_secs(self.settings.refresh_minutes.max(1) as u64 * 60);
                self.next = Instant::now() + wait;
                self.status.running = false;
                self.status.finished_at = Some(now());
                self.status.next_at = Some(now() + wait.as_millis() as i64);
                self.emit(Event::Feeds(self.store.feeds()));
                self.emit(Event::Refresh(self.status.clone()));
            }
            Internal::RefreshDone(_) => {}
            Internal::Discovered(to, q, r) => self.reply(to, Event::Discovered(q, r)),
            Internal::Page(job, r) => self.page(job, r),
            Internal::Api(call) => self.api(call),
            Internal::Pairing(to, link) => self.reply(to, Event::Pairing(link)),
            Internal::Funnel(outcome) => {
                let local = format!("http://127.0.0.1:{}/{}/", self.config.public_port, self.store.token());
                self.public_url = Some(local);
                let message = match outcome {
                    Funnel::Public(url, expiry) => {
                        self.public_url = Some(url.clone());
                        self.store.put("funnel_dir", &self.dir.to_string_lossy());
                        let warning = expiry
                            .and_then(chrono::DateTime::from_timestamp_millis)
                            .map(|d| {
                                format!(
                                    " This Mac's Tailscale key expires on {}, and the link stops working then unless you turn off key expiry for this machine in the Tailscale admin console.",
                                    d.with_timezone(&chrono::Local).format("%-d %B %Y")
                                )
                            })
                            .unwrap_or_default();
                        Some(format!("Your I recommend feed is public at {url}.{warning}"))
                    }
                    Funnel::Private => {
                        self.store.put("funnel_dir", "");
                        Some("Your I recommend feed is no longer public.".into())
                    }
                    Funnel::Unchanged => None,
                    Funnel::Failed(true, e) => Some(format!("Couldn't publish through Tailscale Funnel: {e}")),
                    Funnel::Failed(false, e) => Some(format!("Couldn't stop Tailscale Funnel: {e}")),
                };
                if let Some(m) = message {
                    self.emit(Event::Message(m));
                }
                self.publish();
                self.emit(Event::PublicUrl(self.public_url.clone()));
                if self.public_url.as_deref().is_some_and(|u| u.starts_with("https://")) {
                    self.set_outside(Outside::Checking);
                    self.check_outside(Duration::ZERO, 60);
                } else {
                    self.checks += 1;
                    self.set_outside(Outside::Unchecked);
                }
            }
            Internal::Outside(check, tries, result) => {
                if check == self.checks {
                    match result {
                        Ok(()) => {
                            self.set_outside(Outside::Reachable(now()));
                            self.check_outside(Duration::from_secs(3600), 2);
                        }
                        Err(_) if tries > 0 => self.check_outside(Duration::from_secs(30), tries - 1),
                        Err(e) => {
                            self.set_outside(Outside::Unreachable(now(), e));
                            self.check_outside(Duration::from_secs(3600), 2);
                        }
                    }
                }
            }
            Internal::Ask(sat::Ask::Outbox { reply }) => {
                let pushed: i64 = self.store.get("sync_pushed").and_then(|v| v.parse().ok()).unwrap_or(0);
                let pulled: i64 = self.store.get("sync_pulled").and_then(|v| v.parse().ok()).unwrap_or(0);
                let cursor: i64 = self.store.get("content_cursor").and_then(|v| v.parse().ok()).unwrap_or(0);
                let list = self.store.outbox(&self.device, pushed, 500);
                let top = list.last().map(|(s, _)| *s).unwrap_or(pushed);
                let _ = reply.send((list.into_iter().map(|(_, c)| c).collect(), top, pulled, cursor));
            }
            Internal::Pulled(top, p) => {
                self.store.put("sync_pushed", &top.to_string());
                for (_, c) in p.changes {
                    self.commit(c);
                }
                self.store.put("sync_pulled", &p.seq.to_string());
            }
            Internal::Content(c) => {
                let added = self.store.take_content(&c.feeds, &c.entries);
                self.store.put("content_cursor", &c.next.to_string());
                if !c.feeds.is_empty() {
                    self.feeds_changed();
                }
                self.pending_recommendations(&added);
                if !added.is_empty() {
                    self.emit(Event::EntriesAdded(added));
                }
            }
            Internal::HubVersion(address, protocol) => {
                if self.reach != Reach::Mismatch {
                    self.reach = Reach::Mismatch;
                    let advice = if protocol < PROTOCOL as u64 { "Update Feedreader on the hub" } else { "Update Feedreader on this device" };
                    self.emit(Event::Message(format!("The hub at {address} runs a different version of Feedreader, so syncing is paused. {advice}.")));
                }
            }
            Internal::HubOnline(online, address) => {
                let reach = match (online, self.reach) {
                    (true, _) => Reach::Online,
                    (false, Reach::Mismatch) => Reach::Mismatch,
                    (false, _) => Reach::Offline,
                };
                if reach != self.reach || (online && self.hub_address != address) {
                    self.reach = reach;
                    self.hub_address = address;
                    self.sync_status();
                }
            }
            Internal::Paired(r) => match r {
                Ok(link) => {
                    let secrets = self.dir.join("secrets");
                    let _ = std::fs::create_dir_all(&secrets);
                    let _ = std::fs::set_permissions(&secrets, std::os::unix::fs::PermissionsExt::from_mode(0o700));
                    let path = secrets.join("hub.json");
                    if let Ok(bytes) = serde_json::to_vec(&link) {
                        let _ = std::fs::write(&path, bytes);
                        let _ = std::fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o600));
                    }
                    self.hub = Some(link.clone());
                    if let Some(l) = self.listener.take() {
                        l.abort();
                    }
                    self.store.put("sync_pushed", "0");
                    self.store.put("sync_pulled", "0");
                    self.store.put("content_cursor", "0");
                    self.start_satellite(link);
                    self.emit(Event::Message("Paired with the hub. Syncing\u{2026}".into()));
                    self.sync_status();
                }
                Err(e) => self.emit(Event::Message(format!("Couldn't pair: {e}"))),
            },
            Internal::Offer(host, r) => {
                if let Ok(c) = r
                    && !c.is_empty()
                    && c.iter().all(|c| !c.subscribed)
                {
                    self.emit(Event::FollowOffer(host, c));
                }
            }
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
                    self.emit(Event::Media(url, reply));
                }
            }
            Internal::Read(job, r, by) => self.read(job, r, by),
            Internal::Added(id, r) => {
                let result = self.apply_fetch(&id, r);
                self.emit(Event::Feeds(self.store.feeds()));
                match result {
                    Ok(added) => {
                        let n = added.len();
                        if !added.is_empty() {
                            self.emit(Event::EntriesAdded(added));
                        }
                        if let Some(f) = self.store.feed(&id) {
                            self.emit(Event::FeedAdded(Ok((f, n))));
                        }
                    }
                    Err(e) => self.emit(Event::FeedAdded(Err(e))),
                }
            }
        }
    }

    #[profiling::function]
    fn request(&mut self, from: Client, r: Request) {
        match r {
            Request::SetRead(ids, v) => self.local(Command::Read(ids, v)),
            Request::SetBookmarked(ids, v) => self.local(Command::Bookmark(ids, v)),
            Request::Refresh => self.start_refresh(true),
            Request::Discover(q) => {
                let net = self.net.clone();
                let known = self.known();
                self.spawn(async move {
                    let r = work::discover(&net, &q, &known).await;
                    Internal::Discovered(from, q, r)
                });
            }
            Request::AddFeed(url, title, folders) => {
                if !title.is_empty() && !self.known().contains(&store::feed_id(&url)) && self.known().contains(&work::fingerprint(&title, &url)) {
                    self.emit(Event::FeedAdded(Err(format!("you already follow {title} at another address"))));
                    return;
                }
                let id = store::feed_id(&url);
                self.local(Command::Subscribe(url, title, Vec::new()));
                if !folders.is_empty() {
                    let mut names: Vec<String> = self.store.folders().into_iter().filter(|f| f.feeds.contains(&id)).map(|f| f.name).collect();
                    names.extend(folders);
                    let pairs = self.resolve_folders(&names);
                    self.local(Command::Membership(id, pairs));
                }
            }
            Request::RemoveFeed(id) => self.local(Command::Unsubscribe(id)),
            Request::RestoreFeed(id) => self.local(Command::Resubscribe(id)),
            Request::RenameFeed(id, label) => self.local(Command::Rename(id, label)),
            Request::ImportOpml(path) => {
                let text = match std::fs::read_to_string(&path) {
                    Ok(t) => t,
                    Err(e) => {
                        self.emit(Event::Message(format!("Couldn't read {}: {e}", path.display())));
                        return;
                    }
                };
                let mut known = self.known();
                let mut added = 0;
                let mut skipped = 0;
                self.batching = true;
                for (url, title, folder) in work::read_opml(&text) {
                    match net::parse_url(&url) {
                        Ok(u) => {
                            let id = store::feed_id(u.as_str());
                            if !known.contains(&id) {
                                self.local(Command::Subscribe(u.to_string(), title, Vec::new()));
                                added += 1;
                                known.insert(id.clone());
                            }
                            if let Some(f) = folder {
                                let mut names: Vec<String> = self.store.folders().into_iter().filter(|x| x.feeds.contains(&id)).map(|x| x.name).collect();
                                if !names.iter().any(|n| n.eq_ignore_ascii_case(&f)) {
                                    names.push(f);
                                    let pairs = self.resolve_folders(&names);
                                    self.local(Command::Membership(id, pairs));
                                }
                            }
                        }
                        Err(_) => skipped += 1,
                    }
                }
                self.batching = false;
                self.emit(Event::Feeds(self.store.feeds()));
                self.emit(Event::Folders(self.store.folders()));
                let skipped = if skipped > 0 { format!(", skipped {skipped} unsafe links") } else { String::new() };
                self.emit(Event::Message(format!("Imported {added} new feeds{skipped}")));
                if added > 0 {
                    self.start_refresh(false);
                }
            }
            Request::ExportOpml(path) => {
                let feeds: Vec<Feed> = self.store.feeds().into_iter().filter(|f| f.id != SAVED).collect();
                let text = work::write_opml(&feeds, &self.store.folders());
                let msg = match std::fs::write(&path, text) {
                    Ok(()) => format!("Exported {} feeds to {}", feeds.len(), path.display()),
                    Err(e) => format!("Couldn't write {}: {e}", path.display()),
                };
                self.emit(Event::Message(msg));
            }
            Request::ImportLegacy(path) => {
                let msg = match self.store.import_legacy(&path) {
                    Ok((f, e)) => {
                        self.seed_log();
                        format!("Imported {f} feeds and {e} entries from {}", path.display())
                    }
                    Err(e) => format!("Import failed: {e}"),
                };
                self.snapshot(Audience::All);
                self.emit(Event::Message(msg));
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
                        self.emit(Event::Body(Body { entry: id, mode, blocks, note: None }));
                    }
                    Mode::Clean => {
                        if let Some(html) = self.store.clean_body(&id) {
                            self.emit(Event::Body(Body {
                                entry: id,
                                mode,
                                blocks: Ok(parse::blocks(&html, Some(&entry.url))),
                                note: None,
                            }));
                            return;
                        }
                        if entry.url.is_empty() {
                            self.emit(Event::Body(Body {
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
                let pairs = self.resolve_folders(&names);
                self.local(Command::Membership(feed, pairs));
            }
            Request::RenameFolder(id, name) => self.local(Command::RenameFolder(id, name)),
            Request::DeleteFolder(id) => self.local(Command::DeleteFolder(id)),
            Request::RestoreFolder(f) => self.local(Command::RestoreFolder(f)),
            Request::SetPinned(id, on) => self.local(Command::Pin(id, on)),
            Request::SetHidden(id, on) => self.local(Command::Hide(id, on)),
            Request::SetFeedMode(id, mode) => self.local(Command::FeedMode(id, mode)),
            Request::AddRule(rule) => self.local(Command::AddRule(rule)),
            Request::RemoveRule(id) => self.local(Command::RemoveRule(id)),
            Request::Recommend(id, note) => self.local(Command::Recommend(id, note)),
            Request::Unrecommend(id) => self.local(Command::Unrecommend(id)),
            Request::Search(q) => {
                let ids = self.store.search(&q);
                self.reply(from, Event::SearchResults(q, ids));
            }
            Request::SaveLink(input) => match net::parse_url(&input) {
                Ok(u) => self.local(Command::SaveLink(u.to_string())),
                Err(e) => self.emit(Event::Message(format!("Couldn't save {input}: {e}"))),
            },
            Request::Probe(input) => match net::parse_url(&input) {
                Ok(u) => self.fetch_page(Job::Probe(u.to_string(), from), u.to_string()),
                Err(e) => self.reply(from, Event::Probed(input, Err(e))),
            },
            Request::UseWebExtractor => {
                if !self.extractors.contains(&from) {
                    self.extractors.push(from);
                }
                self.prefetch_next();
            }
            Request::PairCode => {
                if self.hub.is_some() {
                    self.reply(from, Event::Message("This device syncs with a hub; pair new devices on the hub.".into()));
                    return;
                }
                let code = self.store.issue_code(now());
                self.pairing_link(from, code);
            }
            Request::Pair(link, name) => {
                let device = self.device.clone();
                self.spawn(async move {
                    let client = sat::client();
                    Internal::Paired(sat::pair(&client, &link, &device, &name).await)
                });
            }
            Request::Unpair => {
                if let Some(t) = self.hub_task.take() {
                    t.abort();
                }
                let _ = std::fs::remove_file(self.dir.join("secrets/hub.json"));
                self.hub = None;
                self.reach = Reach::Offline;
                self.emit(Event::Message("This device no longer syncs with a hub. Restart the engine to make it a hub.".into()));
                self.sync_status();
            }
            Request::ForgetDevice(name) => {
                if let Some((d, _, _)) = self.store.devices().into_iter().find(|(_, n, _)| *n == name) {
                    self.store.forget_device(&d);
                }
                self.sync_status();
            }
            Request::Resync => {
                self.snapshot(Audience::Client(from));
                self.sync_status();
            }
            Request::Detach => {
                self.extractors.retain(|&c| c != from);
                let orphaned: Vec<u64> = self.jobs.iter().filter(|(_, j)| j.3 == from).map(|(&id, _)| id).collect();
                for id in orphaned {
                    if let Some((job, url, html, _)) = self.jobs.remove(&id) {
                        self.read_locally(job, url, html);
                    }
                }
            }
            Request::Shutdown => {}
            Request::SetTabs(tabs) => self.local(Command::Tabs(tabs)),
            Request::Media(urls) => self.want_media(urls, true),
            Request::Extracted(id, r) => {
                let Some((job, url, html, _)) = self.jobs.remove(&id) else { return };
                match r {
                    Ok(x) if !x.html.trim().is_empty() => self.read(job, Ok(x), Extractor::Defuddle),
                    _ => self.read_locally(job, url, html),
                }
            }
            Request::SetSettings(st) => self.local(Command::Settings(st)),
        }
    }
}
