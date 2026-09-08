import type { Entry, Feed } from '../../types';
import { isSafeExternalUrl } from '../security';
import { buildEntry, isRecord, pickDate, publishedTime } from './parse';
import { fetchJson, type FeedFetchResult, type ResolvedFeedInput } from './transport';
const ATPROTO_APPVIEW = 'https://public.api.bsky.app';
const ATPROTO_IDENTITY = 'https://bsky.social';
const PLC_DIRECTORY = 'https://plc.directory';
const ATPROTO_DOCUMENT_COLLECTION = 'site.standard.document';
const ATPROTO_PUBLICATION_COLLECTION = 'site.standard.publication';
const MAX_ATPROTO_RECORDS = 1000;
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
  service?: {
    id?: string;
    serviceEndpoint?: string;
  }[];
}
interface AtprotoProfile {
  did: string;
  handle: string;
  displayName?: string;
}
interface AtprotoRecord<T = unknown> {
  uri: string;
  value: T;
}
interface StandardPublication {
  url?: string;
  name?: string;
}
function normalizeHandle(input: string): string | null {
  const handle = input.trim().replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(handle)) {
    return null;
  }
  return handle;
}
function parseAtUri(uri: string): {
  did: string;
  collection: string;
  rkey: string;
} | null {
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
export function extractBlueskyHandle(url: URL): string | null {
  const host = url.hostname.toLowerCase();
  if (host !== 'bsky.app' && host !== 'staging.bsky.app') return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] !== 'profile' || !parts[1]) return null;
  return normalizeHandle(parts[1]);
}
function absoluteDocumentUrl(document: unknown, publication?: StandardPublication): string {
  if (!isRecord(document)) return '';
  const path = typeof document.path === 'string' ? document.path : '';
  const site = document.site;
  let base = '';
  if (publication?.url) {
    base = publication.url;
  } else if (typeof site === 'string' && site.startsWith('http')) {
    base = site;
  } else if (isRecord(site)) {
    const domain =
      typeof site.domain === 'string' ? site.domain : typeof site.hostname === 'string' ? site.hostname : '';
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
async function resolveHandle(handle: string): Promise<string> {
  const url = new URL('/xrpc/com.atproto.identity.resolveHandle', ATPROTO_IDENTITY);
  url.searchParams.set('handle', handle);
  const data = await fetchJson<{
    did?: string;
  }>(url.href, {});
  if (!data.did) throw new Error('Handle did not resolve');
  return data.did;
}
async function getProfile(actor: string): Promise<AtprotoProfile> {
  const url = new URL('/xrpc/app.bsky.actor.getProfile', ATPROTO_APPVIEW);
  url.searchParams.set('actor', actor);
  return await fetchJson<AtprotoProfile>(url.href, {});
}
async function getPdsEndpoint(did: string): Promise<string> {
  let doc: DidDocument;
  if (did.startsWith('did:plc:')) {
    doc = await fetchJson<DidDocument>(`${PLC_DIRECTORY}/${encodeURIComponent(did)}`, {});
  } else if (did.startsWith('did:web:')) {
    const id = did.slice('did:web:'.length).replace(/%3A/gi, ':');
    const parts = id.split(':').map(decodeURIComponent);
    const host = parts.shift();
    if (!host) throw new Error('Invalid did:web identifier');
    const path = parts.length ? `${parts.join('/')}/did.json` : '.well-known/did.json';
    doc = await fetchJson<DidDocument>(`https://${host}/${path}`, {});
  } else {
    throw new Error(`Unsupported DID method: ${did}`);
  }
  const endpoint = doc.service?.find((service) => service.id === '#atproto_pds')?.serviceEndpoint;
  if (!endpoint || !isSafeExternalUrl(endpoint).ok) throw new Error('DID document has no safe PDS endpoint');
  return endpoint.replace(/\/+$/, '');
}
async function listAtprotoRecords<T>(
  pds: string,
  did: string,
  collection: string,
): Promise<AtprotoRecord<T>[]> {
  const records: AtprotoRecord<T>[] = [];
  let cursor = '';
  while (records.length < MAX_ATPROTO_RECORDS) {
    const url = new URL('/xrpc/com.atproto.repo.listRecords', pds);
    url.searchParams.set('repo', did);
    url.searchParams.set('collection', collection);
    url.searchParams.set('limit', String(Math.min(100, MAX_ATPROTO_RECORDS - records.length)));
    if (cursor) url.searchParams.set('cursor', cursor);
    const data = await fetchJson<{
      records?: AtprotoRecord<T>[];
      cursor?: string;
    }>(url.href, {});
    records.push(...(data.records || []));
    if (!data.cursor || !data.records?.length) break;
    cursor = data.cursor;
  }
  return records;
}
async function getAtprotoRecord<T>(
  pds: string,
  did: string,
  collection: string,
  rkey: string,
): Promise<AtprotoRecord<T>> {
  const url = new URL('/xrpc/com.atproto.repo.getRecord', pds);
  url.searchParams.set('repo', did);
  url.searchParams.set('collection', collection);
  url.searchParams.set('rkey', rkey);
  return await fetchJson<AtprotoRecord<T>>(url.href, {});
}
async function resolvePublication(
  pds: string,
  publicationUri: string,
  cache: Map<string, StandardPublication>,
): Promise<StandardPublication | undefined> {
  if (cache.has(publicationUri)) return cache.get(publicationUri);
  const parsed = parseAtUri(publicationUri);
  if (!parsed || parsed.collection !== ATPROTO_PUBLICATION_COLLECTION) return undefined;
  try {
    const record = await getAtprotoRecord<StandardPublication>(
      pds,
      parsed.did,
      parsed.collection,
      parsed.rkey,
    );
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
    const value = isRecord(record.value) ? record.value : {};
    const site = typeof value.site === 'string' ? value.site : '';
    if (publicationUri && site !== publicationUri) continue;
    const publication = site.startsWith('at://')
      ? await resolvePublication(pds, site, publications)
      : undefined;
    const title = typeof value.title === 'string' && value.title.trim() ? value.title.trim() : 'Untitled';
    const published = pickDate(
      typeof value.publishedAt === 'string' ? value.publishedAt : undefined,
      typeof value.createdAt === 'string' ? value.createdAt : undefined,
    );
    entries.push(buildEntry(feedId, record.uri, absoluteDocumentUrl(value, publication), title, published));
  }
  return entries.sort((a, b) => publishedTime(b) - publishedTime(a));
}
export async function fetchAtprotoFeed(feed: Feed): Promise<FeedFetchResult> {
  const parsed = parseAtprotoFeedUrl(feed.url);
  if (!parsed) return { entries: [], error: 'Invalid ATProto feed URL' };
  try {
    const did = parsed.type === 'profile' ? await resolveHandle(parsed.handle) : parsed.did;
    const pds = await getPdsEndpoint(did);
    const records = await listAtprotoRecords(pds, did, ATPROTO_DOCUMENT_COLLECTION);
    const publicationUri =
      parsed.type === 'publication'
        ? `at://${parsed.did}/${ATPROTO_PUBLICATION_COLLECTION}/${parsed.rkey}`
        : undefined;
    return { entries: await recordsToEntries(feed.id, pds, records, publicationUri) };
  } catch (e) {
    const msg = (e as Error).message || 'Unknown error';
    return { entries: [], error: msg };
  }
}
export async function resolvePublicationInput(publicationUri: string): Promise<ResolvedFeedInput | null> {
  const parsed = parseAtUri(publicationUri);
  if (!parsed || parsed.collection !== ATPROTO_PUBLICATION_COLLECTION) return null;
  const pds = await getPdsEndpoint(parsed.did);
  const record = await getAtprotoRecord<StandardPublication>(pds, parsed.did, parsed.collection, parsed.rkey);
  return {
    url: atprotoPublicationUrl(parsed.did, parsed.rkey),
    label: record.value.name || record.value.url || publicationUri,
  };
}
export async function resolveDocumentInput(documentUri: string): Promise<ResolvedFeedInput | null> {
  const parsed = parseAtUri(documentUri);
  if (!parsed || parsed.collection !== ATPROTO_DOCUMENT_COLLECTION) return null;
  const pds = await getPdsEndpoint(parsed.did);
  const record = await getAtprotoRecord<Record<string, unknown>>(
    pds,
    parsed.did,
    parsed.collection,
    parsed.rkey,
  );
  const site = typeof record.value.site === 'string' ? record.value.site : '';
  if (site.startsWith('at://')) return await resolvePublicationInput(site);
  const profile = await getProfile(parsed.did);
  return {
    url: atprotoProfileUrl(profile.handle),
    label: profile.displayName || profile.handle,
  };
}
export async function resolveActorInput(actor: string): Promise<ResolvedFeedInput | null> {
  const handle = normalizeHandle(actor);
  if (!handle) return null;
  const profile = await getProfile(handle);
  return {
    url: atprotoProfileUrl(profile.handle),
    label: profile.displayName || profile.handle,
  };
}
