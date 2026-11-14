import { error } from '@sveltejs/kit';
import { TIMELINE_STEP } from '#lib/format.ts';
import { scopes } from '#lib/server/store.ts';
import type { RequestHandler } from './$types';

// One page's list, for drawing it before the library has arrived: on the
// server, and for a page opened in the moment after the app starts.
export const GET: RequestHandler = ({ locals, url }) => {
  const list = url.searchParams.get('of');
  if (list === 'unread') {
    locals.wake(); // opening Unread is the moment to check for news
    return Response.json({ entries: locals.store.entries(scopes.unread) });
  }
  if (list === 'timeline') {
    // One more than the first step, to know whether there is more after it.
    const entries = locals.store.entries({ ...scopes.timeline, limit: TIMELINE_STEP + 1 });
    return Response.json({ entries: entries.slice(0, TIMELINE_STEP), more: entries.length > TIMELINE_STEP });
  }
  if (list === 'bookmarks') return Response.json({ entries: locals.store.entries(scopes.bookmarks) });
  if (list === 'feeds') return Response.json({ sources: locals.store.sources(), mutes: locals.store.mutesBySource() });
  const id = Number(url.searchParams.get('feed'));
  const source = Number.isInteger(id) ? locals.store.source(id) : null;
  if (!source) error(404, 'Not found');
  return Response.json({ label: source.label, entries: locals.store.entries(scopes.feed(id)) });
};
