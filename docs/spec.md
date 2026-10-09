# Feedreader 1.0 spec

The source of truth for what to build: product features, UX behavior and architecture. Visual design (look, layout, motion, components) is not decided here; it is designed with the owner in the real app. Working rules are in [`AGENTS.md`](../AGENTS.md).

Every decision below is the owner's unless marked **Proposed** (engineering choice, unconfirmed) or **Open** (§7).

## 0. Ground rules

- Full rewrite from zero, in place in this repository. The current app is a reference for behavior and edge cases only; do not copy its code. Its behavior and polish (selection, keyboard, refresh, speed) are the floor; its look is not.
- Fresh start for user data: people export OPML from the current app and import it. The current app keeps running until 1.0.
- Tests are laws (§5.10). Everything else is verified by running the app.

## 1. Product

### 1.1 Goal
Get off social media without losing the people and sites you follow. One calm, finite place for everything that publishes a feed, running on your own devices. Recommendations come from friends, not algorithms.

- Finite lists, no ranking, no suggestions, no notifications about new items, no badges.
- Feeds only, and every feed is equal. RSS, Atom and JSON Feed in whatever form they come: a blog, a newsletter, a YouTube channel's feed, a podcast feed, a Nitter feed. No source gets its own look, player, view or plugin.
- Self-reliant apps: every app carries the engine and works on its own; devices sync whenever they can reach each other.
- Your device, your software: no app stores, no developer accounts, no cloud service run by us, no accounts required.

### 1.2 Non-goals
Anything source-specific: YouTube or podcast apps inside the app, SponsorBlock and the like, Bluesky, Mastodon, newsletters read from a mailbox, post or thread views. X / Twitter support of any kind. A timeline view. Ranking or "for you", including by LLM. People entities, a friends view or a social graph. An undo history panel. One-off share links. Editions. Music. App stores and developer accounts. Windows. iOS for now. Docker. Splitting work between engines.

### 1.3 Scope
1.0 is everything here not marked Later, on: the desktop app (Electron, macOS and Linux) with its background server, the web app, and the TUI. Android is designed in from the start and carries the engine; whether it ships in 1.0 or right after is Open.

## 2. Features

### 2.1 Feeds
- RSS, Atom and JSON Feed, read fully: content, summary, author, images (including Media RSS thumbnails), attachments (enclosures), categories and feed metadata.
- Every entry is a row in the list and opens the same way.
- A feed's label is its own title, then the user's rename.

### 2.2 Attachments and embeds
- Audio and video attachments play in the platform's built-in player: the browser's own `<audio>`/`<video>` on web and desktop, the system player on Android, the system opener from the TUI. No player of our own. Other attachment types are plain links.
- Embeds in entry content (for example a video embedded in a blog post) render as real embeds in Clean and Feed views.
- Attachments are cached like images (§5.6) so they play offline and never from the publisher at reading time. Devices keep them for the same entries they keep content for (§5.2).

### 2.3 Discovery
- Every place that offers "add feed" (the add field, Original tabs, links inside entries, saved links) finds **all** feeds a site offers and shows a picker: title, type (all posts, category, comments), last post date, a preview of recent items, and optional "add to folder".
- Ladder: `<link rel=alternate>`; common paths (`/feed`, `/rss`, `/rss.xml`, `/atom.xml`, `/index.xml`, `/feed.json`); platform URL patterns (WordPress, Ghost, Substack, Medium, YouTube channel or handle → `feeds/videos.xml?channel_id=`); JSON-LD and h-feed; sitemaps; LLM recipes (§2.10). Scheme-less input works.
- A discovered feed is validated with a real fetch and parse before saving. Knowing where a platform keeps its feed is discovery only; what it finds is an ordinary feed.

### 2.4 Reading
- Three modes for any entry: **Clean** (Defuddle extraction of the original page, the default), **Feed** (the feed's own content, falling back to extraction when missing or truncated) and **Original** (the real page).
- The default is set in Settings and can be overridden per feed; switching mode in a tab is remembered per feed.
- Opening an entry marks it read: in a tab, in a background tab, in the system browser, one or many at once. The read toggle marks it unread again and undo reverts it.
- Links inside an entry open as new in-app tabs. A tab opened from a link that isn't a followed feed or a known entry offers both **Add as feed** (discovery and picker) and **Bookmark** (keeps it as a saved link).
- Clean view reading settings: font (system or Libron, shipped with its license), text size, column width.
- The web client opens Original as a real browser tab (sites forbid embedding; proxying breaks them). The desktop app opens it in its own web view per tab, with ad and tracker blocking.

### 2.5 Bookmarks and saved links
- Bookmarks are for reading later, newest-bookmarked first.
- Saved links: keep a page without subscribing. Paste, share sheet, bookmarklet, `feedreader add <url>`, or Bookmark in a tab opened from a link. The page is fetched and extracted, auto-bookmarked, marked as a saved link, and keeps its extracted text permanently. If the site has a feed, "Follow this site?" is offered once.

### 2.6 Organizing
- Folders, non-exclusive: a feed can be in several. Each folder is a view. No other grouping, no automation.
- Pinned feeds, shown next to the views. Folders and pins share one limit so the list of views never scrolls (number decided during build).
- Unread counts only on folders and pinned feeds.
- Per feed: rename, pin, folders, "hide from Home" (shows only in its folders), reading-mode override, rule tweaks, refresh cadence info, errors with details and retry.
- Feeds page sorted by unread count, then name.
- Unsubscribing keeps the feed's bookmarked and recommended entries; the rest is pruned after the undo window.
- OPML import and export keep folders both ways (a non-feed outline containing feeds is a folder; a feed in several folders is written once per folder and merged on import).

### 2.7 Rules
- Mute words and merge duplicate links (the same link from several feeds shows once).
- Set globally, with separate tweaks per feed and per folder. "Mute word" is also a quick action on an entry.
- Rules are pure transforms over raw entries: removing a rule brings back what it hid. The engine computes them, so counts and filters agree on every device.

### 2.8 Friends: the "I recommend" feed
- Recommend any entry, with an optional note up to 280 words that friends see as a quote above the entry. Works from a tab and as a bulk action.
- Your recommendations form one public Atom feed, served by the hub's public listener under one long unguessable URL: one link for everyone, no per-friend links, `X-Robots-Tag: noindex`, never linked anywhere public.
- The feed carries full snapshots (text and images, served from the hub's cache), so friends' readers never trigger fetches on your behalf.
- Removing a recommendation (or undoing one) after friends fetched it appends an RFC 6721 tombstone; Feedreader drops tombstoned items on next fetch, other readers may keep them.
- A `feedreader:` Atom namespace carries the note, original source and original link; other readers see the note above a link.
- The same URL in a browser shows a read-only page (guest mode of the web app) with Open Graph previews, "Open in Feedreader" (subscribes) and "Follow in any feed reader".
- Friends' feeds are ordinary subscriptions: they show in Home and can be pinned or foldered. You don't see who follows you.
- The I recommend view shows the feed as friends see it, with remove and copy link.
- Recommending works on any device, offline too; it publishes when the command reaches the hub. Friends get what they missed whenever their reader fetches while the hub runs. Public route: Tailscale Funnel.

### 2.9 Search and command palette
- An fzf-like palette over entries (titles and full text), feeds and folders, with filter words `is:unread`, `in:folder`, `from:feed`. Backed by SQLite FTS5 on every engine and client database.
- Cmd-K on desktop opens a command palette for settings and commands. Nothing equivalent on phones.

### 2.10 Sites without feeds: LLM recipes
Off until an LLM provider is set up.
- Discovery first; the LLM only if a provider is configured.
- The LLM writes a declarative recipe (selectors for item, title, link, date, summary, image, next page; detail strategy; static or browser rendering; checks), never code. The engine runs it and validates it (items found, links resolve, dates parse, titles unique); the user previews and confirms.
- Self-healing: when checks fail, the LLM repairs the recipe; after engine checks and LLM verification the repair applies automatically with a quiet notice and one-click undo. The last working recipe is kept.
- Recipes are user state and sync, so a satellite can run static ones while the hub is away. Writing and repairing happens on the hub, where the keys are.
- Providers: direct APIs and local models (pi-ai: API keys, OpenRouter-style, Ollama, LM Studio) and installed agent CLIs (Claude Code, Codex, OpenCode, Pi). Keys stay on the hub and never sync.
- Guardrails: never ranks; only the slimmed public page is sent; one call per new site and per repair; a daily cap shown in Settings.
- A headless browser (Chromium, downloaded on demand) for JS-only sites, on desktop and server engines.

### 2.11 Plugins
- Built-in features are plugins: feeds, saved links, extraction, discovery, folders and rules, friends, routes, OPML; recipes, LLM providers and the headless browser are off until set up.
- Personal plugins (for example translation or summaries) are dropped into a plugins folder or installed from a repository address, hot-loaded, run on desktop and server engines, and never rank. Daily update check, automatic when compatible (option: ask first); checksum verified; full trust inside the engine with the origin shown.
- Manifest: name, version, compatible engine range, required helper programs, permissions (network domains, secrets), risk notice.
- Plugin UI reaches clients only by description (status lines, buttons, lists, forms) rendered by each client. Plugins never ship client code.

### 2.12 Households
Several people per engine, each with their own subscriptions, state, folders, pins, rules, recommendations and tabs; fetching of shared feeds happens once. Each paired device belongs to exactly one person; a shared computer switches person explicitly. The first person is admin and adds others. In the data model from day one.

### 2.13 Themes
A theme is one CSS file of color variables declaring its `color-scheme`. Export a complete template, import a file; saving a theme file updates running apps instantly. Each file is validated on its own and the last good version is kept. Appearance follows the system by default.

### 2.14 Your data
- Full export and import of personal data (subscriptions, folders, bookmarks, saved links, recommendations, rules, settings) as a versioned bundle, beyond OPML. Secrets are excluded.
- Move to another machine: pair the new engine, transfer state and settings directly, make it the hub, repoint devices and the public link.

### 2.15 Command line
The `feedreader` command is the engine: `serve`, `service install`, `setup`, `pair`, `add <url>`, `plugin add <repo>`, `upgrade`, and `unread` (unread entries as a Markdown list, for scripts and agents). Bare `feedreader` opens the TUI, starting or attaching to the local engine; `--server URL` attaches to a remote hub.

## 3. UX

### 3.1 Views and navigation
- Views: Home (everything from every subscription not hidden from Home), Bookmarks, I recommend, folders and pinned feeds. Library: Search, Feeds, Folders, Settings.
- Opening the app lands on Home and restores the last place.
- Navigation is layered: tabs lie on the list, the list lies on the side navigation. Swiping right peels back one layer: inside a tab it goes back through the tab's history, then closes or leaves the tab, then reveals the library side. Swiping left reveals the views side. Forward is buttons and keys only. On Android the system back gesture equals swiping right.
- Desktop swipes are two-finger trackpad swipes (no click-drag), plus a shortcut not yet chosen. Phones swipe from anywhere. Which side holds views and which holds the library is swappable. Swipes snap with rubber-banding past the end; thresholds are tuned to be less sensitive than early mockups.
- Inside an Original page that scrolls horizontally, the gesture passes to us only after the page reaches its edge.

### 3.2 The list
- One long chronological list is the only way to browse. Seamless loading while scrolling; a quiet "That's everything" at the end. Relative times, exact on hover.
- A toggle between Unread (default) and All.
- Marking something read while viewing never moves or removes rows under the cursor. New entries arriving while scrolled down never shift what you're looking at (scroll anchoring).
- Refresh is `r` or pulling down hard (also on desktop trackpads). There is no refresh button.
- No per-row swipe actions.

### 3.3 Selection and bulk actions
- Drag across checkboxes to paint a range (thresholds 6 px mouse, 8 px pen, 10 px touch; suppress the click after a drag); Shift-click for a range; keyboard move with Shift to extend; `x` to toggle.
- Press-and-hold on a row selects it and starts a drag selection on touch.
- While anything is selected, a bulk bar offers: Mark read, Mark unread, Open, Bookmark, Recommend, Cancel.
- **Mark all read** marks everything in the current view read. Undoable. In the list toolbar and the command palette, no shortcut yet.
- **Open all unread** opens every unread entry in the view as tabs and marks them read. It asks "Are you sure?" when that's more than 20. Entries without links are skipped. In the plain web client, Original mode opens real browser tabs; when the browser blocks them, the client shows a one-time "allow pop-ups" hint with per-browser steps, then opens the rest.

### 3.4 Tabs
- Click opens an in-app tab, growing out of its row. Cmd-click opens the system browser. Middle-click opens a background tab.
- Each tab has its own back/forward history. Close with Cmd-W, middle-click or the close control; reopen with Cmd-Shift-T. No close-all, never closed by age. Tabs reorder by dragging (not the first, view tab). Multiple windows: Later.
- New tabs open right of the current one; background tabs line up after it in order.
- **Peek and kept.** A tab remembers its opener. A tab you opened, read and went back from at the start of its history is a peek: it closes and returns you to the exact spot in its opener, row briefly highlighted. A tab becomes kept when opened in the background, when you switched away and came back, or when you dragged it. Kept tabs close only explicitly. Cmd-Z reopens a closed peek.
- Tabs persist across restarts and updates with their mode, history and scroll position, and are shared across devices: a tab opened on the Mac is on the phone at the same position. Closing a tab closes it everywhere. Which tab is active stays per device.
- On phones, tabs switch by swiping the bottom bar sideways and are listed by swiping it up.

### 3.5 Undo
- Linear, per client, persistent across restarts, covering the last 24 hours. Cmd-Z / Cmd-Shift-Z. Doing something new after undoing discards the redo branch.
- Covers every state change made on that client: read/unread, bookmarks, saved links, opening and closing tabs, a tab's mode, bulk actions, subscribe/unsubscribe, folders, pins, rules, settings, recommendations. Not switching tabs.
- Each undo and redo shows a brief notice of what changed.

### 3.6 Refresh feedback
Refresh status is visible only while something happens and briefly after: all fine disappears quietly, some or all feeds failing shows briefly as a warning or failure. Errors and per-feed details live only on the Feeds page. The status keeps accurate progress and accessible live text.

### 3.7 Keyboard and input
- Carried over: 1–4 navigation, j/k next/previous, h/l the Unread/All toggle, o open, Shift-O open all unread, m toggle read, s toggle bookmark, x select, r refresh, ? shortcuts, Esc close/clear. Feeds page: j/k, Shift-J/K, o/Enter, a add, d remove, i import, e export.
- Fixed new ones: Cmd-Z, Cmd-Shift-Z, Cmd-W, Cmd-Shift-T, Cmd-Shift-[ and ], Cmd-Shift-C (copy the original link), Cmd-K.
- `a` for mark all read stays retired. Everything else is designed with the owner later; never add shortcuts unilaterally.
- One keymap and focus-layer system across tabs, palettes, navigation, sheets and dialogs: no shortcuts while typing, in dialogs or with modifiers; Escape blurs, then clears, then closes. The command palette builds on the same registry.
- Every gesture has a keyboard and screen-reader equivalent. Keep today's accessibility: live regions, progress semantics, labels and pressed states, `dir=auto` titles, reduced motion, 44 px touch targets, safe-area insets.

### 3.8 First run
- Desktop: start the background server (or attach to one); import OPML or start empty; "Where will you use Feedreader?" (this Mac / my Wi-Fi / away → Tailscale); optional features stating what each needs (accounts, cost, download size): LLM recipes, the public recommendation link, JS-only sites. Everything is reachable later in Settings.
- Android: pair with a hub by QR code, or start on its own and pair later.
- Servers: `feedreader setup` asks the same in the terminal.

## 4. Settings scope
- Per person, synced: almost everything, including theme and appearance, reading settings, navigation sides, views, reading modes, rules, folders, pins, shortcuts. "System" appearance still follows each device's system.
- Per device: the active tab, window size and layout, the local cache, OS permissions.
- Engine-wide, in a strict TOML file written atomically (mode 0600): port, retention, trusted origins, plugin installs, refresh limits, background server on/off. Unknown keys are rejected and limits enforced.

## 5. Architecture

### 5.1 Shape
- **Engine:** one Effect program that owns user state, fetching, plugins, the private API, the public listener and the scheduler. Every app carries it.
- **Hub:** one engine per setup, normally the Mac's background server. It holds the authoritative user state, refreshes on its own, serves the web app and the public feed, and is what devices pair with. The first engine you set up is the hub.
- **Background server (OpenCode v2 model):** on launch the desktop app looks for an engine on its machine (a lock file with port and pid in the data directory, then a health check) and attaches; otherwise it starts one as a background process. The engine keeps running after the app quits, so refresh, sync, the web app and the public feed keep working. Turning it off makes the engine a child of the app. Quit completely and Restart stop or restart both.
- **Satellites:** engines on other devices paired with a hub (Android, a desktop on another computer). Connected, they sync with the hub and take fetched content from it. When the hub is unreachable they refresh feeds themselves and keep working fully; everything syncs when the hub is back. Satellites never serve other devices.
- **Clients:** built the way t3code builds its apps: one React web app for desktop (Electron) and web (served by the hub); Android in Expo / React Native with its own screens; the TUI on OpenTUI. The web app is a plain client of the hub, because browsers can't fetch other sites' feeds.
- `feedreader serve` runs headless; `feedreader service install` installs launchd/systemd units.

### 5.2 Data and merging
- Fetched content (entries, extracted bodies, images, attachments, favicons) is a cache. The engine that fetched it owns it; the hub ships it to clients and satellites, and it never flows back.
- User state (read, bookmarks, saved links, positions, subscriptions, folders, pins, rules, recipes, recommendations, settings, tabs) syncs everywhere; the hub holds the authoritative copy.
- Every change to user state is a **command**. The engine applies it to state tables and appends it to the **change log** with the next sequence number. State tables are the truth; the log is for catch-up, live pushes and undo (not full event sourcing).
- Clients and satellites keep a local SQLite database (WASM on OPFS in the web and desktop UI, `bun:sqlite` in the TUI, the engine's own database on Android). The UI reads only from it, so it's instant and works offline. Actions apply locally first and go into an **outbox**, each with an idempotency id; the hub assigns the sequence number and pushes to other devices; rejections roll back and resync.
- What a device keeps: all user state; content for unread entries, bookmarks and open tabs (bodies, images and attachments, prefetched); read entries of the last 3 days. Older content is paged from the hub on demand.
- Ids are the same on every engine: the feed id derives from the normalized feed URL (scheme, trailing slash, final redirect) and stays fixed if the feed later moves; the entry id is `feedId:encodeURIComponent(sourceId)`, with `sourceId` = guid, else safe URL, else title. Dedupe per feed on sourceId, on URL when present, on title when URL is empty.
- Entries can update (edited, late bodies, images) without touching state: identity stays, content is versioned separately.
- Ordering key: published time, falling back to first-seen, tie-broken by id. Stable under updates and identical on hub and satellites.
- Commands that keep an entry around (bookmark, recommend, open in a tab) carry a small snapshot (title, link, feed, dates) so other devices can show it before fetching it. State for an entry an engine hasn't seen yet applies when it arrives (Proposed: dropped after 30 days).
- The engine computes per-person derived flags (hidden by rules, merged duplicates) and ships them with entries, so clients compute counts locally and agree.
- Merge: single values are last-write-wins by hybrid logical clocks. Sets (subscriptions, folder membership, pins) are add/remove sets, add wins. For tabs, closing wins over a concurrent scroll update.
- Undo: every mutating command declares its inverse; clients build undo from it. Unsubscribe is a soft delete kept for the 24-hour undo window. Undoing a recommendation after a friend fetched it appends a tombstone.
- Catch-up: a persistent, monotonically increasing revision; reconnecting devices request changes since N, with a full snapshot if N is too old.

### 5.3 API and transport
- `packages/contracts`: Effect Schema for every request, response and event, imported directly by every app. An OpenAPI document for third parties.
- One WebSocket per client or satellite carrying typed requests and live streams (Effect RPC, as in t3code): commands, queries, catch-up, and pushes (entries, state from other devices, refresh progress, plugin status, tabs). Keepalives, slow consumers dropped, resume from the last sequence.
- Plain HTTP for images and attachments, the public listener, OPML and data-bundle uploads, and health.
- Version handshake on connect; mismatches show "Update the engine" or "Update the app". Hub and satellites on different versions keep syncing within a compatibility window.

### 5.4 Connectivity and pairing (t3code model)
- The desktop app on the engine's own machine is trusted silently. Every other client and satellite pairs once with a one-time link or QR code (Settings → Devices, or `feedreader pair`), over localhost, the same network or Tailscale, http or https. Pairing becomes a long-lived, revocable session per device: a cookie for browsers, a token for the TUI, satellites and remote desktop apps.
- Routes: same network and Tailscale. The hub runs `tailscale serve` for the private API (tailnet only) and `tailscale funnel` for the public listener; it re-asserts both every 60 s without clobbering other served paths and adds its MagicDNS name to the allowed hosts. Funnel is the only public route in 1.0; Cloudflare tunnels are Later.
- Satellites remember every address the hub was reached on and try them in turn. Routes recover after sleep without re-pairing.
- Private API: exact Host allowlist (DNS rebinding), and for mutations an allowed `Origin` and `Sec-Fetch-Site`. JSON bodies need a JSON content type and are capped at 2 MB (413 before dropping the socket); uploads stream with their own limit. Configurable base path so Tailscale Serve can mount it on a sub-path.
- Public listener: a separate port on the hub; serves only the I recommend feed, its page and snapshot images. No auth, read-only, rate-limited, its own CSP and path prefix.
- App CSP stays strict: images from the engine only, no third-party frames except entry embeds (§2.2). Original pages live in desktop web views outside the app's CSP.
- Later: install on a server over SSH.

### 5.5 Refresh
- The hub refreshes every 5 minutes whenever it runs, clients attached or not, and pushes results. No refresh on attach. Manual refresh fetches every feed now (on the hub when connected, locally otherwise).
- Satellites don't fetch while connected. When the hub is unreachable they refresh on the same schedule; Android refreshes while open and through a background task (mechanism Open). Nothing they fetched is uploaded later: the hub fetches its own copy and ids match.
- Per-feed adaptive cadence, 5 minutes at the fastest: slow down for rarely changing feeds; honor `Cache-Control`, `Retry-After`, 429/503; back off exponentially on errors, capped. Conditional requests with `ETag`/`Last-Modified`. Retry and backoff state persists. Exact algorithm Open.
- 8 parallel fetches globally plus per-host politeness.
- Status events: run id, start/finish, total/completed/succeeded/failed, failures with feed and error. Clients ignore status that would go backwards.

### 5.6 Retention and the media cache
- Entries: max count (default 3000, range 100–100000) and optional max age in days (1–36500). Pruning never removes bookmarked entries, saved links or entries in your I recommend feed. Saved links keep their extracted body.
- The engine caches everything an entry references: inline images, thumbnails, favicons and attachments (audio, video, files). Clients load them from the engine, never from third parties at reading time (blocks tracking pixels and IP leaks), and they work offline.
- An entry's cached media is deleted 7 days after it's read, unless it's bookmarked, saved or recommended.
- Limits: a per-item cap (larger items aren't cached and stay links) and a total budget shown in Settings with current usage; over budget, oldest-read goes first. Cached content is compressed to efficient formats. Values Open.

### 5.7 Engine internals
- **Core** (not plugins): storage and migrations, commands and the change log, sync, auth and pairing, the job queue, the scheduler, the HTTP/WebSocket servers, the secret store, the media store.
- **Platform layers:** the core uses only Effect platform services (file system, HTTP client, SQL, key-value store, HTML parsing, sockets). Bun layers on desktop, server and TUI; native layers on Android (`expo-sqlite`, React Native networking, a JS DOM for Defuddle). No Bun-only API outside the Bun layer.
- **Job queue:** one durable, prioritized SQLite queue for everything slow (fetches, extraction, media caching and compression, recipe runs and repairs). Per-host limits. Survives sleep, crash and restart; never on a request path.
- **Content vs state:** entries belong to feeds and are shared across a household; state belongs to a person.
- **Plugin runtime (OpenCode 2 "reloaded"):** plugins never mutate shared data. Each registers transforms on a `State`; rebuilding starts empty and applies all transforms in order. Adding, editing or removing a plugin re-registers its transforms and rebuilds affected states. States: source types, subscriptions, rules, extractors (Defuddle, feed content, site-specific, LLM fallback), routes, LLM providers. Plugins run inside the engine process; a crash is contained where possible, otherwise the service restarts the engine. Helpers (headless Chromium) are separate processes.
- **Source plugin interface:**
  ```ts
  interface SourcePlugin {
    id: string
    claim(url: URL): Option<SourceRef>
    fetch(ref: SourceRef, cursor?: Cursor): Stream<Entry, FetchError>
    resolveItem?(url: URL): Effect<Entry, FetchError>
    cadence?(ref: SourceRef): Schedule
  }
  ```
- **Entry model:** `id`, `feedId`, `sourceId`, `url`, `title?`, `author?`, `published`, `summary`, `content`, `images[]` (with dimensions), `attachments[]` (URL, type, size), `origin` (subscription, saved, friend feed). No kinds.
- **Secrets:** a secrets folder in the engine's data directory, owner-only (folder 0700, files 0600, atomic writes), the same on a Mac and a headless server. Never synced, exported or logged.
- **Supervision:** launchd `KeepAlive` and systemd `Restart=on-failure`; the desktop app restarts the engine if it dies. Graceful shutdown drains with a 10 s hard timeout.
- **Diagnostics:** one JSONL file per day, 7-day retention, in `~/Library/Logs/feedreader` or `$XDG_STATE_HOME/feedreader`, with per-plugin channels. Never log secrets, cookies or link tokens. A health endpoint reports pid, uptime, data dir, port and refresh state.
- **Migrations:** schema versioned; never touch the original, back it up, check integrity, swap atomically; unknown versions are refused with a message. On the hub and on satellites.

### 5.8 Outbound fetching safety
- Only http/https; no credentials in URLs. Block `localhost`, `*.localhost`, `.local`, and 0.0.0.0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0/24, 192.0.2/24, 192.88.99/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24, 224/3, ::/128, ::1/128, fc00::/7, fe80::/10, fec0::/10, ff00::/8, 100::/64, 2001:db8::/32, including IPv4 embedded in IPv6 transition ranges (6to4, Teredo, NAT64, mapped/compatible).
- Resolve every A/AAAA record and require all public; connect to the resolved address with the original Host and TLS name (no rebinding window). Manual redirects, at most 5, each checked; strip `Authorization` and `Cookie` across origins.
- Timeouts: feed 8 s, discovery 10 s, probes 5 s. Body caps: 10 MB feeds, 2 MB HTML discovery; media caps per §5.6.
- Every plugin and every platform layer uses this fetcher, Android included. Original pages are real browser views and are not proxied.

### 5.9 Patterns adopted from t3code
t3code's stack and practices, with Bun instead of Node. Read the matching t3code source before building each part.

**Commands and side effects**
- The engine serializes commands and decides outcomes from current state without I/O. One SQLite transaction commits the state change, the change-log entry, the command receipt (idempotent retries) and any outbox effects. Subscribers hear about it only after commit.
- A worker runs outbox effects (fetch, extract, cache media, publish to the I recommend feed) after commit and feeds results back as commands. An acknowledgement means the intent is committed, not that the work is done.
- Stored commands and change-log entries stay decodable forever.

**Connection runtime** (`packages/client-runtime`, shared by every client and satellite)
- One connection owner per hub; a single supervisor owns retries: jittered exponential backoff capped at five minutes, reset only after the connection stays up. Offline or failed auth waits for a wakeup (network change, foreground, explicit retry).
- Foregrounding, a retry or an offline report first probes the session and reconnects only if the probe fails. After a long mobile suspension the session is replaced at once.
- Transport health and data freshness are separate. Cached data stays readable offline, never pretends to be live, and never overwrites newer live data.
- Subscriptions carry only what the client is looking at; a view's stream is shared and stops when the last viewer leaves, with a short idle cache.
- Reconnecting never replays mutations blindly; retry and idempotency belong to each command.

**Pairing and authorization**
- Pairing grants scopes; exchanging a credential can narrow a grant, never widen it. Ordinary pairing grants no device-management authority. Every RPC declares its scope and is checked before the handler runs. Households map onto this (admin vs person).
- Device lists and pairing links never contain recoverable secrets; only the creation response shows a raw credential.
- A pairing link carries its secret in the URL fragment; the client exchanges it and strips it from history.
- Browsers authenticate the socket with their cookie; token clients get a short-lived socket ticket over authenticated HTTP so long-lived tokens never appear in URLs.
- HTTP credentials renew without touching a healthy socket.

**Identity and routes**
- The hub has a stable id, created atomically once. Addresses are reachability hints; only the connecting device can prove a route works; nothing falls back to a loopback address that means another machine. Tailscale is just another address.

**Versions and capabilities**
- Apps, satellites and the hub upgrade independently. Clients use the capabilities the hub advertises.

**Payload budgets**
- Cold opens and catch-up are bounded (about 1 MiB and a fixed number of rows or events, then a snapshot fallback); older data comes in bounded pages without disturbing scroll; large bodies stay out of list payloads. Change-log cursors seek an index, never scan.

**Engine updates**
- A small stable launcher owned by launchd/systemd is the only writer of service state. An update starts the new version as a trial that must finish migrations and bind its ports before the launcher commits it; otherwise it rolls back. The launcher snapshots the SQLite files first, so migrations are reversible. Clients confirm an update by its id after reconnecting.

**Desktop shell**
- The renderer loads the bundled UI from disk through our own URL scheme; API traffic goes to the engine. The app opens instantly with a local engine, a remote hub or the background server off.
- Risky native work (headless Chromium) runs in child processes with deadlines, never in the Electron main process. Background Original web views are suspended to bound memory.

### 5.10 Laws
Behavior that must hold for every input, checked by generated-input tests. This list is approved; new laws are added with the owner.
- **Sync:** applying a command twice equals applying it once. Delivering the same commands in any order converges to the same state everywhere. A client reconnecting after any offline period ends with the hub's state once its own queued changes merge. Last-write-wins never lets an older change beat a newer one, even with wrong clocks. Add wins over a concurrent remove.
- **Undo:** doing then undoing a command restores the previous state within the 24-hour window. Redo after undo equals the original command.
- **Counts:** the unread count of any view equals the number of unread, not-hidden entries in it, on every client.
- **Parsing:** every feed in the corpus of real-world oddities (encodings, broken XML, missing dates, relative links, duplicates) yields entries with stable ids; parsing twice yields the same ids; nothing crashes on arbitrary input.
- **Identity:** two addresses of the same feed never create two subscriptions.
- **Outbound safety:** for any URL and redirect chain, nothing is fetched from a private, loopback or reserved address.
- **Retention:** pruning never removes a bookmarked, saved or recommended entry; cached media never exceeds the per-item cap or the budget.
- **Ordering:** list order is stable under entry updates and new arrivals.
- **Satellites (Proposed, needs approval):** two engines fetching the same feed document independently produce the same entry ids; a feed subscribed on two offline devices ends as one subscription; after a satellite that worked offline reconnects, it and the hub hold the same state containing every change either side made, merged by the sync rules, including changes to entries the hub hadn't fetched yet.

### 5.11 Storage sketch (Proposed)
Tables (u = per person): `people`, `devices`, `peers`, `feeds` (id from normalized URL, url, label, plugin, cadence state, etag, lastModified, health), `subscriptions` (u, feed, mode override), `folders` (u), `folder_feeds` (u), `pins` (u), `entries`, `entry_bodies` (clean, feed, extracted at), `entry_media`, `states` (u, entry, read, readAt, bookmarked, bookmarkedAt, savedLink, position, snapshot, hlc; no foreign key on entry), `recommendations` (u, snapshot, note, sentAt, removedAt), `rules` (u), `recipes`, `tabs` (u, order, opener, entry/url, mode, history, scroll), `settings` (u and global), `plugin_state`, `outbox_receipts`.
SQLite: WAL, foreign keys on, busy timeout 5 s, `synchronous = FULL`, STRICT tables.

### 5.12 Stack and repository
- TypeScript with Effect 4 throughout (pin versions; some modules unstable). Bun on desktop, server and TUI (`bun build --compile` for macOS arm64/x64 and Linux arm64/x64 glibc/musl); on Android the same engine code runs in React Native (Hermes).
- Effect services and layers following t3code's conventions (one module per service: tagged errors, `Context.Service`, `make`, `layer`; consumers import modules as namespaces); Effect Schedule for refresh and retries; Effect RPC and Stream for the API.
- Web and desktop: React, Vite, TanStack Router, Effect atoms. Android: Expo / React Native with Reanimated and Gesture Handler on the UI thread, `react-native-webview` for Original, built locally (no Expo account or cloud builds). TUI: OpenTUI with React, full mouse support.
- Toolchain as in t3code: Vite+ (`vp`), TypeScript 7 with `@effect/tsgo`, Vitest, Oxlint, Oxfmt, knip, version catalogs. Bun replaces Node and pnpm.
- Layout (Proposed):
  ```
  apps/      engine  web  desktop  mobile  tui
  packages/  contracts  engine  platform-bun  platform-native  client-runtime  design  plugin-sdk
  plugins/   feeds saved reader discovery folders rules friends recipes llm tailscale opml headless
  ```
- `.repos/` holds pinned read-only checkouts of t3code, Effect and OpenTUI (gitignored, synced by a script).

### 5.13 Performance tooling
Performance is a first-class goal, reached by many small optimizations rather than cutting the look. Built early:
- A scenario driver replaying absurd amounts of user-like interaction (scrolling, hundreds of tabs, swipes, bulk actions, refresh storms) against synthetic data at extreme scale (hundreds of feeds, tens of thousands of entries, heavy media).
- Frame-time, long-task, layout/paint and memory instrumentation with an in-app debug overlay and machine-readable reports.
- Budgets per interaction (scroll and gestures at the display's refresh rate, tab open within one frame of input latency) and payload budgets (§5.9), checked on every change.
- Gestures follow the pointer 1:1 and hand velocity to a spring; only transform and opacity animate; no layout during gestures; long lists virtualized; on Android gestures run on the UI thread.

### 5.14 Packaging and distribution
- Artifacts: the desktop app (macOS DMG, Linux AppImage), the `feedreader` command (engine, TUI, web app, built-in plugins), the Android APK. No Docker, no Windows.
- Helpers on demand: headless Chromium downloaded only when needed, checksum-verified, updated monthly.
- Updates: our own desktop updater (Electron's needs Apple signing): checks GitHub releases, verifies our signature, downloads in the background, swaps app and engine together on next launch with a small notice. `feedreader upgrade` for the command.
- No developer accounts: macOS install via `curl … | sh` (no quarantine), a DMG (one-time "Open Anyway") and our own Homebrew tap. Android via GitHub Releases and Obtainium; we don't register for Google's developer verification. No iOS path without an Apple account.
- External services: the core needs none. Tailscale (free) for remote access and Funnel; an LLM key or local model for recipes.

### 5.15 Build order
1. Foundation: monorepo, contracts, engine core with Bun layers, storage and migrations, plugin runtime, scheduler, feeds plugin, WebSocket API, pairing.
2. Client shells: Electron starting or attaching to the background server, web app, TUI, themes.
3. List parity with today: selection, bulk actions, keyboard, retention, OPML, Feeds page, refresh status.
4. Navigation, views, folders, pins, settings, search.
5. Tabs and reading: modes, Original views, history, sync, undo, links, discovery picker, saved links, media cache.
6. Friends: I recommend feed, public page, public listener, Funnel.
7. Satellites and Android.
8. Discovery ladder, LLM providers, recipes, headless browser.
9. Households, onboarding, packaging, updaters, install script, Homebrew tap.

## 6. Carried over from the current app
Hard-won behavior to keep, beyond what's above:
- Feed parsing: `Accept` for RSS, Atom, JSON Feed and XML. Encoding from BOM, XML declaration, then `Content-Type` charset, with unusual encodings decoded before parsing. On broken XML, undeclared entities are repaired (common HTML entities mapped, the rest escaped, DTD declarations respected). Entities decoded after parsing (double-encoded titles). Tag-like text in titles is kept; only formatting tags are stripped.
- Dates: native parse, then RFC 822 with two-digit years, named US zones, numeric offsets and military zones as UTC, with calendar validation; missing dates fall back to fetch time.
- Feed health: garbage XML is an error but an empty valid channel is healthy; validators update only on success; 304 keeps them.
- Atom links prefer `rel=alternate`; unsafe links are dropped and the entry kept without a link.
- Writes racing a feed deletion are dropped; preserving newer state during live sync; recovering sync after suspension or stalled requests.
- No flash of a settled refresh status or counts on first paint; refresh progress reads smoothly even when fetches are instant.
- TUI: minimum size with compact layouts, hover hints with shortcuts, mouse selection, offline notice, appearance detection, OPML export that never overwrites.

## 7. Open questions
1. Android timing (1.0 or right after) and its background mechanism (periodic task or foreground service with a permanent notification).
2. Adaptive refresh algorithm.
3. Media cache limits: per-item cap and total budget for images and attachments; whether phones prefetch large attachments on metered networks.
4. Compression of stored content: formats, quality, and when it runs.
5. Embeds: load immediately or on click (they reach the embed's site and need a CSP exception).
6. I recommend image snapshots.
7. The combined limit for folders and pinned feeds.
8. Desktop shortcut for revealing navigation; the full keyboard map.
9. License: AGPL-3.0 (keeps hosted and modified versions open) or MIT (maximal reuse) were the leading options. Copyright on AI-written code is unsettled.

## 8. References
- [OpenCode reloaded](https://anoma.ly/notes/opencode-reloaded) · [OpenCode v2](https://opencode.ai/v2/docs) · [t3code](https://github.com/pingdotgg/t3code) (`AGENTS.md`, `docs/internals/`, `apps/mobile`, auth in `packages/contracts/src/auth.ts` and `apps/server/src/auth/`) · [Effect 4](https://effect.website/blog/releases/effect/40) · [Vite+](https://viteplus.dev) · [Expo](https://expo.dev) · [OpenTUI](https://github.com/anomalyco/opentui)
- [Pi (pi-ai)](https://github.com/earendil-works/pi) · [Tailscale Funnel](https://tailscale.com/docs/features/tailscale-funnel) · [Libron](https://github.com/nicoverbruggen/libron)
