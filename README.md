# Feedreader

A local-first RSS/Atom reader that runs in the browser. Portable, pretty, lightweight.

## Philosophy

- **Local-first** — everything lives on disk (`data/` folder). Sync via Syncthing, iCloud, or just copy the folder. No accounts, no cloud.
- **Minimal reading in-app** — entries open original links. The app is a _launcher_, not a reader.
- **Runs everywhere** — uses Node.js standard APIs. Works with Bun on Mac and Node/tsx on Android via Termux. No Bun-specific APIs.
- **Two dependencies** — `fast-xml-parser`, `tsx`. That's it.
- **Theming** — drop CSS files in `data/themes/`. The base UI is itself a theme (`default.css`). Themes use CSS custom properties and can override anything. Theme metadata lives in CSS comment headers (`@name`, `@author`, `@description`).
- **File-synced state** — Syncthing conflict files (`state.sync-conflict-*.json`) are auto-merged using latest-timestamp-wins per entry.
- **Safer imports/state** — feed URLs are validated on both manual add and OPML import, and entry IDs are scoped per feed so state cannot bleed across subscriptions.

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
The server binds to `127.0.0.1` by default; pass `--host 0.0.0.0` only if you intentionally want LAN access.

Point to a custom data directory:

```sh
bun server.ts --data /path/to/data
```

## Data

All runtime data lives in `data/` (gitignored):

| File               | Purpose                                      |
| ------------------ | -------------------------------------------- |
| `feeds.json`       | Feed subscriptions                           |
| `state.json`       | Read/starred state per entry                 |
| `cache.json`       | Fetched entries + fetch timestamps           |
| `config.json`      | Settings (created on first write)            |
| `transaction.json` | Crash-recovery journal for multi-file writes |
| `themes/*.css`     | Theme files                                  |

## Pages

| Route       | Page                                            |
| ----------- | ----------------------------------------------- |
| `/`         | Timeline — all entries, newest first            |
| `/starred`  | Starred entries                                 |
| `/feeds`    | Feed management, add/remove/OPML import         |
| `/feed/:id` | Per-feed view                                   |
| `/settings` | Config (also editable by hand in `config.json`) |

## Features

- **Keyboard-driven**: `j`/`k` navigate, `o` open, `m` toggle read, `s` toggle star, `x` select, `a` mark all read, `r` refresh, `/` search, `?` shortcuts overlay
- **Search**: instant, client-side, case-insensitive substring match on title + feed label
- **Bulk actions**: open all unread (tab cap configurable, default 20), mark read/starred, select multiple with `x` or shift-click
- **Feed auto-discovery**: fetches HTML, looks for `<link rel="alternate">`, tries common paths
- **OPML import**: paste or upload OPML to add feeds in bulk; unsafe/local URLs are skipped
- **View transitions**: uses the View Transition API for page navigation — browsers that don't support it just skip the animation
- **Retention**: default 3000 entries, configurable by count and/or max days (whichever hits first)

## API Notes

- Unknown `/api/*` routes return `404` JSON instead of the SPA shell.

## Config

`data/config.json` (all optional, defaults shown):

```json
{
  "maxBulkOpen": 20,
  "retention": { "maxEntries": 3000, "maxDays": null },
  "theme": "cupertino",
  "port": 8787
}
```

## Future

- Feed folders (data model supports `folderId` on feeds, no UI yet)

## Notes

- No swipe gestures, no push notifications — by design
- iOS is out of scope for now (Android via Termux + Node works)
- `data/*.json` is gitignored so personal data never gets pushed
