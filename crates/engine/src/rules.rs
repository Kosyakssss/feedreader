use crate::types::{Rule, Scope};

pub fn muted(title: &str, feed: &str, folders: &[&str], rules: &[Rule]) -> bool {
    let title = title.to_lowercase();
    rules.iter().any(|r| {
        let applies = match &r.scope {
            Scope::All => true,
            Scope::Feed(f) => f == feed,
            Scope::Folder(f) => folders.contains(&f.as_str()),
        };
        applies && !r.word.trim().is_empty() && title.contains(&r.word.trim().to_lowercase())
    })
}

pub fn link_key(url: &str) -> String {
    let Ok(mut u) = url::Url::parse(url) else {
        return url.to_string();
    };
    u.set_fragment(None);
    let kept: Vec<(String, String)> = u
        .query_pairs()
        .filter(|(k, _)| !k.starts_with("utm_") && k != "ref" && k != "source")
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    if kept.is_empty() {
        u.set_query(None);
    } else {
        u.query_pairs_mut().clear().extend_pairs(kept);
    }
    let host = u.host_str().unwrap_or("").trim_start_matches("www.").to_ascii_lowercase();
    let path = u.path().trim_end_matches('/');
    let query = u.query().map(|q| format!("?{q}")).unwrap_or_default();
    format!("{host}{path}{query}")
}

pub fn parse_rule(input: &str, feeds: &[(String, String)], folders: &[(String, String)]) -> Result<(String, Scope), String> {
    let input = input.trim();
    let (word, scope) = if let Some((w, f)) = input.split_once(" in:") {
        let name = f.trim().to_lowercase();
        let folder = folders
            .iter()
            .find(|(_, n)| n.to_lowercase() == name)
            .or_else(|| folders.iter().find(|(_, n)| n.to_lowercase().contains(&name)))
            .ok_or_else(|| format!("No folder called \u{201C}{}\u{201D}", f.trim()))?;
        (w, Scope::Folder(folder.0.clone()))
    } else if let Some((w, f)) = input.split_once(" from:") {
        let name = f.trim().to_lowercase();
        let feed = feeds
            .iter()
            .find(|(_, n)| n.to_lowercase() == name)
            .or_else(|| feeds.iter().find(|(_, n)| n.to_lowercase().contains(&name)))
            .ok_or_else(|| format!("No feed called \u{201C}{}\u{201D}", f.trim()))?;
        (w, Scope::Feed(feed.0.clone()))
    } else {
        (input, Scope::All)
    };
    let word = word.trim().trim_matches('"').to_string();
    if word.is_empty() {
        return Err("Type a word or phrase to mute".into());
    }
    Ok((word, scope))
}
