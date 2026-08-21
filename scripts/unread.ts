import { readCache, readFeeds, readState } from '../lib/data.ts';
import { publishedTime } from '../lib/feeds.ts';

function argValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  const raw = index !== -1 ? process.argv[index + 1] : undefined;
  return raw ?? null;
}

function parseLimit(): number | null {
  const raw = argValue('--limit');
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error('--limit must be a positive integer');
  }
  return parsed;
}

function esc(text: string): string {
  return text.replaceAll('[', '\\[').replaceAll(']', '\\]');
}

const limit = parseLimit();
const cache = await readCache();
const state = await readState(cache);
const feeds = await readFeeds();
const feedLabels = new Map(feeds.feeds.map(feed => [feed.id, feed.label]));

const unread = cache.entries
  .filter(entry => entry.url && !state[entry.id]?.read)
  .sort((a, b) => publishedTime(b) - publishedTime(a));

const selected = limit ? unread.slice(0, limit) : unread;

console.log(`Unread articles with links: ${unread.length}`);

for (const entry of selected) {
  const feed = feedLabels.get(entry.feedId) || entry.feedId;
  console.log(`- [${esc(entry.title)}](${entry.url}) - ${feed}`);
}

if (limit && unread.length > selected.length) {
  console.log(`\n${unread.length - selected.length} more unread articles omitted by --limit ${limit}.`);
}
