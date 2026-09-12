import { requestPolicy, apiError, acceptsGzip } from './src/lib/server/request-policy';
import { Storage } from './src/lib/server/storage';
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
const built = resolve(import.meta.dir, 'build/handler.js');
if (!(await Bun.file(built).exists())) throw new Error('Run bun run build before starting Feedreader');
const storage = new Storage(process.env.FEEDREADER_DATA_DIR);
const config = storage.config();
storage.close();
const port = Number(values.port || process.env.PORT || config.port || 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
process.env.PORT = String(port);
process.env.HOST = values.host || process.env.HOST || '127.0.0.1';
process.env.PROTOCOL_HEADER = 'x-feedreader-protocol';
const { getHandler } = await import(built);
const handler = getHandler();
const policy = requestPolicy(config, port);
const server = Bun.serve({
  hostname: process.env.HOST,
  port,
  maxRequestBodySize: 2 * 1024 * 1024,
  idleTimeout: 10,
  async fetch(request, server) {
    const denied = policy(request);
    if (denied) return denied;
    const url = new URL(request.url);
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
    let response = await handler.fetch(
      new Request(url, { method: request.method, headers, body: request.body, signal: request.signal }),
      server,
    );
    response = await apiError(response, url.pathname);
    if (
      response.body &&
      request.method !== 'HEAD' &&
      /^(?:text\/(?:html|css)|application\/json)/.test(response.headers.get('content-type') ?? '') &&
      !response.headers.has('content-encoding')
    ) {
      response.headers.append('vary', 'accept-encoding');
      if (acceptsGzip(request)) {
        const bytes = Bun.gzipSync(await response.arrayBuffer());
        const headers = new Headers(response.headers);
        headers.set('content-encoding', 'gzip');
        headers.set('content-length', String(bytes.byteLength));
        return new Response(bytes, { status: response.status, headers });
      }
    }
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
