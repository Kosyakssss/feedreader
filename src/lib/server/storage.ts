import type { Database } from 'bun:sqlite';
import type { Config, Entry, EntryState, EnrichedEntry, Feed, FeedCacheMeta } from '../types';
import { openDatabase } from './database';
import type { ConfigPatch } from './config';
import { decodeHtmlEntities, publishedTime, numericSourceId } from './feeds/parse';
import { isSafeExternalUrl, urlKey } from './security';
import type { FeedFetchResult } from './feeds/fetch';

type StateRow = {
  id: string;
  read: number | null;
  readAt: number | null;
  starred: number | null;
  starredAt: number | null;
};
type EntryRow = Omit<Entry, 'sourceId'> & StateRow & { sourceId: string | null; feedLabel: string };
const entrySelect = `SELECT e.id, e.sourceId, e.feedId, e.url, e.title, e.published,
  coalesce(f.label, 'Unknown') AS feedLabel, s.read, s.readAt, s.starred, s.starredAt
  FROM entries e LEFT JOIN feeds f ON f.id = e.feedId LEFT JOIN states s ON s.id = e.id`;
function stateValue(row: StateRow): EntryState {
  return {
    ...(row.read === null ? {} : { read: !!row.read }),
    ...(row.readAt === null ? {} : { readAt: row.readAt }),
    ...(row.starred === null ? {} : { starred: !!row.starred }),
    ...(row.starredAt === null ? {} : { starredAt: row.starredAt }),
  };
}
export class Storage {
  private db: Database;
  get revision(): string {
    const external = this.db.query<{ data_version: number }, []>('PRAGMA data_version').get()!.data_version;
    const local = this.db.query<{ n: number }, []>('SELECT total_changes() AS n').get()!.n;
    return `${external}:${local}`;
  }
  constructor(readonly directory: string) {
    this.db = openDatabase(directory);
  }
  close(): void {
    this.db.close();
  }
  config(): Config {
    return JSON.parse(
      this.db.query<{ value: string }, []>('SELECT value FROM settings WHERE id = 1').get()!.value,
    );
  }
  configure(patch: ConfigPatch): Config {
    return this.db
      .transaction(() => {
        const current = this.config();
        const config = {
          ...current,
          ...patch,
          retention: { ...current.retention, ...patch.retention },
        };
        const value = JSON.stringify(config);
        this.db.query('UPDATE settings SET value = ? WHERE id = 1 AND value <> ?').run(value, value);
        return config;
      })
      .immediate();
  }
  feeds(): Feed[] {
    return this.db.query<Feed, []>('SELECT id, url, label, folderId FROM feeds ORDER BY position').all();
  }
  health() {
    return {
      feeds: this.feeds(),
      folders: this.db
        .query<{ id: string; name: string }, []>('SELECT id, name FROM folders ORDER BY position')
        .all(),
      health: Object.fromEntries(
        this.db
          .query<{ id: string; lastFetched: number | null; error: string | null; entryCount: number }, []>(
            'SELECT f.id, f.lastFetched, f.error, (SELECT count(*) FROM entries e WHERE e.feedId = f.id) AS entryCount FROM feeds f',
          )
          .all()
          .map(({ id, ...health }) => [id, health]),
      ),
    };
  }
  validators(): Record<string, FeedCacheMeta> {
    return Object.fromEntries(
      this.db
        .query<{ id: string; etag: string | null; lastModified: string | null }, []>(
          'SELECT id, etag, lastModified FROM feeds',
        )
        .all()
        .map(({ id, etag, lastModified }) => [
          id,
          { ...(etag ? { etag } : {}), ...(lastModified ? { lastModified } : {}) },
        ]),
    );
  }
  entries(feedId?: string, starred = false, limit = -1, afterRow = 0): EnrichedEntry[] {
    return this.db
      .query<EntryRow, [string | null, string | null, number, number, number]>(`${entrySelect}
      WHERE (? IS NULL OR e.feedId = ?) AND (? = 0 OR s.starred = 1) AND e.rowid > ? ORDER BY e.publishedTime DESC, e.rowid LIMIT ?`)
      .all(feedId ?? null, feedId ?? null, Number(starred), afterRow, limit)
      .map(({ read, readAt, starred, starredAt, sourceId, ...entry }) => ({
        ...entry,
        ...(sourceId === null ? {} : { sourceId }),
        title: decodeHtmlEntities(entry.title),
        url: isSafeExternalUrl(entry.url).ok ? entry.url : '',
        state: stateValue({ id: entry.id, read, readAt, starred, starredAt }),
      }));
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
        value->>'$.starred', CASE WHEN value->>'$.starred' IS NOT NULL THEN ?2 END
      FROM json_each(?1) WHERE true
      ON CONFLICT(id) DO UPDATE SET
        read = coalesce(excluded.read, states.read),
        readAt = CASE WHEN excluded.read IS NULL THEN states.readAt ELSE max(?2, coalesce(states.readAt, 0) + 1) END,
        starred = coalesce(excluded.starred, states.starred),
        starredAt = CASE WHEN excluded.starred IS NULL THEN states.starredAt ELSE max(?2, coalesce(states.starredAt, 0) + 1) END
      RETURNING *`)
      .all(JSON.stringify(updates), Date.now());
    return Object.fromEntries(rows.map((row) => [row.id, stateValue(row)]));
  }
  hasFeed(url: string): boolean {
    return !!this.db.query('SELECT 1 FROM feeds WHERE urlKey = ?').get(urlKey(url));
  }
  addFeeds(feeds: Feed[]): Feed[] {
    return this.db
      .transaction(() => {
        const position = this.db
          .query<{ n: number }, []>('SELECT coalesce(min(position), 0) AS n FROM feeds')
          .get()!.n;
        this.db
          .query(`INSERT INTO feeds (id, url, urlKey, label, folderId, position)
          SELECT value->>'$.id', value->>'$.url', value->>'$.urlKey', value->>'$.label', value->>'$.folderId',
            ?2 - json_array_length(?1) + key FROM json_each(?1)`)
          .run(JSON.stringify(feeds.map((feed) => ({ ...feed, urlKey: urlKey(feed.url) }))), position);
        return this.db
          .query<Feed, [number]>(
            'SELECT id, url, label, folderId FROM feeds WHERE position < ? ORDER BY position',
          )
          .all(position);
      })
      .immediate();
  }
  addFeed(feed: Feed, result: FeedFetchResult, time: number): EnrichedEntry[] | null {
    return this.db
      .transaction(() => {
        if (!this.addFeeds([feed]).length) return null;
        this.saveFeed(feed, result, time);
        return this.entries(feed.id);
      })
      .immediate();
  }
  removeFeed(id: string): string[] {
    return this.db
      .transaction(() => {
        const removed = this.db
          .query<{ id: string }, [string]>('DELETE FROM entries WHERE feedId = ? RETURNING id')
          .all(id)
          .map((entry) => entry.id);
        this.db.query('DELETE FROM feeds WHERE id = ?').run(id);
        return removed;
      })
      .immediate();
  }
  saveFeed(
    feed: Feed,
    result: FeedFetchResult,
    time: number,
  ): { entries: EnrichedEntry[]; removed: string[] } {
    return this.db
      .transaction(() => {
        if (!this.db.query('SELECT 1 FROM feeds WHERE id = ?').get(feed.id))
          return { entries: [], removed: [] };
        const boundary = this.db
          .query<{ id: number }, []>('SELECT coalesce(max(rowid), 0) AS id FROM entries')
          .get()!.id;
        this.db
          .query(`INSERT INTO entries
          SELECT value->>'$.id', value->>'$.sourceId', value->>'$.feedId', value->>'$.url',
            value->>'$.title', value->>'$.published', value->>'$.publishedTime'
          FROM json_each(?1) WHERE value->>'$.feedId' = ?2 AND NOT EXISTS (
            SELECT 1 FROM entries WHERE feedId = ?2 AND sourceId = value->>'$.numericSourceId'
              AND rowid <= ?3 AND value->>'$.numericSourceId' <> '')
          ON CONFLICT(id) DO NOTHING`)
          .run(
            JSON.stringify(
              result.entries.map((entry) => ({
                ...entry,
                publishedTime: publishedTime(entry),
                numericSourceId: numericSourceId(entry.sourceId || ''),
              })),
            ),
            feed.id,
            boundary,
          );
        this.db
          .query('UPDATE feeds SET lastFetched = ?, error = ? WHERE id = ?')
          .run(time, result.error ?? null, feed.id);
        if (!result.error)
          this.db
            .query('UPDATE feeds SET etag = ?, lastModified = ? WHERE id = ?')
            .run(result.validators?.etag ?? null, result.validators?.lastModified ?? null, feed.id);
        const removed = this.prune();
        return { entries: this.entries(feed.id, false, -1, boundary), removed };
      })
      .immediate();
  }
  private prune(): string[] {
    const { maxEntries, maxDays } = this.config().retention;
    const cutoff = maxDays ? Date.now() - maxDays * 86400000 : -Number.MAX_VALUE;
    const removed = this.db
      .query<{ id: string }, [number, number]>(`
      WITH eligible AS (SELECT e.id, row_number() OVER (ORDER BY e.publishedTime DESC, e.rowid) AS position
        FROM entries e LEFT JOIN states s ON s.id = e.id WHERE e.publishedTime >= ? OR s.starred = 1)
      DELETE FROM entries WHERE id NOT IN (SELECT id FROM eligible WHERE position <= ?)
        AND id NOT IN (SELECT id FROM states WHERE starred = 1) RETURNING id`)
      .all(cutoff, maxEntries)
      .map((entry) => entry.id);
    return removed;
  }
}
