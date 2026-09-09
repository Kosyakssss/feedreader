import {
  DEFAULT_CONFIG,
  type CacheFile,
  type Config,
  type Entry,
  type EntryState,
  type FeedCacheMeta,
  type FeedsFile,
  type StateFile,
} from '../types';
import { createEntryId } from './feeds/parse';
import { isSafeObjectKey } from './security';
export type ConfigPatch = Partial<Omit<Config, 'retention'>> & {
  retention?: Partial<Config['retention']>;
};
export const CONFIG_LIMITS = {
  maxBulkOpen: { min: 1, max: 500 },
  port: { min: 1, max: 65535 },
  maxEntries: { min: 100, max: 100000 },
  maxDays: { min: 1, max: 36500 },
} as const;
export function inLimit(
  value: number,
  limit: {
    min: number;
    max: number;
  },
): boolean {
  return Number.isInteger(value) && value >= limit.min && value <= limit.max;
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
export function normalizeFeedsFile(value: unknown): FeedsFile {
  if (!isRecord(value)) return { folders: [], feeds: [] };
  const rawFolders = Array.isArray(value.folders)
    ? value.folders.filter(isRecord).flatMap((folder) => {
        const { id, name } = folder;
        if (typeof id !== 'string' || !isSafeObjectKey(id) || typeof name !== 'string') return [];
        return [{ id, name }];
      })
    : [];
  const folderIds = new Set<string>();
  const folders = rawFolders.filter((folder) => {
    if (folderIds.has(folder.id)) return false;
    folderIds.add(folder.id);
    return true;
  });
  const rawFeeds = Array.isArray(value.feeds)
    ? value.feeds.filter(isRecord).flatMap((feed) => {
        const { id, url, label, folderId } = feed;
        if (typeof id !== 'string' || !isSafeObjectKey(id)) return [];
        if (typeof url !== 'string' || typeof label !== 'string') return [];
        if (folderId !== null && folderId !== undefined && typeof folderId !== 'string') return [];
        return [{ id, url, label, folderId: folderId || null }];
      })
    : [];
  const feedIds = new Set<string>();
  const feedUrls = new Set<string>();
  const feeds = rawFeeds.filter((feed) => {
    if (feedIds.has(feed.id) || feedUrls.has(feed.url)) return false;
    feedIds.add(feed.id);
    feedUrls.add(feed.url);
    return true;
  });
  return { folders, feeds };
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
export function normalizeCacheFile(cache: unknown): CacheFile {
  if (!isRecord(cache)) return { entries: [], lastFetched: {}, feedErrors: {}, feedMeta: {} };
  const rawEntries = Array.isArray(cache.entries)
    ? cache.entries.flatMap((entry) => normalizeEntry(entry) || [])
    : [];
  const entryIds = new Set<string>();
  const entries = rawEntries.filter((entry) => {
    if (entryIds.has(entry.id)) return false;
    entryIds.add(entry.id);
    return true;
  });
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
  if (typeof value.readAt === 'number' && Number.isFinite(value.readAt) && value.readAt >= 0)
    out.readAt = value.readAt;
  if (typeof value.starred === 'boolean') out.starred = value.starred;
  if (typeof value.starredAt === 'number' && Number.isFinite(value.starredAt) && value.starredAt >= 0)
    out.starredAt = value.starredAt;
  return Object.keys(out).length ? out : null;
}
export function normalizeStateShape(value: unknown): StateFile {
  const normalized = createStateFile();
  if (!isRecord(value)) return normalized;
  for (const [id, entryState] of Object.entries(value)) {
    if (!isSafeObjectKey(id)) continue;
    const state = normalizeEntryState(entryState);
    if (state) normalized[id] = state;
  }
  return normalized;
}
export function normalizeConfig(value: unknown): Config {
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
export function mergeStateEntry(existing: EntryState | undefined, incoming: EntryState): EntryState {
  const next: EntryState = existing ? { ...existing } : {};
  if (typeof incoming.read === 'boolean' && !('read' in next)) next.read = incoming.read;
  if (
    typeof incoming.read === 'boolean' &&
    incoming.readAt !== undefined &&
    (next.readAt === undefined || incoming.readAt >= next.readAt)
  ) {
    next.read = incoming.read;
    next.readAt = incoming.readAt;
  }
  if (typeof incoming.starred === 'boolean' && !('starred' in next)) next.starred = incoming.starred;
  if (
    typeof incoming.starred === 'boolean' &&
    incoming.starredAt !== undefined &&
    (next.starredAt === undefined || incoming.starredAt >= next.starredAt)
  ) {
    next.starred = incoming.starred;
    next.starredAt = incoming.starredAt;
  }
  return next;
}
export function normalizeStateFile(state: StateFile, cache: CacheFile): StateFile {
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
