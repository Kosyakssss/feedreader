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
  event.locals.wake = lagan.wake;
  event.locals.follow = lagan.follow;
  return resolve(event);
};
