import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
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
    cwd: '/Users/kote/Projects/feedreader',
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
  test('serves the queued bulk-open fallback page', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/open-queue`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Queued articles');
    expect(body).toContain('window.name');
  });

  test('rejects malformed JSON in /api/state with 400', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{bad',
    });
    expect(res.status).toBe(400);
  });

  test('blocks localhost SSRF in /api/proxy', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/proxy?url=http%3A%2F%2F127.0.0.1%3A${port}%2Fapi%2Ffeeds`);
    expect(res.status).toBe(400);
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
});
