import { spawn } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

function parseArgs(): { runtime: string; requests: number } {
  const argv = process.argv.slice(2);
  const runtime = argv[0] === 'node' || argv[0] === 'bun' ? argv[0] : 'bun';
  const requested = Number.parseInt(argv[1] ?? '', 10);
  return { runtime, requests: Number.isInteger(requested) && requested > 0 ? requested : 30 };
}

async function waitForReady(url: string, deadlineMs: number): Promise<number> {
  const started = performance.now();
  while (performance.now() - started < deadlineMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return performance.now() - started;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error('server did not become ready');
}

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

async function timeEndpoint(url: string, requests: number): Promise<number[]> {
  const samples: number[] = [];
  for (let i = 0; i < requests; i++) {
    const started = performance.now();
    const res = await fetch(url);
    await res.arrayBuffer();
    samples.push(performance.now() - started);
  }
  return samples;
}

async function main(): Promise<void> {
  const { runtime, requests } = parseArgs();
  const dataDir = await mkdtemp(join(tmpdir(), `feedreader-bench-${runtime}-`));
  await cp(join(REPO_ROOT, 'data'), dataDir, { recursive: true });

  const port = 45000 + Math.floor(Math.random() * 5000);
  const base = `http://127.0.0.1:${port}`;
  const proc = spawn(runtime, ['server.ts', '--data', dataDir, '--port', String(port)], {
    cwd: REPO_ROOT,
    stdio: 'ignore',
  });

  try {
    const startupMs = await waitForReady(`${base}/api/feeds`, 15000);

    const routes: Array<[string, string]> = [
      ['/api/feeds', 'feeds'],
      ['/api/entries', 'entries'],
      ['/', 'html'],
    ];
    const results: Record<string, object> = {};
    for (const [path, name] of routes) {
      const samples = await timeEndpoint(base + path, requests);
      results[name] = {
        mean: Math.round(samples.reduce((a, b) => a + b, 0) / samples.length * 100) / 100,
        p50: Math.round(percentile(samples, 50) * 100) / 100,
        max: Math.round(Math.max(...samples) * 100) / 100,
      };
    }

    console.log(JSON.stringify({ runtime, startupMs: Math.round(startupMs), ...results }));
  } finally {
    proc.kill('SIGTERM');
    await new Promise<void>(resolve => {
      proc.once('exit', () => resolve());
      setTimeout(() => { proc.kill('SIGKILL'); resolve(); }, 2000).unref();
    });
    await rm(dataDir, { recursive: true, force: true });
  }
}

await main();
