use futures_util::StreamExt;
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::Path, time::Duration};
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryState {
    pub read: Option<bool>,
    pub read_at: Option<i64>,
    pub starred: Option<bool>,
    pub starred_at: Option<i64>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub feed_id: String,
    pub url: String,
    pub title: String,
    pub published: String,
    pub feed_label: String,
    pub state: EntryState,
}

#[derive(Clone, Deserialize)]
pub struct Feed {
    pub id: String,
    pub url: String,
    pub label: String,
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedHealth {
    pub last_fetched: Option<i64>,
    pub error: Option<String>,
}

#[derive(Clone, Default, Deserialize)]
pub struct Feeds {
    pub feeds: Vec<Feed>,
    pub health: HashMap<String, FeedHealth>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Retention {
    pub max_entries: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_days: Option<u32>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub max_bulk_open: u32,
    pub retention: Retention,
    pub theme: String,
    pub appearance: String,
    pub port: u16,
    pub trusted_origins: Vec<String>,
}

#[derive(Clone, Deserialize)]
pub struct Theme {
    pub name: String,
    pub appearances: Vec<String>,
}

#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshStatus {
    pub run_id: Option<String>,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
    pub refreshing: bool,
    pub count: u32,
    pub total: u32,
    pub completed: u32,
    pub failed: u32,
    pub error: Option<String>,
    pub failures: Vec<RefreshFailure>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedResult {
    pub feed_id: String,
    pub error: Option<String>,
    pub completed_at: i64,
}

#[derive(Clone, Deserialize)]
pub struct RefreshFailure {
    pub label: String,
    pub error: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub entries: Vec<Entry>,
    pub feeds: Feeds,
    pub config: Config,
    pub themes: Vec<Theme>,
    pub status: RefreshStatus,
    pub event_id: u64,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventPayload {
    #[serde(default)]
    pub topics: Vec<String>,
    #[serde(default)]
    pub entry_states: HashMap<String, EntryState>,
    #[serde(default)]
    pub entries: Vec<Entry>,
    #[serde(default)]
    pub removed_ids: Vec<String>,
    pub refresh: Option<RefreshStatus>,
    #[serde(default)]
    pub feed_results: Vec<FeedResult>,
}

#[derive(Clone, Serialize)]
pub struct StatePatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub starred: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StateResponse {
    entry_states: HashMap<String, EntryState>,
}

#[derive(Deserialize)]
pub struct ImportResult {
    pub added: usize,
    pub skipped: usize,
}

pub enum Message {
    Snapshot(Snapshot),
    Event(u64, EventPayload),
    Saved(HashMap<String, EntryState>),
    Refreshed(RefreshStatus),
    FeedAdded(String),
    FeedRemoved(String),
    Imported(ImportResult),
    Exported(String),
    ConfigSaved(Config),
    WriteFailed(String),
    Error(String),
    Offline,
}

#[derive(Clone)]
pub struct Api {
    client: Client,
    base: Url,
}

impl Api {
    pub fn new(address: &str) -> Result<Self, String> {
        let mut base = Url::parse(address).map_err(|error| error.to_string())?;
        if !matches!(base.scheme(), "http" | "https") {
            return Err("Server URL must use http or https".into());
        }
        if base.path().trim_end_matches('/').is_empty() || base.path() == "/" {
            base.set_path("/feedreader/");
        } else if !base.path().ends_with('/') {
            base.set_path(&format!("{}/", base.path()));
        }
        base.set_query(None);
        base.set_fragment(None);
        Ok(Self {
            client: Client::builder()
                .build()
                .map_err(|error| error.to_string())?,
            base,
        })
    }

    fn url(&self, path: &str) -> Url {
        self.base
            .join(&format!("api/{path}"))
            .expect("valid API path")
    }

    async fn response(
        &self,
        request: reqwest::RequestBuilder,
    ) -> Result<reqwest::Response, String> {
        self.response_with_timeout(request, 15).await
    }

    async fn response_with_timeout(
        &self,
        request: reqwest::RequestBuilder,
        seconds: u64,
    ) -> Result<reqwest::Response, String> {
        let response = request
            .timeout(Duration::from_secs(seconds))
            .send()
            .await
            .map_err(|error| error.to_string())?;
        if response.status().is_success() {
            Ok(response)
        } else {
            let status = response.status();
            let body: serde_json::Value = response.json().await.unwrap_or_default();
            Err(body["error"]
                .as_str()
                .unwrap_or(status.canonical_reason().unwrap_or("Request failed"))
                .to_owned())
        }
    }

    pub async fn sync(&self) -> Result<Snapshot, String> {
        self.response(self.client.get(self.url("sync")))
            .await?
            .json()
            .await
            .map_err(|error| error.to_string())
    }

    pub async fn mark(
        &self,
        entries: HashMap<String, StatePatch>,
    ) -> Result<HashMap<String, EntryState>, String> {
        self.response(
            self.client
                .post(self.url("state"))
                .json(&serde_json::json!({ "entries": entries })),
        )
        .await?
        .json::<StateResponse>()
        .await
        .map(|response| response.entry_states)
        .map_err(|error| error.to_string())
    }

    pub async fn refresh(&self) -> Result<RefreshStatus, String> {
        self.response(self.client.post(self.url("refresh")))
            .await?
            .json()
            .await
            .map_err(|error| error.to_string())
    }

    pub async fn add_feed(&self, address: String) -> Result<(), String> {
        self.response_with_timeout(
            self.client
                .post(self.url("feeds"))
                .json(&serde_json::json!({ "url": address })),
            120,
        )
        .await?;
        Ok(())
    }

    pub async fn remove_feed(&self, id: String) -> Result<(), String> {
        self.response(
            self.client
                .delete(self.url(&format!("feeds/{}", encode_segment(&id)))),
        )
        .await?;
        Ok(())
    }

    pub async fn import(&self, path: &Path) -> Result<ImportResult, String> {
        let bytes = tokio::fs::read(path)
            .await
            .map_err(|error| error.to_string())?;
        let response = self
            .client
            .post(self.url("feeds/import"))
            .header("content-type", "application/xml")
            .body(bytes);
        self.response(response)
            .await?
            .json()
            .await
            .map_err(|error| error.to_string())
    }

    pub async fn export(&self, path: &Path) -> Result<(), String> {
        let bytes = self
            .response(self.client.get(self.url("feeds/export")))
            .await?
            .bytes()
            .await
            .map_err(|error| error.to_string())?;
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .await
            .map_err(|error| error.to_string())?;
        file.write_all(&bytes)
            .await
            .map_err(|error| error.to_string())
    }

    pub async fn save_config(&self, config: Config) -> Result<Config, String> {
        self.response(self.client.put(self.url("config")).json(&config))
            .await?
            .json()
            .await
            .map_err(|error| error.to_string())
    }

    pub async fn events(&self, tx: mpsc::UnboundedSender<Message>) {
        loop {
            match self.client.get(self.url("events")).send().await {
                Ok(response) if response.status().is_success() => {
                    let mut stream = response.bytes_stream();
                    let mut buffer = Vec::<u8>::new();
                    let mut id = 0;
                    let mut data = String::new();
                    while let Ok(Some(result)) =
                        tokio::time::timeout(Duration::from_secs(15), stream.next()).await
                    {
                        match result {
                            Ok(chunk) => {
                                buffer.extend_from_slice(&chunk);
                                while let Some(end) = buffer.iter().position(|byte| *byte == b'\n')
                                {
                                    let line = String::from_utf8_lossy(&buffer[..end])
                                        .trim_end_matches('\r')
                                        .to_owned();
                                    buffer.drain(..=end);
                                    if let Some(value) = line.strip_prefix("id: ") {
                                        id = value.parse().unwrap_or(0);
                                    } else if let Some(value) = line.strip_prefix("data: ") {
                                        data.push_str(value);
                                    } else if line.is_empty() && !data.is_empty() {
                                        if let Ok(payload) =
                                            serde_json::from_str::<EventPayload>(&data)
                                        {
                                            if !payload.topics.is_empty() {
                                                if let Ok(snapshot) = self.sync().await {
                                                    let _ = tx.send(Message::Snapshot(snapshot));
                                                }
                                            } else {
                                                let _ = tx.send(Message::Event(id, payload));
                                            }
                                        }
                                        data.clear();
                                    }
                                }
                                if buffer.len() > 4 * 1024 * 1024 {
                                    break;
                                }
                            }
                            Err(_) => break,
                        }
                    }
                }
                _ => {}
            }
            let _ = tx.send(Message::Offline);
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    }
}

fn encode_segment(input: &str) -> String {
    input
        .bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
                (byte as char).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect()
}
