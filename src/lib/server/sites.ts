// Reading the pages people bookmark: their titles, and the feeds they offer.
import { discover, readLimited, safeFetch } from './fetch';
import { plain } from './parse';

const PAGE_BYTES = 2 * 1024 * 1024;
const FEED_TYPES = new Set([
  'application/rss+xml',
  'application/atom+xml',
  'application/feed+json',
  'application/json',
]);
// Where sites without a <link> to their feed usually keep it.
const USUAL_PLACES = ['/feed', '/rss.xml', '/atom.xml', '/feed.xml', '/index.xml', '/rss'];

export type FoundFeed = { url: string; title: string };

async function readPage(url: string): Promise<{ html: string; url: string }> {
  const response = await safeFetch(url, { Accept: 'text/html, application/xhtml+xml' });
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status}`);
  }
  return { html: new TextDecoder().decode(await readLimited(response, PAGE_BYTES)), url: response.url || url };
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

// Feeds the page links to in its <head>, the way browsers find them.
export function linkedFeeds(html: string, base: string): FoundFeed[] {
  const found = new Map<string, FoundFeed>();
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    const link = attributes(tag);
    const rels = (link.rel ?? '').toLowerCase().split(/\s+/);
    if (!rels.includes('alternate') || !FEED_TYPES.has((link.type ?? '').toLowerCase()) || !link.href) continue;
    try {
      const url = new URL(link.href, base).href;
      if (!found.has(url)) found.set(url, { url, title: plain(link.title ?? '') });
    } catch {
      // an address that isn't one
    }
  }
  return [...found.values()];
}

export async function pageTitle(url: string): Promise<string> {
  try {
    return titleOf((await readPage(url)).html);
  } catch {
    return '';
  }
}

// The feeds a site offers: the ones its page links to, or else the first of
// the usual places that turns out to be a feed.
export async function findFeeds(url: string): Promise<FoundFeed[]> {
  const page = await readPage(url);
  const linked = linkedFeeds(page.html, page.url);
  if (linked.length) return linked;
  const tries = USUAL_PLACES.map((path) => discover(new URL(path, page.url).href));
  for (const tried of await Promise.allSettled(tries)) {
    if (tried.status === 'fulfilled') return [{ url: tried.value.ref, title: tried.value.label }];
  }
  return [];
}
