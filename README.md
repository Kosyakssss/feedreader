# Feedreader

Local-first RSS reader with file-based state, optional Syncthing/iCloud sync, and a lightweight Bun server.

## Requirements

- Bun 1.3+

## Quick start

```bash
bun install
bun server.ts
```

Open `http://localhost:8787`.

You can override the port:

```bash
bun server.ts --port 3000
```

You can also point to a custom data directory:

```bash
bun server.ts --data /path/to/data
```

## What it does

- Fetches RSS/Atom feeds and stores entries in a local cache
- Tracks read/starred state in local JSON files
- Supports bulk actions, keyboard shortcuts, OPML import, and per-feed views
- Supports defuddled reading mode via `/read?url=...`
- Supports switchable CSS themes from `data/themes/*.css`

## Data model

Runtime data lives in `data/`:

- `feeds.json`: subscriptions
- `state.json`: read/starred state
- `cache.json`: fetched entries + fetch timestamps
- `config.json`: settings (created on first write)
- `themes/*.css`: theme files

Important: `data/*.json` is gitignored, so personal feed/state/config data is not pushed to remote.

## Security behavior

- `/api/proxy` and `/read` only allow external `http/https` targets
- localhost/private network targets are blocked
- theme names are sanitized to prevent path traversal
- malformed input returns `400` errors
- request body size is capped

## Tests

Run all tests:

```bash
bun test
```

Test coverage includes:

- feed/OPML parsing
- retention pruning
- security URL/theme validation
- server integration checks for hardened endpoints

## Notes for syncing across devices

If you sync `data/` between devices (for example with Syncthing), your read/star state and subscriptions stay aligned.
The server includes conflict merge logic for `state.sync-conflict-*.json` files.
