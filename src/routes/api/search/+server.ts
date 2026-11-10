import type { RequestHandler } from './$types';

// Feeds by name and entries by title, as you type.
export const GET: RequestHandler = ({ locals, url }) => {
  const query = url.searchParams.get('q')?.trim() ?? '';
  if (!query) return Response.json({ feeds: [], entries: [] });
  return Response.json({
    feeds: locals.store.searchFeeds(query).map(({ id, label }) => ({ id, label })),
    entries: locals.store.searchEntries(query),
  });
};
