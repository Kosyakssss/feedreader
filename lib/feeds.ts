import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { XMLParser } from 'fast-xml-parser';
import type { Entry, Feed, FeedCacheMeta } from './types.ts';
import { isPrivateAddress, isSafeExternalUrl } from './security.ts';

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', htmlEntities: true });
const UA = 'Feedreader/1.0';
const FEED_FETCH_TIMEOUT_MS = 8000;
const MAX_FEED_BYTES = 10 * 1024 * 1024;
const MAX_DISCOVERY_BYTES = 2 * 1024 * 1024;
/** Parallel feed fetches per refresh. Bounds sockets, memory, and hammering of feed hosts. */
const FETCH_CONCURRENCY = 8;
const MAX_REDIRECTS = 5;
const ATPROTO_APPVIEW = 'https://public.api.bsky.app';
const ATPROTO_IDENTITY = 'https://bsky.social';
const PLC_DIRECTORY = 'https://plc.directory';
const ATPROTO_DOCUMENT_COLLECTION = 'site.standard.document';
const ATPROTO_PUBLICATION_COLLECTION = 'site.standard.publication';
const MAX_ATPROTO_RECORDS = 1000;
const DIRECT_FEED_PATH_RE = /\.(xml|rss|atom|json)$/i;
const DIRECT_FEED_ROUTE_RE = /\/(feed|rss|atom|json)\/?$/i;

export interface FeedFetchResult {
  entries: Entry[];
  error?: string;
  notModified?: boolean;
  validators?: Pick<FeedCacheMeta, 'etag' | 'lastModified'>;
}

export interface ResolvedFeedInput {
  url: string;
  label: string;
}

interface AtprotoProfileFeed {
  type: 'profile';
  handle: string;
}

interface AtprotoPublicationFeed {
  type: 'publication';
  did: string;
  rkey: string;
}

type AtprotoFeed = AtprotoProfileFeed | AtprotoPublicationFeed;

interface DidDocument {
  service?: { id?: string; serviceEndpoint?: string }[];
}

interface AtprotoProfile {
  did: string;
  handle: string;
  displayName?: string;
}

interface AtprotoRecord<T = any> {
  uri: string;
  value: T;
}

interface StandardPublication {
  url?: string;
  name?: string;
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
  if (!dayText || !monthText || !yearText || !hourText || !minuteText) return null;
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
  const namedOffset = rfc822ZoneOffsets[upper];
  if (namedOffset !== undefined) return namedOffset;

  // RFC 822 military zones (A–I, K–M, N–Y) are obsolete and ambiguous;
  // RFC 5322 says to treat them as unknown offsets, i.e. UTC.
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeHandle(input: string): string | null {
  const handle = input.trim().replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(handle)) {
    return null;
  }
  return handle;
}

function parseAtUri(uri: string): { did: string; collection: string; rkey: string } | null {
  const match = uri.match(/^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  return { did: match[1], collection: match[2], rkey: match[3] };
}

function atprotoProfileUrl(handle: string): string {
  return `atproto://profile/${handle}`;
}

function atprotoPublicationUrl(did: string, rkey: string): string {
  return `atproto://publication/${did}/${rkey}`;
}

export function parseAtprotoFeedUrl(rawUrl: string): AtprotoFeed | null {
  const profilePrefix = 'atproto://profile/';
  if (rawUrl.startsWith(profilePrefix)) {
    const handle = normalizeHandle(decodeURIComponent(rawUrl.slice(profilePrefix.length)));
    return handle ? { type: 'profile', handle } : null;
  }

  const publicationPrefix = 'atproto://publication/';
  if (rawUrl.startsWith(publicationPrefix)) {
    const rest = rawUrl.slice(publicationPrefix.length);
    const slash = rest.lastIndexOf('/');
    if (slash === -1) return null;
    const did = decodeURIComponent(rest.slice(0, slash));
    const rkey = decodeURIComponent(rest.slice(slash + 1));
    if (!did || !rkey || !did.startsWith('did:')) return null;
    return { type: 'publication', did, rkey };
  }

  return null;
}

function extractBlueskyHandle(url: URL): string | null {
  const host = url.hostname.toLowerCase();
  if (host !== 'bsky.app' && host !== 'staging.bsky.app') return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] !== 'profile' || !parts[1]) return null;
  return normalizeHandle(parts[1]);
}

function extractLinkedAtUri(html: string, rel: string): string | null {
  const linkRe = /<link\b[^>]*>/gi;
  for (const tag of html.match(linkRe) || []) {
    const relMatch = tag.match(/\brel\s*=\s*["']([^"']+)["']/i);
    if (!relMatch?.[1]?.split(/\s+/).includes(rel)) continue;
    const hrefMatch = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i);
    if (hrefMatch?.[1]?.startsWith('at://')) return hrefMatch[1];
  }
  return null;
}

function absoluteDocumentUrl(document: any, publication?: StandardPublication): string {
  const path = typeof document?.path === 'string' ? document.path : '';
  const site = document?.site;
  let base = '';

  if (publication?.url) {
    base = publication.url;
  } else if (typeof site === 'string' && site.startsWith('http')) {
    base = site;
  } else if (isRecord(site)) {
    const domain = typeof site.domain === 'string' ? site.domain : typeof site.hostname === 'string' ? site.hostname : '';
    if (domain) base = domain.startsWith('http') ? domain : `https://${domain}`;
  }

  if (!base) return '';
  try {
    const baseUrl = new URL(base);
    const normalizedBase = base.endsWith('/') ? base : `${base}/`;
    const normalizedPath = path.startsWith('/') && baseUrl.pathname !== '/' ? path.slice(1) : path || '/';
    return new URL(normalizedPath, normalizedBase).href;
  } catch {
    return '';
  }
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

async function fetchJson<T>(rawUrl: string, init: RequestInit = {}): Promise<T> {
  const res = await safeFetchExternal(rawUrl, {
    ...init,
    headers: {
      'User-Agent': UA,
      Accept: 'application/json',
      ...(init.headers || {}),
    },
    signal: init.signal || AbortSignal.timeout(FEED_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await readResponseText(res, 4096).catch(() => '');
    throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 120)}` : ''}`);
  }
  return JSON.parse(await readResponseText(res, MAX_DISCOVERY_BYTES)) as T;
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

export type FeedFormat = 'rss' | 'atom' | 'rdf' | 'unrecognized';

export interface ParsedFeed {
  format: FeedFormat;
  entries: Entry[];
}

export function parseFeedStructured(xml: string, feedId: string): ParsedFeed {
  const doc = parser.parse(xml);
  const entries: Entry[] = [];

  if (doc?.rss) {
    const rssItems = toArray(doc.rss.channel?.item);
    for (const item of rssItems) {
      const url = pickLink(item.link);
      const title = pickText(item.title) || 'Untitled';
      const published = pickDate(item.pubDate, item['dc:date']);
      entries.push(buildEntry(feedId, pickText(item.guid?.['#text'] || item.guid || url), url, title, published));
    }
    return { format: 'rss', entries };
  }

  if (doc?.feed) {
    const atomEntries = toArray(doc.feed.entry);
    for (const entry of atomEntries) {
      const url = pickLink(entry.link);
      const title = pickText(entry.title?.['#text'] || entry.title) || 'Untitled';
      const published = pickDate(entry.published, entry.updated);
      entries.push(buildEntry(feedId, pickText(entry.id || url), url, title, published));
    }
    return { format: 'atom', entries };
  }

  // RDF/RSS 1.0
  if (doc?.['rdf:RDF']) {
    const rdfItems = toArray(doc['rdf:RDF'].item);
    for (const item of rdfItems) {
      const url = pickLink(item.link);
      const title = pickText(item.title) || 'Untitled';
      const published = pickDate(item['dc:date'], item.pubDate);
      entries.push(buildEntry(feedId, pickText(item['@_rdf:about'] || url), url, title, published));
    }
    return { format: 'rdf', entries };
  }

  return { format: 'unrecognized', entries };
}

export function parseFeed(xml: string, feedId: string): Entry[] {
  return parseFeedStructured(xml, feedId).entries;
}

async function resolveHandle(handle: string): Promise<string> {
  const url = new URL('/xrpc/com.atproto.identity.resolveHandle', ATPROTO_IDENTITY);
  url.searchParams.set('handle', handle);
  const data = await fetchJson<{ did?: string }>(url.href);
  if (!data.did) throw new Error('Handle did not resolve');
  return data.did;
}

async function getProfile(actor: string): Promise<AtprotoProfile> {
  const url = new URL('/xrpc/app.bsky.actor.getProfile', ATPROTO_APPVIEW);
  url.searchParams.set('actor', actor);
  return await fetchJson<AtprotoProfile>(url.href);
}

async function getPdsEndpoint(did: string): Promise<string> {
  let doc: DidDocument;
  if (did.startsWith('did:plc:')) {
    doc = await fetchJson<DidDocument>(`${PLC_DIRECTORY}/${encodeURIComponent(did)}`);
  } else if (did.startsWith('did:web:')) {
    const id = did.slice('did:web:'.length).replace(/%3A/gi, ':');
    const parts = id.split(':').map(decodeURIComponent);
    const host = parts.shift();
    if (!host) throw new Error('Invalid did:web identifier');
    const path = parts.length ? `${parts.join('/')}/did.json` : '.well-known/did.json';
    doc = await fetchJson<DidDocument>(`https://${host}/${path}`);
  } else {
    throw new Error(`Unsupported DID method: ${did}`);
  }

  const endpoint = doc.service?.find(service => service.id === '#atproto_pds')?.serviceEndpoint;
  if (!endpoint || !isSafeExternalUrl(endpoint).ok) throw new Error('DID document has no safe PDS endpoint');
  return endpoint.replace(/\/+$/, '');
}

async function listAtprotoRecords<T>(pds: string, did: string, collection: string): Promise<AtprotoRecord<T>[]> {
  const records: AtprotoRecord<T>[] = [];
  let cursor = '';

  while (records.length < MAX_ATPROTO_RECORDS) {
    const url = new URL('/xrpc/com.atproto.repo.listRecords', pds);
    url.searchParams.set('repo', did);
    url.searchParams.set('collection', collection);
    url.searchParams.set('limit', String(Math.min(100, MAX_ATPROTO_RECORDS - records.length)));
    if (cursor) url.searchParams.set('cursor', cursor);

    const data = await fetchJson<{ records?: AtprotoRecord<T>[]; cursor?: string }>(url.href);
    records.push(...(data.records || []));
    if (!data.cursor || !data.records?.length) break;
    cursor = data.cursor;
  }

  return records;
}

async function getAtprotoRecord<T>(pds: string, did: string, collection: string, rkey: string): Promise<AtprotoRecord<T>> {
  const url = new URL('/xrpc/com.atproto.repo.getRecord', pds);
  url.searchParams.set('repo', did);
  url.searchParams.set('collection', collection);
  url.searchParams.set('rkey', rkey);
  return await fetchJson<AtprotoRecord<T>>(url.href);
}

async function resolvePublication(pds: string, publicationUri: string, cache: Map<string, StandardPublication>): Promise<StandardPublication | undefined> {
  if (cache.has(publicationUri)) return cache.get(publicationUri);
  const parsed = parseAtUri(publicationUri);
  if (!parsed || parsed.collection !== ATPROTO_PUBLICATION_COLLECTION) return undefined;
  try {
    const record = await getAtprotoRecord<StandardPublication>(pds, parsed.did, parsed.collection, parsed.rkey);
    cache.set(publicationUri, record.value);
    return record.value;
  } catch {
    return undefined;
  }
}

async function recordsToEntries(
  feedId: string,
  pds: string,
  records: AtprotoRecord[],
  publicationUri?: string,
): Promise<Entry[]> {
  const publications = new Map<string, StandardPublication>();
  const entries: Entry[] = [];

  for (const record of records) {
    const value = record.value || {};
    const site = typeof value.site === 'string' ? value.site : '';
    if (publicationUri && site !== publicationUri) continue;
    const publication = site.startsWith('at://') ? await resolvePublication(pds, site, publications) : undefined;
    const title = typeof value.title === 'string' && value.title.trim() ? value.title.trim() : 'Untitled';
    const published = pickDate(
      typeof value.publishedAt === 'string' ? value.publishedAt : undefined,
      typeof value.createdAt === 'string' ? value.createdAt : undefined,
    );
    entries.push(buildEntry(feedId, record.uri, absoluteDocumentUrl(value, publication), title, published));
  }

  return entries.sort((a, b) => publishedTime(b) - publishedTime(a));
}

async function fetchAtprotoFeed(feed: Feed): Promise<FeedFetchResult> {
  const parsed = parseAtprotoFeedUrl(feed.url);
  if (!parsed) return { entries: [], error: 'Invalid ATProto feed URL' };

  try {
    const did = parsed.type === 'profile' ? await resolveHandle(parsed.handle) : parsed.did;
    const pds = await getPdsEndpoint(did);
    const records = await listAtprotoRecords(pds, did, ATPROTO_DOCUMENT_COLLECTION);
    const publicationUri = parsed.type === 'publication'
      ? `at://${parsed.did}/${ATPROTO_PUBLICATION_COLLECTION}/${parsed.rkey}`
      : undefined;
    return { entries: await recordsToEntries(feed.id, pds, records, publicationUri) };
  } catch (e) {
    const msg = (e as Error).message || 'Unknown error';
    console.error(`Failed to fetch ${feed.label} (${feed.url}):`, msg);
    return { entries: [], error: msg };
  }
}

export async function fetchFeed(feed: Feed, meta: FeedCacheMeta = {}): Promise<FeedFetchResult> {
  if (parseAtprotoFeedUrl(feed.url)) return await fetchAtprotoFeed(feed);

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
    const parsed = parseFeedStructured(xml, feed.id);
    if (parsed.format === 'unrecognized') {
      return { entries: [], error: 'Unrecognized feed format', validators };
    }
    return { entries: parsed.entries, validators };
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

export async function probeFeed(url: string, label: string): Promise<{ ok: boolean; error?: string; entryCount: number }> {
  const result = await fetchFeed({ id: 'probe', url, label, folderId: null });
  if (result.error) return { ok: false, error: result.error, entryCount: 0 };
  return { ok: true, entryCount: result.entries.length };
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
      const feed = feeds[index];
      if (!feed) break;
      results[index] = await Promise.resolve(fetchFeed(feed, meta[feed.id])).then(
        value => ({ status: 'fulfilled', value }),
        reason => ({ status: 'rejected', reason }),
      );
      if (onFeedResult) {
        const result = results[index];
        await onFeedResult(feed, result?.status === 'fulfilled'
          ? result.value
          : { entries: [], error: (result?.reason as Error | undefined)?.message || 'Unknown error' });
      }
    }
  }

  const workerCount = Math.min(FETCH_CONCURRENCY, feeds.length);
  await Promise.all(Array.from({ length: workerCount }, worker));

  const all: Entry[] = [];
  const errors: Record<string, string> = {};
  const nextMeta: Record<string, FeedCacheMeta> = {};
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const feedId = feeds[i]?.id;
    if (!r || !feedId) continue;
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

async function resolvePublicationInput(publicationUri: string): Promise<ResolvedFeedInput | null> {
  const parsed = parseAtUri(publicationUri);
  if (!parsed || parsed.collection !== ATPROTO_PUBLICATION_COLLECTION) return null;
  const pds = await getPdsEndpoint(parsed.did);
  const record = await getAtprotoRecord<StandardPublication>(pds, parsed.did, parsed.collection, parsed.rkey);
  return {
    url: atprotoPublicationUrl(parsed.did, parsed.rkey),
    label: record.value.name || record.value.url || publicationUri,
  };
}

async function resolveDocumentInput(documentUri: string): Promise<ResolvedFeedInput | null> {
  const parsed = parseAtUri(documentUri);
  if (!parsed || parsed.collection !== ATPROTO_DOCUMENT_COLLECTION) return null;
  const pds = await getPdsEndpoint(parsed.did);
  const record = await getAtprotoRecord(pds, parsed.did, parsed.collection, parsed.rkey);
  const value = record.value as { site?: unknown } | undefined;
  const site = typeof value?.site === 'string' ? value.site : '';
  if (site.startsWith('at://')) return await resolvePublicationInput(site);

  const profile = await getProfile(parsed.did);
  return {
    url: atprotoProfileUrl(profile.handle),
    label: profile.displayName || profile.handle,
  };
}

async function resolveAtprotoPageInput(pageUrl: string): Promise<ResolvedFeedInput | null> {
  const res = await safeFetchExternal(pageUrl, {
    headers: { 'User-Agent': UA, Accept: 'text/html, application/xhtml+xml' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    await discardResponseBody(res);
    return null;
  }

  const html = await readResponseText(res, MAX_DISCOVERY_BYTES);
  const publicationUri = extractLinkedAtUri(html, ATPROTO_PUBLICATION_COLLECTION);
  if (publicationUri) return await resolvePublicationInput(publicationUri);

  const documentUri = extractLinkedAtUri(html, ATPROTO_DOCUMENT_COLLECTION);
  if (documentUri) return await resolveDocumentInput(documentUri);

  return null;
}

async function resolveActorInput(actor: string): Promise<ResolvedFeedInput | null> {
  const handle = normalizeHandle(actor);
  if (!handle) return null;
  const profile = await getProfile(handle);
  return {
    url: atprotoProfileUrl(profile.handle),
    label: profile.displayName || profile.handle,
  };
}

export async function resolveFeedInput(rawInput: string): Promise<ResolvedFeedInput> {
  const input = rawInput.trim();
  if (!input) throw new Error('Feed URL is required');

  if (input.startsWith('@')) {
    const actor = await resolveActorInput(input);
    if (actor) return actor;
  }

  if (input.startsWith('at://')) {
    const publication = await resolvePublicationInput(input);
    if (publication) return publication;
    const document = await resolveDocumentInput(input);
    if (document) return document;
  }

  let parsedUrl: URL | null = null;
  try {
    parsedUrl = new URL(input);
  } catch {}

  if (parsedUrl) {
    const blueskyHandle = extractBlueskyHandle(parsedUrl);
    if (blueskyHandle) {
      const actor = await resolveActorInput(blueskyHandle);
      if (actor) return actor;
    }

    if (parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:') {
      const standardSite = await resolveAtprotoPageInput(parsedUrl.href).catch(() => null);
      if (standardSite) return standardSite;

      const isDirectFeed = DIRECT_FEED_PATH_RE.test(parsedUrl.pathname) || DIRECT_FEED_ROUTE_RE.test(parsedUrl.pathname);
      const discoveredFeed = isDirectFeed
        ? parsedUrl.href
        : await discoverFeedUrl(parsedUrl.href);
      if (discoveredFeed) return { url: discoveredFeed, label: new URL(discoveredFeed).hostname };

      const hostnameActor = await resolveActorInput(parsedUrl.hostname).catch(() => null);
      if (hostnameActor) return hostnameActor;

      throw new Error('No RSS, Atom, JSON Feed, Standard Site metadata, or Bluesky handle found');
    }
  }

  const actor = await resolveActorInput(input).catch(() => null);
  if (actor) return actor;

  throw new Error('Enter an RSS/Atom URL, website URL, Bluesky handle, or Standard Site link');
}

export async function discoverFeedUrl(pageUrl: string): Promise<string | null> {
  try {
    const res = await safeFetchExternal(pageUrl, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const html = await readResponseText(res, MAX_DISCOVERY_BYTES);

    const linkRe = /<link[^>]+(?:application\/(?:rss|atom)\+xml|application\/feed\+json|text\/xml)[^>]*>/gi;
    const matches = html.match(linkRe);
    if (matches) {
      for (const m of matches) {
        const href = m.match(/href\s*=\s*["']([^"']+)["']/i);
        if (href?.[1]) {
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
      if (res.ok && (ct.includes('xml') || ct.includes('rss') || ct.includes('atom') || ct.includes('feed+json'))) {
        return base + path;
      }
    } catch {}
  }

  return null;
}
