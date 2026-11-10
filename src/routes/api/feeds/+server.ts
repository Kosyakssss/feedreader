import { error } from '@sveltejs/kit';
import { discover } from '#lib/server/fetch.ts';
import type { RequestHandler } from './$types';

// Follows a feed: a feed's address, a site that has one, or a Bluesky handle.
export const POST: RequestHandler = async ({ locals, request }) => {
  const { url } = (await request.json().catch(() => ({}))) as { url?: unknown };
  if (typeof url !== 'string' || !url.trim()) error(400, 'Bad request');
  try {
    const found = await discover(url);
    const id = locals.store.addSource(found.kind, found.ref, found.label);
    locals.follow(id);
    return Response.json({ id, label: found.label });
  } catch (reason) {
    error(422, reason instanceof Error ? reason.message : String(reason));
  }
};
