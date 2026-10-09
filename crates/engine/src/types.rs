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
    pub pinned: bool,
    pub hidden: bool,
    pub mode: Option<Mode>,
}

pub const SAVED: &str = "saved";

#[derive(Clone, Debug, PartialEq)]
pub struct Folder {
    pub id: String,
    pub name: String,
    pub feeds: Vec<FeedId>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Scope {
    All,
    Feed(FeedId),
    Folder(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Rule {
    pub id: String,
    pub word: String,
    pub scope: Scope,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Recommendation {
    pub entry: EntryId,
    pub note: String,
    pub at: i64,
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
    pub merge_duplicates: bool,
    pub public_port: u16,
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
            merge_duplicates: true,
            public_port: 8791,
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
    Image(String, String, Option<(u32, u32)>),
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

#[derive(Clone, Debug)]
pub struct Extracted {
    pub title: String,
    pub html: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Extractor {
    Defuddle,
    Readability,
}

impl Extractor {
    pub fn name(self) -> &'static str {
        match self {
            Self::Defuddle => "Defuddle",
            Self::Readability => "Readability",
        }
    }
}

#[derive(Debug)]
pub enum Request {
    UseWebExtractor,
    Media(Vec<String>),
    Extracted(u64, Result<Extracted, String>),
    Probe(String),
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
    SetFeedFolders(FeedId, Vec<String>),
    RenameFolder(String, String),
    DeleteFolder(String),
    RestoreFolder(Folder),
    SetPinned(FeedId, bool),
    SetHidden(FeedId, bool),
    SetFeedMode(FeedId, Option<Mode>),
    AddRule(Rule),
    RemoveRule(String),
    SaveLink(String),
    Recommend(EntryId, String),
    Unrecommend(EntryId),
    Search(String),
}

#[derive(Clone, Debug)]
pub enum Event {
    Snapshot {
        feeds: Vec<Feed>,
        entries: Vec<Entry>,
        settings: Settings,
        data_dir: String,
        folders: Vec<Folder>,
        rules: Vec<Rule>,
        recommendations: Vec<Recommendation>,
        public_url: Option<String>,
    },
    Folders(Vec<Folder>),
    Rules(Vec<Rule>),
    Recommendations(Vec<Recommendation>),
    PublicUrl(Option<String>),
    SearchResults(String, Vec<EntryId>),
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
    Extract { job: u64, url: String, html: String },
    Media(String, Result<std::path::PathBuf, String>),
    Probed(String, Result<(Extracted, Extractor), String>),
}
