import { error } from '@sveltejs/kit';
import type { Mark } from '#lib/server/store.ts';
import type { RequestHandler } from './$types';

const MOST = 5000; // more than any page shows

const flag = (value: unknown) => value === undefined || typeof value === 'boolean';

// Marks entries read or unread, bookmarked or not: { ids, read?, bookmarked? }.
// Answers with the entries as they now are.
export const POST: RequestHandler = async ({ locals, request }) => {
  const body = (await request.json().catch(() => null)) as ({ ids?: unknown } & Mark) | null;
  const ids = body?.ids;
  if (
    !Array.isArray(ids) ||
    ids.length > MOST ||
    !ids.every(Number.isInteger) ||
    !flag(body!.read) ||
    !flag(body!.bookmarked) ||
    (body!.read === undefined && body!.bookmarked === undefined)
  )
    error(400, 'Bad request');
  return Response.json(locals.store.mark(ids as number[], { read: body!.read, bookmarked: body!.bookmarked }));
};
