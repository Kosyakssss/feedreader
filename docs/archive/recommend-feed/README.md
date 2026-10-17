# The "I recommend" feed, as the Rust app built it

Archived from the Rust version (last commit `5dff2db`) so the web version can rebuild it. The full Rust code is still in git history.

## What it is

You recommend any entry, with an optional note. Your recommendations become one public Atom feed and one plain HTML page that friends can follow in any feed reader.

## How it works

- **One secret link.** Everything lives under `/<token>/`, where the token is a long random string kept in the app's settings. The page is `/<token>/` and the feed is `/<token>/feed.xml`. A wrong token gets a 404. There is one link for everyone, never linked anywhere public.
- **A separate listener.** The public feed is served on its own local port (8791 by default), apart from the app itself, so nothing else the machine serves becomes public.
- **Tailscale Funnel exposes only that port**, on one of the ports Funnel allows (443, 8443 or 10000; the app used 10000):

  ```sh
  tailscale funnel --bg --yes --https=10000 http://127.0.0.1:8791
  tailscale funnel --https=10000 off
  ```

  It checks that this machine is allowed to use Funnel (`tailscale status --json`, `Self.CapMap.funnel`) and that the mapping exists (`tailscale funnel status --json`, `Web.<host>:10000.Handlers./.Proxy`).

- **A reachability check from outside.** After publishing, and hourly, it asks Cloudflare's public DNS (`https://cloudflare-dns.com/dns-query?name=<host>&type=A`) for the machine's public address. It then fetches the link through that address, bypassing local DNS and proxies, and shows whether the internet can reach it.
- **Polite to readers.** Both documents carry an ETag derived from a hash of the feed, `Cache-Control: no-cache` and `X-Robots-Tag: noindex`. A matching `If-None-Match` gets a 304. Each client gets a burst of 20 requests, refilled at one per second (`limit.rs`).
- **The feed** (`public.rs`, `atom`):
  - `<id>urn:feedreader:<token></id>`, with self and alternate links.
  - Each entry's id is `urn:feedreader:<token>:<first 10 bytes of sha256(entry id), hex>`.
  - Each entry has title, link, `published`, `updated` (when you recommended it) and author (the source).
  - Content is the note as a blockquote, then "From <source>", then the full article snapshot. Friends' readers never fetch anything on your behalf.
  - Attachments are `rel="enclosure"` links.
  - A `feedreader:` namespace carries `note` and `source`.
- **Removing a recommendation** leaves an RFC 6721 tombstone, `<at:deleted-entry ref="..." when="..."/>`, so readers drop it. Removed items stay in the feed as tombstones for 60 days. The feed holds the latest 200.
- **The page** (`public.rs`, `page`) is a small monospace HTML list: titles linking to the originals, sources, notes and a "follow in any feed reader" link.

## Data

```sql
create table recommendations (
  entry_id text primary key,
  note text not null default '',
  title text not null,
  url text not null,
  source text not null,
  published integer not null,
  content text,
  at integer not null,
  removed_at integer
) strict;
```

Times are milliseconds since the epoch. `content` is the article snapshot taken when you recommended it.

## Files

- `public.rs`: the Atom feed, the HTML page and the public listener
- `tailscale.rs`: Funnel on and off, status, and the outside reachability check
- `limit.rs`: the per-client rate limit
