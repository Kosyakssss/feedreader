use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use reqwest::redirect::Policy;
use url::{Host, Url};

const V4_BLOCKED: &[(u32, u32)] = &[
    (0x0000_0000, 8),
    (0x0A00_0000, 8),
    (0x6440_0000, 10),
    (0x7F00_0000, 8),
    (0xA9FE_0000, 16),
    (0xAC10_0000, 12),
    (0xC000_0000, 24),
    (0xC000_0200, 24),
    (0xC058_6300, 24),
    (0xC0A8_0000, 16),
    (0xC633_6400, 24),
    (0xCB00_7100, 24),
    (0xE000_0000, 3),
];

const V6_BLOCKED: &[(u128, u32)] = &[
    (0, 128),
    (1, 128),
    (0xfc00 << 112, 7),
    (0xfe80 << 112, 10),
    (0xfec0 << 112, 10),
    (0xff00 << 112, 8),
    (0x0100 << 112, 64),
    (0x2001_0db8 << 96, 32),
];

fn in_net(n: u128, net: u128, len: u32, bits: u32) -> bool {
    len == 0 || (n >> (bits - len)) == (net >> (bits - len))
}

pub fn public_v4(ip: Ipv4Addr) -> bool {
    let n = u32::from(ip) as u128;
    !V4_BLOCKED
        .iter()
        .any(|(net, len)| in_net(n, *net as u128, *len, 32))
}

pub fn public_v6(ip: Ipv6Addr) -> bool {
    let n = u128::from(ip);
    if V6_BLOCKED.iter().any(|(net, len)| in_net(n, *net, *len, 128)) {
        return false;
    }
    let low32 = Ipv4Addr::from((n & 0xffff_ffff) as u32);
    if in_net(n, 0xffff << 32, 96, 128) || in_net(n, 0, 96, 128) || in_net(n, 0x0064_ff9b << 96, 96, 128) {
        return public_v4(low32);
    }
    if in_net(n, 0x2002 << 112, 16, 128) {
        return public_v4(Ipv4Addr::from(((n >> 80) & 0xffff_ffff) as u32));
    }
    if in_net(n, 0x2001_0000 << 96, 32, 128) {
        return public_v4(Ipv4Addr::from(!((n & 0xffff_ffff) as u32)));
    }
    true
}

pub fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => public_v4(v4),
        IpAddr::V6(v6) => public_v6(v6),
    }
}

pub fn check_url(url: &Url) -> Result<(), String> {
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(format!("Only http and https links are allowed, not {}", url.scheme()));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Links with credentials are not allowed".into());
    }
    match url.host() {
        Some(Host::Domain(d)) => {
            let d = d.trim_end_matches('.').to_ascii_lowercase();
            if d == "localhost" || d.ends_with(".localhost") || d.ends_with(".local") {
                return Err(format!("{d} is a local address"));
            }
            Ok(())
        }
        Some(Host::Ipv4(ip)) if public_v4(ip) => Ok(()),
        Some(Host::Ipv6(ip)) if public_v6(ip) => Ok(()),
        Some(_) => Err("That address is private or reserved".into()),
        None => Err("The link has no host".into()),
    }
}

pub fn parse_url(input: &str) -> Result<Url, String> {
    let input = input.trim();
    let with_scheme = if input.contains("://") {
        input.to_string()
    } else {
        format!("https://{input}")
    };
    let url = Url::parse(&with_scheme).map_err(|e| format!("Not a valid link: {e}"))?;
    check_url(&url)?;
    Ok(url)
}

struct SafeResolver;

impl Resolve for SafeResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let host = name.as_str().to_string();
        Box::pin(async move {
            let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), 0)).await?.collect();
            if addrs.is_empty() {
                return Err(format!("{host} has no addresses").into());
            }
            if addrs.iter().any(|a| !public_ip(a.ip())) {
                return Err(format!("{host} points to a private address").into());
            }
            let addrs: Addrs = Box::new(addrs.into_iter());
            Ok(addrs)
        })
    }
}

pub fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .dns_resolver(Arc::new(SafeResolver))
        .no_proxy()
        .redirect(Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 {
                return attempt.error("Too many redirects");
            }
            match check_url(attempt.url()) {
                Ok(()) => attempt.follow(),
                Err(e) => attempt.error(e),
            }
        }))
        .user_agent(concat!("Feedreader/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(5))
        .build()
        .expect("http client")
}

pub struct Fetched {
    pub status: u16,
    pub url: Url,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub kind: Option<String>,
    pub cache_control: Option<String>,
    pub retry_after: Option<String>,
    pub body: Vec<u8>,
}

pub async fn fetch(
    client: &reqwest::Client,
    url: &Url,
    accept: &str,
    validators: Option<(Option<String>, Option<String>)>,
    timeout: Duration,
    cap: usize,
) -> Result<Fetched, String> {
    check_url(url)?;
    let work = async {
        let mut req = client.get(url.clone()).header("accept", accept);
        if let Some((etag, lm)) = &validators {
            if let Some(e) = etag {
                req = req.header("if-none-match", e);
            }
            if let Some(l) = lm {
                req = req.header("if-modified-since", l);
            }
        }
        let mut resp = req.send().await.map_err(describe)?;
        let header = |name: &str| {
            resp.headers()
                .get(name)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string)
        };
        let etag = header("etag");
        let last_modified = header("last-modified");
        let kind = header("content-type");
        let cache_control = header("cache-control");
        let retry_after = header("retry-after");
        let status = resp.status().as_u16();
        let final_url = resp.url().clone();
        let mut body = Vec::new();
        while let Some(chunk) = resp.chunk().await.map_err(describe)? {
            body.extend_from_slice(&chunk);
            if body.len() > cap {
                return Err(format!("Response is larger than {} MB", cap / 1_000_000));
            }
        }
        Ok(Fetched {
            status,
            url: final_url,
            etag,
            last_modified,
            kind,
            cache_control,
            retry_after,
            body,
        })
    };
    tokio::time::timeout(timeout, work)
        .await
        .map_err(|_| format!("Timed out after {} s", timeout.as_secs()))?
}

fn describe(e: reqwest::Error) -> String {
    let mut msg = e.to_string();
    let mut source = std::error::Error::source(&e);
    while let Some(s) = source {
        msg = s.to_string();
        source = s.source();
    }
    msg
}
