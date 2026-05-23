import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dataDir = '';
let port = 0;
let proc: ReturnType<typeof Bun.spawn> | null = null;

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

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'feedreader-test-'));
  await mkdir(join(dataDir, 'themes'), { recursive: true });
  await writeFile(join(dataDir, 'feeds.json'), '{ "folders": [], "feeds": [] }\n');
  await writeFile(join(dataDir, 'state.json'), '{}\n');
  await writeFile(join(dataDir, 'cache.json'), '{ "entries": [], "lastFetched": {} }\n');
  await writeFile(join(dataDir, 'themes', 'default.css'), 'body { color: #111; }\n');

  port = 41000 + Math.floor(Math.random() * 5000);
  proc = Bun.spawn({
    cmd: ['bun', 'server.ts', '--data', dataDir, '--port', String(port)],
    cwd: import.meta.dir + '/..',
    stdout: 'ignore',
    stderr: 'ignore',
  });

  await waitForServerReady(`http://127.0.0.1:${port}`);
});

afterAll(async () => {
  proc?.kill();
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
    expect(body.ok).toBeTrue();
    expect(typeof body.pid).toBe('number');
    expect(typeof body.uptimeSeconds).toBe('number');
    expect(typeof body.refreshing).toBe('boolean');
  });

  test('rejects cross-origin mutating requests', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/refresh`, {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
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

  test('fails loudly on malformed cache JSON', async () => {
    const cachePath = join(dataDir, 'cache.json');
    const original = await readFile(cachePath, 'utf-8');
    await writeFile(cachePath, '{bad');
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/entries`);
      expect(res.status).toBe(500);
      const body = await res.json() as { error: string };
      expect(body.error).toContain('Malformed JSON in cache.json');
    } finally {
      await writeFile(cachePath, original);
    }
  });

  test('skips unsafe feed URLs during OPML import', async () => {
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

    const res = await fetch(`http://127.0.0.1:${port}/api/feeds/import`, {
      method: 'POST',
      body: form,
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { added: number; skipped: number };
    expect(body).toEqual({ added: 1, skipped: 1 });

    const feedsRes = await fetch(`http://127.0.0.1:${port}/api/feeds`);
    const feeds = await feedsRes.json() as { feeds: Array<{ url: string }> };
    expect(feeds.feeds.map(feed => feed.url)).toEqual(['https://example.com/feed.xml']);
  });

  test('preserves concurrent state updates', async () => {
    const requests: Promise<Response>[] = [];
    for (let i = 0; i < 20; i++) {
      requests.push(fetch(`http://127.0.0.1:${port}/api/state`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entries: { a: { read: true } } }),
      }));
      requests.push(fetch(`http://127.0.0.1:${port}/api/state`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entries: { b: { starred: true } } }),
      }));
    }

    await Promise.all(requests);

    const state = JSON.parse(await readFile(join(dataDir, 'state.json'), 'utf-8')) as Record<string, { read?: boolean; starred?: boolean }>;
    expect(state.a?.read).toBeTrue();
    expect(state.b?.starred).toBeTrue();
  });

  test('rejects invalid theme name in /api/config', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ theme: '../../../tmp/evil' }),
    });
    expect(res.status).toBe(400);
  });

  test('accepts valid theme name in /api/config', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ theme: 'default' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { theme: string };
    expect(body.theme).toBe('default');
  });

  test('starts refresh in the background and returns entries and feed health from /api/refresh', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/refresh`, { method: 'POST' });

    expect(res.status).toBe(202);
    const body = await res.json() as {
      count: number;
      refreshing: boolean;
      entries: unknown[];
      feeds: { feeds: unknown[]; health: Record<string, unknown> };
    };
    expect(typeof body.count).toBe('number');
    expect(typeof body.refreshing).toBe('boolean');
    expect(Array.isArray(body.entries)).toBeTrue();
    expect(Array.isArray(body.feeds.feeds)).toBeTrue();
    expect(body.feeds.health).toBeDefined();
  });

  test('reports refresh status', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/refresh/status`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      refreshing: boolean;
      count: number;
      entries: unknown[];
      feeds: { feeds: unknown[] };
    };
    expect(typeof body.refreshing).toBe('boolean');
    expect(typeof body.count).toBe('number');
    expect(Array.isArray(body.entries)).toBeTrue();
    expect(Array.isArray(body.feeds.feeds)).toBeTrue();
  });
});
