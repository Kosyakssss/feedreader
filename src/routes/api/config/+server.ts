import { json } from '@sveltejs/kit';
import { app } from '$lib/server/app';
import type { RequestHandler } from './$types';
import { body, configPatch } from '$lib/server/http';
import { normalizeConfig } from '$lib/server/normalize';
export const GET: RequestHandler = async () => app().store.query((data) => json(data.config));
export const PUT: RequestHandler = async ({ request }) => {
  const patch = configPatch(await body(request));
  const config = await app().store.change(
    ['config'],
    (data) =>
      (data.config = normalizeConfig({
        ...data.config,
        ...patch,
        retention: { ...data.config.retention, ...patch.retention },
      })),
  );
  app().events.publish({ topics: ['config'] });
  return json(config);
};
