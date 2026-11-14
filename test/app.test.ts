import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Item } from '#lib/server/parse.ts';
import { scopes, Store } from '#lib/server/store.ts';
import { app } from '../src/app';

let store: Store;
let server: ReturnType<typeof Bun.serve>;
let woken = 0;

const item = (guid: string, published: number, title = `Post ${guid}`): Item => ({
  guid,
  url: `https://example.com/${guid}`,
  title,
  text: '',
  published,
});

const at = (path: string) => new URL(`/lagan${path}`, server.url).href;
const get = (path: string, headers: Record<string, string> = {}) => fetch(at(path), { headers });
const post = (path: string, form: Record<string, string>, headers: Record<string, string> = {}) =>
  fetch(at(path), {
    method: 'POST',
    body: new URLSearchParams(form),
    headers: { 'Sec-Fetch-Site': 'same-origin', ...headers },
    redirect: 'manual',
  });
const fresh = () => store.entries(scopes.latest).find((entry) => entry.title === 'Post fresh')!;

beforeEach(() => {
  store = new Store(':memory:');
  store.addSource('rss', 'https://example.com/feed', 'Example');
  const feed = store.sources()[0]!;
  store.save(feed, { items: [item('backlog', Date.UTC(2026, 0, 1))] }, 0, 0);
  store.save(
    store.source(feed.id)!,
    { items: [item('fresh', Date.UTC(2026, 0, 2)), item('sly', Date.UTC(2026, 0, 3), '<script>alert(1)</script>')] },
    0,
    0,
  );
  woken = 0;
  server = Bun.serve({ port: 0, ...app({ store, wake: () => woken++, follow: () => {} }, '/lagan') });
});

afterEach(() => server.stop(true));

test('the home page lists new posts, read or not, but not the backlog, and opening it wakes the feeds', async () => {
  store.mark([fresh().id], { read: true });
  const page = await (await get('/')).text();
  expect(page).toContain('Post fresh');
  expect(page).not.toContain('Post backlog');
  expect(woken).toBe(1);
});

test('a page is whole by itself: its CSS inside, its one script deferred, and gzipped for browsers', async () => {
  const response = await get('/', { 'Accept-Encoding': 'gzip' });
  expect(response.headers.get('content-encoding')).toBe('gzip');
  const page = await response.text();
  expect(page).toContain('<style>');
  expect(page).not.toContain('rel="stylesheet"');
  const scripts = [...page.matchAll(/<script[^>]*src=[^>]*>/g)].map(([tag]) => tag);
  expect(scripts).toHaveLength(1);
  expect(scripts[0]).toContain('defer');
  const htmx = await fetch(new URL(scripts[0]!.match(/src="([^"]+)"/)![1]!, server.url));
  expect(htmx.headers.get('cache-control')).toContain('immutable');
});

test('titles are escaped, not run', async () => {
  const page = await (await get('/')).text();
  expect(page).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  expect(page).not.toContain('<script>alert(1)');
});

test('keep, as a plain form, goes back to the entry on the page it was pressed on', async () => {
  const id = fresh().id;
  const response = await post('/keep', { id: String(id), keep: '1' }, { Referer: at('/search?q=fresh') });
  expect(response.status).toBe(303);
  expect(response.headers.get('location')).toBe(`/lagan/search?q=fresh#e${id}`);
  expect(fresh().bookmarked).toBe(1);
  const elsewhere = await post('/keep', { id: String(id), keep: '0' }, { Referer: 'https://elsewhere.example/x' });
  expect(elsewhere.headers.get('location')).toBe(`/lagan/#e${id}`);
  expect(fresh().bookmarked).toBe(0);
});

test('keep sent by htmx answers with the form turned over and the count in the header, and an unknown entry is not found', async () => {
  const id = fresh().id;
  const form = await (await post('/keep', { id: String(id), keep: '1' }, { 'HX-Request': 'true' })).text();
  expect(form).toContain('aria-pressed="true"');
  expect(form).toContain('name="keep" value="0"');
  expect(form).toMatch(/id="kept-count"[^>]*hx-swap-oob="true"[^>]*>\s*1 kept/);
  expect((await post('/keep', { id: '999', keep: '1' })).status).toBe(404);
});

test('a change posted from another site is refused', async () => {
  const response = await post('/keep', { id: String(fresh().id), keep: '1' }, { 'Sec-Fetch-Site': 'cross-site' });
  expect(response.status).toBe(403);
  expect(fresh().bookmarked).toBe(0);
});

test("a feed's page has its backlog too, and its muted words are saved cleaned up", async () => {
  const page = await (await get('/feed/1')).text();
  expect(page).toContain('Post backlog');
  const saved = await post('/feed/1/mutes', { mutes: ' Sponsored, ad ,,' });
  expect(saved.headers.get('location')).toBe('/lagan/feed/1');
  expect(store.mutes(1)).toEqual(['ad', 'sponsored']);
  expect((await get('/feed/999')).status).toBe(404);
  expect((await get('/feed/nope')).status).toBe(404);
});

test('stopping following a feed takes it and its entries away, but keeps what was kept', async () => {
  store.mark([fresh().id], { bookmarked: true });
  expect((await post('/feed/1/remove', {})).status).toBe(303);
  expect(store.sources()).toEqual([]);
  expect(store.entries(scopes.bookmarks).map((entry) => entry.title)).toEqual(['Post fresh']);
  expect((await post('/feed/1/remove', {})).status).toBe(404);
});

test('search finds feeds and entries in any state, and an empty search lists nothing', async () => {
  expect(await (await get('/search?q=backlog')).text()).toContain('Post backlog');
  expect(await (await get('/search?q=exam')).text()).toContain('href="/lagan/feed/1"');
  expect(await (await get('/search?q=%20')).text()).not.toContain('Post');
});

test('the app lives under its path: the bare path leads into it, and anything else is not found', async () => {
  const bare = await fetch(new URL('/lagan', server.url), { redirect: 'manual' });
  expect(bare.headers.get('location')).toBe('/lagan/');
  expect((await fetch(new URL('/elsewhere', server.url))).status).toBe(404);
});

test('what a feed cuts is taken out of its titles everywhere they are shown', async () => {
  expect((await post('/feed/1/cuts', { cuts: 'post , ' })).headers.get('location')).toBe('/lagan/feed/1');
  expect(store.cuts(1)).toEqual(['post']);
  const page = await (await get('/')).text();
  expect(page).toContain('>fresh</a>');
  expect(page).not.toContain('Post fresh');
});

test('stopping following asks first, in place for htmx and as the page without it', async () => {
  const asked = await (await get('/feed/1/stop?sure')).text();
  expect(asked).toContain('action="/lagan/feed/1/remove"');
  expect(await (await get('/feed/1/stop')).text()).not.toContain('/remove');
  expect(await (await get('/feed/1?stop')).text()).toContain('action="/lagan/feed/1/remove"');
  expect(await (await get('/feed/1')).text()).not.toContain('action="/lagan/feed/1/remove"');
});

test('search sent by htmx answers with just what it found', async () => {
  const found = await (await get('/search?q=backlog', { 'HX-Request': 'true' })).text();
  expect(found).toContain('Post backlog');
  expect(found).not.toContain('<header');
});
