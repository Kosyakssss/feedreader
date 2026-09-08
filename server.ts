import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    data: { type: 'string' },
    port: { type: 'string' },
    host: { type: 'string' },
    logs: { type: 'string' },
  },
  strict: true,
});
process.env.FEEDREADER_DATA_DIR = resolve(values.data || process.env.FEEDREADER_DATA_DIR || 'data');
if (values.logs) process.env.FEEDREADER_LOG_DIR = resolve(values.logs);
const raw = await Bun.file(resolve(process.env.FEEDREADER_DATA_DIR, 'config.json'))
  .json()
  .catch((error) => {
    if (error.code === 'ENOENT') return {};
    throw error;
  });
const config = raw?.$feedreader === 1 ? raw.data : raw;
const port = Number(values.port || process.env.PORT || config.port || 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
process.env.PORT = String(port);
process.env.HOST = values.host || process.env.HOST || '127.0.0.1';
process.env.PROTOCOL_HEADER = 'x-feedreader-protocol';
const built = resolve(import.meta.dir, 'build/handler.js');
if (!(await Bun.file(built).exists())) throw new Error('Run bun run build before starting Feedreader');
const { getHandler } = await import(built);
const handler = getHandler();
const allowedHosts = new Set([
  `localhost:${port}`,
  `127.0.0.1:${port}`,
  `[::1]:${port}`,
  ...(config.trustedOrigins || []).map((origin: string) => new URL(origin).host),
]);
const server = Bun.serve({
  hostname: process.env.HOST,
  port,
  maxRequestBodySize: 2 * 1024 * 1024,
  idleTimeout: 10,
  async fetch(request, server) {
    if (!allowedHosts.has(request.headers.get('host')?.trim().toLowerCase() || ''))
      return Response.json({ error: 'Unrecognized Host header' }, { status: 403 });
    const url = new URL(request.url);
    if (url.pathname.endsWith('/api/events')) server.timeout(request, 0);
    else if (url.pathname.endsWith('/api/feeds') && request.method === 'POST') server.timeout(request, 120);
    if (url.pathname.startsWith('/feedreader/_app/')) url.pathname = url.pathname.slice('/feedreader'.length);
    const headers = new Headers(request.headers);
    headers.set(
      'x-feedreader-protocol',
      request.headers.get('x-forwarded-proto') === 'https' ? 'https' : 'http',
    );
    if (
      headers.get('content-type')?.startsWith('multipart/form-data') &&
      !headers.has('origin') &&
      !headers.has('sec-fetch-site')
    )
      headers.set('origin', `${headers.get('x-feedreader-protocol')}://${headers.get('host')}`);
    const response = await handler.fetch(
      new Request(url, { method: request.method, headers, body: request.body, signal: request.signal }),
      server,
    );
    if (
      url.pathname.includes('/api/') &&
      response.status >= 400 &&
      !response.headers.get('content-type')?.includes('application/json')
    )
      return Response.json(
        { error: response.status === 403 ? 'Cross-origin requests are not allowed' : response.statusText },
        { status: response.status },
      );
    return response;
  },
});
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, async () => {
    if (stopping) return;
    stopping = true;
    const timeout = setTimeout(() => process.exit(1), 10000);
    timeout.unref();
    const pending = process.listeners('feedreader:shutdown').map((listener) => listener(signal));
    await Promise.all(pending);
    await server.stop(true);
    clearTimeout(timeout);
  });
console.log(`Feedreader running at http://${process.env.HOST}:${port}`);
