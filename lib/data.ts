import { readdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import type { CacheFile, Config, Entry, EntryState, FeedsFile, StateFile, ThemeMeta } from './types.ts';
import { createEntryId } from './feeds.ts';
import { sanitizeThemeName } from './security.ts';

const DEFAULT_CONFIG: Config = {
  maxBulkOpen: 20,
  retention: { maxEntries: 3000, maxDays: null },
  defaultOpenAction: 'original',
  theme: null,
  port: 8787,
};

let dataDir: string;

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
  try {
    const raw = await readFile(join(getDataDir(), filename), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJSON(filename: string, data: unknown): Promise<void> {
  const target = join(getDataDir(), filename);
  const tmp = `${target}.tmp.${process.pid}.${randomUUID()}`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n');
  await rename(tmp, target);
}

function normalizeEntry(entry: Entry): Entry {
  const sourceId = typeof entry.sourceId === 'string' && entry.sourceId ? entry.sourceId : entry.id;
  const id = createEntryId(entry.feedId, sourceId);
  if (entry.id === id && entry.sourceId === sourceId) return entry;
  return { ...entry, id, sourceId };
}

function normalizeCacheFile(cache: CacheFile): CacheFile {
  const entries = cache.entries.map(normalizeEntry);
  const unchanged = entries.every((entry, index) => entry === cache.entries[index]);
  if (unchanged && cache.feedErrors) return cache;
  return { ...cache, entries, feedErrors: cache.feedErrors || {} };
}

function mergeStateEntry(existing: EntryState | undefined, incoming: EntryState): EntryState {
  const next: EntryState = existing ? { ...existing } : {};

  if ('read' in incoming && !('read' in next)) next.read = incoming.read;
  if (incoming.readAt && (!next.readAt || incoming.readAt >= next.readAt)) {
    next.read = incoming.read;
    next.readAt = incoming.readAt;
  }

  if ('starred' in incoming && !('starred' in next)) next.starred = incoming.starred;
  if (incoming.starredAt && (!next.starredAt || incoming.starredAt >= next.starredAt)) {
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

  const normalized: StateFile = {};
  for (const [id, entryState] of Object.entries(state)) {
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

export const readFeeds = () => readJSON<FeedsFile>('feeds.json', { folders: [], feeds: [] });
export const writeFeeds = (d: FeedsFile) => writeJSON('feeds.json', d);

async function readRawState(): Promise<StateFile> {
  return readJSON<StateFile>('state.json', {});
}

export async function readState(cache?: CacheFile): Promise<StateFile> {
  const state = await readRawState();
  return cache ? normalizeStateFile(state, cache) : state;
}

export const writeState = (d: StateFile) => writeJSON('state.json', d);

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

export const readCache = async () => normalizeCacheFile(await readJSON<CacheFile>('cache.json', { entries: [], lastFetched: {}, feedErrors: {} }));
export const writeCache = (d: CacheFile) => writeJSON('cache.json', normalizeCacheFile(d));

export async function readConfig(): Promise<Config> {
  const saved = await readJSON<Partial<Config>>('config.json', {});
  return { ...DEFAULT_CONFIG, ...saved, retention: { ...DEFAULT_CONFIG.retention, ...saved.retention } };
}

export async function writeConfig(partial: Partial<Config>): Promise<Config> {
  const current = await readConfig();
  const updated = { ...current, ...partial, retention: { ...current.retention, ...partial.retention } };
  updated.theme = updated.theme ? sanitizeThemeName(updated.theme) : null;
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
  await updateState(async (state) => {
    for (const file of conflicts) {
      const conflictState = normalizeStateFile(await readJSON<StateFile>(file, {}), cache);
      for (const [id, cs] of Object.entries(conflictState)) {
        state[id] = mergeStateEntry(state[id], cs);
      }
      await unlink(join(dir, file));
    }
    return state;
  }, cache);
}

export function pruneEntries(cache: CacheFile, state: StateFile, config: Config): { cache: CacheFile; state: StateFile } {
  const sorted = cache.entries.slice().sort((a, b) =>
    new Date(b.published).getTime() - new Date(a.published).getTime()
  );

  const starredIds = new Set(
    Object.entries(state).filter(([, s]) => s.starred).map(([id]) => id),
  );

  let entries = sorted;

  if (config.retention.maxDays) {
    const cutoff = Date.now() - config.retention.maxDays * 86400000;
    entries = entries.filter(e => starredIds.has(e.id) || new Date(e.published).getTime() >= cutoff);
  }

  if (entries.length > config.retention.maxEntries) {
    const kept = entries.slice(0, config.retention.maxEntries);
    const keptIds = new Set(kept.map(e => e.id));
    const starredOverflow = entries.slice(config.retention.maxEntries).filter(e => starredIds.has(e.id) && !keptIds.has(e.id));
    entries = [...kept, ...starredOverflow];
  }

  const keptIds = new Set(entries.map(e => e.id));
  const prunedState: StateFile = {};
  for (const [id, s] of Object.entries(state)) {
    if (keptIds.has(id)) prunedState[id] = s;
  }

  return { cache: { ...cache, entries }, state: prunedState };
}

export async function listThemes(): Promise<ThemeMeta[]> {
  const dir = join(getDataDir(), 'themes');
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const themes: ThemeMeta[] = [];
  for (const f of files.filter(f => f.endsWith('.css'))) {
    const css = await readFile(join(dir, f), 'utf-8');
    const meta: ThemeMeta = {
      file: f.replace(/\.css$/, ''),
      name: f.replace(/\.css$/, ''),
      author: '',
      description: '',
    };
    const header = css.match(/\/\*\*([\s\S]*?)\*\//);
    if (header) {
      const nameMatch = header[1].match(/@name\s+(.+)/);
      const authorMatch = header[1].match(/@author\s+(.+)/);
      const descMatch = header[1].match(/@description\s+(.+)/);
      if (nameMatch) meta.name = nameMatch[1].trim();
      if (authorMatch) meta.author = authorMatch[1].trim();
      if (descMatch) meta.description = descMatch[1].trim();
    }
    themes.push(meta);
  }
  return themes;
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
