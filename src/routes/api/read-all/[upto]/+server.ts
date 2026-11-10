import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

// Marks Unread read up to the newest entry the page was showing.
export const POST: RequestHandler = ({ locals, params }) => {
  const upto = Number(params.upto);
  if (!Number.isInteger(upto)) error(400, 'Bad request');
  locals.store.readAll(upto);
  return new Response(null, { status: 204 });
};
