import { acceptsGzip } from '$lib/server/request-policy';
import { app } from '$lib/server/app';
import type { RequestHandler } from './$types';
let snapshot:
  | { revision: string; bytes: Uint8Array<ArrayBuffer>; gzip: Uint8Array<ArrayBuffer>; etag: string }
  | undefined;
export const GET: RequestHandler = async ({ url, request }) => {
  const store = app().store;
  const feed = url.searchParams.get('feed');
  const asset = (() => {
    if (!feed && snapshot?.revision === store.revision) return snapshot;
    const bytes = new TextEncoder().encode(JSON.stringify(store.entries(feed || undefined)));
    const asset = {
      revision: store.revision,
      bytes,
      gzip: Bun.gzipSync(bytes),
      etag: `W/"${Bun.hash(bytes).toString(16)}"`,
    };
    if (!feed) snapshot = asset;
    return asset;
  })();
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-cache',
    etag: asset.etag,
    vary: 'accept-encoding',
  });
  if (request.headers.get('if-none-match') === asset.etag)
    return new Response(null, { status: 304, headers });
  if (acceptsGzip(request)) {
    headers.set('content-encoding', 'gzip');
    return new Response(asset.gzip, { headers });
  }
  return new Response(asset.bytes, { headers });
};
