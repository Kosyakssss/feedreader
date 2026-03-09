import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  readFeeds, writeFeeds, readState, writeState, readConfig, writeConfig,
  readCache, writeCache, mergeSyncConflicts, pruneEntries, listThemes,
  readThemeCSS, generateId, getDataDir,
} from './lib/data.ts';
import { fetchAllFeeds, parseOPML, discoverFeedUrl } from './lib/feeds.ts';
import { renderApp } from './lib/render.ts';
import type { EnrichedEntry, StateFile } from './lib/types.ts';

async function getEntries(feedFilter?: string): Promise<EnrichedEntry[]> {
  const [cache, state, feedsFile] = await Promise.all([readCache(), readState(), readFeeds()]);
  const feedMap = Object.fromEntries(feedsFile.feeds.map(f => [f.id, f.label]));
  let entries = cache.entries;
  if (feedFilter) entries = entries.filter(e => e.feedId === feedFilter);
  return entries
    .sort((a, b) => new Date(b.published).getTime() - new Date(a.published).getTime())
    .map(e => ({ ...e, feedLabel: feedMap[e.feedId] || 'Unknown', state: state[e.id] || {} }));
}

async function refreshFeeds(): Promise<number> {
  await mergeSyncConflicts();
  const [feedsFile, cache, state, config] = await Promise.all([
    readFeeds(), readCache(), readState(), readConfig(),
  ]);
  const fresh = await fetchAllFeeds(feedsFile.feeds);
  const existing = new Set(cache.entries.map(e => e.id));
  let added = 0;
  for (const entry of fresh) {
    if (!existing.has(entry.id)) {
      cache.entries.push(entry);
      existing.add(entry.id);
      added++;
    }
  }
  const now = Date.now();
  for (const f of feedsFile.feeds) cache.lastFetched[f.id] = now;
  const pruned = pruneEntries(cache, state, config);
  await Promise.all([writeCache(pruned.cache), writeState(pruned.state)]);
  return added;
}

function parseBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
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

function renderReadPage(targetUrl: string): string {
  const safeUrl = JSON.stringify(targetUrl);
  const safeUrlForText = escapeHtml(targetUrl);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Defuddled Reader</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 16px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; background: Canvas; color: CanvasText; }
  .bar { position: sticky; top: 0; z-index: 10; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; padding: 10px 14px; border-bottom: 1px solid color-mix(in srgb, CanvasText 15%, transparent); background: color-mix(in srgb, Canvas 92%, CanvasText 8%); }
  .bar a { color: inherit; text-decoration: none; border: 1px solid color-mix(in srgb, CanvasText 20%, transparent); border-radius: 8px; padding: 6px 10px; }
  .bar .url { opacity: .75; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: min(70vw, 900px); }
  .wrap { max-width: 820px; margin: 0 auto; padding: 24px 16px 40px; }
  .meta { margin-bottom: 18px; opacity: .8; font-size: .95rem; }
  #status { margin: 24px 0; opacity: .8; }
  article img, article video, article iframe { max-width: 100%; height: auto; }
  article pre { overflow: auto; }
</style>
</head>
<body>
  <div class="bar">
    <a href="/" target="_self">Timeline</a>
    <a id="open-original" href="${safeUrlForText}" target="_blank" rel="noopener">Open original ↗</a>
    <div class="url" title="${safeUrlForText}">${safeUrlForText}</div>
  </div>
  <main class="wrap">
    <div id="status">Loading clean article view…</div>
    <h1 id="title" hidden></h1>
    <div id="meta" class="meta" hidden></div>
    <article id="content"></article>
  </main>
  <script src="/vendor/defuddle.js"></script>
  <script>
    const targetUrl = ${safeUrl};
    const statusEl = document.getElementById('status');
    const titleEl = document.getElementById('title');
    const metaEl = document.getElementById('meta');
    const contentEl = document.getElementById('content');

    (async () => {
      try {
        const response = await fetch('/api/proxy?url=' + encodeURIComponent(targetUrl));
        if (!response.ok) throw new Error('Proxy failed: ' + response.status);
        const html = await response.text();

        const iframe = document.createElement('iframe');
        iframe.style.display = 'none';
        iframe.sandbox = 'allow-same-origin';
        iframe.srcdoc = html;
        document.body.appendChild(iframe);
        await new Promise((resolve, reject) => {
          iframe.onload = () => resolve();
          iframe.onerror = () => reject(new Error('Failed to parse article document'));
        });

        const DefuddleCtor = window.Defuddle?.default || window.Defuddle;
        if (!DefuddleCtor) throw new Error('Defuddle bundle not available');
        const parser = new DefuddleCtor(iframe.contentDocument, { url: targetUrl });
        const result = parser.parseAsync ? await parser.parseAsync() : parser.parse();
        iframe.remove();

        const title = result?.title || '';
        const bits = [result?.author, result?.published, result?.site].filter(Boolean);
        if (title) {
          titleEl.textContent = title;
          titleEl.hidden = false;
          document.title = title + ' · Defuddled Reader';
        }
        if (bits.length) {
          metaEl.textContent = bits.join(' · ');
          metaEl.hidden = false;
        }
        contentEl.innerHTML = result?.content || '<p>No readable content found.</p>';
        statusEl.remove();
      } catch (error) {
        statusEl.textContent = 'Could not create defuddled view. Open the original article instead.';
        console.error(error);
      }
    })();
  </script>
</body>
</html>`;
}

async function serveDefuddleBundle(res: import('node:http').ServerResponse) {
  try {
    const bundlePath = join(getDataDir(), '..', 'node_modules', 'defuddle', 'dist', 'index.js');
    const code = await readFile(bundlePath, 'utf-8');
    res.writeHead(200, { 'Content-Type': 'application/javascript' });
    res.end(code);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
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
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(renderReadPage(targetUrl));
    }

    if (path === '/api/entries' && method === 'GET') {
      const feed = url.searchParams.get('feed') || undefined;
      const cache = await readCache();
      const staleMs = 5 * 60 * 1000;
      const anyStale = Object.values(cache.lastFetched).some(t => Date.now() - t > staleMs);
      if (Object.keys(cache.lastFetched).length === 0 || anyStale) {
        await refreshFeeds();
      }
      return json(res, await getEntries(feed));
    }

    if (path === '/api/refresh' && method === 'POST') {
      const count = await refreshFeeds();
      return json(res, { count });
    }

    if (path === '/api/state' && method === 'POST') {
      const body = JSON.parse(await parseBody(req));
      const state = await readState();
      const now = Date.now();
      for (const [id, updates] of Object.entries(body.entries as Record<string, any>)) {
        if (!state[id]) state[id] = {};
        if ('read' in updates) { state[id].read = updates.read; state[id].readAt = now; }
        if ('starred' in updates) { state[id].starred = updates.starred; state[id].starredAt = now; }
      }
      await writeState(state);
      return json(res, { ok: true });
    }

    if (path === '/api/feeds' && method === 'GET') {
      return json(res, await readFeeds());
    }

    if (path === '/api/feeds' && method === 'POST') {
      const body = JSON.parse(await parseBody(req));
      let feedUrl: string = body.url;
      if (!feedUrl.match(/\.(xml|rss|atom)$/i) && !feedUrl.match(/\/(feed|rss|atom)\/?$/i)) {
        const discovered = await discoverFeedUrl(feedUrl);
        if (discovered) feedUrl = discovered;
      }
      const feedsFile = await readFeeds();
      if (feedsFile.feeds.some(f => f.url === feedUrl)) {
        return err(res, 'Feed already exists', 409);
      }
      const newFeed = { id: generateId(), url: feedUrl, label: body.label || new URL(feedUrl).hostname, folderId: null };
      feedsFile.feeds.push(newFeed);
      await writeFeeds(feedsFile);
      return json(res, newFeed, 201);
    }

    if (path.startsWith('/api/feeds/') && method === 'DELETE') {
      const id = path.slice('/api/feeds/'.length);
      const feedsFile = await readFeeds();
      feedsFile.feeds = feedsFile.feeds.filter(f => f.id !== id);
      const cache = await readCache();
      cache.entries = cache.entries.filter(e => e.feedId !== id);
      delete cache.lastFetched[id];
      await Promise.all([writeFeeds(feedsFile), writeCache(cache)]);
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

    if (path === '/api/config' && method === 'GET') {
      return json(res, await readConfig());
    }

    if (path === '/api/config' && method === 'PUT') {
      const body = JSON.parse(await parseBody(req));
      const updated = await writeConfig(body);
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

    if (path === '/api/proxy' && method === 'GET') {
      const targetUrl = url.searchParams.get('url');
      if (!targetUrl) return err(res, 'Missing url param', 400);
      const pRes = await fetch(targetUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Feedreader/1.0)' },
        signal: AbortSignal.timeout(15000),
      });
      const html = await pRes.text();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    if (path === '/vendor/defuddle.js') {
      return await serveDefuddleBundle(res);
    }

    // SPA: serve the app for all non-API routes
    const [config, themes] = await Promise.all([readConfig(), listThemes()]);
    const html = renderApp(config, themes);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);

  } catch (e) {
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
