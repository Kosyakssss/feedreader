// The command line. The app itself is `bun run start`. Feeds added here are
// fetched once the app next starts.
import { parseArgs } from 'node:util';
import { discover, fetchSource } from './lib/server/fetch';
import { readOpml, sourceFor, writeOpml } from './lib/server/opml';
import { Store } from './lib/server/store';

const USAGE = `lagan entries [--db path] [--unread | --bookmarked]
lagan feeds   [--db path]
lagan add     [--db path] <feed url | @handle | did:...>
lagan opml    [--db path] export | import <file>
lagan check   [--db path]`;

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    db: { type: 'string', default: 'data/lagan.sqlite' },
    unread: { type: 'boolean', default: false },
    bookmarked: { type: 'boolean', default: false },
  },
});

const [command, argument, file] = positionals;
const store = new Store(values.db!);

function entries(): void {
  console.log(
    JSON.stringify(store.export(values.unread ? 'unread' : values.bookmarked ? 'bookmarked' : undefined), null, 2),
  );
}

function feeds(): void {
  const mutes = store.mutesBySource();
  const list = store.sources().map(({ id, kind, ref, label, folder, error }) => ({
    id,
    kind,
    ref,
    label,
    folder,
    error,
    muted: mutes[id] ?? [],
  }));
  console.log(JSON.stringify(list, null, 2));
}

async function opml(): Promise<void> {
  if (argument === 'export') return void process.stdout.write(writeOpml(store.sources()));
  if (argument !== 'import' || !file) throw new Error('opml needs export, or import and a file');
  const listed = readOpml(await Bun.file(file).text());
  const added = store.addSources(listed.map(sourceFor));
  console.log(`${listed.length} feeds in the file, ${added.length} new`);
}

async function add(): Promise<void> {
  if (!argument) throw new Error('add needs a feed');
  const { kind, ref, label } = await discover(argument);
  store.addSource(kind, ref, label);
  console.log(`Added ${label} (${ref})`);
}

// Fetches every feed without saving and reports what the parser saw. "new"
// counts items the database doesn't hold, so a parser that disagrees with what
// was stored shows up as a large number.
async function check(): Promise<void> {
  const sources = store.sources();
  const lines: { label: string; items: number; fresh: number; status: string }[] = [];
  for (let start = 0; start < sources.length; start += 8) {
    await Promise.all(
      sources.slice(start, start + 8).map(async (source) => {
        const result = await fetchSource({ ...source, etag: '', last_modified: '' });
        lines.push({
          label: source.label,
          items: result.items.length,
          fresh: result.items.length - store.knownCount(source.id, result.items),
          status: result.error ?? 'ok',
        });
      }),
    );
  }
  lines.sort((a, b) => a.label.localeCompare(b.label));
  for (const line of lines)
    console.log(
      `${line.label.slice(0, 44).padEnd(44)} ${String(line.items).padStart(4)} items ${String(line.fresh).padStart(4)} new  ${line.status}`,
    );
  const failed = lines.filter((line) => line.status !== 'ok').length;
  const sum = (key: 'items' | 'fresh') => lines.reduce((total, line) => total + line[key], 0);
  console.log(`\n${lines.length} feeds, ${failed} failed, ${sum('items')} items, ${sum('fresh')} new`);
}

const commands: Record<string, () => void | Promise<void>> = { entries, feeds, add, opml, check };
const run = commands[command ?? ''];
if (!run) {
  console.error(USAGE);
  process.exit(2);
}
await run();
process.exit(0);
