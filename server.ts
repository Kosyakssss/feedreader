import { join } from 'node:path';
import { stat } from 'node:fs/promises';

import {
  CONFIG_LIMITS,
  readFeeds, readState, updateState, readConfig, writeConfig,
  readCache, mergeSyncConflicts, pruneEntries,
  readThemeCSS, generateId, getDataDir, runDataRead, runDataMutation, writeDataFiles,
  inLimit,
  type ConfigPatch,
} from './lib/data.ts';
import {
  fetchAllFeeds, fetchFeed, parseOPML, decodeHtmlEntities, publishedTime, resolveFeedInput,
  type FeedFetchResult,
} from './lib/feeds.ts';
import { renderApp } from './lib/render.ts';
import { pageChanges } from './lib/refresh-deltas.ts';
import { RefreshRequestQueue } from './lib/refresh-requests.ts';
import { buildClientAssets, encodedAsset, encodedResponse, type ClientAssets, type EncodedAsset } from './lib/client-assets.ts';
import type { Config, EnrichedEntry, EntryState, Feed } from './lib/types.ts';
import { isSafeExternalUrl, isSafeObjectKey, sanitizeThemeName } from './lib/security.ts';

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const DEFAULT_HOST = '127.0.0.1';
const SERVE_BASE_PATH = '/feedreader';
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const SHUTDOWN_TIMEOUT_MS = 10_000;
const MAX_ENTRY_DELTAS = 500;
const MAX_FEED_DELTAS = 250;
const SSE_KEEPALIVE_MS = 15_000;
let allowedHosts = new Set<string>();
let allowedOrigins = new Set<string>();
let clientAssets: ClientAssets | null = null;
let entriesSnapshot: { fingerprint: string; asset: EncodedAsset } | null = null;

type SharedTopic = 'sync' | 'refresh' | 'entries' | 'feeds' | 'config' | 'entry-state';

interface SharedEventPayload {
  topics: SharedTopic[];
  entryStates?: Record<string, EntryState>;
}

const sharedEventEncoder = new TextEncoder();
const sharedEventSubscribers = new Set<ReadableStreamDefaultController<Uint8Array>>();
let sharedEventId = 0;

function sharedEventChunk(id: number, payload: SharedEventPayload): Uint8Array {
  return sharedEventEncoder.encode(`id: ${id}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function enqueueSharedEvent(
  subscriber: ReadableStreamDefaultController<Uint8Array>,
  chunk: Uint8Array,
): boolean {
  try {
    subscriber.enqueue(chunk);
    return true;
  } catch {
    sharedEventSubscribers.delete(subscriber);
    return false;
  }
}

function publishSharedEvent(payload: SharedEventPayload): void {
  const chunk = sharedEventChunk(++sharedEventId, payload);
  for (const subscriber of sharedEventSubscribers) enqueueSharedEvent(subscriber, chunk);
}

function sharedEventsResponse(req: Request, server: Bun.Server<undefined>): Response {
  server.timeout(req, 0);
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const keepalive = setInterval(() => {
        enqueueSharedEvent(controller, sharedEventEncoder.encode(': keepalive\n\n'));
      }, SSE_KEEPALIVE_MS);
      keepalive.unref?.();
      cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(keepalive);
        sharedEventSubscribers.delete(controller);
      };
      sharedEventSubscribers.add(controller);
      enqueueSharedEvent(controller, sharedEventEncoder.encode('retry: 2000\n'));
      enqueueSharedEvent(controller, sharedEventChunk(sharedEventId, { topics: ['sync'] }));
      req.signal.addEventListener('abort', cleanup, { once: true });
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, { headers: {
    'cache-control': 'no-cache, no-transform',
    'connection': 'keep-alive',
    'content-type': 'text/event-stream; charset=utf-8',
    'x-accel-buffering': 'no',
  }});
}

function configureTrust(port: number, trustedOrigins: readonly string[]): void {
  allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
  allowedOrigins = new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`]);
  for (const origin of trustedOrigins) {
    try {
      const parsed = new URL(origin);
      const portSuffix = parsed.port ? `:${parsed.port}` : '';
      allowedHosts.add(`${parsed.hostname}${portSuffix}`);
      allowedOrigins.add(parsed.origin);
    } catch {}
  }
}

function assertTrustedHost(req: Request): void {
  const hostHeader = req.headers.get('host');
  if (!hostHeader?.trim()) {
    throw new HttpError(403, 'Missing Host header');
  }
  if (!allowedHosts.has(hostHeader.trim().toLowerCase())) {
    throw new HttpError(403, 'Unrecognized Host header');
  }
}

let refreshJob: Promise<number> | null = null;
let activeRefreshFeedIds = new Set<string>();
const queuedRefreshRequests = new RefreshRequestQueue();
let lastRefreshResult: { count: number; finishedAt: number; error: string | null } | null = null;
interface RefreshChange {
  sequence: number;
  entry: EnrichedEntry;
}

interface FeedResultChange {
  sequence: number;
  feedId: string;
  entryCount: number | null;
  error: string | null;
  completedAt: number;
}

interface RefreshProgress {
  runId: string;
  startedAt: number;
  finishedAt: number | null;
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  added: number;
  error: string | null;
  failures: { feedId: string; label: string; error: string }[];
  changes: RefreshChange[];
  feedResults: FeedResultChange[];
  removedIds: string[];
}

interface CompletedFeedResult {
  feed: Feed;
  result: FeedFetchResult;
  completedAt: number;
}

let refreshProgress: RefreshProgress | null = null;
const startedAt = new Date().toISOString();
let startupHost = DEFAULT_HOST;
let startupPort = 8787;

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function safeEntryUrl(rawUrl: string): string {
  const safe = isSafeExternalUrl(rawUrl);
  return safe.ok ? safe.url.href : '';
}

async function getEntries(feedFilter?: string): Promise<EnrichedEntry[]> {
  return runDataRead(async () => {
    const cache = await readCache();
    const [state, feedsFile] = await Promise.all([readState(cache), readFeeds()]);
    const feedMap = Object.fromEntries(feedsFile.feeds.map(f => [f.id, f.label]));
    let entries = cache.entries;
    if (feedFilter) entries = entries.filter(e => e.feedId === feedFilter);
    return entries
      .slice()
      .sort((a, b) => publishedTime(b) - publishedTime(a))
      .map(e => ({ ...e, url: safeEntryUrl(e.url), title: decodeHtmlEntities(e.title), feedLabel: feedMap[e.feedId] || 'Unknown', state: state[e.id] || {} }));
  });
}

async function getFeedsWithHealth() {
  return runDataRead(async () => {
    const [feedsFile, cache] = await Promise.all([readFeeds(), readCache()]);
    const entryCounts: Record<string, number> = {};
    for (const entry of cache.entries) {
      entryCounts[entry.feedId] = (entryCounts[entry.feedId] ?? 0) + 1;
    }
    const health: Record<string, { lastFetched: number | null; error: string | null; entryCount: number }> = {};
    for (const f of feedsFile.feeds) {
      health[f.id] = {
        lastFetched: cache.lastFetched[f.id] || null,
        error: cache.feedErrors?.[f.id] || null,
        entryCount: entryCounts[f.id] ?? 0,
      };
    }
    return { ...feedsFile, health };
  });
}

async function refreshFeeds(progress: RefreshProgress, initialFeedIds?: ReadonlySet<string>): Promise<number> {
  await mergeSyncConflicts();
  const { feedsFile, startingCache, startingState } = await runDataRead(async () => {
    const [nextFeeds, nextCache] = await Promise.all([readFeeds(), readCache()]);
    return {
      feedsFile: nextFeeds,
      startingCache: nextCache,
      startingState: await readState(nextCache),
    };
  });

  const existing = new Set(startingCache.entries.map(entry => entry.id));
  const existingSources = new Set(startingCache.entries.flatMap(entry => entry.sourceId ? [`${entry.feedId}\t${entry.sourceId}`] : []));
  const existingUrls = new Set(startingCache.entries.flatMap(entry => entry.url ? [`${entry.feedId}\t${entry.url}`] : []));
  const existingNoUrlTitles = new Set(startingCache.entries.flatMap(entry => !entry.url && entry.title ? [`${entry.feedId}\t${entry.title}`] : []));
  const completedResults: CompletedFeedResult[] = [];

  async function fetchBatch(feeds: Feed[]): Promise<void> {
    const batch = feeds.filter(feed => !activeRefreshFeedIds.has(feed.id));
    if (batch.length === 0) return;
    for (const feed of batch) activeRefreshFeedIds.add(feed.id);
    progress.total += batch.length;

    await fetchAllFeeds(batch, startingCache.feedMeta, async (feed, result) => {
      const completedAt = Date.now();
      completedResults.push({ feed, result, completedAt });
      progress.completed++;
      progress.feedResults.push({
        sequence: progress.feedResults.length + 1,
        feedId: feed.id,
        entryCount: result.notModified ? null : result.entries.length,
        error: result.error || null,
        completedAt,
      });
      if (result.error) {
        progress.failed++;
        progress.failures.push({ feedId: feed.id, label: feed.label, error: result.error });
      } else {
        progress.succeeded++;
      }

      for (const entry of result.entries) {
        if (entry.feedId !== feed.id || existing.has(entry.id)) continue;
        if (entry.sourceId && existingSources.has(`${entry.feedId}\t${entry.sourceId}`)) continue;
        if (entry.url && existingUrls.has(`${entry.feedId}\t${entry.url}`)) continue;
        if (!entry.url && entry.title && existingNoUrlTitles.has(`${entry.feedId}\t${entry.title}`)) continue;

        existing.add(entry.id);
        if (entry.sourceId) existingSources.add(`${entry.feedId}\t${entry.sourceId}`);
        if (entry.url) existingUrls.add(`${entry.feedId}\t${entry.url}`);
        if (!entry.url && entry.title) existingNoUrlTitles.add(`${entry.feedId}\t${entry.title}`);

        progress.changes.push({
          sequence: progress.changes.length + 1,
          entry: {
            ...entry,
            url: safeEntryUrl(entry.url),
            title: decodeHtmlEntities(entry.title),
            feedLabel: feed.label,
            state: startingState[entry.id] || {},
          },
        });
        progress.added++;
      }
      publishSharedEvent({ topics: ['refresh'] });
    });
  }

  const initialFeeds = initialFeedIds
    ? feedsFile.feeds.filter(feed => initialFeedIds.has(feed.id))
    : feedsFile.feeds;
  await fetchBatch(initialFeeds);

  let mergedThrough = 0;
  let added = 0;
  const removedIds = new Set<string>();
  while (true) {
    while (queuedRefreshRequests.pending) {
      const currentFeeds = await readFeeds();
      const queuedIds = queuedRefreshRequests.take(
        currentFeeds.feeds.map(feed => feed.id),
        activeRefreshFeedIds,
      );
      await fetchBatch(currentFeeds.feeds.filter(feed => queuedIds.has(feed.id)));
    }

    const pendingResults = completedResults.slice(mergedThrough);
    if (pendingResults.length > 0) {
      const provisionalIds = new Set(progress.changes.map(change => change.entry.id));
      const merged = await mergeFeedResults(pendingResults, provisionalIds);
      mergedThrough = completedResults.length;
      added += merged.count;
      for (const id of merged.removedIds) removedIds.add(id);
      progress.added = added;
      progress.removedIds = [...removedIds];
      publishSharedEvent({ topics: ['refresh'] });
    }

    if (!queuedRefreshRequests.pending) return added;
  }
}

async function mergeFeedResults(
  completedResults: CompletedFeedResult[],
  provisionalIds: Set<string>,
  feedToAdd?: Feed,
): Promise<{ count: number; removedIds: string[] }> {
  return runDataMutation(async () => {
    const [feedsFile, cache, config] = await Promise.all([
      readFeeds(), readCache(), readConfig(),
    ]);
    if (feedToAdd) {
      if (feedsFile.feeds.some(existingFeed => existingFeed.url === feedToAdd.url)) {
        throw new HttpError(409, 'Feed already exists');
      }
      feedsFile.feeds.unshift(feedToAdd);
    }
    const currentFeedIds = new Set(feedsFile.feeds.map(feed => feed.id));
    const originalIds = new Set(cache.entries.map(entry => entry.id));
    const existing = new Set(cache.entries.map(e => e.id));
    const existingSources = new Set(cache.entries.flatMap(e => e.sourceId ? [`${e.feedId}\t${e.sourceId}`] : []));
    const existingUrls = new Set(cache.entries.flatMap(e => e.url ? [`${e.feedId}\t${e.url}`] : []));
    const existingNoUrlTitles = new Set(cache.entries.flatMap(e => !e.url && e.title ? [`${e.feedId}\t${e.title}`] : []));
    const addedIds: string[] = [];

    for (const { feed, result, completedAt } of completedResults) {
      if (!currentFeedIds.has(feed.id)) continue;
      for (const entry of result.entries) {
        if (entry.feedId !== feed.id || existing.has(entry.id)) continue;
        if (entry.sourceId && existingSources.has(`${entry.feedId}\t${entry.sourceId}`)) continue;
        if (entry.url && existingUrls.has(`${entry.feedId}\t${entry.url}`)) continue;
        if (!entry.url && entry.title && existingNoUrlTitles.has(`${entry.feedId}\t${entry.title}`)) continue;
        cache.entries.push(entry);
        existing.add(entry.id);
        if (entry.sourceId) existingSources.add(`${entry.feedId}\t${entry.sourceId}`);
        if (entry.url) existingUrls.add(`${entry.feedId}\t${entry.url}`);
        if (!entry.url && entry.title) existingNoUrlTitles.add(`${entry.feedId}\t${entry.title}`);
        addedIds.push(entry.id);
      }

      cache.lastFetched[feed.id] = completedAt;
      const priorMeta = cache.feedMeta[feed.id] || {};
      if (result.error) {
        const failureCount = (priorMeta.failureCount || 0) + 1;
        cache.feedMeta[feed.id] = {
          ...priorMeta,
          failureCount,
        };
        cache.feedErrors[feed.id] = result.error;
      } else {
        cache.feedMeta[feed.id] = {
          ...priorMeta,
          ...(result.validators || {}),
          failureCount: 0,
        };
        delete cache.feedErrors[feed.id];
      }
    }

    for (const id of Object.keys(cache.lastFetched)) {
      if (!currentFeedIds.has(id)) delete cache.lastFetched[id];
    }
    for (const id of Object.keys(cache.feedErrors)) {
      if (!currentFeedIds.has(id)) delete cache.feedErrors[id];
    }
    for (const id of Object.keys(cache.feedMeta)) {
      if (!currentFeedIds.has(id)) delete cache.feedMeta[id];
    }

    const state = await readState(cache);
    const pruned = pruneEntries(cache, state, config);
    await writeDataFiles({
      ...(feedToAdd ? { 'feeds.json': feedsFile } : {}),
      'cache.json': pruned.cache,
      'state.json': pruned.state,
    });
    const retainedIds = new Set(pruned.cache.entries.map(entry => entry.id));
    const removedIds = [...new Set([...originalIds, ...provisionalIds])].filter(id => !retainedIds.has(id));
    return { count: addedIds.filter(id => retainedIds.has(id)).length, removedIds };
  });
}

function startRefresh(feedIds?: readonly string[]): Promise<number> {
  const requestedIds = feedIds ? new Set(feedIds) : undefined;
  if (refreshJob) {
    queuedRefreshRequests.enqueue(feedIds);
    return refreshJob;
  }
  activeRefreshFeedIds = new Set();
  queuedRefreshRequests.clear();
  const progress: RefreshProgress = {
    runId: generateId(),
    startedAt: Date.now(),
    finishedAt: null,
    total: 0,
    completed: 0,
    succeeded: 0,
    failed: 0,
    added: 0,
    error: null,
    failures: [],
    changes: [],
    feedResults: [],
    removedIds: [],
  };
  refreshProgress = progress;
  publishSharedEvent({ topics: ['refresh'] });
  refreshJob = refreshFeeds(progress, requestedIds)
    .then(count => {
      progress.finishedAt = Date.now();
      lastRefreshResult = { count, finishedAt: progress.finishedAt, error: null };
      return count;
    })
    .catch(error => {
      progress.error = (error as Error).message || 'Refresh failed';
      progress.finishedAt = Date.now();
      progress.removedIds = progress.changes.map(change => change.entry.id);
      progress.added = 0;
      lastRefreshResult = { count: 0, finishedAt: progress.finishedAt, error: progress.error };
      throw error;
    })
    .finally(() => {
      refreshJob = null;
      activeRefreshFeedIds = new Set();
      queuedRefreshRequests.clear();
      publishSharedEvent({ topics: ['refresh'] });
    });
  return refreshJob;
}

function getRefreshStatus(since = 0, feedsSince = 0) {
  const progress = refreshProgress;
  const entryPage = pageChanges(progress?.changes || [], since, MAX_ENTRY_DELTAS);
  const feedPage = pageChanges(progress?.feedResults || [], feedsSince, MAX_FEED_DELTAS);
  const hasMoreDeltas = entryPage.hasMore || feedPage.hasMore;
  const refreshing = !!refreshJob || hasMoreDeltas;
  return {
    refreshing,
    runId: progress?.runId || null,
    startedAt: progress?.startedAt || null,
    finishedAt: progress?.finishedAt || lastRefreshResult?.finishedAt || null,
    total: progress?.total || 0,
    completed: progress?.completed || 0,
    succeeded: progress?.succeeded || 0,
    failed: progress?.failed || 0,
    count: progress?.added ?? lastRefreshResult?.count ?? 0,
    error: progress?.error || lastRefreshResult?.error || null,
    failures: progress?.failures.slice(-100) || [],
    cursor: entryPage.cursor,
    feedCursor: feedPage.cursor,
    newEntries: entryPage.items.map(change => change.entry),
    feedResults: feedPage.items,
    removedIds: !refreshing ? progress?.removedIds || [] : [],
  };
}

async function getHealth() {
  return {
    ok: true,
    pid: process.pid,
    startedAt,
    uptimeSeconds: Math.round(process.uptime()),
    dataDir: getDataDir(),
    host: startupHost,
    port: startupPort,
    refreshing: !!refreshJob,
    lastRefreshResult,
  };
}

async function parseBody(req: Request): Promise<string> {
  const contentLength = Number(req.headers.get('content-length') || 0);
  let tooLarge = Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES;
  let total = 0;
  let text = '';
  const decoder = new TextDecoder();

  if (req.body) {
    for await (const chunk of req.body) {
      total += chunk.byteLength;
      if (total > MAX_BODY_BYTES) tooLarge = true;
      if (!tooLarge) text += decoder.decode(chunk, { stream: true });
    }
  }
  if (tooLarge) throw new HttpError(413, 'Request body too large');
  return text + decoder.decode();
}

function headerValue(req: Request, name: string): string {
  return req.headers.get(name) || '';
}

function hasJsonContentType(req: Request): boolean {
  const contentType = headerValue(req, 'content-type').split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return contentType === 'application/json' || contentType.endsWith('+json');
}

function requestHost(req: Request): string {
  return headerValue(req, 'x-forwarded-host').split(',', 1)[0]?.trim()
    || headerValue(req, 'host')
    || 'localhost';
}

function requestUrl(req: Request): URL {
  const host = requestHost(req);
  const forwardedProto = headerValue(req, 'x-forwarded-proto').split(',', 1)[0]?.trim().toLowerCase() ?? '';
  const proto = forwardedProto === 'https' ? 'https' : 'http';
  const incoming = new URL(req.url);
  return new URL(incoming.pathname + incoming.search, `${proto}://${host}`);
}

function appPath(path: string): string {
  if (path === SERVE_BASE_PATH) return '/';
  if (path.startsWith(SERVE_BASE_PATH + '/')) return path.slice(SERVE_BASE_PATH.length) || '/';
  return path;
}

function renderBasePath(req: Request, pathname: string): string {
  const host = requestHost(req).split(':', 1)[0]?.toLowerCase() ?? '';
  if (pathname.startsWith(SERVE_BASE_PATH) || host.endsWith('.ts.net')) return SERVE_BASE_PATH;
  return '';
}

async function parseJSONBody(req: Request): Promise<unknown> {
  if (!hasJsonContentType(req)) {
    throw new HttpError(415, 'Content-Type must be application/json');
  }
  const raw = await parseBody(req);
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'Malformed JSON body');
  }
}

function parseExternalUrlOrThrow(rawUrl: string): URL {
  const safe = isSafeExternalUrl(rawUrl);
  if (!safe.ok) throw new HttpError(400, safe.reason);
  return safe.url;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function err(msg: string, status = 500): Response {
  return json({ error: msg }, status);
}

function clientAssetResponse(req: Request, kind: keyof ClientAssets): Response {
  if (!clientAssets) return err('Client assets are unavailable', 503);
  return encodedResponse(
    req,
    clientAssets[kind],
    kind === 'script' ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8',
    { allowRange: true },
  );
}

function clientAssetVersion(): string {
  if (!clientAssets) return '';
  return `${clientAssets.script.etag}:${clientAssets.style.etag}`.replace(/[^a-zA-Z0-9_-]/g, '');
}

async function entriesResponse(req: Request, feed?: string): Promise<Response> {
  if (feed) return encodedJsonResponse(req, await getEntries(feed));
  const fingerprint = await dataFingerprint(['cache.json', 'state.json', 'feeds.json']);
  if (!entriesSnapshot || entriesSnapshot.fingerprint !== fingerprint) {
    const bytes = new TextEncoder().encode(JSON.stringify(await getEntries()));
    entriesSnapshot = { fingerprint, asset: encodedAsset(bytes) };
  }
  return encodedResponse(req, entriesSnapshot.asset, 'application/json; charset=utf-8');
}

function encodedJsonResponse(req: Request, data: unknown, status = 200): Response {
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  const response = encodedResponse(req, encodedAsset(bytes), 'application/json; charset=utf-8', { cacheControl: 'no-store' });
  return status === 200 ? response : new Response(response.body, { status, headers: response.headers });
}

async function dataFingerprint(files: string[]): Promise<string> {
  const parts = await Promise.all(files.map(async file => {
    try {
      const info = await stat(join(getDataDir(), file));
      return `${file}:${info.ino}:${info.size}:${info.mtimeMs}`;
    } catch {
      return `${file}:missing`;
    }
  }));
  return parts.join('|');
}

function assertTrustedRequest(req: Request): void {
  const secFetchSite = headerValue(req, 'sec-fetch-site').toLowerCase();
  if (secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'same-site' && secFetchSite !== 'none') {
    throw new HttpError(403, 'Cross-origin requests are not allowed');
  }

  // Exact-match against the configured origin allowlist. Never reconstruct
  // "our" origin from request headers: that let reflected Host/XFH values
  // authorize DNS-rebinding attacks.
  const origin = headerValue(req, 'origin');
  if (!origin) return;
  if (!allowedOrigins.has(origin.trim().toLowerCase())) {
    throw new HttpError(403, 'Cross-origin requests are not allowed');
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseStateUpdates(body: unknown): Record<string, Pick<EntryState, 'read' | 'starred'>> {
  if (!isRecord(body) || !isRecord(body.entries)) throw new HttpError(400, 'Invalid state payload');
  const parsed: Record<string, Pick<EntryState, 'read' | 'starred'>> = Object.create(null);
  for (const [id, value] of Object.entries(body.entries)) {
    if (!isSafeObjectKey(id)) throw new HttpError(400, 'Invalid entry id');
    if (!isRecord(value)) throw new HttpError(400, `Invalid state update for ${id}`);
    const update: Pick<EntryState, 'read' | 'starred'> = {};
    if ('read' in value) {
      if (typeof value.read !== 'boolean') throw new HttpError(400, `Invalid read state for ${id}`);
      update.read = value.read;
    }
    if ('starred' in value) {
      if (typeof value.starred !== 'boolean') throw new HttpError(400, `Invalid starred state for ${id}`);
      update.starred = value.starred;
    }
    if (!('read' in update) && !('starred' in update)) throw new HttpError(400, `Empty state update for ${id}`);
    parsed[id] = update;
  }
  return parsed;
}

async function updateEntryState(req: Request): Promise<Response> {
  const updates = parseStateUpdates(await parseJSONBody(req));
  const now = Date.now();
  await runDataMutation(async () => {
    const cache = await readCache();
    const knownIds = new Set(cache.entries.map(entry => entry.id));
    for (const change of refreshProgress?.changes ?? []) knownIds.add(change.entry.id);
    for (const id of Object.keys(updates)) {
      if (!knownIds.has(id)) throw new HttpError(400, `Unknown entry id: ${id}`);
    }
    await updateState((state) => {
      for (const [id, update] of Object.entries(updates)) {
        const next = state[id] ?? {};
        if (update.read !== undefined) {
          next.read = update.read;
          next.readAt = now;
        }
        if (update.starred !== undefined) {
          next.starred = update.starred;
          next.starredAt = now;
        }
        state[id] = next;
      }
      return state;
    }, cache);
  });
  const entryStates: Record<string, EntryState> = Object.create(null);
  for (const [id, update] of Object.entries(updates)) {
    entryStates[id] = {
      ...update,
      ...(update.read !== undefined ? { readAt: now } : {}),
      ...(update.starred !== undefined ? { starredAt: now } : {}),
    };
  }
  publishSharedEvent({ topics: ['entry-state'], entryStates });
  return json({ ok: true });
}

function parseConfigPatch(body: unknown): ConfigPatch {
  if (!isRecord(body)) throw new HttpError(400, 'Invalid config payload');
  const patch: ConfigPatch = {};
  if ('maxBulkOpen' in body) {
    if (typeof body.maxBulkOpen !== 'number' || !inLimit(body.maxBulkOpen, CONFIG_LIMITS.maxBulkOpen)) {
      throw new HttpError(400, 'Invalid maxBulkOpen');
    }
    patch.maxBulkOpen = body.maxBulkOpen;
  }
  if ('port' in body) {
    if (typeof body.port !== 'number' || !inLimit(body.port, CONFIG_LIMITS.port)) {
      throw new HttpError(400, 'Invalid port');
    }
    patch.port = body.port;
  }
  if ('theme' in body) {
    if (body.theme === null || body.theme === '') {
      patch.theme = 'system';
    } else {
      const safeTheme = sanitizeThemeName(body.theme);
      if (!safeTheme) throw new HttpError(400, 'Invalid theme name');
      if (safeTheme !== 'system') throw new HttpError(400, 'Theme is not available');
      patch.theme = safeTheme;
    }
  }
  if ('retention' in body) {
    if (!isRecord(body.retention)) throw new HttpError(400, 'Invalid retention config');
    const retention: Partial<Config['retention']> = {};
    if ('maxEntries' in body.retention) {
      const maxEntries = body.retention.maxEntries;
      if (typeof maxEntries !== 'number' || !inLimit(maxEntries, CONFIG_LIMITS.maxEntries)) {
        throw new HttpError(400, 'Invalid retention.maxEntries');
      }
      retention.maxEntries = maxEntries;
    }
    if ('maxDays' in body.retention) {
      const maxDays = body.retention.maxDays;
      if (maxDays !== null && (typeof maxDays !== 'number' || !inLimit(maxDays, CONFIG_LIMITS.maxDays))) {
        throw new HttpError(400, 'Invalid retention.maxDays');
      }
      retention.maxDays = maxDays as number | null;
    }
    patch.retention = retention;
  }
  return patch;
}

async function updateConfig(req: Request): Promise<Response> {
  const patch = parseConfigPatch(await parseJSONBody(req));
  const config = await writeConfig(patch);
  publishSharedEvent({ topics: ['config'] });
  return json(config);
}

async function addFeed(req: Request, server: Bun.Server<undefined>): Promise<Response> {
  const body = await parseJSONBody(req);
  if (!isRecord(body) || typeof body.url !== 'string') throw new HttpError(400, 'Invalid feed payload');
  server.timeout(req, 120);
  const resolved = await resolveFeedInput(body.url).catch(error => {
    throw new HttpError(400, (error as Error).message || 'Could not resolve feed');
  });
  const duplicate = await runDataRead(async () => (await readFeeds()).feeds.some(feed => feed.url === resolved.url));
  if (duplicate) throw new HttpError(409, 'Feed already exists');

  const created: Feed = {
    id: generateId(),
    url: resolved.url,
    label: resolved.label,
    folderId: null,
  };
  const result = await fetchFeed(created).catch((error: unknown) => {
    throw new HttpError(400, `Feed could not be read: ${(error as Error)?.message || 'unknown error'}`);
  });
  if (result.error) throw new HttpError(400, `Feed could not be read: ${result.error}`);

  const completedAt = Date.now();
  await mergeFeedResults([{ feed: created, result, completedAt }], new Set(), created);
  const entries = await getEntries(created.id);
  publishSharedEvent({ topics: ['feeds', 'entries'] });
  return json({
    feed: created,
    entries,
    health: { lastFetched: completedAt, error: null, entryCount: entries.length },
  }, 201);
}

async function deleteFeed(id: string): Promise<Response> {
  await runDataMutation(async () => {
    const feedsFile = await readFeeds();
    feedsFile.feeds = feedsFile.feeds.filter(feed => feed.id !== id);
    const cache = await readCache();
    const removedIds = new Set(cache.entries.filter(entry => entry.feedId === id).map(entry => entry.id));
    cache.entries = cache.entries.filter(entry => entry.feedId !== id);
    delete cache.lastFetched[id];
    delete cache.feedErrors[id];
    delete cache.feedMeta[id];
    const state = await readState(cache);
    for (const removedId of removedIds) delete state[removedId];
    await writeDataFiles({ 'feeds.json': feedsFile, 'cache.json': cache, 'state.json': state });
  });
  publishSharedEvent({ topics: ['feeds', 'entries'] });
  return json({ ok: true });
}

async function importFeeds(req: Request): Promise<Response> {
  const raw = await parseBody(req);
  let opmlText = raw;
  const boundary = req.headers.get('content-type')?.match(/boundary=(.+)/)?.[1];
  if (boundary) {
    for (const part of raw.split(`--${boundary}`)) {
      const bodyStart = part.indexOf('\r\n\r\n');
      if (bodyStart === -1) continue;
      const content = part.slice(bodyStart + 4).trim();
      if (content.includes('<opml') || content.includes('<outline')) {
        opmlText = content;
        break;
      }
    }
  }

  const imported = parseOPML(opmlText);
  const addedFeeds = await runDataMutation(async () => {
    const feedsFile = await readFeeds();
    const existingUrls = new Set(feedsFile.feeds.map(feed => feed.url));
    const created: Feed[] = [];
    for (const candidate of imported) {
      let feedUrl: string;
      try {
        feedUrl = parseExternalUrlOrThrow(candidate.url).href;
      } catch {
        continue;
      }
      if (existingUrls.has(feedUrl)) continue;
      created.push({
        id: generateId(),
        url: feedUrl,
        label: candidate.label || new URL(feedUrl).hostname,
        folderId: null,
      });
      existingUrls.add(feedUrl);
    }
    feedsFile.feeds.unshift(...created);
    await writeDataFiles({ 'feeds.json': feedsFile });
    return created;
  });
  if (addedFeeds.length > 0) {
    publishSharedEvent({ topics: ['feeds'] });
    void startRefresh(addedFeeds.map(feed => feed.id)).catch(error => console.error('Imported feed scan error:', error));
  }
  return json({ feeds: addedFeeds, added: addedFeeds.length, skipped: imported.length - addedFeeds.length });
}

async function exportFeeds(): Promise<Response> {
  const feedsFile = await readFeeds();
  const outlines = feedsFile.feeds.map(feed =>
    `  <outline type="rss" text="${escapeHtml(feed.label)}" title="${escapeHtml(feed.label)}" xmlUrl="${escapeHtml(feed.url)}" />`
  );
  const opml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    '<head><title>Feedreader Export</title></head>',
    '<body>',
    ...outlines,
    '</body>',
    '</opml>',
  ].join('\n');
  return new Response(opml, { headers: {
    'content-type': 'text/xml; charset=utf-8',
    'content-disposition': 'attachment; filename="feedreader.opml"',
  }});
}

async function handleRequest(req: Request, server: Bun.Server<undefined>): Promise<Response> {
  try {
    assertTrustedHost(req);
    const url = requestUrl(req);
    const path = appPath(url.pathname);
    const method = req.method;

    if (MUTATING_METHODS.has(method)) assertTrustedRequest(req);

    if (path === '/api/health' && method === 'GET') {
      return json(await getHealth());
    }

    if (path === '/api/entries' && method === 'GET') {
      const feed = url.searchParams.get('feed') || undefined;
      return await entriesResponse(req, feed);
    }

    if (path === '/api/events' && method === 'GET') {
      return sharedEventsResponse(req, server);
    }

    if (path === '/api/refresh' && method === 'POST') {
      let feedIds: string[] | undefined;
      if (req.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
        const body = await parseJSONBody(req);
        if (!isRecord(body) || !Array.isArray(body.feedIds) || !body.feedIds.every(id => typeof id === 'string')) {
          throw new HttpError(400, 'Invalid refresh payload');
        }
        feedIds = body.feedIds;
      }
      startRefresh(feedIds).catch(error => console.error('Refresh error:', error));
      return json(await getRefreshStatus(), 202);
    }

    if (path === '/api/refresh/status' && method === 'GET') {
      const rawSince = Number(url.searchParams.get('since') || 0);
      const since = Number.isSafeInteger(rawSince) && rawSince >= 0 ? rawSince : 0;
      const rawFeedsSince = Number(url.searchParams.get('feedsSince') || 0);
      const feedsSince = Number.isSafeInteger(rawFeedsSince) && rawFeedsSince >= 0 ? rawFeedsSince : 0;
      return json(getRefreshStatus(since, feedsSince));
    }

    if (path === '/api/state' && method === 'POST') {
      return await updateEntryState(req);
    }

    if (path === '/api/feeds' && method === 'GET') {
      return json(await getFeedsWithHealth());
    }

    if (path === '/api/feeds' && method === 'POST') {
      return await addFeed(req, server);
    }

    if (path.startsWith('/api/feeds/') && method === 'DELETE') {
      return await deleteFeed(path.slice('/api/feeds/'.length));
    }

    if (path === '/api/feeds/import' && method === 'POST') {
      return await importFeeds(req);
    }

    if (path === '/api/feeds/export' && method === 'GET') {
      return await exportFeeds();
    }

    if (path === '/api/config' && method === 'GET') {
      return json(await readConfig());
    }

    if (path === '/api/config' && method === 'PUT') {
      return await updateConfig(req);
    }

    if (path === '/api/theme' && method === 'GET') {
      const config = await readConfig();
      const themeName = config.theme || 'system';
      const css = await readThemeCSS(themeName);
      return new Response(css, { headers: { 'content-type': 'text/css' } });
    }

    if (path === '/app.js' && method === 'GET') {
      return clientAssetResponse(req, 'script');
    }

    if (path === '/app.css' && method === 'GET') {
      return clientAssetResponse(req, 'style');
    }

    if (path.startsWith('/api/')) {
      // Known API resources respond 405 (not 404) on wrong methods.
      const known = ['/api/health', '/api/entries', '/api/events', '/api/refresh', '/api/refresh/status', '/api/state',
        '/api/feeds', '/api/feeds/import', '/api/feeds/export', '/api/config', '/api/theme'];
      const isKnownResource = known.includes(path) || /^\/api\/feeds\/[^/]+$/.test(path);
      return err(isKnownResource ? 'Method not allowed' : 'Not found', isKnownResource ? 405 : 404);
    }

    // SPA: serve the app for all non-API routes
    const html = renderApp(renderBasePath(req, url.pathname), clientAssetVersion());
    return new Response(html, { headers: {
      'cache-control': 'no-cache',
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy':
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'",
    }});

  } catch (e) {
    if (e instanceof HttpError) {
      return err(e.message, e.status);
    }
    console.error('Request error:', e);
    return err('Internal server error');
  }
}

function describeListenError(error: unknown, host: string, port: number): string {
  const code = typeof error === 'object' && error && 'code' in error ? (error as { code?: unknown }).code : undefined;
  if (code === 'EADDRINUSE') {
    return `Port ${port} is already in use on ${host}. Stop the other Feedreader process or change data/config.json port.`;
  }
  if (code === 'EACCES') {
    return `Cannot bind to ${host}:${port}; permission denied.`;
  }
  return (error as Error).message || String(error);
}

function installShutdownHandlers(server: Bun.Server<undefined>) {
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}; shutting down Feedreader`);

    const forceExit = setTimeout(() => {
      console.error('Timed out waiting for Feedreader to shut down');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref?.();

    try {
      const stopped = server.stop();
      if (refreshJob) await refreshJob.catch(() => undefined);
      await stopped;
      clearTimeout(forceExit);
      process.exit(0);
    } catch (error) {
      console.error('Error while closing Feedreader:', error);
      process.exit(1);
    }
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

async function main() {
  if (!Bun.semver.satisfies(Bun.version, '>=1.4.0')) {
    throw new Error(`Bun 1.4.0 or newer is required; found ${Bun.version}`);
  }
  const config = await readConfig();
  const portArg = process.argv.indexOf('--port');
  const portRaw = portArg !== -1 ? process.argv[portArg + 1] : undefined;
  const port = portRaw ? parseInt(portRaw) : config.port;
  const hostArg = process.argv.indexOf('--host');
  const hostRaw = hostArg !== -1 ? process.argv[hostArg + 1] : undefined;
  const host = hostRaw || DEFAULT_HOST;
  configureTrust(port, config.trustedOrigins);
  startupHost = host;
  startupPort = port;

  clientAssets = await buildClientAssets();

  await mergeSyncConflicts();

  const server = Bun.serve({
    hostname: host,
    port,
    reusePort: false,
    idleTimeout: 10,
    development: false,
    fetch: handleRequest,
    error(error) {
      console.error('Server error:', error);
      return err('Internal server error');
    },
  });
  installShutdownHandlers(server);

  const displayHost = host === DEFAULT_HOST ? 'localhost' : host;
  console.log(`Feedreader running at http://${displayHost}:${port}`);
  startRefresh().catch(error => console.error('Startup refresh error:', error));
}

process.on('unhandledRejection', reason => {
  console.error('Unhandled rejection:', reason);
});

process.on('uncaughtException', error => {
  console.error('Uncaught exception:', error);
  process.exit(1);
});

main().catch(error => {
  console.error('Feedreader failed to start:', describeListenError(error, startupHost, startupPort));
  process.exit(1);
});
