# Feedreader

A self-hosted feed reader with a web UI. The Bun server fetches feeds and keeps subscriptions, entries, and read and bookmark state in one place. It supports RSS, Atom, and JSON Feed, plus OPML import and export.

## Run the server

Install [Bun](https://bun.sh/), then run:

```sh
bun install
bun run build
bun run start
```

Open [http://127.0.0.1:8787/feedreader/](http://127.0.0.1:8787/feedreader/). The server listens on localhost by default and stores its SQLite database and configuration in `data/`.
