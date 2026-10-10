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

pub fn fingerprint(title: &str, url: &str) -> String {
    let host = Url::parse(url).ok().and_then(|u| u.host_str().map(|h| h.trim_start_matches("www.").to_ascii_lowercase())).unwrap_or_default();
    format!("print:{}|{host}", title.trim().to_lowercase())
}

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
        subscribed: known.contains(&feed_id(url.as_str()))
            || known.contains(&fingerprint(&parsed.title, url.as_str()))
            || parsed.site_url.as_deref().is_some_and(|s| known.contains(&fingerprint(&parsed.title, s))),
        recent: {
            let mut items: Vec<(Option<i64>, &str)> = parsed.entries.iter().map(|e| (e.published, e.title.as_str())).collect();
            items.sort_by_key(|i| std::cmp::Reverse(i.0));
            let mut seen = HashSet::new();
            items.into_iter().filter(|(_, t)| !t.is_empty() && seen.insert(*t)).take(3).map(|(_, t)| t.to_string()).collect()
        },
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

fn platform(url: &Url, page: Option<&str>) -> Vec<(Url, String)> {
    let host = url.host_str().unwrap_or("").trim_start_matches("www.").trim_start_matches("m.").to_ascii_lowercase();
    let segs: Vec<&str> = url.path_segments().map(|s| s.filter(|x| !x.is_empty()).collect()).unwrap_or_default();
    let mut out: Vec<(String, &str)> = Vec::new();
    match host.as_str() {
        "youtube.com" | "youtu.be" => {
            if let Some(list) = url.query_pairs().find(|(k, _)| k == "list").map(|(_, v)| v.to_string()) {
                out.push((format!("https://www.youtube.com/feeds/videos.xml?playlist_id={list}"), "playlist"));
            }
            if segs.first() == Some(&"channel")
                && let Some(id) = segs.get(1)
            {
                out.push((format!("https://www.youtube.com/feeds/videos.xml?channel_id={id}"), "videos"));
            }
            if let Some(page) = page {
                for marker in ["\"channelId\":\"", "\"externalId\":\"", "youtube.com/channel/"] {
                    if let Some(i) = page.find(marker) {
                        let id: String = page[i + marker.len()..].chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-').collect();
                        if id.starts_with("UC") && id.len() == 24 {
                            out.push((format!("https://www.youtube.com/feeds/videos.xml?channel_id={id}"), "videos"));
                            break;
                        }
                    }
                }
            }
        }
        "medium.com" => {
            if let Some(first) = segs.first() {
                out.push((format!("https://medium.com/feed/{first}"), "feed"));
            }
        }
        "github.com" => {
            if let (Some(owner), Some(repo)) = (segs.first(), segs.get(1)) {
                out.push((format!("https://github.com/{owner}/{repo}/releases.atom"), "releases"));
                out.push((format!("https://github.com/{owner}/{repo}/commits.atom"), "commits"));
            } else if let Some(owner) = segs.first() {
                out.push((format!("https://github.com/{owner}.atom"), "activity"));
            }
        }
        "reddit.com" | "old.reddit.com" => {
            if segs.first() == Some(&"r")
                && let Some(sub) = segs.get(1)
            {
                out.push((format!("https://www.reddit.com/r/{sub}/.rss"), "feed"));
            }
        }
        h if h.ends_with(".medium.com") || h.ends_with(".substack.com") => {
            out.push((format!("https://{h}/feed"), "feed"));
        }
        _ => {}
    }
    out.into_iter().filter_map(|(u, k)| Url::parse(&u).ok().map(|u| (u, k.to_string()))).collect()
}

fn link_tags(page: &str, base: &Url) -> Vec<(Url, String)> {
    let doc = Html::parse_document(page);
    let sel = Selector::parse("link[rel~=alternate][href], a[rel~=alternate][href][type]").unwrap();
    doc.select(&sel)
        .filter(|l| {
            let t = l.value().attr("type").unwrap_or("").to_ascii_lowercase();
            t.contains("rss") || t.contains("atom") || t.contains("feed+json") || t == "application/json"
        })
        .filter_map(|l| {
            let href = base.join(l.value().attr("href")?).ok()?;
            let title = l.value().attr("title").unwrap_or("").to_lowercase();
            let kind = if title.contains("comment") {
                "comments"
            } else if title.contains("categor") || title.contains("tag") || title.contains("topic") {
                "category"
            } else {
                "feed"
            };
            Some((href, kind.to_string()))
        })
        .collect()
}

pub async fn discover(client: &reqwest::Client, input: &str, known: &HashSet<String>) -> Result<Vec<Candidate>, String> {
    let url = net::parse_url(input)?;
    let f = fetch(client, &url, FEED_ACCEPT, None, Duration::from_secs(10), 10_000_000).await?;
    if f.status >= 400 && platform(&url, None).is_empty() {
        return Err(format!("HTTP {}", f.status));
    }
    if f.status < 400
        && let Ok(parsed) = parse_feed(&f.body, f.url.as_str())
    {
        return Ok(vec![candidate(&f.url, &parsed, "feed", known)]);
    }
    let page = String::from_utf8_lossy(&f.body[..f.body.len().min(2_000_000)]).to_string();
    let base = f.url.clone();
    let mut links = platform(&base, Some(&page));
    links.extend(link_tags(&page, &base));
    let root = base.join("/").ok().filter(|r| r.as_str() != base.as_str());
    if let Some(root) = &root
        && let Ok(rf) = fetch(client, root, PAGE_ACCEPT, None, Duration::from_secs(10), 2_000_000).await
        && rf.status < 400
    {
        let rp = String::from_utf8_lossy(&rf.body).to_string();
        links.extend(link_tags(&rp, &rf.url));
    }
    let probe_base = root.unwrap_or_else(|| base.clone());
    links.extend(PROBES.iter().filter_map(|p| probe_base.join(p).ok().map(|u| (u, "feed".to_string()))));
    links.extend(base.join("feed/").ok().filter(|_| base.path().len() > 1).map(|u| (u, "category".to_string())));
    let mut seen = HashSet::new();
    links.retain(|(u, _)| seen.insert(feed_id(u.as_str())));
    let found: Vec<Candidate> = join_all(links.into_iter().map(|(u, k)| probe(client, u, k, known)))
        .await
        .into_iter()
        .flatten()
        .collect();
    let mut seen = HashSet::new();
    let mut titles = HashSet::new();
    let found: Vec<Candidate> = found
        .into_iter()
        .filter(|c| seen.insert(feed_id(&c.url)))
        .filter(|c| titles.insert((c.title.clone(), c.entries, c.latest)))
        .collect();
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
    store_media(dir, url, &f.body, &f.kind.unwrap_or_default()).await
}

pub async fn store_media(dir: &std::path::Path, url: &str, body: &[u8], kind: &str) -> Result<(String, String, i64), String> {
    let digest = <sha2::Sha256 as sha2::Digest>::digest(url.as_bytes());
    let file: String = digest[..16].iter().map(|b| format!("{b:02x}")).collect();
    tokio::fs::create_dir_all(dir).await.map_err(|e| e.to_string())?;
    let tmp = dir.join(format!("{file}.part"));
    tokio::fs::write(&tmp, body).await.map_err(|e| e.to_string())?;
    tokio::fs::rename(&tmp, dir.join(&file)).await.map_err(|e| e.to_string())?;
    Ok((file, kind.to_string(), body.len() as i64))
}

pub fn read_opml(text: &str) -> Vec<(String, String, Option<String>)> {
    use quick_xml::events::Event;
    let mut reader = quick_xml::Reader::from_str(text);
    let mut out = Vec::new();
    let mut stack: Vec<Option<String>> = Vec::new();
    loop {
        match reader.read_event() {
            Ok(ev @ (Event::Start(_) | Event::Empty(_))) => {
                let (e, empty) = match &ev {
                    Event::Start(e) => (e, false),
                    Event::Empty(e) => (e, true),
                    _ => unreachable!(),
                };
                if e.local_name().as_ref() != "outline" {
                    continue;
                }
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
                let name = title.or(text).unwrap_or_default();
                match url {
                    Some(u) => {
                        let folder = stack.iter().rev().flatten().next().cloned();
                        out.push((u, name, folder));
                        if !empty {
                            stack.push(None);
                        }
                    }
                    None if !empty => stack.push(Some(name).filter(|n| !n.trim().is_empty())),
                    None => {}
                }
            }
            Ok(Event::End(e)) if e.local_name().as_ref() == "outline" => {
                stack.pop();
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    out
}

pub fn write_opml(feeds: &[Feed], folders: &[crate::types::Folder]) -> String {
    let esc = |s: &str| html_escape::encode_double_quoted_attribute(s).to_string();
    let line = |f: &Feed, indent: &str| {
        format!(
            "{indent}<outline type=\"rss\" text=\"{0}\" title=\"{0}\" xmlUrl=\"{1}\"{2}/>\n",
            esc(f.name()),
            esc(&f.url),
            f.site_url.as_deref().map(|h| format!(" htmlUrl=\"{}\"", esc(h))).unwrap_or_default()
        )
    };
    let mut s = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<opml version=\"2.0\">\n  <head><title>Feedreader subscriptions</title></head>\n  <body>\n",
    );
    let mut placed = HashSet::new();
    for folder in folders {
        let members: Vec<&Feed> = feeds.iter().filter(|f| folder.feeds.contains(&f.id)).collect();
        if members.is_empty() {
            continue;
        }
        s.push_str(&format!("    <outline text=\"{0}\" title=\"{0}\">\n", esc(&folder.name)));
        for f in members {
            placed.insert(f.id.clone());
            s.push_str(&line(f, "      "));
        }
        s.push_str("    </outline>\n");
    }
    for f in feeds.iter().filter(|f| !placed.contains(&f.id)) {
        s.push_str(&line(f, "    "));
    }
    s.push_str("  </body>\n</opml>\n");
    s
}
