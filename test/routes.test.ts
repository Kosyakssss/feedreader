import { beforeEach, expect, test } from 'bun:test';
import { isHttpError } from '@sveltejs/kit';
import type { Item } from '#lib/server/parse.ts';
import { Live } from '#lib/server/live.ts';
import { scopes, Store } from '#lib/server/store.ts';
import { handle } from '../src/hooks.server';
import { POST as mark } from '../src/routes/api/mark/+server';
import { GET as timeline } from '../src/routes/api/timeline/+server';
import { DELETE as removeFeed } from '../src/routes/api/feeds/[id]/+server';
import { PUT as setMutes } from '../src/routes/api/feeds/[id]/mutes/+server';
import { GET as search } from '../src/routes/api/search/+server';
import { GET as list } from '../src/routes/api/list/+server';

let store: Store;
let woken = 0;

const item = (guid: string, published: number): Item => ({
  guid,
  url: `https://example.com/${guid}`,
  title: `Post ${guid}`,
  text: '',
  published,
});
const titles = (entries: { title: string }[]) => entries.map((entry) => entry.title);

// Only what these handlers read from a request.
const event = (params: Record<string, string> = {}, url = 'http://lagan.test/', body?: unknown) =>
  ({
    locals: { store, wake: () => woken++, follow: () => {} },
    params,
    url: new URL(url),
    request: new Request(url, { method: 'PUT', body: JSON.stringify(body ?? null) }),
  }) as never;

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

test('Unread shows new posts but not the backlog, and opening it wakes the feeds', async () => {
  const data = (await (await list(event({}, 'http://lagan.test/api/list?of=unread'))).json()) as {
    entries: { title: string }[];
  };
  expect(titles(data.entries)).toEqual(['Post fresh']);
  expect(woken).toBe(1);
});

test('a feed page includes the backlog, and an unknown feed is not found', async () => {
  const data = (await (await list(event({}, 'http://lagan.test/api/list?feed=1'))).json()) as {
    label: string;
    entries: { title: string }[];
  };
  expect(data.label).toBe('Example');
  expect(titles(data.entries)).toEqual(['Post fresh', 'Post backlog']);
  expect(statusOf(() => list(event({}, 'http://lagan.test/api/list?feed=999')))).toBe(404);
  expect(statusOf(() => list(event({}, 'http://lagan.test/api/list?feed=nope')))).toBe(404);
});

test('marking answers with the entries as they now are, and refuses anything but ids and flags', async () => {
  const id = store.entries(scopes.unread)[0]!.id;
  const live = new Live(store);
  const post = (body: unknown) =>
    mark({
      locals: { store, live },
      request: new Request('http://lagan.test/api/mark', { method: 'POST', body: JSON.stringify(body) }),
    } as never);
  expect(await (await post({ ids: [id], read: true })).json()).toEqual({
    version: live.version, // the number the live stream gave the change
    entries: [expect.objectContaining({ state: 'read', bookmarked: 0 })],
  });
  expect(store.entries(scopes.unread)).toEqual([]);
  expect(await (await post({ ids: [id, 999], bookmarked: true })).json()).toMatchObject({
    entries: [{ id, bookmarked: 1 }],
  });
  for (const bad of [
    { ids: [id] },
    { ids: 'all', read: true },
    { ids: [1.5], read: true },
    { ids: [id], read: 'yes' },
    null,
  ])
    await expect(post(bad)).rejects.toMatchObject({ status: 400 });
});

test('the timeline goes on after the last entry shown, and a bad cursor is refused', async () => {
  const [newest] = store.entries(scopes.timeline);
  const after = `${newest!.published_at}:${newest!.id}`;
  const page = await (timeline(event({}, `http://lagan.test/api/timeline?after=${after}`)) as Response).json();
  expect(page).toEqual({ entries: [], more: false });
  expect(statusOf(() => timeline(event({}, 'http://lagan.test/api/timeline?after=soon')))).toBe(400);
});

test('search finds feeds and entries in any state, and an empty search finds nothing', async () => {
  const found = await (search(event({}, 'http://lagan.test/api/search?q=backlog')) as Response).json();
  expect(titles(found.entries)).toEqual(['Post backlog']);
  const feeds = await (search(event({}, 'http://lagan.test/api/search?q=exam')) as Response).json();
  expect(feeds.feeds).toEqual([{ id: 1, label: 'Example' }]);
  expect(await (search(event({}, 'http://lagan.test/api/search?q=%20')) as Response).json()).toEqual({
    feeds: [],
    entries: [],
  });
});

test('a change posted from another site is refused before it reaches the app', async () => {
  const request = new Request('http://lagan.test/api/mark', {
    method: 'POST',
    headers: { 'Sec-Fetch-Site': 'cross-site' },
  });
  const response = await handle({
    event: { request } as never,
    resolve: () => Promise.reject(new Error('reached the app')),
  });
  expect(response.status).toBe(403);
});

test("a feed's muted words are saved cleaned up, and only as a list of words", async () => {
  const saved = await (await setMutes(event({ id: '1' }, undefined, { words: [' Sponsored', 'ad ', ''] }))).json();
  expect(saved).toEqual({ words: ['ad', 'sponsored'] });
  await expect(setMutes(event({ id: '1' }, undefined, { words: 'ad' }))).rejects.toMatchObject({ status: 400 });
  await expect(setMutes(event({ id: '9' }, undefined, { words: [] }))).rejects.toMatchObject({ status: 404 });
});

test('removing a feed takes it and its entries away', () => {
  expect((removeFeed(event({ id: '1' })) as Response).status).toBe(204);
  expect(store.sources()).toEqual([]);
  expect(store.entries(scopes.timeline)).toEqual([]);
  expect(statusOf(() => removeFeed(event({ id: '1' })))).toBe(404);
});
