import { scopes } from '#lib/server/store.ts';
import type { PageServerLoad } from './$types';

// Opening Unread is the moment to check for news.
export const load: PageServerLoad = ({ locals }) => {
  locals.wake();
  return { entries: locals.store.entries(scopes.unread) };
};
