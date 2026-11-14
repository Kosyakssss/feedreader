// What each address does. Pages are read with GET; a change is a form posted,
// answered by sending the browser back to a page, so reloading never posts
// it again. Sent by htmx instead, a change is answered with just the part of
// the page it changed.
import { linksIn } from '#lib/links.ts';
import type { Lagan } from '#lib/server/lagan.ts';
import { errorText } from '#lib/server/fetch.ts';
import { readOpml, sourceFor, writeOpml } from '#lib/server/opml.ts';
import { findFeed, pageTitle } from '#lib/server/sites.ts';
import { scopes, type Source } from '#lib/server/store.ts';
import { html, type Html } from '#lib/html.ts';
import { address, pages, type Edited, type Found } from './pages';

type Handler = (request: Bun.BunRequest) => Response | Promise<Response>;

const MOST_LINKS = 100;
const MOST_FEEDS = 50;

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
  if (!type.startsWith('text/') || !accepts || !response.body) return response;
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
const saying = (path: string, said: string) => `${path}?said=${encodeURIComponent(said)}`;

const text = (form: FormData, name: string) => String(form.get(name) ?? '').trim();
// htmx asking for part of a page; not when it restores a whole page from history.
const fromHtmx = (request: Request) =>
  request.headers.has('hx-request') && !request.headers.has('hx-history-restore-request');

// Why no feed was found, in plain words.
function plainly(thrown: unknown): string {
  const said = errorText(thrown);
  if (/ENOTFOUND|EAI_AGAIN|ECONN|connect|timed? ?out|abort|certificate|TLS|reach/i.test(said))
    return 'couldn’t reach it';
  if (/not a public address/i.test(said)) return 'it isn’t on the public web';
  const status = /^HTTP (\d+)/.exec(said)?.[1];
  if (status) return status === '404' ? 'nothing at that address' : `the site answered ${status}`;
  return 'no feed there';
}

// Chrome keeps pages it fetched ahead for a while. Keeping without leaving
// the page makes them stale.
const fresh = (response: Response) => {
  response.headers.set('Clear-Site-Data', '"prefetchCache"');
  return response;
};
const query = (request: Request) => new URL(request.url).searchParams;

// The app, served under `base`: '' or a path such as '/lagan'.
export function app({ store, wake, follow }: Lagan, base = '') {
  const at = (path: string) => base + path;
  const views = pages(base, at(htmxName));
  const counts = () => ({ kept: store.keptCount(), feeds: store.sources().length });
  const missing = () => sent(views.missing(counts()), 404);
  const followed = (ref: string) => store.sources().find((source) => source.ref === ref);

  // The feed an address names, and what to do with it if there is one. A
  // site pages were kept from is no feed.
  const withSource =
    (handler: (source: Source, request: Bun.BunRequest) => Response | Promise<Response>): Handler =>
    (request) => {
      const id = Number((request.params as { id?: string }).id);
      const source = Number.isInteger(id) ? store.source(id) : null;
      return source && source.kind !== 'page' ? handler(source, request) : missing();
    };

  // A feed's page; after an edit that failed, with the edit open, what was
  // typed, and why.
  const feedPage = (source: Source, failed?: { note: string; typed: Edited }) =>
    sent(
      views.feed(
        counts(),
        source,
        store.entries(scopes.feed(source.id)),
        {
          label: source.label,
          ref: address(source),
          mutes: store.mutes(source.id).join(', '),
          cuts: store.cuts(source.id).join(', '),
          ...failed?.typed,
        },
        failed?.note,
      ),
      failed ? 422 : 200,
    );

  // The page a keep was pressed on, to go back to. Only its path is used,
  // so it can't send anyone anywhere else.
  function back(request: Request): string {
    const from = URL.parse(request.headers.get('referer') ?? '');
    return from?.pathname.startsWith(at('/')) ? from.pathname + from.search : at('/');
  }

  const routes: Record<string, Handler | Partial<Record<'GET' | 'POST', Handler>>> = {
    [at('/')]: {
      GET: (request) => {
        // Opening the app is the moment to check for news; fetching it ahead isn't.
        if (!request.headers.get('sec-purpose')?.includes('prefetch')) wake();
        return sent(views.home(counts(), store.entries(scopes.latest)));
      },
    },

    [at('/keep')]: {
      POST: async (request) => {
        const form = await request.formData();
        const id = Number(form.get('id'));
        const [entry] = Number.isInteger(id) ? store.keep([id], form.get('keep') === '1') : [];
        if (!entry) return missing();
        const from = back(request);
        if (!fromHtmx(request)) return see(`${from}#e${id}`);
        const here = from.split('?')[0] === at('/kept') ? '/kept' : '';
        return fresh(sent(html`${views.keep(entry, true)}${views.keptCount(counts(), here, true)}`));
      },
    },

    [at('/kept')]: {
      GET: (request) => sent(views.kept(counts(), store.entries(scopes.kept), query(request).get('said'))),
      // Keeps every link in what was pasted, each with its page's title.
      POST: async (request) => {
        const links = linksIn(text(await request.formData(), 'links')).slice(0, MOST_LINKS);
        if (!links.length) return see(saying(at('/kept'), 'No links in that.'));
        const titles = await Promise.all(links.map(pageTitle));
        links.forEach((url, index) => store.keepPage(url, titles[index]!));
        return see(saying(at('/kept'), links.length === 1 ? 'Kept.' : `Kept ${links.length}.`));
      },
    },

    [at('/feeds')]: {
      GET: (request) => sent(views.feeds(counts(), store.sources(), query(request).get('said'))),
      // Follows what was looked over: each feed as found, or at the address
      // it was changed to, under the name it was given.
      POST: async (request) => {
        const form = await request.formData();
        const [kinds, founds, labels, refs] = ['kind', 'found', 'label', 'ref'].map((name) =>
          form.getAll(name).map(String),
        ) as [Source['kind'][], string[], string[], string[]];
        const results = await Promise.allSettled(
          refs.slice(0, MOST_FEEDS).map(async (typed, index) => {
            const ref = typed.trim();
            const found = ref === founds[index] ? { kind: kinds[index]!, ref } : await findFeed(ref);
            const id = store.addSource(found.kind, found.ref, labels[index]?.trim() || found.ref);
            follow(id);
            return id;
          }),
        );
        const ids = results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
        const missed = results.length - ids.length;
        if (ids.length === 1 && !missed) return see(at(`/feed/${ids[0]}`));
        const told = [ids.length && `Following ${ids.length}.`, missed && `${missed} could not be followed.`];
        return see(saying(at('/feeds'), told.filter(Boolean).join(' ')));
      },
    },

    // What was pasted into Feeds, looked for: links, however written, or
    // else handles.
    [at('/feeds/new')]: {
      GET: async (request) => {
        const typed = query(request).get('links')?.trim() ?? '';
        const links = linksIn(typed);
        const tries = (links.length ? links : typed.split(/[\s,]+/).filter(Boolean)).slice(0, MOST_FEEDS);
        if (!tries.length) return see(at('/feeds'));
        const found = await Promise.all(
          tries.map((each): Promise<Found> =>
            findFeed(each).then(
              (feed) => {
                const known = followed(feed.ref);
                return known ? { typed: each, followed: known } : { typed: each, ...feed };
              },
              (thrown) => ({ typed: each, missed: plainly(thrown) }),
            ),
          ),
        );
        // Two things pasted that lead to one feed show it once.
        const seen = new Set<string>();
        const once = found.filter((each) => {
          const ref = 'ref' in each ? each.ref : 'followed' in each ? each.followed.ref : null;
          if (ref === null) return true;
          if (seen.has(ref)) return false;
          seen.add(ref);
          return true;
        });
        return sent(views.review(counts(), once));
      },
    },

    [at('/feed/:id')]: { GET: withSource((source) => feedPage(source)) },

    // Everything about a feed at once: its name, its address (a feed there,
    // of whatever kind), its muted words and its cuts.
    [at('/feed/:id/edit')]: {
      POST: withSource(async (source, request) => {
        const form = await request.formData();
        const typed = {
          label: text(form, 'label'),
          ref: text(form, 'ref'),
          mutes: text(form, 'mutes'),
          cuts: text(form, 'cuts'),
        };
        const failed = (note: string) => feedPage(source, { note, typed });
        // The address as the form showed it is no change, however it is written.
        if (typed.ref && typed.ref !== source.ref && typed.ref !== address(source)) {
          let found;
          try {
            found = await findFeed(typed.ref);
          } catch (thrown) {
            return failed(`Can’t follow that address: ${plainly(thrown)}.`);
          }
          const other = followed(found.ref);
          if (other && other.id !== source.id) return failed(`That is ${other.label}, followed already.`);
          if (found.ref !== source.ref) {
            store.readdress(source.id, found.kind, found.ref);
            follow(source.id);
          }
        }
        store.rename(source.id, typed.label || source.label);
        store.setMutes(source.id, typed.mutes.split(','));
        store.setCuts(source.id, typed.cuts.split(','));
        return see(at(`/feed/${source.id}`));
      }),
    },

    // What was kept from it stays, as pages of its site.
    [at('/feed/:id/remove')]: {
      POST: withSource((source) => {
        store.removeSource(source.id);
        return see(saying(at('/feeds'), `Stopped following ${source.label}.`));
      }),
    },

    [at('/search')]: {
      GET: (request) => {
        const typed = query(request).get('q')?.trim() ?? '';
        const [feeds, list] = [store.searchFeeds(typed), store.searchEntries(typed)];
        if (fromHtmx(request)) return sent(html`${views.results(typed, feeds, list)}`);
        return sent(views.search(counts(), typed, feeds, list));
      },
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
          return see(saying(at('/feeds'), 'That file could not be read as OPML.'));
        }
        const added = store.addSources(listed.flatMap((feed) => (URL.canParse(feed.url) ? [sourceFor(feed)] : [])));
        for (const id of added) follow(id);
        return see(saying(at('/feeds'), `${listed.length} feeds in the file, ${added.length} new.`));
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
