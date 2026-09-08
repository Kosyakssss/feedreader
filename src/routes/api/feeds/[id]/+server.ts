import { json } from '@sveltejs/kit';
import { app } from '$lib/server/app';
import type { RequestHandler } from './$types';
import { remove } from '$lib/server/subscriptions';
export const DELETE: RequestHandler = async ({ params }) => {
  await remove(app(), params.id);
  return json({ ok: true });
};
