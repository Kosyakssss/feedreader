# Fetching

Spec §5.8 says what may reach where; this is why it is built the way it is (`crates/engine/src/net.rs`).

## Zones instead of a blocklist

A single list of forbidden ranges asked "is this address private?" when the question that matters is "who asked for this request?". It blocked feeds the owner wants (a NAS, a tailnet machine, a dev server on localhost) and needed a new exception for every unusual network, while the web pane loaded the same private addresses unchecked. Three ordered zones and one rule, a request reaches no deeper than whatever asked for it, keep what the blocklist protected (a public server can't steer the engine into the LAN or at 169.254.169.254) without refusing what the user typed.

## Who asked

Inside one task the asker is the previous server: `fetch` follows redirects itself, because reqwest's redirect policy sees URLs but not where they came from, and each hop's bound becomes the zone of the server that sent it. Discovery treats links on a page the same way.

Across tasks, content stored from a feed has no record of the server that delivered it, and keeping one would mean a zone column on entries and media that syncs. Instead the engine asks whether the content's host is one the user named: a followed feed's host or a saved link's host (`Store::named_hosts`). A feed's `site_url` doesn't count, because the feed itself writes it. This is a pure function of synced state, so the hub and satellites agree.

## Clients

reqwest takes one resolver per client, so `Net` holds three clients, one per bound. The resolver refuses names with any address deeper than its bound, and `fetch` checks the zone again before each request, which also covers IP literals the resolver never sees.

## 198.18/15

Fake-IP proxies (Clash, Surge) answer every lookup from 198.18/15 and route by the fake address. If that range were private, a public feed's images on a CDN host would resolve there and be refused, so it is public. A real 198.18 address is only a benchmarking network.

## Proxies

The system's proxy settings apply (reqwest's `system-proxy`). Through an HTTP proxy the target name never reaches our resolver, so the zone comes from this machine's own DNS, and a name it can't resolve counts as public. So an intranet name that only the proxy can resolve counts as public. The proxy's own host is read from the same settings and always passes the resolver, since otherwise a proxy named by a private hostname would refuse everything.

## The web pane

WebKit offers a navigation hook but nothing for subresources, so the pane checks top-level and frame navigations only: images and scripts on a public page can still load from the LAN, as in any browser. The hook runs on the main thread, where a DNS lookup would block input, so it judges only what the address says about itself: IP literals, `localhost` and `.local`. The page the pane opened is the bound, because opening it was the user's choice.

## Rate limits

`/v1/pair` shares the public listener's per-address token bucket (`limit.rs`). The hub sees peers directly; the public listener sits behind Funnel's proxy on loopback, so there it reads the last `X-Forwarded-For`. A local process can forge that header, but all it gains is a different bucket for its own requests, so it isn't checked further.
