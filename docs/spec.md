# Feedreader and Graticule: 1.0 spec

The source of truth for what to build: Graticule (model DK-01, our own framework for native apps), Feedreader (the first app built on it), and the engine underneath Feedreader. Working rules are in [`AGENTS.md`](../AGENTS.md). The build plan and its status are in §10.

Every decision below is the owner's unless marked **Proposed** (engineering choice, unconfirmed) or **Open** (§9). Visual details (exact spacing, weights, colors, glyph choices) are designed with the owner component by component in the gallery and the real app (§6.9); this document records the principles and the decisions already made.

## 0. Ground rules

- One Rust codebase: Graticule, the engine, and the apps built on them. No web app, no Electron, no JavaScript runtime of our own. JavaScript runs only inside the system web view, for pages and for Defuddle.
- We are building a framework and an app at the same time. Feedreader proves Graticule; Graticule makes Feedreader easy, fast and beautiful by default. Graticule gains whatever primitives a good app needs, not only what Feedreader needs today.
- The previous TypeScript app is retired. Its data imports once (Settings or `feedreader import`); its behavior and polish (selection, keyboard, refresh, speed) are the floor.
- No `unsafe` in our code; the workspace forbids it. The only exception allowed so far is the native context menu on macOS (§6.8), and every exception is justified explicitly to the owner before it lands: why no safe route exists, philosophically and architecturally.
- Tests are laws (§5.10). Everything else is verified by running the app and looking at the gallery.

## 1. Product

### 1.1 Goal
Get off social media without losing the people and sites you follow. One calm, finite place for everything that publishes a feed, running on your own devices. Recommendations come from friends, not algorithms.

- Finite lists, no ranking, no suggestions, no notifications about new items, no attention badges (icon counters, red dots, "3 new!"). Badges that label what something is are part of the visual language (§6.4).
- Feeds only, and every feed is equal. RSS, Atom and JSON Feed in whatever form they come: a blog, a newsletter, a YouTube channel's feed, a podcast feed, a Nitter feed. No source gets its own look, player, view or plugin.
- Self-reliant apps: every app carries the engine and works on its own; devices sync whenever they can reach each other.
- Your device, your software: no app stores, no developer accounts, no cloud service run by us, no accounts required.

### 1.2 Non-goals
For Feedreader: anything source-specific (YouTube or podcast apps inside the app, SponsorBlock and the like), Bluesky, Mastodon, newsletters read from a mailbox, post or thread views. X / Twitter support of any kind. A timeline view. Ranking or "for you", including by LLM. People entities, a friends view or a social graph. An undo history panel. One-off share links. Editions. Music. A web app. Plugins and extensibility. App stores and developer accounts. iOS for now. Docker. Splitting work between engines. A terminal UI (maybe later, as a Graticule experiment).

Windows is not a target for Feedreader 1.0; whether Graticule supports it is Open (§9).

### 1.3 Scope
1.0 is everything here not marked Later, on: the desktop app (macOS first, then Linux) with its background engine, the `feedreader` command, and Android. Android shares every crate; whether it ships in 1.0 or right after is Open. Android work is paused until the desktop app, the engine and Graticule are settled; then the work of adapting to mobile starts fresh. Linux is verified later on a real Linux machine (§6.8).

## 2. Features

### 2.1 Feeds
- RSS, Atom and JSON Feed, read fully: content, summary, author, images (including Media RSS thumbnails), attachments (enclosures), categories and feed metadata.
- Every entry is a row in the list and opens the same way.
- A feed's label is its own title, then the user's rename.

### 2.2 Attachments and embeds
- Audio and video attachments play in the platform's built-in player: the system web view's own `<audio>`/`<video>`. No player of our own. Other attachment types are plain links.
- Embeds in entry content (for example a video embedded in a blog post) render as real embeds, in the web pane, when clicked.
- Attachments are data, not links in the text: each entry keeps its attachments (address, type, size, duration when known) and shows them in every reading mode, Clean included, as typed values with a way to play or open them.
- Attachments are cached like images (§5.6) so they play offline and never from the publisher at reading time. Devices keep them for the same entries they keep content for (§5.2).

### 2.3 Discovery
- Every place that offers "add feed" (a new tab, Original tabs, links inside entries, saved links) finds **all** feeds a site offers and shows them: title, type (all posts, category, comments), last post date, a preview of recent items, and optional "add to folder".
- Ladder: `<link rel=alternate>`; common paths (`/feed`, `/rss`, `/rss.xml`, `/atom.xml`, `/index.xml`, `/feed.json`); platform URL patterns (WordPress, Ghost, Substack, Medium, YouTube channel or handle → `feeds/videos.xml?channel_id=`); JSON-LD and h-feed; sitemaps; LLM recipes (§2.10). Scheme-less input works.
- A discovered feed is validated with a real fetch and parse before saving. Knowing where a platform keeps its feed is discovery only; what it finds is an ordinary feed.

### 2.4 Reading
- Three modes for any entry: **Clean** (Defuddle extraction of the original page, the default), **Feed** (the feed's own content, falling back to extraction when missing or truncated) and **Original** (the real page in the web pane).
- The default is set in Settings and can be overridden per feed; switching mode in a tab is remembered per feed.
- Opening an entry marks it read: in a tab, in a background tab, in the system browser, one or many at once. The read toggle marks it unread again and undo reverts it.
- Links inside an entry open as new in-app tabs. A tab showing a page that isn't a followed feed or a known entry offers the site's feeds (discovery, §2.3) and **Bookmark** (keeps it as a saved link).
- All text is selectable and copyable (§6.6).
- Reading settings: article text size and column width.
- Original pages open in a web view per tab, with ad and tracker blocking (Later).

### 2.5 Bookmarks and saved links
- Bookmarks are for reading later, newest-bookmarked first.
- Saved links: keep a page without subscribing. Open a new tab and paste the address, use the share sheet or `feedreader add <url>`, or Bookmark in any tab showing a page. The page is fetched and extracted, auto-bookmarked, marked as a saved link, and keeps its extracted text permanently. If the site has a feed, "Follow this site?" is offered once.

### 2.6 Organizing
- Folders, non-exclusive: a feed can be in several. Each folder is a place (§3.1). No other grouping, no automation.
- Pinned feeds are places too. Folders and pins share one limit so the places never scroll (number decided during build).
- Unread counts on folders and pinned feeds; the total unread count is always in the status line.
- Per feed: rename, pin, folders, "hide from Home" (shows only in its folders), reading-mode override, rule tweaks, refresh cadence info, errors with details and retry.
- Feeds page sorted by unread count, then name.
- Unsubscribing keeps the feed's bookmarked and recommended entries; the rest is pruned after the undo window.
- OPML import and export keep folders both ways (a non-feed outline containing feeds is a folder; a feed in several folders is written once per folder and merged on import). Import and export use the platform's file dialog.

### 2.7 Rules
- Mute words and merge duplicate links (the same link from several feeds shows once).
- Set globally, with separate tweaks per feed and per folder. "Mute word" is also a quick action on an entry.
- Rules are pure transforms over raw entries: removing a rule brings back what it hid. They are pure functions in the engine crate that every app runs over the same data, so counts and filters agree on every device.

### 2.8 Friends: the "I recommend" feed
- Recommend any entry, with an optional note up to 280 words that friends see as a quote above the entry. Works from a tab and as a bulk action.
- Your recommendations form one public Atom feed, served by the hub's public listener under one long random URL: one link for everyone, no per-friend links, `X-Robots-Tag: noindex`, never linked anywhere public.
- The feed carries full snapshots (text and images, served from the hub's cache), so friends' readers never trigger fetches on your behalf.
- Removing a recommendation (or undoing one) after friends fetched it appends an RFC 6721 tombstone; Feedreader drops tombstoned items on next fetch, other readers may keep them.
- A `feedreader:` Atom namespace carries the note, original source and original link; other readers see the note above a link.
- The same URL in a browser shows a read-only HTML page rendered by the engine, with "Open in Feedreader" (subscribes) and "Follow in any feed reader".
- Friends' feeds are ordinary subscriptions: they show in Home and can be pinned or foldered. You don't see who follows you.
- The I recommend place lists what you recommended, with remove and copy link.
- Recommending works on any device, offline too; it publishes when the command reaches the hub. Public route: Tailscale Funnel.

### 2.9 Find, search and the command palette
- Every list has a find field. It takes words and the filter tokens `is:unread`, `is:read`, `is:bookmarked`, `in:folder` and `from:feed`. Home opens with `is:unread` in the field, so the Unread/All state is visible text; deleting the token shows everything. The separate Unread/All toggle is retired.
- The palette is fzf-like over entries (titles and full text), feeds, folders and places, with the same tokens. Backed by SQLite FTS5 on every engine.
- Cmd-K on desktop opens the palette; it also runs every command in the registry by name. Nothing equivalent on phones.

### 2.10 Sites without feeds: LLM recipes (Later)
Off until an LLM provider is set up.
- Discovery first; the LLM only if a provider is configured.
- The LLM writes a declarative recipe (selectors for item, title, link, date, summary, image, next page; detail strategy; static or browser rendering; checks), never code. The engine runs it and validates it (items found, links resolve, dates parse, titles unique); the user previews and confirms.
- Self-healing: when checks fail, the LLM repairs the recipe; after engine checks and LLM verification the repair applies automatically with a quiet notice and one-click undo. The last working recipe is kept.
- Recipes are user state and sync, so a satellite can run static ones while the hub is away. Writing and repairing happens on the hub, where the keys are.
- Providers: direct APIs and local models (API keys, OpenRouter-style, Ollama, LM Studio) and installed agent CLIs (Claude Code, Codex, OpenCode, Pi). Keys stay on the hub and never sync.
- Guardrails: never ranks; only the slimmed public page is sent; one call per new site and per repair; a daily cap shown in Settings.
- JS-only sites render in a hidden system web view on devices with a UI.

### 2.11 Households
Several people per engine, each with their own subscriptions, state, folders, pins, rules, recommendations and tabs; fetching of shared feeds happens once. Each paired device belongs to exactly one person; a shared computer switches person explicitly. The first person is admin and adds others. In the data model from the sync step on.

### 2.12 Look and themes
- Feedreader uses Graticule's visual language (§6, §7): IBM Plex Mono and IBM Plex Sans, rules, boxes, typed values and images, on the grid.
- Lines and borders come in named styles (ASCII, light, heavy, double, dotted) chosen app-wide and switchable at any moment.
- A theme is one small TOML file of named colors with a light and a dark variant. Export a complete template, import a file; saving it updates running apps instantly. Each file is validated on its own and the last good version is kept. Appearance follows the system by default.

### 2.13 Your data
- Full export and import of personal data (subscriptions, folders, bookmarks, saved links, recommendations, rules, settings) as a versioned bundle, beyond OPML. Secrets are excluded.
- Move to another machine: pair the new engine, transfer state and settings directly, make it the hub, repoint devices and the public link.

### 2.14 Command line
The `feedreader` command is the same binary as the desktop app: `serve` (headless engine), `service install` and `uninstall`, `pair` (show a pairing link and QR code, or pair with one), `add <url>`, `import <file>`, `export <file>`, `refresh`, `extract <url>` (the Clean text of any page), `unread` (unread entries as a Markdown list, for scripts and agents) and `upgrade`. Bare `feedreader` opens the desktop app.

## 3. UX

### 3.1 Places and tabs
- **Places** are where lists live: Home (everything from every subscription not hidden from Home), Bookmarks, I recommend, folders, pinned feeds, Feeds and Settings. They are finite and always visible, never scroll and never overflow; the shared folder-and-pin limit (§2.6) guarantees it.
- **Tabs** are documents you opened: entries, pages, players and empty new tabs. They can be many; their strip scrolls and shows where you are in it.
- Places and tabs are two strips. Two arrangements: places across the top with tabs down the side, or places down the side with tabs across the top; which one is a setting.
- Narrow windows move the strips but never hide actions or state. The narrow layouts take their cues from opencode's v2 web view, which is studied before they are built.
- Opening the app lands on Home and restores the last place.
- On phones, swiping right peels back one layer (tab history, then the tab, then the places); the system back gesture does the same. Forward is buttons and keys only.

### 3.2 The list
- One long chronological list is the only way to browse. A quiet "That's everything" at the end. Relative times, exact on hover.
- Unread or all is the find field's `is:unread` token (§2.9).
- The scrollbar is always visible, with the position next to it ("214 / 3000").
- Marking something read while viewing never moves or removes rows under the cursor. New entries arriving while scrolled down never shift what you're looking at (scroll anchoring).
- Refresh is `r` or pulling down hard on phones. There is no refresh button.
- Read and bookmark state are their own clickable columns in each row.

### 3.3 Selection and bulk actions
- Drag across checkboxes to paint a range; Shift-click for a range; keyboard move with Shift to extend; `x` to toggle.
- Press-and-hold on a row selects it and starts a drag selection on touch.
- While anything is selected, the action bar offers: Mark read, Mark unread, Open, Bookmark, Recommend, Cancel.
- **Mark all read** marks everything in the current list read. Undoable. In the action bar and the palette, no shortcut.
- **Open all unread** opens every unread entry in the list in the system browser and marks them read. It asks "Are you sure?" when that's more than 20 (configurable). Entries without links are skipped.

### 3.4 Tabs
- Click opens an in-app tab. Cmd-click opens the system browser. Middle-click opens a background tab.
- **New tab**: an empty tab is a small browser. Paste or type an address and it shows the page (Clean or Original), the feeds the site offers with Subscribe (§2.3), and Bookmark (§2.5). It is the one way to add a feed or save a link by address; the separate add-feed and save-link prompts are retired. Its key is assigned by the owner.
- Each tab has its own back/forward history. Close with Cmd-W, middle-click or the close control; reopen with Cmd-Shift-T. No close-all, never closed by age. Cmd-Shift-[ and ] switch tabs.
- New tabs open next to the current one; background tabs line up after it in order.
- **Peek and kept.** A tab remembers its opener. A tab you opened, read and went back from at the start of its history is a peek: it closes and returns you to the exact spot in its opener. A tab becomes kept when opened in the background, when you switched away and came back. Kept tabs close only explicitly. Cmd-Z reopens a closed peek.
- Tabs persist across restarts with their mode, history and scroll position, and are shared across devices. Which tab is active stays per device.

### 3.5 Undo
- Linear, per client, persistent across restarts, covering the last 24 hours. Cmd-Z / Cmd-Shift-Z. Doing something new after undoing discards the redo branch.
- Covers every state change made on that client: read/unread, bookmarks, saved links, opening and closing tabs, a tab's mode, bulk actions, subscribe/unsubscribe, folders, pins, rules, settings, recommendations. Not switching tabs.
- Each change shows a one-line message with an undo button; each undo and redo says what changed.

### 3.6 Refresh feedback and the Engineering page
- The status line always shows the last and next refresh, progress while refreshing, and how many feeds are failing; errors and per-feed details live on the Feeds page.
- Frame times and inner workings leave the status line for an **Engineering** page: a spec sheet of the running system (app and engine versions, hub or satellite and paired devices, data folder, ports, Tailscale name and Funnel state, last refresh, frame times against the budget). A small stamp in a corner of the window shows the engine's role and version and opens it.

### 3.7 Keyboard and input
- Every action is a command in one registry with a name, a label, optional keys and an availability rule. The action bar, the help page, the palette, context menus, mouse targets and keymaps are all generated from it, so every available action is visible on screen.
- The action bar groups commands by subject (this entry, this list, the app) and wraps to more rows instead of hiding anything; if a narrow window truly can't fit them, it says how many more are in the palette.
- Carried over: 1–4 navigation, j/k next/previous, o open, Shift-O open all unread, m toggle read, s toggle bookmark, x select, Shift-J/K extend, r refresh, ? help, Esc close/clear. Feeds page: d remove, i import, e export. `h`/`l` are retired with the Unread/All toggle; `a` (add feed) goes with the add-feed prompt.
- Fixed new ones: Cmd-Z, Cmd-Shift-Z, Cmd-W, Cmd-Shift-T, Cmd-Shift-[ and ], Cmd-Shift-C (copy the original link), Cmd-K, Cmd-C (copy selected text). On Linux, Ctrl takes Cmd's place.
- System shortcuts stay the system's: on macOS the menu bar has the standard app and Window menus, so hiding, minimizing, full screen and window tiling (Globe-Ctrl-F and the rest) work as in any Mac app. Keys with the other platform's modifier (Ctrl on macOS, Super on Linux) are never taken by the app.
- `a` for mark all read stays retired. Everything else is designed with the owner; never add shortcuts unilaterally. Keys are user settings (Later), F-keys included.
- One focus model: no shortcuts while typing; Escape blurs, then clears, then closes.
- Every gesture has a keyboard and screen-reader equivalent (AccessKit, fed from the same pass that paints).

### 3.8 First run
- Desktop: start the background engine (or attach to one); import OPML or the old app's database, or start empty; "Where will you use Feedreader?" (this Mac / my Wi-Fi / away → Tailscale); optional features stating what each needs: LLM recipes, the public recommendation link.
- Android: pair with a hub by QR code, or start on its own and pair later.
- Servers: `feedreader serve` with flags; `feedreader service install` sets it up.

## 4. Settings scope
- Per person, synced: almost everything, including theme and appearance, line style, reading settings, places, reading modes, rules, folders, pins, keys.
- Per device: the active tab, window size and layout, the strip arrangement, the local cache, OS permissions.
- Engine-wide, in a strict TOML file written atomically (mode 0600): ports, retention, trusted origins, refresh limits, background engine on/off. Unknown keys are rejected and limits enforced. Until the file exists, ports come from `FEEDREADER_SYNC_PORT` and `FEEDREADER_PUBLIC_PORT`.

## 5. The engine

### 5.1 Shape
```
crates/graticule   the framework: shell, grid, styles, components, pictures, canvas,
                   text, command registry, gallery (§6)
crates/engine      the engine as a library: storage, fetching, parsing, discovery,
                   extraction fallback, rules, the public listener, sync
crates/feedreader  the binary: desktop app, headless `serve`, command line
```
- **Engine:** one Rust library that owns user state, fetching, the public listener, the scheduler and sync. It runs on its own thread with a tokio runtime. Apps talk to it through one typed channel: `Request` in, `Event` out. A remote hub speaks the same types over the network, so the UI never knows whether the hub is in-process or across Tailscale. Answers go only to the client that asked; changes to shared state go to everyone (`docs/internals/engine.md`).
- **Hub:** one engine per setup, normally the Mac's background engine. It holds the authoritative user state, refreshes on its own, serves the public feed, and is what devices pair with. The first engine you set up is the hub.
- **Background engine:** the desktop app connects to the engine's Unix socket in the data directory (owner-only, so reaching it is the authorization) and attaches; otherwise it starts `feedreader serve` as a background process. A lock file guarantees one engine per library; the command line attaches the same way. The engine keeps running after the app quits, so refresh, sync and the public feed keep working. Turning it off makes the engine part of the app. Quit completely and Restart stop or restart both.
- **Satellites:** engines on other devices paired with a hub (Android, a desktop on another computer). Connected, they sync with the hub and take fetched content from it. When the hub is unreachable they refresh feeds themselves and keep working fully; everything syncs when the hub is back.
- **UI:** a function of state (§6.2). Data flows one way: engine events → app model → view → Graticule → GPU. Input becomes commands; commands change the model and send requests.

### 5.2 Data and merging
- Fetched content (entries, extracted bodies, images, attachments, favicons) is a cache. The engine that fetched it owns it; the hub ships it to satellites, and it never flows back.
- User state (read, bookmarks, saved links, positions, subscriptions, folders, pins, rules, recipes, recommendations, settings, tabs) syncs everywhere; the hub holds the authoritative copy.
- Every change to user state is a **command**. The engine applies it to state tables and appends it to the **change log** with the next sequence number, in one SQLite transaction. State tables are the truth; the log is for catch-up and live pushes (not full event sourcing).
- Satellites apply commands locally first and queue them in an **outbox**, each with an idempotency id; the hub assigns the sequence number and pushes to other devices.
- What a device keeps: all user state; content for unread entries, bookmarks and open tabs (bodies, images and attachments); read entries of the last 3 days. Older content is paged from the hub on demand.
- Ids are the same on every engine: the feed id derives from the normalized feed URL and stays fixed if the feed later moves; the entry id is `feedId:urlencode(sourceId)`, with `sourceId` = guid, else URL, else title.
- Entries can update (edited, late bodies, images) without touching state.
- Ordering key: published time, falling back to first-seen, tie-broken by id. Stable under updates and identical on hub and satellites.
- Commands that keep an entry around (bookmark, recommend, open in a tab) carry a small snapshot (title, link, feed, dates) so other devices can show it before fetching it.
- Merge: single values are last-write-wins by hybrid logical clocks. Sets (subscriptions, folder membership, pins) are add/remove sets, add wins. For tabs, closing wins over a concurrent scroll update.
- Undo: every mutating command has an inverse; clients build undo from it. Unsubscribe is a soft delete kept for the 24-hour undo window. Undoing a recommendation after a friend fetched it appends a tombstone.
- Catch-up: a persistent, monotonically increasing revision; reconnecting devices request changes since N, with a full snapshot if N is too old.

### 5.3 Transport
- `Request`, `Event`, `Command` and `Change` are serde types in the engine crate; that is the contract.
- App to engine: JSON lines over the engine's Unix socket (or an in-process channel).
- Satellite to hub: HTTP with bearer tokens. `/v1/sync` pushes a device's changes and long-polls everyone else's since a cursor; `/v1/content` pages fetched entries; `/v1/media` serves cached images; `/v1/pair` exchanges a code for a token. Details and the reasons are in `docs/internals/sync.md`.
- Version handshake (Open): mismatches should show "Update the engine" or "Update the app".

### 5.4 Connectivity and pairing
- The desktop app on the engine's own machine is trusted through the data directory. Every other device pairs once with a one-time link or QR code (Settings, or `feedreader pair`), over the same network or Tailscale. Pairing becomes a long-lived token per device; the hub can forget a device.
- Routes: the pairing link carries the hub's Tailscale name, LAN address and loopback; Tailscale reaches the hub's port directly. The public listener goes through Tailscale Funnel on its own port so nothing else the machine serves becomes public. Funnel is the only public route in 1.0.
- Satellites remember every address the hub was reached on and try them in turn. Routes recover after sleep without re-pairing.
- Private API: exact Host allowlist; bodies capped; tokens never in URLs.
- Public listener: a separate port on the hub; serves only the I recommend feed, its page and snapshot images. No auth, read-only, its own path prefix.

### 5.5 Refresh
- The hub refreshes every 5 minutes (configurable) whenever it runs, apps attached or not, and pushes results. Manual refresh fetches every feed now.
- Satellites don't fetch while connected. When the hub is unreachable they refresh on the same schedule. Nothing they fetched is uploaded later: the hub fetches its own copy and ids match.
- Per-feed adaptive cadence (Proposed): a feed that brought new entries is checked every cycle; each quiet check stretches its interval by half, up to 6 hours; errors back off exponentially from the cycle, up to 12 hours. `Retry-After` (also on 429 and 503) is honored up to a day; `Cache-Control: max-age` up to an hour, since static hosts often send days for feeds that post daily. Conditional requests with `ETag`/`Last-Modified`. Manual refresh fetches every feed.
- 8 parallel fetches globally, at most 2 per host.

### 5.6 Retention and the media cache
- Entries: max count (default 3000, range 100–100000) and optional max age in days (1–36500). Pruning never removes bookmarked entries, saved links or entries in your I recommend feed. Saved links keep their extracted body.
- The engine caches everything an entry references: inline images, thumbnails, favicons and attachments. Apps draw them from the cache, never from third parties at reading time (blocks tracking pixels and IP leaks), and they work offline.
- An entry's cached media is deleted 7 days after it's read, unless it's bookmarked, saved or recommended.
- Limits: a per-item cap (larger items aren't cached and stay links) and a total budget shown in Settings with current usage; over budget, oldest-read goes first. Values Open.
- **Prefetch.** Opening an entry never waits on the network. In the background, the engine fetches and extracts the Clean text of every unread entry up to 30 days old (configurable), and caches its images and attachments, within the fetch limits of §5.5 and the media budget. The app pre-shapes what you're likely to open next (§6.10).

### 5.7 Extraction and the web pane
- Clean mode runs **Defuddle** inside a hidden system web view (WebKit on macOS and Linux, Android WebView). The engine fetches the page through the safe fetcher (§5.8) and hands the HTML to the app; the app parses it with `DOMParser` (no scripts run, nothing loads) and runs Defuddle on it; the result goes back to the engine, which stores it.
- A headless engine (`serve` on a server) has no web view and falls back to a Rust Readability port.
- Original pages, embeds, audio and video live in the web pane: a child web view placed over the reading area. It is the only place third-party content loads.

### 5.8 Outbound fetching safety
- Only http/https; no credentials in URLs. Block `localhost`, `*.localhost`, `.local`, and 0.0.0.0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0/24, 192.0.2/24, 192.88.99/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24, 224/3, ::/128, ::1/128, fc00::/7, fe80::/10, fec0::/10, ff00::/8, 100::/64, 2001:db8::/32, including IPv4 embedded in IPv6 transition ranges (6to4, Teredo, NAT64, mapped/compatible).
- Resolve every A/AAAA record and require all public; connect to the resolved address (no rebinding window). Redirects at most 5, each checked.
- Timeouts: feed 8 s, discovery 10 s, probes 5 s. Body caps: 10 MB feeds, 2 MB HTML discovery; media caps per §5.6.
- Every engine uses this fetcher. Original pages are real web views and are not proxied.

### 5.9 Engine internals
- **Actor:** one task owns the database and serializes every write; fetches, extraction and discovery run concurrently and report back to it as internal messages. Each message is one SQLite transaction (`docs/internals/storage.md`).
- **Storage:** SQLite (bundled), WAL, foreign keys on, busy timeout 5 s, `synchronous = FULL`, STRICT tables, FTS5 for search. Schema versioned with `user_version`; migrations back up the file first.
- **Errors:** a failed write is reported, never silently dropped (today many store calls discard their result).
- **Secrets:** a secrets folder in the engine's data directory, owner-only (folder 0700, files 0600, atomic writes). Never synced, exported or logged.
- **Supervision:** launchd `KeepAlive` and systemd `Restart=on-failure`; the desktop app restarts the engine if it dies.
- **Diagnostics:** one log file per day, 7-day retention, in `~/Library/Logs/feedreader` or `$XDG_STATE_HOME/feedreader`. Never log secrets or tokens. A health endpoint reports pid, uptime, data dir, port and refresh state.

### 5.10 Laws
Behavior that must hold for every input, checked by property tests (proptest) over generated operation sequences, shrunk to minimal failing cases (the niri approach). This list is approved; new laws are added with the owner. None is written yet (§10).
- **Sync:** applying a command twice equals applying it once. Delivering the same commands in any order converges to the same state everywhere. A client reconnecting after any offline period ends with the hub's state once its own queued changes merge. Last-write-wins never lets an older change beat a newer one, even with wrong clocks. Add wins over a concurrent remove.
- **Undo:** doing then undoing a command restores the previous state within the 24-hour window. Redo after undo equals the original command.
- **Counts:** the unread count of any list equals the number of unread, not-hidden entries in it, on every client.
- **Parsing:** every feed in the corpus of real-world oddities (encodings, broken XML, missing dates, relative links, duplicates) yields entries with stable ids; parsing twice yields the same ids; nothing crashes on arbitrary input.
- **Identity:** two addresses of the same feed never create two subscriptions.
- **Outbound safety:** for any URL and redirect chain, nothing is fetched from a private, loopback or reserved address.
- **Retention:** pruning never removes a bookmarked, saved or recommended entry; cached media never exceeds the per-item cap or the budget.
- **Ordering:** list order is stable under entry updates and new arrivals.
- **Frames:** every frame of the gallery and of Feedreader's screens paints within budget (§6.10) at the smallest and largest sizes.

### 5.11 Stack
- Rust, edition 2024, one cargo workspace.
- Engine: tokio, reqwest with rustls and a resolver that refuses private addresses, rusqlite (bundled SQLite with FTS5), feed-rs, scraper, dom_smoothie (headless extraction), quick-xml (OPML), axum (sync and public listeners), serde.
- Graticule: see §6.11.
- Android: the same crates through winit's android-activity and wry's Android support, built locally with cargo-ndk; no Google account.

### 5.12 Packaging and distribution
- Artifacts: the macOS app bundle, a Linux binary, the Android APK. The `feedreader` command is the same binary.
- Updates: `feedreader upgrade` and an in-app check of GitHub releases, signature-verified, swapped on next launch.
- No developer accounts: macOS install via `curl … | sh` (no quarantine) and our own Homebrew tap. Android via GitHub Releases and Obtainium.
- External services: the core needs none. Tailscale (free) for remote access and Funnel; an LLM key or local model for recipes.

## 6. Graticule

### 6.1 Purpose
Graticule, model DK-01: a graticule is the ruled measuring grid on an instrument screen, and this is a framework built on a grid. The model code changes with each breaking version.

A framework for native apps that feel like the best interfaces of the past, at today's speed: easy and fast by default, close to no-code in code. An app describes its model, its commands and its pages built from components; Graticule does the rest.

The win condition: Graticule builds a TextEdit-class editor and a trading terminal for professionals, each in a small amount of app code, both beautiful and both within budget. Two demo apps hold it to that (§6.9).

### 6.2 What the app writes and what Graticule owns
- The app supplies: a **model** (plain state, enums), **commands** (id, label, keys, availability, effect), **pages** composed of components and sized in cells, and **effects** as data (send a request, open a URL, copy text).
- Graticule owns: the **shell** (windows, the event loop, keys to commands, focus, hover, dragging, scrolling, text input, clipboard, menus, web views, file dialogs, accessibility), the per-component **interaction state** (scroll offsets, hover, pressed, selection) kept by stable id, the **component library**, **styles and themes**, the **gallery**, and the frame **budgets**.
- The view is a pure function of the model: painting never writes back into the app's state (today Feedreader's view writes scroll and layout values into its model).
- The action bar, the help page, the palette, the menu bar and context menus are Graticule components fed by the command registry.

### 6.3 The grid
- The screen is paper ruled in cells. The cell comes from the monospace font: its width is the advance of IBM Plex Mono, its height the line. Both are whole device pixels; the font size is derived from the cell, not the other way around, so column edges never fall between pixels.
- Layout is in whole cells: every box, rule, column and component edge sits on the grid. Narrow and wide are different column counts.
- Proportional text and images live inside boxes; only the box sits on the grid. Mono and Sans share a baseline on a row.
- Character graphics (box drawing, block elements, braille) are drawn by Graticule, not taken from the font, so they meet exactly at cell edges in every font and style.

### 6.4 Styles, themes and typed values
- A **style** is a set of glyphs and line treatments: how rules, boxes, checkboxes, tab edges, scrollbars and shadows are drawn. ASCII, light, heavy, double and dotted exist today; styles switch at runtime and everything redraws in the new one.
- A **theme** is colors (§2.12). Styles and themes are independent.
- **Typed values**: each kind of value has one look, used everywhere (date, version, state, count, error, code, mode). This is what badges are: a badge labels what something is, never what you should do.
- Everything drawn uses semantic ink (ink, muted, faint, rule, accent, danger, warn; foreground or background; thin, regular or heavy weight), so a style or theme change restyles components, pictures and canvases alike. Raw colors and widths are available when an app needs them.

### 6.5 Three layers of graphics
1. **Components.** A library of prebuilt elements drawn from the style, modeled on the completeness of shadcn/ui: button, toggle, checkbox, radio, field, text area, select, stepper, progress, separator, scroll area, list, table, tree, tabs, places strip, action bar, palette, badge, key label, breadcrumb, spec sheet (key/value table), status line, confirm row, message line. Components that float elsewhere are grounded here: a tooltip becomes the status line's hint, a toast the message line, a dialog an inline confirm row, a dropdown a cycling value or an inline list that pushes content down. Most apps only ever use this layer.
2. **Pictures.** Vector art made ahead of time: icons, ornaments, logos. Drawn as SVG (or in a small Rust drawing vocabulary) and converted at build time into compact shape data in the binary, so nothing is parsed at runtime; on first use at a size each picture is drawn once into the GPU atlas like a glyph, and after that costs one quad. Every picture has a required text label, used by screen readers and as its stand-in in the ASCII style. Pictures are not terminal-compatible beyond that label.
3. **Canvas.** A box on the grid (or the whole window) with its own coordinate space, holding shapes drawn at runtime: lines, curves, filled and stroked paths, text labels and images, in semantic ink and weights. Shapes have ids and hit testing. In the ASCII style a canvas can render to braille and block characters on the cells. Charts are components built on the canvas. A canvas may request frames at display rate only while it is live (a focused game or visualization); idle still costs nothing. 3D is the app's math projected to 2D; the canvas draws weighted lines and fills, it is not a 3D engine.

### 6.6 Text
- Fonts: IBM Plex Mono and IBM Plex Sans (Open Font License), bundled in the weights the design uses. Mono for anything you compare, copy or align (codes, values, keys, columns); Sans for prose and labels.
- **Selection** is on by default for all text, in reading order across components, like a web page; a component opts out (controls, for example). Drag, double-click for a word, triple-click for a line, Shift-click to extend, Cmd-C to copy.
- **Fields** are Graticule's own, built to native behavior: the platform's input methods, dictation and emoji picker through the OS text-input protocol; selection with mouse and keyboard; the macOS text key bindings (Option and Cmd with arrows, Shift to extend, Ctrl-A/E/K/Y); select all; undo per field; single- and multi-line. Spellcheck, autocorrect and Writing Tools need native widgets and are out for now.

### 6.7 Interaction and motion
- Nothing floats, except the platform's own context menus and menu bar (§6.8).
- What you can act on looks actionable on sight, without hovering; the current place is marked quietly (the exact treatment is designed in the gallery).
- No time-based animation by default. Short glows are allowed where they add clarity (for example a value that just changed), decided per component, always finite and never on what you're reading or dragging.
- After a change you didn't watch happen (an undo, a jump, entries that arrived), the affected items carry a mark until your next input.
- Frames come from input, data or resize, coalesced to one per display refresh. Data-driven updates (a list filling during refresh, a ticking value) are frames like any other. Only a live canvas may ask for continuous frames, and only while live.

### 6.8 Native integration
- Native where the platform has a native; ours where it doesn't.
- **macOS:** the menu bar (app and Window menus, so system shortcuts and window tiling work), context menus generated from the registry (the one sanctioned `unsafe`: muda's popup takes a raw view pointer), file dialogs (`rfd`), clipboard, input methods, cursors, appearance, trackpad scrolling with the system's own momentum, accessibility through AccessKit, the system web view.
- **Linux:** Open, verified later on a real machine (a friend's Linux box). Known so far: under Wayland there is no system context menu or global menu bar, so Graticule's own drawn menu is the native one; GNOME needs a drawn title bar; file dialogs through the XDG portal; input methods, clipboard, appearance, fontconfig and AT-SPI are available. To verify: the web pane and extraction under Wayland (wry may need a GTK container there).
- Qt is not used: it is native only on KDE, heavy to ship, and its Rust bindings need `unsafe`.

### 6.9 The gallery and the demo apps
- The **gallery** renders every component in every state (hover, focus, selected, disabled, empty, overflowing, narrow) in every style and both appearances, offscreen, as sheets. It is how components are designed one by one with the owner, and how regressions are seen.
- Two **demo apps** keep Graticule honest at both extremes: a TextEdit-class editor (multi-line editing, find and replace, large documents) and a ticker board (dense live tables, charts, data-driven frames, the tick glow). They may ask for any primitive.

### 6.10 Performance
Performance is design.
- **Budget:** our work from input to GPU submit stays under 1 ms for Feedreader's screens and the gallery at the smallest and largest sizes, with 3000 entries; the result is on screen at the next display refresh. Checked automatically (§5.10).
- **No allocation per frame** in steady state, measured with Tracy.
- **Instant.** The work for an interaction is proportional to what changed, not to the size of the app or the document: a cursor move repaints two rows, a keypress in a field one line. Each stage of the input path (event to command, model update, paint, GPU submit) has its own budget in microseconds or nanoseconds, measured and shown on the Engineering page.
- **The main thread only handles input, updates the model, paints and submits.** Network, extraction, image decoding, text shaping, picture rasterization and waiting for the display all happen elsewhere; the main thread never blocks on the GPU or the screen.
- **Pre-shaping**: turning text into positioned glyphs and lines is the costly part of showing a new article. Likely next documents (the next unread entries, what's visible in the list) are shaped on a worker at the current width before they're opened, so opening one only draws.
- **Instant launch**: the app keeps a compact local copy of what it last showed and draws its first frame from it, before the engine answers.
- Components are memoized: the API redraws everything from the model, and each component reuses its last output when its inputs haven't changed. Only visible rows and columns are laid out; shaped text, glyphs and pictures are cached; internal ids are integers, not strings.
- **Profiling:** the `profiling` crate marks zones in Graticule, the app and the engine; building with `--features profile` connects them to [Tracy](https://github.com/wolfpld/tracy), with frame marks, GPU timing and allocation tracking.
- **Headless snapshots:** `feedreader --snapshot out.png --keys "…"` renders any state offscreen, replays commands through the registry, and prints paint times.

### 6.11 Stack
- winit (windows and input), wgpu (drawing), parley and swash (text shaping, layout and font fallback), AccessKit (accessibility), arboard (clipboard), wry (web pane and the extraction web view), muda (macOS menus).
- lyon (canvas tessellation), usvg (pictures at build time), rfd (file dialogs).
- Fonts: IBM Plex Mono and IBM Plex Sans under the Open Font License, bundled.

## 7. Design language

### 7.1 Principles
- **Expose state and inner workings.** What the app is doing and why is visible text, not hidden behind hover or a debug mode.
- **Dense and calm.** Dense in information, calm in motion: nothing moves unless you move it, nothing asks for attention.
- **Everything visible, flat not hierarchical.** Every available action is on screen; every place is one step away.
- **Explicit over implicit, verbose over opaque.** Labels say what things are; values carry their type.
- **One grammar.** Rules, boxes, `[key label]`, typed values, the grid; the same everywhere.
- **Performance is design.**
- **Timeless, not trendy; don't infantilize the user.**

### 7.2 References
The main reference is U.S. Graphics Company (usgraphics.com). What we take from it:
- Its design philosophy, printed on its front page: emergent over prescribed aesthetics; expose state and inner workings; dense, not sparse; explicit over implicit; engineered for human vision and perception; performance is design; verbosity over opacity; timeless and unfashionable; flat, not hierarchical; as complex as it needs to be; don't infantilize users.
- Typed values: the environment is a solid green stamp (`PROD`), versions sit in dotted mono boxes, dates in a solid blue field, product codes are stamped (`FX-050`); plain facts are plain text. The look tells you what kind of value it is (§6.4).
- What you can act on is boxed (with a hard drop shadow); grouping labels are bare text. You know what is clickable without hovering.
- The current place is marked with a small dot, not an inverted button.
- The sitemap is a drawn tree of everything, on one page; our help page and folder tree can be the same.
- The engineering page is a spec sheet of the whole running system, reached from a `PROD v3.0.2` stamp in the footer (§3.6).
- The catalog is the complete price list on one page: finite, nothing hidden.
- Two typefaces with one split: proportional for prose and labels, mono for data, codes and values.

Alongside it, the interfaces of the 1970s and 80s: the Bloomberg Terminal, Lotus 1-2-3, Xerox Star, Symbolics Genera, Oberon, Norton Commander, Teletext, IBM 3270 and others. The swipe file lives outside the repository, with the owner. We learn from these; we don't copy any of them.

## 8. Carried over from the old app
Hard-won behavior to keep:
- Feed parsing: `Accept` for RSS, Atom, JSON Feed and XML. Encoding from BOM, XML declaration, then `Content-Type` charset. Entities decoded after parsing (double-encoded titles). Tag-like text in titles is kept; only formatting tags are stripped.
- Dates: RFC 3339, RFC 822 with variants, bare dates and bare years; missing or impossible dates fall back to fetch time.
- Feed health: garbage XML is an error but an empty valid channel is healthy; validators update only on success; 304 keeps them.
- Atom links prefer `rel=alternate`; unsafe links are dropped and the entry kept without a link.
- Feeds titling entries "Untitled" get a title from their first words.
- Writes racing a feed deletion are dropped.

## 9. Open questions
1. Android timing (1.0 or right after) and its background mechanism (periodic task or foreground service with a permanent notification).
2. Adaptive refresh: confirm the proposal in §5.5.
3. Media cache limits: per-item cap and total budget for images and attachments; whether phones prefetch large attachments on metered networks.
4. I recommend image snapshots.
5. The combined limit for folders and pinned feeds.
6. The full keyboard map and user-assignable keys, including the new tab.
7. License: AGPL-3.0 or MIT. Copyright on AI-written code is unsettled.
8. Windows support for Graticule.
9. The Linux story (§6.8), after testing on a real machine.
10. A feed that changes its entry links (for example by adding a fragment) shows old posts twice, since merging only hides copies from different feeds.
11. Whether muted and merged entries appear in palette search.

## 10. Build plan
Status: done, partial, open, paused or later. We are restarting the interface on a new foundation; the engine underneath is largely built and keeps its status. Each step is committed when it works.

### 10.1 Already built
- **Done.** Engine core: safe fetcher, parsing, storage, adaptive refresh, discovery (link tags, common paths, YouTube, Medium, Substack, GitHub, Reddit), OPML with folders, retention, import from the old app, rules, the I recommend feed and public listener with Funnel publishing, saved links, full-text index, Defuddle extraction with the headless fallback, undo as engine commands, the background engine and `service install`, sync between hub and satellites with pairing.
- **Done.** The current interface: list, selection and bulk actions, reader in three modes, tabs with peek and kept, palette, Feeds and Settings pages, help, themes and live `theme.toml`, images and the media cache, the macOS menu bar. It keeps working until each screen is replaced (§10.4).

### 10.2 Foundations
1. **Open.** Design language: grid rules, style tokens, typed values and the component inventory (each component mapped as kept, grounded or skipped), drawn up with the owner from the references (§7).
2. **Open.** IBM Plex Mono and Sans, whole-pixel cells derived from the mono advance, character graphics drawn by Graticule.
3. **Open.** The gallery.
4. **Open.** Laws: the approved list in §5.10, starting with sync, undo and outbound safety, plus frame budgets checked automatically.

### 10.3 Graticule
5. **Partial.** The shell lives in Graticule (`graticule::shell`): the event loop, keys to commands, editing of the focused field, IME, clipboard, hit testing, hover, cursors, clicks and drags, the wheel, the web pane, the menu bar, file drops and effects as data; apps implement `graticule::shell::App`, and `Offscreen` renders the same way for snapshots. Open: interaction state (scroll offsets, drags) kept by Graticule instead of the app's model, so the view stops writing into the model.
6. **Open.** Registry-driven components: action bar (grouped, no hiding), help as a drawn tree, palette, context menus (macOS, the one `unsafe`), menu bar.
7. **Open.** Text: selection on by default; fields with native behavior; native file dialogs.
8. **Open.** Components, one at a time with gallery sheets: entry row, list with scrollbar and position, find field with tokens, places strip, tab strip with the new tab, spec sheet, table, tree, confirm row and message line, badges, article.
9. **Open.** Accessibility with AccessKit, fed from the same pass that paints.

### 10.4 Feedreader on Graticule
10. **Open.** Screen by screen, each reviewed in the gallery and once in the real window: Home and the list; the reader; the new tab (replacing add feed and save link); Feeds; Settings; Help; the Engineering page; narrow layouts (after studying opencode v2). The old view code goes as each screen lands.

### 10.5 Graphics
11. **Open.** Pictures: build-time SVG, atlas caching, required labels.
12. **Open.** Canvas: shapes, weights, hit testing, ASCII rendering, live frames; charts on top (a posting-frequency sparkline per feed on the Feeds page, the pairing QR code).

### 10.6 Instant
13. **Open.** Stage budgets measured per interaction; memoized components; integer ids; the main thread freed of shaping and waiting; pre-shaping; instant launch (§6.10).

### 10.7 Demo apps
14. **Open.** The editor.
15. **Open.** The ticker board.

### 10.8 Engine and platform
16. **Open.** Sync: the version handshake, households, rate limiting on the public listener, the engine-wide TOML file.
17. **Open.** Engine errors reported instead of discarded (§5.9).
18. **Partial.** Media: images and pruning done. Open: attachments as data shown in every mode (today they are links appended to the feed's text, so Clean mode loses them), attachments cached for offline (limits are Open, §9), prefetching unread entries up to 30 days old (§5.6), favicons.
19. **Partial.** Discovery. Open: JSON-LD, h-feed, sitemaps.
20. **Partial.** Tabs. Open: reordering by drag, one web view per tab.
21. **Open.** Export bundle, move to another machine.
22. **Partial.** Profiling with Tracy. Open: GPU zones.
23. **Partial.** Packaging: `scripts/bundle.sh` builds and installs Feedreader.app and links the command. Open: the icon, a `feedreader://` handler for pairing and "Open in Feedreader" links, release builds, the install script, the Homebrew tap, updates.
24. **Open.** Linux, tested on a real machine (§6.8).
25. **Paused.** Android, started fresh once the desktop is settled.
26. **Later.** LLM recipes; ad and tracker blocking in Original.

## 11. References
- [niri talk on testing and profiling](https://www.youtube.com/watch?v=Kmz8ODolnDg) · [Tracy](https://github.com/wolfpld/tracy) · [profiling crate](https://github.com/aclysma/profiling) · [proptest](https://github.com/proptest-rs/proptest)
- [Defuddle](https://github.com/kepano/defuddle) · [wry](https://github.com/tauri-apps/wry) · [winit](https://github.com/rust-windowing/winit) · [parley](https://github.com/linebender/parley) · [wgpu](https://github.com/gfx-rs/wgpu) · [AccessKit](https://github.com/AccessKit/accesskit) · [muda](https://github.com/tauri-apps/muda) · [lyon](https://github.com/nical/lyon) · [IBM Plex](https://github.com/IBM/plex)
- [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) · [RFC 6721 tombstones](https://www.rfc-editor.org/rfc/rfc6721)
- [U.S. Graphics Company](https://usgraphics.com) · [shadcn/ui](https://ui.shadcn.com)
