import { scopes } from '#lib/server/store.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => ({ entries: locals.store.entries(scopes.bookmarks) });
