import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Config, Entry, EntryState, EnrichedEntry, Feed, FeedCacheMeta } from '../types';
import { readLegacy } from './legacy';
import { normalizeConfig, type ConfigPatch } from './normalize';
import { EntryIndex } from './entries';
import { decodeHtmlEntities, publishedTime } from './feeds/parse';
import { isSafeExternalUrl } from './security';
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
export function urlKey(url: string): string {
  const safe = isSafeExternalUrl(url);
  return safe.ok ? safe.url.href : url;
}
export class Storage {
  private db: Database;
  get revision(): string {
    const external = this.db.query<{ data_version: number }, []>('PRAGMA data_version').get()!.data_version;
    const local = this.db.query<{ n: number }, []>('SELECT total_changes() AS n').get()!.n;
    return `${external}:${local}`;
  }
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true });
    this.db = new Database(join(directory, 'feedreader.sqlite'), { create: true, strict: true });
    this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    try {
      this.db
        .transaction(() => {
          const version = this.db
            .query<{ user_version: number }, []>('PRAGMA user_version')
            .get()!.user_version;
          if (version === 1) return;
          if (version !== 0) throw new Error('Unsupported database version');
          const data = readLegacy(directory);
          this.db.exec(`
          CREATE TABLE feeds (id TEXT PRIMARY KEY, url TEXT NOT NULL, urlKey TEXT NOT NULL, label TEXT NOT NULL,
            folderId TEXT, position INTEGER NOT NULL, lastFetched INTEGER, error TEXT, etag TEXT, lastModified TEXT) STRICT;
          CREATE INDEX feed_url ON feeds(urlKey);
          CREATE TABLE folders (id TEXT PRIMARY KEY, name TEXT NOT NULL, position INTEGER NOT NULL) STRICT;
          CREATE TABLE entries (id TEXT PRIMARY KEY, sourceId TEXT, feedId TEXT NOT NULL, url TEXT NOT NULL,
            title TEXT NOT NULL, published TEXT NOT NULL, publishedTime REAL NOT NULL) STRICT;
          CREATE INDEX entry_order ON entries(publishedTime DESC);
          CREATE INDEX entry_feed ON entries(feedId, publishedTime DESC);
          CREATE TABLE states (id TEXT PRIMARY KEY, read INTEGER, readAt REAL, starred INTEGER, starredAt REAL) STRICT;
          CREATE INDEX state_starred ON states(starred) WHERE starred = 1;
          CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK(id = 1), value TEXT NOT NULL) STRICT;
        `);
          data.feeds.feeds.forEach((feed, position) => {
            this.insertFeed(feed, position);
            const meta = data.cache.feedMeta[feed.id];
            this.db
              .query('UPDATE feeds SET lastFetched = ?, error = ?, etag = ?, lastModified = ? WHERE id = ?')
              .run(
                data.cache.lastFetched[feed.id] ?? null,
                data.cache.feedErrors[feed.id] ?? null,
                meta?.etag ?? null,
                meta?.lastModified ?? null,
                feed.id,
              );
          });
          data.feeds.folders.forEach((folder, position) =>
            this.db.query('INSERT INTO folders VALUES (?, ?, ?)').run(folder.id, folder.name, position),
          );
          for (const entry of data.cache.entries) this.insertEntry(entry);
          for (const [id, state] of Object.entries(data.state))
            this.db
              .query('INSERT INTO states VALUES (?, ?, ?, ?, ?)')
              .run(
                id,
                state.read === undefined ? null : Number(state.read),
                state.readAt ?? null,
                state.starred === undefined ? null : Number(state.starred),
                state.starredAt ?? null,
              );
          this.db.query('INSERT INTO settings VALUES (1, ?)').run(JSON.stringify(data.config));
          this.db.exec('PRAGMA user_version = 1');
        })
        .immediate();
    } catch (error) {
      this.db.close();
      throw error;
    }
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
        const config = normalizeConfig({
          ...current,
          ...patch,
          retention: { ...current.retention, ...patch.retention },
        });
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
  entries(feedId?: string, starred = false, limit = -1): EnrichedEntry[] {
    return this.db
      .query<EntryRow, [string | null, string | null, number, number]>(`${entrySelect}
      WHERE (? IS NULL OR e.feedId = ?) AND (? = 0 OR s.starred = 1) ORDER BY e.publishedTime DESC, e.rowid LIMIT ?`)
      .all(feedId ?? null, feedId ?? null, Number(starred), limit)
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
    return this.db
      .transaction(() => {
        const result: Record<string, EntryState> = {};
        for (const [id, update] of Object.entries(updates)) {
          if (!this.db.query('SELECT 1 FROM entries WHERE id = ?').get(id))
            throw new Error(`Unknown entry id: ${id}`);
          this.db.query('INSERT OR IGNORE INTO states (id) VALUES (?)').run(id);
          for (const key of ['read', 'starred'] as const)
            if (update[key] !== undefined)
              this.db
                .query(
                  `UPDATE states SET ${key} = ?, ${key}At = max(?, coalesce(${key}At, 0) + 1) WHERE id = ?`,
                )
                .run(Number(update[key]), Date.now(), id);
          result[id] = stateValue(
            this.db.query<StateRow, [string]>('SELECT * FROM states WHERE id = ?').get(id)!,
          );
        }
        return result;
      })
      .immediate();
  }
  hasFeed(url: string): boolean {
    return !!this.db.query('SELECT 1 FROM feeds WHERE urlKey = ?').get(urlKey(url));
  }
  addFeeds(feeds: Feed[]): Feed[] {
    return this.db
      .transaction(() => {
        const created: Feed[] = [];
        const position =
          this.db.query<{ n: number }, []>('SELECT coalesce(min(position), 0) AS n FROM feeds').get()!.n -
          feeds.length;
        for (const feed of feeds) {
          if (this.hasFeed(feed.url)) continue;
          this.insertFeed(feed, position + created.length);
          created.push(feed);
        }
        return created;
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
          .query<{ id: string }, [string]>('SELECT id FROM entries WHERE feedId = ?')
          .all(id)
          .map((entry) => entry.id);
        this.db.query('DELETE FROM states WHERE id IN (SELECT id FROM entries WHERE feedId = ?)').run(id);
        this.db.query('DELETE FROM entries WHERE feedId = ?').run(id);
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
        const index = new EntryIndex(
          this.db
            .query<Entry, [string]>(
              'SELECT id, sourceId, feedId, url, title, published FROM entries WHERE feedId = ?',
            )
            .all(feed.id),
        );
        const added = new Set<string>();
        for (const entry of result.entries)
          if (index.add(entry, feed.id)) {
            this.insertEntry(entry);
            added.add(entry.id);
          }
        this.db
          .query('UPDATE feeds SET lastFetched = ?, error = ? WHERE id = ?')
          .run(time, result.error ?? null, feed.id);
        if (!result.error)
          this.db
            .query('UPDATE feeds SET etag = ?, lastModified = ? WHERE id = ?')
            .run(result.validators?.etag ?? null, result.validators?.lastModified ?? null, feed.id);
        const removed = this.prune();
        return { entries: this.entries(feed.id).filter((entry) => added.has(entry.id)), removed };
      })
      .immediate();
  }
  private insertFeed(feed: Feed, position: number): void {
    this.db
      .query('INSERT INTO feeds (id, url, urlKey, label, folderId, position) VALUES (?, ?, ?, ?, ?, ?)')
      .run(feed.id, feed.url, urlKey(feed.url), feed.label, feed.folderId, position);
  }
  private insertEntry(entry: Entry): void {
    this.db
      .query('INSERT INTO entries VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(
        entry.id,
        entry.sourceId ?? null,
        entry.feedId,
        entry.url,
        entry.title,
        entry.published,
        publishedTime(entry),
      );
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
    for (const id of removed) this.db.query('DELETE FROM states WHERE id = ?').run(id);
    return removed;
  }
}
