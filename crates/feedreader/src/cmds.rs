use engine::{Mode, Request, Rule};
use toolkit::commands::{Chord, Command, Key, Registry};
use toolkit::field::Field;

use crate::model::{Confirm, Discovery, Focus, Model, Op, Page, Prompt, PromptKind, Row, Setting, Target, View};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Cmd {
    Home,
    Bookmarks,
    Feeds,
    Settings,
    Help,
    Refresh,
    Undo,
    Redo,
    Down,
    Up,
    PageDown,
    PageUp,
    First,
    Last,
    Select,
    Open,
    ToggleRead,
    Bookmark,
    Browser,
    CopyLink,
    UnreadAll,
    OpenAllUnread,
    MarkAllRead,
    Filter,
    FilterDone,
    FilterClear,
    Deselect,
    Close,
    Next,
    Previous,
    ScrollDown,
    ScrollUp,
    Clean,
    FeedMode,
    Original,
    AddFeed,
    RemoveFeed,
    Rename,
    Import,
    Export,
    Pick,
    CancelDiscovery,
    Edit,
    Yes,
    No,
    PromptOk,
    PromptCancel,
    Lines,
    ExtendDown,
    ExtendUp,
    Copy,
    More,
    Recommended,
    Recommend,
    CopyPublicLink,
    Mute,
    SaveLink,
    AddAsFeed,
    Pin,
    HideFromHome,
    FeedFolders,
    FeedReadingMode,
    RenameFolder,
    DeleteFolder,
    RemoveRule,
    Retry,
    Palette,
    PaletteDown,
    PaletteUp,
    PaletteRun,
    PaletteBack,
}

fn idle(m: &Model) -> bool {
    m.focus == Focus::Main && m.confirm.is_none()
}

fn listing(m: &Model) -> bool {
    idle(m) && m.page == Page::List && m.reader.is_none()
}

fn reading(m: &Model) -> bool {
    idle(m) && m.reader.is_some()
}

fn reading_entry(m: &Model) -> bool {
    reading(m) && matches!(m.reader.as_ref().map(|r| r.target()), Some(Target::Entry(_)))
}

fn feeds_page(m: &Model) -> bool {
    idle(m) && m.page == Page::Feeds && !matches!(m.discovery, Some(Discovery::Found(..)))
}

fn picking(m: &Model) -> bool {
    idle(m) && m.page == Page::Feeds && matches!(m.discovery, Some(Discovery::Found(..)))
}

fn scrollable(m: &Model) -> bool {
    idle(m) && m.reader.is_none() && (m.page != Page::List || !m.list.visible.is_empty())
}

fn entry_action(m: &Model) -> bool {
    idle(m) && m.current_entry().is_some() && (m.page == Page::List || m.reader.is_some())
}

fn reading_page(m: &Model) -> bool {
    reading(m) && m.reader.as_ref().is_some_and(|r| r.target().link().is_some())
}

fn current_feed(m: &Model) -> Option<&engine::Feed> {
    m.feeds_order.get(m.feeds_page.cursor).and_then(|&i| m.feeds.get(i))
}

fn feed_row(m: &Model) -> bool {
    feeds_page(m) && current_feed(m).is_some()
}

fn folder_view(m: &Model) -> bool {
    listing(m) && matches!(m.view, View::Folder(_))
}

fn rule_row(m: &Model) -> bool {
    idle(m) && m.page == Page::Settings && m.reader.is_none() && crate::model::settings_rows(m).get(m.settings_page.cursor).is_some_and(|r| matches!(r, crate::model::Row::Rule(_)))
}

fn plural(n: usize) -> String {
    if n == 1 { "1 entry".into() } else { format!("{n} entries") }
}

pub fn registry() -> Registry<Cmd, Model> {
    fn c(id: Cmd, keys: Vec<Chord>, label: fn(&Model) -> String, available: fn(&Model) -> bool) -> Command<Cmd, Model> {
        Command { id, keys, label, available, rank: rank(id) }
    }
    let k = Chord::key;
    let ch = Chord::ch;
    Registry {
        commands: vec![
            c(Cmd::PaletteRun, vec![k(Key::Enter)], |_| "run".into(), |m| m.focus == Focus::Palette),
            c(Cmd::PaletteDown, vec![k(Key::Down)], |_| "down".into(), |m| m.focus == Focus::Palette),
            c(Cmd::PaletteUp, vec![k(Key::Up)], |_| "up".into(), |m| m.focus == Focus::Palette),
            c(Cmd::PaletteBack, vec![k(Key::Escape)], |m| {
                if m.palette.as_ref().is_some_and(|p| !p.field.text.is_empty()) { "clear".into() } else { "close".into() }
            }, |m| m.focus == Focus::Palette),
            c(Cmd::Palette, vec![Chord::cmd('k')], |_| "search and commands".into(), |m| m.focus == Focus::Main && m.confirm.is_none()),
            c(Cmd::Yes, vec![ch('y')], |_| "yes".into(), |m| m.confirm.is_some()),
            c(Cmd::No, vec![ch('n'), k(Key::Escape)], |_| "no".into(), |m| m.confirm.is_some()),
            c(Cmd::PromptOk, vec![k(Key::Enter)], |m| match m.prompt.as_ref().map(|p| &p.kind) {
                Some(PromptKind::AddFeed) => "find feeds".into(),
                _ => "save".into(),
            }, |m| m.focus == Focus::Prompt),
            c(Cmd::PromptCancel, vec![k(Key::Escape)], |_| "cancel".into(), |m| m.focus == Focus::Prompt),
            c(Cmd::FilterDone, vec![k(Key::Enter)], |_| "done".into(), |m| m.focus == Focus::Filter),
            c(Cmd::FilterClear, vec![k(Key::Escape)], |_| "clear filter".into(), |m| m.focus == Focus::Filter),
            c(Cmd::Pick, vec![k(Key::Enter), ch('o')], |m| match &m.discovery {
                Some(Discovery::Found(_, c, i)) if c.get(*i).is_some_and(|c| c.subscribed) => "already subscribed".into(),
                _ => "subscribe".into(),
            }, picking),
            c(Cmd::CancelDiscovery, vec![k(Key::Escape)], |_| "cancel".into(), |m| {
                idle(m) && m.page == Page::Feeds && m.discovery.is_some()
            }),
            c(Cmd::Close, vec![k(Key::Escape), Chord::cmd('w')], |m| {
                if m.reader.as_ref().is_some_and(|r| r.history.len() > 1) { "back".into() } else { "close".into() }
            }, reading),
            c(Cmd::Deselect, vec![k(Key::Escape)], |m| format!("deselect {}", m.list.selected.len()), |m| {
                listing(m) && !m.list.selected.is_empty()
            }),
            c(Cmd::Next, vec![ch('j')], |_| "next".into(), reading_entry),
            c(Cmd::Previous, vec![ch('k')], |_| "previous".into(), reading_entry),
            c(Cmd::ScrollDown, vec![k(Key::Down), k(Key::PageDown)], |_| "scroll".into(), |m| {
                reading(m) && m.reader.as_ref().is_some_and(|r| matches!(r.target(), Target::Entry(_)) && r.mode != Mode::Original)
            }),
            c(Cmd::ScrollUp, vec![k(Key::Up), k(Key::PageUp)], |_| "scroll up".into(), |m| {
                reading(m) && m.reader.as_ref().is_some_and(|r| matches!(r.target(), Target::Entry(_)) && r.mode != Mode::Original)
            }),
            c(Cmd::Down, vec![ch('j'), k(Key::Down)], |_| "down".into(), |m| scrollable(m) || picking(m)),
            c(Cmd::Up, vec![ch('k'), k(Key::Up)], |_| "up".into(), |m| scrollable(m) || picking(m)),
            c(Cmd::PageDown, vec![k(Key::PageDown)], |_| "page down".into(), scrollable),
            c(Cmd::PageUp, vec![k(Key::PageUp)], |_| "page up".into(), scrollable),
            c(Cmd::First, vec![k(Key::Home)], |_| "top".into(), scrollable),
            c(Cmd::Last, vec![k(Key::End)], |_| "bottom".into(), scrollable),
            c(Cmd::Select, vec![ch('x')], |_| "select".into(), |m| listing(m) && !m.list.visible.is_empty()),
            c(Cmd::Open, vec![ch('o'), k(Key::Enter)], |m| {
                if m.list.selected.len() > 1 { format!("open {}", m.list.selected.len()) } else { "open".into() }
            }, |m| listing(m) && !m.list.visible.is_empty()),
            c(Cmd::ToggleRead, vec![ch('m')], |m| {
                let t = m.targets();
                let to = t.iter().any(|id| m.entry(id).is_some_and(|e| !e.read));
                let n = if t.len() > 1 { format!(" {}", t.len()) } else { String::new() };
                format!("mark{n} {}", if to { "read" } else { "unread" })
            }, entry_action),
            c(Cmd::Bookmark, vec![ch('s')], |m| {
                let t = m.targets();
                let to = t.iter().any(|id| m.entry(id).is_some_and(|e| !e.bookmarked));
                let n = if t.len() > 1 { format!(" {}", t.len()) } else { String::new() };
                format!("{}{n}", if to { "bookmark" } else { "unbookmark" })
            }, entry_action),
            c(Cmd::Clean, vec![], |m| mode_label(m, Mode::Clean), reading_entry),
            c(Cmd::FeedMode, vec![], |m| mode_label(m, Mode::Feed), reading_entry),
            c(Cmd::Original, vec![], |m| mode_label(m, Mode::Original), reading_entry),
            c(Cmd::Browser, vec![], |_| "open in browser".into(), |m| entry_action(m) || reading(m)),
            c(Cmd::CopyLink, vec![Chord::cmd_shift('c')], |_| "copy link".into(), |m| entry_action(m) || reading(m)),
            c(Cmd::UnreadAll, vec![ch('h'), ch('l')], |m| {
                if m.unread_only { "show all".into() } else { "show unread".into() }
            }, |m| listing(m) && m.view.filters_read()),
            c(Cmd::OpenAllUnread, vec![Chord { key: Key::Char('o'), cmd: false, shift: true }], |_| "open all unread".into(), |m| {
                listing(m) && m.list.selected.is_empty()
            }),
            c(Cmd::MarkAllRead, vec![], |_| "mark all read".into(), |m| listing(m) && m.list.selected.is_empty() && !m.list.visible.is_empty()),
            c(Cmd::Filter, vec![], |_| "filter".into(), listing),
            c(Cmd::AddFeed, vec![ch('a')], |_| "add feed".into(), feeds_page),
            c(Cmd::RemoveFeed, vec![ch('d')], |m| {
                if m.armed.is_some() { "press d again to remove".into() } else { "remove".into() }
            }, |m| feeds_page(m) && !m.feeds.is_empty()),
            c(Cmd::Rename, vec![], |_| "rename".into(), |m| feeds_page(m) && !m.feeds.is_empty()),
            c(Cmd::Import, vec![ch('i')], |_| "import OPML".into(), feeds_page),
            c(Cmd::Export, vec![ch('e')], |_| "export OPML".into(), feeds_page),
            c(Cmd::Open, vec![ch('o'), k(Key::Enter)], |_| "show entries".into(), |m| feeds_page(m) && !m.feeds.is_empty()),
            c(Cmd::Edit, vec![k(Key::Enter), ch('o')], |m| match crate::model::settings_rows(m).get(m.settings_page.cursor) {
                Some(crate::model::Row::Setting(Setting::ReadingMode | Setting::Lines | Setting::MergeDuplicates)) => "change".into(),
                _ => "edit".into(),
            }, |m| idle(m) && m.page == Page::Settings && !rule_row(m)),
            c(Cmd::Refresh, vec![ch('r')], |m| if m.refresh.running { "refreshing".into() } else { "refresh".into() }, |m| idle(m) && m.reader.is_none()),
            c(Cmd::Copy, vec![Chord::cmd('c')], |_| "copy".into(), |m| {
                m.reader.as_ref().is_some_and(|r| r.ordered().is_some())
            }),
            c(Cmd::ExtendDown, vec![Chord { key: Key::Char('j'), cmd: false, shift: true }, Chord { key: Key::Down, cmd: false, shift: true }], |_| "extend selection down".into(), |m| listing(m) && !m.list.visible.is_empty()),
            c(Cmd::ExtendUp, vec![Chord { key: Key::Char('k'), cmd: false, shift: true }, Chord { key: Key::Up, cmd: false, shift: true }], |_| "extend selection up".into(), |m| listing(m) && !m.list.visible.is_empty()),
            c(Cmd::Recommend, vec![], |m| {
                let t = m.targets();
                let all = !t.is_empty() && t.iter().all(|id| m.recommended.contains_key(id));
                let n = if t.len() > 1 { format!(" {}", t.len()) } else { String::new() };
                format!("{}{n}", if all { "unrecommend" } else { "recommend" })
            }, entry_action),
            c(Cmd::Mute, vec![], |_| "mute word".into(), |m| entry_action(m) || (idle(m) && m.page == Page::Settings)),
            c(Cmd::SaveLink, vec![], |m| if reading_page(m) { "bookmark".into() } else { "save link".into() }, |m| {
                (listing(m) || feeds_page(m)) || reading_page(m)
            }),
            c(Cmd::AddAsFeed, vec![], |_| "add as feed".into(), reading_page),
            c(Cmd::CopyPublicLink, vec![], |_| "copy public link".into(), |m| {
                listing(m) && m.view == View::Recommended && m.public_url.is_some()
            }),
            c(Cmd::Pin, vec![], |m| if current_feed(m).is_some_and(|f| f.pinned) { "unpin".into() } else { "pin".into() }, feed_row),
            c(Cmd::HideFromHome, vec![], |m| {
                if current_feed(m).is_some_and(|f| f.hidden) { "show on home".into() } else { "hide from home".into() }
            }, feed_row),
            c(Cmd::FeedFolders, vec![], |_| "folders".into(), feed_row),
            c(Cmd::FeedReadingMode, vec![], |m| {
                let mode = current_feed(m).and_then(|f| f.mode).map(|m| m.name()).unwrap_or("default");
                format!("opens in: {mode}")
            }, feed_row),
            c(Cmd::Retry, vec![], |_| "retry".into(), |m| feed_row(m) && current_feed(m).is_some_and(|f| f.error.is_some())),
            c(Cmd::RenameFolder, vec![], |_| "rename folder".into(), folder_view),
            c(Cmd::DeleteFolder, vec![], |_| "delete folder".into(), folder_view),
            c(Cmd::RemoveRule, vec![ch('d')], |_| "remove rule".into(), rule_row),
            c(Cmd::Recommended, vec![], |_| "i recommend".into(), |_| false),
            c(Cmd::Home, vec![ch('1')], |_| "home".into(), idle),
            c(Cmd::Bookmarks, vec![ch('2')], |_| "bookmarks".into(), idle),
            c(Cmd::Feeds, vec![ch('3')], |_| "feeds".into(), idle),
            c(Cmd::Settings, vec![ch('4')], |_| "settings".into(), idle),
            c(Cmd::Help, vec![ch('?')], |m| if m.page == Page::Help && m.reader.is_none() { "close help".into() } else { "help".into() }, idle),
            c(Cmd::Undo, vec![Chord::cmd('z')], |_| "undo".into(), |m| m.can_undo() && m.focus == Focus::Main),
            c(Cmd::Redo, vec![Chord::cmd_shift('z')], |_| "redo".into(), |m| m.can_redo() && m.focus == Focus::Main),
            c(Cmd::Lines, vec![], |m| format!("lines: {}", m.lines.name()), |_| false),
            c(Cmd::More, vec![], |m| if m.bar_expanded { "less".into() } else { "more".into() }, |m| m.focus == Focus::Main && m.confirm.is_none()),
        ],
    }
}

fn rank(cmd: Cmd) -> u8 {
    match cmd {
        Cmd::Yes
        | Cmd::No
        | Cmd::PromptOk
        | Cmd::PromptCancel
        | Cmd::FilterDone
        | Cmd::FilterClear
        | Cmd::Pick
        | Cmd::CancelDiscovery
        | Cmd::Close
        | Cmd::Open
        | Cmd::ToggleRead
        | Cmd::Bookmark
        | Cmd::Deselect
        | Cmd::AddFeed
        | Cmd::RemoveFeed
        | Cmd::Edit
        | Cmd::Clean
        | Cmd::FeedMode
        | Cmd::Original
        | Cmd::Copy
        | Cmd::Select
        | Cmd::Recommend
        | Cmd::AddAsFeed
        | Cmd::RemoveRule
        | Cmd::PaletteRun
        | Cmd::PaletteBack
        | Cmd::More => 0,
        Cmd::PageDown
        | Cmd::PageUp
        | Cmd::First
        | Cmd::Last
        | Cmd::ScrollUp
        | Cmd::ScrollDown
        | Cmd::Home
        | Cmd::Bookmarks
        | Cmd::Feeds
        | Cmd::Settings
        | Cmd::Lines
        | Cmd::ExtendDown
        | Cmd::ExtendUp
        | Cmd::Down
        | Cmd::Up
        | Cmd::Next
        | Cmd::Previous => 2,
        _ => 1,
    }
}

fn mode_label(m: &Model, mode: Mode) -> String {
    let current = m.reader.as_ref().map(|r| r.mode) == Some(mode);
    format!("{} {}", if current { "\u{25CF}" } else { "\u{25CB}" }, mode.name())
}

fn prompt(m: &mut Model, kind: PromptKind, label: &str, value: &str) {
    m.prompt = Some(Prompt {
        kind,
        label: label.into(),
        field: Field::with(value),
        error: None,
    });
    m.focus = Focus::Prompt;
}

fn downloads(name: &str) -> String {
    dirs_home()
        .map(|h| format!("{h}/Downloads/{name}"))
        .unwrap_or_else(|| name.to_string())
}

fn dirs_home() -> Option<String> {
    std::env::var("HOME").ok()
}

pub fn expand(path: &str) -> std::path::PathBuf {
    let path = path.trim();
    match (path.strip_prefix("~/"), dirs_home()) {
        (Some(rest), Some(home)) => std::path::PathBuf::from(home).join(rest),
        _ => std::path::PathBuf::from(path),
    }
}

fn open_targets(m: &mut Model, ids: Vec<String>) {
    let mut urls = Vec::new();
    let mut read = Vec::new();
    for id in ids {
        if let Some(e) = m.entry(&id)
            && !e.url.is_empty()
        {
            urls.push(e.url.clone());
            read.push((id, true));
        }
    }
    let n = urls.len();
    m.open.extend(urls);
    if n > 0 {
        m.act(format!("Opened {} in the browser and marked read", plural(n)), Op::Read(read));
    } else {
        m.message = Some("No links to open.".into());
    }
}

pub fn exec(m: &mut Model, cmd: Cmd) {
    if m.armed.is_some() && cmd != Cmd::RemoveFeed {
        m.armed = None;
    }
    let page_rows = |view_h: f32, row_h: f32| (view_h / row_h).floor().max(1.0) as usize;
    match cmd {
        Cmd::Home => m.show(View::Home),
        Cmd::Bookmarks => m.show(View::Bookmarks),
        Cmd::Feeds => m.go(Page::Feeds),
        Cmd::Settings => m.go(Page::Settings),
        Cmd::Help => {
            let page = if m.page == Page::Help { Page::List } else { Page::Help };
            m.go(page);
        }
        Cmd::Refresh => {
            if m.refresh.running {
                m.message = Some("Already refreshing.".into());
            } else {
                m.out.push(Request::Refresh);
            }
        }
        Cmd::Undo => m.undo(),
        Cmd::Redo => m.redo(),
        Cmd::Down | Cmd::Up | Cmd::PageDown | Cmd::PageUp | Cmd::First | Cmd::Last => {
            if let Some(Discovery::Found(_, c, i)) = &mut m.discovery {
                match cmd {
                    Cmd::Down => *i = (*i + 1).min(c.len().saturating_sub(1)),
                    Cmd::Up => *i = i.saturating_sub(1),
                    _ => {}
                }
                return;
            }
            let (len, s) = match m.page {
                Page::List => {
                    let len = m.list.visible.len();
                    let rows = page_rows(m.list.view_h, m.list.row_h);
                    m.list.cursor = step(m.list.cursor, len, rows, cmd);
                    m.list.reveal_cursor();
                    return;
                }
                Page::Feeds => (m.feeds_order.len(), &mut m.feeds_page),
                Page::Settings => (crate::model::settings_rows(m).len(), &mut m.settings_page),
                Page::Help => (registry().commands.len() + 8, &mut m.help),
            };
            let rows = page_rows(s.view_h, s.row_h);
            s.cursor = step(s.cursor, len, rows, cmd);
            s.reveal(len);
        }
        Cmd::Select => {
            if let Some(&i) = m.list.visible.get(m.list.cursor) {
                let id = m.entries[i].id.clone();
                m.list.anchor = Some(m.list.cursor);
                if !m.list.selected.remove(&id) {
                    m.list.selected.insert(id);
                }
                m.list.cursor = (m.list.cursor + 1).min(m.list.visible.len().saturating_sub(1));
                m.list.reveal_cursor();
            }
        }
        Cmd::Open => match m.page {
            Page::Feeds => {
                if let Some(&i) = m.feeds_order.get(m.feeds_page.cursor) {
                    let id = m.feeds[i].id.clone();
                    m.show(View::Feed(id));
                }
            }
            _ => {
                let targets = m.targets();
                if targets.len() > 1 {
                    m.list.selected.clear();
                    let first = targets[0].clone();
                    let rest: Vec<_> = targets[1..].iter().map(|id| (id.clone(), true)).collect();
                    m.open_entry(first, None);
                    m.act(format!("Marked {} more read", plural(rest.len())), Op::Read(rest));
                } else if let Some(id) = targets.into_iter().next() {
                    m.open_entry(id, None);
                }
            }
        },
        Cmd::ToggleRead => {
            let t = m.targets();
            let to = t.iter().any(|id| m.entry(id).is_some_and(|e| !e.read));
            let what = if to { "read" } else { "unread" };
            let n = t.len();
            m.act(format!("Marked {} {what}", plural(n)), Op::Read(t.into_iter().map(|id| (id, to)).collect()));
        }
        Cmd::Bookmark => {
            let t = m.targets();
            let to = t.iter().any(|id| m.entry(id).is_some_and(|e| !e.bookmarked));
            let n = t.len();
            let what = if to { "Bookmarked" } else { "Removed the bookmark from" };
            m.act(format!("{what} {}", plural(n)), Op::Bookmark(t.into_iter().map(|id| (id, to)).collect()));
        }
        Cmd::Browser => {
            if let Some(url) = m.reader.as_ref().and_then(|r| r.target().link().map(str::to_string)) {
                m.open.push(url);
            } else {
                let t = m.targets();
                open_targets(m, t);
            }
        }
        Cmd::CopyLink => {
            let url = match m.reader.as_ref().map(|r| r.target().clone()) {
                Some(Target::Page(u) | Target::Play(u, _)) => Some(u),
                _ => m.current_entry().map(|e| e.url.clone()),
            };
            if let Some(u) = url.filter(|u| !u.is_empty()) {
                m.message = Some(format!("Copied {u}"));
                m.copy = Some(u);
            }
        }
        Cmd::UnreadAll => {
            m.unread_only = !m.unread_only;
            m.reset_list();
        }
        Cmd::OpenAllUnread => {
            let ids: Vec<String> = m
                .list
                .visible
                .iter()
                .map(|&i| &m.entries[i])
                .filter(|e| !e.read && !e.url.is_empty())
                .map(|e| e.id.clone())
                .collect();
            if ids.is_empty() {
                m.message = Some("No unread entries here.".into());
            } else if ids.len() > m.settings.confirm_open_over as usize {
                m.confirm = Some(Confirm::OpenAll(ids));
            } else {
                open_targets(m, ids);
            }
        }
        Cmd::MarkAllRead => {
            let list: Vec<_> = m
                .list
                .visible
                .iter()
                .map(|&i| &m.entries[i])
                .filter(|e| !e.read)
                .map(|e| (e.id.clone(), true))
                .collect();
            if list.is_empty() {
                m.message = Some("Everything here is already read.".into());
            } else {
                let label = format!("Marked {} read in {}", plural(list.len()), m.view_name());
                m.act(label, Op::Read(list));
            }
        }
        Cmd::Filter => {
            m.focus = Focus::Filter;
            m.filter.end();
        }
        Cmd::FilterDone => m.focus = Focus::Main,
        Cmd::FilterClear => {
            m.filter.clear();
            m.focus = Focus::Main;
            m.reset_list();
        }
        Cmd::Deselect => {
            m.list.selected.clear();
            m.list.anchor = None;
        }
        Cmd::Close => m.back(),
        Cmd::Next => m.step_entry(true),
        Cmd::Previous => m.step_entry(false),
        Cmd::ScrollDown | Cmd::ScrollUp => {
            if let Some(r) = &mut m.reader {
                let dy = r.view_h * 0.8;
                r.scroll += if cmd == Cmd::ScrollDown { dy } else { -dy };
                r.scroll = r.scroll.clamp(0.0, (r.content_h - r.view_h).max(0.0));
            }
        }
        Cmd::Clean => m.set_mode(Mode::Clean),
        Cmd::FeedMode => m.set_mode(Mode::Feed),
        Cmd::Original => m.set_mode(Mode::Original),
        Cmd::AddFeed => prompt(m, PromptKind::AddFeed, "Feed or site address", ""),
        Cmd::RemoveFeed => {
            let Some(&i) = m.feeds_order.get(m.feeds_page.cursor) else { return };
            let id = m.feeds[i].id.clone();
            if m.armed.as_ref() == Some(&id) {
                m.armed = None;
                let name = m.feeds[i].name().to_string();
                m.act(format!("Removed {name}"), Op::RemoveFeed(id));
            } else {
                m.message = Some(format!("Press d again to remove {} and its entries.", m.feeds[i].name()));
                m.armed = Some(id);
            }
        }
        Cmd::Rename => {
            if let Some(&i) = m.feeds_order.get(m.feeds_page.cursor) {
                let f = m.feeds[i].clone();
                prompt(m, PromptKind::Rename(f.id.clone()), "New name (empty uses the feed's own title)", f.name());
            }
        }
        Cmd::Import => prompt(m, PromptKind::ImportOpml, "Import OPML from", &downloads("")),
        Cmd::Export => {
            let name = format!("feedreader-{}.opml", chrono::Local::now().format("%Y-%m-%d"));
            prompt(m, PromptKind::ExportOpml, "Export OPML to", &downloads(&name));
        }
        Cmd::Pick => {
            if let Some(Discovery::Found(_, c, i)) = &m.discovery
                && let Some(cand) = c.get(*i)
            {
                if cand.subscribed {
                    m.message = Some(format!("You already follow {}.", cand.title));
                } else {
                    m.out.push(Request::AddFeed(cand.url.clone(), cand.title.clone()));
                    m.message = Some(format!("Adding {}\u{2026}", cand.title));
                    m.discovery = None;
                }
            }
        }
        Cmd::CancelDiscovery => m.discovery = None,
        Cmd::Edit => edit_setting(m),
        Cmd::Yes => {
            if let Some(Confirm::OpenAll(ids)) = m.confirm.take() {
                open_targets(m, ids);
            }
        }
        Cmd::No => m.confirm = None,
        Cmd::PromptOk => submit(m),
        Cmd::PromptCancel => {
            m.prompt = None;
            m.focus = Focus::Main;
        }
        Cmd::ExtendDown => m.extend(true),
        Cmd::ExtendUp => m.extend(false),
        Cmd::Copy => {
            if let Some(t) = m.reader.as_ref().and_then(|r| r.selected_text()) {
                m.message = Some(format!("Copied {} characters.", t.chars().count()));
                m.copy = Some(t);
            }
        }
        Cmd::More => m.bar_expanded = !m.bar_expanded,
        Cmd::Recommended => m.show(View::Recommended),
        Cmd::Palette => crate::palette::open(m),
        Cmd::PaletteDown | Cmd::PaletteUp => {
            if let Some(p) = m.palette.as_mut() {
                let last = p.items.len().saturating_sub(1);
                p.cursor = if cmd == Cmd::PaletteDown { (p.cursor + 1).min(last) } else { p.cursor.saturating_sub(1) };
                p.reveal();
            }
        }
        Cmd::PaletteRun => {
            let i = m.palette.as_ref().map(|p| p.cursor).unwrap_or(0);
            crate::palette::activate(m, i);
        }
        Cmd::PaletteBack => {
            if let Some(p) = m.palette.as_mut()
                && !p.field.text.is_empty()
            {
                p.field.clear();
                p.cursor = 0;
                crate::palette::refresh(m);
            } else {
                crate::palette::close(m);
            }
        }
        Cmd::Recommend => {
            let t = m.targets();
            if t.is_empty() {
                return;
            }
            if t.iter().all(|id| m.recommended.contains_key(id)) {
                let n = t.len();
                m.act(format!("Removed {} from I recommend", plural(n)), Op::Recommend(t.into_iter().map(|id| (id, None)).collect()));
            } else {
                let label = if t.len() == 1 { "Note for your friends (optional, up to 280 words)" } else { "Note for these entries (optional, up to 280 words)" };
                prompt(m, PromptKind::Recommend(t), label, "");
            }
        }
        Cmd::CopyPublicLink => {
            if let Some(u) = m.public_url.clone() {
                m.message = Some(format!("Copied {u}"));
                m.copy = Some(u);
            }
        }
        Cmd::Mute => {
            let hint = m.current_entry().filter(|_| m.page != Page::Settings).map(|e| format!(" from:{}", m.feed_name(&e.feed_id))).unwrap_or_default();
            prompt(m, PromptKind::Mute, "Mute a word or phrase (add in:folder or from:feed to narrow it)", &hint);
            if let Some(p) = m.prompt.as_mut() {
                p.field.home();
            }
        }
        Cmd::SaveLink => {
            if let Some(url) = m.reader.as_ref().and_then(|r| r.target().link().map(str::to_string)) {
                m.out.push(Request::SaveLink(url.clone()));
                m.message = Some(format!("Saving {url}\u{2026}"));
            } else {
                prompt(m, PromptKind::SaveLink, "Page address to keep in Bookmarks", "");
            }
        }
        Cmd::AddAsFeed => {
            if let Some(url) = m.reader.as_ref().and_then(|r| r.target().link().map(str::to_string)) {
                m.go(Page::Feeds);
                m.discovery = Some(Discovery::Searching(url.clone()));
                m.out.push(Request::Discover(url));
            }
        }
        Cmd::Pin => {
            if let Some(f) = current_feed(m).cloned() {
                let label = format!("{} {}", if f.pinned { "Unpinned" } else { "Pinned" }, f.name());
                m.act(label, Op::Pin(f.id, !f.pinned));
            }
        }
        Cmd::HideFromHome => {
            if let Some(f) = current_feed(m).cloned() {
                let label = if f.hidden { format!("{} shows on Home again", f.name()) } else { format!("{} no longer shows on Home", f.name()) };
                m.act(label, Op::Hide(f.id, !f.hidden));
            }
        }
        Cmd::FeedFolders => {
            if let Some(f) = current_feed(m).cloned() {
                let names: Vec<String> = m.folders_of(&f.id).iter().map(|x| x.name.clone()).collect();
                prompt(m, PromptKind::Folders(f.id), "Folders, separated by commas", &names.join(", "));
            }
        }
        Cmd::FeedReadingMode => {
            if let Some(f) = current_feed(m).cloned() {
                let next = match f.mode {
                    None => Some(Mode::Clean),
                    Some(Mode::Clean) => Some(Mode::Feed),
                    Some(Mode::Feed) => Some(Mode::Original),
                    Some(Mode::Original) => None,
                };
                let what = next.map(|n| format!("in {} mode", n.name())).unwrap_or_else(|| "in the default mode".into());
                m.act(format!("{} opens {what}", f.name()), Op::FeedMode(f.id, next));
            }
        }
        Cmd::Retry => m.out.push(Request::Refresh),
        Cmd::RenameFolder => {
            if let View::Folder(id) = m.view.clone()
                && let Some(f) = m.folder(&id).cloned()
            {
                prompt(m, PromptKind::RenameFolder(id), "New folder name", &f.name);
            }
        }
        Cmd::DeleteFolder => {
            if let View::Folder(id) = m.view.clone()
                && let Some(f) = m.folder(&id).cloned()
            {
                m.act(format!("Deleted the folder {}; its feeds stay", f.name), Op::DeleteFolder(f));
            }
        }
        Cmd::RemoveRule => {
            if let Some(Row::Rule(i)) = crate::model::settings_rows(m).get(m.settings_page.cursor).cloned()
                && let Some(r) = m.rules.get(i).cloned()
            {
                m.act(format!("Unmuted \u{201C}{}\u{201D}", r.word), Op::RemoveRule(r));
            }
        }
        Cmd::Lines => {
            let mut s = m.settings.clone();
            s.lines = m.lines.next().name().to_string();
            let label = format!("Changed lines to {}", s.lines);
            m.act(label, Op::Settings(s));
        }
    }
}

fn step(cursor: usize, len: usize, page: usize, cmd: Cmd) -> usize {
    let last = len.saturating_sub(1);
    match cmd {
        Cmd::Down => (cursor + 1).min(last),
        Cmd::Up => cursor.saturating_sub(1),
        Cmd::PageDown => (cursor + page).min(last),
        Cmd::PageUp => cursor.saturating_sub(page),
        Cmd::First => 0,
        Cmd::Last => last,
        _ => cursor,
    }
}

fn edit_setting(m: &mut Model) {
    let Some(Row::Setting(setting)) = crate::model::settings_rows(m).get(m.settings_page.cursor).cloned() else { return };
    let s = m.settings.clone();
    match setting {
        Setting::MergeDuplicates => {
            let mut n = s.clone();
            n.merge_duplicates = !s.merge_duplicates;
            let label = if n.merge_duplicates { "Showing each link once" } else { "Showing duplicate links from every feed" };
            m.act(label.into(), Op::Settings(n));
        }
        Setting::Mute => exec(m, Cmd::Mute),
        Setting::PublicLink => match m.public_url.clone() {
            Some(u) => {
                m.message = Some(format!("Copied {u}"));
                m.copy = Some(u);
            }
            None => m.message = Some("The public listener isn't running; another program may be using its port.".into()),
        },
        Setting::ReadingMode => {
            let mut n = s.clone();
            n.reading_mode = match s.reading_mode {
                Mode::Clean => Mode::Feed,
                Mode::Feed => Mode::Original,
                Mode::Original => Mode::Clean,
            };
            let label = format!("Entries open in {} mode", n.reading_mode.name());
            m.act(label, Op::Settings(n));
        }
        Setting::Lines => exec(m, Cmd::Lines),
        Setting::MaxEntries => prompt(m, PromptKind::Setting(setting), "Keep at most this many entries", &s.max_entries.to_string()),
        Setting::MaxAge => prompt(
            m,
            PromptKind::Setting(setting),
            "Delete read entries older than this many days (empty keeps them)",
            &s.max_age_days.map(|d| d.to_string()).unwrap_or_default(),
        ),
        Setting::RefreshMinutes => prompt(m, PromptKind::Setting(setting), "Refresh every this many minutes", &s.refresh_minutes.to_string()),
        Setting::ConfirmOver => prompt(
            m,
            PromptKind::Setting(setting),
            "Ask before opening more than this many entries",
            &s.confirm_open_over.to_string(),
        ),
        Setting::ImportLegacy => prompt(m, PromptKind::ImportLegacy, "Path to the current app's feedreader.sqlite", ""),
    }
}

fn submit(m: &mut Model) {
    let Some(p) = m.prompt.as_mut() else { return };
    let value = p.field.text.trim().to_string();
    let kind = p.kind.clone();
    let fail = |m: &mut Model, e: &str| {
        if let Some(p) = m.prompt.as_mut() {
            p.error = Some(e.to_string());
        }
    };
    let number = |v: &str, lo: u32, hi: u32| -> Result<u32, String> {
        v.parse::<u32>()
            .ok()
            .filter(|n| (lo..=hi).contains(n))
            .ok_or_else(|| format!("Enter a whole number from {lo} to {hi}"))
    };
    match kind {
        PromptKind::AddFeed => {
            if value.is_empty() {
                return fail(m, "Type a feed or site address");
            }
            m.discovery = Some(Discovery::Searching(value.clone()));
            m.out.push(Request::Discover(value));
        }
        PromptKind::SaveLink => {
            if value.is_empty() {
                return fail(m, "Type a page address");
            }
            if let Err(e) = engine::check_input(&value) {
                return fail(m, &e);
            }
            m.out.push(Request::SaveLink(value.clone()));
            m.message = Some(format!("Saving {value}\u{2026}"));
        }
        PromptKind::Folders(id) => {
            let names: Vec<String> = value.split(',').map(|n| n.trim().to_string()).filter(|n| !n.is_empty()).collect();
            let name = m.feed_name(&id).to_string();
            let label = if names.is_empty() { format!("Took {name} out of every folder") } else { format!("Put {name} in {}", names.join(", ")) };
            m.act(label, Op::Folders(id, names));
        }
        PromptKind::RenameFolder(id) => {
            if value.is_empty() {
                return fail(m, "Type a name");
            }
            if m.folders.iter().any(|f| f.id != id && f.name.eq_ignore_ascii_case(&value)) {
                return fail(m, "Another folder already has that name");
            }
            m.act(format!("Renamed the folder to {value}"), Op::RenameFolder(id, value));
        }
        PromptKind::Mute => {
            let feeds: Vec<(String, String)> = m.subscriptions().map(|f| (f.id.clone(), f.name().to_string())).collect();
            let folders: Vec<(String, String)> = m.folders.iter().map(|f| (f.id.clone(), f.name.clone())).collect();
            match engine::rules::parse_rule(&value, &feeds, &folders) {
                Ok((word, scope)) => {
                    let id = format!("{:x}", engine::now());
                    let place = match &scope {
                        engine::Scope::All => String::new(),
                        engine::Scope::Feed(f) => format!(" in {}", m.feed_name(f)),
                        engine::Scope::Folder(f) => format!(" in the folder {}", m.folder(f).map(|x| x.name.as_str()).unwrap_or("")),
                    };
                    m.act(format!("Muted \u{201C}{word}\u{201D}{place}"), Op::AddRule(Rule { id, word, scope }));
                }
                Err(e) => return fail(m, &e),
            }
        }
        PromptKind::Recommend(ids) => {
            let words = value.split_whitespace().count();
            if words > 280 {
                return fail(m, &format!("That's {words} words; keep it to 280"));
            }
            let n = ids.len();
            let label = if n == 1 {
                format!("Recommended \u{201C}{}\u{201D}", m.entry(&ids[0]).map(|e| e.title.as_str()).unwrap_or(""))
            } else {
                format!("Recommended {}", plural(n))
            };
            m.act(label, Op::Recommend(ids.into_iter().map(|id| (id, Some(value.clone()))).collect()));
        }
        PromptKind::Rename(id) => {
            let label = if value.is_empty() || m.feed(&id).is_some_and(|f| f.title == value) { None } else { Some(value) };
            let name = m.feed_name(&id).to_string();
            m.act(format!("Renamed {name}"), Op::Rename(id, label));
        }
        PromptKind::ImportOpml => {
            let path = expand(&value);
            if !path.is_file() {
                return fail(m, "No file there");
            }
            m.out.push(Request::ImportOpml(path));
            m.message = Some("Importing\u{2026}".into());
        }
        PromptKind::ExportOpml => {
            let path = expand(&value);
            if path.is_dir() {
                return fail(m, "That's a folder; add a file name");
            }
            m.out.push(Request::ExportOpml(path));
        }
        PromptKind::ImportLegacy => {
            let path = expand(&value);
            if !path.is_file() {
                return fail(m, "No file there");
            }
            m.out.push(Request::ImportLegacy(path));
            m.message = Some("Importing\u{2026}".into());
        }
        PromptKind::Setting(setting) => {
            let mut s = m.settings.clone();
            let label = match setting {
                Setting::MaxEntries => match number(&value, 100, 100_000) {
                    Ok(n) => {
                        s.max_entries = n;
                        format!("Keeping at most {n} entries")
                    }
                    Err(e) => return fail(m, &e),
                },
                Setting::MaxAge => {
                    if value.is_empty() {
                        s.max_age_days = None;
                        "Keeping entries regardless of age".to_string()
                    } else {
                        match number(&value, 1, 36_500) {
                            Ok(n) => {
                                s.max_age_days = Some(n);
                                format!("Deleting entries older than {n} days")
                            }
                            Err(e) => return fail(m, &e),
                        }
                    }
                }
                Setting::RefreshMinutes => match number(&value, 5, 1440) {
                    Ok(n) => {
                        s.refresh_minutes = n;
                        format!("Refreshing every {n} minutes")
                    }
                    Err(e) => return fail(m, &e),
                },
                Setting::ConfirmOver => match number(&value, 1, 1000) {
                    Ok(n) => {
                        s.confirm_open_over = n;
                        format!("Asking before opening more than {n} entries")
                    }
                    Err(e) => return fail(m, &e),
                },
                _ => return,
            };
            m.act(label, Op::Settings(s));
        }
    }
    m.prompt = None;
    m.focus = Focus::Main;
}
