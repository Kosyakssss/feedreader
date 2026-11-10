import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

// Replaces a feed's muted words. Answers with them as stored.
export const PUT: RequestHandler = async ({ locals, params, request }) => {
  const id = Number(params.id);
  if (!Number.isInteger(id) || !locals.store.source(id)) error(404, 'No such feed');
  const { words } = (await request.json().catch(() => ({}))) as { words?: unknown };
  if (!Array.isArray(words) || !words.every((word) => typeof word === 'string')) error(400, 'Bad request');
  return Response.json({ words: locals.store.setMutes(id, words) });
};
