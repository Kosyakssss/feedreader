import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { RefreshStatus } from '../client/state.ts';
import type { Config } from '../lib/types.ts';

let dataDir = '';
let port = 0;
let proc: ChildProcess | null = null;
let serverOutput = '';

async function availablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const selected = typeof address === 'object' && address ? address.port : 0;
      server.close(error => error ? reject(error) : resolve(selected));
    });
  });
}

async function waitForServerReady(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(baseUrl + '/api/feeds');
      if (res.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 120));
  }
  throw new Error('Server did not become ready');
}

function rawRequest(options: { method: string; path: string; headers: Record<string, string> }): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, setHost: false, ...options },
      res => {
        res.resume();
        res.once('end', () => resolve({ status: res.statusCode ?? 0 }));
      },
    );
    req.once('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'feedreader-test-'));
  await mkdir(join(dataDir, 'themes'), { recursive: true });
  await writeFile(join(dataDir, 'feeds.json'), '{ "folders": [], "feeds": [] }\n');
  await writeFile(join(dataDir, 'state.json'), '{}\n');
  await writeFile(join(dataDir, 'cache.json'), '{ "entries": [], "lastFetched": {} }\n');
  await writeFile(join(dataDir, 'config.json'), '{ "trustedOrigins": ["https://airm1.example.ts.net"] }\n');
  await writeFile(join(dataDir, 'themes', 'system.css'), '/* feedreader-system-theme */\nbody { color: CanvasText; }\n');

  port = await availablePort();
  proc = spawn(process.env.FEEDREADER_SERVER_BIN || 'bun', ['server.ts', '--data', dataDir, '--port', String(port)], {
    cwd: dirname(fileURLToPath(new URL('../server.ts', import.meta.url))),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout?.on('data', chunk => { serverOutput += String(chunk); });
  proc.stderr?.on('data', chunk => { serverOutput += String(chunk); });

  try {
    await waitForServerReady(`http://127.0.0.1:${port}`);
  } catch (error) {
    throw new Error(`${(error as Error).message}\n${serverOutput}`);
  }
});

afterAll(async () => {
  if (proc && proc.exitCode === null) {
    proc.kill();
    await new Promise<void>(resolve => {
      const forceTimer = setTimeout(() => proc?.kill('SIGKILL'), 3000);
      const abandonTimer = setTimeout(resolve, 5000);
      proc?.once('exit', () => {
        clearTimeout(forceTimer);
        clearTimeout(abandonTimer);
        resolve();
      });
    });
  }
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

describe('server hardening', () => {
  test('reports health for launch agents and smoke checks', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean;
      pid: number;
      uptimeSeconds: number;
      refreshing: boolean;
    };
    expect(body.ok).toBe(true);
    expect(typeof body.pid).toBe('number');
    expect(typeof body.uptimeSeconds).toBe('number');
    expect(typeof body.refreshing).toBe('boolean');
  });

  test('streams an initial snapshot signal and subsequent shared-state changes', async () => {
    const abort = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/events`, { signal: abort.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let received = '';

    const readUntil = async (text: string): Promise<void> => {
      const deadline = Date.now() + 3000;
      while (!received.includes(text) && Date.now() < deadline) {
        const next = await reader.read();
        if (next.done) break;
        received += decoder.decode(next.value, { stream: true });
      }
      expect(received).toContain(text);
    };

    try {
      await readUntil('"topics":["sync"]');
      const update = await fetch(`http://127.0.0.1:${port}/api/config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ maxBulkOpen: 20 }),
      });
      expect(update.status).toBe(200);
      await readUntil('"topics":["config"]');
    } finally {
      abort.abort();
      await reader.cancel().catch(() => undefined);
    }
  });

  test('rejects cross-origin mutating requests', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/refresh`, {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
  });

  test('responds with 413 (not a reset) for oversized streaming bodies', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, method: 'POST', path: '/api/state', setHost: false,
          headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json' } },
        res => {
          res.resume();
          res.once('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.once('error', reject);
      // No Content-Length header: the body streams and trips the byte cap mid-flight.
      req.end('{"entries":{' + 'x'.repeat(3 * 1024 * 1024) + '}}');
    });
    expect(status).toBe(413);
  });

  test('answers 405 for known API resources hit with the wrong method', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/feeds`, { method: 'DELETE' });
    expect(res.status).toBe(405);
  });

  test('rejects requests with an unrecognized Host header', async () => {
    const res = await rawRequest({ method: 'GET', path: '/api/feeds', headers: { host: `evil.com:${port}` } });
    expect(res.status).toBe(403);
  });

  test('rejects rebinding-style reflected-host mutations', async () => {
    const res = await rawRequest({
      method: 'POST',
      path: '/api/refresh',
      headers: { host: `evil.com:${port}`, origin: `http://evil.com:${port}` },
    });
    expect(res.status).toBe(403);
  });

  test('ignores x-forwarded-host for trust decisions', async () => {
    const res = await rawRequest({
      method: 'POST',
      path: '/api/refresh',
      headers: { host: `127.0.0.1:${port}`, 'x-forwarded-host': 'evil.com', origin: 'http://evil.com' },
    });
    expect(res.status).toBe(403);
  });

  test('accepts mutations from a configured trusted origin', async () => {
    const res = await rawRequest({
      method: 'POST',
      path: '/api/refresh',
      headers: { host: 'airm1.example.ts.net', origin: 'https://airm1.example.ts.net' },
    });
    expect(res.status).toBe(202);
  });

  test('accepts same-origin mutating requests through an HTTPS reverse proxy', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/state`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-host': 'airm1.example.ts.net',
        'origin': 'https://airm1.example.ts.net',
        'x-forwarded-proto': 'https',
      },
      body: JSON.stringify({ entries: {} }),
    });
    expect(res.status).toBe(200);
  });

  test('serves the app and APIs under the Tailscale /feedreader path', async () => {
    const page = await fetch(`http://127.0.0.1:${port}/feedreader/`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('href="/feedreader/api/theme"');
    expect(html).toContain('href="/feedreader/app.css?v=');
    expect(html).toContain('<script src="/feedreader/app.js?v=');

    const api = await fetch(`http://127.0.0.1:${port}/feedreader/api/state`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-host': 'airm1.example.ts.net',
        'origin': 'https://airm1.example.ts.net',
        'x-forwarded-proto': 'https',
      },
      body: JSON.stringify({ entries: {} }),
    });
    expect(api.status).toBe(200);
  });

  test('serves the system theme by default', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/theme`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('feedreader-system-theme');
  });

  test('does not expose a theme selector', async () => {
    const page = await fetch(`http://127.0.0.1:${port}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).not.toContain('name="theme"');
  });

  test('renders /feedreader links when Tailscale Serve strips the path prefix', async () => {
    const page = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { 'x-forwarded-host': 'airm1.example.ts.net' },
    });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('href="/feedreader/api/theme"');
    expect(html).toContain('href="/feedreader/app.css?v=');
    expect(html).toContain('<script src="/feedreader/app.js?v=');
  });

  test('requires JSON content type for JSON endpoints', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/state`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ entries: {} }),
    });
    expect(res.status).toBe(415);
  });

  test('rejects malformed JSON in /api/state with 400', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{bad',
    });
    expect(res.status).toBe(400);
  });

  test('rejects magic state keys', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"entries":{"__proto__":{"read":true}}}',
    });
    expect(res.status).toBe(400);
  });

  test('returns 404 JSON for unknown API routes', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/proxy?url=https%3A%2F%2Fexample.com`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  test('normalizes incomplete but valid cache JSON', async () => {
    const cachePath = join(dataDir, 'cache.json');
    const original = await readFile(cachePath, 'utf-8');
    await writeFile(cachePath, '{}\n');
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/entries`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    } finally {
      await writeFile(cachePath, original);
    }
  });

  test('returns a generic 500 for malformed cache JSON without exposing disk details', async () => {
    const cachePath = join(dataDir, 'cache.json');
    const original = await readFile(cachePath, 'utf-8');
    await writeFile(cachePath, '{bad');
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/entries`);
      expect(res.status).toBe(500);
      const body = await res.json() as { error: string };
      expect(body.error).toBe('Internal server error');
    } finally {
      await writeFile(cachePath, original);
    }
  });

  test('skips unsafe feed URLs during OPML import', async () => {
    const feedsPath = join(dataDir, 'feeds.json');
    const cachePath = join(dataDir, 'cache.json');
    const [originalFeeds, originalCache] = await Promise.all([
      readFile(feedsPath, 'utf-8'),
      readFile(cachePath, 'utf-8'),
    ]);
    const form = new FormData();
    form.append('file', new File([
      `<?xml version="1.0"?>
<opml version="2.0">
  <body>
    <outline text="Safe Feed" xmlUrl="https://example.com/feed.xml" />
    <outline text="Local Feed" xmlUrl="http://127.0.0.1:9/rss.xml" />
  </body>
</opml>`,
    ], 'feeds.opml', { type: 'text/xml' }));

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/feeds/import`, {
        method: 'POST',
        body: form,
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { feeds: Array<{ url: string }>; added: number; skipped: number };
      expect(body.added).toBe(1);
      expect(body.skipped).toBe(1);
      expect(body.feeds.map(feed => feed.url)).toEqual(['https://example.com/feed.xml']);

      const feedsRes = await fetch(`http://127.0.0.1:${port}/api/feeds`);
      const feeds = await feedsRes.json() as { feeds: Array<{ url: string }> };
      expect(feeds.feeds.map(feed => feed.url)).toEqual(['https://example.com/feed.xml']);
      for (let attempt = 0; attempt < 100; attempt++) {
        const status = await (await fetch(`http://127.0.0.1:${port}/api/refresh/status`)).json() as { refreshing: boolean };
        if (!status.refreshing) break;
        await Bun.sleep(20);
      }
    } finally {
      await Promise.all([
        writeFile(feedsPath, originalFeeds),
        writeFile(cachePath, originalCache),
      ]);
    }
  });

  test('preserves concurrent state updates', async () => {
    const cachePath = join(dataDir, 'cache.json');
    const statePath = join(dataDir, 'state.json');
    const [originalCache, originalState] = await Promise.all([
      readFile(cachePath, 'utf-8'),
      readFile(statePath, 'utf-8'),
    ]);
    const persistedEntries = ['a', 'b'].map(id => ({
      id: `f:${id}`,
      sourceId: id,
      feedId: 'f',
      url: `https://example.com/${id}`,
      title: id,
      published: '2026-08-25T00:00:00.000Z',
    }));
    await writeFile(cachePath, JSON.stringify({ entries: persistedEntries, lastFetched: {}, feedErrors: {}, feedMeta: {} }));
    const requests: Promise<Response>[] = [];
    for (let i = 0; i < 100; i++) {
      requests.push(fetch(`http://127.0.0.1:${port}/api/state`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entries: { 'f:a': { read: true } } }),
      }));
      requests.push(fetch(`http://127.0.0.1:${port}/api/state`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entries: { 'f:b': { starred: true } } }),
      }));
    }

    try {
      const responses = await Promise.all(requests);
      expect(responses.every(response => response.status === 200)).toBe(true);
      const first = await responses[0]!.json() as {
        entryStates: Record<string, { read?: boolean; readAt?: number }>;
      };
      expect(first.entryStates['f:a']?.read).toBe(true);
      expect(typeof first.entryStates['f:a']?.readAt).toBe('number');
      const state = JSON.parse(await readFile(statePath, 'utf-8')) as Record<string, { read?: boolean; starred?: boolean }>;
      expect(state['f:a']?.read).toBe(true);
      expect(state['f:b']?.starred).toBe(true);
    } finally {
      await Promise.all([writeFile(cachePath, originalCache), writeFile(statePath, originalState)]);
    }
  });

  test('rejects unknown entry ids and malformed state values', async () => {
    const unknown = await fetch(`http://127.0.0.1:${port}/api/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entries: { missing: { read: true } } }),
    });
    expect(unknown.status).toBe(400);

    const malformed = await fetch(`http://127.0.0.1:${port}/api/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entries: { missing: { read: 'yes' } } }),
    });
    expect(malformed.status).toBe(400);
  });

  test('deleting a feed removes its cache metadata, entries, and state atomically', async () => {
    const paths = ['feeds.json', 'cache.json', 'state.json'] as const;
    const originals = await Promise.all(paths.map(file => readFile(join(dataDir, file), 'utf-8')));
    const persistedEntry = {
      id: 'delete-me:item',
      sourceId: 'item',
      feedId: 'delete-me',
      url: 'https://example.com/item',
      title: 'Item',
      published: '2026-08-25T00:00:00.000Z',
    };
    await Promise.all([
      writeFile(join(dataDir, 'feeds.json'), JSON.stringify({ folders: [], feeds: [
        { id: 'delete-me', url: 'https://example.com/feed', label: 'Delete me', folderId: null },
      ] })),
      writeFile(join(dataDir, 'cache.json'), JSON.stringify({
        entries: [persistedEntry],
        lastFetched: { 'delete-me': 1 },
        feedErrors: { 'delete-me': 'old error' },
        feedMeta: { 'delete-me': { etag: 'old', failureCount: 2 } },
      })),
      writeFile(join(dataDir, 'state.json'), JSON.stringify({ [persistedEntry.id]: { starred: true, starredAt: 1 } })),
    ]);

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/feeds/delete-me`, { method: 'DELETE' });
      expect(response.status).toBe(200);
      const [feeds, cache, state] = await Promise.all(paths.map(async file =>
        JSON.parse(await readFile(join(dataDir, file), 'utf-8'))));
      expect(feeds.feeds).toEqual([]);
      expect(cache.entries).toEqual([]);
      expect(cache.lastFetched).toEqual({});
      expect(cache.feedErrors).toEqual({});
      expect(cache.feedMeta).toEqual({});
      expect(state).toEqual({});
    } finally {
      await Promise.all(paths.map((file, index) => writeFile(join(dataDir, file), originals[index]!)));
    }
  });

  test('accepts the system theme and serves its CSS', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ theme: 'system' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json() as { theme: string }).theme).toBe('system');

    const css = await fetch(`http://127.0.0.1:${port}/api/theme`);
    expect(css.status).toBe(200);
    expect(await css.text()).toContain('feedreader-system-theme');
  });

  test('rejects unsafe and unavailable theme names', async () => {
    for (const theme of ['../../../tmp/evil', 'default']) {
      const res = await fetch(`http://127.0.0.1:${port}/api/config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ theme }),
      });
      expect(res.status).toBe(400);
    }
  });

  test('validates config bounds and preserves fields omitted by partial updates', async () => {
    const configPath = join(dataDir, 'config.json');
    const original = await readFile(configPath, 'utf-8');
    try {
      for (const body of [
        { maxBulkOpen: 0 },
        { retention: { maxEntries: 99 } },
        { retention: { maxDays: 36501 } },
      ]) {
        const invalid = await fetch(`http://127.0.0.1:${port}/api/config`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        expect(invalid.status).toBe(400);
      }

      const update = await fetch(`http://127.0.0.1:${port}/api/config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ retention: { maxDays: 30 } }),
      });
      expect(update.status).toBe(200);
      const saved = await update.json() as Config;
      expect(saved.retention).toEqual({ maxEntries: 3000, maxDays: 30 });
      expect(saved.maxBulkOpen).toBe(20);
    } finally {
      await writeFile(configPath, original);
    }
  });

  test('starts refresh with progress and delta fields instead of full snapshots', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/refresh`, { method: 'POST' });

    expect(res.status).toBe(202);
    const body = await res.json() as RefreshStatus & {
      entries?: unknown[];
      feeds?: unknown;
    };
    expect(typeof body.runId).toBe('string');
    expect(typeof body.cursor).toBe('number');
    expect(body.newEntries).toEqual([]);
    expect(body.feedResults).toEqual([]);
    expect(body.entries).toBeUndefined();
    expect(body.feeds).toBeUndefined();
  });

  test('reports refresh status', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/refresh/status`);
    expect(res.status).toBe(200);
    const body = await res.json() as RefreshStatus & {
      entries?: unknown[];
      feeds?: unknown;
    };
    expect(typeof body.refreshing).toBe('boolean');
    expect(typeof body.cursor).toBe('number');
    expect(body.entries).toBeUndefined();
    expect(body.feeds).toBeUndefined();

    const caughtUp = await fetch(`http://127.0.0.1:${port}/api/refresh/status?since=${body.cursor}`);
    expect(caughtUp.status).toBe(200);
    const caughtUpBody = await caughtUp.json() as { newEntries: unknown[] };
    expect(caughtUpBody.newEntries).toEqual([]);
  });

  test('renders persistent loading and refresh status UI', async () => {
    const page = await fetch(`http://127.0.0.1:${port}/`);
    const html = await page.text();
    expect(html).toContain('id="refresh-status"');
    expect(html.match(/class="refresh-bar"/g)).toHaveLength(4);
    const app = await (await fetch(`http://127.0.0.1:${port}/app.js`)).text();
    expect(app).toContain('Loading saved entries…');
    expect(app).toContain('Checking feeds ');
    expect(app).toContain('/api/refresh/status?since=');
  });

  test('serves app.js with a strict CSP on the document', async () => {
    const page = await fetch(`http://127.0.0.1:${port}/`);
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(page.headers.get('content-security-policy')).toContain("style-src 'self'");
    expect(page.headers.get('content-security-policy')).not.toContain("'unsafe-inline'");
    const script = await fetch(`http://127.0.0.1:${port}/app.js`);
    expect(script.status).toBe(200);
    expect(script.headers.get('content-type')).toContain('text/javascript');
    const underServe = await fetch(`http://127.0.0.1:${port}/feedreader/app.js`);
    expect(underServe.status).toBe(200);
  });

  test('serves compiled client assets with conditional, compressed, and range handling', async () => {
    const full = await fetch(`http://127.0.0.1:${port}/app.js`);
    expect(full.status).toBe(200);
    const etag = full.headers.get('etag');
    expect(etag).toBeTruthy();

    const conditional = await fetch(`http://127.0.0.1:${port}/app.js`, {
      headers: { 'if-none-match': etag! },
    });
    expect(conditional.status).toBe(304);

    const range = await fetch(`http://127.0.0.1:${port}/app.js`, {
      headers: { range: 'bytes=0-15' },
    });
    expect(range.status).toBe(206);
    expect(range.headers.get('content-range')).toMatch(/^bytes 0-15\//);
    expect((await range.arrayBuffer()).byteLength).toBe(16);

    const compressed = await fetch(`http://127.0.0.1:${port}/app.css`, {
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(compressed.status).toBe(200);
    expect(compressed.headers.get('content-encoding')).toBe('gzip');
    expect(compressed.headers.get('vary')).toContain('accept-encoding');
    expect(await compressed.text()).toContain('.entry-card');
  });

  test('compresses and revalidates the cached entries snapshot', async () => {
    const full = await fetch(`http://127.0.0.1:${port}/api/entries`, {
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(full.status).toBe(200);
    expect(full.headers.get('content-encoding')).toBe('gzip');
    expect(full.headers.get('vary')).toContain('accept-encoding');
    expect(await full.json()).toEqual([]);
    const etag = full.headers.get('etag');
    expect(etag).toBeTruthy();

    const conditional = await fetch(`http://127.0.0.1:${port}/api/entries`, {
      headers: { 'if-none-match': etag! },
    });
    expect(conditional.status).toBe(304);
  });

  test('validates raw Host before serving app.js', async () => {
    const res = await rawRequest({ method: 'GET', path: '/app.js', headers: { host: `evil.com:${port}` } });
    expect(res.status).toBe(403);
  });

  test('closes stalled headers and chunked bodies after the idle timeout', async () => {
    const waitForClose = (initial: string) => new Promise<number>((resolve, reject) => {
      const started = Date.now();
      const socket = net.createConnection({ host: '127.0.0.1', port }, () => socket.write(initial));
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('Stalled connection exceeded the server idle timeout'));
      }, 13_000);
      socket.once('close', () => {
        clearTimeout(timer);
        resolve(Date.now() - started);
      });
      socket.once('error', error => {
        clearTimeout(timer);
        reject(error);
      });
    });

    const [headerMs, bodyMs] = await Promise.all([
      waitForClose(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}`),
      waitForClose(`POST /api/state HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n1\r\n{\r\n`),
    ]);
    expect(headerMs).toBeLessThan(13_000);
    expect(bodyMs).toBeLessThan(13_000);
  }, 15_000);
});
