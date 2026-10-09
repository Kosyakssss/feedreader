pub type FeedId = String;
pub type EntryId = String;

#[derive(Clone, Debug)]
pub struct Feed {
    pub id: FeedId,
    pub url: String,
    pub title: String,
    pub label: Option<String>,
    pub site_url: Option<String>,
    pub position: i64,
    pub last_fetched: Option<i64>,
    pub error: Option<String>,
}

impl Feed {
    pub fn name(&self) -> &str {
        match &self.label {
            Some(l) if !l.is_empty() => l,
            _ if !self.title.is_empty() => &self.title,
            _ => &self.url,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Entry {
    pub id: EntryId,
    pub feed_id: FeedId,
    pub url: String,
    pub title: String,
    pub author: Option<String>,
    pub published: i64,
    pub read: bool,
    pub bookmarked: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Clean,
    Feed,
    Original,
}

impl Mode {
    pub fn name(self) -> &'static str {
        match self {
            Self::Clean => "clean",
            Self::Feed => "feed",
            Self::Original => "original",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "clean" => Some(Self::Clean),
            "feed" => Some(Self::Feed),
            "original" => Some(Self::Original),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Settings {
    pub max_entries: u32,
    pub max_age_days: Option<u32>,
    pub refresh_minutes: u32,
    pub confirm_open_over: u32,
    pub reading_mode: Mode,
    pub lines: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            max_entries: 3000,
            max_age_days: None,
            refresh_minutes: 5,
            confirm_open_over: 20,
            reading_mode: Mode::Clean,
            lines: "light".into(),
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct RefreshStatus {
    pub run: u64,
    pub running: bool,
    pub total: usize,
    pub completed: usize,
    pub failed: usize,
    pub added: usize,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub next_at: Option<i64>,
}

#[derive(Clone, Debug)]
pub struct Candidate {
    pub url: String,
    pub title: String,
    pub kind: String,
    pub entries: usize,
    pub latest: Option<i64>,
    pub subscribed: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Inline {
    Text(String),
    Bold(String),
    Italic(String),
    Code(String),
    Link(String, String),
    Break,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Block {
    Heading(u8, Vec<Inline>),
    Paragraph(Vec<Inline>),
    Quote(Vec<Inline>),
    Item(u8, Option<u32>, Vec<Inline>),
    Code(String),
    Image(String, String),
    Media(String, String),
    Rule,
}

#[derive(Clone, Debug)]
pub struct Body {
    pub entry: EntryId,
    pub mode: Mode,
    pub blocks: Result<Vec<Block>, String>,
    pub note: Option<String>,
}

#[derive(Debug)]
pub enum Request {
    SetRead(Vec<EntryId>, bool),
    SetBookmarked(Vec<EntryId>, bool),
    Refresh,
    Discover(String),
    AddFeed(String, String),
    RemoveFeed(FeedId),
    RestoreFeed(FeedId),
    RenameFeed(FeedId, Option<String>),
    ImportOpml(std::path::PathBuf),
    ExportOpml(std::path::PathBuf),
    ImportLegacy(std::path::PathBuf),
    LoadBody(EntryId, Mode),
    SetSettings(Settings),
}

#[derive(Clone, Debug)]
pub enum Event {
    Snapshot {
        feeds: Vec<Feed>,
        entries: Vec<Entry>,
        settings: Settings,
        data_dir: String,
    },
    Feeds(Vec<Feed>),
    EntriesAdded(Vec<Entry>),
    EntriesUpdated(Vec<(EntryId, String, i64)>),
    EntriesRemoved(Vec<EntryId>),
    Refresh(RefreshStatus),
    Discovered(String, Result<Vec<Candidate>, String>),
    FeedAdded(Result<(Feed, usize), String>),
    Body(Body),
    Settings(Settings),
    Message(String),
}
