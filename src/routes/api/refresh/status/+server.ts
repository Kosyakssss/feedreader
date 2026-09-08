import { json } from '@sveltejs/kit';
import { app } from '$lib/server/app';
import type { RequestHandler } from './$types';
import { cursor } from '$lib/server/http';
export const GET: RequestHandler = ({ url }) =>
  json(
    app().refresh.status(cursor(url.searchParams.get('since')), cursor(url.searchParams.get('feedsSince'))),
  );
