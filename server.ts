import { join } from 'node:path';
import { stat } from 'node:fs/promises';

import {
  readFeeds, readState, updateState, readConfig, writeConfig,
  readCache, mergeSyncConflicts, pruneEntries,
  readThemeCSS, generateId, getDataDir, runDataMutation, writeDataFiles,
} from './lib/data.ts';
import { CONFIG_LIMITS, inLimit } from './lib/data.ts';
import { fetchAllFeeds, parseOPML, decodeHtmlEntities, probeFeed, publishedTime, resolveFeedInput } from './lib/feeds.ts';
import type { FeedFetchResult } from './lib/feeds.ts';
import { renderApp } from './lib/render.ts';
import { buildClientAssets, encodedAsset, encodedResponse, type ClientAssets, type EncodedAsset } from './lib/client-assets.ts';
import type { EnrichedEntry, Feed } from './lib/types.ts';
import { isSafeExternalUrl, isSafeObjectKey, sanitizeThemeName } from './lib/security.ts';

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const DEFAULT_HOST = '127.0.0.1';
const SERVE_BASE_PATH = '/feedreader';
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const SHUTDOWN_TIMEOUT_MS = 10_000;
let allowedHosts = new Set<string>();
let allowedOrigins = new Set<string>();
let clientAssets: ClientAssets | null = null;
let entriesSnapshot: { fingerprint: string; asset: EncodedAsset } | null = null;

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
let lastRefreshResult: { count: number; finishedAt: number; error: string | null } | null = null;
interface RefreshChange {
  sequence: number;
  entry: EnrichedEntry;
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
  const cache = await readCache();
  const [state, feedsFile] = await Promise.all([readState(cache), readFeeds()]);
  const feedMap = Object.fromEntries(feedsFile.feeds.map(f => [f.id, f.label]));
  let entries = cache.entries;
  if (feedFilter) entries = entries.filter(e => e.feedId === feedFilter);
  return entries
    .slice()
    .sort((a, b) => publishedTime(b) - publishedTime(a))
    .map(e => ({ ...e, url: safeEntryUrl(e.url), title: decodeHtmlEntities(e.title), feedLabel: feedMap[e.feedId] || 'Unknown', state: state[e.id] || {} }));
}

async function getFeedsWithHealth() {
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
}

async function refreshFeeds(progress: RefreshProgress): Promise<number> {
  await runDataMutation(() => mergeSyncConflicts());
  const [feedsFile, startingCache] = await Promise.all([readFeeds(), readCache()]);
  const startingState = await readState(startingCache);
  const feedsToFetch = feedsFile.feeds;
  progress.total = feedsToFetch.length;

  const existing = new Set(startingCache.entries.map(entry => entry.id));
  const existingSources = new Set(startingCache.entries.flatMap(entry => entry.sourceId ? [`${entry.feedId}\t${entry.sourceId}`] : []));
  const existingUrls = new Set(startingCache.entries.flatMap(entry => entry.url ? [`${entry.feedId}\t${entry.url}`] : []));
  const existingNoUrlTitles = new Set(startingCache.entries.flatMap(entry => !entry.url && entry.title ? [`${entry.feedId}\t${entry.title}`] : []));
  const completedResults: CompletedFeedResult[] = [];

  await fetchAllFeeds(feedsToFetch, startingCache.feedMeta, async (feed, result) => {
    completedResults.push({ feed, result, completedAt: Date.now() });
    progress.completed++;
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
  });

  const provisionalIds = new Set(progress.changes.map(change => change.entry.id));
  const merged = await mergeFeedResults(completedResults, provisionalIds);
  progress.added = merged.count;
  progress.removedIds = merged.removedIds;
  return merged.count;
}

async function mergeFeedResults(completedResults: CompletedFeedResult[], provisionalIds: Set<string>): Promise<{ count: number; removedIds: string[] }> {
  return runDataMutation(async () => {
    const [feedsFile, cache, config] = await Promise.all([
      readFeeds(), readCache(), readConfig(),
    ]);
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
    await writeDataFiles({ 'cache.json': pruned.cache, 'state.json': pruned.state });
    const retainedIds = new Set(pruned.cache.entries.map(entry => entry.id));
    const removedIds = [...new Set([...originalIds, ...provisionalIds])].filter(id => !retainedIds.has(id));
    return { count: addedIds.filter(id => retainedIds.has(id)).length, removedIds };
  });
}

function startRefresh(): Promise<number> {
  if (refreshJob) return refreshJob;
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
    removedIds: [],
  };
  refreshProgress = progress;
  refreshJob = refreshFeeds(progress)
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
    });
  return refreshJob;
}

function getRefreshStatus(since = 0) {
  const progress = refreshProgress;
  const cursor = progress?.changes.length || 0;
  return {
    refreshing: !!refreshJob,
    runId: progress?.runId || null,
    startedAt: progress?.startedAt || null,
    finishedAt: progress?.finishedAt || lastRefreshResult?.finishedAt || null,
    total: progress?.total || 0,
    completed: progress?.completed || 0,
    succeeded: progress?.succeeded || 0,
    failed: progress?.failed || 0,
    count: progress?.added ?? lastRefreshResult?.count ?? 0,
    error: progress?.error || lastRefreshResult?.error || null,
    failures: progress?.failures || [],
    cursor,
    newEntries: progress?.changes.filter(change => change.sequence > since).map(change => change.entry) || [],
    removedIds: !refreshJob ? progress?.removedIds || [] : [],
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

async function parseJSONBody(req: Request): Promise<any> {
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

    if (path === '/api/refresh' && method === 'POST') {
      startRefresh().catch(error => console.error('Refresh error:', error));
      return json(await getRefreshStatus(), 202);
    }

    if (path === '/api/refresh/status' && method === 'GET') {
      const rawSince = Number(url.searchParams.get('since') || 0);
      const since = Number.isSafeInteger(rawSince) && rawSince >= 0 ? rawSince : 0;
      return json(getRefreshStatus(since));
    }

    if (path === '/api/state' && method === 'POST') {
      const body = await parseJSONBody(req);
      if (!body || typeof body !== 'object' || !body.entries || typeof body.entries !== 'object' || Array.isArray(body.entries)) {
        throw new HttpError(400, 'Invalid state payload');
      }
      const now = Date.now();
      await runDataMutation(() => updateState((state) => {
        for (const [id, updates] of Object.entries(body.entries as Record<string, any>)) {
          if (!isSafeObjectKey(id)) throw new HttpError(400, 'Invalid entry id');
          if (!updates || typeof updates !== 'object') continue;
          if (!state[id]) state[id] = {};
          if ('read' in updates && typeof updates.read === 'boolean') { state[id].read = updates.read; state[id].readAt = now; }
          if ('starred' in updates && typeof updates.starred === 'boolean') { state[id].starred = updates.starred; state[id].starredAt = now; }
        }
        return state;
      }));
      return json({ ok: true });
    }

    if (path === '/api/feeds' && method === 'GET') {
      return json(await getFeedsWithHealth());
    }

    if (path === '/api/feeds' && method === 'POST') {
      const body = await parseJSONBody(req);
      if (!body || typeof body !== 'object' || typeof body.url !== 'string') {
        throw new HttpError(400, 'Invalid feed payload');
      }
      server.timeout(req, 120);
      const resolved = await resolveFeedInput(body.url).catch(error => {
        throw new HttpError(400, (error as Error).message || 'Could not resolve feed');
      });
      const feedUrl = resolved.url;
      const probe = await probeFeed(feedUrl, resolved.label).catch((error: unknown) => {
        throw new HttpError(400, `Feed could not be read: ${(error as Error)?.message || 'unknown error'}`);
      });
      if (!probe.ok) {
        throw new HttpError(400, `Feed could not be read: ${probe.error}`);
      }
      const newFeed = await runDataMutation(async () => {
        const feedsFile = await readFeeds();
        if (feedsFile.feeds.some(f => f.url === feedUrl)) {
          throw new HttpError(409, 'Feed already exists');
        }
        const feed = {
          id: generateId(),
          url: feedUrl,
          label: resolved.label,
          folderId: null,
        };
        feedsFile.feeds.push(feed);
        await writeDataFiles({ 'feeds.json': feedsFile });
        return feed;
      });
      return json(newFeed, 201);
    }

    if (path.startsWith('/api/feeds/') && method === 'DELETE') {
      const id = path.slice('/api/feeds/'.length);
      await runDataMutation(async () => {
        const feedsFile = await readFeeds();
        feedsFile.feeds = feedsFile.feeds.filter(f => f.id !== id);
        const cache = await readCache();
        const removedIds = new Set(cache.entries.filter(e => e.feedId === id).map(e => e.id));
        cache.entries = cache.entries.filter(e => e.feedId !== id);
        delete cache.lastFetched[id];
        delete cache.feedErrors[id];
        const state = await readState(cache);
        for (const rid of removedIds) delete state[rid];
        await writeDataFiles({ 'feeds.json': feedsFile, 'cache.json': cache, 'state.json': state });
      });
      return json({ ok: true });
    }

    if (path === '/api/feeds/import' && method === 'POST') {
      const raw = await parseBody(req);
      let opmlText = raw;
      const boundary = req.headers.get('content-type')?.match(/boundary=(.+)/)?.[1];
      if (boundary) {
        const parts = raw.split('--' + boundary);
        for (const part of parts) {
          const bodyStart = part.indexOf('\r\n\r\n');
          if (bodyStart !== -1) {
            const content = part.slice(bodyStart + 4).trim();
            if (content.includes('<opml') || content.includes('<outline')) {
              opmlText = content;
              break;
            }
          }
        }
      }
      const imported = parseOPML(opmlText);
      const added = await runDataMutation(async () => {
        const feedsFile = await readFeeds();
        const existingUrls = new Set(feedsFile.feeds.map(f => f.url));
        let count = 0;
        for (const f of imported) {
          let feedUrl: string;
          try {
            feedUrl = parseExternalUrlOrThrow(f.url).href;
          } catch {
            continue;
          }
          if (existingUrls.has(feedUrl)) continue;
          feedsFile.feeds.push({
            id: generateId(),
            url: feedUrl,
            label: f.label || new URL(feedUrl).hostname,
            folderId: null,
          });
          existingUrls.add(feedUrl);
          count++;
        }
        await writeDataFiles({ 'feeds.json': feedsFile });
        return count;
      });
      return json({ added, skipped: imported.length - added });
    }

    if (path === '/api/feeds/export' && method === 'GET') {
      const feedsFile = await readFeeds();
      let opml = '<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n<head><title>Feedreader Export</title></head>\n<body>\n';
      for (const f of feedsFile.feeds) {
        opml += `  <outline type="rss" text="${escapeHtml(f.label)}" title="${escapeHtml(f.label)}" xmlUrl="${escapeHtml(f.url)}" />\n`;
      }
      opml += '</body>\n</opml>';
      return new Response(opml, { headers: {
        'content-type': 'text/xml; charset=utf-8',
        'content-disposition': 'attachment; filename="feedreader.opml"',
      }});
    }

    if (path === '/api/config' && method === 'GET') {
      return json(await readConfig());
    }

    if (path === '/api/config' && method === 'PUT') {
      const body = await parseJSONBody(req);
      if (!body || typeof body !== 'object') throw new HttpError(400, 'Invalid config payload');

      const patch: any = {};
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
          if (!['system'].includes(safeTheme)) {
            throw new HttpError(400, 'Theme is not available');
          }
          patch.theme = safeTheme;
        }
      }
      if ('retention' in body) {
        const r = body.retention;
        if (!r || typeof r !== 'object') throw new HttpError(400, 'Invalid retention config');
        const retentionPatch: any = {};
        if ('maxEntries' in r) {
          if (typeof r.maxEntries !== 'number' || !inLimit(r.maxEntries, CONFIG_LIMITS.maxEntries)) {
            throw new HttpError(400, 'Invalid retention.maxEntries');
          }
          retentionPatch.maxEntries = r.maxEntries;
        }
        if ('maxDays' in r) {
          if (r.maxDays !== null && (typeof r.maxDays !== 'number' || !inLimit(r.maxDays, CONFIG_LIMITS.maxDays))) {
            throw new HttpError(400, 'Invalid retention.maxDays');
          }
          retentionPatch.maxDays = r.maxDays;
        }
        patch.retention = retentionPatch;
      }

      const updated = await runDataMutation(() => writeConfig(patch));
      return json(updated);
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
      const known = ['/api/health', '/api/entries', '/api/refresh', '/api/refresh/status', '/api/state',
        '/api/feeds', '/api/feeds/import', '/api/feeds/export', '/api/config', '/api/theme'];
      const isKnownResource = known.includes(path) || /^\/api\/feeds\/[^/]+$/.test(path);
      return err(isKnownResource ? 'Method not allowed' : 'Not found', isKnownResource ? 405 : 404);
    }

    // SPA: serve the app for all non-API routes
    const html = renderApp(renderBasePath(req, url.pathname));
    return new Response(html, { headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy':
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'",
    }});

  } catch (e) {
    if (e instanceof HttpError) {
      return err(e.message, e.status);
    }
    console.error('Request error:', e);
    return err((e as Error).message);
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
