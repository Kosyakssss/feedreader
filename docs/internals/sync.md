# Sync

## Commands, clocks and the log

Every change to user state is a `Command` inside a `Change { id, device, at }`. The app still sends ordinary requests; the engine turns each mutation into a change in `local()` and applies every change, local or remote, through `commit()`:

- A change id is applied at most once (`changes.id` is unique), so retries and replays are harmless.
- `at` is a hybrid logical clock in microseconds: the wall clock, but never behind the newest change this engine has seen.
- Each field has a key in the `clock` table (`read:<entry>`, `pin:<feed>`, `folders:<feed>`, `settings`, …). A change writes a field only if its `at` is newer than the key's, ties broken by device id. That is the whole merge rule; it makes the order changes arrive in irrelevant.
- The `changes` log is for catch-up, not for rebuilding state; the state tables are the truth.

## Registers: a value can arrive before its row

Changes reach devices in different orders, so a feed's label, pin, hidden flag, reading mode or folders can arrive before the subscription that creates the feed's row. The clock table therefore keeps each field's winning value too (`clock.value`), not just its time, and `Engine::materialize` writes the registers into the feed's row whenever a `Subscribe` makes sure the row exists. A `Subscribe` always creates the row (it carries the only copy of the URL); whether the feed counts as subscribed is the `sub:<feed>` register, so an older subscribe never undoes a newer unsubscribe.

## Folders are rebuilt from registers

- A folder is the register `folder:<id>`: `+name`, or `-` once deleted. A feed's membership is the register `folders:<feed>`: a JSON list of folder ids. The `folders` and `folder_feeds` tables are rebuilt from these after every folder command, so they are a pure function of the registers.
- Folder ids derive from the name the folder was created with (`store::folder_id`), so two devices creating "News" agree on its id; renaming keeps the id. A name whose id is taken by a renamed or deleted folder gets a suffixed id.
- The device making a change resolves names to ids and sends `Membership(feed, [(id, name)])`. Naming a folder in a membership gives it a name register at time zero, so any real rename or delete wins over it. The older `Folders(feed, names)`, still in existing change logs, maps each name to its derived id.
- `user_version` 4 moved existing folders to derived ids and seeded their registers, after copying the database to `feedreader.sqlite.v3.bak`.

The laws in `crates/engine/src/laws.rs` check that any order of the same changes converges, that applying twice equals once, and that the result equals applying them oldest first.

## The log is seeded once

A library that existed before sync, or that was filled by importing the old app's database, has state the log never saw. On first start as a hub (and after a legacy import) the engine writes synthetic changes describing the current state with clocks 1, 2, 3…, so any real change beats them and a newly paired device still receives everything.

Anything a command needs from a row that may not exist yet is a register too. A saved link's bookmark and read state go through their clocks in `SaveLink`, and a recommendation is the register `rec:<entry>` (`+note` or `-`), applied by `pending_recommendations` once the entry arrives from a fetch or from the hub's content.

On its first start after `user_version` 4, a hub appends folder and membership changes for its current folders (`reseed_folders`, flag `folders_reseeded`), because its log still names the random ids folders had before; a satellite paired later would otherwise rebuild folders that no longer exist.

## Hub and satellite

- The hub listens on port 8790 (`FEEDREADER_SYNC_PORT`) on every interface. Every route but pairing and health needs a bearer token; tokens are stored hashed. A pairing code is single-use and lasts 15 minutes.
- Requests must name the hub in `Host`: an IP address, `localhost`, or this machine's Tailscale name (full or short). Anything else gets 421, which shuts out DNS rebinding from a web page, whose `Host` is always the attacker's domain.
- A satellite keeps its hub link in `secrets/hub.json` (0600). Its loop pushes its own unsent changes, long-polls `/v1/sync` for everyone else's (25 seconds), then pages `/v1/content` for entries the hub fetched, by a content sequence (`entries.cseq`) that moves when an entry is added or gains its body.
- A local change cuts a pending long-poll short so it goes out at once. Before long-polling an address the loop checks `/v1/health` with a 2-second limit, because a firewall in stealth mode drops connections instead of refusing them and a long-poll would otherwise hang until its timeout.
- While the hub answers, a satellite doesn't fetch feeds and takes images from the hub; when it doesn't, the satellite refreshes and fetches on its own. Nothing it fetched is uploaded: the hub fetches its own copy and the ids match.

## Protocol

`engine::PROTOCOL` changes whenever `Request`, `Event`, `Command` or `Change` changes incompatibly. The app checks the running engine's `engine.json` and replaces an engine speaking another protocol; a satellite reads the hub's from `/v1/health`, stops syncing on a mismatch and reports which side needs updating, then resumes when they agree.

## Reaching a hub

The pairing link lists the hub's Tailscale name, its LAN address and 127.0.0.1. The satellite remembers all of them and moves the one that worked to the front. On macOS with the firewall on, the hub's binary must be allowed incoming connections, or only the same machine can reach it.
