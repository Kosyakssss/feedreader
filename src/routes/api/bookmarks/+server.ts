import { error } from '@sveltejs/kit';
import { linksIn } from '#lib/links.ts';
import { pageTitle } from '#lib/server/sites.ts';
import type { RequestHandler } from './$types';

const MOST = 100;

// Bookmarks every link in the text, each with its page's title. Answers with
// the bookmarks as they now are.
export const POST: RequestHandler = async ({ locals, request }) => {
  const { text } = (await request.json().catch(() => ({}))) as { text?: unknown };
  if (typeof text !== 'string') error(400, 'Bad request');
  const links = linksIn(text).slice(0, MOST);
  const titles = await Promise.all(links.map(pageTitle));
  return Response.json({ entries: links.map((url, index) => locals.store.bookmarkPage(url, titles[index]!)) });
};
