import { XMLParser } from 'fast-xml-parser';
import type { Entry, Feed } from './types.ts';

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', htmlEntities: true });
const UA = 'Feedreader/1.0';

const namedEntities: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function createEntryId(feedId: string, sourceId: string): string {
  return `${feedId}:${encodeURIComponent(sourceId)}`;
}

export function decodeHtmlEntities(input: string): string {
  if (!input.includes('&')) return input;
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]+);/g, (match, entity) => {
    if (entity[0] === '#') {
      const hex = entity[1]?.toLowerCase() === 'x';
      const raw = hex ? entity.slice(2) : entity.slice(1);
      const codepoint = Number.parseInt(raw, hex ? 16 : 10);
      if (!Number.isFinite(codepoint) || codepoint < 0 || codepoint > 0x10ffff) return match;
      try {
        return String.fromCodePoint(codepoint);
      } catch {
        return match;
      }
    }
    return namedEntities[entity.toLowerCase()] ?? match;
  });
}

function pickText(value: any): string {
  if (typeof value === 'string') return decodeHtmlEntities(value);
  if (value && typeof value === 'object') {
    if (typeof value['#text'] === 'string') return decodeHtmlEntities(value['#text']);
    if (typeof value.__cdata === 'string') return decodeHtmlEntities(value.__cdata);
  }
  if (value === undefined || value === null) return '';
  return decodeHtmlEntities(String(value));
}

function toArray<T>(v: T | T[] | undefined): T[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function pickDate(...candidates: (string | undefined)[]): string {
  for (const c of candidates) {
    if (!c) continue;
    const d = new Date(c);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

function pickLink(link: any): string {
  if (typeof link === 'string') return link;
  if (Array.isArray(link)) {
    const alt = link.find((l: any) => l['@_rel'] === 'alternate');
    const first = alt || link[0];
    return first?.['@_href'] || first || '';
  }
  return link?.['@_href'] || '';
}

function buildEntry(feedId: string, rawSourceId: string, url: string, title: string, published: string): Entry {
  const sourceId = rawSourceId || url || `${title}:${published}`;
  return {
    id: createEntryId(feedId, sourceId),
    sourceId,
    feedId,
    url,
    title,
    published,
  };
}

export function parseFeed(xml: string, feedId: string): Entry[] {
  const doc = parser.parse(xml);
  const entries: Entry[] = [];

  const rssItems = toArray(doc?.rss?.channel?.item);
  for (const item of rssItems) {
    const url = pickLink(item.link);
    const title = pickText(item.title) || 'Untitled';
    const published = pickDate(item.pubDate, item['dc:date']);
    entries.push(buildEntry(feedId, pickText(item.guid?.['#text'] || item.guid || url), url, title, published));
  }

  const atomEntries = toArray(doc?.feed?.entry);
  for (const entry of atomEntries) {
    const url = pickLink(entry.link);
    const title = pickText(entry.title?.['#text'] || entry.title) || 'Untitled';
    const published = pickDate(entry.published, entry.updated);
    entries.push(buildEntry(feedId, pickText(entry.id || url), url, title, published));
  }

  // RDF/RSS 1.0
  const rdfItems = toArray(doc?.['rdf:RDF']?.item);
  for (const item of rdfItems) {
    const url = pickLink(item.link);
    const title = pickText(item.title) || 'Untitled';
    const published = pickDate(item['dc:date'], item.pubDate);
    entries.push(buildEntry(feedId, pickText(item['@_rdf:about'] || url), url, title, published));
  }

  return entries;
}

export async function fetchFeed(feed: Feed): Promise<{ entries: Entry[]; error?: string }> {
  try {
    const res = await fetch(feed.url, {
      headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { entries: [], error: `HTTP ${res.status}` };
    const xml = await res.text();
    return { entries: parseFeed(xml, feed.id) };
  } catch (e) {
    const msg = (e as Error).message || 'Unknown error';
    console.error(`Failed to fetch ${feed.label} (${feed.url}):`, msg);
    return { entries: [], error: msg };
  }
}

export async function fetchAllFeeds(feeds: Feed[]): Promise<{ entries: Entry[]; errors: Record<string, string> }> {
  const results = await Promise.allSettled(feeds.map(f => fetchFeed(f)));
  const all: Entry[] = [];
  const errors: Record<string, string> = {};
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled') {
      all.push(...r.value.entries);
      if (r.value.error) errors[feeds[i].id] = r.value.error;
    } else {
      errors[feeds[i].id] = r.reason?.message || 'Unknown error';
    }
  }
  all.sort((a, b) => new Date(b.published).getTime() - new Date(a.published).getTime());
  return { entries: all, errors };
}

export function parseOPML(xml: string): { url: string; label: string }[] {
  const doc = parser.parse(xml);
  const feeds: { url: string; label: string }[] = [];

  function walk(outlines: any) {
    for (const o of toArray(outlines)) {
      if (o['@_xmlUrl']) {
        feeds.push({ url: o['@_xmlUrl'], label: pickText(o['@_title'] || o['@_text'] || o['@_xmlUrl']) });
      }
      if (o.outline) walk(o.outline);
    }
  }

  const body = doc?.opml?.body;
  if (body?.outline) walk(body.outline);
  return feeds;
}

export async function discoverFeedUrl(pageUrl: string): Promise<string | null> {
  try {
    const res = await fetch(pageUrl, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const html = await res.text();

    const linkRe = /<link[^>]+(?:application\/(?:rss|atom)\+xml|text\/xml)[^>]*>/gi;
    const matches = html.match(linkRe);
    if (matches) {
      for (const m of matches) {
        const href = m.match(/href\s*=\s*["']([^"']+)["']/i);
        if (href) return new URL(href[1], pageUrl).href;
      }
    }
  } catch {}

  const base = new URL(pageUrl).origin;
  const guesses = ['/feed', '/rss', '/feed.xml', '/atom.xml', '/index.xml', '/rss.xml'];
  for (const path of guesses) {
    try {
      const res = await fetch(base + path, {
        method: 'HEAD',
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(5000),
      });
      const ct = res.headers.get('content-type') || '';
      if (res.ok && (ct.includes('xml') || ct.includes('rss') || ct.includes('atom'))) {
        return base + path;
      }
    } catch {}
  }

  return null;
}
