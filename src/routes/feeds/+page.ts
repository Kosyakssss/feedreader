import { fromServer } from '#lib/lists.ts';
import type { Source } from '#lib/server/store.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch }) => ({
  list: await fromServer<{ sources: Source[]; mutes: Record<number, string[]> }>(fetch, 'of=feeds'),
});
