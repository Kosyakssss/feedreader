import { Database } from 'bun:sqlite';
import { beforeEach, expect, test } from 'bun:test';
import type { FetchResult } from '../src/lib/server/fetch';
import type { Item } from '../src/lib/server/parse';
import { scopes, Store, type Change, type Source } from '../src/lib/server/store';

let store: Store;
let feed: Source;
const JAN = Date.UTC(2026, 0, 1);

const item = (guid: string, overrides: Partial<Item> = {}): Item => ({
  guid,
  url: `https://example.com/${guid}`,
  title: `Post ${guid}`,
  text: '',
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
  expect(titles(scopes.timeline)).toEqual([]);
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

test('bookmarking something never seen makes it read, and taking the bookmark off leaves it read', () => {
  saveItems(item('a'));
  const id = store.entries(scopes.feed(feed.id))[0]!.id;
  expect(store.mark([id], { bookmarked: true })).toMatchObject([{ state: 'read', bookmarked: 1 }]);
  expect(titles(scopes.bookmarks)).toEqual(['Post a']);
  expect(store.mark([id], { bookmarked: false })).toMatchObject([{ state: 'read', bookmarked: 0 }]);
  expect(titles(scopes.bookmarks)).toEqual([]);
  expect(titles(scopes.timeline)).toEqual(['Post a']);
});

test('a bookmarked entry leaves Unread but stays unread, and comes back when the bookmark comes off', () => {
  saveItems(item('backlog'));
  saveItems(item('a', { published: JAN + 1000 }));
  const id = store.entries(scopes.unread)[0]!.id;
  expect(store.mark([id], { bookmarked: true })).toMatchObject([{ state: 'unread', bookmarked: 1 }]);
  expect(titles(scopes.unread)).toEqual([]);
  store.mark([id], { bookmarked: false });
  expect(titles(scopes.unread)).toEqual(['Post a']);
});

test('marking sets entries chosen together, whatever each was, and tells copies of the app which changed', () => {
  saveItems(item('backlog'));
  saveItems(item('a', { published: JAN + 1000 }), item('b', { published: JAN + 2000 }));
  const [b, a] = store.entries(scopes.unread).map((entry) => entry.id);
  store.mark([a!], { read: true });
  const changes: Change[] = [];
  store.onChange = (change) => changes.push(change);
  expect(store.mark([a!, b!, 999], { read: true }).map((entry) => entry.state)).toEqual(['read', 'read']);
  expect(changes).toEqual([{ entries: [a!, b!] }]);
  store.mark([a!, b!], { read: false });
  expect(titles(scopes.unread)).toEqual(['Post b', 'Post a']);
});

test("a feed's muted words keep matching entries out of Unread and the timeline, not off its own page", () => {
  saveItems(item('backlog'));
  saveItems(item('a', { title: 'Sponsored: buy this', published: JAN + 1000 }), item('b', { published: JAN + 2000 }));
  expect(store.setMutes(feed.id, [' SPONSORED ', 'sponsored', ''])).toEqual(['sponsored']);
  expect(titles(scopes.unread)).toEqual(['Post b']);
  expect(titles(scopes.timeline)).toEqual(['Post b']);
  expect(titles(scopes.feed(feed.id))).toContain('Sponsored: buy this');
});

test('a bookmarked link is stored once: an entry a feed already has is bookmarked instead', () => {
  saveItems(item('a'));
  expect(store.bookmarkPage('https://example.com/a', '')).toMatchObject({ title: 'Post a', bookmarked: 1, page: 0 });
  expect(store.bookmarkPage('https://elsewhere.example/x', 'Elsewhere')).toMatchObject({ bookmarked: 1, page: 1 });
  expect(titles(scopes.bookmarks).toSorted()).toEqual(['Elsewhere', 'Post a']);
  expect(store.sources().map((source) => source.label)).toEqual(['Example']);
});

test('removing a feed keeps its bookmarks as bookmarked pages', () => {
  saveItems(item('a'), item('b'));
  store.mark([store.entries(scopes.feed(feed.id))[0]!.id], { bookmarked: true });
  store.removeSource(feed.id);
  expect(store.sources()).toEqual([]);
  expect(store.entries(scopes.bookmarks)).toHaveLength(1);
  expect(store.entries(scopes.bookmarks)[0]!.page).toBe(1);
});

test('a database from before bookmarks were a flag of their own keeps every entry and bookmark', () => {
  const path = `${Bun.env.TMPDIR ?? '/tmp'}/lagan-migrate-${process.pid}.sqlite`;
  const old = new Database(path, { create: true });
  old.run(`CREATE TABLE sources (id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('rss', 'atproto')), ref TEXT NOT NULL UNIQUE, label TEXT NOT NULL, folder TEXT NOT NULL DEFAULT '', etag TEXT NOT NULL DEFAULT '', last_modified TEXT NOT NULL DEFAULT '', fetched_at INTEGER, next_at INTEGER, failures INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '') STRICT;
    CREATE TABLE entries (id INTEGER PRIMARY KEY, source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE, guid TEXT NOT NULL, url TEXT NOT NULL, published_at INTEGER NOT NULL, state TEXT NOT NULL CHECK (state IN ('none', 'unread', 'read', 'bookmarked')), title TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '') STRICT;
    CREATE INDEX timeline ON entries(published_at DESC, id DESC) WHERE state <> 'none';
    INSERT INTO sources (id, kind, ref, label) VALUES (1, 'rss', 'https://example.com/feed', 'Example');
    INSERT INTO entries (source_id, guid, url, published_at, state, title) VALUES (1, 'a', 'https://example.com/a', 1, 'bookmarked', 'Kept'), (1, 'b', 'https://example.com/b', 2, 'unread', 'New');`);
  old.close();
  try {
    const migrated = new Store(path);
    expect(migrated.entries(scopes.bookmarks)).toMatchObject([{ title: 'Kept', state: 'read', bookmarked: 1 }]);
    expect(migrated.entries(scopes.unread)).toMatchObject([{ title: 'New', bookmarked: 0 }]);
    expect(new Store(path).entries(scopes.timeline)).toHaveLength(2); // opening it again changes nothing
  } finally {
    for (const suffix of ['', '-wal', '-shm'])
      Bun.file(path + suffix)
        .delete()
        .catch(() => {});
  }
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
  saveItems(
    item('a', { title: 'Going places', published: JAN + 5000 }),
    item('b', { title: 'Why go', published: JAN }),
  );
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
  saveItems(
    item('a', { title: 'Same', url: 'https://one.example.com/post' }),
    item('copy', { title: 'Same', url: 'https://two.example.com/post' }),
  );
  store.mark([store.entries(scopes.feed(feed.id)).at(-1)!.id], { bookmarked: true });

  expect(store.mergeMoved()).toBe(1);
  expect(store.entries(scopes.feed(feed.id))).toMatchObject([
    { state: 'read', bookmarked: 1, url: 'https://two.example.com/post' },
  ]);
});

test('copies at different paths are different posts', () => {
  saveItems(
    item('a', { title: 'Links', url: 'https://example.com/one' }),
    item('b', { title: 'Links', url: 'https://example.com/two' }),
  );
  expect(store.mergeMoved()).toBe(0);
  expect(store.entries(scopes.feed(feed.id))).toHaveLength(2);
});
