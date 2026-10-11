use proptest::prelude::*;

use engine::{Entry, Event, Feed, Folder, Rule, Scope, Settings};
use graticule::images::Images;

use crate::model::{Model, View};

const WORDS: &[&str] = &["alpha", "beta", "gamma", "delta"];

fn snapshot(feeds: Vec<Feed>, entries: Vec<Entry>, folders: Vec<Folder>, rules: Vec<Rule>, merge: bool) -> Event {
    Event::Snapshot {
        feeds,
        entries,
        settings: Settings { merge_duplicates: merge, ..Settings::default() },
        data_dir: String::new(),
        config: Default::default(),
        folders,
        rules,
        recommendations: Vec::new(),
        public_url: None,
        tabs: Vec::new(),
    }
}

fn library() -> impl Strategy<Value = Event> {
    let feeds = proptest::collection::vec(any::<bool>(), 1..4);
    feeds.prop_flat_map(|hidden| {
        let n = hidden.len();
        let entries = proptest::collection::vec((0..n, any::<bool>(), proptest::sample::select(WORDS.to_vec()), 0u8..4, 0i64..1000), 0..30);
        let folders = proptest::collection::vec(proptest::collection::vec(0..n, 0..=n), 0..3);
        let rules = proptest::collection::vec((proptest::sample::select(WORDS.to_vec()), 0u8..3, 0..n), 0..2);
        (Just(hidden), entries, folders, rules, any::<bool>()).prop_map(|(hidden, entries, folders, rules, merge)| {
            let feeds: Vec<Feed> = hidden
                .iter()
                .enumerate()
                .map(|(i, &h)| Feed {
                    id: format!("f{i}"),
                    url: format!("https://f{i}.example/feed"),
                    title: format!("Feed {i}"),
                    label: None,
                    site_url: None,
                    position: i as i64,
                    last_fetched: None,
                    error: None,
                    pinned: false,
                    hidden: h,
                    mode: None,
                })
                .collect();
            let entries = entries
                .into_iter()
                .enumerate()
                .map(|(i, (feed, read, word, link, published))| Entry {
                    id: format!("f{feed}:e{i}"),
                    feed_id: format!("f{feed}"),
                    url: format!("https://shared.example/{link}"),
                    title: format!("{word} {i}"),
                    author: None,
                    published,
                    read,
                    bookmarked: false,
                    attachments: Vec::new(),
                })
                .collect();
            let folders = folders
                .into_iter()
                .enumerate()
                .map(|(i, members)| {
                    let mut feeds: Vec<String> = members.into_iter().map(|m| format!("f{m}")).collect();
                    feeds.sort();
                    feeds.dedup();
                    Folder { id: format!("d{i}"), name: format!("Folder {i}"), feeds }
                })
                .collect::<Vec<_>>();
            let rules = rules
                .into_iter()
                .enumerate()
                .map(|(i, (word, kind, target))| Rule {
                    id: format!("r{i}"),
                    word: word.to_string(),
                    scope: match kind {
                        0 => Scope::All,
                        1 => Scope::Feed(format!("f{target}")),
                        _ => Scope::Folder(format!("d{}", target % folders.len().max(1))),
                    },
                })
                .collect();
            snapshot(feeds, entries, folders, rules, merge)
        })
    })
}

fn listed(m: &mut Model, view: View) -> usize {
    m.show(view);
    m.filter.set("is:unread ");
    m.reset_list();
    m.list.visible.len()
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 128, ..ProptestConfig::default() })]

    #[test]
    fn counts_match_what_each_view_lists(event in library()) {
        let mut m = Model::new(Images::new(|| {}));
        m.event(event);
        prop_assert_eq!(m.unread_home, listed(&mut m, View::Home));
        let folders: Vec<String> = m.folders.iter().map(|f| f.id.clone()).collect();
        for id in folders {
            let count = m.unread_by_folder.get(&id).copied().unwrap_or(0);
            prop_assert_eq!(count, listed(&mut m, View::Folder(id.clone())), "folder {}", id);
        }
        let feeds: Vec<String> = m.subscriptions().map(|f| f.id.clone()).collect();
        for id in feeds {
            let count = m.unread_by_feed.get(&id).copied().unwrap_or(0);
            prop_assert_eq!(count, listed(&mut m, View::Feed(id.clone())), "feed {}", id);
        }
    }
}

#[derive(Debug, PartialEq)]
struct Visible {
    entries: Vec<(String, bool, bool)>,
    feeds: Vec<(String, bool, bool, Option<&'static str>)>,
    rules: Vec<String>,
    settings: String,
    recommended: Vec<(String, String)>,
}

fn visible(m: &Model) -> Visible {
    let mut recommended: Vec<(String, String)> = m.recommended.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    recommended.sort();
    Visible {
        entries: m.entries.iter().map(|e| (e.id.clone(), e.read, e.bookmarked)).collect(),
        feeds: m.feeds.iter().map(|f| (f.id.clone(), f.pinned, f.hidden, f.mode.map(engine::Mode::name))).collect(),
        rules: {
            let mut ids: Vec<String> = m.rules.iter().map(|r| format!("{}:{}:{:?}", r.id, r.word, r.scope)).collect();
            ids.sort();
            ids
        },
        settings: serde_json::to_string(&m.settings).unwrap_or_default(),
        recommended,
    }
}

fn op(m: &Model) -> impl Strategy<Value = crate::model::Op> + use<> {
    use crate::model::Op;
    let entries: Vec<String> = m.entries.iter().map(|e| e.id.clone()).collect();
    let feeds: Vec<String> = m.feeds.iter().map(|f| f.id.clone()).collect();
    let rules: Vec<Rule> = m.rules.clone();
    let some = if entries.is_empty() { Just(Vec::new()).boxed() } else { proptest::sample::subsequence(entries.clone(), 1..=entries.len().min(4)).boxed() };
    let feed = proptest::sample::select(feeds);
    let mut options: Vec<BoxedStrategy<Op>> = vec![
        (some.clone(), any::<bool>()).prop_map(|(ids, v)| Op::Read(ids.into_iter().map(|id| (id, v)).collect())).boxed(),
        (some.clone(), any::<bool>()).prop_map(|(ids, v)| Op::Bookmark(ids.into_iter().map(|id| (id, v)).collect())).boxed(),
        (feed.clone(), any::<bool>()).prop_map(|(f, v)| Op::Pin(f, v)).boxed(),
        (feed.clone(), any::<bool>()).prop_map(|(f, v)| Op::Hide(f, v)).boxed(),
        (feed, proptest::option::of(prop_oneof![Just(engine::Mode::Clean), Just(engine::Mode::Feed)])).prop_map(|(f, m)| Op::FeedMode(f, m)).boxed(),
        ("[a-z]{1,4}").prop_map(|w| Op::AddRule(Rule { id: format!("new-{w}"), word: w, scope: Scope::All })).boxed(),
        (any::<bool>(), 5u32..60).prop_map(|(merge, refresh)| Op::Settings(Settings { merge_duplicates: merge, refresh_minutes: refresh, ..Settings::default() })).boxed(),
        (some, proptest::option::of("[a-z]{0,4}")).prop_map(|(ids, note)| Op::Recommend(ids.into_iter().map(|id| (id, note.clone())).collect())).boxed(),
    ];
    if !rules.is_empty() {
        options.push(proptest::sample::select(rules).prop_map(Op::RemoveRule).boxed());
    }
    proptest::strategy::Union::new(options)
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 128, ..ProptestConfig::default() })]

    #[test]
    fn undo_restores_and_redo_repeats((event, ops) in library().prop_flat_map(|event| {
        let mut m = Model::new(Images::new(|| {}));
        m.event(event.clone());
        let ops = proptest::collection::vec(op(&m), 1..4);
        (Just(event), ops)
    })) {
        let mut m = Model::new(Images::new(|| {}));
        m.event(event);
        for op in ops {
            let before = visible(&m);
            m.act("change".into(), op);
            let after = visible(&m);
            m.undo();
            prop_assert_eq!(&visible(&m), &before);
            m.redo();
            prop_assert_eq!(&visible(&m), &after);
        }
    }
}

fn arrivals() -> impl Strategy<Value = Vec<Entry>> {
    proptest::collection::vec((0usize..2, -500i64..1500, proptest::sample::select(WORDS.to_vec())), 1..10).prop_map(|list| {
        list.into_iter()
            .enumerate()
            .map(|(i, (feed, published, word))| Entry {
                id: format!("f{feed}:new{i}"),
                feed_id: format!("f{feed}"),
                url: format!("https://new.example/{i}"),
                title: format!("{word} new {i}"),
                author: None,
                published,
                read: false,
                bookmarked: false,
                attachments: Vec::new(),
            })
            .collect()
    })
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 128, max_global_rejects: 100_000, ..ProptestConfig::default() })]

    #[test]
    fn nothing_moves_under_the_reader(event in library(), new in arrivals(), top in 0usize..20, marks in proptest::collection::vec(0usize..30, 0..5)) {
        let mut m = Model::new(Images::new(|| {}));
        m.event(event);
        m.show(View::Home);
        m.list.row_h = 1.0;
        m.list.view_h = 2.0;
        let rows = m.list.visible.len();
        prop_assume!(rows > 2);
        let top = top % (rows - 2);
        m.list.scroll = top as f32;
        let anchor = m.entries[m.list.visible[top]].id.clone();
        let read: Vec<(String, bool)> = marks.iter().filter_map(|&i| m.list.visible.get(i % rows).map(|&e| (m.entries[e].id.clone(), true))).collect();
        let listed: Vec<String> = m.list.visible.iter().map(|&i| m.entries[i].id.clone()).collect();
        m.act("read".into(), crate::model::Op::Read(read));
        m.rebuild();
        let still: Vec<String> = m.list.visible.iter().map(|&i| m.entries[i].id.clone()).collect();
        prop_assert_eq!(&listed, &still);
        let max = (m.list.visible.len() as f32 - m.list.view_h).max(0.0);
        prop_assume!(m.list.scroll < max);
        m.event(Event::EntriesAdded(new));
        let row = (m.list.scroll / m.list.row_h).floor() as usize;
        let now = m.list.visible.get(row).map(|&i| m.entries[i].id.clone());
        prop_assert_eq!(now, Some(anchor));
    }
}
