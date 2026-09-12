import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  normalizeFeedsFile,
  normalizeCacheFile,
  normalizeStateShape,
  normalizeStateFile,
  normalizeConfig,
  mergeStateEntry,
} from './normalize';

export function readLegacy(directory: string) {
  function read(name: string): unknown {
    try {
      const value = JSON.parse(readFileSync(join(directory, name), 'utf8'));
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

export function legacySource(source: string): string {
  const hex = /^[-+]?0x[0-9a-f]+$/i.test(source);
  const numeric = hex ? Number.parseInt(source, 16) : Number(source);
  if (!source || !Number.isFinite(numeric)) return source;
  if (hex) return Number.isSafeInteger(numeric) ? String(numeric) : source;
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)[eE][+-]?\d+$/.test(source) && !/^[+-]?0{2,}[eE]/.test(source))
    return String(numeric);
  const normalized = source
    .replace(/^\+/, '')
    .replace(/^(-?)0+(?=\d)/, '$1')
    .replace(/(\.\d*?)0+$/, '$1')
    .replace(/\.$/, '')
    .replace(/^(-?)\./, '$10.');
  return normalized === String(numeric) || normalized === '-0' ? String(numeric) : source;
}
