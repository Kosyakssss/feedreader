use std::sync::{Arc, RwLock};

use axum::Router;
use axum::extract::{Path, State};
use axum::http::{HeaderName, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use chrono::{DateTime, Utc};
use tokio::net::TcpListener;

use crate::store::PublicItem;

#[derive(Default)]
pub struct Published {
    pub token: String,
    pub atom: String,
    pub html: String,
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

fn reply(kind: &'static str, body: String) -> Response {
    let headers = [
        (header::CONTENT_TYPE, kind),
        (HeaderName::from_static("x-robots-tag"), "noindex"),
        (header::CACHE_CONTROL, "no-cache"),
    ];
    (headers, body).into_response()
}

fn current(shared: &Shared, token: &str, pick: fn(&Published) -> (&'static str, String)) -> Response {
    let p = shared.read().unwrap_or_else(|e| e.into_inner());
    if token != p.token {
        return (StatusCode::NOT_FOUND, "Not found").into_response();
    }
    let (kind, body) = pick(&p);
    reply(kind, body)
}

async fn serve_page(State(shared): State<Shared>, Path(token): Path<String>) -> Response {
    current(&shared, &token, |p| ("text/html; charset=utf-8", p.html.clone()))
}

async fn serve_feed(State(shared): State<Shared>, Path(token): Path<String>) -> Response {
    current(&shared, &token, |p| ("application/atom+xml; charset=utf-8", p.atom.clone()))
}

pub async fn serve(listener: std::net::TcpListener, shared: Shared) -> std::io::Result<()> {
    listener.set_nonblocking(true)?;
    let listener = TcpListener::from_std(listener)?;
    let app = Router::new()
        .route("/{token}", get(serve_page))
        .route("/{token}/", get(serve_page))
        .route("/{token}/feed.xml", get(serve_feed))
        .with_state(shared);
    axum::serve(listener, app).await
}
