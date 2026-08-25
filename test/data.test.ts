import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  mergeSyncConflicts,
  pruneEntries,
  readCache,
  readConfig,
  readFeeds,
  readState,
  runDataMutation,
  runDataRead,
  writeDataFiles,
} from '../lib/data.ts';
import { createEntryId } from '../lib/feeds.ts';
import type { CacheFile, Config, StateFile } from '../lib/types.ts';

let dataDir = '';

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'feedreader-data-test-'));
  process.argv.push('--data', dataDir);
});

afterAll(async () => {
  const dataArg = process.argv.lastIndexOf('--data');
  if (dataArg !== -1) process.argv.splice(dataArg, 2);
  await rm(dataDir, { recursive: true, force: true });
});

function entry(id: string, published = new Date().toISOString()) {
  return { id: createEntryId('f', id), sourceId: id, feedId: 'f', url: `https://example.com/${id}`, title: id, published };
}

function config(overrides: Partial<Config['retention']> = {}): Config {
  return {
    maxBulkOpen: 20,
    theme: 'system',
    port: 8787,
    retention: { maxEntries: 3000, maxDays: null, ...overrides },
    trustedOrigins: [],
  };
}

describe('pruneEntries', () => {
  test('keeps newest maxEntries and prunes state for removed entries', () => {
    const now = Date.now();
    const cache: CacheFile = {
      entries: [
        { id: 'a', sourceId: 'a', feedId: 'f', url: 'https://a', title: 'a', published: new Date(now - 1000).toISOString() },
        { id: 'b', sourceId: 'b', feedId: 'f', url: 'https://b', title: 'b', published: new Date(now - 2000).toISOString() },
        { id: 'c', sourceId: 'c', feedId: 'f', url: 'https://c', title: 'c', published: new Date(now - 3000).toISOString() },
      ],
      lastFetched: { f: now },
      feedErrors: {},
      feedMeta: {},
    };
    const state: StateFile = { a: { read: true }, b: { read: true }, c: { read: true } };
    const config: Config = {
      maxBulkOpen: 20,
      theme: null,
      port: 8787,
      retention: { maxEntries: 2, maxDays: null },
      trustedOrigins: [],
    };

    const out = pruneEntries(cache, state, config);
    expect(out.cache.entries.map(e => e.id)).toEqual(['a', 'b']);
    expect(Object.keys(out.state).sort()).toEqual(['a', 'b']);
  });

  test('preserves starred entries beyond maxEntries', () => {
    const now = Date.now();
    const cache: CacheFile = {
      entries: [
        { id: 'a', sourceId: 'a', feedId: 'f', url: 'https://a', title: 'a', published: new Date(now - 1000).toISOString() },
        { id: 'b', sourceId: 'b', feedId: 'f', url: 'https://b', title: 'b', published: new Date(now - 2000).toISOString() },
        { id: 'c', sourceId: 'c', feedId: 'f', url: 'https://c', title: 'c', published: new Date(now - 3000).toISOString() },
      ],
      lastFetched: { f: now },
      feedErrors: {},
      feedMeta: {},
    };
    const state: StateFile = { a: { read: true }, b: { read: true }, c: { starred: true, starredAt: now } };
    const config: Config = {
      maxBulkOpen: 20,
      theme: null,
      port: 8787,
      retention: { maxEntries: 2, maxDays: null },
      trustedOrigins: [],
    };

    const out = pruneEntries(cache, state, config);
    expect(out.cache.entries.map(e => e.id)).toEqual(['a', 'b', 'c']);
    expect(Object.keys(out.state).sort()).toEqual(['a', 'b', 'c']);
  });

  test('applies maxDays while retaining old starred entries', () => {
    const now = Date.now();
    const recent = entry('recent', new Date(now - 12 * 60 * 60 * 1000).toISOString());
    const old = entry('old', new Date(now - 3 * 86400000).toISOString());
    const starred = entry('starred', new Date(now - 4 * 86400000).toISOString());
    const cache: CacheFile = {
      entries: [old, starred, recent],
      lastFetched: {},
      feedErrors: {},
      feedMeta: {},
    };
    const state: StateFile = { [starred.id]: { starred: true, starredAt: now } };

    const out = pruneEntries(cache, state, config({ maxDays: 1 }));
    expect(out.cache.entries.map(item => item.id)).toEqual([recent.id, starred.id]);
    expect(out.state).toEqual({ [starred.id]: { starred: true, starredAt: now } });
  });
});

describe('persistent data coordination', () => {
  test('normalizes malformed and duplicate records at the disk boundary', async () => {
    await writeFile(join(dataDir, 'feeds.json'), JSON.stringify({
      folders: [{ id: 'folder', name: 'One' }, { id: 'folder', name: 'Duplicate' }],
      feeds: [
        { id: 'feed', url: 'https://example.com/feed', label: 'One', folderId: null },
        { id: 'feed', url: 'https://other.example/feed', label: 'Duplicate id', folderId: null },
        { id: 'other', url: 'https://example.com/feed', label: 'Duplicate URL', folderId: null },
        { id: '__proto__', url: 'https://bad.example', label: 'Unsafe', folderId: null },
      ],
    }));
    await writeFile(join(dataDir, 'cache.json'), JSON.stringify({
      entries: [entry('same'), entry('same'), { nope: true }],
      lastFetched: { f: 1, bad: 'now' },
      feedErrors: { f: 'broken', constructor: 'unsafe' },
    }));

    const [feeds, cache] = await Promise.all([readFeeds(), readCache()]);
    expect(feeds.folders).toEqual([{ id: 'folder', name: 'One' }]);
    expect(feeds.feeds).toEqual([{ id: 'feed', url: 'https://example.com/feed', label: 'One', folderId: null }]);
    expect(cache.entries).toHaveLength(1);
    expect(cache.lastFetched).toEqual({ f: 1 });
    expect(cache.feedErrors).toEqual({ f: 'broken' });
    expect(Object.getPrototypeOf(cache.feedErrors)).toBeNull();
  });

  test('holds readers behind an in-progress multi-file mutation', async () => {
    let mutationStarted!: () => void;
    let releaseMutation!: () => void;
    const started = new Promise<void>(resolve => { mutationStarted = resolve; });
    const release = new Promise<void>(resolve => { releaseMutation = resolve; });
    const nextEntry = entry('coordinated');

    const mutation = runDataMutation(async () => {
      await writeDataFiles({
        'feeds.json': { folders: [], feeds: [{ id: 'f', url: 'https://example.com/feed', label: 'Feed', folderId: null }] },
        'cache.json': { entries: [nextEntry], lastFetched: {}, feedErrors: {}, feedMeta: {} },
      });
      mutationStarted();
      await release;
    });
    await started;

    let readFinished = false;
    const snapshot = runDataRead(async () => ({ feeds: await readFeeds(), cache: await readCache() }))
      .then(value => {
        readFinished = true;
        return value;
      });
    try {
      await new Promise(resolve => setTimeout(resolve, 5));
      expect(readFinished).toBe(false);
    } finally {
      releaseMutation();
      await mutation;
    }
    const result = await snapshot;
    expect(result.feeds.feeds[0]?.id).toBe('f');
    expect(result.cache.entries[0]?.id).toBe(nextEntry.id);
  });

  test('migrates legacy state ids and merges sync conflicts by latest timestamp', async () => {
    const migratedEntry = entry('legacy-source');
    await writeDataFiles({
      'cache.json': { entries: [migratedEntry], lastFetched: {}, feedErrors: {}, feedMeta: {} },
      'state.json': { 'legacy-source': { read: true, readAt: 0 }, [migratedEntry.id]: { starred: false, starredAt: 10 } },
    });
    await writeFile(join(dataDir, 'state.sync-conflict-device.json'), JSON.stringify({
      [migratedEntry.id]: { read: false, readAt: 0, starred: true, starredAt: 20 },
    }));

    await mergeSyncConflicts();
    const state = await readState(await readCache());
    expect(state[migratedEntry.id]).toEqual({ read: false, readAt: 0, starred: true, starredAt: 20 });
    await expect(access(join(dataDir, 'state.sync-conflict-device.json'))).rejects.toThrow();
  });

  test('replays a transaction after every possible completed-file boundary', async () => {
    const moduleUrl = pathToFileURL(join(import.meta.dir, '..', 'lib', 'data.ts')).href;
    const recoveredEntry = entry('recovered');
    const files = {
      'feeds.json': { folders: [], feeds: [{ id: 'f', url: 'https://example.com/feed', label: 'Recovered', folderId: null }] },
      'state.json': { [recoveredEntry.id]: { read: true, readAt: 12 } },
      'cache.json': { entries: [recoveredEntry], lastFetched: { f: 12 }, feedErrors: {}, feedMeta: {} },
      'config.json': config({ maxDays: 30 }),
    };
    const filenames = Object.keys(files) as (keyof typeof files)[];

    for (let completed = 0; completed <= filenames.length; completed++) {
      const crashDir = await mkdtemp(join(tmpdir(), 'feedreader-recovery-test-'));
      try {
        await mkdir(crashDir, { recursive: true });
        for (const filename of filenames) {
          await writeFile(join(crashDir, filename), JSON.stringify({ old: true }));
        }
        for (const filename of filenames.slice(0, completed)) {
          await writeFile(join(crashDir, filename), JSON.stringify(files[filename]));
        }
        await writeFile(join(crashDir, 'transaction.json'), JSON.stringify({ files }));

        const script = `
          process.argv.push('--data', ${JSON.stringify(crashDir)});
          const data = await import(${JSON.stringify(moduleUrl)});
          console.log(JSON.stringify({
            feeds: await data.readFeeds(),
            state: await data.readState(await data.readCache()),
            cache: await data.readCache(),
            config: await data.readConfig(),
          }));
        `;
        const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(exitCode, stderr).toBe(0);
        const recovered = JSON.parse(stdout);
        expect(recovered.feeds).toEqual(files['feeds.json']);
        expect(recovered.state).toEqual(files['state.json']);
        expect(recovered.cache).toEqual(files['cache.json']);
        expect(recovered.config).toEqual(files['config.json']);
        await expect(access(join(crashDir, 'transaction.json'))).rejects.toThrow();
      } finally {
        await rm(crashDir, { recursive: true, force: true });
      }
    }
  });

  test('writes normalized config values through the coordinated path', async () => {
    await writeDataFiles({ 'config.json': { maxBulkOpen: -2, retention: { maxEntries: 500, maxDays: 7 } } });
    const saved = await readConfig();
    expect(saved.maxBulkOpen).toBe(20);
    expect(saved.retention).toEqual({ maxEntries: 500, maxDays: 7 });
    expect(JSON.parse(await readFile(join(dataDir, 'config.json'), 'utf8'))).toEqual(saved);
  });
});
