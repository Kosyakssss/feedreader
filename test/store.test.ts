import { Database } from 'bun:sqlite';
import { beforeEach, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FetchResult } from '../src/fetch';
import type { Item } from '../src/parse';
import { scopes, Store, type Source } from '../src/store';

let store: Store;
let feed: Source;
const JAN = Date.UTC(2026, 0, 1);

const item = (guid: string, overrides: Partial<Item> = {}): Item => ({
  guid,
  url: `https://example.com/${guid}`,
  title: `Post ${guid}`,
  text: '',
  body: '',
  published: JAN,
  ...overrides,
});
const result = (...items: Item[]): FetchResult => ({ items });
const refresh = () => (feed = store.source(feed.id)!);
const saveItems = (...items: Item[]) => {
  const changed = store.save(feed, result(...items), 0, 0);
  refresh();
  return changed;
};
const titles = (scope: Parameters<Store['entries']>[0]) => store.entries(scope).map((entry) => entry.title);

beforeEach(() => {
  store = new Store(':memory:');
  store.addSource('rss', 'https://example.com/feed', 'Example');
  feed = store.sources()[0]!;
});

test("a feed's first fetch is backlog, later posts are unread", () => {
  saveItems(item('old'));
  expect(titles(scopes.unread)).toEqual([]);
  expect(titles(scopes.all)).toEqual([]);
  expect(titles(scopes.feed(feed.id))).toEqual(['Post old']);

  saveItems(item('new', { published: JAN + 1000 }));
  expect(titles(scopes.unread)).toEqual(['Post new']);
});

test('fetching the same item twice changes nothing', () => {
  saveItems(item('a'));
  expect(saveItems(item('a'))).toBe(0);
  expect(store.entries(scopes.feed(feed.id))).toHaveLength(1);
});

test('a post whose id changed is updated, not duplicated', () => {
  saveItems(item('a', { title: 'Same', url: 'https://old.example.com/a' }));
  saveItems(item('b', { title: 'Same', url: 'https://new.example.com/a' }));
  const [entry, ...rest] = store.entries(scopes.feed(feed.id));
  expect(rest).toEqual([]);
  expect(entry!.url).toBe('https://new.example.com/a');
});

test('two posts with the same title and date in one fetch are both kept', () => {
  saveItems(item('a', { title: 'Links' }), item('b', { title: 'Links' }));
  expect(store.entries(scopes.feed(feed.id))).toHaveLength(2);
});

test('impossible dates fall back to now', () => {
  const before = Date.now();
  saveItems(item('a', { published: Date.now() + 10 * 86_400_000 }));
  expect(store.entries(scopes.feed(feed.id))[0]!.published_at).toBeGreaterThanOrEqual(before);
  expect(store.entries(scopes.feed(feed.id))[0]!.published_at).toBeLessThanOrEqual(Date.now());
});

test('a feed where every item has the same date uses the fetch time', () => {
  const before = Date.now();
  saveItems(item('a'), item('b'), item('c'), item('d'));
  for (const entry of store.entries(scopes.feed(feed.id))) expect(entry.published_at).toBeGreaterThanOrEqual(before);
});

test('a next-fetch time with a fraction of a millisecond still saves', () => {
  expect(() => store.save(feed, result(), 0, Date.now() + 1234.5)).not.toThrow();
  expect(Number.isInteger(store.source(feed.id)!.next_at)).toBe(true);
});

test('a failed fetch keeps the old validators', () => {
  store.save(feed, { items: [], etag: 'one', lastModified: 'then' }, 0, 0);
  refresh();
  store.save(feed, { items: [], error: 'HTTP 500' }, 1, 0);
  refresh();
  expect(feed).toMatchObject({ etag: 'one', last_modified: 'then', error: 'HTTP 500', failures: 1 });
});

test('bookmarking from any state, and removing it gives read', () => {
  saveItems(item('a'));
  const id = store.entries(scopes.feed(feed.id))[0]!.id;
  expect(store.toggleBookmark(id)!.state).toBe('bookmarked');
  expect(titles(scopes.bookmarks)).toEqual(['Post a']);
  expect(store.toggleBookmark(id)!.state).toBe('read');
  expect(titles(scopes.bookmarks)).toEqual([]);
  expect(titles(scopes.all)).toEqual(['Post a']);
});

test('mark all read leaves anything newer than the page unread', () => {
  saveItems(item('backlog'));
  saveItems(item('a', { published: JAN + 1000 }));
  const newest = store.entries(scopes.unread)[0]!.id;
  saveItems(item('b', { published: JAN + 2000 }));
  expect(store.readAll(newest)).toEqual([feed.id]);
  expect(titles(scopes.unread)).toEqual(['Post b']);
});

test('search finds titles in every state, not body text', () => {
  saveItems(item('a', { title: 'Neovim tricks' }), item('b', { title: 'Other', text: 'neovim in the body' }));
  expect(store.searchEntries('neovim').map((entry) => entry.title)).toEqual(['Neovim tricks']);
});

test('search matches whole words, except the word still being typed', () => {
  saveItems(item('a', { title: 'Trust the process' }), item('b', { title: 'Rust notes' }));
  expect(store.searchEntries('rust').map((entry) => entry.title)).toEqual(['Rust notes']);
  expect(store.searchEntries('ru').map((entry) => entry.title)).toEqual(['Rust notes']);
  expect(store.searchEntries('ru notes')).toEqual([]);
});

test('search puts exact matches before partial ones', () => {
  saveItems(item('a', { title: 'Going places', published: JAN + 5000 }), item('b', { title: 'Why go', published: JAN }));
  expect(store.searchEntries('go').map((entry) => entry.title)).toEqual(['Why go', 'Going places']);
});

test('an untitled entry is searched by the text it shows', () => {
  saveItems(item('a', { title: '', text: 'A short microblog post' }));
  expect(store.searchEntries('microblog')).toHaveLength(1);
});

test('feeds match by name before address', () => {
  store.addSource('rss', 'https://blog.example.org/feed', 'Zeta');
  store.addSource('rss', 'https://x.example.org/feed', 'My blog');
  expect(store.searchFeeds('blog').map((source) => source.label)).toEqual(['My blog', 'Zeta']);
});

test('copies left by a moved site merge and keep the strongest state', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'feedreader-')), 'test.sqlite');
  const onDisk = new Store(file);
  onDisk.addSource('rss', 'https://example.com/feed', 'Example');
  const source = onDisk.sources()[0]!;
  onDisk.save(source, result(item('a', { title: 'Same', url: 'https://one.example.com/post' })), 0, 0);
  onDisk.toggleBookmark(onDisk.entries(scopes.feed(source.id))[0]!.id);

  const raw = new Database(file);
  raw.run(`INSERT INTO entries (source_id, guid, url, published_at, state, title) VALUES (?, 'copy', 'https://two.example.com/post', ?, 'none', 'Same')`, [source.id, JAN]);
  raw.close();

  expect(onDisk.mergeMoved()).toBe(1);
  expect(onDisk.entries(scopes.feed(source.id))).toMatchObject([{ state: 'bookmarked', url: 'https://two.example.com/post' }]);
  onDisk.close();
});

test('copies at different paths are different posts', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'feedreader-')), 'test.sqlite');
  const onDisk = new Store(file);
  onDisk.addSource('rss', 'https://example.com/feed', 'Example');
  const source = onDisk.sources()[0]!;
  onDisk.save(source, result(item('a', { title: 'Links', url: 'https://example.com/one' }), item('b', { title: 'Links', url: 'https://example.com/two' })), 0, 0);
  expect(onDisk.mergeMoved()).toBe(0);
  expect(onDisk.entries(scopes.feed(source.id))).toHaveLength(2);
  onDisk.close();
});
