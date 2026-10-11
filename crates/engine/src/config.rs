use std::path::Path;

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct Config {
    pub sync_port: u16,
    pub public_port: u16,
    pub funnel_port: u16,
    pub media_budget_mb: u32,
    pub hosts: Vec<String>,
}

impl Default for Config {
    fn default() -> Self {
        Self { sync_port: 8790, public_port: 8791, funnel_port: 10000, media_budget_mb: 1000, hosts: Vec::new() }
    }
}

const FUNNEL_PORTS: [u16; 3] = [443, 8443, 10000];

impl Config {
    pub fn load(dir: &Path) -> Result<Self, String> {
        let path = dir.join("engine.toml");
        let mut config = match std::fs::read_to_string(&path) {
            Ok(text) => toml::from_str(&text).map_err(|e| format!("{}: {}", path.display(), e.message()))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Self::default(),
            Err(e) => return Err(format!("{}: {e}", path.display())),
        };
        let env = |name| std::env::var(name).ok().and_then(|p| p.parse().ok());
        config.sync_port = env("FEEDREADER_SYNC_PORT").unwrap_or(config.sync_port);
        config.public_port = env("FEEDREADER_PUBLIC_PORT").unwrap_or(config.public_port);
        config.check().map_err(|e| format!("{}: {e}", path.display()))?;
        Ok(config)
    }

    fn check(&self) -> Result<(), String> {
        for (name, port) in [("sync_port", self.sync_port), ("public_port", self.public_port)] {
            if port < 1024 {
                return Err(format!("{name} must be 1024 or higher"));
            }
        }
        if self.sync_port == self.public_port {
            return Err("sync_port and public_port must differ".into());
        }
        if !FUNNEL_PORTS.contains(&self.funnel_port) {
            return Err("funnel_port must be 443, 8443 or 10000, the ports Tailscale Funnel serves".into());
        }
        if !(100..=100_000).contains(&self.media_budget_mb) {
            return Err("media_budget_mb must be between 100 and 100000".into());
        }
        if let Some(h) = self.hosts.iter().find(|h| h.is_empty() || h.contains([':', '/', ' '])) {
            return Err(format!("hosts must be plain host names, not {h:?}"));
        }
        Ok(())
    }

    pub fn media_budget(&self) -> i64 {
        self.media_budget_mb as i64 * 1_000_000
    }
}
