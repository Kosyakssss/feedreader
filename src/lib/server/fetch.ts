// Fetches feeds: when to ask, how to ask, and Bluesky.
import { resolveTxt } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { parseFeed, parseDate, type Item } from './parse';
import type { Source, Store } from './store';

export type FetchResult = {
  items: Item[];
  title?: string;
  error?: string;
  etag?: string;
  lastModified?: string;
  retryAfter?: number;
  maxAge?: number;
};

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

const BASE = 5 * MINUTE;
const QUIET_MAX = HOUR;
const QUIET_FACTOR = 48;
const MAX_WAIT = 6 * HOUR;
const WAKE_SPREAD = 5 * SECOND;
const SAME_HOST_GAP = SECOND;
const START_SPREAD = MINUTE;
const WAIT_SPREAD = 30 * SECOND;
const WOKE_LATE = 30 * SECOND;

const MAX_FEED_BYTES = 10 * 1024 * 1024;
const TIMEOUT = 20 * SECOND;
const USER_AGENT = 'Lagan/0.4';
const ACCEPT = 'application/rss+xml, application/atom+xml, application/feed+json, application/xml, text/xml';

// ---- reaching only the public internet

const blocked = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['224.0.0.0', 3]] as const) blocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) blocked.addSubnet(address, prefix, 'ipv6');

function isPublic(address: string): boolean {
  const mapped = address.toLowerCase().replace(/^::ffff:/, '');
  const family = isIP(mapped);
  return family !== 0 && !blocked.check(mapped, family === 4 ? 'ipv4' : 'ipv6');
}

async function assertPublic(url: URL): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http and https are allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : (await Bun.dns.lookup(host)).map((found) => found.address);
  if (!addresses.length || !addresses.every(isPublic)) throw new Error('Not a public address');
}

// Every redirect is checked, so a feed can't send us to this machine or the tailnet.
async function safeFetch(start: string, headers: Record<string, string>): Promise<Response> {
  let url = new URL(start);
  for (let hop = 0; hop <= 5; hop++) {
    await assertPublic(url);
    const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT, ...headers }, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT) });
    const location = response.headers.get('location');
    if (response.status < 300 || response.status >= 400 || !location) return response;
    await response.body?.cancel();
    url = new URL(location, url);
  }
  throw new Error('Too many redirects');
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function readLimited(response: Response): Promise<Uint8Array> {
  const data = new Uint8Array(await response.arrayBuffer());
  if (data.length > MAX_FEED_BYTES) throw new Error('Feed too large');
  return data;
}

function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds * SECOND;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : date - Date.now();
}

function maxAge(value: string | null): number | undefined {
  const match = /max-age=(\d+)/i.exec(value ?? '');
  return match ? Number(match[1]) * SECOND : undefined;
}

async function fetchRss(source: Pick<Source, 'ref' | 'etag' | 'last_modified'>): Promise<FetchResult> {
  const headers: Record<string, string> = { Accept: ACCEPT };
  if (source.etag) headers['If-None-Match'] = source.etag;
  if (source.last_modified) headers['If-Modified-Since'] = source.last_modified;
  try {
    const response = await safeFetch(source.ref, headers);
    const timing = { retryAfter: retryAfter(response.headers.get('retry-after')), maxAge: maxAge(response.headers.get('cache-control')) };
    if (response.status === 304) {
      await response.body?.cancel();
      return { items: [], etag: source.etag, lastModified: source.last_modified, ...timing };
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      return { items: [], error: `HTTP ${response.status}`, ...timing };
    }
    const parsed = parseFeed(await readLimited(response), response.headers.get('content-type') ?? '', response.url);
    return { items: parsed.items, title: parsed.title, etag: response.headers.get('etag') ?? '', lastModified: response.headers.get('last-modified') ?? '', ...timing };
  } catch (error) {
    return { items: [], error: errorText(error) };
  }
}

// ---- Bluesky: posts are read straight from each account's public data server

type Json = Record<string, any>;
const identities = new Map<string, { pds: string; handle: string }>();

async function getJson(url: string): Promise<Json> {
  const response = await safeFetch(url, { Accept: 'application/json' });
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json() as Promise<Json>;
}

async function identity(did: string) {
  const known = identities.get(did);
  if (known) return known;
  const url = did.startsWith('did:web:') ? `https://${did.slice('did:web:'.length)}/.well-known/did.json` : `https://plc.directory/${did}`;
  const doc = await getJson(url);
  const pds = (doc.service as Json[] | undefined)?.find((service) => service.id?.endsWith('atproto_pds'))?.serviceEndpoint as string | undefined;
  if (!pds) throw new Error('No data server for this account');
  const aka = (doc.alsoKnownAs as string[] | undefined)?.find((name) => name.startsWith('at://'));
  const found = { pds, handle: aka ? aka.slice(5) : did };
  identities.set(did, found);
  return found;
}

async function record(uri: string) {
  const [did, collection, rkey] = uri.slice(5).split('/');
  if (!did || !collection || !rkey) return null;
  try {
    const { pds, handle } = await identity(did);
    const found = await getJson(`${pds}/xrpc/com.atproto.repo.getRecord?repo=${did}&collection=${collection}&rkey=${rkey}`);
    return { handle, value: found.value as Json };
  } catch {
    return null;
  }
}

async function describe(post: Json): Promise<string> {
  let text = typeof post.text === 'string' ? post.text : '';
  const embed = post.embed as Json | undefined;
  const external = embed?.external?.uri as string | undefined;
  if (external && !text.includes(external)) text += `\n${external}`;
  const quoted = (embed?.record?.record?.uri ?? embed?.record?.uri) as string | undefined;
  if (quoted) {
    const target = await record(quoted);
    if (target && typeof target.value.text === 'string') text += `\n\n@${target.handle}: ${target.value.text}`;
  }
  if (embed?.video || embed?.media?.video) text += '\n\n[video]';
  return text.trim();
}

function postUrl(uri: string): string {
  const [did, , rkey] = uri.slice(5).split('/');
  return `https://bsky.app/profile/${did}/post/${rkey}`;
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

async function fetchAtproto(did: string, since: number | null): Promise<FetchResult> {
  try {
    const { pds } = await identity(did);
    const list = (collection: string) => getJson(`${pds}/xrpc/com.atproto.repo.listRecords?repo=${did}&collection=${collection}&limit=50`);
    const [posts, reposts] = await Promise.all([list('app.bsky.feed.post'), list('app.bsky.feed.repost')]);
    const fresh = (time: number | null) => since === null || (time !== null && time >= since - 86_400_000);
    const items: Item[] = [];
    for (const { uri, value } of (posts.records ?? []) as { uri: string; value: Json }[]) {
      if (value.reply) continue;
      const published = parseDate(value.createdAt);
      const text = fresh(published) ? await describe(value) : String(value.text ?? '');
      items.push({ guid: uri, url: postUrl(uri), title: '', text: oneLine(text) || '[post]', published });
    }
    for (const { uri, value } of (reposts.records ?? []) as { uri: string; value: Json }[]) {
      const published = parseDate(value.createdAt);
      const subject = value.subject?.uri as string | undefined;
      if (!subject || !fresh(published)) continue;
      const target = await record(subject);
      if (target) items.push({ guid: uri, url: postUrl(subject), title: '', text: oneLine(`Reposted @${target.handle}: ${await describe(target.value)}`), published });
    }
    return { items };
  } catch (error) {
    return { items: [], error: errorText(error) };
  }
}

export function fetchSource(source: Source): Promise<FetchResult> {
  return source.kind === 'atproto' ? fetchAtproto(source.ref, source.fetched_at) : fetchRss(source);
}

async function resolveHandle(handle: string): Promise<string> {
  const records = await resolveTxt(`_atproto.${handle}`).catch(() => [] as string[][]);
  const fromDns = records.map((parts) => parts.join('')).find((value) => value.startsWith('did='));
  if (fromDns) return fromDns.slice(4);
  const response = await safeFetch(`https://${handle}/.well-known/atproto-did`, {});
  const did = (await response.text()).trim();
  if (response.status !== 200 || !did.startsWith('did:')) throw new Error('Could not find that account');
  return did;
}

// Turns what a person typed into a source to store.
export async function discover(input: string): Promise<Pick<Source, 'kind' | 'ref' | 'label'>> {
  const raw = input.trim();
  const profile = /bsky\.app\/profile\/([^/?#]+)/i.exec(raw)?.[1];
  const actor = raw.startsWith('did:') ? raw : raw.startsWith('@') ? raw.slice(1) : profile;
  if (actor) {
    const did = actor.startsWith('did:') ? actor : await resolveHandle(actor);
    const { handle } = await identity(did);
    return { kind: 'atproto', ref: did, label: `@${handle}` };
  }
  const ref = raw.includes('://') ? raw : `https://${raw}`;
  const result = await fetchRss({ ref, etag: '', last_modified: '' });
  if (result.error) throw new Error(result.error);
  return { kind: 'rss', ref, label: result.title || ref };
}

// ---- when to fetch

const clamp = (value: number, ceiling = MAX_WAIT) => Math.min(Math.max(value, BASE), ceiling);
const spread = (limit: number) => Math.random() * limit;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

export function earliestAfter(result: FetchResult, failures: number): number {
  if (result.retryAfter && result.retryAfter > 0) return clamp(result.retryAfter);
  if (result.error) return Math.min(BASE * 2 ** failures, MAX_WAIT);
  return clamp(result.maxAge ?? BASE);
}

// A feed silent for two days is fetched hourly, one that posted today every few minutes.
export const restFor = (quietFor: number, earliest: number) => Math.max(earliest, clamp(quietFor / QUIET_FACTOR, QUIET_MAX));

type Loop = { wake?: () => void; earliest: number };

export class Fetcher {
  private loops: Loop[] = [];
  private hostNext = new Map<string, number>();
  private lastNudge = 0;

  constructor(
    private store: Store,
    private onChange: (sourceId: number, added: number) => void,
  ) {}

  startAll(): void {
    for (const source of this.store.sources()) {
      const loop: Loop = { earliest: 0 };
      this.loops.push(loop);
      void this.run(source.id, loop);
    }
  }

  // Opening the app wakes every feed that is allowed to fetch again.
  nudge(): void {
    const now = Date.now();
    if (now - this.lastNudge < BASE) return;
    this.lastNudge = now;
    for (const loop of this.loops) if (now >= loop.earliest) loop.wake?.();
  }

  private async turn(host: string): Promise<void> {
    const start = Math.max(Date.now(), this.hostNext.get(host) ?? 0);
    this.hostNext.set(host, start + SAME_HOST_GAP);
    await sleep(start - Date.now());
  }

  private rest(loop: Loop, ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        loop.wake = undefined;
        resolve(false);
      }, ms);
      loop.wake = () => {
        clearTimeout(timer);
        loop.wake = undefined;
        resolve(true);
      };
    });
  }

  private async run(id: number, loop: Loop): Promise<void> {
    const first = this.store.source(id);
    if (first?.fetched_at != null) await this.rest(loop, Math.max(0, (first.next_at ?? 0) - Date.now()) + spread(START_SPREAD));
    for (;;) {
      const source = this.store.source(id);
      if (!source) return;
      await this.turn(source.kind === 'atproto' ? 'atproto' : new URL(source.ref).hostname);
      const result = await fetchSource(source);
      const failures = result.error ? source.failures + 1 : 0;
      const earliest = earliestAfter(result, failures);
      loop.earliest = Date.now() + earliest;
      const quietFor = source.kind === 'atproto' ? 0 : Date.now() - this.store.lastPost(id);
      const wait = restFor(quietFor, earliest);
      try {
        const added = this.store.save(source, result, failures, Date.now() + wait);
        if (added > 0 || (result.error ?? '') !== source.error) this.onChange(id, added);
      } catch (error) {
        console.error(`Feed ${source.label}: ${errorText(error)}`);
      }
      const asleep = wait + spread(WAIT_SPREAD);
      const started = Date.now();
      if (await this.rest(loop, asleep)) await sleep(spread(WAKE_SPREAD));
      else if (Date.now() - started - asleep > WOKE_LATE) await sleep(spread(START_SPREAD)); // the Mac slept
    }
  }
}
