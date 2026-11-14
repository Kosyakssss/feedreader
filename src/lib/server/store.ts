// Everything that reads or writes the database.
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { displayTitle, TIMELINE_STEP } from '../format';
import type { FetchResult } from './fetch';

// none: from before the feed was followed, shown only on its own page.
export type State = 'none' | 'unread' | 'read';

export type Source = {
  id: number;
  kind: 'rss' | 'atproto' | 'page'; // 'page' holds bookmarked pages that came from no feed
  ref: string;
  label: string;
  folder: string;
  etag: string;
  last_modified: string;
  fetched_at: number | null;
  next_at: number | null;
  failures: number;
  error: string;
};

export type Entry = {
  id: number;
  source_id: number;
  feed: string;
  url: string;
  published_at: number;
  state: State;
  bookmarked: 0 | 1;
  page: 0 | 1; // bookmarked from a link, not from a feed
  title: string;
  text: string; // only filled in for untitled entries, the only rows that show it
};

export type Mark = { read?: boolean; bookmarked?: boolean };

export type Scope = { where: string; args?: SQLQueryBindings[]; limit?: number };

// Entries whose title has one of their feed's muted words in it.
const NOT_MUTED = `NOT EXISTS (SELECT 1 FROM mutes m WHERE m.source_id = entries.source_id AND instr(lower(entries.title), m.word) > 0)`;

export const scopes = {
  unread: { where: `state = 'unread' AND bookmarked = 0 AND ${NOT_MUTED}` },
  timeline: { where: `state <> 'none' AND ${NOT_MUTED}`, limit: TIMELINE_STEP },
  bookmarks: { where: 'bookmarked = 1' },
  feed: (id: number): Scope => ({ where: 'source_id = ?', args: [id] }),
} satisfies Record<string, Scope | ((id: number) => Scope)>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('rss', 'atproto', 'page')),
  ref TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  folder TEXT NOT NULL DEFAULT '',
  etag TEXT NOT NULL DEFAULT '',
  last_modified TEXT NOT NULL DEFAULT '',
  fetched_at INTEGER,
  next_at INTEGER,
  failures INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT ''
) STRICT;
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  guid TEXT NOT NULL,
  url TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('none', 'unread', 'read')),
  bookmarked INTEGER NOT NULL DEFAULT 0 CHECK (bookmarked IN (0, 1)),
  title TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT ''
) STRICT;
CREATE TABLE IF NOT EXISTS mutes (
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  word TEXT NOT NULL, -- lower case
  PRIMARY KEY (source_id, word)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS source_guid ON entries(source_id, guid) WHERE guid <> '';
CREATE UNIQUE INDEX IF NOT EXISTS source_url ON entries(source_id, url) WHERE url <> '';
CREATE INDEX IF NOT EXISTS timeline ON entries(published_at DESC, id DESC) WHERE state <> 'none';
CREATE INDEX IF NOT EXISTS bookmarks ON entries(published_at DESC, id DESC) WHERE bookmarked = 1;
CREATE INDEX IF NOT EXISTS by_source ON entries(source_id, published_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS by_state ON entries(state, published_at DESC, id DESC);
`;

// Databases from before read and bookmarked were two things kept "bookmarked"
// as a fourth state. It becomes read and bookmarked. SQLite can't change a
// table's checks in place, so the tables are copied into the new shape.
const FLAGS_MIGRATION = `
ALTER TABLE sources RENAME TO sources_old;
ALTER TABLE entries RENAME TO entries_old;
DROP INDEX IF EXISTS source_guid;
DROP INDEX IF EXISTS source_url;
DROP INDEX IF EXISTS timeline;
DROP INDEX IF EXISTS by_source;
DROP INDEX IF EXISTS by_state;
${SCHEMA}
INSERT INTO sources SELECT * FROM sources_old;
INSERT INTO entries (id, source_id, guid, url, published_at, state, bookmarked, title, text)
  SELECT id, source_id, guid, url, published_at, CASE state WHEN 'bookmarked' THEN 'read' ELSE state END, state = 'bookmarked', title, text
  FROM entries_old;
DROP TABLE entries_old;
DROP TABLE sources_old;
`;

const ROW = `e.id, e.source_id, s.label AS feed, e.url, e.published_at, e.state, e.bookmarked, s.kind = 'page' AS page, e.title, CASE WHEN e.title = '' THEN e.text ELSE '' END AS text`;
const SEARCH_LIMIT = 200;
const EARLIEST_DATE = 631_152_000_000; // 1990: anything earlier is a broken date
const DAY = 86_400_000;

const wordsOf = (text: string) =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

// Every typed word must be a word of the title. The last one may still be being
// typed, so it can match the start of a word.
function matchWords(typed: string[], title: string[]): 'exact' | 'partial' | null {
  let result: 'exact' | 'partial' = 'exact';
  for (const [index, word] of typed.entries()) {
    if (title.includes(word)) continue;
    if (index === typed.length - 1 && title.some((candidate) => candidate.startsWith(word))) result = 'partial';
    else return null;
  }
  return result;
}

// What a change touched, told to whoever keeps a copy: some entries, the
// feeds (their names, errors, folders, muted words), or too much to list.
export type Change = { entries: number[] } | { sources: true } | { everything: true };

export class Store {
  private db: Database;
  onChange: (change: Change) => void = () => {};

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run('PRAGMA busy_timeout = 5000');
    this.db.run('PRAGMA synchronous = NORMAL');
    const columns = this.db.query<{ name: string }, []>(`SELECT name FROM pragma_table_info('entries')`).all();
    if (columns.length && !columns.some((column) => column.name === 'bookmarked')) {
      this.db.transaction(() => this.db.run(FLAGS_MIGRATION))();
    } else {
      this.db.run(SCHEMA);
    }
    this.db.run('PRAGMA foreign_keys = ON');
  }

  sources(): Source[] {
    return this.db
      .query<Source, []>(`SELECT * FROM sources WHERE kind <> 'page' ORDER BY folder, label COLLATE NOCASE`)
      .all();
  }

  source(id: number): Source | null {
    return this.db.query<Source, [number]>('SELECT * FROM sources WHERE id = ?').get(id);
  }

  // Adds a feed, or finds it if it is already followed. Returns its id.
  addSource(kind: Source['kind'], ref: string, label: string, folder = ''): number {
    this.addSources([{ kind, ref, label, folder }]);
    return this.db.query<{ id: number }, [string]>('SELECT id FROM sources WHERE ref = ?').get(ref)!.id;
  }

  // Adds the feeds of a list, skipping any already followed. Returns the new ids.
  addSources(sources: Pick<Source, 'kind' | 'ref' | 'label' | 'folder'>[]): number[] {
    const insert = this.db.query('INSERT OR IGNORE INTO sources (kind, ref, label, folder) VALUES (?, ?, ?, ?)');
    const ids = this.db.transaction(() =>
      sources.flatMap((source) => {
        const added = insert.run(source.kind, source.ref, source.label, source.folder);
        return added.changes ? [Number(added.lastInsertRowid)] : [];
      }),
    )();
    if (ids.length) this.onChange({ sources: true });
    return ids;
  }

  mutesBySource(): Record<number, string[]> {
    const rows = this.db
      .query<{ source_id: number; word: string }, []>('SELECT source_id, word FROM mutes ORDER BY word')
      .all();
    const all: Record<number, string[]> = {};
    for (const row of rows) (all[row.source_id] ??= []).push(row.word);
    return all;
  }

  lastPost(id: number): number {
    return (
      this.db
        .query<{ last: number | null }, [number]>('SELECT max(published_at) AS last FROM entries WHERE source_id = ?')
        .get(id)?.last ?? 0
    );
  }

  // Stores a fetch and returns how many entries it added or changed.
  save(source: Source, result: FetchResult, failures: number, nextAt: number): number {
    const now = Date.now();
    const state: State = source.fetched_at === null ? 'none' : 'unread'; // a feed's first fetch is its backlog
    const dates = new Set(result.items.map((item) => item.published));
    const allSameDate = result.items.length > 3 && dates.size === 1;
    const current = new Set(result.items.map((item) => item.guid));

    const moved = this.db.query<{ id: number; guid: string }, [number, string, number, string]>(
      'SELECT id, guid FROM entries WHERE source_id = ? AND title = ? AND published_at = ? AND guid <> ?',
    );
    const repoint = this.db.query('UPDATE OR IGNORE entries SET guid = ?, url = ? WHERE id = ?');
    const insert = this.db.query(
      `INSERT OR IGNORE INTO entries (source_id, guid, url, published_at, state, title, text) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    const saved = this.db.transaction(() => {
      const touched: number[] = [];
      for (const item of result.items) {
        // Some sites change every item's id when they redeploy. The same title at
        // the same moment in the same feed is the same post, unless the other one
        // is still in this very fetch.
        const old =
          item.title && item.published
            ? moved.all(source.id, item.title, item.published, item.guid).find((row) => !current.has(row.guid))
            : undefined;
        const usable =
          item.published !== null && item.published > EARLIEST_DATE && item.published <= now + DAY && !allSameDate;
        const done = old
          ? repoint.run(item.guid, item.url, old.id)
          : insert.run(source.id, item.guid, item.url, usable ? item.published : now, state, item.title, item.text);
        if (done.changes) touched.push(old ? old.id : Number(done.lastInsertRowid));
      }
      const failed = !!result.error;
      this.db.run(
        `UPDATE sources SET fetched_at = ?, next_at = ?, failures = ?, error = ?, etag = ?, last_modified = ? WHERE id = ?`,
        [
          now,
          Math.round(nextAt),
          failures,
          result.error ?? '',
          failed ? source.etag : (result.etag ?? ''),
          failed ? source.last_modified : (result.lastModified ?? ''),
          source.id,
        ],
      );
      return touched;
    })();
    if (saved.length) this.onChange({ entries: saved });
    if ((result.error ?? '') !== source.error) this.onChange({ sources: true });
    return saved.length;
  }

  knownCount(sourceId: number, items: FetchResult['items']): number {
    const known = this.db.query(
      `SELECT 1 FROM entries WHERE source_id = ? AND (guid = ? OR (url <> '' AND url = ?) OR (title <> '' AND title = ? AND published_at = ?)) LIMIT 1`,
    );
    return items.filter((item) => known.get(sourceId, item.guid, item.url, item.title, item.published ?? 0)).length;
  }

  // Newest first.
  entries(scope: Scope): Entry[] {
    const limit = scope.limit ? `LIMIT ${scope.limit}` : '';
    return this.db
      .query<Entry, SQLQueryBindings[]>(
        `SELECT ${ROW} FROM (SELECT * FROM entries WHERE ${scope.where} ORDER BY published_at DESC, id DESC ${limit}) e
         JOIN sources s ON s.id = e.source_id ORDER BY e.published_at DESC, e.id DESC`,
      )
      .all(...(scope.args ?? []));
  }

  entry(id: number): Entry | null {
    return this.db
      .query<Entry, [number]>(`SELECT ${ROW} FROM entries e JOIN sources s ON s.id = e.source_id WHERE e.id = ?`)
      .get(id);
  }

  // Finds entries in any state by what their row shows as a title.
  searchEntries(query: string): Entry[] {
    const typed = wordsOf(query);
    if (!typed.length) return [];
    const exact: Entry[] = [];
    const partial: Entry[] = [];
    for (const entry of this.allEntries()) {
      const found = matchWords(typed, wordsOf(displayTitle(entry)));
      if (found === 'exact') exact.push(entry);
      else if (found === 'partial') partial.push(entry);
    }
    return [...exact, ...partial].slice(0, SEARCH_LIMIT);
  }

  // Finds feeds by name first, then by address or folder.
  searchFeeds(query: string): Source[] {
    const typed = wordsOf(query);
    if (!typed.length) return [];
    const byName: Source[] = [];
    const byOther: Source[] = [];
    for (const source of this.sources()) {
      if (matchWords(typed, wordsOf(source.label))) byName.push(source);
      else if (matchWords(typed, wordsOf(`${source.ref} ${source.folder}`))) byOther.push(source);
    }
    return [...byName, ...byOther];
  }

  // Marks entries read or unread, bookmarked or not: one pressed, or several
  // chosen together. Bookmarking something never seen counts as seeing it, so
  // it joins the timeline as read; otherwise read and bookmarked are separate.
  // Answers with the entries as they now are.
  mark(ids: number[], change: Mark): Entry[] {
    this.db.transaction(() => {
      for (const id of ids) {
        if (change.read !== undefined)
          this.db.run('UPDATE entries SET state = ? WHERE id = ?', [change.read ? 'read' : 'unread', id]);
        if (change.bookmarked !== undefined)
          this.db.run(
            `UPDATE entries SET bookmarked = ?1, state = CASE WHEN ?1 AND state = 'none' THEN 'read' ELSE state END WHERE id = ?2`,
            [change.bookmarked ? 1 : 0, id],
          );
      }
    })();
    const entries = ids.map((id) => this.entry(id)).filter((entry) => entry !== null);
    if (entries.length) this.onChange({ entries: entries.map((entry) => entry.id) });
    return entries;
  }

  // A page bookmarked from its link. If some feed already has it, that entry
  // is bookmarked instead of keeping a second copy.
  bookmarkPage(url: string, title: string): Entry {
    const known = this.db
      .query<{ id: number }, [string]>('SELECT id FROM entries WHERE url = ? ORDER BY id LIMIT 1')
      .get(url);
    if (known) return this.mark([known.id], { bookmarked: true })[0]!;
    const { id } = this.db
      .query<{ id: number }, [number, string, string, number, string]>(
        `INSERT INTO entries (source_id, guid, url, published_at, state, bookmarked, title) VALUES (?, ?, ?, ?, 'read', 1, ?) RETURNING id`,
      )
      .get(this.pageSource(), url, url, Date.now(), title)!;
    this.onChange({ entries: [id] });
    return this.entry(id)!;
  }

  // The one source that bookmarked pages belong to, made the first time it's needed.
  private pageSource(): number {
    this.db.run(`INSERT OR IGNORE INTO sources (kind, ref, label) VALUES ('page', 'pages', 'Pages')`);
    return this.db.query<{ id: number }, []>(`SELECT id FROM sources WHERE kind = 'page'`).get()!.id;
  }

  // Removes a feed and its entries. Bookmarks stay, as bookmarked pages.
  removeSource(id: number): void {
    this.db.transaction(() => {
      this.db.run('UPDATE OR IGNORE entries SET source_id = ? WHERE source_id = ? AND bookmarked = 1', [
        this.pageSource(),
        id,
      ]);
      this.db.run(`DELETE FROM sources WHERE id = ? AND kind <> 'page'`, [id]);
    })();
    this.onChange({ everything: true });
  }

  mutes(sourceId: number): string[] {
    return this.db
      .query<{ word: string }, [number]>('SELECT word FROM mutes WHERE source_id = ? ORDER BY word')
      .all(sourceId)
      .map((row) => row.word);
  }

  setMutes(sourceId: number, words: string[]): string[] {
    const clean = [...new Set(words.map((word) => word.trim().toLowerCase()).filter(Boolean))];
    this.db.transaction(() => {
      this.db.run('DELETE FROM mutes WHERE source_id = ?', [sourceId]);
      for (const word of clean) this.db.run('INSERT INTO mutes (source_id, word) VALUES (?, ?)', [sourceId, word]);
    })();
    this.onChange({ sources: true });
    return this.mutes(sourceId);
  }

  // Everything a copy of the app shows: every entry, and every feed with its
  // muted words.
  library(): { entries: Entry[]; sources: Source[]; mutes: Record<number, string[]> } {
    return { entries: this.allEntries(), sources: this.sources(), mutes: this.mutesBySource() };
  }

  // Every entry, newest first, as rows show them.
  private allEntries(): Entry[] {
    return this.db
      .query<Entry, []>(
        `SELECT ${ROW} FROM entries e JOIN sources s ON s.id = e.source_id ORDER BY e.published_at DESC, e.id DESC`,
      )
      .all();
  }

  entriesById(ids: number[]): Entry[] {
    if (!ids.length) return [];
    return this.db
      .query<Entry, number[]>(
        `SELECT ${ROW} FROM entries e JOIN sources s ON s.id = e.source_id WHERE e.id IN (${ids.map(() => '?').join(',')})`,
      )
      .all(...ids);
  }

  export(only?: 'unread' | 'bookmarked') {
    const where =
      only === 'unread' ? `WHERE e.state = 'unread'` : only === 'bookmarked' ? 'WHERE e.bookmarked = 1' : '';
    const rows = this.db
      .query<Entry, []>(
        `SELECT e.id, e.source_id, s.label AS feed, e.url, e.published_at, e.state, e.bookmarked, e.title, e.text FROM entries e JOIN sources s ON s.id = e.source_id ${where} ORDER BY e.published_at DESC, e.id DESC`,
      )
      .all();
    return rows.map((row) => ({
      id: row.id,
      feed: row.feed,
      title: displayTitle(row),
      url: row.url,
      published: new Date(row.published_at).toISOString(),
      state: row.state,
      bookmarked: row.bookmarked === 1,
      text: row.text,
    }));
  }

  // Folds together copies of one post left behind by a site that changed its
  // address: same feed, title, date and URL path. The newest copy stays and keeps
  // the strongest state any copy had, and a bookmark if any copy had one.
  mergeMoved(): number {
    type Copy = Pick<Entry, 'id' | 'url' | 'state' | 'bookmarked' | 'source_id' | 'title' | 'published_at'>;
    const copies = this.db
      .query<Copy, []>(
        `SELECT e.id, e.url, e.state, e.bookmarked, e.source_id, e.title, e.published_at FROM entries e
         JOIN (SELECT source_id s, title t, published_at p FROM entries WHERE title <> '' GROUP BY 1, 2, 3 HAVING count(*) > 1) d
         ON e.source_id = d.s AND e.title = d.t AND e.published_at = d.p ORDER BY e.id DESC`,
      )
      .all();
    const groups = new Map<string, Copy[]>();
    for (const copy of copies) {
      let path = copy.url;
      try {
        path = new URL(copy.url).pathname;
      } catch {}
      const key = JSON.stringify([copy.source_id, copy.title, copy.published_at, path]);
      groups.set(key, [...(groups.get(key) ?? []), copy]);
    }
    const strength: Record<State, number> = { none: 0, read: 1, unread: 2 };
    return this.db.transaction(() => {
      let removed = 0;
      for (const group of groups.values()) {
        if (group.length < 2) continue;
        const state = group.reduce(
          (best, copy) => (strength[copy.state] > strength[best] ? copy.state : best),
          group[0]!.state,
        );
        for (const extra of group.slice(1)) {
          this.db.run('DELETE FROM entries WHERE id = ?', [extra.id]);
          removed++;
        }
        const bookmarked = group.some((copy) => copy.bookmarked) ? 1 : 0;
        this.db.run('UPDATE entries SET state = ?, bookmarked = ? WHERE id = ?', [state, bookmarked, group[0]!.id]);
      }
      return removed;
    })();
  }
}
