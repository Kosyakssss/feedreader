import { describe, expect, test } from 'bun:test';
import { pruneEntries } from '../lib/data.ts';
import type { CacheFile, Config, StateFile } from '../lib/types.ts';

describe('pruneEntries', () => {
  test('keeps newest maxEntries and prunes state for removed entries', () => {
    const now = Date.now();
    const cache: CacheFile = {
      entries: [
        { id: 'a', feedId: 'f', url: 'https://a', title: 'a', published: new Date(now - 1000).toISOString() },
        { id: 'b', feedId: 'f', url: 'https://b', title: 'b', published: new Date(now - 2000).toISOString() },
        { id: 'c', feedId: 'f', url: 'https://c', title: 'c', published: new Date(now - 3000).toISOString() },
      ],
      lastFetched: { f: now },
    };
    const state: StateFile = { a: { read: true }, b: { read: true }, c: { read: true } };
    const config: Config = {
      maxBulkOpen: 20,
      defaultOpenAction: 'original',
      theme: null,
      port: 8787,
      retention: { maxEntries: 2, maxDays: null },
    };

    const out = pruneEntries(cache, state, config);
    expect(out.cache.entries.map(e => e.id)).toEqual(['a', 'b']);
    expect(Object.keys(out.state).sort()).toEqual(['a', 'b']);
  });

  test('preserves starred entries beyond maxEntries', () => {
    const now = Date.now();
    const cache: CacheFile = {
      entries: [
        { id: 'a', feedId: 'f', url: 'https://a', title: 'a', published: new Date(now - 1000).toISOString() },
        { id: 'b', feedId: 'f', url: 'https://b', title: 'b', published: new Date(now - 2000).toISOString() },
        { id: 'c', feedId: 'f', url: 'https://c', title: 'c', published: new Date(now - 3000).toISOString() },
      ],
      lastFetched: { f: now },
    };
    const state: StateFile = { a: { read: true }, b: { read: true }, c: { starred: true, starredAt: now } };
    const config: Config = {
      maxBulkOpen: 20,
      defaultOpenAction: 'original',
      theme: null,
      port: 8787,
      retention: { maxEntries: 2, maxDays: null },
    };

    const out = pruneEntries(cache, state, config);
    expect(out.cache.entries.map(e => e.id)).toEqual(['a', 'b', 'c']);
    expect(Object.keys(out.state).sort()).toEqual(['a', 'b', 'c']);
  });
});
