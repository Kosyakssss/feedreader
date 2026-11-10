import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

// Stops following a feed. Its bookmarks stay, as bookmarked pages.
export const DELETE: RequestHandler = ({ locals, params }) => {
  const id = Number(params.id);
  if (!Number.isInteger(id) || !locals.store.source(id)) error(404, 'No such feed');
  locals.store.removeSource(id);
  return new Response(null, { status: 204 });
};
