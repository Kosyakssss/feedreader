use chrono::{DateTime, NaiveDate, NaiveDateTime, Utc};
use scraper::{ElementRef, Html, Node};
use url::Url;

use crate::types::{Block, Inline};

pub struct ParsedFeed {
    pub title: String,
    pub site_url: Option<String>,
    pub entries: Vec<NewEntry>,
}

pub struct NewEntry {
    pub source_id: String,
    pub url: String,
    pub title: String,
    pub author: Option<String>,
    pub published: Option<i64>,
    pub summary: Option<String>,
    pub content: Option<String>,
    pub images: Vec<String>,
}

pub fn image_urls(html: &str, base: Option<&Url>, limit: usize) -> Vec<String> {
    if !html.contains("<img") {
        return Vec::new();
    }
    let doc = Html::parse_fragment(html);
    let mut out: Vec<String> = Vec::new();
    for el in doc.select(&IMG) {
        let Some(src) = el.value().attr("src").or(el.value().attr("data-src")) else { continue };
        let u = resolve(base, src);
        if u.starts_with("http") && !out.contains(&u) {
            out.push(u);
        }
        if out.len() >= limit {
            break;
        }
    }
    out
}

pub fn parse_date(raw: &str) -> Option<DateTime<Utc>> {
    let s = raw.trim();
    if s.is_empty() {
        return None;
    }
    if let Ok(d) = DateTime::parse_from_rfc3339(s) {
        return Some(d.with_timezone(&Utc));
    }
    if let Ok(d) = DateTime::parse_from_rfc2822(s) {
        return Some(d.with_timezone(&Utc));
    }
    let mut t = s.replace(" UTC", " +0000").replace(" Z", " +0000");
    if let Some(i) = t.find(", ")
        && t[..i].chars().all(|c| c.is_alphabetic())
    {
        t = t[i + 2..].to_string();
    }
    let parts: Vec<&str> = t.split_whitespace().collect();
    let fixed: Vec<String> = parts
        .iter()
        .map(|p| {
            if p.contains(':') && p.split(':').next().is_some_and(|h| h.len() == 1) {
                format!("0{p}")
            } else {
                p.to_string()
            }
        })
        .collect();
    let t = fixed.join(" ");
    if let Ok(d) = DateTime::parse_from_rfc2822(&format!("Mon, {t}").replace("Mon, Mon, ", "Mon, ")) {
        return Some(d.with_timezone(&Utc));
    }
    for f in ["%d %b %Y %H:%M:%S %z", "%d %b %Y %H:%M %z", "%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%d %H:%M:%S %z", "%Y-%m-%dT%H:%M:%S%.f%z"] {
        if let Ok(d) = DateTime::parse_from_str(&t, f) {
            return Some(d.with_timezone(&Utc));
        }
    }
    for f in ["%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M", "%d %b %Y %H:%M:%S", "%d %b %Y %H:%M", "%Y-%m-%dT%H:%M:%S%.f"] {
        if let Ok(d) = NaiveDateTime::parse_from_str(&t, f) {
            return Some(d.and_utc());
        }
    }
    for f in ["%Y-%m-%d", "%Y/%m/%d", "%d %b %Y", "%B %d, %Y", "%b %d, %Y", "%d %B %Y"] {
        if let Ok(d) = NaiveDate::parse_from_str(&t, f) {
            return d.and_hms_opt(0, 0, 0).map(|d| d.and_utc());
        }
    }
    if let Ok(d) = NaiveDate::parse_from_str(&format!("{t}-01"), "%Y-%m-%d") {
        return d.and_hms_opt(0, 0, 0).map(|d| d.and_utc());
    }
    if t.len() == 4 && let Ok(y) = t.parse::<i32>() && (1990..=2100).contains(&y) {
        return NaiveDate::from_ymd_opt(y, 1, 1).and_then(|d| d.and_hms_opt(0, 0, 0)).map(|d| d.and_utc());
    }
    None
}

#[profiling::function]
pub fn parse_feed(bytes: &[u8], base: &str) -> Result<ParsedFeed, String> {
    let parser = feed_rs::parser::Builder::new()
        .base_uri(Some(base))
        .timestamp_parser(parse_date)
        .id_generator(|links, title, _| {
            links
                .first()
                .map(|l| l.href.clone())
                .or_else(|| title.as_ref().map(|t| t.content.clone()))
                .unwrap_or_default()
        })
        .build();
    let feed = parser
        .parse(bytes)
        .map_err(|_| "Unrecognized feed format".to_string())?;
    let base_url = Url::parse(base).ok();
    let title = feed
        .title
        .as_ref()
        .map(|t| text_of(&t.content, t.content_type.to_string().contains("html")))
        .unwrap_or_default();
    let site_url = feed
        .links
        .iter()
        .find(|l| l.rel.as_deref().is_none_or(|r| r == "alternate"))
        .map(|l| l.href.clone());
    let entries = feed
        .entries
        .into_iter()
        .map(|e| {
            let link = e
                .links
                .iter()
                .find(|l| l.rel.as_deref().is_none_or(|r| r == "alternate"))
                .or(e.links.first())
                .map(|l| resolve(base_url.as_ref(), &l.href))
                .filter(|u| u.starts_with("http://") || u.starts_with("https://"))
                .unwrap_or_default();
            let title = e
                .title
                .as_ref()
                .map(|t| text_of(&t.content, t.content_type.to_string().contains("html")))
                .unwrap_or_default();
            let content = e.content.and_then(|c| c.body).filter(|b| !b.trim().is_empty());
            let summary = e.summary.map(|s| s.content).filter(|s| !s.trim().is_empty());
            let title = if title.is_empty() || title.eq_ignore_ascii_case("untitled") {
                let text = text_of(summary.as_deref().or(content.as_deref()).unwrap_or(""), true);
                let mut short: String = text.chars().take(90).collect();
                if text.chars().count() > 90 {
                    short = short.trim_end().to_string() + "\u{2026}";
                }
                short
            } else {
                title
            };
            let author = e.authors.first().and_then(|a| a.name.clone()).filter(|a| !a.is_empty());
            let published = e.published.or(e.updated).map(|d| d.timestamp_millis()).filter(|&t| t > 631_152_000_000);
            let mut media = String::new();
            let has_image = content.as_deref().or(summary.as_deref()).is_some_and(|c| c.contains("<img"));
            let attr = |s: &str| html_escape::encode_double_quoted_attribute(s).to_string();
            let mut thumb = None;
            for m in &e.media {
                for c in &m.content {
                    if let Some(u) = &c.url {
                        let kind = c.content_type.as_ref().map(|t| t.to_string()).unwrap_or_default();
                        if kind.starts_with("image/") {
                            if !has_image {
                                media.push_str(&format!("<p><img src=\"{}\"></p>", attr(u.as_str())));
                            }
                        } else {
                            media.push_str(&format!("<p><a href=\"{0}\" data-media=\"{1}\">{0}</a></p>", attr(u.as_str()), attr(&kind)));
                        }
                    }
                }
                if thumb.is_none() {
                    thumb = m.thumbnails.first().map(|t| t.image.uri.clone());
                }
            }
            if let Some(t) = thumb.filter(|_| !has_image && !media.contains("<img")) {
                media.insert_str(0, &format!("<p><img src=\"{}\"></p>", attr(&t)));
            }
            let content = match (content, media.is_empty()) {
                (Some(c), true) => Some(c),
                (Some(c), false) => Some(format!("{c}{media}")),
                (None, false) => Some(media),
                (None, true) => None,
            };
            let images = image_urls(content.as_deref().or(summary.as_deref()).unwrap_or(""), base_url.as_ref(), 12);
            NewEntry {
                source_id: e.id,
                url: link,
                title,
                author,
                published,
                summary,
                content,
                images,
            }
        })
        .collect();
    Ok(ParsedFeed {
        title,
        site_url,
        entries,
    })
}

fn resolve(base: Option<&Url>, href: &str) -> String {
    match base.and_then(|b| b.join(href).ok()) {
        Some(u) => u.to_string(),
        None => href.to_string(),
    }
}

fn collapse_keep_edges(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut space = false;
    for c in s.chars() {
        if c.is_whitespace() {
            space = true;
        } else {
            if space {
                out.push(' ');
                space = false;
            }
            out.push(c);
        }
    }
    if space {
        out.push(' ');
    }
    out
}

fn collapse(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn text_of(s: &str, html: bool) -> String {
    if html {
        let frag = Html::parse_fragment(s);
        collapse(&frag.root_element().text().collect::<String>())
    } else {
        collapse(&html_escape::decode_html_entities(s))
    }
}

struct Walker<'a> {
    base: Option<&'a Url>,
    blocks: Vec<Block>,
    inline: Vec<Inline>,
    quote: usize,
    list: Vec<Option<u32>>,
}

impl Walker<'_> {
    fn push_text(&mut self, text: &str, wrap: fn(String) -> Inline) {
        let mut t = collapse_keep_edges(text);
        if t.is_empty() {
            return;
        }
        if self.inline.is_empty() || matches!(self.inline.last(), Some(Inline::Break)) {
            t = t.trim_start().to_string();
            if t.is_empty() {
                return;
            }
        }
        let plain = matches!(wrap(String::new()), Inline::Text(_));
        if plain && let Some(Inline::Text(prev)) = self.inline.last_mut() {
            if prev.ends_with(' ') && t.starts_with(' ') {
                t.remove(0);
            }
            prev.push_str(&t);
            return;
        }
        self.inline.push(wrap(t));
    }

    fn flush(&mut self) {
        while matches!(self.inline.last(), Some(Inline::Break)) {
            self.inline.pop();
        }
        if let Some(Inline::Text(t)) = self.inline.last_mut() {
            let trimmed = t.trim_end().to_string();
            *t = trimmed;
        }
        let has_text = self.inline.iter().any(|i| match i {
            Inline::Text(t) | Inline::Bold(t) | Inline::Italic(t) | Inline::Code(t) => !t.trim().is_empty(),
            Inline::Link(t, _) => !t.trim().is_empty(),
            Inline::Break => false,
        });
        let inline = std::mem::take(&mut self.inline);
        if !has_text {
            return;
        }
        let block = if let Some(n) = self.list.last() {
            let depth = self.list.len() as u8;
            Block::Item(depth, *n, inline)
        } else if self.quote > 0 {
            Block::Quote(inline)
        } else {
            Block::Paragraph(inline)
        };
        self.blocks.push(block);
    }

    fn walk(&mut self, el: ElementRef) {
        for child in el.children() {
            match child.value() {
                Node::Text(t) => self.push_text(t, Inline::Text),
                Node::Element(_) => {
                    if let Some(c) = ElementRef::wrap(child) {
                        self.element(c);
                    }
                }
                _ => {}
            }
        }
    }

    fn element(&mut self, el: ElementRef) {
        let name = el.value().name();
        let text = || collapse(&el.text().collect::<String>());
        match name {
            "script" | "style" | "noscript" | "template" | "svg" | "button" | "form" | "nav" => {}
            "br" => self.inline.push(Inline::Break),
            "strong" | "b" => self.push_text(&text(), Inline::Bold),
            "em" | "i" | "cite" => self.push_text(&text(), Inline::Italic),
            "code" | "kbd" | "samp" | "tt" => {
                let t = text();
                if !t.is_empty() {
                    self.inline.push(Inline::Code(t));
                }
            }
            "a" => {
                let href = el.value().attr("href").map(|h| resolve(self.base, h)).unwrap_or_default();
                if el.select(&IMG).next().is_some() {
                    self.walk(el);
                    return;
                }
                let t = text();
                if el.value().attr("data-media").is_some() {
                    self.flush();
                    self.blocks.push(Block::Media(href, el.value().attr("data-media").unwrap_or("").to_string()));
                } else if !t.is_empty() {
                    if href.starts_with("http") {
                        self.inline.push(Inline::Link(t, href));
                    } else {
                        self.push_text(&t, Inline::Text);
                    }
                }
            }
            "img" => {
                let src = el
                    .value()
                    .attr("src")
                    .or(el.value().attr("data-src"))
                    .map(|s| resolve(self.base, s))
                    .unwrap_or_default();
                if src.starts_with("http") {
                    self.flush();
                    let dim = |k: &str| el.value().attr(k).and_then(|v| v.trim_end_matches("px").parse::<u32>().ok()).filter(|&n| n > 0);
                    let size = dim("width").zip(dim("height"));
                    self.blocks.push(Block::Image(src, el.value().attr("alt").unwrap_or("").to_string(), size));
                }
            }
            "video" | "audio" | "iframe" | "embed" | "object" => {
                let src = el
                    .value()
                    .attr("src")
                    .or_else(|| el.select(&SOURCE).next().and_then(|s| s.value().attr("src")))
                    .map(|s| resolve(self.base, s))
                    .unwrap_or_default();
                self.flush();
                if !src.is_empty() {
                    self.blocks.push(Block::Media(src, name.to_string()));
                }
            }
            "hr" => {
                self.flush();
                self.blocks.push(Block::Rule);
            }
            "pre" => {
                self.flush();
                let code: String = el.text().collect();
                self.blocks.push(Block::Code(code.trim_end().to_string()));
            }
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                self.flush();
                let level = name[1..].parse().unwrap_or(2);
                let t = text();
                if !t.is_empty() {
                    self.blocks.push(Block::Heading(level, vec![Inline::Text(t)]));
                }
            }
            "blockquote" => {
                self.flush();
                self.quote += 1;
                self.walk(el);
                self.flush();
                self.quote -= 1;
            }
            "ul" | "ol" => {
                self.flush();
                let ordered = name == "ol";
                self.list.push(if ordered { Some(0) } else { None });
                self.walk(el);
                self.flush();
                self.list.pop();
            }
            "li" => {
                self.flush();
                if let Some(Some(n)) = self.list.last_mut() {
                    *n += 1;
                }
                self.walk(el);
                self.flush();
            }
            "p" | "div" | "section" | "article" | "header" | "footer" | "main" | "figure" | "figcaption"
            | "table" | "tr" | "dl" | "dt" | "dd" | "aside" | "details" | "summary" | "center" => {
                self.flush();
                self.walk(el);
                self.flush();
            }
            "td" | "th" => {
                self.walk(el);
                self.push_text(" ", Inline::Text);
            }
            _ => self.walk(el),
        }
    }
}

static IMG: std::sync::LazyLock<scraper::Selector> =
    std::sync::LazyLock::new(|| scraper::Selector::parse("img").unwrap());
static SOURCE: std::sync::LazyLock<scraper::Selector> =
    std::sync::LazyLock::new(|| scraper::Selector::parse("source").unwrap());

#[profiling::function]
pub fn blocks(html: &str, base: Option<&str>) -> Vec<Block> {
    let base = base.and_then(|b| Url::parse(b).ok());
    let doc = Html::parse_fragment(html);
    let mut w = Walker {
        base: base.as_ref(),
        blocks: Vec::new(),
        inline: Vec::new(),
        quote: 0,
        list: Vec::new(),
    };
    w.walk(doc.root_element());
    w.flush();
    w.blocks
}
