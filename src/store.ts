// Everything that reads or writes the database.
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import type { FetchResult } from './fetch';

export type State = 'none' | 'unread' | 'read' | 'bookmarked';

export type Source = {
  id: number;
  kind: 'rss' | 'atproto';
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
  title: string;
  text: string; // only filled in for untitled entries, the only rows that show it
};

export type Scope = { where: string; args?: SQLQueryBindings[]; limit?: number };

export const scopes = {
  unread: { where: `state = 'unread'` },
  all: { where: `state <> 'none'`, limit: 500 },
  archive: { where: `state <> 'none'` },
  bookmarks: { where: `state = 'bookmarked'` },
  feed: (id: number): Scope => ({ where: 'source_id = ?', args: [id] }),
} satisfies Record<string, Scope | ((id: number) => Scope)>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('rss', 'atproto')),
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
  state TEXT NOT NULL CHECK (state IN ('none', 'unread', 'read', 'bookmarked')),
  title TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT ''
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS source_guid ON entries(source_id, guid) WHERE guid <> '';
CREATE UNIQUE INDEX IF NOT EXISTS source_url ON entries(source_id, url) WHERE url <> '';
CREATE INDEX IF NOT EXISTS timeline ON entries(published_at DESC, id DESC) WHERE state <> 'none';
CREATE INDEX IF NOT EXISTS by_source ON entries(source_id, published_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS by_state ON entries(state, published_at DESC, id DESC);
`;

const ROW = `e.id, e.source_id, s.label AS feed, e.url, e.published_at, e.state, e.title, CASE WHEN e.title = '' THEN e.text ELSE '' END AS text`;
const SEARCH_LIMIT = 200;
const EARLIEST_DATE = 631_152_000_000; // 1990: anything earlier is a broken date
const DAY = 86_400_000;

export const wordsOf = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

export function displayTitle(entry: Pick<Entry, 'title' | 'text' | 'url'>): string {
  return entry.title || entry.text || entry.url;
}

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

export class Store {
  private db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run('PRAGMA busy_timeout = 5000');
    this.db.run('PRAGMA foreign_keys = ON');
    this.db.run('PRAGMA synchronous = NORMAL');
    this.db.run(SCHEMA);
  }

  sources(): Source[] {
    return this.db.query<Source, []>('SELECT * FROM sources ORDER BY folder, label COLLATE NOCASE').all();
  }

  source(id: number): Source | null {
    return this.db.query<Source, [number]>('SELECT * FROM sources WHERE id = ?').get(id);
  }

  addSource(kind: Source['kind'], ref: string, label: string): void {
    this.db.run('INSERT INTO sources (kind, ref, label) VALUES (?, ?, ?)', [kind, ref, label]);
  }

  lastPost(id: number): number {
    return this.db.query<{ last: number | null }, [number]>('SELECT max(published_at) AS last FROM entries WHERE source_id = ?').get(id)?.last ?? 0;
  }

  // Stores a fetch and returns how many entries it added or changed.
  save(source: Source, result: FetchResult, failures: number, nextAt: number): number {
    const now = Date.now();
    const state: State = source.fetched_at === null ? 'none' : 'unread'; // a feed's first fetch is its backlog
    const dates = new Set(result.items.map((item) => item.published));
    const allSameDate = result.items.length > 3 && dates.size === 1;
    const current = new Set(result.items.map((item) => item.guid));

    const moved = this.db.query<{ id: number; guid: string }, [number, string, number, string]>('SELECT id, guid FROM entries WHERE source_id = ? AND title = ? AND published_at = ? AND guid <> ?');
    const repoint = this.db.query('UPDATE OR IGNORE entries SET guid = ?, url = ? WHERE id = ?');
    const insert = this.db.query(`INSERT OR IGNORE INTO entries (source_id, guid, url, published_at, state, title, text) VALUES (?, ?, ?, ?, ?, ?, ?)`);

    return this.db.transaction(() => {
      let changed = 0;
      for (const item of result.items) {
        // Some sites change every item's id when they redeploy. The same title at
        // the same moment in the same feed is the same post, unless the other one
        // is still in this very fetch.
        const old = item.title && item.published ? moved.all(source.id, item.title, item.published, item.guid).find((row) => !current.has(row.guid)) : undefined;
        const usable = item.published !== null && item.published > EARLIEST_DATE && item.published <= now + DAY && !allSameDate;
        changed += old ? repoint.run(item.guid, item.url, old.id).changes : insert.run(source.id, item.guid, item.url, usable ? item.published : now, state, item.title, item.text).changes;
      }
      const failed = !!result.error;
      this.db.run(`UPDATE sources SET fetched_at = ?, next_at = ?, failures = ?, error = ?, etag = ?, last_modified = ? WHERE id = ?`, [
        now,
        Math.round(nextAt),
        failures,
        result.error ?? '',
        failed ? source.etag : (result.etag ?? ''),
        failed ? source.last_modified : (result.lastModified ?? ''),
        source.id,
      ]);
      return changed;
    })();
  }

  knownCount(sourceId: number, items: FetchResult['items']): number {
    const known = this.db.query(`SELECT 1 FROM entries WHERE source_id = ? AND (guid = ? OR (url <> '' AND url = ?) OR (title <> '' AND title = ? AND published_at = ?)) LIMIT 1`);
    return items.filter((item) => known.get(sourceId, item.guid, item.url, item.title, item.published ?? 0)).length;
  }

  entries(scope: Scope): Entry[] {
    const limit = scope.limit ? `LIMIT ${scope.limit}` : '';
    return this.db
      .query<Entry, SQLQueryBindings[]>(
        `SELECT ${ROW} FROM (SELECT * FROM entries WHERE ${scope.where} ORDER BY published_at DESC, id DESC ${limit}) e
         JOIN sources s ON s.id = e.source_id ORDER BY e.published_at DESC, e.id DESC`,
      )
      .all(...(scope.args ?? []));
  }

  // Finds entries in any state by what their row shows as a title.
  searchEntries(query: string): Entry[] {
    const typed = wordsOf(query);
    if (!typed.length) return [];
    const exact: Entry[] = [];
    const partial: Entry[] = [];
    const everything = this.db.query<Entry, []>(`SELECT ${ROW} FROM entries e JOIN sources s ON s.id = e.source_id ORDER BY e.published_at DESC, e.id DESC`).all();
    for (const entry of everything) {
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

  // Bookmarked becomes read; anything else becomes bookmarked.
  toggleBookmark(id: number): Entry | null {
    this.db.run(`UPDATE entries SET state = CASE state WHEN 'bookmarked' THEN 'read' ELSE 'bookmarked' END WHERE id = ?`, [id]);
    return this.db.query<Entry, [number]>(`SELECT ${ROW} FROM entries e JOIN sources s ON s.id = e.source_id WHERE e.id = ?`).get(id);
  }

  // Marks entries read up to the newest one the page was showing, so anything
  // that arrived after the page loaded stays unread. Returns the feeds touched.
  readAll(upto: number): number[] {
    const rows = this.db.query<{ source_id: number }, [number]>(`UPDATE entries SET state = 'read' WHERE state = 'unread' AND id <= ? RETURNING source_id`).all(upto);
    return [...new Set(rows.map((row) => row.source_id))];
  }

  export(state?: State) {
    const where = state ? 'WHERE e.state = ?' : '';
    const rows = this.db
      .query<Entry, SQLQueryBindings[]>(`SELECT e.id, e.source_id, s.label AS feed, e.url, e.published_at, e.state, e.title, e.text FROM entries e JOIN sources s ON s.id = e.source_id ${where} ORDER BY e.published_at DESC, e.id DESC`)
      .all(...(state ? [state] : []));
    return rows.map((row) => ({ id: row.id, feed: row.feed, title: displayTitle(row), url: row.url, published: new Date(row.published_at).toISOString(), state: row.state, text: row.text }));
  }

  // Folds together copies of one post left behind by a site that changed its
  // address: same feed, title, date and URL path. The newest copy stays and keeps
  // the strongest state any copy had.
  mergeMoved(): number {
    type Copy = { id: number; url: string; state: State; source_id: number; title: string; published_at: number };
    const copies = this.db
      .query<Copy, []>(
        `SELECT e.id, e.url, e.state, e.source_id, e.title, e.published_at FROM entries e
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
    const strength: Record<State, number> = { none: 0, read: 1, unread: 2, bookmarked: 3 };
    return this.db.transaction(() => {
      let removed = 0;
      for (const group of groups.values()) {
        if (group.length < 2) continue;
        const state = group.reduce((best, copy) => (strength[copy.state] > strength[best] ? copy.state : best), group[0]!.state);
        for (const extra of group.slice(1)) {
          this.db.run('DELETE FROM entries WHERE id = ?', [extra.id]);
          removed++;
        }
        this.db.run('UPDATE entries SET state = ? WHERE id = ?', [state, group[0]!.id]);
      }
      return removed;
    })();
  }

  close(): void {
    this.db.close();
  }
}
