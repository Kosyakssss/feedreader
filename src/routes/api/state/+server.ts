import { json, error } from '@sveltejs/kit';
import { app } from '$lib/server/app';
import type { RequestHandler } from './$types';
import { body, statePatch } from '$lib/server/http';
import type { EntryState } from '$lib/types';
export const POST: RequestHandler = async ({ request }) => {
  const updates = statePatch(await body(request));
  const entryStates = await app().store.change(['state'], (data) => {
    const known = new Set([...data.cache.entries.map((entry) => entry.id), ...app().refresh.knownIds]);
    const result: Record<string, EntryState> = {};
    for (const [id, update] of Object.entries(updates)) {
      if (!known.has(id)) error(400, `Unknown entry id: ${id}`);
      const state = (data.state[id] ??= {});
      for (const key of ['read', 'starred'] as const)
        if (update[key] !== undefined) {
          state[key] = update[key];
          const timestamp = key === 'read' ? 'readAt' : 'starredAt';
          state[timestamp] = Math.max(Date.now(), (state[timestamp] ?? 0) + 1);
        }
      result[id] = { ...state };
    }
    return result;
  });
  app().events.publish({ topics: ['entry-state'], entryStates });
  return json({ ok: true, entryStates });
};
