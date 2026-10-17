use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use axum::extract::{ConnectInfo, Request, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

const BURST: f64 = 20.0;
const PER_SECOND: f64 = 1.0;
const CLIENTS: usize = 4096;

#[derive(Clone, Copy)]
struct Bucket {
    tokens: f64,
    at: Instant,
}

fn take(bucket: Option<Bucket>, now: Instant) -> Result<Bucket, u64> {
    let tokens = bucket.map_or(BURST, |b| (b.tokens + now.duration_since(b.at).as_secs_f64() * PER_SECOND).min(BURST));
    if tokens >= 1.0 { Ok(Bucket { tokens: tokens - 1.0, at: now }) } else { Err(((1.0 - tokens) / PER_SECOND).ceil() as u64) }
}

#[derive(Clone, Copy)]
pub enum Peers {
    Direct,
    BehindLocalProxy,
}

#[derive(Clone)]
pub struct Limits {
    peers: Peers,
    buckets: Arc<Mutex<HashMap<IpAddr, Bucket>>>,
}

impl Limits {
    pub fn new(peers: Peers) -> Self {
        Self { peers, buckets: Arc::default() }
    }

    fn client(&self, peer: SocketAddr, headers: &HeaderMap) -> IpAddr {
        let forwarded = || headers.get("x-forwarded-for")?.to_str().ok()?.rsplit(',').next()?.trim().parse().ok();
        match self.peers {
            Peers::BehindLocalProxy if peer.ip().is_loopback() => forwarded().unwrap_or(peer.ip()),
            _ => peer.ip(),
        }
    }
}

pub async fn limit(State(limits): State<Limits>, ConnectInfo(peer): ConnectInfo<SocketAddr>, request: Request, next: Next) -> Response {
    let who = limits.client(peer, request.headers());
    let now = Instant::now();
    let verdict = {
        let mut map = limits.buckets.lock().unwrap_or_else(|e| e.into_inner());
        if map.len() >= CLIENTS {
            map.retain(|_, b| take(Some(*b), now).is_ok_and(|b| b.tokens + 1.0 < BURST));
        }
        if map.len() >= CLIENTS {
            map.clear();
        }
        let verdict = take(map.get(&who).copied(), now);
        if let Ok(b) = verdict {
            map.insert(who, b);
        }
        verdict
    };
    match verdict {
        Ok(_) => next.run(request).await,
        Err(wait) => (StatusCode::TOO_MANY_REQUESTS, [(header::RETRY_AFTER, wait.to_string())], "Too many requests").into_response(),
    }
}
