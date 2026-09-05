import { join } from 'node:path';

const request = globalThis.fetch;
const dataDir = process.argv[process.argv.indexOf('--data') + 1]!;

globalThis.fetch = (async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname !== '93.184.216.34' || !url.pathname.startsWith('/fixture/')) return request(input, init);
  const file = Bun.file(join(dataDir, 'upstream.json'));
  const fixtures = await file.exists() ? await file.json() as Record<string, { body: string; delay?: number }> : {};
  const fixture = fixtures[url.pathname];
  if (fixture?.delay) await Bun.sleep(fixture.delay);
  init?.signal?.throwIfAborted();
  return new Response(fixture?.body ?? '<rss><channel/></rss>', { headers: { 'content-type': 'application/xml' } });
}) as typeof fetch;
