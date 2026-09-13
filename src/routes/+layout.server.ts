import { app } from '$lib/server/app';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ params, route, untrack }) => {
  const { store, config, themes, refresh } = app();
  const path = untrack(() => route.id);
  const feed = untrack(() => params.id);
  return {
    initial: {
      entries:
        path === '/' || path === '/starred' || feed ? store.entries(feed, path === '/starred', 50) : [],
      feeds: store.health(),
      config: config.read(),
      themes: themes.list(),
      counts: store.counts(),
      status: refresh.status(),
    },
  };
};
