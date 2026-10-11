pub type FeedId = String;
pub type EntryId = String;

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
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

pub type Client = u64;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Audience {
    All,
    Client(Client),
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Folder {
    pub id: String,
    pub name: String,
    pub feeds: Vec<FeedId>,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum Scope {
    All,
    Feed(FeedId),
    Folder(String),
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Rule {
    pub id: String,
    pub word: String,
    pub scope: Scope,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
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

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Attachment {
    pub url: String,
    pub kind: String,
    pub bytes: Option<u64>,
    pub seconds: Option<u64>,
}

impl Attachment {
    pub fn class(&self) -> &'static str {
        if self.kind.starts_with("audio/") {
            "audio"
        } else if self.kind.starts_with("video/") {
            "video"
        } else {
            "file"
        }
    }
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct Entry {
    pub id: EntryId,
    pub feed_id: FeedId,
    pub url: String,
    pub title: String,
    pub author: Option<String>,
    pub published: i64,
    pub read: bool,
    pub bookmarked: bool,
    #[serde(default)]
    pub attachments: Vec<Attachment>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
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

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Lines {
    Ascii,
    #[default]
    Light,
    Heavy,
    Double,
    Dotted,
}

impl Lines {
    pub const ALL: [Self; 5] = [Self::Ascii, Self::Light, Self::Heavy, Self::Double, Self::Dotted];

    pub fn name(self) -> &'static str {
        match self {
            Self::Ascii => "ascii",
            Self::Light => "light",
            Self::Heavy => "heavy",
            Self::Double => "double",
            Self::Dotted => "dotted",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|l| l.name() == s)
    }

    pub fn next(self) -> Self {
        let i = Self::ALL.iter().position(|&l| l == self).unwrap_or(0);
        Self::ALL[(i + 1) % Self::ALL.len()]
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Appearance {
    #[default]
    System,
    Light,
    Dark,
}

impl Appearance {
    pub const ALL: [Self; 3] = [Self::System, Self::Light, Self::Dark];

    pub fn name(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::Light => "light",
            Self::Dark => "dark",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|a| a.name() == s)
    }

    pub fn next(self) -> Self {
        let i = Self::ALL.iter().position(|&a| a == self).unwrap_or(0);
        Self::ALL[(i + 1) % Self::ALL.len()]
    }
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Settings {
    pub max_entries: u32,
    pub max_age_days: Option<u32>,
    pub refresh_minutes: u32,
    pub confirm_open_over: u32,
    pub reading_mode: Mode,
    pub lines: Lines,
    pub merge_duplicates: bool,
    pub appearance: Appearance,
    pub reading_size: u32,
    pub reading_width: u32,
    #[serde(default)]
    pub publish: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            max_entries: 3000,
            max_age_days: None,
            refresh_minutes: 5,
            confirm_open_over: 20,
            reading_mode: Mode::Clean,
            lines: Lines::Light,
            merge_duplicates: true,
            appearance: Appearance::System,
            reading_size: 100,
            reading_width: 78,
            publish: false,
        }
    }
}

#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
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

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct Candidate {
    pub url: String,
    pub title: String,
    pub kind: String,
    pub entries: usize,
    pub latest: Option<i64>,
    pub subscribed: bool,
    pub recent: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum Inline {
    Text(String),
    Bold(String),
    Italic(String),
    Code(String),
    Link(String, String),
    Break,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
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

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct Body {
    pub entry: EntryId,
    pub mode: Mode,
    pub blocks: Result<Vec<Block>, String>,
    pub note: Option<String>,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum Target {
    Entry(EntryId),
    Page(String),
    Play(String, String),
}

impl Target {
    pub fn link(&self) -> Option<&str> {
        match self {
            Target::Page(u) | Target::Play(u, _) => Some(u),
            Target::Entry(_) => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct TabState {
    pub history: Vec<Target>,
    pub mode: Mode,
    pub scroll: f32,
    pub kept: bool,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct Extracted {
    pub title: String,
    pub html: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
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

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum Command {
    Read(Vec<EntryId>, bool),
    Bookmark(Vec<EntryId>, bool),
    Subscribe(String, String, Vec<String>),
    Unsubscribe(FeedId),
    Resubscribe(FeedId),
    Rename(FeedId, Option<String>),
    Folders(FeedId, Vec<String>),
    Membership(FeedId, Vec<(String, String)>),
    RenameFolder(String, String),
    DeleteFolder(String),
    RestoreFolder(Folder),
    Pin(FeedId, bool),
    Hide(FeedId, bool),
    FeedMode(FeedId, Option<Mode>),
    AddRule(Rule),
    RemoveRule(String),
    Recommend(EntryId, String),
    Unrecommend(EntryId),
    SaveLink(String),
    Settings(Settings),
    Tabs(Vec<TabState>),
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum SyncStatus {
    Hub { devices: Vec<(String, Option<i64>)> },
    Satellite { online: bool, address: String },
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Change {
    pub id: String,
    pub device: String,
    pub at: i64,
    pub command: Command,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub enum Request {
    UseWebExtractor,
    PairCode,
    Pair(String, String),
    Unpair,
    ForgetDevice(String),
    Resync,
    Detach,
    Shutdown,
    SetTabs(Vec<TabState>),
    Media(Vec<String>),
    Extracted(u64, Result<Extracted, String>),
    Probe(String),
    SetRead(Vec<EntryId>, bool),
    SetBookmarked(Vec<EntryId>, bool),
    Refresh,
    Discover(String),
    AddFeed(String, String, Vec<String>),
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

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
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
        tabs: Vec<TabState>,
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
    FollowOffer(String, Vec<Candidate>),
    Disconnected,
    States(Vec<(EntryId, Option<bool>, Option<bool>)>),
    Pairing(String),
    Sync(SyncStatus),
    Tabs(Vec<TabState>),
    Probed(String, Result<(Extracted, Extractor), String>),
}
