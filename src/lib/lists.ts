// A page's list from the server, for while the library is still on its way.
// Once it has arrived, a page asks nothing: it shows the library.
import { browser } from '$app/env';
import { error } from '@sveltejs/kit';
import { library } from '#lib/library.svelte.ts';

type Fetch = typeof fetch;

export async function fromServer<T>(fetch: Fetch, query: string): Promise<T | null> {
  if (browser && library.ready) return null;
  const response = await fetch(`/api/list?${query}`);
  if (response.status === 404) error(404, 'Not found');
  if (!response.ok) error(response.status, 'Could not load this page');
  return (await response.json()) as T;
}
