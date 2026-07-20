# Feedreader

A local-first RSS/Atom reader that runs in the browser. Portable, pretty, lightweight.

## Philosophy

- **Local-first** — everything lives on disk (`data/` folder). Sync via Syncthing, iCloud, or just copy the folder. No accounts, no cloud.
- **Minimal reading in-app** — entries open original links. The app is a _launcher_, not a reader.
- **Portable server** — uses Node.js standard APIs and runs with Bun on macOS and Linux. No Bun-specific APIs.
- **Two dependencies** — `fast-xml-parser`, `tsx`. That's it.
- **Theme choice** — pick the rounded Cupertino theme or the square Flexoki theme in Settings.
- **File-synced state** — Syncthing conflict files (`state.sync-conflict-*.json`) are auto-merged using latest-timestamp-wins per entry.
- **Safer imports/state** — feed URLs are validated on both manual add and OPML import, and entry IDs are scoped per feed so state cannot bleed across subscriptions.

## Running

```sh
bun install
bun server.ts
```

Open `http://localhost:8787`. Override the port with `--port 3000` or in `data/config.json`.
The server binds to `127.0.0.1` by default; pass `--host 0.0.0.0` only if you intentionally want LAN access.

For private access from trusted devices, install Tailscale on both devices and use the macOS LaunchAgent helper below. It keeps feedreader bound to localhost and publishes `http://127.0.0.1:8787` at `/feedreader` with Tailscale Serve inside your tailnet. Open it from another tailnet device at `https://<mac-name>.<tailnet>.ts.net/feedreader`.

Point to a custom data directory:

```sh
bun server.ts --data /path/to/data
```

## macOS startup

Install Feedreader as a user LaunchAgent:

```sh
scripts/feedreader-launch-agent.sh install
```

Useful commands:

```sh
scripts/feedreader-launch-agent.sh status
scripts/feedreader-launch-agent.sh restart
scripts/feedreader-launch-agent.sh stop
scripts/feedreader-launch-agent.sh uninstall
bun run unread
bun run unread --limit 20
```

The LaunchAgent runs `server.ts` from this checkout at login and writes logs to `~/Library/Logs/feedreader/`.
It also starts Tailscale Serve for the configured feedreader port at `/feedreader` when Tailscale is installed.
Tailscale Serve strips the `/feedreader` prefix before proxying to the local server, so Feedreader renders `/feedreader`-prefixed links automatically for `*.ts.net` hosts.

## Data

All runtime data lives in `data/`. The public feed list and themes are versioned; local state is ignored:

| File                   | Purpose                                      | Versioned |
| ---------------------- | -------------------------------------------- | --------- |
| `feeds.json`           | Feed subscriptions                           | Yes       |
| `state.json`           | Read/starred state per entry                 | No        |
| `cache.json`           | Fetched entries + fetch timestamps           | No        |
| `config.json`          | Local settings (created on first write)      | No        |
| `transaction.json`     | Crash-recovery journal for multi-file writes | No        |
| `themes/cupertino.css` | Default Cupertino theme                      | Yes       |
| `themes/flexoki.css`   | Square Flexoki theme                         | Yes       |

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
- **Bulk actions**: open all unread (tab cap configurable, default 20), mark read/starred, select multiple with `x`, shift-click, or drag-selecting the checkbox lane
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
  "port": 8787
}
```

## Future

- Feed folders (data model supports `folderId` on feeds, no UI yet)

## Notes

- No swipe gestures or push notifications — by design.
- Feed subscriptions in `data/feeds.json` are intentionally public. Never put authenticated feed URLs, cookies, tokens, or private feeds there.
- Cache, read/star state, settings, and transaction files under `data/` stay local and are ignored.
