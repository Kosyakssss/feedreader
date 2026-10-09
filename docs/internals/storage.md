# Storage

## The search index is keyed by the entries table's rowid

`entries_fts` is an FTS5 table whose rowid equals `entries.rowid`. FTS5 cannot index an ordinary column, so looking rows up by entry id would scan the whole index; with a rowid link every insert, update and delete is a direct lookup. Profiling a refresh showed the scan version spending 60 ms per feed on the engine's only writer.

Consequences:

- Delete an entry's index row before the entry itself; once the entry is gone its rowid can't be found.
- Anything that deletes entries in bulk (pruning, purging removed feeds, cascades) clears the matching index rows first, or SQLite may reuse the rowid for a new entry that then inherits stale text.
- `entries` has a text primary key, so `VACUUM` may renumber its rowids. Rebuild the index after any vacuum (the `user_version` 3 migration shows how).
