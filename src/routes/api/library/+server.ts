import type { RequestHandler } from './$types';

// The whole library, numbered with the last change it includes. The app
// starting is the moment to check for news.
export const GET: RequestHandler = ({ locals }) => {
  locals.wake();
  return Response.json(locals.live.library());
};
