import { json } from '@sveltejs/kit';
import { app } from '$lib/server/app';
import type { RequestHandler } from './$types';
import { body, configPatch } from '$lib/server/http';
export const GET: RequestHandler = async () => json(app().store.config());
export const PUT: RequestHandler = async ({ request }) => {
  const patch = configPatch(await body(request));
  const config = app().store.configure(patch);
  app().events.publish({ topics: ['config'] });
  return json(config);
};
