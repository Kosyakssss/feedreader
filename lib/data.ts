import { readdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { CacheFile, Config, FeedsFile, StateFile, ThemeMeta } from './types.ts';

const DEFAULT_CONFIG: Config = {
  maxBulkOpen: 20,
  retention: { maxEntries: 3000, maxDays: null },
  defaultOpenAction: 'original',
  theme: null,
  port: 8080,
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
  await writeFile(join(getDataDir(), filename), JSON.stringify(data, null, 2) + '\n');
}

export const readFeeds = () => readJSON<FeedsFile>('feeds.json', { folders: [], feeds: [] });
export const writeFeeds = (d: FeedsFile) => writeJSON('feeds.json', d);

export const readState = () => readJSON<StateFile>('state.json', {});
export const writeState = (d: StateFile) => writeJSON('state.json', d);

export const readCache = () => readJSON<CacheFile>('cache.json', { entries: [], lastFetched: {} });
export const writeCache = (d: CacheFile) => writeJSON('cache.json', d);

export async function readConfig(): Promise<Config> {
  const saved = await readJSON<Partial<Config>>('config.json', {});
  return { ...DEFAULT_CONFIG, ...saved, retention: { ...DEFAULT_CONFIG.retention, ...saved.retention } };
}

export async function writeConfig(partial: Partial<Config>): Promise<Config> {
  const current = await readConfig();
  const updated = { ...current, ...partial, retention: { ...current.retention, ...partial.retention } };
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

  const state = await readState();
  for (const file of conflicts) {
    const conflictState = await readJSON<StateFile>(file, {});
    for (const [id, cs] of Object.entries(conflictState)) {
      const existing = state[id];
      if (!existing) {
        state[id] = cs;
        continue;
      }
      if (cs.readAt && (!existing.readAt || cs.readAt > existing.readAt)) {
        existing.read = cs.read;
        existing.readAt = cs.readAt;
      }
      if (cs.starredAt && (!existing.starredAt || cs.starredAt > existing.starredAt)) {
        existing.starred = cs.starred;
        existing.starredAt = cs.starredAt;
      }
    }
    await unlink(join(dir, file));
  }
  await writeState(state);
}

export function pruneEntries(cache: CacheFile, state: StateFile, config: Config): { cache: CacheFile; state: StateFile } {
  let entries = cache.entries.slice().sort((a, b) =>
    new Date(b.published).getTime() - new Date(a.published).getTime()
  );

  if (config.retention.maxDays) {
    const cutoff = Date.now() - config.retention.maxDays * 86400000;
    entries = entries.filter(e => new Date(e.published).getTime() >= cutoff);
  }

  if (entries.length > config.retention.maxEntries) {
    entries = entries.slice(0, config.retention.maxEntries);
  }

  const kept = new Set(entries.map(e => e.id));
  const prunedState: StateFile = {};
  for (const [id, s] of Object.entries(state)) {
    if (kept.has(id)) prunedState[id] = s;
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
  try {
    return await readFile(join(getDataDir(), 'themes', `${name}.css`), 'utf-8');
  } catch {
    return '';
  }
}

export function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
}
