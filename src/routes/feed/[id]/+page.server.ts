import { error } from '@sveltejs/kit';
import { scopes } from '#lib/server/store.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, params }) => {
  const id = Number(params.id);
  const source = Number.isInteger(id) ? locals.store.source(id) : null;
  if (!source) error(404, 'Not found');
  return { label: source.label, entries: locals.store.entries(scopes.feed(id)) };
};
