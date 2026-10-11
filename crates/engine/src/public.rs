use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Instant;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{ConnectInfo, Path, Request, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode, header};
use axum::middleware::{Next, from_fn_with_state};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use chrono::{DateTime, Utc};
use tokio::net::TcpListener;

use crate::store::PublicItem;

#[derive(Default)]
pub struct Published {
    pub token: String,
    pub atom: Bytes,
    pub html: Bytes,
    pub tag: String,
}

impl Published {
    pub fn set(&mut self, token: String, atom: String, html: String) {
        let digest = <sha2::Sha256 as sha2::Digest>::digest(atom.as_bytes());
        self.tag = digest[..8].iter().map(|b| format!("{b:02x}")).collect();
        self.atom = atom.into();
        self.html = html.into();
        self.token = token;
    }
}

pub type Shared = Arc<RwLock<Published>>;

fn esc(s: &str) -> String {
    html_escape::encode_text(s).to_string()
}

fn attr(s: &str) -> String {
    html_escape::encode_double_quoted_attribute(s).to_string()
}

fn rfc3339(ms: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(ms)
        .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
        .unwrap_or_default()
}

fn urn(token: &str, entry: &str) -> String {
    let digest = <sha2::Sha256 as sha2::Digest>::digest(entry.as_bytes());
    let hex: String = digest[..10].iter().map(|b| format!("{b:02x}")).collect();
    format!("urn:feedreader:{token}:{hex}")
}

pub fn atom(token: &str, base: &str, items: &[PublicItem]) -> String {
    let updated = items.iter().map(|i| i.removed_at.unwrap_or(i.at)).max().unwrap_or(0);
    let mut s = String::from(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<feed xmlns=\"http://www.w3.org/2005/Atom\" xmlns:at=\"http://purl.org/atompub/tombstones/1.0\" xmlns:feedreader=\"https://github.com/Kosyakssss/feedreader/ns/1\">\n",
    );
    s.push_str("  <title>I recommend</title>\n");
    s.push_str(&format!("  <id>urn:feedreader:{token}</id>\n"));
    s.push_str(&format!("  <updated>{}</updated>\n", rfc3339(updated)));
    s.push_str(&format!("  <link rel=\"self\" href=\"{}\"/>\n", attr(&format!("{base}feed.xml"))));
    s.push_str(&format!("  <link rel=\"alternate\" href=\"{}\"/>\n", attr(base)));
    for i in items {
        let id = urn(token, &i.entry);
        if let Some(removed) = i.removed_at {
            s.push_str(&format!("  <at:deleted-entry ref=\"{id}\" when=\"{}\"/>\n", rfc3339(removed)));
            continue;
        }
        let mut html = String::new();
        if !i.note.trim().is_empty() {
            html.push_str(&format!("<blockquote><p>{}</p></blockquote>", esc(&i.note)));
        }
        html.push_str(&format!("<p>From {}</p>", esc(&i.source)));
        html.push_str(i.content.as_deref().unwrap_or(""));
        s.push_str("  <entry>\n");
        s.push_str(&format!("    <id>{id}</id>\n"));
        s.push_str(&format!("    <title>{}</title>\n", esc(&i.title)));
        s.push_str(&format!("    <link href=\"{}\"/>\n", attr(&i.url)));
        s.push_str(&format!("    <published>{}</published>\n", rfc3339(i.published)));
        s.push_str(&format!("    <updated>{}</updated>\n", rfc3339(i.at)));
        s.push_str(&format!("    <author><name>{}</name></author>\n", esc(&i.source)));
        if !i.note.trim().is_empty() {
            s.push_str(&format!("    <feedreader:note>{}</feedreader:note>\n", esc(&i.note)));
        }
        s.push_str(&format!("    <feedreader:source>{}</feedreader:source>\n", esc(&i.source)));
        s.push_str(&format!("    <content type=\"html\">{}</content>\n", esc(&html)));
        s.push_str("  </entry>\n");
    }
    s.push_str("</feed>\n");
    s
}

pub fn page(base: &str, items: &[PublicItem]) -> String {
    let mut s = String::from(
        "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><meta name=\"robots\" content=\"noindex\"><title>I recommend</title>",
    );
    s.push_str(&format!("<link rel=\"alternate\" type=\"application/atom+xml\" href=\"{}\">", attr(&format!("{base}feed.xml"))));
    s.push_str("<style>body{font:15px/1.6 ui-monospace,'SF Mono',monospace;max-width:46rem;margin:3rem auto;padding:0 1rem;color:#1a1a1c;background:#f9f9f7}a{color:#2152a8}blockquote{margin:.4rem 0 .4rem 0;padding-left:1rem;border-left:1px solid #b8b8ba;color:#555}h1{font-size:15px;font-weight:600;letter-spacing:.04em}hr{border:0;border-top:1px solid #b8b8ba;margin:1.5rem 0}.m{color:#737377}</style></head><body>");
    s.push_str("<h1>I RECOMMEND</h1>");
    s.push_str(&format!(
        "<p class=\"m\">[<a href=\"{}\">follow in any feed reader</a>]</p><hr>",
        attr(&format!("{base}feed.xml"))
    ));
    let live: Vec<&PublicItem> = items.iter().filter(|i| i.removed_at.is_none()).collect();
    if live.is_empty() {
        s.push_str("<p class=\"m\">Nothing here yet.</p>");
    }
    for i in live {
        s.push_str(&format!("<p><a href=\"{}\">{}</a><br><span class=\"m\">{}</span></p>", attr(&i.url), esc(&i.title), esc(&i.source)));
        if !i.note.trim().is_empty() {
            s.push_str(&format!("<blockquote>{}</blockquote>", esc(&i.note)));
        }
        s.push_str("<hr>");
    }
    s.push_str("</body></html>");
    s
}

#[derive(Clone, Copy)]
enum Doc {
    Page,
    Feed,
}

fn current(shared: &Shared, token: &str, doc: Doc, headers: &HeaderMap) -> Response {
    let p = shared.read().unwrap_or_else(|e| e.into_inner());
    if token != p.token {
        return (StatusCode::NOT_FOUND, "Not found").into_response();
    }
    let (kind, body, tag) = match doc {
        Doc::Page => ("text/html; charset=utf-8", &p.html, format!("\"h{}\"", p.tag)),
        Doc::Feed => ("application/atom+xml; charset=utf-8", &p.atom, format!("\"a{}\"", p.tag)),
    };
    let seen = headers.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok()).is_some_and(|v| v.split(',').any(|t| t.trim() == tag));
    let tag = HeaderValue::from_str(&tag).unwrap_or(HeaderValue::from_static("\"\""));
    let common = [(header::ETAG, tag), (HeaderName::from_static("x-robots-tag"), HeaderValue::from_static("noindex")), (header::CACHE_CONTROL, HeaderValue::from_static("no-cache"))];
    if seen {
        return (StatusCode::NOT_MODIFIED, common).into_response();
    }
    (common, [(header::CONTENT_TYPE, kind)], body.clone()).into_response()
}

async fn serve_page(State(shared): State<Shared>, Path(token): Path<String>, headers: HeaderMap) -> Response {
    current(&shared, &token, Doc::Page, &headers)
}

async fn serve_feed(State(shared): State<Shared>, Path(token): Path<String>, headers: HeaderMap) -> Response {
    current(&shared, &token, Doc::Feed, &headers)
}

const BURST: f64 = 20.0;
const PER_SECOND: f64 = 1.0;
const CLIENTS: usize = 4096;

#[derive(Clone, Copy)]
struct Bucket {
    tokens: f64,
    at: Instant,
}

fn take(bucket: Option<Bucket>, now: Instant) -> Result<Bucket, u64> {
    let tokens = bucket.map_or(BURST, |b| (b.tokens + now.duration_since(b.at).as_secs_f64() * PER_SECOND).min(BURST));
    if tokens >= 1.0 { Ok(Bucket { tokens: tokens - 1.0, at: now }) } else { Err(((1.0 - tokens) / PER_SECOND).ceil() as u64) }
}

type Limits = Arc<Mutex<HashMap<IpAddr, Bucket>>>;

fn client(peer: SocketAddr, headers: &HeaderMap) -> IpAddr {
    let forwarded = || headers.get("x-forwarded-for")?.to_str().ok()?.rsplit(',').next()?.trim().parse().ok();
    if peer.ip().is_loopback() { forwarded().unwrap_or(peer.ip()) } else { peer.ip() }
}

async fn limit(State(limits): State<Limits>, ConnectInfo(peer): ConnectInfo<SocketAddr>, request: Request, next: Next) -> Response {
    let who = client(peer, request.headers());
    let now = Instant::now();
    let verdict = {
        let mut map = limits.lock().unwrap_or_else(|e| e.into_inner());
        if map.len() >= CLIENTS {
            map.retain(|_, b| take(Some(*b), now).is_ok_and(|b| b.tokens + 1.0 < BURST));
        }
        if map.len() >= CLIENTS {
            map.clear();
        }
        let verdict = take(map.get(&who).copied(), now);
        if let Ok(b) = verdict {
            map.insert(who, b);
        }
        verdict
    };
    match verdict {
        Ok(_) => next.run(request).await,
        Err(wait) => (StatusCode::TOO_MANY_REQUESTS, [(header::RETRY_AFTER, wait.to_string())], "Too many requests").into_response(),
    }
}

pub async fn serve(listener: std::net::TcpListener, shared: Shared) -> std::io::Result<()> {
    listener.set_nonblocking(true)?;
    let listener = TcpListener::from_std(listener)?;
    let app = Router::new()
        .route("/{token}", get(serve_page))
        .route("/{token}/", get(serve_page))
        .route("/{token}/feed.xml", get(serve_feed))
        .with_state(shared)
        .layer(from_fn_with_state(Limits::default(), limit));
    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>()).await
}
