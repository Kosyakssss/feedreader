use std::collections::HashSet;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use reqwest::redirect::Policy;
use url::{Host, Url};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Zone {
    Public,
    Private,
    Local,
}

const V4: &[(u32, u32, Zone)] = &[
    (0x0000_0000, 8, Zone::Local),
    (0x7F00_0000, 8, Zone::Local),
    (0xA9FE_0000, 16, Zone::Local),
    (0x0A00_0000, 8, Zone::Private),
    (0x6440_0000, 10, Zone::Private),
    (0xAC10_0000, 12, Zone::Private),
    (0xC000_0000, 24, Zone::Private),
    (0xC000_0200, 24, Zone::Private),
    (0xC058_6300, 24, Zone::Private),
    (0xC0A8_0000, 16, Zone::Private),
    (0xC633_6400, 24, Zone::Private),
    (0xCB00_7100, 24, Zone::Private),
    (0xE000_0000, 3, Zone::Private),
];

const V6: &[(u128, u32, Zone)] = &[
    (0, 128, Zone::Local),
    (1, 128, Zone::Local),
    (0xfe80 << 112, 10, Zone::Local),
    (0xfc00 << 112, 7, Zone::Private),
    (0xfec0 << 112, 10, Zone::Private),
    (0xff00 << 112, 8, Zone::Private),
    (0x0100 << 112, 64, Zone::Private),
    (0x2001_0db8 << 96, 32, Zone::Private),
];

fn in_net(n: u128, net: u128, len: u32, bits: u32) -> bool {
    len == 0 || (n >> (bits - len)) == (net >> (bits - len))
}

pub fn zone_v4(ip: Ipv4Addr) -> Zone {
    let n = u32::from(ip) as u128;
    V4.iter().find(|(net, len, _)| in_net(n, *net as u128, *len, 32)).map_or(Zone::Public, |(_, _, zone)| *zone)
}

pub fn zone_v6(ip: Ipv6Addr) -> Zone {
    let n = u128::from(ip);
    if let Some((_, _, zone)) = V6.iter().find(|(net, len, _)| in_net(n, *net, *len, 128)) {
        return *zone;
    }
    let low32 = Ipv4Addr::from((n & 0xffff_ffff) as u32);
    if in_net(n, 0xffff << 32, 96, 128) || in_net(n, 0, 96, 128) || in_net(n, 0x0064_ff9b << 96, 96, 128) {
        return zone_v4(low32);
    }
    if in_net(n, 0x2002 << 112, 16, 128) {
        return zone_v4(Ipv4Addr::from(((n >> 80) & 0xffff_ffff) as u32));
    }
    if in_net(n, 0x2001_0000 << 96, 32, 128) {
        return zone_v4(Ipv4Addr::from(!((n & 0xffff_ffff) as u32)));
    }
    Zone::Public
}

pub fn zone_ip(ip: IpAddr) -> Zone {
    match ip {
        IpAddr::V4(v4) => zone_v4(v4),
        IpAddr::V6(v6) => zone_v6(v6),
    }
}

pub fn written_zone(url: &Url) -> Zone {
    match url.host() {
        Some(Host::Ipv4(ip)) => zone_v4(ip),
        Some(Host::Ipv6(ip)) => zone_v6(ip),
        Some(Host::Domain(d)) => {
            let d = d.trim_end_matches('.').to_ascii_lowercase();
            if d == "localhost" || d.ends_with(".localhost") {
                Zone::Local
            } else if d.ends_with(".local") {
                Zone::Private
            } else {
                Zone::Public
            }
        }
        None => Zone::Public,
    }
}

async fn zone_of(url: &Url) -> Zone {
    let written = written_zone(url);
    let Some(Host::Domain(d)) = url.host() else { return written };
    let resolved = match tokio::net::lookup_host((d, 0)).await {
        Ok(addrs) => addrs.map(|a| zone_ip(a.ip())).max().unwrap_or(Zone::Public),
        Err(_) => Zone::Public,
    };
    written.max(resolved)
}

pub fn host_key(url: &Url) -> Option<String> {
    url.host_str().map(|h| h.trim_end_matches('.').to_ascii_lowercase())
}

pub fn bound(url: &str, named: &HashSet<String>) -> Zone {
    match Url::parse(url).ok().as_ref().and_then(host_key) {
        Some(host) if named.contains(&host) => Zone::Local,
        _ => Zone::Public,
    }
}

pub fn may_navigate(opened: &str, to: &str) -> bool {
    let Ok(to) = Url::parse(to) else { return true };
    if to.scheme() != "http" && to.scheme() != "https" {
        return true;
    }
    let from = Url::parse(opened).map_or(Zone::Public, |u| written_zone(&u));
    written_zone(&to) <= from
}

fn refused(host: &str, zone: Zone) -> String {
    match zone {
        Zone::Local => format!("{host} is a local address, and only links you add yourself may lead there"),
        _ => format!("{host} is on a private network, and only links you add yourself may lead there"),
    }
}

pub fn check_url(url: &Url) -> Result<(), String> {
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(format!("Only http and https links are allowed, not {}", url.scheme()));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Links with credentials are not allowed".into());
    }
    if url.host().is_none() {
        return Err("The link has no host".into());
    }
    Ok(())
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

struct Guard {
    bound: Zone,
    proxies: Arc<HashSet<String>>,
}

impl Resolve for Guard {
    fn resolve(&self, name: Name) -> Resolving {
        let host = name.as_str().to_ascii_lowercase();
        let bound = if self.proxies.contains(&host) { Zone::Local } else { self.bound };
        Box::pin(async move {
            let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), 0)).await?.collect();
            if addrs.is_empty() {
                return Err(format!("{host} has no addresses").into());
            }
            if let Some(zone) = addrs.iter().map(|a| zone_ip(a.ip())).max().filter(|z| *z > bound) {
                return Err(refused(&host, zone).into());
            }
            let addrs: Addrs = Box::new(addrs.into_iter());
            Ok(addrs)
        })
    }
}

fn proxy_hosts() -> HashSet<String> {
    let matcher = hyper_util::client::proxy::matcher::Matcher::from_system();
    ["http://feedreader.invalid/", "https://feedreader.invalid/"]
        .iter()
        .filter_map(|u| matcher.intercept(&u.parse().ok()?))
        .filter_map(|i| i.uri().host().map(|h| h.trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase()))
        .collect()
}

#[derive(Clone)]
pub struct Net {
    public: reqwest::Client,
    private: reqwest::Client,
    local: reqwest::Client,
}

impl Default for Net {
    fn default() -> Self {
        let proxies = Arc::new(proxy_hosts());
        let client = |bound| {
            reqwest::Client::builder()
                .dns_resolver(Arc::new(Guard { bound, proxies: proxies.clone() }))
                .redirect(Policy::none())
                .user_agent(concat!("Feedreader/", env!("CARGO_PKG_VERSION")))
                .connect_timeout(Duration::from_secs(5))
                .build()
                .expect("http client")
        };
        Self { public: client(Zone::Public), private: client(Zone::Private), local: client(Zone::Local) }
    }
}

impl Net {
    pub fn client(&self, bound: Zone) -> &reqwest::Client {
        match bound {
            Zone::Public => &self.public,
            Zone::Private => &self.private,
            Zone::Local => &self.local,
        }
    }
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
    pub zone: Zone,
}

pub async fn fetch(
    net: &Net,
    url: &Url,
    bound: Zone,
    accept: &str,
    validators: Option<(Option<String>, Option<String>)>,
    timeout: Duration,
    cap: usize,
) -> Result<Fetched, String> {
    let work = async {
        let mut url = url.clone();
        let mut bound = bound;
        for _ in 0..=REDIRECTS {
            check_url(&url)?;
            let zone = zone_of(&url).await;
            if zone > bound {
                return Err(refused(url.host_str().unwrap_or_default(), zone));
            }
            let mut req = net.client(bound).get(url.clone()).header("accept", accept);
            if let Some((etag, lm)) = &validators {
                if let Some(e) = etag {
                    req = req.header("if-none-match", e);
                }
                if let Some(l) = lm {
                    req = req.header("if-modified-since", l);
                }
            }
            let mut resp = req.send().await.map_err(describe)?;
            if let Some(next) = redirect(&resp, &url) {
                url = next;
                bound = zone;
                continue;
            }
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
            let mut body = Vec::new();
            while let Some(chunk) = resp.chunk().await.map_err(describe)? {
                body.extend_from_slice(&chunk);
                if body.len() > cap {
                    return Err(format!("Response is larger than {} MB", cap / 1_000_000));
                }
            }
            return Ok(Fetched {
                status,
                url,
                etag,
                last_modified,
                kind,
                cache_control,
                retry_after,
                body,
                zone,
            });
        }
        Err("Too many redirects".to_string())
    };
    tokio::time::timeout(timeout, work)
        .await
        .map_err(|_| format!("Timed out after {} s", timeout.as_secs()))?
}

const REDIRECTS: usize = 5;

fn redirect(resp: &reqwest::Response, from: &Url) -> Option<Url> {
    if !matches!(resp.status().as_u16(), 301 | 302 | 303 | 307 | 308) {
        return None;
    }
    from.join(resp.headers().get("location")?.to_str().ok()?).ok()
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
