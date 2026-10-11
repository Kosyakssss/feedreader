# Storage

## The search index is keyed by the entries table's rowid

`entries_fts` is an FTS5 table whose rowid equals `entries.rowid`. FTS5 cannot index an ordinary column, so looking rows up by entry id would scan the whole index; with a rowid link every insert, update and delete is a direct lookup. Profiling a refresh showed the scan version spending 60 ms per feed on the engine's only writer.

Consequences:

- Delete an entry's index row before the entry itself; once the entry is gone its rowid can't be found.
- Anything that deletes entries in bulk (pruning, purging removed feeds, cascades) clears the matching index rows first, or SQLite may reuse the rowid for a new entry that then inherits stale text.
- `entries` has a text primary key, so `VACUUM` may renumber its rowids. Rebuild the index after any vacuum (the `user_version` 3 migration shows how).

## One transaction per engine message

The engine actor wraps each request, internal message and refresh tick in one SQLite transaction (`Engine::within`), so a command's state change, its clocks and its change-log row commit together, and a message costs one fsync. With `synchronous = FULL` every autocommitted statement is its own fsync: marking 3000 entries read used to stall the actor for about half a second on a Mac SSD. Store methods rely on that transaction instead of opening their own, so any failed statement rolls back the whole message. The legacy import is the exception: it uses `savepoint()`, which nests inside the message's transaction (`transaction()` would fail there), so a failed import leaves nothing behind.

A store write that fails doesn't stop the message; it is recorded (`Store::failure`), and `Engine::saved` rolls the whole transaction back instead of committing, logs it, tells the user, and sends every client a fresh snapshot, because events describing the change may already have gone out.
