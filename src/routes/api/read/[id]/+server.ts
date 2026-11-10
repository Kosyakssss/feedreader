import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

// Marks an entry read, or unread again. Answers with the entry as it now is.
export const POST: RequestHandler = ({ locals, params }) => {
  const id = Number(params.id);
  const entry = Number.isInteger(id) ? locals.store.toggleRead(id) : null;
  if (!entry) error(404, 'No such entry');
  return Response.json(entry);
};
