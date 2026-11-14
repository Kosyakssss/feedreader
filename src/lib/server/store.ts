// Everything that reads or writes the database.
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { displayTitle } from '../format';
import type { FetchResult } from './fetch';

export type Source = {
  id: number;
  kind: 'rss' | 'atproto' | 'page'; // 'page' is a site whose pages were kept from their links, not from a feed
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
  kept: 0 | 1;
  site: string | null; // kept from its link, not from a feed: the site it is from
  title: string;
  text: string; // only filled in for untitled entries, the only rows that show it
};

export type Scope = { where: string; args?: SQLQueryBindings[]; limit?: number };

// Entries whose title has one of their feed's muted words in it.
const NOT_MUTED = `NOT EXISTS (SELECT 1 FROM mutes m WHERE m.source_id = entries.source_id AND instr(lower(entries.title), m.word) > 0)`;

export const scopes = {
  // The newest hundred: everything older is the archive.
  latest: { where: `backlog = 0 AND ${NOT_MUTED}`, limit: 100 },
  kept: { where: 'kept = 1' },
  feed: (id: number): Scope => ({ where: 'source_id = ?', args: [id], limit: 100 }),
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
  backlog INTEGER NOT NULL DEFAULT 0 CHECK (backlog IN (0, 1)), -- from before the feed was followed: only on its own page
  kept INTEGER NOT NULL DEFAULT 0 CHECK (kept IN (0, 1)),
  title TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT ''
) STRICT;
CREATE TABLE IF NOT EXISTS mutes (
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  word TEXT NOT NULL, -- lower case
  PRIMARY KEY (source_id, word)
) STRICT;
CREATE TABLE IF NOT EXISTS cuts (
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  text TEXT NOT NULL, -- taken out of the source's titles wherever it appears
  PRIMARY KEY (source_id, text)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS source_guid ON entries(source_id, guid) WHERE guid <> '';
CREATE UNIQUE INDEX IF NOT EXISTS source_url ON entries(source_id, url) WHERE url <> '';
CREATE INDEX IF NOT EXISTS latest ON entries(published_at DESC, id DESC) WHERE backlog = 0;
CREATE INDEX IF NOT EXISTS kept ON entries(published_at DESC, id DESC) WHERE kept = 1;
CREATE INDEX IF NOT EXISTS by_source ON entries(source_id, published_at DESC, id DESC);
`;

const ROW = `e.id, e.source_id, s.label AS feed, e.url, e.published_at, e.kept, CASE WHEN s.kind = 'page' THEN s.ref END AS site, e.title, CASE WHEN e.title = '' THEN e.text ELSE '' END AS text`;
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

// A title with every cut taken out wherever it appears, in any case. A cut
// that would leave nothing leaves the title as it was.
export function cutFrom(title: string, cuts: string[]): string {
  const escaped = cuts.map((cut) => cut.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const cut = title
    .replace(new RegExp(escaped.join('|'), 'gi'), ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cut || title;
}

export class Store {
  private db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run('PRAGMA busy_timeout = 5000');
    this.db.run('PRAGMA synchronous = NORMAL');
    this.migrate();
    this.db.run('PRAGMA foreign_keys = ON');
    this.splitPages();
  }

  // Entries once had a state, read, unread or never seen ("none"), and before
  // that "bookmarked" as a fourth one. Only never seen still matters, as the
  // backlog; bookmarked is kept. SQLite can't change a table's checks in
  // place, so older tables are copied into the new shape.
  private migrate(): void {
    const columns = new Set(
      this.db
        .query<{ name: string }, []>(`SELECT name FROM pragma_table_info('entries')`)
        .all()
        .map((column) => column.name),
    );
    if (!columns.size || columns.has('backlog')) return void this.db.run(SCHEMA);
    const kept = columns.has('bookmarked') ? 'bookmarked' : `state = 'bookmarked'`;
    const sources = this.db.query<{ sql: string }, []>(`SELECT sql FROM sqlite_master WHERE name = 'sources'`).get();
    const oldSources = !sources?.sql.includes("'page'"); // from before pages could be kept
    const indexes = this.db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'entries' AND sql IS NOT NULL`,
      )
      .all();
    this.db.run('PRAGMA legacy_alter_table = ON'); // other tables keep pointing at "sources", not at its old copy
    this.db.transaction(() => {
      for (const { name } of indexes) this.db.run(`DROP INDEX ${name}`);
      this.db.run('ALTER TABLE entries RENAME TO entries_old');
      if (oldSources) this.db.run('ALTER TABLE sources RENAME TO sources_old');
      this.db.run(SCHEMA);
      if (oldSources) this.db.run('INSERT INTO sources SELECT * FROM sources_old');
      this.db.run(
        `INSERT INTO entries (id, source_id, guid, url, published_at, backlog, kept, title, text)
         SELECT id, source_id, guid, url, published_at, state = 'none', ${kept}, title, text FROM entries_old`,
      );
      this.db.run('DROP TABLE entries_old');
      if (oldSources) this.db.run('DROP TABLE sources_old');
    })();
    this.db.run('PRAGMA legacy_alter_table = OFF');
  }

  // Pages kept from their links once all belonged to one source, "Pages".
  // Each now belongs to its site's.
  private splitPages(): void {
    const old = this.db.query<{ id: number }, []>(`SELECT id FROM sources WHERE kind = 'page' AND ref = 'pages'`).get();
    if (!old) return;
    const pages = this.db.query<{ id: number; url: string }, [number]>(
      'SELECT id, url FROM entries WHERE source_id = ?',
    );
    this.db.transaction(() => {
      for (const page of pages.all(old.id))
        this.db.run('UPDATE OR IGNORE entries SET source_id = ? WHERE id = ?', [this.siteSource(page.url), page.id]);
      this.db.run('DELETE FROM sources WHERE id = ?', [old.id]);
    })();
  }

  // The feeds followed.
  sources(): Source[] {
    return this.db
      .query<Source, []>(`SELECT * FROM sources WHERE kind <> 'page' ORDER BY folder, label COLLATE NOCASE`)
      .all();
  }

  keptCount(): number {
    return this.db.query<{ count: number }, []>('SELECT count(*) AS count FROM entries WHERE kept = 1').get()!.count;
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
    return ids;
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
    const backlog = source.fetched_at === null ? 1 : 0; // a feed's first fetch is its backlog
    const dates = new Set(result.items.map((item) => item.published));
    const allSameDate = result.items.length > 3 && dates.size === 1;
    const current = new Set(result.items.map((item) => item.guid));

    const moved = this.db.query<{ id: number; guid: string }, [number, string, number, string]>(
      'SELECT id, guid FROM entries WHERE source_id = ? AND title = ? AND published_at = ? AND guid <> ?',
    );
    const repoint = this.db.query('UPDATE OR IGNORE entries SET guid = ?, url = ? WHERE id = ?');
    const insert = this.db.query(
      `INSERT OR IGNORE INTO entries (source_id, guid, url, published_at, backlog, title, text) VALUES (?, ?, ?, ?, ?, ?, ?)`,
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
          : insert.run(source.id, item.guid, item.url, usable ? item.published : now, backlog, item.title, item.text);
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
    const rows = this.db
      .query<Entry, SQLQueryBindings[]>(
        `SELECT ${ROW} FROM (SELECT * FROM entries WHERE ${scope.where} ORDER BY published_at DESC, id DESC ${limit}) e
         JOIN sources s ON s.id = e.source_id ORDER BY e.published_at DESC, e.id DESC`,
      )
      .all(...(scope.args ?? []));
    return this.cut(rows);
  }

  entry(id: number): Entry | null {
    const row = this.db
      .query<Entry, [number]>(`SELECT ${ROW} FROM entries e JOIN sources s ON s.id = e.source_id WHERE e.id = ?`)
      .get(id);
    return row && this.cut([row])[0]!;
  }

  // Finds entries, the backlog too, by what their row shows as a title.
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

  // Keeps entries, or stops keeping them. Keeping something from the backlog
  // brings it out, onto the home page. Answers with the entries as they now are.
  keep(ids: number[], kept: boolean): Entry[] {
    this.db.transaction(() => {
      for (const id of ids)
        this.db.run('UPDATE entries SET kept = ?1, backlog = CASE WHEN ?1 THEN 0 ELSE backlog END WHERE id = ?2', [
          kept ? 1 : 0,
          id,
        ]);
    })();
    return ids.map((id) => this.entry(id)).filter((entry) => entry !== null);
  }

  // A page kept from its link. If some feed already has it, that entry is
  // kept instead of a second copy.
  keepPage(url: string, title: string): Entry {
    const known = this.db
      .query<{ id: number }, [string]>('SELECT id FROM entries WHERE url = ? ORDER BY id LIMIT 1')
      .get(url);
    if (known) return this.keep([known.id], true)[0]!;
    const { id } = this.db
      .query<{ id: number }, [number, string, string, number, string]>(
        `INSERT INTO entries (source_id, guid, url, published_at, kept, title) VALUES (?, ?, ?, ?, 1, ?) RETURNING id`,
      )
      .get(this.siteSource(url), url, url, Date.now(), title)!;
    return this.entry(id)!;
  }

  // The source a page kept from its link belongs to: its site, made the
  // first time one of its pages is kept.
  private siteSource(url: string): number {
    const site = URL.parse(url)?.hostname.replace(/^www\./, '') || url;
    this.db.run(`INSERT OR IGNORE INTO sources (kind, ref, label) VALUES ('page', ?, ?)`, [site, site]);
    return this.db.query<{ id: number }, [string]>('SELECT id FROM sources WHERE ref = ?').get(site)!.id;
  }

  // Removes a feed and its entries. What was kept stays, as pages of its site.
  removeSource(id: number): void {
    const kept = this.db.query<{ id: number; url: string }, [number]>(
      'SELECT id, url FROM entries WHERE source_id = ? AND kept = 1',
    );
    this.db.transaction(() => {
      for (const entry of kept.all(id))
        this.db.run('UPDATE OR IGNORE entries SET source_id = ? WHERE id = ?', [this.siteSource(entry.url), entry.id]);
      this.db.run(`DELETE FROM sources WHERE id = ? AND kind <> 'page'`, [id]);
    })();
  }

  rename(id: number, label: string): void {
    this.db.run('UPDATE sources SET label = ? WHERE id = ?', [label, id]);
  }

  // Points a feed at another address, maybe of another kind. What it fetches
  // from there first is its backlog, as when it was followed.
  readdress(id: number, kind: Source['kind'], ref: string): void {
    this.db.run(
      `UPDATE sources SET kind = ?, ref = ?, etag = '', last_modified = '', fetched_at = NULL, next_at = NULL, failures = 0, error = '' WHERE id = ?`,
      [kind, ref, id],
    );
  }

  cuts(sourceId: number): string[] {
    return this.db
      .query<{ text: string }, [number]>('SELECT text FROM cuts WHERE source_id = ? ORDER BY text')
      .all(sourceId)
      .map((row) => row.text);
  }

  setCuts(sourceId: number, texts: string[]): string[] {
    const clean = [...new Set(texts.map((text) => text.trim()).filter(Boolean))];
    this.db.transaction(() => {
      this.db.run('DELETE FROM cuts WHERE source_id = ?', [sourceId]);
      for (const text of clean) this.db.run('INSERT INTO cuts (source_id, text) VALUES (?, ?)', [sourceId, text]);
    })();
    return this.cuts(sourceId);
  }

  // Titles with their source's cuts taken out.
  private cut(entries: Entry[]): Entry[] {
    const cuts = Map.groupBy(
      this.db.query<{ source_id: number; text: string }, []>('SELECT source_id, text FROM cuts').all(),
      (cut) => cut.source_id,
    );
    for (const entry of entries) {
      const texts = cuts.get(entry.source_id);
      if (texts && entry.title)
        entry.title = cutFrom(
          entry.title,
          texts.map((cut) => cut.text),
        );
    }
    return entries;
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
    return this.mutes(sourceId);
  }

  // Every entry, newest first, as rows show them.
  private allEntries(): Entry[] {
    const rows = this.db
      .query<Entry, []>(
        `SELECT ${ROW} FROM entries e JOIN sources s ON s.id = e.source_id ORDER BY e.published_at DESC, e.id DESC`,
      )
      .all();
    return this.cut(rows);
  }

  // Entries for the command line, newest first.
  export(onlyKept = false) {
    const rows = this.db
      .query<Entry, []>(
        `SELECT ${ROW} FROM entries e JOIN sources s ON s.id = e.source_id ${onlyKept ? 'WHERE e.kept = 1' : ''} ORDER BY e.published_at DESC, e.id DESC`,
      )
      .all();
    return this.cut(rows).map((row) => ({
      id: row.id,
      feed: row.feed,
      title: displayTitle(row),
      url: row.url,
      published: new Date(row.published_at).toISOString(),
      kept: row.kept === 1,
    }));
  }

  // Folds together copies of one post left behind by a site that changed its
  // address: same feed, title, date and URL path. The newest copy stays, out of
  // the backlog if any copy was, and kept if any copy was.
  mergeMoved(): number {
    type Copy = {
      id: number;
      url: string;
      backlog: 0 | 1;
      kept: 0 | 1;
      source_id: number;
      title: string;
      published_at: number;
    };
    const copies = this.db
      .query<Copy, []>(
        `SELECT e.id, e.url, e.backlog, e.kept, e.source_id, e.title, e.published_at FROM entries e
         JOIN (SELECT source_id s, title t, published_at p FROM entries WHERE title <> '' GROUP BY 1, 2, 3 HAVING count(*) > 1) d
         ON e.source_id = d.s AND e.title = d.t AND e.published_at = d.p ORDER BY e.id DESC`,
      )
      .all();
    const groups = new Map<string, Copy[]>();
    for (const copy of copies) {
      const path = URL.parse(copy.url)?.pathname ?? copy.url;
      const key = JSON.stringify([copy.source_id, copy.title, copy.published_at, path]);
      groups.set(key, [...(groups.get(key) ?? []), copy]);
    }
    return this.db.transaction(() => {
      let removed = 0;
      for (const group of groups.values()) {
        if (group.length < 2) continue;
        for (const extra of group.slice(1)) {
          this.db.run('DELETE FROM entries WHERE id = ?', [extra.id]);
          removed++;
        }
        const backlog = group.every((copy) => copy.backlog) ? 1 : 0;
        const kept = group.some((copy) => copy.kept) ? 1 : 0;
        this.db.run('UPDATE entries SET backlog = ?, kept = ? WHERE id = ?', [backlog, kept, group[0]!.id]);
      }
      return removed;
    })();
  }
}
