import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { Configuration } from './src/lib/server/config';
import { acceptsGzip } from './src/lib/server/request-policy';

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
process.env.FEEDREADER_ROOT = import.meta.dir;
process.env.FEEDREADER_DATA_DIR = resolve(values.data || process.env.FEEDREADER_DATA_DIR || 'data');
if (values.logs) process.env.FEEDREADER_LOG_DIR = resolve(values.logs);
const built = resolve(import.meta.dir, 'build/handler.js');
if (!(await Bun.file(built).exists())) throw new Error('Run bun run build before starting Feedreader');
const config = new Configuration(process.env.FEEDREADER_DATA_DIR).read();
const port = Number(values.port || process.env.PORT || config.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
process.env.PORT = String(port);
process.env.HOST = values.host || process.env.HOST || '127.0.0.1';
process.env.PROTOCOL_HEADER = 'x-forwarded-proto';
const { getHandler } = await import(built);
const handler = getHandler();
const server = Bun.serve({
  hostname: process.env.HOST,
  port,
  maxRequestBodySize: 2 * 1024 * 1024,
  idleTimeout: 10,
  async fetch(request, server) {
    const asset = new URL(request.url);
    if (asset.pathname.startsWith('/feedreader/_app/')) {
      asset.pathname = asset.pathname.slice('/feedreader'.length);
      return handler.fetch(new Request(asset, request), server);
    }
    const headers = new Headers(request.headers);
    if (!headers.has('x-forwarded-proto')) headers.set('x-forwarded-proto', 'http');
    const response = await handler.fetch(new Request(request, { headers }), server);
    if (
      response.body &&
      request.method !== 'HEAD' &&
      acceptsGzip(request) &&
      /^(?:text\/(?:html|css)|application\/json)/.test(response.headers.get('content-type') ?? '') &&
      !response.headers.has('content-encoding')
    ) {
      const headers = new Headers(response.headers);
      headers.set('content-encoding', 'gzip');
      headers.delete('content-length');
      headers.append('vary', 'accept-encoding');
      return new Response(response.body.pipeThrough(new CompressionStream('gzip')), {
        status: response.status,
        headers,
      });
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
    const drained = server.stop();
    await Promise.all(process.listeners('feedreader:shutdown').map((listener) => listener(drained)));
    await drained;
    clearTimeout(timeout);
  });
console.log(`Feedreader running at http://${process.env.HOST}:${port}/feedreader/`);
