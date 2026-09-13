import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Config, EntryState, EnrichedEntry, Feed, FeedCacheMeta, FeedData } from '../types';
import type { FeedFetchResult } from './feed-fetch';

type StateRow = {
  id: string;
  read: number | null;
  readAt: number | null;
  starred: number | null;
  starredAt: number | null;
};
type EntryRow = Omit<EnrichedEntry, 'state'> & StateRow;
const entrySelect = `SELECT e.*, f.label AS feedLabel, s.read, s.readAt, s.starred, s.starredAt
  FROM entries e JOIN feeds f ON f.id = e.feedId LEFT JOIN states s ON s.id = e.id`;
function stateValue(row: StateRow): EntryState {
  return {
    ...(row.read === null ? {} : { read: !!row.read, readAt: row.readAt! }),
    ...(row.starred === null ? {} : { starred: !!row.starred, starredAt: row.starredAt! }),
  };
}
function entryValue({ read, readAt, starred, starredAt, ...entry }: EntryRow): EnrichedEntry {
  return { ...entry, state: stateValue({ id: entry.id, read, readAt, starred, starredAt }) };
}
export function createSchema(db: Database): void {
  db.exec(`
    CREATE TABLE feeds (id TEXT PRIMARY KEY, url TEXT NOT NULL UNIQUE, label TEXT NOT NULL, position INTEGER NOT NULL,
      lastFetched INTEGER, error TEXT, etag TEXT, lastModified TEXT) STRICT;
    CREATE TABLE entries (id TEXT PRIMARY KEY, sourceId TEXT NOT NULL, feedId TEXT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
      url TEXT NOT NULL, title TEXT NOT NULL, published TEXT NOT NULL, publishedTime REAL NOT NULL) STRICT;
    CREATE INDEX entry_order ON entries(publishedTime DESC);
    CREATE INDEX entry_feed ON entries(feedId);
    CREATE UNIQUE INDEX entry_source ON entries(feedId, sourceId) WHERE sourceId <> '';
    CREATE UNIQUE INDEX entry_url ON entries(feedId, url) WHERE url <> '';
    CREATE UNIQUE INDEX entry_title ON entries(feedId, title) WHERE url = '' AND title <> '';
    CREATE TABLE states (id TEXT PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
      read INTEGER, readAt REAL, starred INTEGER, starredAt REAL) STRICT;
    CREATE INDEX state_starred ON states(starred) WHERE starred = 1;
    PRAGMA user_version = 100;
  `);
}
export class Storage {
  private db: Database;
  revision = 0;
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true });
    this.db = new Database(join(directory, 'feedreader.sqlite'), { create: true, strict: true });
    try {
      this.db.exec(
        'PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;',
      );
      const version = this.db.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version;
      if (version === 0) this.db.transaction(() => createSchema(this.db)).immediate();
      else if (version !== 100)
        throw new Error('This database is not v0.1. Run the migration into a new data directory.');
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  close(): void {
    this.db.close();
  }
  feeds(): Feed[] {
    return this.db.query<Feed, []>('SELECT id, url, label FROM feeds ORDER BY position').all();
  }
  refreshFeeds(): (Feed & FeedCacheMeta)[] {
    return this.db
      .query<Feed & FeedCacheMeta, []>(
        'SELECT id, url, label, etag, lastModified FROM feeds ORDER BY position',
      )
      .all();
  }
  health(): FeedData {
    return {
      feeds: this.feeds(),
      health: Object.fromEntries(
        this.db
          .query<{ id: string; lastFetched: number | null; error: string | null }, []>(
            'SELECT id, lastFetched, error FROM feeds',
          )
          .all()
          .map(({ id, ...health }) => [id, health]),
      ),
    };
  }
  entries(feedId?: string, starred = false, limit = -1): EnrichedEntry[] {
    return this.db
      .query<EntryRow, [string | null, string | null, number, number]>(`${entrySelect}
      WHERE (? IS NULL OR e.feedId = ?) AND (? = 0 OR s.starred = 1)
      ORDER BY e.publishedTime DESC, e.id LIMIT ?`)
      .all(feedId ?? null, feedId ?? null, Number(starred), limit)
      .map(entryValue);
  }
  unread(limit = -1): { entries: EnrichedEntry[]; total: number } {
    return {
      entries: this.db
        .query<EntryRow, [number]>(`${entrySelect} WHERE e.url <> '' AND coalesce(s.read, 0) = 0
        ORDER BY e.publishedTime DESC, e.id LIMIT ?`)
        .all(limit)
        .map(entryValue),
      total: this.db
        .query<{ n: number }, []>(`SELECT count(*) AS n FROM entries e LEFT JOIN states s ON s.id = e.id
        WHERE e.url <> '' AND coalesce(s.read, 0) = 0`)
        .get()!.n,
    };
  }
  counts() {
    return this.db
      .query<{ feedId: string; total: number; unread: number; starred: number; starredUnread: number }, []>(`
      SELECT e.feedId, count(*) AS total, sum(coalesce(s.read, 0) = 0) AS unread,
        sum(coalesce(s.starred, 0)) AS starred, sum(coalesce(s.starred, 0) = 1 AND coalesce(s.read, 0) = 0) AS starredUnread
      FROM entries e LEFT JOIN states s ON s.id = e.id GROUP BY e.feedId`)
      .all();
  }
  mark(updates: Record<string, Pick<EntryState, 'read' | 'starred'>>): Record<string, EntryState> {
    const rows = this.db
      .query<StateRow, [string, number]>(`
      INSERT INTO states (id, read, readAt, starred, starredAt)
      SELECT key, value->>'$.read', CASE WHEN value->>'$.read' IS NOT NULL THEN ?2 END,
        value->>'$.starred', CASE WHEN value->>'$.starred' IS NOT NULL THEN ?2 END FROM json_each(?1) WHERE true
      ON CONFLICT(id) DO UPDATE SET read = coalesce(excluded.read, states.read),
        readAt = CASE WHEN excluded.read IS NULL THEN states.readAt ELSE max(?2, coalesce(states.readAt, 0) + 1) END,
        starred = coalesce(excluded.starred, states.starred),
        starredAt = CASE WHEN excluded.starred IS NULL THEN states.starredAt ELSE max(?2, coalesce(states.starredAt, 0) + 1) END
      RETURNING *`)
      .all(JSON.stringify(updates), Date.now());
    if (rows.length) this.revision++;
    return Object.fromEntries(rows.map((row) => [row.id, stateValue(row)]));
  }
  hasFeed(url: string): boolean {
    return !!this.db.query('SELECT 1 FROM feeds WHERE url = ?').get(url);
  }
  addFeeds(feeds: Feed[]): Feed[] {
    const added = this.db
      .transaction(() => {
        const position = this.db
          .query<{ n: number }, []>('SELECT coalesce(min(position), 0) AS n FROM feeds')
          .get()!.n;
        return this.db
          .query<Feed, [string, number]>(`INSERT INTO feeds (id, url, label, position)
        SELECT value->>'$.id', value->>'$.url', value->>'$.label', ?2 - json_array_length(?1) + key FROM json_each(?1) WHERE true
        ON CONFLICT DO NOTHING RETURNING id, url, label`)
          .all(JSON.stringify(feeds), position);
      })
      .immediate();
    return added;
  }
  addFeed(feed: Feed, result: FeedFetchResult, time: number): EnrichedEntry[] | null {
    return this.db
      .transaction(() => {
        if (!this.addFeeds([feed]).length) return null;
        return this.saveFeed(feed, result, time);
      })
      .immediate();
  }
  removeFeed(id: string): string[] {
    return this.db
      .transaction(() => {
        const removed = this.db
          .query<{ id: string }, [string]>('SELECT id FROM entries WHERE feedId = ?')
          .all(id)
          .map((row) => row.id);
        this.db.query('DELETE FROM feeds WHERE id = ?').run(id);
        if (removed.length) this.revision++;
        return removed;
      })
      .immediate();
  }
  saveFeed(feed: Feed, result: FeedFetchResult, time: number): EnrichedEntry[] {
    return this.db
      .transaction(() => {
        if (!this.db.query('SELECT 1 FROM feeds WHERE id = ?').get(feed.id)) return [];
        const inserted = result.entries.length
          ? this.db
              .query<Omit<EnrichedEntry, 'feedLabel' | 'state'>, [string]>(`
        INSERT INTO entries (id, sourceId, feedId, url, title, published, publishedTime)
        SELECT value->>'$.id', value->>'$.sourceId', value->>'$.feedId', value->>'$.url', value->>'$.title',
          value->>'$.published', value->>'$.publishedTime' FROM json_each(?) WHERE true
        ON CONFLICT DO NOTHING RETURNING *`)
              .all(JSON.stringify(result.entries))
          : [];
        this.db
          .query('UPDATE feeds SET lastFetched = ?, error = ? WHERE id = ?')
          .run(time, result.error ?? null, feed.id);
        if (!result.error)
          this.db
            .query('UPDATE feeds SET etag = ?, lastModified = ? WHERE id = ?')
            .run(result.validators?.etag ?? null, result.validators?.lastModified ?? null, feed.id);
        if (inserted.length) this.revision++;
        return inserted.map((entry) => ({ ...entry, feedLabel: feed.label, state: {} }));
      })
      .immediate();
  }
  prune({ maxEntries, maxDays }: Config['retention']): string[] {
    const cutoff = maxDays ? Date.now() - maxDays * 86400000 : -Number.MAX_VALUE;
    const removed = this.db
      .query<{ id: string }, [number, number]>(`
      WITH eligible AS (SELECT e.id, row_number() OVER (ORDER BY e.publishedTime DESC, e.id) AS position
        FROM entries e LEFT JOIN states s ON s.id = e.id WHERE e.publishedTime >= ? OR s.starred = 1)
      DELETE FROM entries WHERE id NOT IN (SELECT id FROM eligible WHERE position <= ?)
        AND id NOT IN (SELECT id FROM states WHERE starred = 1) RETURNING id`)
      .all(cutoff, maxEntries)
      .map((row) => row.id);
    if (removed.length) this.revision++;
    return removed;
  }
}
