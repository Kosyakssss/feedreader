import { beforeEach, expect, test } from 'bun:test';
import type { Item } from '../src/parse';
import { createApp } from '../src/server';
import { scopes, Store } from '../src/store';

const BASE = 'http://reader.test';
let store: Store;
let app: Awaited<ReturnType<typeof createApp>>;
let opened = 0;

const item = (guid: string, published: number): Item => ({ guid, url: `https://example.com/${guid}`, title: `Post ${guid}`, text: '', body: '', published });
const pageText = async (path: string) => Bun.gunzipSync(new Uint8Array(await app.handle(new Request(BASE + path)).arrayBuffer()));
const page = async (path: string) => new TextDecoder().decode(await pageText(path));
const post = (path: string, currentUrl = `${BASE}/all`) => app.handle(new Request(BASE + path, { method: 'POST', headers: { 'HX-Current-URL': currentUrl } }));
const firstId = () => store.entries(scopes.unread)[0]!.id;

beforeEach(async () => {
  store = new Store(':memory:');
  store.addSource('rss', 'https://example.com/feed', 'Example');
  const feed = store.sources()[0]!;
  store.save(feed, { items: [item('backlog', Date.UTC(2026, 0, 1))] }, 0, 0);
  store.save(store.source(feed.id)!, { items: [item('fresh', Date.UTC(2026, 0, 2))] }, 0, 0);
  opened = 0;
  app = await createApp(store, () => opened++);
});

test('every page is served', async () => {
  for (const path of ['/', '/all', '/archive', '/bookmarks', '/feeds', '/feed/1']) expect(app.handle(new Request(BASE + path)).status).toBe(200);
});

test('Unread shows new posts but not the backlog', async () => {
  const html = await page('/');
  expect(html).toContain('Post fresh');
  expect(html).not.toContain('Post backlog');
});

test('a feed page includes the backlog', async () => {
  expect(await page('/feed/1')).toContain('Post backlog');
});

test('an unknown page is a 404', () => {
  expect(app.handle(new Request(`${BASE}/nope`)).status).toBe(404);
  expect(app.handle(new Request(`${BASE}/feed/999`)).status).toBe(404);
});

test('a page can be answered from the browser cache', () => {
  const first = app.handle(new Request(`${BASE}/all`));
  const etag = first.headers.get('etag')!;
  expect(app.handle(new Request(`${BASE}/all`, { headers: { 'If-None-Match': etag } })).status).toBe(304);
});

test('opening Unread wakes the feeds', () => {
  app.handle(new Request(`${BASE}/`));
  expect(opened).toBe(1);
});

test('text from a feed is escaped', async () => {
  const feed = store.sources()[0]!;
  store.save(feed, { items: [{ ...item('xss', Date.UTC(2026, 0, 3)), title: '<script>alert(1)</script>' }] }, 0, 0);
  app.rebuildEntries([feed.id]);
  const html = await page('/');
  expect(html).not.toContain('<script>alert(1)');
  expect(html).toContain('&lt;script&gt;');
});

test('links out of the app open in a new tab, links inside do not', async () => {
  const html = await page('/all');
  expect(html).toContain('href="https://example.com/fresh" target="_blank" rel="noopener"');
  expect(html).toMatch(/<a href="\/feed\/1">/);
  const results = await app.handle(new Request(`${BASE}/search?q=backlog`)).text();
  expect(results).toContain('href="https://example.com/backlog" target="_blank"');
});

test('there are no visible page headings', async () => {
  const html = await page('/all');
  expect(html).not.toMatch(/<h[1-6]/);
});

test('the app name opens the page list on every page', async () => {
  for (const path of ['/', '/all', '/feed/1']) expect(await page(path)).toMatch(/<button class="crumb" popovertarget="menu-0"/);
});

test('a page with nothing under it is plain text in the path', async () => {
  expect(await page('/bookmarks')).toContain('<span class="crumb" aria-current="page">Bookmarks</span>');
});

test('Feeds opens the list of feeds, on its own page and on a feed', async () => {
  store.addSource('rss', 'https://example.org/feed', 'Other');
  app = await createApp(store);
  for (const path of ['/feeds', '/feed/1']) {
    const html = await page(path);
    expect(html).toMatch(/<button class="crumb" popovertarget="menu-1"[^>]*>Feeds/);
    expect(html).toMatch(/<a href="\/feed\/2"[^>]*>Other/);
  }
});

test('saving replies with the updated row and rebuilds the pages', async () => {
  const response = post(`/bookmark/${firstId()}`);
  expect(await response.text()).toContain('Saved');
  expect(await page('/bookmarks')).toContain('Post fresh');
  expect(await page('/')).not.toContain('Post fresh');
});

test('saving on Unread takes the row off that page', async () => {
  const response = post(`/bookmark/${firstId()}`, `${BASE}/`);
  expect(await response.text()).toBe('');
});

test('removing a bookmark on Bookmarks takes the row off that page', async () => {
  const id = firstId();
  post(`/bookmark/${id}`);
  const response = post(`/bookmark/${id}`, `${BASE}/bookmarks`);
  expect(await response.text()).toBe('');
});

test('a form posted from another site is refused', () => {
  const response = app.handle(new Request(`${BASE}/bookmark/1`, { method: 'POST', headers: { Origin: 'https://evil.example' } }));
  expect(response.status).toBe(403);
});

test('mark all read empties Unread', async () => {
  const response = post(`/read-all/${firstId()}`, `${BASE}/`);
  expect(await response.text()).toContain('Nothing unread');
  expect(await page('/')).toContain('Nothing unread');
});

test('search returns entries as plain links, with no Save button', async () => {
  const body = await app.handle(new Request(`${BASE}/search?q=backlog`)).text();
  expect(body).toContain('Post backlog');
  expect(body).toContain('href="https://example.com/backlog"');
  expect(body).not.toContain('<button');
});

test('search with no match says so, an empty search shows nothing', async () => {
  expect(await app.handle(new Request(`${BASE}/search?q=zzzz`)).text()).toContain('Nothing found');
  expect(await app.handle(new Request(`${BASE}/search?q=`)).text()).toBe('');
});
