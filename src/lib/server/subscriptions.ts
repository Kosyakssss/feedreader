import { error } from '@sveltejs/kit';
import type { App } from './app';
import type { Feed } from '../types';
import { discoverFeed } from './feed-discovery';
import { parseOPML } from './feed-parser';
import { isSafeExternalUrl } from './external-http';

export async function add(app: App, input: string) {
  const { feed, result } = await discoverFeed(input, crypto.randomUUID()).catch((cause) =>
    error(400, cause.message),
  );
  if (result.error) error(400, `Feed could not be read: ${result.error}`);
  const time = Date.now();
  const entries = app.store.addFeed(feed, result, time);
  if (!entries) error(409, 'Feed already exists');
  const removedIds = app.store.prune(app.config.read().retention);
  const removed = new Set(removedIds);
  const retained = entries.filter((entry) => !removed.has(entry.id));
  app.events.publish({ topics: ['feeds', 'entries'] });
  app.log.record('feed.added', { feedId: feed.id, entries: retained.length });
  return {
    feed,
    entries: retained,
    removedIds,
    health: { lastFetched: time, error: null },
  };
}
export function remove(app: App, id: string): void {
  const removedIds = app.store.removeFeed(id);
  app.events.publish({ topics: ['feeds'], removedIds });
  app.log.record('feed.removed', { feedId: id });
}
export function importOPML(app: App, input: Uint8Array) {
  let imported: ReturnType<typeof parseOPML>;
  try {
    imported = parseOPML(input);
  } catch {
    error(400, 'Invalid OPML document');
  }
  const candidates: Feed[] = imported.flatMap((item) => {
    const safe = isSafeExternalUrl(item.url);
    return safe.ok ? [{ id: crypto.randomUUID(), url: safe.url.href, label: item.label || item.url }] : [];
  });
  const feeds = app.store.addFeeds(candidates);
  if (feeds.length) {
    app.events.publish({ topics: ['feeds'] });
    void app.refresh.start(feeds.map((feed) => feed.id)).catch(() => undefined);
  }
  return { feeds, added: feeds.length, skipped: imported.length - feeds.length };
}
export function exportOPML(app: App): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    Bun.XML.stringify({
      opml: {
        '@version': '2.0',
        head: { title: 'Feedreader Export' },
        body: {
          outline: app.store.feeds().map((feed) => ({
            '@type': 'rss',
            '@text': feed.label,
            '@title': feed.label,
            '@xmlUrl': feed.url,
          })),
        },
      },
    })
  );
}
