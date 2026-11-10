import type { LayoutServerLoad } from './$types';

// Every page's breadcrumbs can list the feeds.
export const load: LayoutServerLoad = ({ locals }) => ({
  feeds: locals.store.sources().map(({ id, label }) => ({ id, label })),
});
