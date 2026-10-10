# Sync

## Commands, clocks and the log

Every change to user state is a `Command` inside a `Change { id, device, at }`. The app still sends ordinary requests; the engine turns each mutation into a change in `local()` and applies every change, local or remote, through `commit()`:

- A change id is applied at most once (`changes.id` is unique), so retries and replays are harmless.
- `at` is a hybrid logical clock in microseconds: the wall clock, but never behind the newest change this engine has seen.
- Each field has a key in the `clock` table (`read:<entry>`, `pin:<feed>`, `folders:<feed>`, `settings`, …). A change writes a field only if its `at` is newer than the key's, ties broken by device id. That is the whole merge rule; it makes the order changes arrive in irrelevant.
- The `changes` log is for catch-up, not for rebuilding state; the state tables are the truth.

## The log is seeded once

A library that existed before sync, or that was filled by importing the old app's database, has state the log never saw. On first start as a hub (and after a legacy import) the engine writes synthetic changes describing the current state with clocks 1, 2, 3…, so any real change beats them and a newly paired device still receives everything.

## Hub and satellite

- The hub listens on port 8790 (`FEEDREADER_SYNC_PORT`) on every interface. Every route but pairing and health needs a bearer token; tokens are stored hashed. A pairing code is single-use and lasts 15 minutes.
- Requests must name the hub in `Host`: an IP address, `localhost`, or this machine's Tailscale name (full or short). Anything else gets 421, which shuts out DNS rebinding from a web page, whose `Host` is always the attacker's domain.
- A satellite keeps its hub link in `secrets/hub.json` (0600). Its loop pushes its own unsent changes, long-polls `/v1/sync` for everyone else's (25 seconds), then pages `/v1/content` for entries the hub fetched, by a content sequence (`entries.cseq`) that moves when an entry is added or gains its body.
- A local change cuts a pending long-poll short so it goes out at once. Before long-polling an address the loop checks `/v1/health` with a 2-second limit, because a firewall in stealth mode drops connections instead of refusing them and a long-poll would otherwise hang until its timeout.
- While the hub answers, a satellite doesn't fetch feeds and takes images from the hub; when it doesn't, the satellite refreshes and fetches on its own. Nothing it fetched is uploaded: the hub fetches its own copy and the ids match.

## Reaching a hub

The pairing link lists the hub's Tailscale name, its LAN address and 127.0.0.1. The satellite remembers all of them and moves the one that worked to the front. On macOS with the firewall on, the hub's binary must be allowed incoming connections, or only the same machine can reach it.
