use std::path::PathBuf;
use std::time::Duration;

use axum::Json;
use axum::Router;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use tokio::sync::{mpsc::UnboundedSender, oneshot, watch};

use crate::store::{WireEntry, WireFeed};
use crate::types::Change;

pub enum Api {
    Pair { code: String, device: String, name: String, reply: oneshot::Sender<Option<String>> },
    Auth { token: String, reply: oneshot::Sender<Option<String>> },
    Sync { device: String, since: i64, changes: Vec<Change>, reply: oneshot::Sender<Pulled> },
    Content { since: i64, reply: oneshot::Sender<Content> },
    Media { url: String, reply: oneshot::Sender<Option<PathBuf>> },
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
pub struct Pulled {
    pub seq: i64,
    pub changes: Vec<(i64, Change)>,
    pub more: bool,
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
pub struct Content {
    pub feeds: Vec<WireFeed>,
    pub entries: Vec<WireEntry>,
    pub next: i64,
    pub more: bool,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct PairRequest {
    pub code: String,
    pub device: String,
    pub name: String,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct PairReply {
    pub token: String,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct SyncRequest {
    pub since: i64,
    pub changes: Vec<Change>,
    pub wait: bool,
}

#[derive(serde::Deserialize)]
struct Since {
    since: i64,
}

#[derive(serde::Deserialize)]
struct MediaQuery {
    url: String,
}

#[derive(Clone)]
struct Hub {
    api: UnboundedSender<crate::Internal>,
    changed: watch::Receiver<i64>,
}

impl Hub {
    async fn ask<T>(&self, make: impl FnOnce(oneshot::Sender<T>) -> Api) -> Option<T> {
        let (tx, rx) = oneshot::channel();
        self.api.send(crate::Internal::Api(make(tx))).ok()?;
        rx.await.ok()
    }

    async fn device(&self, headers: &HeaderMap) -> Result<String, StatusCode> {
        let token = headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .ok_or(StatusCode::UNAUTHORIZED)?
            .to_string();
        self.ask(|reply| Api::Auth { token, reply }).await.flatten().ok_or(StatusCode::UNAUTHORIZED)
    }
}

async fn pair(State(hub): State<Hub>, Json(req): Json<PairRequest>) -> Response {
    let PairRequest { code, device, name } = req;
    match hub.ask(|reply| Api::Pair { code, device, name, reply }).await.flatten() {
        Some(token) => Json(PairReply { token }).into_response(),
        None => (StatusCode::FORBIDDEN, "That pairing code is wrong or expired").into_response(),
    }
}

async fn sync(State(hub): State<Hub>, headers: HeaderMap, Json(req): Json<SyncRequest>) -> Response {
    let device = match hub.device(&headers).await {
        Ok(d) => d,
        Err(s) => return s.into_response(),
    };
    let mut changed = hub.changed.clone();
    changed.mark_unchanged();
    let SyncRequest { since, changes, wait } = req;
    let d = device.clone();
    let Some(mut pulled) = hub.ask(|reply| Api::Sync { device: d, since, changes, reply }).await else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    if wait && pulled.changes.is_empty() && !pulled.more {
        let _ = tokio::time::timeout(Duration::from_secs(25), changed.changed()).await;
        let d = device.clone();
        if let Some(p) = hub.ask(|reply| Api::Sync { device: d, since, changes: Vec::new(), reply }).await {
            pulled = p;
        }
    }
    Json(pulled).into_response()
}

async fn content(State(hub): State<Hub>, headers: HeaderMap, Query(q): Query<Since>) -> Response {
    if let Err(s) = hub.device(&headers).await {
        return s.into_response();
    }
    match hub.ask(|reply| Api::Content { since: q.since, reply }).await {
        Some(c) => Json(c).into_response(),
        None => StatusCode::SERVICE_UNAVAILABLE.into_response(),
    }
}

async fn media(State(hub): State<Hub>, headers: HeaderMap, Query(q): Query<MediaQuery>) -> Response {
    if let Err(s) = hub.device(&headers).await {
        return s.into_response();
    }
    let url = q.url;
    match hub.ask(|reply| Api::Media { url, reply }).await.flatten() {
        Some(path) => match tokio::fs::read(&path).await {
            Ok(bytes) => bytes.into_response(),
            Err(_) => StatusCode::NOT_FOUND.into_response(),
        },
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn health() -> Response {
    Json(serde_json::json!({ "app": "feedreader", "version": env!("CARGO_PKG_VERSION"), "pid": std::process::id() })).into_response()
}

pub async fn serve(port: u16, api: UnboundedSender<crate::Internal>, changed: watch::Receiver<i64>) -> std::io::Result<()> {
    let app = Router::new()
        .route("/v1/health", get(health))
        .route("/v1/pair", post(pair))
        .route("/v1/sync", post(sync))
        .route("/v1/content", get(content))
        .route("/v1/media", get(media))
        .with_state(Hub { api, changed });
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
    axum::serve(listener, app).await
}
