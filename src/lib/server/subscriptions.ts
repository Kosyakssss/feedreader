import { error } from '@sveltejs/kit';
import type { App } from './app';
import type { Feed } from '../types';
import { resolveFeedInput } from './feeds/discovery';
import { fetchFeed } from './feeds/fetch';
import { parseAtprotoFeedUrl } from './feeds/atproto';
import { parseOPML } from './feeds/parse';
import { pruneEntries } from './normalize';
import { enrich } from './refresh';
import { isSafeExternalUrl } from './security';
function urlKey(url: string): string {
  const safe = isSafeExternalUrl(url);
  return safe.ok ? safe.url.href : url;
}
export async function health(app: App) {
  return app.store.query((data) => {
    const counts = new Map<string, number>();
    for (const entry of data.cache.entries) counts.set(entry.feedId, (counts.get(entry.feedId) ?? 0) + 1);
    return {
      ...data.feeds,
      health: Object.fromEntries(
        data.feeds.feeds.map((feed) => [
          feed.id,
          {
            lastFetched: data.cache.lastFetched[feed.id] ?? null,
            error: data.cache.feedErrors[feed.id] ?? null,
            entryCount: counts.get(feed.id) ?? 0,
          },
        ]),
      ),
    };
  });
}
export async function add(app: App, input: string) {
  const resolved = await resolveFeedInput(input).catch((e) => error(400, e.message));
  const duplicate = () => error(409, 'Feed already exists');
  if (
    await app.store.query((data) =>
      data.feeds.feeds.some((feed) => urlKey(feed.url) === urlKey(resolved.url)),
    )
  )
    duplicate();
  const feed: Feed = { ...resolved, id: crypto.randomUUID(), folderId: null };
  const result = await fetchFeed(feed);
  if (result.error) error(400, `Feed could not be read: ${result.error}`);
  const time = Date.now();
  const entries = await app.store.change(['feeds', 'cache', 'state'], (data) => {
    if (data.feeds.feeds.some((item) => urlKey(item.url) === urlKey(feed.url))) duplicate();
    data.feeds.feeds.unshift(feed);
    const ids = new Set<string>();
    data.cache.entries.push(...result.entries.filter((entry) => !ids.has(entry.id) && !!ids.add(entry.id)));
    data.cache.lastFetched[feed.id] = time;
    data.cache.feedMeta[feed.id] = result.validators ?? {};
    Object.assign(data, pruneEntries(data.cache, data.state, data.config));
    return enrich(
      data,
      data.cache.entries.filter((entry) => entry.feedId === feed.id),
    );
  });
  app.events.publish({ topics: ['feeds', 'entries'] });
  app.log.record('feed.added', { feedId: feed.id, entries: entries.length });
  return { feed, entries, health: { lastFetched: time, error: null, entryCount: entries.length } };
}
export async function remove(app: App, id: string) {
  const removed = await app.store.change(['feeds', 'cache', 'state'], (data) => {
    data.feeds.feeds = data.feeds.feeds.filter((feed) => feed.id !== id);
    const ids = data.cache.entries.filter((entry) => entry.feedId === id).map((entry) => entry.id);
    data.cache.entries = data.cache.entries.filter((entry) => entry.feedId !== id);
    for (const key of ids) delete data.state[key];
    for (const map of [data.cache.lastFetched, data.cache.feedErrors, data.cache.feedMeta]) delete map[id];
    return ids;
  });
  app.refresh.removeFeed(id, removed);
  app.events.publish({ topics: ['feeds', 'entries'] });
  app.log.record('feed.removed', { feedId: id });
}
export async function importOPML(app: App, text: string) {
  let imported: ReturnType<typeof parseOPML>;
  try {
    imported = parseOPML(text);
  } catch {
    error(400, 'Invalid OPML document');
  }
  const feeds = await app.store.change(['feeds'], (data) => {
    const urls = new Set(data.feeds.feeds.map((feed) => urlKey(feed.url)));
    const created: Feed[] = [];
    for (const item of imported) {
      let valid = false;
      try {
        valid = !!parseAtprotoFeedUrl(item.url);
      } catch {}
      const safe = isSafeExternalUrl(item.url);
      if (!valid && !safe.ok) continue;
      const url = safe.ok ? safe.url.href : item.url;
      if (urls.has(url)) continue;
      urls.add(url);
      created.push({ id: crypto.randomUUID(), url, label: item.label || url, folderId: null });
    }
    data.feeds.feeds.unshift(...created);
    return created;
  });
  if (feeds.length) {
    app.events.publish({ topics: ['feeds'] });
    void app.refresh.start(feeds.map((feed) => feed.id)).catch(() => undefined);
  }
  return { feeds, added: feeds.length, skipped: imported.length - feeds.length };
}
export async function exportOPML(app: App): Promise<string> {
  const feeds = await app.store.query((data) => data.feeds);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0"><head><title>Feedreader Export</title></head><body>\n${feeds.feeds.map((feed) => `<outline type="rss" text="${Bun.escapeHTML(feed.label)}" title="${Bun.escapeHTML(feed.label)}" xmlUrl="${Bun.escapeHTML(feed.url)}" />`).join('\n')}\n</body></opml>`;
}
