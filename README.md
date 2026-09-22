# Feedreader

A self-hosted feed reader with a web UI and a terminal client. The Bun server fetches feeds and keeps subscriptions, entries, and read/starred state in one place; both clients use the same API. It supports RSS, Atom, and JSON Feed, plus OPML import and export.

## Run the server

Install [Bun](https://bun.sh/), then run:

```sh
bun install
bun run build
bun run start
```

Open [http://127.0.0.1:8787/feedreader/](http://127.0.0.1:8787/feedreader/). The server listens on localhost by default and stores its SQLite database and configuration in `data/`.

## Use the terminal client

Install Rust, leave the server running, and run:

```sh
bun run tui
```

The client connects to the local server by default. Use `bun run tui --server URL` or `FEEDREADER_URL` for another server, and `bun run tui --check` to test the connection. Press `?` for shortcuts; `1`–`4` switch views, `j`/`k` move through entries, and `q` quits. Mouse navigation, scrolling, selection, and hover are supported.

See the [terminal client guide](tui/README.md) for the rest of the controls and appearance options.
