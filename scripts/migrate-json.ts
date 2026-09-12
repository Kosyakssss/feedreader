import { Database } from 'bun:sqlite';
import { existsSync, readFileSync, readdirSync, mkdirSync, mkdtempSync, linkSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import {
  DEFAULT_CONFIG,
  type Config,
  type Entry,
  type EntryState,
  type FeedCacheMeta,
  type FeedsFile,
} from '../src/lib/types';
import { createSchema, openDatabase } from '../src/lib/server/database';
import { createEntryId, publishedTime } from '../src/lib/server/feeds/parse';
import { isSafeObjectKey, urlKey } from '../src/lib/server/security';
import { CONFIG_LIMITS, inLimit } from '../src/lib/server/config';
type StateFile = Record<string, EntryState>;
type CacheFile = {
  entries: Entry[];
  lastFetched: Record<string, number>;
  feedErrors: Record<string, string>;
  feedMeta: Record<string, FeedCacheMeta>;
};

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    from: { type: 'string' },
    to: { type: 'string' },
    help: { type: 'boolean' },
  },
  strict: true,
});
if (values.help) {
  console.log(
    'Stop the old server, then run: bun run migrate --from <JSON data directory> [--to <new SQLite file>]\nDefaults to feedreader.sqlite in the source directory. Existing databases are never overwritten. Original files and theme assets stay untouched.',
  );
  process.exit(0);
}
if (!values.from)
  throw new Error('Provide --from <JSON data directory>; stop the old server before migrating.');
const source = resolve(values.from);
const target = resolve(values.to || join(source, 'feedreader.sqlite'));
for (const suffix of ['', '-wal', '-shm'])
  if (existsSync(target + suffix)) throw new Error(`Refusing to overwrite ${target + suffix}`);
if (!existsSync(join(source, 'feeds.json'))) throw new Error('Source directory must contain feeds.json');
const inputs = new Map<string, string>();
const sourceFiles = readdirSync(source)
  .filter((name) => name.endsWith('.json'))
  .sort();
const { feeds, cache, state, config } = readLegacy(source);
mkdirSync(dirname(target), { recursive: true });
const temporary = mkdtempSync(join(dirname(target), '.feedreader-migration-'));
let db: Database | undefined;
try {
  db = new Database(join(temporary, 'feedreader.sqlite'), { create: true, strict: true });
  const expected: Record<string, unknown[]> = {};
  function insert(table: string, sql: string, data: unknown): void {
    expected[table] = db!.query(sql + ' RETURNING *').all(JSON.stringify(data));
  }
  db.transaction(() => {
    createSchema(db!);
    insert(
      'feeds',
      `INSERT OR IGNORE INTO feeds SELECT value->>'$.id', value->>'$.url', value->>'$.urlKey', value->>'$.label',
      value->>'$.folderId', key, value->>'$.lastFetched', value->>'$.error', value->>'$.etag', value->>'$.lastModified'
      FROM json_each(?)`,
      feeds.feeds.map((feed) => ({
        ...feed,
        urlKey: urlKey(feed.url),
        lastFetched: cache.lastFetched[feed.id] ?? null,
        error: cache.feedErrors[feed.id] ?? null,
        ...cache.feedMeta[feed.id],
      })),
    );
    insert(
      'folders',
      `INSERT OR IGNORE INTO folders SELECT value->>'$.id', value->>'$.name', key FROM json_each(?)`,
      feeds.folders,
    );
    insert(
      'entries',
      `INSERT OR IGNORE INTO entries SELECT value->>'$.id', value->>'$.sourceId', value->>'$.feedId', value->>'$.url',
      value->>'$.title', value->>'$.published', value->>'$.publishedTime' FROM json_each(?)`,
      cache.entries.map((entry) => ({ ...entry, publishedTime: publishedTime(entry) })),
    );
    insert(
      'states',
      `INSERT INTO states SELECT key, value->>'$.read', value->>'$.readAt', value->>'$.starred', value->>'$.starredAt' FROM json_each(?)`,
      state,
    );
    expected.settings = db!
      .query('UPDATE settings SET value = ? WHERE id = 1 RETURNING *')
      .all(JSON.stringify(config));
  }).immediate();
  db.close();
  db = openDatabase(temporary);
  if (db.query<{ integrity_check: string }, []>('PRAGMA integrity_check').get()?.integrity_check !== 'ok')
    throw new Error('SQLite integrity verification failed');
  for (const [table, rows] of Object.entries(expected)) {
    if (!isDeepStrictEqual(new Set(rows), new Set(db.query(`SELECT * FROM ${table}`).all())))
      throw new Error(`Migration verification failed for ${table}`);
  }
  if (
    !isDeepStrictEqual(
      sourceFiles,
      readdirSync(source)
        .filter((name) => name.endsWith('.json'))
        .sort(),
    ) ||
    [...inputs].some(([name, text]) => readFileSync(join(source, name), 'utf8') !== text)
  )
    throw new Error('Source files changed during migration. Stop the old server and try again.');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;');
  db.close();
  db = undefined;
  linkSync(join(temporary, 'feedreader.sqlite'), target);
  console.log(
    JSON.stringify(
      {
        database: target,
        verified: true,
        counts: Object.fromEntries(Object.entries(expected).map(([table, rows]) => [table, rows.length])),
      },
      null,
      2,
    ),
  );
} finally {
  db?.close();
  rmSync(temporary, { recursive: true, force: true });
}

function readLegacy(directory: string) {
  function read(name: string): unknown {
    try {
      const text = readFileSync(join(directory, name), 'utf8');
      inputs.set(name, text);
      const value = JSON.parse(text);
      if (value && typeof value === 'object' && '$feedreader' in value) {
        if (value.$feedreader !== 1) throw new Error(`Unsupported storage version in ${name}`);
        return value.data;
      }
      return value;
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return undefined;
      throw error;
    }
  }
  const journal = read('transaction.json') as { files?: Record<string, unknown> } | undefined;
  if (journal && (!journal.files || typeof journal.files !== 'object' || Array.isArray(journal.files)))
    throw new Error('Invalid transaction journal');
  for (const name of Object.keys(journal?.files ?? {}))
    if (!['feeds.json', 'cache.json', 'state.json', 'config.json'].includes(name))
      throw new Error('Invalid transaction filename');
  const value = (name: string) =>
    journal?.files && Object.hasOwn(journal.files, name) ? journal.files[name] : read(name);
  const feeds = normalizeFeedsFile(value('feeds.json'));
  const cache = normalizeCacheFile(value('cache.json'));
  const state = normalizeStateFile(normalizeStateShape(value('state.json')), cache);
  for (const name of readdirSync(directory).filter((name) => /^state\.sync-conflict-.*\.json$/.test(name))) {
    const incoming = normalizeStateFile(normalizeStateShape(read(name)), cache);
    for (const [id, entry] of Object.entries(incoming)) state[id] = mergeStateEntry(state[id], entry);
  }
  return { feeds, cache, state, config: normalizeConfig(value('config.json')) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function createStateFile(): StateFile {
  return Object.create(null) as StateFile;
}
function stringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  if (!isRecord(value)) return out;
  for (const [key, entry] of Object.entries(value)) {
    if (isSafeObjectKey(key) && typeof entry === 'string') out[key] = entry;
  }
  return out;
}
function numberRecord(value: unknown): Record<string, number> {
  const out: Record<string, number> = Object.create(null);
  if (!isRecord(value)) return out;
  for (const [key, entry] of Object.entries(value)) {
    if (isSafeObjectKey(key) && typeof entry === 'number' && Number.isFinite(entry)) out[key] = entry;
  }
  return out;
}
function normalizeFeedMeta(value: unknown): Record<string, FeedCacheMeta> {
  const out: Record<string, FeedCacheMeta> = Object.create(null);
  if (!isRecord(value)) return out;
  for (const [key, entry] of Object.entries(value)) {
    if (!isSafeObjectKey(key) || !isRecord(entry)) continue;
    const meta: FeedCacheMeta = {};
    if (typeof entry.etag === 'string' && entry.etag) meta.etag = entry.etag;
    if (typeof entry.lastModified === 'string' && entry.lastModified) meta.lastModified = entry.lastModified;
    if (Object.keys(meta).length) out[key] = meta;
  }
  return out;
}
function normalizeFeedsFile(value: unknown): FeedsFile {
  if (!isRecord(value)) return { folders: [], feeds: [] };
  const rawFolders = Array.isArray(value.folders)
    ? value.folders.filter(isRecord).flatMap((folder) => {
        const { id, name } = folder;
        if (typeof id !== 'string' || !isSafeObjectKey(id) || typeof name !== 'string') return [];
        return [{ id, name }];
      })
    : [];
  const rawFeeds = Array.isArray(value.feeds)
    ? value.feeds.filter(isRecord).flatMap((feed) => {
        const { id, url, label, folderId } = feed;
        if (typeof id !== 'string' || !isSafeObjectKey(id)) return [];
        if (typeof url !== 'string' || typeof label !== 'string') return [];
        if (folderId !== null && folderId !== undefined && typeof folderId !== 'string') return [];
        return [{ id, url, label, folderId: folderId || null }];
      })
    : [];
  return { folders: rawFolders, feeds: rawFeeds };
}
function normalizeEntry(entry: unknown): Entry | null {
  if (!isRecord(entry)) return null;
  if (typeof entry.feedId !== 'string' || !entry.feedId) return null;
  const url = typeof entry.url === 'string' ? entry.url : '';
  const title = typeof entry.title === 'string' ? entry.title : 'Untitled';
  const published = typeof entry.published === 'string' ? entry.published : new Date(0).toISOString();
  const sourceId =
    typeof entry.sourceId === 'string' && entry.sourceId
      ? entry.sourceId
      : typeof entry.id === 'string' && entry.id
        ? entry.id
        : url || `${title}:${published}`;
  const id = createEntryId(entry.feedId, sourceId);
  return { id, sourceId, feedId: entry.feedId, url, title, published };
}
function normalizeCacheFile(cache: unknown): CacheFile {
  if (!isRecord(cache)) return { entries: [], lastFetched: {}, feedErrors: {}, feedMeta: {} };
  const rawEntries = Array.isArray(cache.entries)
    ? cache.entries.flatMap((entry) => normalizeEntry(entry) || [])
    : [];
  return {
    entries: rawEntries,
    lastFetched: numberRecord(cache.lastFetched),
    feedErrors: stringRecord(cache.feedErrors),
    feedMeta: normalizeFeedMeta(cache.feedMeta),
  };
}
function normalizeEntryState(value: unknown): EntryState | null {
  if (!isRecord(value)) return null;
  const out: EntryState = {};
  if (typeof value.read === 'boolean') out.read = value.read;
  if (typeof value.readAt === 'number' && Number.isFinite(value.readAt) && value.readAt >= 0)
    out.readAt = value.readAt;
  if (typeof value.starred === 'boolean') out.starred = value.starred;
  if (typeof value.starredAt === 'number' && Number.isFinite(value.starredAt) && value.starredAt >= 0)
    out.starredAt = value.starredAt;
  return Object.keys(out).length ? out : null;
}
function normalizeStateShape(value: unknown): StateFile {
  const normalized = createStateFile();
  if (!isRecord(value)) return normalized;
  for (const [id, entryState] of Object.entries(value)) {
    if (!isSafeObjectKey(id)) continue;
    const state = normalizeEntryState(entryState);
    if (state) normalized[id] = state;
  }
  return normalized;
}
function normalizeConfig(value: unknown): Config {
  const config: Config = { ...DEFAULT_CONFIG, retention: { ...DEFAULT_CONFIG.retention } };
  if (!isRecord(value)) return config;
  const maxBulkOpen = value.maxBulkOpen;
  if (typeof maxBulkOpen === 'number' && inLimit(maxBulkOpen, CONFIG_LIMITS.maxBulkOpen)) {
    config.maxBulkOpen = maxBulkOpen;
  }
  const port = value.port;
  if (typeof port === 'number' && inLimit(port, CONFIG_LIMITS.port)) {
    config.port = port;
  }
  if (value.theme === null || value.theme === '') {
    config.theme = 'system';
  } else if (typeof value.theme === 'string' && /^[a-zA-Z0-9_-]+$/.test(value.theme)) {
    config.theme = value.theme;
  }
  if (Array.isArray(value.trustedOrigins)) {
    const origins: string[] = [];
    for (const entry of value.trustedOrigins) {
      if (typeof entry !== 'string') continue;
      const normalized = entry.trim().toLowerCase().replace(/\/+$/, '');
      try {
        const parsed = new URL(normalized);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') continue;
        origins.push(parsed.origin);
      } catch {}
      if (origins.length >= 16) break;
    }
    config.trustedOrigins = origins;
  }
  if (isRecord(value.retention)) {
    const maxEntries = value.retention.maxEntries;
    const maxDays = value.retention.maxDays;
    if (typeof maxEntries === 'number' && inLimit(maxEntries, CONFIG_LIMITS.maxEntries)) {
      config.retention.maxEntries = maxEntries;
    }
    if (maxDays === null) {
      config.retention.maxDays = null;
    } else if (typeof maxDays === 'number' && inLimit(maxDays, CONFIG_LIMITS.maxDays)) {
      config.retention.maxDays = maxDays;
    }
  }
  return config;
}
function mergeStateEntry(existing: EntryState | undefined, incoming: EntryState): EntryState {
  const next = { ...existing };
  for (const key of ['read', 'starred'] as const) {
    const timestamp = key === 'read' ? 'readAt' : 'starredAt';
    if (typeof incoming[key] !== 'boolean') continue;
    if (!(key in next)) next[key] = incoming[key];
    if (
      incoming[timestamp] !== undefined &&
      (next[timestamp] === undefined || incoming[timestamp] >= next[timestamp])
    ) {
      next[key] = incoming[key];
      next[timestamp] = incoming[timestamp];
    }
  }
  return next;
}
function normalizeStateFile(state: StateFile, cache: CacheFile): StateFile {
  const currentIds = new Set(cache.entries.map((entry) => entry.id));
  const sources = Object.groupBy(cache.entries, (entry) => entry.sourceId || entry.id);
  const normalized = createStateFile();
  for (const [id, entryState] of Object.entries(normalizeStateShape(state))) {
    const ids = currentIds.has(id) ? [id] : sources[id]?.map((entry) => entry.id) || [id];
    for (const id of ids) normalized[id] = mergeStateEntry(normalized[id], entryState);
  }
  return normalized;
}
