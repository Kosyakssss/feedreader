import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => ({
  sources: locals.store.sources(),
  mutes: locals.store.mutesBySource(),
});
