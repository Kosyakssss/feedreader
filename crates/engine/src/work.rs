use std::collections::HashSet;
use std::time::Duration;

use futures::future::join_all;
use scraper::{Html, Selector};
use url::Url;

use crate::net::{self, fetch};
use crate::parse::{ParsedFeed, parse_feed};
use crate::store::feed_id;
use crate::types::{Candidate, Extracted, Feed};

pub const FEED_ACCEPT: &str =
    "application/rss+xml, application/atom+xml, application/feed+json, application/json;q=0.9, application/xml;q=0.8, text/xml;q=0.8, */*;q=0.1";
const PAGE_ACCEPT: &str = "text/html, application/xhtml+xml, */*;q=0.5";
const PROBES: &[&str] = &["/feed", "/rss", "/feed.xml", "/atom.xml", "/index.xml", "/rss.xml", "/feed.json"];

fn candidate(url: &Url, parsed: &ParsedFeed, kind: &str, known: &HashSet<String>) -> Candidate {
    Candidate {
        url: url.to_string(),
        title: if parsed.title.is_empty() {
            url.host_str().unwrap_or("").to_string()
        } else {
            parsed.title.clone()
        },
        kind: kind.to_string(),
        entries: parsed.entries.len(),
        latest: parsed.entries.iter().filter_map(|e| e.published).max(),
        subscribed: known.contains(&feed_id(url.as_str())),
    }
}

async fn probe(client: &reqwest::Client, url: Url, kind: String, known: &HashSet<String>) -> Option<Candidate> {
    let f = fetch(client, &url, FEED_ACCEPT, None, Duration::from_secs(5), 10_000_000).await.ok()?;
    if f.status >= 400 {
        return None;
    }
    let parsed = parse_feed(&f.body, f.url.as_str()).ok()?;
    Some(candidate(&f.url, &parsed, &kind, known))
}

pub async fn discover(client: &reqwest::Client, input: &str, known: &HashSet<String>) -> Result<Vec<Candidate>, String> {
    let url = net::parse_url(input)?;
    let f = fetch(client, &url, FEED_ACCEPT, None, Duration::from_secs(10), 10_000_000).await?;
    if f.status >= 400 {
        return Err(format!("HTTP {}", f.status));
    }
    if let Ok(parsed) = parse_feed(&f.body, f.url.as_str()) {
        return Ok(vec![candidate(&f.url, &parsed, "feed", known)]);
    }
    let page = String::from_utf8_lossy(&f.body[..f.body.len().min(2_000_000)]).to_string();
    let base = f.url.clone();
    let mut links: Vec<(Url, String)> = {
        let doc = Html::parse_document(&page);
        let sel = Selector::parse("link[rel~=alternate][href]").unwrap();
        doc.select(&sel)
            .filter(|l| {
                let t = l.value().attr("type").unwrap_or("").to_ascii_lowercase();
                t.contains("rss") || t.contains("atom") || t.contains("feed+json") || t == "application/json"
            })
            .filter_map(|l| {
                let href = base.join(l.value().attr("href")?).ok()?;
                let title = l.value().attr("title").unwrap_or("").to_lowercase();
                let kind = if title.contains("comment") { "comments" } else if title.contains("categor") || title.contains("tag") { "category" } else { "feed" };
                Some((href, kind.to_string()))
            })
            .collect()
    };
    if links.is_empty() {
        links = PROBES
            .iter()
            .filter_map(|p| base.join(p).ok().map(|u| (u, "feed".to_string())))
            .collect();
    }
    let mut seen = HashSet::new();
    links.retain(|(u, _)| seen.insert(feed_id(u.as_str())));
    let found: Vec<Candidate> = join_all(links.into_iter().map(|(u, k)| probe(client, u, k, known)))
        .await
        .into_iter()
        .flatten()
        .collect();
    let mut seen = HashSet::new();
    let found: Vec<Candidate> = found.into_iter().filter(|c| seen.insert(feed_id(&c.url))).collect();
    if found.is_empty() {
        Err("No RSS, Atom or JSON Feed found there".into())
    } else {
        Ok(found)
    }
}

pub async fn fetch_page(client: &reqwest::Client, url: &str) -> Result<(String, String), String> {
    let u = Url::parse(url).map_err(|e| e.to_string())?;
    let f = fetch(client, &u, PAGE_ACCEPT, None, Duration::from_secs(12), 8_000_000).await?;
    if f.status >= 400 {
        return Err(format!("HTTP {}", f.status));
    }
    Ok((f.url.to_string(), String::from_utf8_lossy(&f.body).to_string()))
}

#[profiling::function]
pub fn readability(url: &str, html: String) -> Result<Extracted, String> {
    let mut r = dom_smoothie::Readability::new(html, Some(url), None).map_err(|e| e.to_string())?;
    let article = r.parse().map_err(|e| e.to_string())?;
    Ok(Extracted {
        title: article.title.trim().to_string(),
        html: article.content.to_string(),
    })
}

const MEDIA_ACCEPT: &str = "image/webp, image/png, image/jpeg, image/gif, image/*;q=0.8, */*;q=0.1";

pub async fn fetch_media(client: &reqwest::Client, url: &str, dir: &std::path::Path) -> Result<(String, String, i64), String> {
    let u = Url::parse(url).map_err(|e| e.to_string())?;
    let f = fetch(client, &u, MEDIA_ACCEPT, None, Duration::from_secs(15), 10_000_000).await?;
    if f.status >= 400 {
        return Err(format!("HTTP {}", f.status));
    }
    let digest = <sha2::Sha256 as sha2::Digest>::digest(url.as_bytes());
    let file: String = digest[..16].iter().map(|b| format!("{b:02x}")).collect();
    tokio::fs::create_dir_all(dir).await.map_err(|e| e.to_string())?;
    let tmp = dir.join(format!("{file}.part"));
    tokio::fs::write(&tmp, &f.body).await.map_err(|e| e.to_string())?;
    tokio::fs::rename(&tmp, dir.join(&file)).await.map_err(|e| e.to_string())?;
    Ok((file, f.kind.unwrap_or_default(), f.body.len() as i64))
}

pub fn read_opml(text: &str) -> Vec<(String, String)> {
    use quick_xml::events::Event;
    let mut reader = quick_xml::Reader::from_str(text);
    let mut out = Vec::new();
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) if e.local_name().as_ref() == "outline" => {
                let mut url = None;
                let mut title = None;
                let mut text = None;
                for a in e.attributes().flatten() {
                    let value = a.normalized_value(quick_xml::XmlVersion::Implicit1_0).map(|v| v.to_string()).unwrap_or_default();
                    match a.key.local_name().as_ref() {
                        "xmlUrl" | "xmlurl" => url = Some(value),
                        "title" => title = Some(value),
                        "text" => text = Some(value),
                        _ => {}
                    }
                }
                if let Some(u) = url {
                    out.push((u, title.or(text).unwrap_or_default()));
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    out
}

pub fn write_opml(feeds: &[Feed]) -> String {
    let esc = |s: &str| html_escape::encode_double_quoted_attribute(s).to_string();
    let mut s = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<opml version=\"2.0\">\n  <head><title>Feedreader subscriptions</title></head>\n  <body>\n",
    );
    for f in feeds {
        s.push_str(&format!(
            "    <outline type=\"rss\" text=\"{0}\" title=\"{0}\" xmlUrl=\"{1}\"{2}/>\n",
            esc(f.name()),
            esc(&f.url),
            f.site_url.as_deref().map(|h| format!(" htmlUrl=\"{}\"", esc(h))).unwrap_or_default()
        ));
    }
    s.push_str("  </body>\n</opml>\n");
    s
}
