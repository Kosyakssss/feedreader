import { app } from '$lib/server/app';
import type { RequestHandler } from './$types';
import { enrich } from '$lib/server/refresh';
let snapshot:
  | { revision: number; bytes: Uint8Array<ArrayBuffer>; gzip: Uint8Array<ArrayBuffer>; etag: string }
  | undefined;
export const GET: RequestHandler = async ({ url, request }) => {
  const store = app().store;
  const feed = url.searchParams.get('feed');
  const asset = await store.query((data) => {
    if (!feed && snapshot?.revision === store.revision) return snapshot;
    const bytes = new TextEncoder().encode(
      JSON.stringify(
        enrich(data, feed ? data.cache.entries.filter((entry) => entry.feedId === feed) : undefined),
      ),
    );
    const asset = {
      revision: store.revision,
      bytes,
      gzip: Bun.gzipSync(bytes),
      etag: `W/"${Bun.hash(bytes).toString(16)}"`,
    };
    if (!feed) snapshot = asset;
    return asset;
  });
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-cache',
    etag: asset.etag,
    vary: 'accept-encoding',
  });
  if (request.headers.get('if-none-match') === asset.etag)
    return new Response(null, { status: 304, headers });
  const encodings = new Map(
    (request.headers.get('accept-encoding') ?? '').split(',').map((value) => {
      const [encoding, ...params] = value.trim().toLowerCase().split(';');
      return [
        encoding,
        Number(
          params
            .find((p) => p.trim().startsWith('q='))
            ?.trim()
            .slice(2) ?? 1,
        ),
      ];
    }),
  );
  if ((encodings.get('gzip') ?? encodings.get('*') ?? 0) > 0) {
    headers.set('content-encoding', 'gzip');
    return new Response(asset.gzip, { headers });
  }
  return new Response(asset.bytes, { headers });
};
