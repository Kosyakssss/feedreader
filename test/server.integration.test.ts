import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

let dataDir = '';
let port = 0;
let proc: ChildProcess | null = null;

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
  await writeFile(join(dataDir, 'themes', 'system.css'), '/* feedreader-system-theme */\nbody { color: CanvasText; }\n');

  port = 41000 + Math.floor(Math.random() * 5000);
  proc = spawn(process.env.FEEDREADER_SERVER_BIN || 'bun', ['server.ts', '--data', dataDir, '--port', String(port)], {
    cwd: dirname(fileURLToPath(new URL('../server.ts', import.meta.url))),
    stdio: 'ignore',
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
    expect(body.ok).toBe(true);
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
    expect(html).toContain('const BASE_PATH = "/feedreader"');

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
    expect(html).toContain('const BASE_PATH = "/feedreader"');
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
    for (let i = 0; i < 100; i++) {
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
    expect(state.a?.read).toBe(true);
    expect(state.b?.starred).toBe(true);
  });

  test('rejects invalid theme name in /api/config', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ theme: '../../../tmp/evil' }),
    });
    expect(res.status).toBe(400);
  });

  test('accepts the system theme in /api/config', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ theme: 'system' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json() as { theme: string }).theme).toBe('system');
  });

  test('serves the active system theme CSS', async () => {
    const update = await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ theme: 'system' }),
    });
    expect(update.status).toBe(200);

    const css = await fetch(`http://127.0.0.1:${port}/api/theme`);
    expect(css.status).toBe(200);
    expect(await css.text()).toContain('feedreader-system-theme');
  });

  test('rejects unavailable theme names in /api/config', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ theme: 'default' }),
    });
    expect(res.status).toBe(400);
  });

  test('starts refresh with progress and delta fields instead of full snapshots', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/refresh`, { method: 'POST' });

    expect(res.status).toBe(202);
    const body = await res.json() as {
      count: number;
      runId: string;
      total: number;
      completed: number;
      succeeded: number;
      failed: number;
      failures: Array<{ feedId: string; label: string; error: string }>;
      cursor: number;
      newEntries: unknown[];
      removedIds: string[];
      refreshing: boolean;
      entries?: unknown[];
      feeds?: { feeds: unknown[]; health: Record<string, unknown> };
    };
    expect(typeof body.count).toBe('number');
    expect(typeof body.refreshing).toBe('boolean');
    expect(typeof body.runId).toBe('string');
    expect(typeof body.total).toBe('number');
    expect(typeof body.completed).toBe('number');
    expect(typeof body.succeeded).toBe('number');
    expect(typeof body.failed).toBe('number');
    expect(Array.isArray(body.failures)).toBe(true);
    expect(typeof body.cursor).toBe('number');
    expect(Array.isArray(body.newEntries)).toBe(true);
    expect(Array.isArray(body.removedIds)).toBe(true);
    expect(body.entries).toBeUndefined();
    expect(body.feeds).toBeUndefined();
  });

  test('reports refresh status', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/refresh/status`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      refreshing: boolean;
      count: number;
      cursor: number;
      newEntries: unknown[];
      removedIds: string[];
      failures: Array<{ feedId: string; label: string; error: string }>;
      entries?: unknown[];
      feeds?: { feeds: unknown[] };
    };
    expect(typeof body.refreshing).toBe('boolean');
    expect(typeof body.count).toBe('number');
    expect(typeof body.cursor).toBe('number');
    expect(Array.isArray(body.newEntries)).toBe(true);
    expect(Array.isArray(body.removedIds)).toBe(true);
    expect(Array.isArray(body.failures)).toBe(true);
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
    expect(html).toContain('Loading saved entries…');
    expect(html).toContain('Checking feeds ');
    expect(html).toContain("'/api/refresh/status?since=' + refreshCursor");
  });
});
