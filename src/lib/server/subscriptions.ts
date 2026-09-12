import { error } from '@sveltejs/kit';
import type { App } from './app';
import type { Feed } from '../types';
import { resolveFeedInput } from './feeds/discovery';
import { fetchFeed } from './feeds/fetch';
import { parseAtprotoFeedUrl } from './feeds/atproto';
import { parseOPML } from './feeds/parse';
import { isSafeExternalUrl } from './security';
export async function add(app: App, input: string) {
  const resolved = await resolveFeedInput(input).catch((e) => error(400, e.message));
  const duplicate = () => error(409, 'Feed already exists');
  if (app.store.hasFeed(resolved.url)) duplicate();
  const feed: Feed = { ...resolved, id: crypto.randomUUID(), folderId: null };
  const result = await fetchFeed(feed);
  if (result.error) error(400, `Feed could not be read: ${result.error}`);
  const time = Date.now();
  const entries = app.store.addFeed(feed, result, time);
  if (!entries) return duplicate();
  app.events.publish({ topics: ['feeds', 'entries'] });
  app.log.record('feed.added', { feedId: feed.id, entries: entries.length });
  return { feed, entries, health: { lastFetched: time, error: null, entryCount: entries.length } };
}
export async function remove(app: App, id: string) {
  const removed = app.store.removeFeed(id);
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
  const created: Feed[] = [];
  for (const item of imported) {
    let valid = false;
    try {
      valid = !!parseAtprotoFeedUrl(item.url);
    } catch {}
    const safe = isSafeExternalUrl(item.url);
    if (!valid && !safe.ok) continue;
    const url = safe.ok ? safe.url.href : item.url;
    created.push({ id: crypto.randomUUID(), url, label: item.label || url, folderId: null });
  }
  const feeds = app.store.addFeeds(created);
  if (feeds.length) {
    app.events.publish({ topics: ['feeds'] });
    void app.refresh.start(feeds.map((feed) => feed.id)).catch(() => undefined);
  }
  return { feeds, added: feeds.length, skipped: imported.length - feeds.length };
}
export async function exportOPML(app: App): Promise<string> {
  const feeds = app.store.feeds();
  return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0"><head><title>Feedreader Export</title></head><body>\n${feeds.map((feed) => `<outline type="rss" text="${Bun.escapeHTML(feed.label)}" title="${Bun.escapeHTML(feed.label)}" xmlUrl="${Bun.escapeHTML(feed.url)}" />`).join('\n')}\n</body></opml>`;
}
