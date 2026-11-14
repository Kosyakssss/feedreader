// The command line: everything the app does, without the app. It works on
// the same database while the app runs; the app picks up feeds added here the
// next time it is opened. Lists print as JSON.
import { parseArgs } from 'node:util';
import { fetchSource } from './lib/server/fetch';
import { readOpml, sourceFor, writeOpml } from './lib/server/opml';
import { findFeed } from './lib/server/sites';
import { Store, type Source } from './lib/server/store';

const USAGE = `lagan entries  [--kept]               entries, newest first
lagan keep     <entry id>...          keep entries
lagan unkeep   <entry id>...          stop keeping them
lagan feeds                           feeds followed, with their settings
lagan sites                           sites pages were kept from, with theirs
lagan follow   <link | @handle>...    follow feeds, or the first feed of a site
lagan rename   <feed id> <name>       rename a feed or a site
lagan move     <feed id> <link>       point a feed at another address
lagan unfollow <feed id>              stop following; what was kept stays
lagan mutes    <feed id> [word]...    its muted words, or set them: entries with any are hidden ("" for none)
lagan cuts     <id> [text]...         a feed's or site's cuts, or set them: taken out of titles ("" for none)
lagan opml     export | import <file>
lagan check                           fetch every feed, without saving, and report

Every command takes --db <path>, data/lagan.sqlite by default.`;

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    db: { type: 'string', default: 'data/lagan.sqlite' },
    kept: { type: 'boolean', default: false },
  },
});

const [command, ...rest] = positionals;
const store = new Store(values.db!);
const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));

function usage(): never {
  console.error(USAGE);
  process.exit(2);
}

// The feed or site an id names.
function sourceOf(id: string | undefined, kinds: Source['kind'][] = ['rss', 'atproto', 'page']): Source {
  const source = id && /^\d+$/.test(id) ? store.source(Number(id)) : null;
  if (!source || !kinds.includes(source.kind))
    throw new Error(`No ${kinds.includes('page') ? 'feed or site' : 'feed'} ${id ?? ''}`);
  return source;
}

const withSettings = (source: Source) => ({
  id: source.id,
  kind: source.kind,
  ref: source.ref,
  label: source.label,
  folder: source.folder,
  error: source.error,
  mutes: store.mutes(source.id),
  cuts: store.cuts(source.id),
});

function keeping(kept: boolean) {
  return () => {
    const ids = rest.map(Number);
    if (!ids.length || !ids.every(Number.isInteger)) usage();
    print(store.keep(ids, kept).map(({ id, title, kept }) => ({ id, title, kept: kept === 1 })));
  };
}

async function follow(): Promise<void> {
  if (!rest.length) usage();
  for (const typed of rest) {
    try {
      const { kind, ref, label } = await findFeed(typed);
      const id = store.addSource(kind, ref, label);
      console.log(`Following ${label} (${id}, ${ref})`);
    } catch (thrown) {
      console.error(`No feed at ${typed}: ${thrown instanceof Error ? thrown.message : thrown}`);
      process.exitCode = 1;
    }
  }
}

async function move(): Promise<void> {
  const source = sourceOf(rest[0], ['rss', 'atproto']);
  if (!rest[1]) usage();
  const { kind, ref } = await findFeed(rest[1]);
  const other = store.sources().find((each) => each.ref === ref);
  if (other && other.id !== source.id) throw new Error(`That is ${other.label} (${other.id}), followed already`);
  store.readdress(source.id, kind, ref);
  console.log(`${source.label} now fetches ${ref}`);
}

async function opml(): Promise<void> {
  const [what, file] = rest;
  if (what === 'export') return void process.stdout.write(writeOpml(store.sources()));
  if (what !== 'import' || !file) usage();
  const listed = readOpml(await Bun.file(file).text());
  const added = store.addSources(listed.map(sourceFor));
  console.log(`${listed.length} feeds in the file, ${added.length} new`);
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

const commands: Record<string, () => void | Promise<void>> = {
  entries: () => print(store.export(values.kept)),
  keep: keeping(true),
  unkeep: keeping(false),
  feeds: () => print(store.sources().map(withSettings)),
  sites: () => print(store.sites().map(withSettings)),
  follow,
  rename: () => {
    const source = sourceOf(rest[0]);
    const name = rest.slice(1).join(' ').trim();
    if (!name) usage();
    store.rename(source.id, name);
    console.log(`${source.label} is now ${name}`);
  },
  move,
  unfollow: () => {
    const source = sourceOf(rest[0], ['rss', 'atproto']);
    store.removeSource(source.id);
    console.log(`Stopped following ${source.label}`);
  },
  mutes: () => {
    const source = sourceOf(rest[0], ['rss', 'atproto']);
    print(rest.length > 1 ? store.setMutes(source.id, rest.slice(1)) : store.mutes(source.id));
  },
  cuts: () => {
    const source = sourceOf(rest[0]);
    print(rest.length > 1 ? store.setCuts(source.id, rest.slice(1)) : store.cuts(source.id));
  },
  opml,
  check,
};

const run = commands[command ?? ''];
if (!run) usage();
try {
  await run();
} catch (thrown) {
  console.error(thrown instanceof Error ? thrown.message : thrown);
  process.exit(1);
}
process.exit(process.exitCode ?? 0);
