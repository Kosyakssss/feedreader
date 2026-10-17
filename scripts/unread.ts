import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { Storage } from '../src/lib/server/storage';

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { data: { type: 'string' }, limit: { type: 'string' } },
  strict: true,
});
const limit = values.limit === undefined ? -1 : Number(values.limit);
if (values.limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1))
  throw new Error('--limit must be a positive integer');
const store = new Storage(resolve(values.data || process.env.FEEDREADER_DATA_DIR || 'data'));
try {
  const { entries, total } = store.unread(limit);
  console.log(`Unread articles with links: ${total}`);
  for (const entry of entries)
    console.log(
      `- [${entry.title.replaceAll('[', '\\[').replaceAll(']', '\\]')}](${entry.url}) - ${entry.feedLabel}`,
    );
  if (entries.length < total)
    console.log(`\n${total - entries.length} more unread articles omitted by --limit ${limit}.`);
} finally {
  store.close();
}
