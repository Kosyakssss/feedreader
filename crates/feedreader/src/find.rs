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

