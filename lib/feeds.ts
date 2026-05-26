import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { XMLParser } from 'fast-xml-parser';
import type { Entry, Feed, FeedCacheMeta } from './types.ts';
import { isPrivateAddress, isSafeExternalUrl } from './security.ts';

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', htmlEntities: true });
const UA = 'Feedreader/1.0';
const MAX_FEED_FETCH_CONCURRENCY = 24;
const FEED_FETCH_TIMEOUT_MS = 8000;
const MAX_FEED_BYTES = 10 * 1024 * 1024;
const MAX_DISCOVERY_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;

export interface FeedFetchResult {
  entries: Entry[];
  error?: string;
  notModified?: boolean;
  validators?: Pick<FeedCacheMeta, 'etag' | 'lastModified'>;
}

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

const monthNumbers: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

const rfc822ZoneOffsets: Record<string, number> = {
  UT: 0,
  UTC: 0,
  GMT: 0,
  Z: 0,
  EST: -5 * 60,
  EDT: -4 * 60,
  CST: -6 * 60,
  CDT: -5 * 60,
  MST: -7 * 60,
  MDT: -6 * 60,
  PST: -8 * 60,
  PDT: -7 * 60,
};

function parseFeedDate(input: string): string | null {
  const direct = new Date(input);
  if (!isNaN(direct.getTime())) return direct.toISOString();

  const match = input.trim().match(
    /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),?\s+)?(\d{1,2})\s+([A-Za-z]{3})\s+(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s+([A-Za-z]{1,5}|[+-]\d{2}:?\d{2}))?$/i,
  );
  if (!match) return null;

  const [, dayText, monthText, yearText, hourText, minuteText, secondText, zoneText] = match;
  const month = monthNumbers[monthText.toLowerCase()];
  if (month === undefined) return null;

  const day = Number(dayText);
  const rawYear = Number(yearText);
  const year = yearText.length === 2 ? rawYear + (rawYear >= 70 ? 1900 : 2000) : rawYear;
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = secondText ? Number(secondText) : 0;
  if (
    !Number.isInteger(day) || day < 1 || day > 31 ||
    !Number.isInteger(year) ||
    !Number.isInteger(hour) || hour > 23 ||
    !Number.isInteger(minute) || minute > 59 ||
    !Number.isInteger(second) || second > 59
  ) {
    return null;
  }

  const wallClock = new Date(Date.UTC(year, month, day, hour, minute, second));
  if (
    wallClock.getUTCFullYear() !== year ||
    wallClock.getUTCMonth() !== month ||
    wallClock.getUTCDate() !== day
  ) {
    return null;
  }

  const offsetMinutes = parseZoneOffset(zoneText);
  const parsed = new Date(wallClock.getTime() - offsetMinutes * 60 * 1000);
  return parsed.toISOString();
}

function parseZoneOffset(zone: string | undefined): number {
  if (!zone) return 0;

  const numeric = zone.match(/^([+-])(\d{2}):?(\d{2})$/);
  if (numeric) {
    const sign = numeric[1] === '-' ? -1 : 1;
    const hours = Number(numeric[2]);
    const minutes = Number(numeric[3]);
    if (hours > 23 || minutes > 59) return 0;
    return sign * (hours * 60 + minutes);
  }

  const upper = zone.toUpperCase();
  if (upper in rfc822ZoneOffsets) return rfc822ZoneOffsets[upper];

  if (/^[A-IK-M]$/.test(upper)) {
    return upper.charCodeAt(0) - 'A'.charCodeAt(0) + 1;
  }
  if (/^[N-Y]$/.test(upper)) {
    return -(upper.charCodeAt(0) - 'N'.charCodeAt(0) + 1);
  }

  return 0;
}

function pickDate(...candidates: (string | undefined)[]): string {
  for (const c of candidates) {
    if (!c) continue;
    const parsed = parseFeedDate(c);
    if (parsed) return parsed;
  }
  return new Date().toISOString();
}

export function publishedTime(entry: Pick<Entry, 'published'>): number {
  const time = Date.parse(entry.published);
  return Number.isFinite(time) ? time : 0;
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

function safeEntryUrl(rawUrl: string): string {
  const safe = isSafeExternalUrl(rawUrl);
  return safe.ok ? safe.url.href : '';
}

function buildEntry(feedId: string, rawSourceId: string, url: string, title: string, published: string): Entry {
  const safeUrl = safeEntryUrl(url);
  const sourceId = rawSourceId || safeUrl || title;
  return {
    id: createEntryId(feedId, sourceId),
    sourceId,
    feedId,
    url: safeUrl,
    title,
    published,
  };
}

async function assertSafeFetchTarget(url: URL): Promise<void> {
  const safe = isSafeExternalUrl(url.href);
  if (!safe.ok) throw new Error(safe.reason);

  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new Error('Private IP addresses are not allowed');
    return;
  }

  const records = await lookup(host, { all: true });
  if (records.length === 0) throw new Error('Hostname did not resolve');
  for (const record of records) {
    if (isPrivateAddress(record.address)) {
      throw new Error('Host resolves to a private IP address');
    }
  }
}

async function safeFetchExternal(rawUrl: string, init: RequestInit): Promise<Response> {
  let current = new URL(rawUrl);
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
    await assertSafeFetchTarget(current);
    const res = await fetch(current.href, { ...init, redirect: 'manual' });

    if (![301, 302, 303, 307, 308].includes(res.status)) return res;

    const location = res.headers.get('location');
    if (!location) return res;
    await discardResponseBody(res);
    current = new URL(location, current);
  }
  throw new Error('Too many redirects');
}

async function discardResponseBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // Nothing useful to do here; this is just defensive resource cleanup.
  }
}

async function readResponseText(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) {
    const text = await res.text();
    if (Buffer.byteLength(text) > maxBytes) throw new Error('Response body too large');
    return text;
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('Response body too large');
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf-8');
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

export async function fetchFeed(feed: Feed, meta: FeedCacheMeta = {}): Promise<FeedFetchResult> {
  try {
    const headers: Record<string, string> = {
      'User-Agent': UA,
      Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml',
    };
    if (meta.etag) headers['If-None-Match'] = meta.etag;
    if (meta.lastModified) headers['If-Modified-Since'] = meta.lastModified;

    const res = await safeFetchExternal(feed.url, {
      headers,
      signal: AbortSignal.timeout(FEED_FETCH_TIMEOUT_MS),
    });
    const validators = pickValidators(res, meta);
    if (res.status === 304) {
      await discardResponseBody(res);
      return { entries: [], notModified: true, validators };
    }
    if (!res.ok) {
      await discardResponseBody(res);
      return { entries: [], error: `HTTP ${res.status}` };
    }
    const xml = await readResponseText(res, MAX_FEED_BYTES);
    return { entries: parseFeed(xml, feed.id), validators };
  } catch (e) {
    const msg = (e as Error).message || 'Unknown error';
    console.error(`Failed to fetch ${feed.label} (${feed.url}):`, msg);
    return { entries: [], error: msg };
  }
}

function pickValidators(res: Response, fallback: FeedCacheMeta): Pick<FeedCacheMeta, 'etag' | 'lastModified'> {
  return {
    etag: res.headers.get('etag') || fallback.etag,
    lastModified: res.headers.get('last-modified') || fallback.lastModified,
  };
}

export async function fetchAllFeeds(
  feeds: Feed[],
  meta: Record<string, FeedCacheMeta> = {},
  onFeedResult?: (feed: Feed, result: FeedFetchResult) => Promise<void>,
): Promise<{ entries: Entry[]; errors: Record<string, string>; feedMeta: Record<string, FeedCacheMeta> }> {
  const results: PromiseSettledResult<FeedFetchResult>[] = new Array(feeds.length);
  let nextFeedIndex = 0;

  async function worker() {
    while (nextFeedIndex < feeds.length) {
      const index = nextFeedIndex++;
      results[index] = await Promise.resolve(fetchFeed(feeds[index], meta[feeds[index].id])).then(
        value => ({ status: 'fulfilled', value }),
        reason => ({ status: 'rejected', reason }),
      );
      if (onFeedResult) {
        const result = results[index];
        await onFeedResult(feeds[index], result.status === 'fulfilled'
          ? result.value
          : { entries: [], error: result.reason?.message || 'Unknown error' });
      }
    }
  }

  const workerCount = Math.min(MAX_FEED_FETCH_CONCURRENCY, feeds.length);
  await Promise.all(Array.from({ length: workerCount }, worker));

  const all: Entry[] = [];
  const errors: Record<string, string> = {};
  const nextMeta: Record<string, FeedCacheMeta> = {};
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const feedId = feeds[i].id;
    if (r.status === 'fulfilled') {
      all.push(...r.value.entries);
      if (r.value.error) {
        errors[feedId] = r.value.error;
      } else if (r.value.validators?.etag || r.value.validators?.lastModified) {
        nextMeta[feedId] = r.value.validators;
      }
    } else {
      errors[feedId] = r.reason?.message || 'Unknown error';
    }
  }
  all.sort((a, b) => publishedTime(b) - publishedTime(a));
  return { entries: all, errors, feedMeta: nextMeta };
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
    const res = await safeFetchExternal(pageUrl, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const html = await readResponseText(res, MAX_DISCOVERY_BYTES);

    const linkRe = /<link[^>]+(?:application\/(?:rss|atom)\+xml|text\/xml)[^>]*>/gi;
    const matches = html.match(linkRe);
    if (matches) {
      for (const m of matches) {
        const href = m.match(/href\s*=\s*["']([^"']+)["']/i);
        if (href) {
          const discovered = new URL(href[1], pageUrl).href;
          if (isSafeExternalUrl(discovered).ok) return discovered;
        }
      }
    }
  } catch {}

  const base = new URL(pageUrl).origin;
  const guesses = ['/feed', '/rss', '/feed.xml', '/atom.xml', '/index.xml', '/rss.xml'];
  for (const path of guesses) {
    try {
      const res = await safeFetchExternal(base + path, {
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
