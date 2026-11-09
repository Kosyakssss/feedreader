// Answers requests. Pages are built ahead of time and kept in memory.
import { entryList, feedList, layout, row, searchResults, unreadSection, type Html } from './pages';
import { scopes, type Entry, type Scope, type Store } from './store';

const WEB = new URL('../web/', import.meta.url).pathname;
const HTML = 'text/html; charset=utf-8';
const IMMUTABLE = 'public, max-age=31536000, immutable';

type Built = { body: Uint8Array<ArrayBuffer>; etag: string };
type Asset = { body: Uint8Array<ArrayBuffer>; type: string };

const pack = (text: string): Built => ({ body: Bun.gzipSync(text), etag: `"${Bun.hash(text).toString(16)}"` });
const gzip = { 'Content-Encoding': 'gzip' };

const newest = (entries: Entry[]) => entries.reduce((most, entry) => Math.max(most, entry.id), 0);

async function loadAssets() {
  const bundle = await Bun.build({ entrypoints: [`${WEB}js/titles.ts`], format: 'iife', minify: true, target: 'browser' });
  if (!bundle.success) throw new AggregateError(bundle.logs, 'Could not build titles.ts');
  const titles = await bundle.outputs[0]!.text();
  const style = await Bun.file(`${WEB}style.css`).text();
  const htmx = await Bun.file(`${WEB}js/htmx.min.js`).text();
  const assets = new Map<string, Asset>([
    ['/style.css', { body: Bun.gzipSync(style), type: 'text/css; charset=utf-8' }],
    ['/js/titles.js', { body: Bun.gzipSync(titles), type: 'text/javascript; charset=utf-8' }],
    ['/js/htmx.min.js', { body: Bun.gzipSync(htmx), type: 'text/javascript; charset=utf-8' }],
  ]);
  return { assets, version: Bun.hash(style + titles).toString(16).slice(0, 8) };
}

// A page loaded from another site must not be able to change anything here.
function sameOrigin(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site');
  if (site) return site === 'same-origin' || site === 'none';
  const origin = request.headers.get('origin');
  return !origin || new URL(origin).host === new URL(request.url).host;
}

const ENTRY_PAGES: Record<string, { title: string; scope: Scope }> = {
  '/': { title: 'Unread', scope: scopes.unread },
  '/all': { title: 'All', scope: scopes.all },
  '/archive': { title: 'Archive', scope: scopes.archive },
  '/bookmarks': { title: 'Bookmarks', scope: scopes.bookmarks },
};
const feedPath = (id: number) => `/feed/${id}`;

export async function createApp(store: Store, onOpen: () => void = () => {}) {
  const { assets, version } = await loadAssets();
  const pages = new Map<string, Built>();

  // Renders one page. Returns null for a path that isn't a page.
  function renderPage(path: string): string | null {
    const feeds = store.sources();
    const page = (title: string, content: Html) => layout({ title, path, version, content, feeds });
    const known = ENTRY_PAGES[path];
    if (known) {
      const entries = store.entries(known.scope);
      return page(known.title, path === '/' ? unreadSection(entries, newest(entries)) : entryList(entries));
    }
    if (path === '/feeds') return page('Feeds', feedList(feeds));
    const id = Number(path.slice('/feed/'.length));
    const source = path.startsWith('/feed/') && Number.isInteger(id) ? store.source(id) : null;
    return source && page(source.label, entryList(store.entries(scopes.feed(id))));
  }

  function build(paths: string[]): void {
    for (const path of paths) {
      const page = renderPage(path);
      if (page) pages.set(path, pack(page));
    }
  }

  const rebuildEntries = (feeds: number[]) => build([...Object.keys(ENTRY_PAGES), ...feeds.map(feedPath)]);
  const buildAll = () => build([...Object.keys(ENTRY_PAGES), '/feeds', ...store.sources().map((source) => feedPath(source.id))]);

  function servePage(request: Request, path: string): Response {
    const page = pages.get(path);
    if (!page) return new Response('Not found', { status: 404 });
    const headers = { 'Content-Type': HTML, 'Cache-Control': 'no-cache', ETag: page.etag, Vary: 'Accept-Encoding' };
    if (request.headers.get('if-none-match') === page.etag) return new Response(null, { status: 304, headers });
    return new Response(page.body, { headers: { ...headers, ...gzip } });
  }

  const fragment = (text: string) => new Response(text, { headers: { 'Content-Type': HTML, 'Cache-Control': 'no-store' } });

  function search(url: URL): Response {
    const query = url.searchParams.get('q')?.trim() ?? '';
    return fragment(query ? searchResults(store.searchFeeds(query), store.searchEntries(query)).value : '');
  }

  function bookmark(request: Request, id: number): Response {
    const entry = store.toggleBookmark(id);
    if (!entry) return new Response('No such entry', { status: 404 });
    rebuildEntries([entry.source_id]);
    const page = new URL(request.headers.get('hx-current-url') ?? request.url).pathname;
    const leaves = page === '/' || (page === '/bookmarks' && entry.state !== 'bookmarked');
    return fragment(leaves ? '' : row(entry).value);
  }

  function readAll(upto: number): Response {
    rebuildEntries(store.readAll(upto));
    return fragment('<p>Nothing unread.</p>');
  }

  function handle(request: Request): Response {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'POST') {
      if (!sameOrigin(request)) return new Response('Forbidden', { status: 403 });
      const [, action, value] = path.split('/');
      const number = Number(value);
      if (!Number.isInteger(number)) return new Response('Bad request', { status: 400 });
      if (action === 'bookmark') return bookmark(request, number);
      if (action === 'read-all') return readAll(number);
      return new Response('Not found', { status: 404 });
    }
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });

    const asset = assets.get(path);
    if (asset) return new Response(asset.body, { headers: { 'Content-Type': asset.type, 'Cache-Control': IMMUTABLE, Vary: 'Accept-Encoding', ...gzip } });
    if (path === '/search') return search(url);
    if (path === '/') onOpen();
    return servePage(request, path);
  }

  buildAll();
  return { handle, rebuildEntries, buildFeedsPage: () => build(['/feeds']) };
}
