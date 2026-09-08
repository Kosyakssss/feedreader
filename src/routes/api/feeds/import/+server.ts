import { json, error } from '@sveltejs/kit';
import { app } from '$lib/server/app';
import type { RequestHandler } from './$types';
import { importOPML } from '$lib/server/subscriptions';
export const POST: RequestHandler = async ({ request }) => {
  let text: string;
  if (request.headers.get('content-type')?.startsWith('multipart/form-data')) {
    try {
      const file = (await request.formData()).get('file');
      if (!(file instanceof File)) error(400, 'Missing OPML file');
      text = await file.text();
    } catch {
      error(400, 'Invalid OPML upload');
    }
  } else text = await request.text();
  return json(await importOPML(app(), text));
};
