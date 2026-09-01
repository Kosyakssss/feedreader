# Feedreader

A local-first RSS/Atom reader that runs in the browser. Portable, pretty, lightweight.

## Philosophy

- **Local-first** — everything lives on disk (`data/` folder). Sync via Syncthing, iCloud, or just copy the folder. No accounts, no cloud.
- **Minimal reading in-app** — entries open original links. The app is a _launcher_, not a reader.
- **Portable server** — runs on Bun 1.4 or newer on macOS and Linux.
- **No runtime dependencies** — HTTP, static files, and XML parsing use Bun APIs.
- **Framework-free typed client** — browser code is TypeScript and native DOM/CSS, bundled in memory by Bun when the server starts.
- **Theme choice** — one adaptive system theme follows the browser and macOS light/dark appearance.
- **File-synced state** — Syncthing conflict files (`state.sync-conflict-*.json`) are auto-merged using latest-timestamp-wins per entry.
- **Safer imports/state** — feed URLs are validated on both manual add and OPML import, and entry IDs are scoped per feed so state cannot bleed across subscriptions.

## Running

```sh
bun install
bun start
```

Open `http://localhost:8787`. Override the port with `--port 3000` or in `data/config.json`.
The server binds to `127.0.0.1` by default; pass `--host 0.0.0.0` only if you intentionally want LAN access.

For private access from trusted devices, install Tailscale on both devices and use the macOS LaunchAgent helper below. It keeps feedreader bound to localhost and publishes `http://127.0.0.1:8787` at `/feedreader` with Tailscale Serve inside your tailnet. Open it from another tailnet device at `https://<mac-name>.<tailnet>.ts.net/feedreader`.

The server only accepts requests whose raw `Host` header matches localhost (on its port) or an origin listed in `trustedOrigins` in `data/config.json` — e.g. `"trustedOrigins": ["https://airm1.toyger-tautara.ts.net"]`. Add your Serve hostname there before using the tailnet URL; mutations from browsers also require that origin to match the request's `Origin`. `X-Forwarded-*` headers are never used for these trust decisions. Changes require a restart.

Point to a custom data directory:

```sh
bun start -- --data /path/to/data
```

Only run one feedreader process per data directory. Writes are atomic
per-file with last-writer-wins semantics, so two live processes sharing a
directory can interleave and silently lose state (the port only prevents
address conflicts, not data races).

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
bun run unread -- --limit 20
```

The LaunchAgent runs `server.ts` from this checkout at login and writes logs to `~/Library/Logs/feedreader/`.
It also checks Tailscale Serve every minute and restores the `/feedreader` route if Tailscale or another local service removes it.
Tailscale Serve strips the `/feedreader` prefix before proxying to the local server, so Feedreader renders `/feedreader`-prefixed links automatically for `*.ts.net` hosts.

## Data

All runtime data lives in `data/`. The feed list and system theme are versioned; local state is ignored:

| File                   | Purpose                                      | Versioned |
| ---------------------- | -------------------------------------------- | --------- |
| `feeds.json`           | Feed subscriptions                           | Yes       |
| `state.json`           | Read/starred state per entry                 | No        |
| `cache.json`           | Fetched entries + fetch timestamps           | No        |
| `config.json`          | Local settings (created on first write)      | No        |
| `transaction.json`     | Crash-recovery journal for multi-file writes | No        |
| `themes/system.css`    | Adaptive system light/dark design tokens       | Yes       |

## Pages

| Route       | Page                                            |
| ----------- | ----------------------------------------------- |
| `/`         | Timeline — all entries, newest first            |
| `/starred`  | Starred entries                                 |
| `/feeds`    | Feed management, add/remove/OPML import         |
| `/feed/:id` | Per-feed view                                   |
| `/settings` | Config (also editable by hand in `config.json`) |

## Features

- **Keyboard-driven**: `j`/`k` navigate, `o` open, `m` toggle read, `s` toggle star, `x` select, `a` mark all read, `r` refresh, `?` shortcuts overlay
- **Bulk actions**: open all unread (tab cap configurable, default 20), mark read/starred, select multiple with `x`, shift-click, or drag-selecting the checkbox lane
- **Feed auto-discovery**: fetches HTML, looks for `<link rel="alternate">`, tries common paths
- **OPML import**: paste or upload OPML to add feeds in bulk; unsafe/local URLs are skipped
- **Incremental rendering**: keyed DOM reconciliation preserves entry identity, while targeted Web Animations reveal only newly inserted entries
- **Keyed live updates**: refreshed entries appear at their sorted position without rebuilding unchanged rows or moving a scrolled reading position
- **Live UI synchronization**: refresh progress and saved changes stream to every connected browser instance through native server-sent events
- **Retention**: default 3000 entries, configurable by count and/or max days (whichever hits first)

## API Notes

- Unknown `/api/*` routes return `404` JSON instead of the SPA shell.

## Config

`data/config.json` (all optional, defaults shown):

```json
{
  "maxBulkOpen": 20,
  "retention": { "maxEntries": 3000, "maxDays": null },
  "theme": "system",
  "port": 8787
}
```

## Future

- Feed folders (data model supports `folderId` on feeds, no UI yet)

## Notes

- No swipe gestures or push notifications — by design.
- Feed subscriptions in `data/feeds.json` are intentionally public. Never put authenticated feed URLs, cookies, tokens, or private feeds there.
- Cache, read/star state, settings, and transaction files under `data/` stay local and are ignored.
