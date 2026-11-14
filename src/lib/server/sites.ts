// Reading the pages people bookmark: their titles, and the feeds they offer.
import { discover, ok, readLimited, safeFetch } from './fetch';
import { plain } from './parse';

// What a page says about itself, its title and its feeds, is in its head: a
// page longer than this is read only this far.
const PAGE_BYTES = 1024 * 1024;
const FEED_TYPES = new Set([
  'application/rss+xml',
  'application/atom+xml',
  'application/feed+json',
  'application/json',
]);
// Where sites without a <link> to their feed usually keep it.
const USUAL_PLACES = ['/feed', '/rss.xml', '/atom.xml', '/feed.xml', '/index.xml', '/rss'];

async function readPage(url: string): Promise<{ html: string; url: string }> {
  const response = await ok(await safeFetch(url, { Accept: 'text/html, application/xhtml+xml' }));
  return { html: new TextDecoder().decode(await readLimited(response, PAGE_BYTES, true)), url: response.url || url };
}

function attributes(tag: string): Record<string, string> {
  const pairs = tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g);
  return Object.fromEntries([...pairs].map((pair) => [pair[1]!.toLowerCase(), pair[2] ?? pair[3] ?? pair[4] ?? '']));
}

// The page's own title, or what it tells sites that link to it.
export function titleOf(html: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  if (title && plain(title)) return plain(title);
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    const meta = attributes(tag);
    if (meta.property === 'og:title' && meta.content) return plain(meta.content);
  }
  return '';
}

// The first feed the page links to in its <head>, the way browsers find them.
export function linkedFeed(html: string, base: string): string | undefined {
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    const link = attributes(tag);
    const rels = (link.rel ?? '').toLowerCase().split(/\s+/);
    if (!rels.includes('alternate') || !FEED_TYPES.has((link.type ?? '').toLowerCase()) || !link.href) continue;
    const url = URL.parse(link.href, base)?.href;
    if (url) return url;
  }
}

export async function pageTitle(url: string): Promise<string> {
  try {
    return titleOf((await readPage(url)).html);
  } catch {
    return '';
  }
}

// The feed at what was typed: its address, a site that has one, or a Bluesky
// handle. Not a feed itself? Then the feed the site at that address links to,
// or else the first of the usual places that is one; or why there is none:
// the site out of reach, or no feed on it.
export const findFeed = (typed: string) =>
  discover(typed).catch(async () => {
    const page = await readPage(typed.includes('://') ? typed : `https://${typed}`);
    const linked = linkedFeed(page.html, page.url);
    if (linked) return discover(linked);
    const tries = await Promise.allSettled(USUAL_PLACES.map((path) => discover(new URL(path, page.url).href)));
    const found = tries.find((tried) => tried.status === 'fulfilled');
    if (!found) throw new Error('no feed on that page');
    return found.value;
  });
