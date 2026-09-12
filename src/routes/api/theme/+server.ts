import { join } from 'node:path';
import { app } from '$lib/server/app';
export const GET = async () => {
  const { store } = app();
  const name = store.config().theme || 'system';
  const file = Bun.file(join(store.directory, 'themes', `${name}.css`));
  return new Response((await file.exists()) ? file : '', {
    headers: { 'content-type': 'text/css', 'cache-control': 'no-cache' },
  });
};
