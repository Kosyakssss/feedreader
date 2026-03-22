import { createServer } from 'node:http';

import {
  readFeeds, writeFeeds, readState, writeState, readConfig, writeConfig,
  readCache, writeCache, mergeSyncConflicts, pruneEntries, listThemes,
  readThemeCSS, generateId, getDataDir,
} from './lib/data.ts';
import { fetchAllFeeds, parseOPML, discoverFeedUrl, decodeHtmlEntities } from './lib/feeds.ts';
import { renderApp } from './lib/render.ts';
import type { EnrichedEntry, StateFile } from './lib/types.ts';
import { isSafeExternalUrl, sanitizeThemeName } from './lib/security.ts';
import { Defuddle } from 'defuddle/node';

const MAX_BODY_BYTES = 2 * 1024 * 1024;
let refreshing = false;

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function getEntries(feedFilter?: string): Promise<EnrichedEntry[]> {
  const [cache, state, feedsFile] = await Promise.all([readCache(), readState(), readFeeds()]);
  const feedMap = Object.fromEntries(feedsFile.feeds.map(f => [f.id, f.label]));
  let entries = cache.entries;
  if (feedFilter) entries = entries.filter(e => e.feedId === feedFilter);
  return entries
    .sort((a, b) => new Date(b.published).getTime() - new Date(a.published).getTime())
    .map(e => ({ ...e, title: decodeHtmlEntities(e.title), feedLabel: feedMap[e.feedId] || 'Unknown', state: state[e.id] || {} }));
}

async function refreshFeeds(): Promise<number> {
  await mergeSyncConflicts();
  const [feedsFile, cache, state, config] = await Promise.all([
    readFeeds(), readCache(), readState(), readConfig(),
  ]);
  const countBefore = cache.entries.length;
  const { entries: fresh, errors } = await fetchAllFeeds(feedsFile.feeds);
  const existing = new Set(cache.entries.map(e => e.id));
  for (const entry of fresh) {
    if (!existing.has(entry.id)) {
      cache.entries.push(entry);
      existing.add(entry.id);
    }
  }
  const now = Date.now();
  for (const f of feedsFile.feeds) cache.lastFetched[f.id] = now;
  if (!cache.feedErrors) cache.feedErrors = {};
  for (const f of feedsFile.feeds) {
    if (errors[f.id]) cache.feedErrors[f.id] = errors[f.id];
    else delete cache.feedErrors[f.id];
  }
  const pruned = pruneEntries(cache, state, config);
  await Promise.all([writeCache(pruned.cache), writeState(pruned.state)]);
  return Math.max(0, pruned.cache.entries.length - countBefore);
}

function parseBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const contentLength = Number(req.headers['content-length'] || 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      reject(new HttpError(413, 'Request body too large'));
      return;
    }

    const chunks: Buffer[] = [];
    let total = 0;
    let aborted = false;
    req.on('data', c => {
      if (aborted) return;
      chunks.push(c);
      total += c.length;
      if (total > MAX_BODY_BYTES) {
        aborted = true;
        reject(new HttpError(413, 'Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => { if (!aborted) resolve(Buffer.concat(chunks).toString()); });
    req.on('error', reject);
  });
}

async function parseJSONBody(req: import('node:http').IncomingMessage): Promise<any> {
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

function json(res: import('node:http').ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function err(res: import('node:http').ServerResponse, msg: string, status = 500) {
  json(res, { error: msg }, status);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

interface DefuddleResult {
  title?: string;
  author?: string;
  published?: string;
  site?: string;
  content?: string;
}

function renderReadPage(targetUrl: string, result: DefuddleResult): string {
  const safeUrlForText = escapeHtml(targetUrl);
  const title = result.title || '';
  const pageTitle = title ? escapeHtml(title) + ' · Feedreader' : 'Feedreader';
  const metaBits = [result.author, result.published, result.site].filter(Boolean);
  const content = result.content || '<p>No readable content found.</p>';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${pageTitle}</title>
${title ? `<meta property="og:title" content="${escapeHtml(title)}">\n` : ''}<meta property="og:site_name" content="Feedreader">
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 16px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; background: Canvas; color: CanvasText; }
  .bar { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; padding: 8px 14px; border-bottom: 1px solid color-mix(in srgb, CanvasText 15%, transparent); background: color-mix(in srgb, Canvas 92%, CanvasText 8%); }
  .bar a { color: inherit; text-decoration: none; border: 1px solid color-mix(in srgb, CanvasText 20%, transparent); border-radius: 8px; padding: 6px 10px; }
  .bar .url { opacity: .75; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: min(70vw, 900px); }
  .wrap { max-width: 640px; margin: 0 auto; padding: 24px 16px 40px; line-height: 1.7; font-size: 1.05rem; }
  .meta { margin-bottom: 18px; opacity: .8; font-size: .95rem; }
  article img, article video, article iframe { max-width: 100%; height: auto; }
  article pre { overflow: auto; padding: 14px 16px; border-radius: 8px; background: color-mix(in srgb, CanvasText 8%, Canvas); font-size: .9rem; line-height: 1.5; }
  article :not(pre) > code { padding: 2px 5px; border-radius: 4px; background: color-mix(in srgb, CanvasText 8%, Canvas); font-size: .9em; }
  article blockquote { margin: 1em 0; padding: 0 1em; border-left: 3px solid color-mix(in srgb, CanvasText 20%, transparent); }
  article table { border-collapse: collapse; width: 100%; }
  article th, article td { border: 1px solid color-mix(in srgb, CanvasText 15%, transparent); padding: 6px 10px; text-align: left; }
  article figure { margin: 1.5em 0; }
  article figcaption { font-size: .9rem; opacity: .7; margin-top: 6px; }
</style>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/github-dark-dimmed.min.css" media="(prefers-color-scheme:dark)">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/github.min.css" media="(prefers-color-scheme:light)">
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/highlight.min.js" defer></script>
</head>
<body>
  <div class="bar">
    <a href="/" target="_self">Timeline</a>
    <a href="${safeUrlForText}" target="_blank" rel="noopener">Open original ↗</a>
    <div class="url" title="${safeUrlForText}">${safeUrlForText}</div>
  </div>
  <main class="wrap">
    ${title ? `<h1>${escapeHtml(title)}</h1>` : ''}
    ${metaBits.length ? `<div class="meta">${escapeHtml(metaBits.join(' · '))}</div>` : ''}
    <article>${content}</article>
  </main>
  <script>document.addEventListener('DOMContentLoaded', () => { if (window.hljs) hljs.highlightAll(); });</script>
</body>
</html>`;
}



async function handleRequest(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method || 'GET';

  try {
    if (path === '/read' && method === 'GET') {
      const targetUrl = url.searchParams.get('url');
      if (!targetUrl) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Missing url query param');
      }
      const safeTarget = parseExternalUrlOrThrow(targetUrl);
      const pRes = await fetch(safeTarget, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Feedreader/1.0)' },
        signal: AbortSignal.timeout(15000),
      });
      if (!pRes.ok) throw new HttpError(502, `Upstream returned ${pRes.status}`);
      const html = await pRes.text();
      const result = await Defuddle(html, safeTarget.href);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(renderReadPage(targetUrl, result));
    }

    if (path === '/api/entries' && method === 'GET') {
      const feed = url.searchParams.get('feed') || undefined;
      return json(res, await getEntries(feed));
    }

    if (path === '/api/refresh' && method === 'POST') {
      if (refreshing) return json(res, { count: 0 });
      refreshing = true;
      try {
        const count = await refreshFeeds();
        return json(res, { count });
      } finally {
        refreshing = false;
      }
    }

    if (path === '/api/state' && method === 'POST') {
      const body = await parseJSONBody(req);
      if (!body || typeof body !== 'object' || typeof body.entries !== 'object' || Array.isArray(body.entries)) {
        throw new HttpError(400, 'Invalid state payload');
      }
      const state = await readState();
      const now = Date.now();
      for (const [id, updates] of Object.entries(body.entries as Record<string, any>)) {
        if (!updates || typeof updates !== 'object') continue;
        if (!state[id]) state[id] = {};
        if ('read' in updates && typeof updates.read === 'boolean') { state[id].read = updates.read; state[id].readAt = now; }
        if ('starred' in updates && typeof updates.starred === 'boolean') { state[id].starred = updates.starred; state[id].starredAt = now; }
      }
      await writeState(state);
      return json(res, { ok: true });
    }

    if (path === '/api/feeds' && method === 'GET') {
      const [feedsFile, cache] = await Promise.all([readFeeds(), readCache()]);
      const health: Record<string, { lastFetched: number | null; error: string | null }> = {};
      for (const f of feedsFile.feeds) {
        health[f.id] = {
          lastFetched: cache.lastFetched[f.id] || null,
          error: cache.feedErrors?.[f.id] || null,
        };
      }
      return json(res, { ...feedsFile, health });
    }

    if (path === '/api/feeds' && method === 'POST') {
      const body = await parseJSONBody(req);
      if (!body || typeof body !== 'object' || typeof body.url !== 'string') {
        throw new HttpError(400, 'Invalid feed payload');
      }
      let feedUrl: string = body.url.trim();
      if (!feedUrl) throw new HttpError(400, 'Feed URL is required');
      parseExternalUrlOrThrow(feedUrl);
      if (!feedUrl.match(/\.(xml|rss|atom)$/i) && !feedUrl.match(/\/(feed|rss|atom)\/?$/i)) {
        const discovered = await discoverFeedUrl(feedUrl);
        if (discovered) feedUrl = discovered;
      }
      parseExternalUrlOrThrow(feedUrl);
      const feedsFile = await readFeeds();
      if (feedsFile.feeds.some(f => f.url === feedUrl)) {
        return err(res, 'Feed already exists', 409);
      }
      const newFeed = {
        id: generateId(),
        url: feedUrl,
        label: typeof body.label === 'string' && body.label.trim() ? body.label.trim() : new URL(feedUrl).hostname,
        folderId: null,
      };
      feedsFile.feeds.push(newFeed);
      await writeFeeds(feedsFile);
      return json(res, newFeed, 201);
    }

    if (path.startsWith('/api/feeds/') && method === 'DELETE') {
      const id = path.slice('/api/feeds/'.length);
      const feedsFile = await readFeeds();
      feedsFile.feeds = feedsFile.feeds.filter(f => f.id !== id);
      const cache = await readCache();
      const removedIds = new Set(cache.entries.filter(e => e.feedId === id).map(e => e.id));
      cache.entries = cache.entries.filter(e => e.feedId !== id);
      delete cache.lastFetched[id];
      const state = await readState();
      for (const rid of removedIds) delete state[rid];
      await Promise.all([writeFeeds(feedsFile), writeCache(cache), writeState(state)]);
      return json(res, { ok: true });
    }

    if (path === '/api/feeds/import' && method === 'POST') {
      const raw = await parseBody(req);
      let opmlText = raw;
      const boundary = req.headers['content-type']?.match(/boundary=(.+)/)?.[1];
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
      const feedsFile = await readFeeds();
      const existingUrls = new Set(feedsFile.feeds.map(f => f.url));
      let added = 0;
      for (const f of imported) {
        if (!existingUrls.has(f.url)) {
          feedsFile.feeds.push({ id: generateId(), url: f.url, label: f.label, folderId: null });
          existingUrls.add(f.url);
          added++;
        }
      }
      await writeFeeds(feedsFile);
      return json(res, { added, skipped: imported.length - added });
    }

    if (path === '/api/feeds/export' && method === 'GET') {
      const feedsFile = await readFeeds();
      let opml = '<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n<head><title>Feedreader Export</title></head>\n<body>\n';
      for (const f of feedsFile.feeds) {
        opml += `  <outline type="rss" text="${escapeHtml(f.label)}" title="${escapeHtml(f.label)}" xmlUrl="${escapeHtml(f.url)}" />\n`;
      }
      opml += '</body>\n</opml>';
      res.writeHead(200, {
        'Content-Type': 'text/xml; charset=utf-8',
        'Content-Disposition': 'attachment; filename="feedreader.opml"',
      });
      return res.end(opml);
    }

    if (path === '/api/config' && method === 'GET') {
      return json(res, await readConfig());
    }

    if (path === '/api/config' && method === 'PUT') {
      const body = await parseJSONBody(req);
      if (!body || typeof body !== 'object') throw new HttpError(400, 'Invalid config payload');

      const patch: any = {};
      if ('defaultOpenAction' in body) {
        if (body.defaultOpenAction !== 'original' && body.defaultOpenAction !== 'defuddled') {
          throw new HttpError(400, 'Invalid defaultOpenAction');
        }
        patch.defaultOpenAction = body.defaultOpenAction;
      }
      if ('maxBulkOpen' in body) {
        if (!Number.isInteger(body.maxBulkOpen) || body.maxBulkOpen < 1 || body.maxBulkOpen > 500) {
          throw new HttpError(400, 'Invalid maxBulkOpen');
        }
        patch.maxBulkOpen = body.maxBulkOpen;
      }
      if ('port' in body) {
        if (!Number.isInteger(body.port) || body.port < 1 || body.port > 65535) {
          throw new HttpError(400, 'Invalid port');
        }
        patch.port = body.port;
      }
      if ('theme' in body) {
        if (body.theme === null || body.theme === '') {
          patch.theme = null;
        } else {
          const safeTheme = sanitizeThemeName(body.theme);
          if (!safeTheme) throw new HttpError(400, 'Invalid theme name');
          patch.theme = safeTheme;
        }
      }
      if ('retention' in body) {
        const r = body.retention;
        if (!r || typeof r !== 'object') throw new HttpError(400, 'Invalid retention config');
        const retentionPatch: any = {};
        if ('maxEntries' in r) {
          if (!Number.isInteger(r.maxEntries) || r.maxEntries < 100 || r.maxEntries > 100000) {
            throw new HttpError(400, 'Invalid retention.maxEntries');
          }
          retentionPatch.maxEntries = r.maxEntries;
        }
        if ('maxDays' in r) {
          if (r.maxDays !== null && (!Number.isInteger(r.maxDays) || r.maxDays < 1 || r.maxDays > 36500)) {
            throw new HttpError(400, 'Invalid retention.maxDays');
          }
          retentionPatch.maxDays = r.maxDays;
        }
        patch.retention = retentionPatch;
      }

      const updated = await writeConfig(patch);
      return json(res, updated);
    }

    if (path === '/api/themes' && method === 'GET') {
      return json(res, await listThemes());
    }

    if (path === '/api/theme' && method === 'GET') {
      const config = await readConfig();
      const themeName = config.theme || 'default';
      const css = await readThemeCSS(themeName);
      res.writeHead(200, { 'Content-Type': 'text/css' });
      return res.end(css);
    }

    if (path === '/api/defuddle' && method === 'GET') {
      const targetUrl = url.searchParams.get('url');
      if (!targetUrl) return err(res, 'Missing url param', 400);
      const safeTarget = parseExternalUrlOrThrow(targetUrl);
      const pRes = await fetch(safeTarget, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Feedreader/1.0)' },
        signal: AbortSignal.timeout(15000),
      });
      if (!pRes.ok) throw new HttpError(502, `Upstream returned ${pRes.status}`);
      const html = await pRes.text();
      const result = await Defuddle(html, safeTarget.href);
      return json(res, {
        title: result.title,
        author: result.author,
        published: result.published,
        site: result.site,
        content: result.content,
      });
    }

    // SPA: serve the app for all non-API routes
    const [config, themes] = await Promise.all([readConfig(), listThemes()]);
    const html = renderApp(config, themes);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);

  } catch (e) {
    if (e instanceof HttpError) {
      return err(res, e.message, e.status);
    }
    console.error('Request error:', e);
    err(res, (e as Error).message);
  }
}

async function main() {
  const config = await readConfig();
  const portArg = process.argv.indexOf('--port');
  const port = (portArg !== -1 && process.argv[portArg + 1]) ? parseInt(process.argv[portArg + 1]) : config.port;

  await mergeSyncConflicts();

  const server = createServer(handleRequest);
  server.listen(port, () => {
    console.log(`Feedreader running at http://localhost:${port}`);
  });
}

main();
