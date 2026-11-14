import type { Handle, ServerInit } from '@sveltejs/kit/hooks';
import { start, type Lagan } from '#lib/server/lagan.ts';

let lagan: Lagan;

export const init: ServerInit = () => {
  lagan = start();
};

// A page on another site must not be able to change anything here.
function sameOrigin(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site');
  if (site) return site === 'same-origin' || site === 'none';
  const origin = request.headers.get('origin');
  return !origin || new URL(origin).host === new URL(request.url).host;
}

export const handle: Handle = async ({ event, resolve }) => {
  if (event.request.method !== 'GET' && event.request.method !== 'HEAD' && !sameOrigin(event.request)) {
    return new Response('Forbidden', { status: 403 });
  }
  event.locals.store = lagan.store;
  event.locals.live = lagan.live;
  event.locals.wake = lagan.wake;
  event.locals.follow = lagan.follow;
  return compressed(event.request, await resolve(event));
};

// Pages go out gzipped, small enough to arrive in the connection's first
// round trip. The server built for Bun only compresses its static files.
function compressed(request: Request, response: Response): Response {
  const html = response.headers.get('content-type')?.startsWith('text/html');
  const accepts = /\bgzip\b/.test(request.headers.get('accept-encoding') ?? '');
  if (!html || !accepts || !response.body || response.headers.has('content-encoding')) return response;
  const headers = new Headers(response.headers);
  headers.set('content-encoding', 'gzip');
  headers.delete('content-length');
  headers.append('vary', 'accept-encoding');
  const body = response.body.pipeThrough(new CompressionStream('gzip'));
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}
