import { fromServer } from '#lib/lists.ts';
import type { Entry } from '#lib/server/store.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch }) => ({
  list: await fromServer<{ entries: Entry[] }>(fetch, 'of=bookmarks'),
});
