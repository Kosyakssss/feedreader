import { Database } from 'bun:sqlite';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createSchema } from '../src/lib/server/storage';
import { parseConfig } from '../src/lib/server/config';
import { createEntryId, decodeHtmlEntities, publishedTime } from '../src/lib/server/feed-parser';
import { isSafeExternalUrl } from '../src/lib/server/external-http';
import { mergeEntryState } from '../src/lib/client/entries';
import type { Entry, EntryState, Feed, FeedCacheMeta } from '../src/lib/types';

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { from: { type: 'string' }, to: { type: 'string' }, help: { type: 'boolean' } },
  strict: true,
});
if (values.help) {
  console.log(
    'Stop the main-branch server, then run: bun run migrate --from <main data directory> --to <new v0.1 data directory>\nThe destination must not exist. Original files are never changed.',
  );
  process.exit(0);
}
if (!values.from || !values.to) throw new Error('Provide --from and --to directories');
const source = resolve(values.from),
  target = resolve(values.to);
if (existsSync(target)) throw new Error('Destination already exists');
if (
  existsSync(join(source, 'transaction.json')) ||
  readdirSync(source).some((name) => /^state\.sync-conflict-.*\.json$/.test(name))
)
  throw new Error(
    'Let the main-branch app finish data recovery and synchronization, then stop it before migrating',
  );
const originals = new Map<string, string>();
function read<T>(file: string, fallback: T): T {
  const path = join(source, file);
  if (!existsSync(path)) return fallback;
  const text = readFileSync(path, 'utf8');
  originals.set(file, text);
  return JSON.parse(text) as T;
}
if (!existsSync(join(source, 'feeds.json'))) throw new Error('Missing feeds.json');
const feeds = read<{ feeds: Feed[] }>('feeds.json', { feeds: [] }).feeds;
const cache = read<{
  entries: (Omit<Entry, 'publishedTime' | 'sourceId'> & { sourceId?: string })[];
  lastFetched: Record<string, number>;
  feedErrors: Record<string, string>;
  feedMeta?: Record<string, FeedCacheMeta>;
}>('cache.json', { entries: [], lastFetched: {}, feedErrors: {} });
const states = read<Record<string, EntryState>>('state.json', {});
const old = read<{
  maxBulkOpen?: number;
  port?: number;
  trustedOrigins?: string[];
  theme?: string | null;
  retention?: { maxEntries?: number; maxDays?: number | null };
}>('config.json', {});
const retention = { ...old.retention };
if (retention.maxDays === null) delete retention.maxDays;
const config = parseConfig({
  ...old,
  retention,
  theme: !old.theme || old.theme === 'system' ? 'default' : old.theme,
  appearance: 'system',
});
mkdirSync(dirname(target), { recursive: true });
const temporary = mkdtempSync(join(dirname(target), '.feedreader-migrate-'));
const db = new Database(join(temporary, 'feedreader.sqlite'), { create: true, strict: true });
let closed = false;
try {
  db.exec('PRAGMA foreign_keys = ON;');
  let addedFeeds = 0,
    addedEntries = 0,
    skippedFeeds = 0;
  const feedIds = new Map<string, string>();
  const mergedStates = new Map<string, EntryState>();
  db.transaction(() => {
    createSchema(db);
    const insertFeed = db.query<
      { id: string },
      [string, string, string, number, number | null, string | null, string | null, string | null]
    >('INSERT INTO feeds VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING id');
    for (const [position, feed] of feeds.entries()) {
      const safe = isSafeExternalUrl(feed.url);
      if (!safe.ok) {
        skippedFeeds++;
        continue;
      }
      const meta = cache.feedMeta?.[feed.id];
      const inserted = insertFeed.get(
        feed.id,
        safe.url.href,
        feed.label,
        position,
        cache.lastFetched[feed.id] ?? null,
        cache.feedErrors[feed.id] ?? null,
        meta?.etag ?? null,
        meta?.lastModified ?? null,
      );
      const id =
        inserted?.id ??
        db.query<{ id: string }, [string]>('SELECT id FROM feeds WHERE url = ?').get(safe.url.href)?.id;
      if (!id) throw new Error(`Could not migrate subscription ${feed.id}`);
      feedIds.set(feed.id, id);
      if (inserted) addedFeeds++;
    }
    const insertEntry = db.query<{ id: string }, [string, string, string, string, string, string, number]>(
      'INSERT INTO entries VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING id',
    );
    for (const entry of cache.entries) {
      const feedId = feedIds.get(entry.feedId);
      if (!feedId) continue;
      const sourceId = entry.sourceId || entry.id;
      const safe = isSafeExternalUrl(entry.url),
        url = safe.ok ? safe.url.href : '';
      const title = decodeHtmlEntities(entry.title);
      const inserted = insertEntry.get(
        createEntryId(feedId, sourceId),
        sourceId,
        feedId,
        url,
        title,
        entry.published,
        publishedTime(entry),
      );
      const id =
        inserted?.id ??
        db
          .query<{ id: string }, [string, string, string, string, string, string]>(
            `SELECT id FROM entries WHERE feedId = ? AND (sourceId = ? OR (? <> '' AND url = ?) OR (url = '' AND ? = '' AND title = ?)) LIMIT 1`,
          )
          .get(feedId, sourceId, url, url, url, title)?.id;
      if (!id) throw new Error(`Could not migrate entry ${entry.id}`);
      if (inserted) addedEntries++;
      const state = Object.hasOwn(states, entry.id) ? states[entry.id] : states[sourceId];
      if (state) mergedStates.set(id, mergeEntryState(mergedStates.get(id), state));
    }
    const insertState = db.query('INSERT INTO states VALUES (?, ?, ?, ?, ?)');
    for (const [id, state] of mergedStates)
      insertState.run(
        id,
        state.read === undefined ? null : Number(state.read),
        state.readAt ?? 0,
        state.starred === undefined ? null : Number(state.starred),
        state.starredAt ?? 0,
      );
  }).immediate();
  if (db.query<{ integrity_check: string }, []>('PRAGMA integrity_check').get()?.integrity_check !== 'ok')
    throw new Error('Migration database integrity check failed');
  db.close();
  closed = true;
  writeFileSync(join(temporary, 'config.toml'), Bun.TOML.stringify(config)!, { mode: 0o600 });
  const defaultFile = resolve(import.meta.dir, '../data/default.css');
  copyFileSync(defaultFile, join(temporary, 'default.css'));
  const themeDir = join(source, 'themes');
  if (existsSync(themeDir))
    for (const file of readdirSync(themeDir).filter((name) => /^[a-zA-Z0-9_-]+\.css$/.test(name))) {
      if (file === 'system.css') continue;
      if (file === 'default.css') throw new Error('Rename the old custom default.css theme before migrating');
      const text = readFileSync(join(themeDir, file), 'utf8');
      originals.set(`themes/${file}`, text);
      writeFileSync(join(temporary, file), convertTheme(text));
    }
  if (!existsSync(join(temporary, `${config.theme}.css`))) throw new Error(`Missing theme: ${config.theme}`);
  for (const [file, text] of originals)
    if (readFileSync(join(source, file), 'utf8') !== text)
      throw new Error('Source changed during migration; stop the old server first');
  renameSync(temporary, target);
  console.log(
    `Migrated ${addedFeeds} subscriptions, ${addedEntries} entries, and ${mergedStates.size} states to ${target}. Skipped ${skippedFeeds} unsupported subscriptions. Original files are untouched.`,
  );
} finally {
  if (!closed) db.close();
  if (existsSync(temporary)) rmSync(temporary, { recursive: true, force: true });
}

function convertTheme(css: string): string {
  const names: Record<string, string> = {
    bg: 'background',
    'bg-card': 'surface',
    'bg-hover': 'surface-hover',
    'bg-nav': 'navigation-background',
    text: 'foreground',
    'text-muted': 'muted',
    'text-link': 'link',
    'on-accent': 'accent-foreground',
    'control-bg': 'field-background',
    'focus-ring': 'field-focus-ring',
    overlay: 'scrim',
    selection: 'selection-background',
    'selection-text': 'selection-foreground',
    star: 'star-accent',
  };
  const allowed = new Set(
    [...readFileSync(resolve(import.meta.dir, '../data/default.css'), 'utf8').matchAll(/--([\w-]+):/g)].map(
      (match) => match[1],
    ),
  );
  const text = css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--([\w-]+)/g, (token, name: string) => (names[name] ? `--${names[name]}` : token));
  const parts = text.split(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{/i);
  const properties = (part: string) =>
    new Map(
      [...part.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)]
        .filter((match) => allowed.has(match[1]))
        .map((match) => [match[1]!, match[2]!.trim()]),
    );
  const light = properties(parts[0]!),
    dark = parts[1] ? properties(parts[1]) : undefined;
  if (!light.size) throw new Error('Theme has no supported color variables');
  const scheme = dark ? 'light dark' : /color-scheme\s*:\s*dark\s*;/.test(text) ? 'dark' : 'light';
  const colors = [...new Set([...light.keys(), ...(dark?.keys() ?? [])])].map((name) => {
    const a = light.get(name),
      b = dark?.get(name);
    return `  --${name}: ${a && b ? `light-dark(${a}, ${b})` : (a ?? b)};`;
  });
  return `:root {\n  color-scheme: ${scheme};\n${colors.join('\n')}\n}\n`;
}
