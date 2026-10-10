use std::time::Duration;

use tokio::sync::{mpsc::UnboundedSender, oneshot, watch};

use crate::hub::{Content, PairReply, PairRequest, Pulled, SyncRequest};
use crate::types::Change;

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct HubLink {
    pub addresses: Vec<String>,
    pub token: String,
}

pub enum Ask {
    Outbox { reply: oneshot::Sender<(Vec<Change>, i64, i64, i64)> },
}

pub fn parse_link(link: &str) -> Result<(String, Vec<String>), String> {
    let rest = link.trim().strip_prefix("feedreader://pair?").ok_or("A pairing link starts with feedreader://pair?")?;
    let mut code = None;
    let mut hubs = Vec::new();
    for (k, v) in url::form_urlencoded::parse(rest.as_bytes()) {
        match k.as_ref() {
            "code" => code = Some(v.to_string()),
            "hub" => hubs.extend(v.split(',').map(|s| s.trim().trim_end_matches('/').to_string()).filter(|s| !s.is_empty())),
            _ => {}
        }
    }
    let code = code.ok_or("The pairing link has no code")?;
    if hubs.is_empty() {
        return Err("The pairing link has no hub address".into());
    }
    Ok((code, hubs))
}

pub async fn pair(client: &reqwest::Client, link: &str, device: &str, name: &str) -> Result<HubLink, String> {
    let (code, addresses) = parse_link(link)?;
    let body = serde_json::to_vec(&PairRequest { code, device: device.into(), name: name.into() }).map_err(|e| e.to_string())?;
    let mut last = String::from("No hub address answered");
    for a in &addresses {
        let r = client
            .post(format!("{a}/v1/pair"))
            .header("content-type", "application/json")
            .body(body.clone())
            .timeout(Duration::from_secs(8))
            .send()
            .await;
        match r {
            Ok(resp) if resp.status().is_success() => {
                let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
                let reply: PairReply = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
                let mut ordered = vec![a.clone()];
                ordered.extend(addresses.iter().filter(|x| *x != a).cloned());
                return Ok(HubLink { addresses: ordered, token: reply.token });
            }
            Ok(resp) => last = format!("{a} said {}: {}", resp.status(), resp.text().await.unwrap_or_default()),
            Err(e) => last = format!("{a}: {e}"),
        }
    }
    Err(last)
}

pub fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(Duration::from_secs(4))
        .build()
        .expect("sync client")
}

async fn alive(client: &reqwest::Client, base: &str) -> bool {
    client
        .get(format!("{base}/v1/health"))
        .timeout(Duration::from_secs(2))
        .send()
        .await
        .is_ok_and(|r| r.status().is_success())
}

async fn post_sync(client: &reqwest::Client, base: &str, token: &str, req: &SyncRequest) -> Result<Pulled, String> {
    let resp = client
        .post(format!("{base}/v1/sync"))
        .bearer_auth(token)
        .header("content-type", "application/json")
        .body(serde_json::to_vec(req).map_err(|e| e.to_string())?)
        .timeout(Duration::from_secs(40))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

async fn get_content(client: &reqwest::Client, base: &str, token: &str, since: i64) -> Result<Content, String> {
    let resp = client
        .get(format!("{base}/v1/content?since={since}"))
        .bearer_auth(token)
        .timeout(Duration::from_secs(60))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

pub async fn fetch_media(client: &reqwest::Client, link: &HubLink, url: &str) -> Option<Vec<u8>> {
    for a in &link.addresses {
        let r = client
            .get(format!("{a}/v1/media?url={}", url::form_urlencoded::byte_serialize(url.as_bytes()).collect::<String>()))
            .bearer_auth(&link.token)
            .timeout(Duration::from_secs(20))
            .send()
            .await;
        if let Ok(resp) = r
            && resp.status().is_success()
            && let Ok(b) = resp.bytes().await
        {
            return Some(b.to_vec());
        }
    }
    None
}

pub async fn run(link: HubLink, engine: UnboundedSender<crate::Internal>, mut changed: watch::Receiver<i64>) {
    let client = client();
    let mut backoff = 1u64;
    let mut addr = 0usize;
    loop {
        let (tx, rx) = oneshot::channel();
        if engine.send(crate::Internal::Ask(Ask::Outbox { reply: tx })).is_err() {
            return;
        }
        let Ok((outbox, top, pulled, cursor)) = rx.await else { return };
        let base = link.addresses[addr % link.addresses.len()].clone();
        let req = SyncRequest { since: pulled, changes: outbox, wait: true };
        changed.mark_unchanged();
        let result = if !alive(&client, &base).await {
            Some(Err("not answering".to_string()))
        } else {
            tokio::select! {
                r = post_sync(&client, &base, &link.token, &req) => Some(r),
                _ = changed.changed(), if req.changes.is_empty() => None,
            }
        };
        let Some(result) = result else { continue };
        match result {
            Ok(p) => {
                if backoff > 1 {
                    eprintln!("sync: connected to {base}");
                }
                backoff = 1;
                let more = p.more;
                let _ = engine.send(crate::Internal::Pulled(top, p));
                let mut since = cursor;
                loop {
                    match get_content(&client, &base, &link.token, since).await {
                        Ok(c) => {
                            let next = c.next;
                            let again = c.more;
                            let _ = engine.send(crate::Internal::Content(c));
                            since = next;
                            if !again {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
                let _ = engine.send(crate::Internal::HubOnline(true, base.clone()));
                if more {
                    continue;
                }
            }
            Err(e) => {
                eprintln!("sync: {base}: {e}");
                addr += 1;
                if addr % link.addresses.len() == 0 {
                    let _ = engine.send(crate::Internal::HubOnline(false, base.clone()));
                    let mut jitter = [0u8; 1];
                    let _ = getrandom::fill(&mut jitter);
                    let wait = Duration::from_millis(backoff.min(15) * 1000 + jitter[0] as u64 * 4);
                    backoff = (backoff * 2).min(15);
                    tokio::select! {
                        _ = tokio::time::sleep(wait) => {}
                        _ = changed.changed() => {}
                    }
                }
            }
        }
    }
}
