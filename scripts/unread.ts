import { Storage } from '../src/lib/server/storage';
import { resolve } from 'node:path';

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
const store = new Storage(resolve(argValue('--data') || process.env.FEEDREADER_DATA_DIR || 'data'));
const unread = store.entries().filter((entry) => entry.url && !entry.state.read);
store.close();

const selected = limit ? unread.slice(0, limit) : unread;

console.log(`Unread articles with links: ${unread.length}`);

for (const entry of selected) {
  const feed = entry.feedLabel;
  console.log(`- [${esc(entry.title)}](${entry.url}) - ${feed}`);
}

if (limit && unread.length > selected.length) {
  console.log(`\n${unread.length - selected.length} more unread articles omitted by --limit ${limit}.`);
}
