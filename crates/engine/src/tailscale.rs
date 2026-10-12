use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

const INSTALLED: &[&str] = &[
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    "/opt/homebrew/bin/tailscale",
    "/usr/local/bin/tailscale",
    "/usr/bin/tailscale",
    "/usr/sbin/tailscale",
    "/snap/bin/tailscale",
];

fn binary() -> Option<PathBuf> {
    let on_path: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).map(|d| d.join("tailscale")).collect())
        .unwrap_or_default();
    on_path.into_iter().chain(INSTALLED.iter().map(PathBuf::from)).find(|p| p.is_file())
}

async fn run(args: &[&str]) -> Result<Vec<u8>, String> {
    let bin = binary().ok_or("Tailscale isn't installed")?;
    let child = tokio::process::Command::new(bin).args(args).env("SHLVL", "1").stdin(Stdio::null()).kill_on_drop(true).output();
    let out = tokio::time::timeout(Duration::from_secs(20), child)
        .await
        .map_err(|_| "Tailscale didn't answer within 20 seconds".to_string())?
        .map_err(|e| format!("Couldn't run Tailscale: {e}"))?;
    if out.status.success() {
        return Ok(out.stdout);
    }
    let said = if out.stderr.is_empty() { &out.stdout } else { &out.stderr };
    Err(String::from_utf8_lossy(said).trim().to_string())
}

pub struct Node {
    pub name: String,
    pub funnel: bool,
    pub key_expiry: Option<i64>,
}

pub async fn node() -> Result<Node, String> {
    let out = run(&["status", "--json"]).await?;
    let v: serde_json::Value = serde_json::from_slice(&out).map_err(|e| format!("Tailscale's status didn't parse: {e}"))?;
    if v.get("BackendState").and_then(|s| s.as_str()) != Some("Running") {
        return Err("Tailscale isn't connected".into());
    }
    let me = v.get("Self").ok_or("Tailscale didn't describe this machine")?;
    let name = me
        .get("DNSName")
        .and_then(|s| s.as_str())
        .map(|s| s.trim_end_matches('.').to_string())
        .filter(|s| !s.is_empty())
        .ok_or("Tailscale has no name for this machine")?;
    let funnel = me.get("CapMap").and_then(|c| c.as_object()).is_some_and(|c| c.contains_key("funnel"));
    let key_expiry = me
        .get("KeyExpiry")
        .and_then(|s| s.as_str())
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.timestamp_millis());
    Ok(Node { name, funnel, key_expiry })
}

pub async fn name() -> Option<String> {
    node().await.ok().map(|n| n.name)
}

pub async fn publish(public: u16, local: u16) -> Result<Node, String> {
    let node = node().await?;
    if !node.funnel {
        return Err("Funnel isn't allowed for this machine; turn it on in the tailnet's access controls".into());
    }
    run(&["funnel", "--bg", "--yes", &format!("--https={public}"), &format!("http://127.0.0.1:{local}")]).await?;
    Ok(node)
}

pub async fn published(public: u16, local: u16) -> bool {
    let Ok(out) = run(&["funnel", "status", "--json"]).await else { return false };
    let Ok(v) = serde_json::from_slice::<serde_json::Value>(&out) else { return false };
    let ours = format!("http://127.0.0.1:{local}");
    v.get("Web").and_then(|w| w.as_object()).is_some_and(|web| {
        web.iter().any(|(host, site)| {
            host.ends_with(&format!(":{public}")) && site.pointer("/Handlers/~1/Proxy").and_then(|p| p.as_str()) == Some(ours.as_str())
        })
    })
}

pub async fn unpublish(public: u16) -> Result<(), String> {
    run(&["funnel", &format!("--https={public}"), "off"]).await.map(|_| ())
}

pub async fn reachable(net: &crate::net::Net, url: &str) -> Result<(), String> {
    let parsed = url::Url::parse(url).map_err(|e| e.to_string())?;
    let host = parsed.host_str().ok_or("the public link has no host")?.to_string();
    let port = parsed.port_or_known_default().unwrap_or(443);
    let mut ask = url::Url::parse("https://cloudflare-dns.com/dns-query").map_err(|e| e.to_string())?;
    ask.query_pairs_mut().append_pair("name", &host).append_pair("type", "A");
    let answer: serde_json::Value = net
        .client(crate::net::Zone::Public)
        .get(ask)
        .header("accept", "application/dns-json")
        .send()
        .await
        .map_err(|e| format!("couldn't ask public DNS for {host}: {e}"))?
        .bytes()
        .await
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .ok_or("public DNS gave an unreadable answer")?;
    let ip: std::net::IpAddr = answer
        .get("Answer")
        .and_then(|a| a.as_array())
        .into_iter()
        .flatten()
        .filter(|r| r.get("type").and_then(|t| t.as_u64()) == Some(1))
        .find_map(|r| r.get("data")?.as_str()?.parse().ok())
        .ok_or_else(|| format!("public DNS has no address for {host} yet"))?;
    let client = reqwest::Client::builder()
        .resolve(&host, std::net::SocketAddr::new(ip, port))
        .no_proxy()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let status = client.get(url).send().await.map_err(|e| format!("couldn't reach {host} through {ip}: {e}"))?.status();
    if status.is_success() { Ok(()) } else { Err(format!("{host} answered {status} from the internet")) }
}
