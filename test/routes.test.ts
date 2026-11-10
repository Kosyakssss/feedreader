import { beforeEach, expect, test } from 'bun:test';
import { isHttpError } from '@sveltejs/kit';
import type { Item } from '#lib/server/parse.ts';
import { scopes, Store } from '#lib/server/store.ts';
import { handle } from '../src/hooks.server';
import { POST as bookmark } from '../src/routes/api/bookmark/[id]/+server';
import { POST as readAll } from '../src/routes/api/read-all/[upto]/+server';
import { GET as search } from '../src/routes/api/search/+server';
import { load as feedPage } from '../src/routes/feed/[id]/+page.server';
import { load as unreadPage } from '../src/routes/+page.server';

let store: Store;
let woken = 0;

const item = (guid: string, published: number): Item => ({ guid, url: `https://example.com/${guid}`, title: `Post ${guid}`, text: '', published });
const titles = (entries: { title: string }[]) => entries.map((entry) => entry.title);

// Only what these handlers read from a request.
const event = (params: Record<string, string> = {}, url = 'http://lagan.test/') => ({ locals: { store, wake: () => woken++ }, params, url: new URL(url) }) as never;

function statusOf(run: () => unknown): number | undefined {
  try {
    run();
  } catch (error) {
    if (isHttpError(error)) return error.status;
    throw error;
  }
}

beforeEach(() => {
  store = new Store(':memory:');
  store.addSource('rss', 'https://example.com/feed', 'Example');
  const feed = store.sources()[0]!;
  store.save(feed, { items: [item('backlog', Date.UTC(2026, 0, 1))] }, 0, 0);
  store.save(store.source(feed.id)!, { items: [item('fresh', Date.UTC(2026, 0, 2))] }, 0, 0);
  woken = 0;
});

test('Unread shows new posts but not the backlog, and opening it wakes the feeds', () => {
  const data = unreadPage(event()) as { entries: { title: string }[] };
  expect(titles(data.entries)).toEqual(['Post fresh']);
  expect(woken).toBe(1);
});

test('a feed page includes the backlog, and an unknown feed is not found', () => {
  const data = feedPage(event({ id: '1' })) as { label: string; entries: { title: string }[] };
  expect(data.label).toBe('Example');
  expect(titles(data.entries)).toEqual(['Post fresh', 'Post backlog']);
  expect(statusOf(() => feedPage(event({ id: '999' })))).toBe(404);
  expect(statusOf(() => feedPage(event({ id: 'nope' })))).toBe(404);
});

test('bookmarking answers with the entry as it now is, and pressing again makes it read', async () => {
  const id = store.entries(scopes.unread)[0]!.id;
  expect((await (bookmark(event({ id: String(id) })) as Response).json()).state).toBe('bookmarked');
  expect(titles(store.entries(scopes.bookmarks))).toEqual(['Post fresh']);
  expect(store.entries(scopes.unread)).toEqual([]);
  expect((await (bookmark(event({ id: String(id) })) as Response).json()).state).toBe('read');
  expect(statusOf(() => bookmark(event({ id: '999' })))).toBe(404);
});

test('mark all read stops at the newest entry the page showed', () => {
  const shown = store.entries(scopes.unread)[0]!.id;
  store.save(store.sources()[0]!, { items: [item('later', Date.UTC(2026, 0, 3))] }, 0, 0);
  expect((readAll(event({ upto: String(shown) })) as Response).status).toBe(204);
  expect(titles(store.entries(scopes.unread))).toEqual(['Post later']);
});

test('search finds feeds and entries in any state, and an empty search finds nothing', async () => {
  const found = await (search(event({}, 'http://lagan.test/api/search?q=backlog')) as Response).json();
  expect(titles(found.entries)).toEqual(['Post backlog']);
  const feeds = await (search(event({}, 'http://lagan.test/api/search?q=exam')) as Response).json();
  expect(feeds.feeds).toEqual([{ id: 1, label: 'Example' }]);
  expect(await (search(event({}, 'http://lagan.test/api/search?q=%20')) as Response).json()).toEqual({ feeds: [], entries: [] });
});

test('a change posted from another site is refused before it reaches the app', async () => {
  const request = new Request('http://lagan.test/api/bookmark/1', { method: 'POST', headers: { 'Sec-Fetch-Site': 'cross-site' } });
  const response = await handle({ event: { request } as never, resolve: () => Promise.reject(new Error('reached the app')) });
  expect(response.status).toBe(403);
});
