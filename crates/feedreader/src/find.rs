use engine::FeedId;

use crate::model::Model;

#[derive(Default)]
pub struct Query {
    pub words: Vec<String>,
    pub read: Option<bool>,
    pub bookmarked: bool,
    pub folder: Option<String>,
    pub feed: Option<FeedId>,
    pub error: Option<String>,
}

pub fn parse(m: &Model, text: &str) -> Query {
    let mut q = Query::default();
    for token in text.split_whitespace() {
        let lower = token.to_lowercase();
        if let Some(v) = lower.strip_prefix("is:") {
            match v {
                "unread" => q.read = Some(false),
                "read" => q.read = Some(true),
                "bookmarked" | "saved" => q.bookmarked = true,
                _ => q.error = Some(format!("is:{v} isn't a filter; use is:unread, is:read or is:bookmarked")),
            }
        } else if let Some(v) = lower.strip_prefix("in:") {
            let v = v.replace('_', " ");
            match m.folders.iter().find(|f| f.name.to_lowercase() == v).or_else(|| m.folders.iter().find(|f| f.name.to_lowercase().contains(&v))) {
                Some(f) => q.folder = Some(f.id.clone()),
                None => q.error = Some(format!("No folder matches \u{201C}{v}\u{201D}")),
            }
        } else if let Some(v) = lower.strip_prefix("from:") {
            let v = v.replace('_', " ");
            match m.subscriptions().find(|f| f.name().to_lowercase() == v).or_else(|| m.subscriptions().find(|f| f.name().to_lowercase().contains(&v))) {
                Some(f) => q.feed = Some(f.id.clone()),
                None => q.error = Some(format!("No feed matches \u{201C}{v}\u{201D}")),
            }
        } else {
            q.words.push(lower);
        }
    }
    q
}


pub struct Hints {
    pub from: usize,
    pub options: Vec<(String, String)>,
    pub error: Option<String>,
}

const PREFIXES: [&str; 3] = ["is:", "in:", "from:"];

fn key(name: &str) -> String {
    name.to_lowercase().replace(' ', "_")
}

pub fn hints(m: &Model, text: &str, caret: usize) -> Hints {
    let before = &text[..caret];
    let from = before.rfind(char::is_whitespace).map_or(0, |i| i + 1);
    let token = before[from..].to_lowercase();
    let options: Vec<(String, String)> = if token.is_empty() {
        PREFIXES.iter().map(|p| (p.to_string(), p.to_string())).collect()
    } else if let Some(v) = token.strip_prefix("is:") {
        ["unread", "read", "bookmarked"].iter().filter(|o| o.starts_with(v)).map(|o| (o.to_string(), format!("is:{o} "))).collect()
    } else if let Some(v) = token.strip_prefix("in:") {
        m.folders.iter().filter(|f| key(&f.name).contains(v)).take(8).map(|f| (f.name.clone(), format!("in:{} ", key(&f.name)))).collect()
    } else if let Some(v) = token.strip_prefix("from:") {
        m.subscriptions().filter(|f| key(f.name()).contains(v)).take(8).map(|f| (f.name().to_string(), format!("from:{} ", key(f.name())))).collect()
    } else {
        PREFIXES.iter().filter(|p| p.starts_with(token.as_str())).map(|p| (p.to_string(), p.to_string())).collect()
    };
    let error = if options.is_empty() && PREFIXES.iter().any(|p| token.starts_with(p)) { parse(m, &token).error } else { None };
    let error = error.or_else(|| parse(m, &format!("{}{}", &text[..from], &text[caret..])).error);
    Hints { from, options, error }
}
