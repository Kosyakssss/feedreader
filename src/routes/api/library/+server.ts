import { gzipSync } from 'node:zlib';
import type { RequestHandler } from './$types';

// The whole library, numbered with the last change it includes. The app
// starting is the moment to check for news. It is large and mostly repeated
// words, so it goes compressed: a tenth or so of the size, over a slow link.
export const GET: RequestHandler = ({ locals, request }) => {
  locals.wake();
  const body = JSON.stringify(locals.live.library());
  const headers = { 'Content-Type': 'application/json', Vary: 'Accept-Encoding' };
  if (!/\bgzip\b/.test(request.headers.get('accept-encoding') ?? '')) return new Response(body, { headers });
  return new Response(gzipSync(body), { headers: { ...headers, 'Content-Encoding': 'gzip' } });
};
