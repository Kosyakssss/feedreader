use std::collections::BTreeSet;
use std::net::{Ipv4Addr, Ipv6Addr};

use proptest::prelude::*;

use crate::net::{check_url, parse_url, public_ip, public_v4};
use crate::parse::{NewEntry, parse_feed};
use crate::store::feed_id;
use crate::types::{Appearance, Change, Command, Lines, Mode, Rule, Scope, Settings};
use crate::{Audience, Engine, Event};

const URLS: &[&str] = &["https://a.example/feed", "https://b.example/rss.xml", "https://c.example/atom.xml"];
const FOLDERS: &[&str] = &["News", "Friends", "Work"];
const SETUP: &str = "https://setup.example/feed";

fn engine() -> Engine {
    let dir = std::env::temp_dir().join(format!("feedreader-law-{}", crate::store::new_id()));
    let out: Box<dyn Fn(Event, Audience) + Send> = Box::new(|_, _| {});
    let mut e = Engine::new(dir, out).expect("engine");
    e.batching = true;
    let feed = e.store.ensure_feed(SETUP, "Setup").expect("feed");
    let now = crate::now();
    let items = (0..5)
        .map(|i| NewEntry {
            source_id: format!("e{i}"),
            url: format!("https://setup.example/{i}"),
            title: format!("Entry {i}"),
            author: None,
            published: Some(now - i * 1000),
            summary: None,
            content: None,
            images: Vec::new(),
        })
        .collect();
    e.store.insert_entries(&feed.id, items, now);
    e
}

fn entry_ids() -> Vec<String> {
    let feed = feed_id(SETUP);
    (0..5).map(|i| crate::store::entry_id(&feed, &format!("e{i}"))).collect()
}

fn feed_ids() -> Vec<String> {
    URLS.iter().chain([SETUP].iter()).map(|u| feed_id(u)).collect()
}

fn command() -> impl Strategy<Value = Command> {
    let entries = entry_ids();
    let feeds = feed_ids();
    let entry = proptest::sample::select(entries.clone());
    let some_entries = proptest::sample::subsequence(entries, 1..=3);
    let feed = proptest::sample::select(feeds);
    let url = proptest::sample::select(URLS.to_vec());
    let names = proptest::sample::subsequence(FOLDERS.to_vec(), 0..=2).prop_map(|v| v.into_iter().map(String::from).collect::<Vec<_>>());
    let mode = proptest::option::of(prop_oneof![Just(Mode::Clean), Just(Mode::Feed), Just(Mode::Original)]);
    let rule_id = proptest::sample::select(vec!["r1", "r2"]);
    let scope = prop_oneof![Just(Scope::All), feed.clone().prop_map(Scope::Feed)];
    prop_oneof![
        (some_entries.clone(), any::<bool>()).prop_map(|(ids, v)| Command::Read(ids, v)),
        (some_entries, any::<bool>()).prop_map(|(ids, v)| Command::Bookmark(ids, v)),
        (url.clone(), names.clone()).prop_map(|(u, f)| Command::Subscribe(u.to_string(), String::new(), f)),
        url.clone().prop_map(|u| Command::Unsubscribe(feed_id(u))),
        url.prop_map(|u| Command::Resubscribe(feed_id(u))),
        (feed.clone(), proptest::option::of("[a-z]{1,4}")).prop_map(|(f, l)| Command::Rename(f, l)),
        (feed.clone(), names).prop_map(|(f, n)| Command::Folders(f, n)),
        (feed.clone(), any::<bool>()).prop_map(|(f, v)| Command::Pin(f, v)),
        (feed.clone(), any::<bool>()).prop_map(|(f, v)| Command::Hide(f, v)),
        (feed, mode).prop_map(|(f, m)| Command::FeedMode(f, m)),
        (rule_id.clone(), "[a-z]{1,4}", scope).prop_map(|(id, word, scope)| Command::AddRule(Rule { id: id.to_string(), word, scope })),
        rule_id.prop_map(|id| Command::RemoveRule(id.to_string())),
        (entry.clone(), "[a-z]{0,4}").prop_map(|(e, n)| Command::Recommend(e, n)),
        entry.prop_map(Command::Unrecommend),
        (proptest::sample::select(FOLDERS.to_vec()), "[A-Z][a-z]{1,4}").prop_map(|(f, n)| Command::RenameFolder(crate::store::folder_id(f), n)),
        proptest::sample::select(FOLDERS.to_vec()).prop_map(|f| Command::DeleteFolder(crate::store::folder_id(f))),
        proptest::sample::select(FOLDERS.to_vec()).prop_map(|f| Command::RestoreFolder(crate::types::Folder { id: crate::store::folder_id(f), name: f.to_string(), feeds: Vec::new() })),
        (proptest::sample::select(feed_ids()), proptest::sample::subsequence(FOLDERS.to_vec(), 0..=2))
            .prop_map(|(feed, names)| Command::Membership(feed, names.into_iter().map(|n| (crate::store::folder_id(n), n.to_string())).collect())),
        (any::<bool>(), 5u32..30, prop_oneof![Just(Lines::Light), Just(Lines::Ascii), Just(Lines::Double)], prop_oneof![Just(Appearance::System), Just(Appearance::Dark)])
            .prop_map(|(merge, refresh, lines, appearance)| Command::Settings(Settings { merge_duplicates: merge, refresh_minutes: refresh, lines, appearance, ..Settings::default() })),
    ]
}

fn changes() -> impl Strategy<Value = Vec<Change>> {
    proptest::collection::vec((command(), 1i64..40, proptest::sample::select(vec!["d1", "d2", "d3"])), 1..25).prop_map(|list| {
        let mut used = std::collections::HashSet::new();
        list.into_iter()
            .enumerate()
            .map(|(n, (command, at, device))| {
                let mut at = at * 1_000_000;
                while !used.insert((device, at)) {
                    at += 1;
                }
                Change { id: format!("c{n}"), device: device.to_string(), at, command }
            })
            .collect()
    })
}

type FeedState = (String, Option<String>, bool, bool, Option<&'static str>);

#[derive(Debug, PartialEq)]
struct State {
    feeds: BTreeSet<FeedState>,
    folders: BTreeSet<(String, String, Vec<String>)>,
    rules: BTreeSet<(String, String, String)>,
    recommendations: BTreeSet<(String, String)>,
    entries: BTreeSet<(String, bool, bool)>,
    settings: String,
}

fn state(e: &Engine) -> State {
    State {
        feeds: e.store.feeds().into_iter().map(|f| (f.id, f.label, f.pinned, f.hidden, f.mode.map(Mode::name))).collect(),
        folders: e
            .store
            .folders()
            .into_iter()
            .map(|f| {
                let mut members = f.feeds;
                members.sort();
                (f.id, f.name, members)
            })
            .collect(),
        rules: e.store.rules().into_iter().map(|r| (r.id, r.word, format!("{:?}", r.scope))).collect(),
        recommendations: e.store.recommendations().into_iter().map(|r| (r.entry, r.note)).collect(),
        entries: e.store.entries().into_iter().map(|x| (x.id, x.read, x.bookmarked)).collect(),
        settings: serde_json::to_string(&e.store.settings()).unwrap_or_default(),
    }
}

fn apply(e: &mut Engine, list: &[Change]) {
    for c in list {
        e.within(|e| {
            e.commit(c.clone());
        });
    }
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 64, ..ProptestConfig::default() })]

    #[test]
    fn sync_converges_in_any_order(list in changes(), seed in any::<u64>()) {
        let mut shuffled = list.clone();
        let mut s = seed;
        for i in (1..shuffled.len()).rev() {
            s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            shuffled.swap(i, (s >> 33) as usize % (i + 1));
        }
        let mut a = engine();
        let mut b = engine();
        apply(&mut a, &list);
        apply(&mut b, &shuffled);
        prop_assert_eq!(state(&a), state(&b));
    }

    #[test]
    fn sync_applying_twice_equals_once(list in changes()) {
        let mut a = engine();
        let mut b = engine();
        apply(&mut a, &list);
        apply(&mut b, &list);
        apply(&mut b, &list);
        prop_assert_eq!(state(&a), state(&b));
    }

    #[test]
    fn sync_newest_change_wins(list in changes()) {
        let mut sorted = list.clone();
        sorted.sort_by(|x, y| (x.at, &x.device).cmp(&(y.at, &y.device)));
        let mut a = engine();
        let mut b = engine();
        apply(&mut a, &list);
        apply(&mut b, &sorted);
        prop_assert_eq!(state(&a), state(&b));
    }

    #[test]
    fn outbound_never_reaches_private_ipv4(octets in any::<[u8; 4]>()) {
        let ip = Ipv4Addr::from(octets);
        let allowed = check_url(&url::Url::parse(&format!("http://{ip}/")).expect("url")).is_ok();
        prop_assert_eq!(allowed, public_v4(ip));
        let decimal = u32::from(ip);
        if let Ok(u) = url::Url::parse(&format!("http://{decimal}/")) {
            prop_assert_eq!(check_url(&u).is_ok(), public_v4(ip));
        }
    }

    #[test]
    fn outbound_never_reaches_private_ipv4_through_ipv6(octets in any::<[u8; 4]>(), form in 0u8..4) {
        let v4 = Ipv4Addr::from(octets);
        let n = u32::from(v4) as u128;
        let v6 = match form {
            0 => Ipv6Addr::from((0xffffu128 << 32) | n),
            1 => Ipv6Addr::from((0x0064_ff9bu128 << 96) | n),
            2 => Ipv6Addr::from((0x2002u128 << 112) | (n << 80)),
            _ => Ipv6Addr::from((0x2001_0000u128 << 96) | (!(n as u32)) as u128),
        };
        if !public_v4(v4) {
            prop_assert!(!public_ip(v6.into()));
            let u = url::Url::parse(&format!("http://[{v6}]/")).expect("url");
            prop_assert!(check_url(&u).is_err());
        }
    }

    #[test]
    fn identity_one_feed_per_address(host in "[a-z]{1,10}\\.(com|org|net)", path in "(/[a-z0-9]{1,6}){0,3}", https in any::<bool>(), www in any::<bool>(), upper in any::<bool>(), slash in any::<bool>()) {
        let base = format!("https://{host}{path}");
        let scheme = if https { "https" } else { "http" };
        let mut h = if www { format!("www.{host}") } else { host.clone() };
        if upper {
            h = h.to_uppercase();
        }
        let variant = format!("{scheme}://{h}{path}{}", if slash { "/" } else { "" });
        prop_assert_eq!(feed_id(&base), feed_id(&variant));
        if let (Ok(a), Ok(b)) = (parse_url(&base), parse_url(&variant)) {
            prop_assert_eq!(feed_id(a.as_str()), feed_id(b.as_str()));
        }
    }

    #[test]
    fn parsing_never_crashes(bytes in proptest::collection::vec(any::<u8>(), 0..2000)) {
        let _ = parse_feed(&bytes, "https://example.com/feed");
    }

    #[test]
    fn parsing_twice_gives_the_same_ids(titles in proptest::collection::vec("[ -~]{0,12}", 0..8), links in any::<bool>(), guids in any::<bool>()) {
        let items: String = titles
            .iter()
            .enumerate()
            .map(|(i, t)| {
                let t = html_escape::encode_text(t);
                let link = if links { format!("<link>https://example.com/{i}</link>") } else { String::new() };
                let guid = if guids { format!("<guid>id-{i}</guid>") } else { String::new() };
                format!("<item><title>{t}</title>{link}{guid}</item>")
            })
            .collect();
        let xml = format!("<?xml version=\"1.0\"?><rss version=\"2.0\"><channel><title>T</title>{items}</channel></rss>");
        let a = parse_feed(xml.as_bytes(), "https://example.com/feed");
        let b = parse_feed(xml.as_bytes(), "https://example.com/feed");
        match (a, b) {
            (Ok(a), Ok(b)) => {
                let ids = |p: &crate::parse::ParsedFeed| p.entries.iter().map(|e| e.source_id.clone()).collect::<Vec<_>>();
                prop_assert_eq!(ids(&a), ids(&b));
            }
            (a, b) => prop_assert_eq!(a.is_ok(), b.is_ok()),
        }
    }
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 64, ..ProptestConfig::default() })]

    #[test]
    fn retention_keeps_what_you_keep(entries in proptest::collection::vec((0i64..400, any::<bool>(), any::<bool>()), 0..160), max in 100u32..140, days in proptest::option::of(1u32..30), saved in 0usize..4) {
        let mut e = engine();
        let feed = feed_id(SETUP);
        let now = crate::now();
        let items = entries
            .iter()
            .enumerate()
            .map(|(i, (age, _, _))| NewEntry {
                source_id: format!("k{i}"),
                url: format!("https://setup.example/k{i}"),
                title: format!("K {i}"),
                author: None,
                published: Some(now - age * 86_400_000),
                summary: None,
                content: None,
                images: Vec::new(),
            })
            .collect();
        e.store.insert_entries(&feed, items, now);
        let mut kept = Vec::new();
        for (i, (_, bookmarked, recommended)) in entries.iter().enumerate() {
            let id = crate::store::entry_id(&feed, &format!("k{i}"));
            if *bookmarked {
                e.store.set_bookmarked(std::slice::from_ref(&id), true, now);
                kept.push(id.clone());
            }
            if *recommended {
                e.store.recommend(&id, "", now);
                kept.push(id);
            }
        }
        for n in 0..saved {
            kept.push(e.store.save_link(&format!("https://saved.example/{n}"), "Saved", "<p>x</p>", now).id);
        }
        let settings = Settings { max_entries: max, max_age_days: days, ..Settings::default() };
        let removed: BTreeSet<String> = e.store.prune(&settings, now).into_iter().collect();
        for id in &kept {
            prop_assert!(!removed.contains(id), "pruned {}", id);
        }
        let left = e.store.entries().into_iter().filter(|x| x.feed_id == feed && !x.bookmarked).count();
        prop_assert!(left <= max as usize + kept.len());
    }
}
