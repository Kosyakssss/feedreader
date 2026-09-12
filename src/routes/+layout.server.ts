import { app } from '$lib/server/app';
import { requestBase } from '$lib/server/request-policy';
import { internalPath } from '$lib/paths';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ url, params, request, untrack }) => {
  const { store, refresh } = app();
  const path = internalPath(untrack(() => url.pathname));
  const feed = path.startsWith('/feed/') ? untrack(() => params.id) : undefined;
  return {
    initial: {
      base: untrack(() => requestBase(request, url)),
      entries:
        path === '/' || path === '/starred' || feed ? store.entries(feed, path === '/starred', 50) : [],
      feeds: store.health(),
      config: store.config(),
      counts: store.counts(),
      status: refresh.status(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
    },
  };
};
