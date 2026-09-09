import { json, error } from '@sveltejs/kit';
import { app } from '$lib/server/app';
import type { RequestHandler } from './$types';
import { body, statePatch } from '$lib/server/http';
export const POST: RequestHandler = async ({ request }) => {
  const updates = statePatch(await body(request));
  let entryStates;
  try {
    entryStates = app().store.mark(updates);
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith('Unknown entry id:')) error(400, cause.message);
    throw cause;
  }
  app().events.publish({ topics: ['entry-state'], entryStates });
  return json({ ok: true, entryStates });
};
