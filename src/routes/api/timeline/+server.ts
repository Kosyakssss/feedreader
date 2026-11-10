import { error } from '@sveltejs/kit';
import { timelinePage } from '#lib/server/timeline.ts';
import type { RequestHandler } from './$types';

// The next page of the timeline, after the entry `after=<published_at>:<id>`.
export const GET: RequestHandler = ({ locals, url }) => {
  const [published_at, id] = (url.searchParams.get('after') ?? '').split(':').map(Number);
  if (!Number.isInteger(published_at) || !Number.isInteger(id)) error(400, 'Bad request');
  return Response.json(timelinePage(locals.store, { published_at: published_at!, id: id! }));
};
