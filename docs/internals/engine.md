# Engine

## Clients and audiences

Everything that talks to an engine is a client: the in-process app is client 0, and `serve` numbers each socket connection. Every request reaches the actor with its client, and every event goes out with an `Audience`: `All` for changes to shared state (entries, feeds, settings, refresh, sync), or one `Client` for answers to that client's own question (its snapshot on connecting, pairing links, search results, discovery, probes, extraction jobs). Broadcasting answers made every attached app react to a terminal's `feedreader pair` (it copied the link to the clipboard) and to every CLI connection's snapshot (it reset open tabs).

The web extractor belongs to a client too. The first client that sent `UseWebExtractor` gets the `Extract` jobs; when it detaches, its unanswered jobs fall back to Readability.

## Stopping

`Request::Shutdown` ends the actor's loop after the current message commits. The engine thread then signals `serve`, which returns, so the process exits with status 0 (launchd's `KeepAlive` only restarts on failure). Apps close their handle on exit, which drains the socket writer, so the last requests (tabs, read state, `Shutdown` itself) are never lost.

## Ports

The sync listener (8790) and the public listener (8791) are per engine, not user settings, so they never sync between devices. They live in `engine.toml` (`engine::Config`) with the Funnel port, the image cache budget and extra host names; the environment variables `FEEDREADER_SYNC_PORT` and `FEEDREADER_PUBLIC_PORT` override the file, which is how tests run engines side by side. The engine reports its config in `Snapshot`, so the app shows the ports the running engine actually uses, not the ones its own environment would pick.

The engine is built, store and config included, before its thread starts, so a bad file or a database that won't open reaches the caller as an error instead of a handle to an engine that never ran.
