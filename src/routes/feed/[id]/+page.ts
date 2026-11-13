import { browser } from '$app/env';
import { error } from '@sveltejs/kit';
import { library } from '#lib/library.svelte.ts';
import { fromServer } from '#lib/lists.ts';
import type { Entry } from '#lib/server/store.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, params }) => {
  const id = Number(params.id);
  if (browser && library.ready && !library.source(id)) error(404, 'Not found');
  return {
    id,
    list: await fromServer<{ label: string; entries: Entry[] }>(fetch, `feed=${encodeURIComponent(params.id)}`),
  };
};
