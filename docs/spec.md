# Feedreader 1.0 spec

The source of truth for what to build: product features, UX behavior and architecture. Visual design (look, layout, motion) is not decided here; it is designed with the owner in the real app. Working rules are in [`AGENTS.md`](../AGENTS.md). The build plan and its status are in §8.

Every decision below is the owner's unless marked **Proposed** (engineering choice, unconfirmed) or **Open** (§7).

## 0. Ground rules

- One Rust codebase: a small UI toolkit of our own, the engine, and the apps built on them. No web app, no Electron, no JavaScript runtime of our own. JavaScript runs only inside the system web view, for pages and for Defuddle.
- The previous TypeScript app is retired. Its data imports once (Settings or `feedreader import`); its behavior and polish (selection, keyboard, refresh, speed) are the floor.
- Tests are laws (§5.10). Everything else is verified by running the app.

## 1. Product

### 1.1 Goal
Get off social media without losing the people and sites you follow. One calm, finite place for everything that publishes a feed, running on your own devices. Recommendations come from friends, not algorithms.

- Finite lists, no ranking, no suggestions, no notifications about new items, no badges.
- Feeds only, and every feed is equal. RSS, Atom and JSON Feed in whatever form they come: a blog, a newsletter, a YouTube channel's feed, a podcast feed, a Nitter feed. No source gets its own look, player, view or plugin.
- Self-reliant apps: every app carries the engine and works on its own; devices sync whenever they can reach each other.
- Your device, your software: no app stores, no developer accounts, no cloud service run by us, no accounts required.

### 1.2 Non-goals
Anything source-specific: YouTube or podcast apps inside the app, SponsorBlock and the like, Bluesky, Mastodon, newsletters read from a mailbox, post or thread views. X / Twitter support of any kind. A timeline view. Ranking or "for you", including by LLM. People entities, a friends view or a social graph. An undo history panel. One-off share links. Editions. Music. A web app. Plugins and extensibility. App stores and developer accounts. Windows. iOS for now. Docker. Splitting work between engines. A terminal UI (maybe later, as toolkit experimentation).

### 1.3 Scope
1.0 is everything here not marked Later, on: the desktop app (macOS and Linux) with its background engine, the `feedreader` command, and Android. Android shares every crate; whether it ships in 1.0 or right after is Open.

## 2. Features

### 2.1 Feeds
- RSS, Atom and JSON Feed, read fully: content, summary, author, images (including Media RSS thumbnails), attachments (enclosures), categories and feed metadata.
- Every entry is a row in the list and opens the same way.
- A feed's label is its own title, then the user's rename.

### 2.2 Attachments and embeds
- Audio and video attachments play in the platform's built-in player: the system web view's own `<audio>`/`<video>`. No player of our own. Other attachment types are plain links.
- Embeds in entry content (for example a video embedded in a blog post) render as real embeds, in the web pane, when clicked.
- Attachments are cached like images (§5.6) so they play offline and never from the publisher at reading time. Devices keep them for the same entries they keep content for (§5.2).

### 2.3 Discovery
- Every place that offers "add feed" (the add field, Original tabs, links inside entries, saved links) finds **all** feeds a site offers and shows a picker: title, type (all posts, category, comments), last post date, a preview of recent items, and optional "add to folder".
- Ladder: `<link rel=alternate>`; common paths (`/feed`, `/rss`, `/rss.xml`, `/atom.xml`, `/index.xml`, `/feed.json`); platform URL patterns (WordPress, Ghost, Substack, Medium, YouTube channel or handle → `feeds/videos.xml?channel_id=`); JSON-LD and h-feed; sitemaps; LLM recipes (§2.10). Scheme-less input works.
- A discovered feed is validated with a real fetch and parse before saving. Knowing where a platform keeps its feed is discovery only; what it finds is an ordinary feed.

### 2.4 Reading
- Three modes for any entry: **Clean** (Defuddle extraction of the original page, the default), **Feed** (the feed's own content, falling back to extraction when missing or truncated) and **Original** (the real page in the web pane).
- The default is set in Settings and can be overridden per feed; switching mode in a tab is remembered per feed.
- Opening an entry marks it read: in a tab, in a background tab, in the system browser, one or many at once. The read toggle marks it unread again and undo reverts it.
- Links inside an entry open as new in-app tabs. A tab opened from a link that isn't a followed feed or a known entry offers both **Add as feed** (discovery and picker) and **Bookmark** (keeps it as a saved link).
- Clean and Feed text is selectable and copyable.
- Reading settings: article text size and column width. The proportional face stays Google Sans Code Proportional (Proposed).
- Original pages open in a web view per tab, with ad and tracker blocking (Later).

### 2.5 Bookmarks and saved links
- Bookmarks are for reading later, newest-bookmarked first.
- Saved links: keep a page without subscribing. Paste, share sheet, `feedreader add <url>`, or Bookmark in a tab opened from a link. The page is fetched and extracted, auto-bookmarked, marked as a saved link, and keeps its extracted text permanently. If the site has a feed, "Follow this site?" is offered once.

### 2.6 Organizing
- Folders, non-exclusive: a feed can be in several. Each folder is a view. No other grouping, no automation.
- Pinned feeds, shown next to the views. Folders and pins share one limit so the list of views never scrolls (number decided during build).
- Unread counts only on folders and pinned feeds; the total unread count is always in the status line.
- Per feed: rename, pin, folders, "hide from Home" (shows only in its folders), reading-mode override, rule tweaks, refresh cadence info, errors with details and retry.
- Feeds page sorted by unread count, then name.
- Unsubscribing keeps the feed's bookmarked and recommended entries; the rest is pruned after the undo window.
- OPML import and export keep folders both ways (a non-feed outline containing feeds is a folder; a feed in several folders is written once per folder and merged on import).

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
- The I recommend view lists what you recommended, with remove and copy link.
- Recommending works on any device, offline too; it publishes when the command reaches the hub. Public route: Tailscale Funnel.

### 2.9 Search and command palette
- An fzf-like palette over entries (titles and full text), feeds and folders, with filter words `is:unread`, `in:folder`, `from:feed`. Backed by SQLite FTS5 on every engine.
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
- One visual language for every app: text in Google Sans Code and Google Sans Code Proportional, rules, boxes and images. Lines and borders come in named styles (ASCII, light, heavy, double, dotted) chosen app-wide.
- A theme is one small TOML file of named colors with a light and a dark variant. Export a complete template, import a file; saving it updates running apps instantly. Each file is validated on its own and the last good version is kept. Appearance follows the system by default.

### 2.13 Your data
- Full export and import of personal data (subscriptions, folders, bookmarks, saved links, recommendations, rules, settings) as a versioned bundle, beyond OPML. Secrets are excluded.
- Move to another machine: pair the new engine, transfer state and settings directly, make it the hub, repoint devices and the public link.

### 2.14 Command line
The `feedreader` command is the same binary as the desktop app: `serve` (headless engine), `service install` and `uninstall`, `pair`, `add <url>`, `import <file>`, `export <file>`, `refresh`, `extract <url>` (the Clean text of any page), `unread` (unread entries as a Markdown list, for scripts and agents) and `upgrade`. Bare `feedreader` opens the desktop app.

## 3. UX

### 3.1 Views and navigation
- Views: Home (everything from every subscription not hidden from Home), Bookmarks, I recommend, folders and pinned feeds. Library: Feeds, Settings. Search lives in the palette.
- The navigation pane is always visible on wide windows; narrow windows turn it into a strip above the list. A narrow layout may move things but never hides actions or state.
- Opening the app lands on Home and restores the last place.
- On phones, swiping right peels back one layer (tab history, then the tab, then the navigation); the system back gesture does the same. Forward is buttons and keys only.

### 3.2 The list
- One long chronological list is the only way to browse. A quiet "That's everything" at the end. Relative times, exact on hover.
- A toggle between Unread (default) and All.
- Marking something read while viewing never moves or removes rows under the cursor. New entries arriving while scrolled down never shift what you're looking at (scroll anchoring).
- Refresh is `r` or pulling down hard on phones. There is no refresh button.
- Read and bookmark state are their own clickable columns in each row.

### 3.3 Selection and bulk actions
- Drag across checkboxes to paint a range; Shift-click for a range; keyboard move with Shift to extend; `x` to toggle.
- Press-and-hold on a row selects it and starts a drag selection on touch.
- While anything is selected, the action bar offers: Mark read, Mark unread, Open, Bookmark, Recommend, Cancel.
- **Mark all read** marks everything in the current view read. Undoable. In the action bar and the palette, no shortcut.
- **Open all unread** opens every unread entry in the view in the system browser and marks them read. It asks "Are you sure?" when that's more than 20 (configurable). Entries without links are skipped.

### 3.4 Tabs
- Click opens an in-app tab. Cmd-click opens the system browser. Middle-click opens a background tab.
- Each tab has its own back/forward history. Close with Cmd-W, middle-click or the close control; reopen with Cmd-Shift-T. No close-all, never closed by age. Cmd-Shift-[ and ] switch tabs.
- New tabs open right of the current one; background tabs line up after it in order.
- **Peek and kept.** A tab remembers its opener. A tab you opened, read and went back from at the start of its history is a peek: it closes and returns you to the exact spot in its opener. A tab becomes kept when opened in the background, when you switched away and came back. Kept tabs close only explicitly. Cmd-Z reopens a closed peek.
- Tabs persist across restarts with their mode, history and scroll position, and are shared across devices. Which tab is active stays per device.

### 3.5 Undo
- Linear, per client, persistent across restarts, covering the last 24 hours. Cmd-Z / Cmd-Shift-Z. Doing something new after undoing discards the redo branch.
- Covers every state change made on that client: read/unread, bookmarks, saved links, opening and closing tabs, a tab's mode, bulk actions, subscribe/unsubscribe, folders, pins, rules, settings, recommendations. Not switching tabs.
- Each change shows a one-line message with an undo button; each undo and redo says what changed.

### 3.6 Refresh feedback
The status line always shows the last and next refresh, progress while refreshing, and how many feeds are failing; errors and per-feed details live on the Feeds page.

### 3.7 Keyboard and input
- Every action is a command in one registry with a name, a label, optional keys and an availability rule. The action bar, the help page, the palette, mouse targets and keymaps are all generated from it, so every available action is visible on screen.
- Carried over: 1–4 navigation, j/k next/previous, h/l the Unread/All toggle, o open, Shift-O open all unread, m toggle read, s toggle bookmark, x select, Shift-J/K extend, r refresh, ? help, Esc close/clear. Feeds page: a add, d remove, i import, e export.
- Fixed new ones: Cmd-Z, Cmd-Shift-Z, Cmd-W, Cmd-Shift-T, Cmd-Shift-[ and ], Cmd-Shift-C (copy the original link), Cmd-K, Cmd-C (copy selected text).
- `a` for mark all read stays retired. Everything else is designed with the owner later; never add shortcuts unilaterally. Keys are user settings (Later), F-keys included.
- One focus model: no shortcuts while typing; Escape blurs, then clears, then closes.
- Every gesture has a keyboard and screen-reader equivalent (AccessKit, fed from the same view tree).

### 3.8 First run
- Desktop: start the background engine (or attach to one); import OPML or the old app's database, or start empty; "Where will you use Feedreader?" (this Mac / my Wi-Fi / away → Tailscale); optional features stating what each needs: LLM recipes, the public recommendation link.
- Android: pair with a hub by QR code, or start on its own and pair later.
- Servers: `feedreader serve` with flags; `feedreader service install` sets it up.

## 4. Settings scope
- Per person, synced: almost everything, including theme and appearance, line style, reading settings, views, reading modes, rules, folders, pins, keys.
- Per device: the active tab, window size and layout, the local cache, OS permissions.
- Engine-wide, in a strict TOML file written atomically (mode 0600): ports, retention, trusted origins, refresh limits, background engine on/off. Unknown keys are rejected and limits enforced.

## 5. Architecture

### 5.1 Shape
```
crates/toolkit     windows and input (winit), drawing (wgpu), text (parley + swash),
                   command registry, text fields, line styles, scene and hit testing
crates/engine      the engine as a library: storage, fetching, parsing, discovery,
                   extraction fallback, rules, the public listener, sync
crates/feedreader  the binary: desktop app, headless `serve`, command line
```
- **Engine:** one Rust library that owns user state, fetching, the public listener, the scheduler and sync. It runs on its own thread with a tokio runtime. Apps talk to it through one typed channel: `Request` in, `Event` out. A remote hub speaks the same types over the network, so the UI never knows whether the hub is in-process or across Tailscale.
- **Hub:** one engine per setup, normally the Mac's background engine. It holds the authoritative user state, refreshes on its own, serves the public feed, and is what devices pair with. The first engine you set up is the hub.
- **Background engine:** the desktop app connects to the engine's Unix socket in the data directory (owner-only, so reaching it is the authorization) and attaches; otherwise it starts `feedreader serve` as a background process. A lock file guarantees one engine per library; the command line attaches the same way. The engine keeps running after the app quits, so refresh, sync and the public feed keep working. Turning it off makes the engine part of the app. Quit completely and Restart stop or restart both.
- **Satellites:** engines on other devices paired with a hub (Android, a desktop on another computer). Connected, they sync with the hub and take fetched content from it. When the hub is unreachable they refresh feeds themselves and keep working fully; everything syncs when the hub is back.
- **UI:** a function of state. Data flows one way: engine events → app model → view (pure paint into a scene) → layout and GPU. Input becomes commands; commands change the model and send requests. A frame is drawn only for input, new data or a resize; an idle app does no work.

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
- `Request`, `Event` and `Command` are serde types in the engine crate; that is the contract. One WebSocket per satellite carries commands, catch-up and pushes. Keepalives, resume from the last sequence.
- Plain HTTP for media, the public listener, OPML and bundle uploads, and health.
- Version handshake on connect; mismatches show "Update the engine" or "Update the app".

### 5.4 Connectivity and pairing
- The desktop app on the engine's own machine is trusted through the data directory. Every other device pairs once with a one-time link or QR code (Settings, or `feedreader pair`), over localhost, the same network or Tailscale, http or https. Pairing becomes a long-lived, revocable token per device.
- Routes: same network and Tailscale. The hub can run `tailscale serve` for the private API (tailnet only) and `tailscale funnel` for the public listener. Funnel is the only public route in 1.0.
- Satellites remember every address the hub was reached on and try them in turn. Routes recover after sleep without re-pairing.
- Private API: exact Host allowlist; bodies capped; tokens never in URLs.
- Public listener: a separate port on the hub; serves only the I recommend feed, its page and snapshot images. No auth, read-only, its own path prefix.

### 5.5 Refresh
- The hub refreshes every 5 minutes (configurable) whenever it runs, apps attached or not, and pushes results. Manual refresh fetches every feed now.
- Satellites don't fetch while connected. When the hub is unreachable they refresh on the same schedule. Nothing they fetched is uploaded later: the hub fetches its own copy and ids match.
- Per-feed adaptive cadence (Open): slow down for rarely changing feeds; honor `Cache-Control`, `Retry-After`, 429/503; back off exponentially on errors, capped. Conditional requests with `ETag`/`Last-Modified`.
- 8 parallel fetches globally plus per-host politeness.

### 5.6 Retention and the media cache
- Entries: max count (default 3000, range 100–100000) and optional max age in days (1–36500). Pruning never removes bookmarked entries, saved links or entries in your I recommend feed. Saved links keep their extracted body.
- The engine caches everything an entry references: inline images, thumbnails, favicons and attachments. Apps draw them from the cache, never from third parties at reading time (blocks tracking pixels and IP leaks), and they work offline.
- An entry's cached media is deleted 7 days after it's read, unless it's bookmarked, saved or recommended.
- Limits: a per-item cap (larger items aren't cached and stay links) and a total budget shown in Settings with current usage; over budget, oldest-read goes first. Values Open.

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
- **Actor:** one task owns the database and serializes every write; fetches, extraction and discovery run concurrently and report back to it as internal messages.
- **Storage:** SQLite (bundled), WAL, foreign keys on, busy timeout 5 s, `synchronous = FULL`, STRICT tables, FTS5 for search. Schema versioned with `user_version`; migrations back up the file first.
- **Secrets:** a secrets folder in the engine's data directory, owner-only (folder 0700, files 0600, atomic writes). Never synced, exported or logged.
- **Supervision:** launchd `KeepAlive` and systemd `Restart=on-failure`; the desktop app restarts the engine if it dies.
- **Diagnostics:** one log file per day, 7-day retention, in `~/Library/Logs/feedreader` or `$XDG_STATE_HOME/feedreader`. Never log secrets or tokens. A health endpoint reports pid, uptime, data dir, port and refresh state.

### 5.10 Laws
Behavior that must hold for every input, checked by property tests (proptest) over generated operation sequences, shrunk to minimal failing cases (the niri approach). This list is approved; new laws are added with the owner.
- **Sync:** applying a command twice equals applying it once. Delivering the same commands in any order converges to the same state everywhere. A client reconnecting after any offline period ends with the hub's state once its own queued changes merge. Last-write-wins never lets an older change beat a newer one, even with wrong clocks. Add wins over a concurrent remove.
- **Undo:** doing then undoing a command restores the previous state within the 24-hour window. Redo after undo equals the original command.
- **Counts:** the unread count of any view equals the number of unread, not-hidden entries in it, on every client.
- **Parsing:** every feed in the corpus of real-world oddities (encodings, broken XML, missing dates, relative links, duplicates) yields entries with stable ids; parsing twice yields the same ids; nothing crashes on arbitrary input.
- **Identity:** two addresses of the same feed never create two subscriptions.
- **Outbound safety:** for any URL and redirect chain, nothing is fetched from a private, loopback or reserved address.
- **Retention:** pruning never removes a bookmarked, saved or recommended entry; cached media never exceeds the per-item cap or the budget.
- **Ordering:** list order is stable under entry updates and new arrivals.

### 5.11 Performance and tooling
Performance is a first-class goal, reached by many small optimizations rather than cutting the look.
- **No render loop.** Frames are drawn on input, data and resize only. Nothing animates continuously.
- **Profiling:** the `profiling` crate marks zones in the toolkit, the view and the engine; building with `--features profile` connects them to [Tracy](https://github.com/wolfpld/tracy), with frame marks, GPU timing and allocation tracking. Tracy connects over the network, which is how Android is profiled.
- **In-app numbers:** the status line shows paint and GPU time of the last frame and the worst of the last 240.
- **Headless snapshots:** `feedreader --snapshot out.png --keys "…"` renders any state offscreen, replays commands through the registry, and prints paint times. Used for visual checks at any window size.
- **Budgets:** a frame paints in under 2 ms at Retina size with 3000 entries; scrolling and typing stay within one display refresh of input.
- Long lists only lay out visible rows; shaped text and glyphs are cached; the article is laid out once per width.

### 5.12 Stack
- Rust, edition 2024, one cargo workspace.
- Toolkit: winit, wgpu, parley and swash (text, font fallback), AccessKit (Later), arboard (clipboard), wry (web pane and the extraction web view).
- Engine: tokio, reqwest with rustls and a resolver that refuses private addresses, rusqlite (bundled SQLite with FTS5), feed-rs, scraper, dom_smoothie (headless extraction), quick-xml (OPML), serde.
- Android: the same crates through winit's android-activity and wry's Android support, built locally with cargo-ndk; no Google account.
- Fonts: Google Sans Code and Google Sans Code Proportional under the Open Font License, bundled.

### 5.13 Packaging and distribution
- Artifacts: the macOS app bundle, a Linux binary, the Android APK. The `feedreader` command is the same binary.
- Updates: `feedreader upgrade` and an in-app check of GitHub releases, signature-verified, swapped on next launch.
- No developer accounts: macOS install via `curl … | sh` (no quarantine) and our own Homebrew tap. Android via GitHub Releases and Obtainium.
- External services: the core needs none. Tailscale (free) for remote access and Funnel; an LLM key or local model for recipes.

## 6. Carried over from the old app
Hard-won behavior to keep:
- Feed parsing: `Accept` for RSS, Atom, JSON Feed and XML. Encoding from BOM, XML declaration, then `Content-Type` charset. Entities decoded after parsing (double-encoded titles). Tag-like text in titles is kept; only formatting tags are stripped.
- Dates: RFC 3339, RFC 822 with variants, bare dates and bare years; missing or impossible dates fall back to fetch time.
- Feed health: garbage XML is an error but an empty valid channel is healthy; validators update only on success; 304 keeps them.
- Atom links prefer `rel=alternate`; unsafe links are dropped and the entry kept without a link.
- Feeds titling entries "Untitled" get a title from their first words.
- Writes racing a feed deletion are dropped.

## 7. Open questions
1. Android timing (1.0 or right after) and its background mechanism (periodic task or foreground service with a permanent notification).
2. Adaptive refresh algorithm.
3. Media cache limits: per-item cap and total budget for images and attachments; whether phones prefetch large attachments on metered networks.
4. I recommend image snapshots.
5. The combined limit for folders and pinned feeds.
6. The full keyboard map and user-assignable keys.
7. License: AGPL-3.0 or MIT. Copyright on AI-written code is unsettled.

## 8. Build plan
Status: done, partial or open. Each step is committed and pushed to `main` when it works.

1. **Done.** Toolkit: GPU renderer, text, command registry, fields, line styles, scene, hit testing, hover, headless snapshots.
2. **Done.** Engine core: safe fetcher, parsing, storage, refresh every 5 minutes, discovery from link tags and common paths, OPML, retention, import from the old app.
3. **Done.** App: list with selection and bulk actions, unread/all, filter, reader in three modes, text selection, Feeds and Settings pages, help, undo/redo, open all unread with confirmation.
4. **Done.** Folders, pins, hide from Home, per-feed reading mode, mute rules, duplicate merging, I recommend feed and public listener, saved links, full-text index.
5. **Done.** Defuddle in the extraction web view; headless fallback; `feedreader extract`.
6. **Partial.** Profiling with Tracy (zones, frames, allocations). Open: GPU zones, budgets checked automatically.
7. **Partial.** Images and the media cache with prefetch and pruning; audio, video and embeds play in the web pane. Open: caching attachments for offline (limits are Open, §7), favicons.
8. **Done.** Command palette and search: every available command, views, folders, feeds, and entries by title and full text with `is:`, `in:`, `from:`; Cmd-K.
9. **Partial.** Tabs: history, background tabs (middle-click, bulk open), peek and kept, Cmd-W, Cmd-Shift-T, Cmd-Shift-[ and ], undoable closing, persistence; links open in the tab with Add as feed and Bookmark. Open: reordering by drag, one web view per tab.
10. **Partial.** Discovery: link tags on the page and the site root, common paths, YouTube channels, handles and playlists, Medium, Substack, GitHub, Reddit; the picker with recent titles and subscribing into folders; identity by address and by title and site; OPML folders both ways; Follow this site after saving a link. Open: JSON-LD, h-feed, sitemaps.
11. **Done.** Light and dark palettes following the system (or fixed in Settings), `theme.toml` in the data folder with live reload and the last good colors kept on errors, article text size and column width.
12. **Partial.** Undo persists for 24 hours per device. Open: engine commands and the change log (with sync, step 14).
13. **Done.** `feedreader serve` on an owner-only Unix socket, one engine per library (lock file), the app and the command line attach or start it in the background, quit completely and restart engine, `service install` and `uninstall` for launchd and systemd.
14. **Open.** Sync: hub and satellites, pairing, Tailscale serve and funnel.
15. **Open.** Android.
16. **Open.** Adaptive refresh, per-host politeness, Retry-After.
17. **Open.** Export bundle, move to another machine, households.
18. **Open.** Accessibility with AccessKit.
19. **Open.** Packaging, install script, Homebrew tap, updates.
20. **Later.** LLM recipes; ad and tracker blocking in Original.

## 9. References
- [niri talk on testing and profiling](https://www.youtube.com/watch?v=Kmz8ODolnDg) · [Tracy](https://github.com/wolfpld/tracy) · [profiling crate](https://github.com/aclysma/profiling) · [proptest](https://github.com/proptest-rs/proptest)
- [Defuddle](https://github.com/kepano/defuddle) · [wry](https://github.com/tauri-apps/wry) · [winit](https://github.com/rust-windowing/winit) · [parley](https://github.com/linebender/parley) · [wgpu](https://github.com/gfx-rs/wgpu) · [AccessKit](https://github.com/AccessKit/accesskit)
- [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) · [RFC 6721 tombstones](https://www.rfc-editor.org/rfc/rfc6721)
