import { error } from '@sveltejs/kit';
import { findFeeds } from '#lib/server/sites.ts';
import type { RequestHandler } from './$types';

// The feeds the site of `url` offers, and whether each is followed already.
export const GET: RequestHandler = async ({ locals, url }) => {
  const page = url.searchParams.get('url');
  if (!page) error(400, 'Bad request');
  const followed = new Set(locals.store.sources().map((source) => source.ref));
  try {
    const feeds = await findFeeds(page);
    return Response.json({ feeds: feeds.map((feed) => ({ ...feed, followed: followed.has(feed.url) })) });
  } catch (reason) {
    return Response.json({ feeds: [], error: reason instanceof Error ? reason.message : String(reason) });
  }
};
