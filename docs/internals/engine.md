# Engine

## Clients and audiences

Everything that talks to an engine is a client: the in-process app is client 0, and `serve` numbers each socket connection. Every request reaches the actor with its client, and every event goes out with an `Audience`: `All` for changes to shared state (entries, feeds, settings, refresh, sync), or one `Client` for answers to that client's own question (its snapshot on connecting, pairing links, search results, discovery, probes, extraction jobs). Broadcasting answers made every attached app react to a terminal's `feedreader pair` (it copied the link to the clipboard) and to every CLI connection's snapshot (it reset open tabs).

The web extractor belongs to a client too. The first client that sent `UseWebExtractor` gets the `Extract` jobs; when it detaches, its unanswered jobs fall back to Readability.

## Stopping

`Request::Shutdown` ends the actor's loop after the current message commits. The engine thread then signals `serve`, which returns, so the process exits with status 0 (launchd's `KeepAlive` only restarts on failure). Apps close their handle on exit, which drains the socket writer, so the last requests (tabs, read state, `Shutdown` itself) are never lost.

## Ports

The sync listener (8790, `FEEDREADER_SYNC_PORT`) and the public listener (8791, `FEEDREADER_PUBLIC_PORT`) are per engine, not user settings, so they never sync between devices. The engine-wide TOML file in spec §4 is where they will live.
