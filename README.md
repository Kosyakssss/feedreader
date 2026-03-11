# Feedreader

A local-first RSS/Atom reader that runs in the browser. Portable, pretty, lightweight.

## Philosophy

- **Local-first** — everything lives on disk (`data/` folder). Sync via Syncthing, iCloud, or just copy the folder. No accounts, no cloud.
- **Minimal reading in-app** — entries open links: original page or a cleaned-up "defuddled" view. The app is a *launcher*, not a reader.
- **Defuddle runs client-side** — the server just proxies HTML via `/api/proxy?url=...`, and the browser runs [defuddle](https://github.com/nichochar/defuddle) on it. Server stays at ~40MB idle.
- **Runs everywhere** — uses Node.js standard APIs. Works with Bun on Mac and Node/tsx on Android via Termux. No Bun-specific APIs.
- **Three dependencies** — `defuddle`, `fast-xml-parser`, `tsx`. That's it.
- **Theming** — drop CSS files in `data/themes/`. The base UI is itself a theme (`default.css`). Themes use CSS custom properties and can override anything. Theme metadata lives in CSS comment headers (`@name`, `@author`, `@description`).
- **File-synced state** — Syncthing conflict files (`state.sync-conflict-*.json`) are auto-merged using latest-timestamp-wins per entry.

## Running

```sh
# With Bun (Mac)
bun install
bun server.ts

# With Node.js (Android/Termux)
npm install
npx tsx server.ts
```

Open `http://localhost:8787`. Override the port with `--port 3000` or in `data/config.json`.

Point to a custom data directory:

```sh
bun server.ts --data /path/to/data
```

## Data

All runtime data lives in `data/` (gitignored):

| File | Purpose |
|------|---------|
| `feeds.json` | Feed subscriptions |
| `state.json` | Read/starred state per entry |
| `cache.json` | Fetched entries + fetch timestamps |
| `config.json` | Settings (created on first write) |
| `themes/*.css` | Theme files |

## Pages

| Route | Page |
|-------|------|
| `/` | Timeline — all entries, newest first |
| `/starred` | Starred entries |
| `/feeds` | Feed management, add/remove/OPML import |
| `/feed/:id` | Per-feed view |
| `/settings` | Config (also editable by hand in `config.json`) |
| `/read?url=...` | Defuddled reading view |

## Features

- **Keyboard-driven**: `j`/`k` navigate, `o`/`O` open (default/alt), `m` toggle read, `s` toggle star, `x` select, `a` mark all read, `r` refresh, `/` search, `?` shortcuts overlay
- **Search**: instant, client-side, case-insensitive substring match on title + feed label
- **Bulk actions**: open all unread (tab cap configurable, default 20), mark read/starred, select multiple with `x` or shift-click
- **Feed auto-discovery**: fetches HTML, looks for `<link rel="alternate">`, tries common paths
- **OPML import**: paste or upload OPML to add feeds in bulk
- **View transitions**: uses the View Transition API for page navigation — browsers that don't support it just skip the animation
- **Retention**: default 3000 entries, configurable by count and/or max days (whichever hits first)

## Config

`data/config.json` (all optional, defaults shown):

```json
{
  "defaultOpenAction": "original",
  "maxBulkOpen": 20,
  "retention": { "maxEntries": 3000, "maxDays": null },
  "theme": null,
  "port": 8787
}
```

## Future

- Feed folders (data model supports `folderId` on feeds, no UI yet)

## Notes

- No swipe gestures, no push notifications — by design
- iOS is out of scope for now (Android via Termux + Node works)
- `data/*.json` is gitignored so personal data never gets pushed
