import { error } from '@sveltejs/kit';
import { readOpml, sourceFor, writeOpml } from '#lib/server/opml.ts';
import type { RequestHandler } from './$types';

// Every feed followed, as a file other readers can import.
export const GET: RequestHandler = ({ locals }) =>
  new Response(writeOpml(locals.store.sources()), {
    headers: {
      'Content-Type': 'text/x-opml; charset=utf-8',
      'Content-Disposition': 'attachment; filename="lagan.opml"',
    },
  });

// Follows every feed in an OPML file that isn't followed already.
export const POST: RequestHandler = async ({ locals, request }) => {
  let listed;
  try {
    listed = readOpml(await request.text());
  } catch {
    error(400, 'That is not an OPML file');
  }
  const added = locals.store.addSources(listed.flatMap((feed) => (URL.canParse(feed.url) ? [sourceFor(feed)] : [])));
  for (const id of added) locals.follow(id);
  return Response.json({ found: listed.length, added: added.length });
};
