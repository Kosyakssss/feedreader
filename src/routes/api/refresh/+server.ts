import { json, error } from '@sveltejs/kit';
import { app } from '$lib/server/app';
import type { RequestHandler } from './$types';
import { body, record } from '$lib/server/http';
export const POST: RequestHandler = async ({ request }) => {
  let ids: string[] | undefined;
  if (request.headers.get('content-type')?.startsWith('application/json')) {
    const value = await body(request);
    if (
      !record(value) ||
      !Array.isArray(value.feedIds) ||
      !value.feedIds.every((id) => typeof id === 'string')
    )
      error(400, 'Invalid refresh payload');
    ids = value.feedIds;
  }
  void app()
    .refresh.start(ids)
    .catch(() => undefined);
  return json(app().refresh.status(), { status: 202 });
};
