import { error } from '@sveltejs/kit';
import { CONFIG_LIMITS, inLimit, type ConfigPatch } from './normalize';
import { isSafeObjectKey } from './security';
import type { Config, EntryState } from '../types';
export function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
export async function body(request: Request): Promise<unknown> {
  if (!/^application\/(?:[\w.-]+\+)?json(?:;|$)/i.test(request.headers.get('content-type') ?? ''))
    error(415, 'Content-Type must be application/json');
  try {
    return await request.json();
  } catch {
    error(400, 'Malformed JSON body');
  }
}
export function statePatch(value: unknown): Record<string, Pick<EntryState, 'read' | 'starred'>> {
  if (!record(value) || !record(value.entries)) error(400, 'Invalid state payload');
  return Object.fromEntries(
    Object.entries(value.entries).map(([id, patch]) => {
      if (!isSafeObjectKey(id) || !record(patch)) error(400, 'Invalid state update');
      const result: Pick<EntryState, 'read' | 'starred'> = {};
      for (const key of ['read', 'starred'] as const)
        if (key in patch) {
          if (typeof patch[key] !== 'boolean') error(400, `Invalid ${key} state for ${id}`);
          result[key] = patch[key];
        }
      if (!Object.keys(result).length) error(400, 'Empty state update');
      return [id, result];
    }),
  );
}
export function configPatch(value: unknown): ConfigPatch {
  if (!record(value)) error(400, 'Invalid config payload');
  const patch: ConfigPatch = {};
  for (const key of ['maxBulkOpen', 'port'] as const)
    if (key in value) {
      if (typeof value[key] !== 'number' || !inLimit(value[key], CONFIG_LIMITS[key]))
        error(400, `Invalid ${key}`);
      patch[key] = value[key];
    }
  if ('theme' in value) {
    if (
      value.theme !== null &&
      (typeof value.theme !== 'string' || (value.theme !== '' && !/^[a-zA-Z0-9_-]+$/.test(value.theme)))
    )
      error(400, 'Invalid theme name');
    patch.theme = value.theme || 'system';
  }
  if ('retention' in value) {
    if (!record(value.retention)) error(400, 'Invalid retention config');
    const retention: Partial<Config['retention']> = {};
    for (const key of ['maxEntries', 'maxDays'] as const)
      if (key in value.retention) {
        const item = value.retention[key];
        if (key === 'maxDays' && item === null) retention.maxDays = null;
        else {
          if (typeof item !== 'number' || !inLimit(item, CONFIG_LIMITS[key]))
            error(400, `Invalid retention.${key}`);
          retention[key] = item;
        }
      }
    patch.retention = retention;
  }
  return patch;
}
export function cursor(value: string | null): number {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}
