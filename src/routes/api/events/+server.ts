import { app } from '$lib/server/app';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = ({ request, platform }) => {
  if (platform) platform.server.timeout(platform.request, 0);
  return app().events.response(request.signal);
};
