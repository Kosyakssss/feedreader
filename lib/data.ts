import { mkdir, readdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import type { CacheFile, Config, Entry, EntryState, FeedCacheMeta, FeedsFile, StateFile } from './types.ts';
import { createEntryId, publishedTime } from './feeds.ts';
import { isSafeObjectKey, sanitizeThemeName } from './security.ts';

const DEFAULT_CONFIG: Config = {
  maxBulkOpen: 20,
  retention: { maxEntries: 3000, maxDays: null },
  theme: 'system',
  port: 8787,
};

const TRANSACTION_FILE = 'transaction.json';
type DataFilename = 'feeds.json' | 'state.json' | 'cache.json' | 'config.json';

let dataDir: string;
let recoveryChain: Promise<void> | null = null;
let dataMutationChain: Promise<void> = Promise.resolve();

export function getDataDir(): string {
  if (!dataDir) {
    const arg = process.argv.indexOf('--data');
    dataDir = arg !== -1 && process.argv[arg + 1]
      ? resolve(process.argv[arg + 1])
      : resolve('data');
  }
  return dataDir;
}

async function readJSON<T>(filename: string, fallback: T): Promise<T> {
  await ensureRecovered();
  let raw: string;
  try {
    raw = await readFile(join(getDataDir(), filename), 'utf-8');
  } catch (e) {
    const code = typeof e === 'object' && e && 'code' in e ? (e as { code?: unknown }).code : undefined;
    if (code === 'ENOENT') return fallback;
    throw new Error(`Failed to read ${filename}: ${(e as Error).message}`);
  }

  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`Malformed JSON in ${filename}: ${(e as Error).message}`);
  }
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
    if (typeof entry.failureCount === 'number' && Number.isInteger(entry.failureCount) && entry.failureCount > 0) {
      meta.failureCount = entry.failureCount;
    }
    if (typeof entry.nextRetryAfter === 'number' && Number.isFinite(entry.nextRetryAfter) && entry.nextRetryAfter > 0) {
      meta.nextRetryAfter = entry.nextRetryAfter;
    }
    if (Object.keys(meta).length) out[key] = meta;
  }
  return out;
}

function normalizeFeedsFile(value: unknown): FeedsFile {
  if (!isRecord(value)) return { folders: [], feeds: [] };
  const folders = Array.isArray(value.folders)
    ? value.folders.filter(isRecord).flatMap(folder => {
      const { id, name } = folder;
      if (typeof id !== 'string' || !isSafeObjectKey(id) || typeof name !== 'string') return [];
      return [{ id, name }];
    })
    : [];
  const feeds = Array.isArray(value.feeds)
    ? value.feeds.filter(isRecord).flatMap(feed => {
      const { id, url, label, folderId } = feed;
      if (typeof id !== 'string' || !isSafeObjectKey(id)) return [];
      if (typeof url !== 'string' || typeof label !== 'string') return [];
      if (folderId !== null && folderId !== undefined && typeof folderId !== 'string') return [];
      return [{ id, url, label, folderId: folderId || null }];
    })
    : [];
  return { folders, feeds };
}

function normalizeEntry(entry: unknown): Entry | null {
  if (!isRecord(entry)) return null;
  if (typeof entry.feedId !== 'string' || !entry.feedId) return null;
  const url = typeof entry.url === 'string' ? entry.url : '';
  const title = typeof entry.title === 'string' ? entry.title : 'Untitled';
  const published = typeof entry.published === 'string' ? entry.published : new Date(0).toISOString();
  const sourceId = typeof entry.sourceId === 'string' && entry.sourceId
    ? entry.sourceId
    : typeof entry.id === 'string' && entry.id
      ? entry.id
      : url || `${title}:${published}`;
  const id = createEntryId(entry.feedId, sourceId);
  return { id, sourceId, feedId: entry.feedId, url, title, published };
}

function normalizeCacheFile(cache: unknown): CacheFile {
  if (!isRecord(cache)) return { entries: [], lastFetched: {}, feedErrors: {}, feedMeta: {} };
  const entries = Array.isArray(cache.entries)
    ? cache.entries.flatMap(entry => normalizeEntry(entry) || [])
    : [];
  return {
    entries,
    lastFetched: numberRecord(cache.lastFetched),
    feedErrors: stringRecord(cache.feedErrors),
    feedMeta: normalizeFeedMeta(cache.feedMeta),
  };
}

function normalizeEntryState(value: unknown): EntryState | null {
  if (!isRecord(value)) return null;
  const out: EntryState = {};
  if (typeof value.read === 'boolean') out.read = value.read;
  if (typeof value.readAt === 'number' && Number.isFinite(value.readAt) && value.readAt >= 0) out.readAt = value.readAt;
  if (typeof value.starred === 'boolean') out.starred = value.starred;
  if (typeof value.starredAt === 'number' && Number.isFinite(value.starredAt) && value.starredAt >= 0) out.starredAt = value.starredAt;
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
  if (typeof maxBulkOpen === 'number' && Number.isInteger(maxBulkOpen) && maxBulkOpen >= 1 && maxBulkOpen <= 500) {
    config.maxBulkOpen = maxBulkOpen;
  }
  const port = value.port;
  if (typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535) {
    config.port = port;
  }
  if (value.theme === null || value.theme === '') {
    config.theme = 'system';
  } else if (typeof value.theme === 'string' && value.theme === 'system') {
    config.theme = value.theme;
  }
  if (isRecord(value.retention)) {
    const maxEntries = value.retention.maxEntries;
    const maxDays = value.retention.maxDays;
    if (typeof maxEntries === 'number' && Number.isInteger(maxEntries) && maxEntries >= 100 && maxEntries <= 100000) {
      config.retention.maxEntries = maxEntries;
    }
    if (maxDays === null) {
      config.retention.maxDays = null;
    } else if (typeof maxDays === 'number' && Number.isInteger(maxDays) && maxDays >= 1 && maxDays <= 36500) {
      config.retention.maxDays = maxDays;
    }
  }

  return config;
}

function isDataFilename(filename: string): filename is DataFilename {
  return filename === 'feeds.json' || filename === 'state.json' || filename === 'cache.json' || filename === 'config.json';
}

function normalizeDataFile(filename: DataFilename, data: unknown): unknown {
  if (filename === 'feeds.json') return normalizeFeedsFile(data);
  if (filename === 'state.json') return normalizeStateShape(data);
  if (filename === 'cache.json') return normalizeCacheFile(data);
  return normalizeConfig(data);
}

async function writeJSONRaw(filename: string, data: unknown): Promise<void> {
  await mkdir(getDataDir(), { recursive: true });
  const target = join(getDataDir(), filename);
  const tmp = `${target}.tmp.${process.pid}.${randomUUID()}`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n');
  await rename(tmp, target);
}

async function recoverPendingTransaction(): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(join(getDataDir(), TRANSACTION_FILE), 'utf-8');
  } catch (e) {
    const code = typeof e === 'object' && e && 'code' in e ? (e as { code?: unknown }).code : undefined;
    if (code === 'ENOENT') return;
    throw new Error(`Failed to read ${TRANSACTION_FILE}: ${(e as Error).message}`);
  }

  let transaction: unknown;
  try {
    transaction = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Malformed JSON in ${TRANSACTION_FILE}: ${(e as Error).message}`);
  }
  if (!isRecord(transaction) || !isRecord(transaction.files)) {
    throw new Error(`Invalid ${TRANSACTION_FILE}`);
  }

  const writes = Object.entries(transaction.files).flatMap(([filename, data]) =>
    isDataFilename(filename) ? [[filename, normalizeDataFile(filename, data)] as const] : []
  );
  for (const [filename, data] of writes) {
    await writeJSONRaw(filename, data);
  }
  await unlink(join(getDataDir(), TRANSACTION_FILE));
}

async function ensureRecovered(): Promise<void> {
  if (!recoveryChain) recoveryChain = recoverPendingTransaction();
  await recoveryChain;
}

async function writeJSON(filename: DataFilename, data: unknown): Promise<void> {
  await ensureRecovered();
  await writeJSONRaw(filename, normalizeDataFile(filename, data));
}

export async function writeDataFiles(files: Partial<Record<DataFilename, unknown>>): Promise<void> {
  await ensureRecovered();
  const writes = Object.entries(files).flatMap(([filename, data]) =>
    isDataFilename(filename) ? [[filename, normalizeDataFile(filename, data)] as const] : []
  );
  if (writes.length === 0) return;
  if (writes.length === 1) {
    await writeJSONRaw(writes[0][0], writes[0][1]);
    return;
  }

  await writeJSONRaw(TRANSACTION_FILE, { files: Object.fromEntries(writes) });
  for (const [filename, data] of writes) {
    await writeJSONRaw(filename, data);
  }
  await unlink(join(getDataDir(), TRANSACTION_FILE));
}

export async function runDataMutation<T>(operation: () => Promise<T>): Promise<T> {
  let result!: T;
  const run = dataMutationChain.then(async () => {
    result = await operation();
  });
  dataMutationChain = run.then(() => undefined, () => undefined);
  await run;
  return result;
}

function mergeStateEntry(existing: EntryState | undefined, incoming: EntryState): EntryState {
  const next: EntryState = existing ? { ...existing } : {};

  if (typeof incoming.read === 'boolean' && !('read' in next)) next.read = incoming.read;
  if (typeof incoming.read === 'boolean' && incoming.readAt && (!next.readAt || incoming.readAt >= next.readAt)) {
    next.read = incoming.read;
    next.readAt = incoming.readAt;
  }

  if (typeof incoming.starred === 'boolean' && !('starred' in next)) next.starred = incoming.starred;
  if (typeof incoming.starred === 'boolean' && incoming.starredAt && (!next.starredAt || incoming.starredAt >= next.starredAt)) {
    next.starred = incoming.starred;
    next.starredAt = incoming.starredAt;
  }

  return next;
}

function normalizeStateFile(state: StateFile, cache: CacheFile): StateFile {
  const currentIds = new Set<string>();
  const idsBySource = new Map<string, string[]>();
  for (const entry of cache.entries) {
    currentIds.add(entry.id);
    const sourceId = entry.sourceId || entry.id;
    const ids = idsBySource.get(sourceId);
    if (ids) ids.push(entry.id);
    else idsBySource.set(sourceId, [entry.id]);
  }

  const normalized = createStateFile();
  for (const [id, entryState] of Object.entries(normalizeStateShape(state))) {
    if (currentIds.has(id)) {
      normalized[id] = mergeStateEntry(normalized[id], entryState);
      continue;
    }

    const migratedIds = idsBySource.get(id);
    if (migratedIds?.length) {
      for (const migratedId of migratedIds) {
        normalized[migratedId] = mergeStateEntry(normalized[migratedId], entryState);
      }
      continue;
    }

    normalized[id] = mergeStateEntry(normalized[id], entryState);
  }

  return normalized;
}

let stateUpdateChain: Promise<void> = Promise.resolve();

export const writeFeeds = (d: FeedsFile) => writeJSON('feeds.json', normalizeFeedsFile(d));

async function readRawState(): Promise<StateFile> {
  return normalizeStateShape(await readJSON<unknown>('state.json', {}));
}

export async function readState(cache?: CacheFile): Promise<StateFile> {
  const state = await readRawState();
  return cache ? normalizeStateFile(state, cache) : state;
}

export const writeState = (d: StateFile) => writeJSON('state.json', normalizeStateShape(d));

export async function updateState(mutator: (state: StateFile) => StateFile | void | Promise<StateFile | void>, cache?: CacheFile): Promise<StateFile> {
  let result!: StateFile;
  const run = stateUpdateChain.then(async () => {
    const currentCache = cache || await readCache();
    const currentState = await readState(currentCache);
    const nextState = await mutator(currentState) || currentState;
    await writeState(nextState);
    result = nextState;
  });
  stateUpdateChain = run.then(() => undefined, () => undefined);
  await run;
  return result;
}

export const readFeeds = async () => normalizeFeedsFile(await readJSON<unknown>('feeds.json', { folders: [], feeds: [] }));
export const readCache = async () => normalizeCacheFile(await readJSON<unknown>('cache.json', { entries: [], lastFetched: {}, feedErrors: {} }));
export const writeCache = (d: CacheFile) => writeJSON('cache.json', normalizeCacheFile(d));

export async function readConfig(): Promise<Config> {
  return normalizeConfig(await readJSON<unknown>('config.json', {}));
}

export async function writeConfig(partial: Partial<Config>): Promise<Config> {
  const current = await readConfig();
  const updated = normalizeConfig({ ...current, ...partial, retention: { ...current.retention, ...partial.retention } });
  await writeJSON('config.json', updated);
  return updated;
}

export async function mergeSyncConflicts(): Promise<void> {
  const dir = getDataDir();
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return;
  }
  const conflicts = files.filter(f => f.startsWith('state.sync-conflict-') && f.endsWith('.json'));
  if (conflicts.length === 0) return;

  const cache = await readCache();
  const mergedFiles: string[] = [];
  await updateState(async (state) => {
    for (const file of conflicts) {
      const conflictState = normalizeStateFile(await readJSON<StateFile>(file, {}), cache);
      for (const [id, cs] of Object.entries(conflictState)) {
        state[id] = mergeStateEntry(state[id], cs);
      }
      mergedFiles.push(file);
    }
    return state;
  }, cache);
  await Promise.all(mergedFiles.map(file => unlink(join(dir, file))));
}

export function pruneEntries(cache: CacheFile, state: StateFile, config: Config): { cache: CacheFile; state: StateFile } {
  const sorted = cache.entries.slice().sort((a, b) =>
    publishedTime(b) - publishedTime(a)
  );

  const starredIds = new Set(
    Object.entries(state).filter(([, s]) => s.starred).map(([id]) => id),
  );

  let entries = sorted;

  if (config.retention.maxDays) {
    const cutoff = Date.now() - config.retention.maxDays * 86400000;
    entries = entries.filter(e => starredIds.has(e.id) || publishedTime(e) >= cutoff);
  }

  if (entries.length > config.retention.maxEntries) {
    const kept = entries.slice(0, config.retention.maxEntries);
    const keptIds = new Set(kept.map(e => e.id));
    const starredOverflow = entries.slice(config.retention.maxEntries).filter(e => starredIds.has(e.id) && !keptIds.has(e.id));
    entries = [...kept, ...starredOverflow];
  }

  const keptIds = new Set(entries.map(e => e.id));
  const prunedState = createStateFile();
  for (const [id, s] of Object.entries(state)) {
    if (keptIds.has(id)) prunedState[id] = s;
  }

  return { cache: { ...cache, entries }, state: prunedState };
}

export async function readThemeCSS(name: string): Promise<string> {
  const safeName = sanitizeThemeName(name);
  if (!safeName) return '';
  try {
    return await readFile(join(getDataDir(), 'themes', `${safeName}.css`), 'utf-8');
  } catch {
    return '';
  }
}

export function generateId(): string {
  return randomUUID();
}
