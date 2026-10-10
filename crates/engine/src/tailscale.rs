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
    Ok(Node { name, funnel })
}

pub async fn name() -> Option<String> {
    node().await.ok().map(|n| n.name)
}

pub async fn publish(public: u16, local: u16) -> Result<String, String> {
    let node = node().await?;
    if !node.funnel {
        return Err("Funnel isn't allowed for this machine; turn it on in the tailnet's access controls".into());
    }
    run(&["funnel", "--bg", "--yes", &format!("--https={public}"), &format!("http://127.0.0.1:{local}")]).await?;
    Ok(node.name)
}

pub async fn unpublish(public: u16) -> Result<(), String> {
    run(&["funnel", &format!("--https={public}"), "off"]).await.map(|_| ())
}
