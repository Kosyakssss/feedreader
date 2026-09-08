import { app } from '$lib/server/app';
import type { RequestHandler } from './$types';
import { exportOPML } from '$lib/server/subscriptions';
export const GET: RequestHandler = async () =>
  new Response(await exportOPML(app()), {
    headers: {
      'content-type': 'text/xml; charset=utf-8',
      'content-disposition': 'attachment; filename="feedreader.opml"',
    },
  });
