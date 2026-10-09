use std::sync::{Arc, RwLock};

use chrono::{DateTime, Utc};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
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

fn response(status: &str, kind: &str, body: &str) -> Vec<u8> {
    format!(
        "HTTP/1.1 {status}\r\ncontent-type: {kind}\r\ncontent-length: {}\r\nx-robots-tag: noindex\r\ncache-control: no-cache\r\nconnection: close\r\n\r\n{body}",
        body.len()
    )
    .into_bytes()
}

pub async fn serve(port: u16, shared: Shared) -> std::io::Result<()> {
    let listener = TcpListener::bind(("127.0.0.1", port)).await?;
    loop {
        let (mut sock, _) = listener.accept().await?;
        let shared = shared.clone();
        tokio::spawn(async move {
            let mut buf = vec![0u8; 4096];
            let n = match tokio::time::timeout(std::time::Duration::from_secs(5), sock.read(&mut buf)).await {
                Ok(Ok(n)) => n,
                _ => return,
            };
            let req = String::from_utf8_lossy(&buf[..n]);
            let path = req.split_whitespace().nth(1).unwrap_or("/").to_string();
            let reply = {
                let p = shared.read().unwrap();
                let root = format!("/{}/", p.token);
                if path == format!("{root}feed.xml") {
                    response("200 OK", "application/atom+xml; charset=utf-8", &p.atom)
                } else if path == root || path == format!("/{}", p.token) {
                    response("200 OK", "text/html; charset=utf-8", &p.html)
                } else {
                    response("404 Not Found", "text/plain", "Not found")
                }
            };
            let _ = sock.write_all(&reply).await;
        });
    }
}
