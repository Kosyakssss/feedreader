import { json, error } from '@sveltejs/kit';
import { app } from '$lib/server/app';
import type { RequestHandler } from './$types';
import { add } from '$lib/server/subscriptions';
import { body, record } from '$lib/server/http';
export const GET: RequestHandler = () => json(app().store.health());
export const POST: RequestHandler = async ({ request, platform }) => {
  platform?.server.timeout(platform.request, 120);
  const value = await body(request);
  if (!record(value) || typeof value.url !== 'string') error(400, 'Invalid feed payload');
  return json(await add(app(), value.url), { status: 201 });
};
