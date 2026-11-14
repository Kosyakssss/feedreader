// What each address does. Pages are read with GET; a change is a form posted,
// answered by sending the browser back to a page, so reloading never posts
// it again. The one exception is keep sent by htmx, answered with the form
// it replaces.
import { linksIn } from '#lib/links.ts';
import { discover } from '#lib/server/fetch.ts';
import type { Lagan } from '#lib/server/lagan.ts';
import { readOpml, sourceFor, writeOpml } from '#lib/server/opml.ts';
import { findFeeds, pageTitle } from '#lib/server/sites.ts';
import { scopes } from '#lib/server/store.ts';
import type { Html } from '#lib/html.ts';
import { pages, type Found } from './pages';

type Handler = (request: Bun.BunRequest) => Response | Promise<Response>;

const MOST_LINKS = 100;

// htmx, named by what is in it, so that browsers can keep it for good.
const htmx = await Bun.file(Bun.resolveSync('htmx.org/dist/htmx.min.js', import.meta.dir)).text();
const htmxName = `/htmx.${Bun.hash(htmx).toString(36)}.js`;

// A page on another site must not be able to change anything here.
export function sameOrigin(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site');
  if (site) return site === 'same-origin' || site === 'none';
  const origin = request.headers.get('origin');
  return !origin || URL.parse(origin)?.host === new URL(request.url).host;
}

// Pages go out gzipped, small enough to arrive in the connection's first round trip.
function compressed(request: Request, response: Response): Response {
  const type = response.headers.get('content-type') ?? '';
  const accepts = /\bgzip\b/.test(request.headers.get('accept-encoding') ?? '');
  if (!/^text\/|javascript/.test(type) || !accepts || !response.body) return response;
  const headers = new Headers(response.headers);
  headers.set('content-encoding', 'gzip');
  headers.delete('content-length');
  headers.append('vary', 'accept-encoding');
  return new Response(response.body.pipeThrough(new CompressionStream('gzip')), { status: response.status, headers });
}

const guarded =
  (handler: Handler): Handler =>
  async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD' && !sameOrigin(request))
      return new Response('Forbidden', { status: 403 });
    return compressed(request, await handler(request));
  };

const sent = (page: Html, status = 200) =>
  new Response(page.text, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });

// Back to a page after a change, saying how it went.
const see = (location: string) => new Response(null, { status: 303, headers: { Location: location } });
const saying = (path: string, said: string, more = '') => `${path}?said=${encodeURIComponent(said)}${more}`;

const text = (form: FormData, name: string) => String(form.get(name) ?? '').trim();
const reason = (thrown: unknown) => (thrown instanceof Error ? thrown.message : String(thrown));

// The app, served under `base`: '' or a path such as '/lagan'.
export function app({ store, wake, follow }: Lagan, base = '') {
  const at = (path: string) => base + path;
  const views = pages(base, at(htmxName));
  const counts = () => ({ kept: store.entries(scopes.bookmarks).length, feeds: store.sources().length });
  const missing = () => sent(views.missing(counts()), 404);
  const sourceOf = (request: Bun.BunRequest) => {
    const id = Number((request.params as { id?: string }).id);
    return Number.isInteger(id) ? store.source(id) : null;
  };

  // The page a keep was pressed on, to go back to. Only its path is used,
  // so it can't send anyone anywhere else.
  function back(request: Request): string {
    const from = URL.parse(request.headers.get('referer') ?? '');
    return from?.pathname.startsWith(at('/')) ? from.pathname + from.search : at('/');
  }

  const routes: Record<string, Handler | Partial<Record<'GET' | 'POST', Handler>>> = {
    [at('/')]: {
      GET: () => {
        wake(); // opening the app is the moment to check for news
        return sent(views.home(counts(), store.entries(scopes.latest)));
      },
    },

    [at('/keep')]: {
      POST: async (request) => {
        const form = await request.formData();
        const id = Number(form.get('id'));
        const [entry] = Number.isInteger(id) ? store.mark([id], { bookmarked: form.get('keep') === '1' }) : [];
        if (!entry) return missing();
        if (request.headers.get('hx-request')) return sent(views.keep(entry));
        return see(`${back(request)}#e${id}`);
      },
    },

    [at('/kept')]: {
      GET: (request) =>
        sent(views.kept(counts(), store.entries(scopes.bookmarks), new URL(request.url).searchParams.get('said'))),
      // Keeps every link in what was pasted, each with its page's title.
      POST: async (request) => {
        const links = linksIn(text(await request.formData(), 'links')).slice(0, MOST_LINKS);
        if (!links.length) return see(saying(at('/kept'), 'No links in that.'));
        const titles = await Promise.all(links.map(pageTitle));
        links.forEach((url, index) => store.bookmarkPage(url, titles[index]!));
        return see(saying(at('/kept'), links.length === 1 ? 'Kept.' : `Kept ${links.length}.`));
      },
    },

    [at('/feeds')]: {
      GET: (request) => {
        const query = new URL(request.url).searchParams;
        return sent(views.feeds(counts(), store.sources(), query.get('said'), query.get('url') ?? ''));
      },
      // Follows a feed's address, a site that has one, or a Bluesky handle.
      POST: async (request) => {
        const url = text(await request.formData(), 'url');
        if (!url) return see(at('/feeds'));
        try {
          // Not a feed itself? Then the first feed of the site at that address.
          const found = await discover(url).catch(async (notAFeed) => {
            const [first] = await findFeeds(url.includes('://') ? url : `https://${url}`).catch(() => []);
            if (!first) throw notAFeed;
            return discover(first.url);
          });
          const id = store.addSource(found.kind, found.ref, found.label);
          follow(id);
          return see(at(`/feed/${id}`));
        } catch (thrown) {
          return see(saying(at('/feeds'), `No feed there: ${reason(thrown)}`, `&url=${encodeURIComponent(url)}`));
        }
      },
    },

    [at('/feed/:id')]: {
      GET: (request) => {
        const source = sourceOf(request);
        if (!source) return missing();
        return sent(views.feed(counts(), source, store.mutes(source.id), store.entries(scopes.feed(source.id))));
      },
    },

    [at('/feed/:id/mutes')]: {
      POST: async (request) => {
        const source = sourceOf(request);
        if (!source) return missing();
        store.setMutes(source.id, text(await request.formData(), 'words').split(','));
        return see(at(`/feed/${source.id}`));
      },
    },

    // Its bookmarks stay, as kept pages.
    [at('/feed/:id/remove')]: {
      POST: (request) => {
        const source = sourceOf(request);
        if (!source) return missing();
        store.removeSource(source.id);
        return see(saying(at('/feeds'), `Stopped following ${source.label}.`));
      },
    },

    [at('/search')]: {
      GET: (request) => {
        const query = new URL(request.url).searchParams.get('q')?.trim() ?? '';
        return sent(views.search(counts(), query, store.searchFeeds(query), store.searchEntries(query)));
      },
    },

    [at('/settings')]: {
      GET: (request) => sent(views.settings(counts(), new URL(request.url).searchParams.get('said'))),
    },

    [at('/opml')]: {
      // Every feed followed, as a file other readers can import.
      GET: () =>
        new Response(writeOpml(store.sources()), {
          headers: {
            'Content-Type': 'text/x-opml; charset=utf-8',
            'Content-Disposition': 'attachment; filename="lagan.opml"',
          },
        }),
      // Follows every feed in an OPML file that isn't followed already.
      POST: async (request) => {
        const file = (await request.formData()).get('file');
        let listed;
        try {
          listed = readOpml(file instanceof Blob ? await file.text() : '');
        } catch {
          return see(saying(at('/settings'), 'That file could not be read as OPML.'));
        }
        const added = store.addSources(listed.flatMap((feed) => (URL.canParse(feed.url) ? [sourceFor(feed)] : [])));
        for (const id of added) follow(id);
        return see(saying(at('/settings'), `${listed.length} feeds in the file, ${added.length} new.`));
      },
    },

    // The feeds the site of a page offers, and which are followed already.
    [at('/discover')]: {
      GET: async (request) => {
        const url = new URL(request.url).searchParams.get('url') ?? '';
        const site = URL.parse(url)?.hostname.replace(/^www\./, '');
        if (!site) return missing();
        const followed = new Map(store.sources().map((source) => [source.ref, source.id]));
        const found: Found[] | string = await findFeeds(url).then(
          (feeds) => feeds.map((feed) => ({ ...feed, followed: followed.get(feed.url) ?? null })),
          reason,
        );
        return sent(views.discover(counts(), site, found));
      },
    },
  };

  if (base) routes[base] = () => see(at('/'));
  const guardedRoutes = Object.fromEntries(
    Object.entries(routes).map(([path, route]) => [
      path,
      typeof route === 'function'
        ? guarded(route)
        : Object.fromEntries(Object.entries(route).map(([method, handler]) => [method, guarded(handler)])),
    ]),
  );

  return {
    routes: {
      ...guardedRoutes,
      [at(htmxName)]: new Response(Bun.gzipSync(htmx), {
        headers: {
          'Content-Type': 'text/javascript',
          'Content-Encoding': 'gzip', // every browser takes it
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      }),
    },
    fetch: guarded(missing) as (request: Request) => Promise<Response>,
  };
}
