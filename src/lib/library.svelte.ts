// The whole library, kept on the device and kept current, so that every page
// is ready before it is opened. It is fetched once, as the app starts, and the
// server then tells it each change as it happens: new posts, and anything read,
// saved or changed on another device. Pages are views of it, worked out here
// with the same rules the server's lists use.
//
// Presses change it at once and tell the server after. If the server then
// fails, the change is undone and the button turns red.
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import type { Library as Snapshot, Update } from '#lib/server/live.ts';
import type { Entry, Source } from '#lib/server/store.ts';

export type Toggle = 'read' | 'bookmark';

export const TIMELINE_STEP = 200; // how many more entries the timeline shows each time

const newestFirst = (a: Entry, b: Entry) => b.published_at - a.published_at || b.id - a.id;

// What the server will do, done here first.
function toggled(entry: Entry, toggle: Toggle): Entry {
  if (toggle === 'read') return { ...entry, state: entry.state === 'read' ? 'unread' : 'read' };
  const bookmarking = entry.bookmarked === 0;
  return {
    ...entry,
    bookmarked: bookmarking ? 1 : 0,
    state: bookmarking && entry.state === 'none' ? 'read' : entry.state,
  };
}

const post = (path: string) =>
  fetch(path, { method: 'POST' }).then(
    (response) => response.ok,
    () => false,
  );

class Library {
  ready = $state(false);
  sources = $state<Source[]>([]);
  mutes = $state<Record<number, string[]>>({});
  failed = new SvelteSet<string>(); // `${id} ${toggle}` for changes that didn't save
  readAllFailed = $state(false);

  private entries = new SvelteMap<number, Entry>();
  private pending = new Map<number, number>(); // entries with presses the server hasn't answered yet
  private version = 0;
  private stream: EventSource | null = null;

  // Every entry, newest first.
  readonly all = $derived([...this.entries.values()].toSorted(newestFirst));

  // What belongs on each page, by the same rules as the server's lists.
  unread = (entry: Entry) => entry.state === 'unread' && !this.muted(entry);
  timeline = (entry: Entry) => entry.state !== 'none' && !this.muted(entry);
  bookmarks = (entry: Entry) => entry.bookmarked === 1;
  feed = (id: number) => (entry: Entry) => entry.source_id === id;
  source = (id: number) => this.sources.find((source) => source.id === id);

  // A page's list. Until the library arrives, the one the server sent for
  // the page, with any presses made since.
  list(sent: Entry[] | undefined, belongs: (entry: Entry) => boolean): Entry[] {
    if (this.ready) return this.all.filter(belongs);
    return (sent ?? []).map((entry) => this.entries.get(entry.id) ?? entry).filter(belongs);
  }

  private muted(entry: Entry): boolean {
    const words = this.mutes[entry.source_id];
    if (!words?.length) return false;
    const title = entry.title.toLowerCase();
    return words.some((word) => title.includes(word));
  }

  // Started once, in the browser, as the app starts.
  start(): void {
    if (this.stream) return;
    this.listen();
    void this.fetchAll();
  }

  // The stream first, so that no change made while the library is on its way
  // is lost: the library comes with the number of the last change in it, and
  // any change up to that number is already in it.
  private listen(): void {
    this.stream = new EventSource('/api/live');
    this.stream.addEventListener('at', (event) => {
      // On every connection, after a sleep or a dropped network too: a copy
      // that is behind takes the whole library again.
      if (this.ready && Number(event.data) !== this.version) void this.fetchAll();
    });
    this.stream.addEventListener('message', (event) => this.apply(JSON.parse(event.data) as Update));
  }

  private async fetchAll(): Promise<void> {
    const response = await fetch('/api/library').catch(() => null);
    if (!response?.ok) return; // the stream's next connection tries again
    const library = (await response.json()) as Snapshot;
    this.entries.clear();
    for (const entry of library.entries) this.entries.set(entry.id, entry);
    this.sources = library.sources;
    this.mutes = library.mutes;
    this.version = library.version;
    this.ready = true;
  }

  private apply(update: Update): void {
    if (update.version <= this.version) return; // already in the library
    if (update.version !== this.version + 1) {
      void this.fetchAll(); // one went missing
      return;
    }
    this.version = update.version;
    if ('entries' in update) this.put(update.entries);
    else if ('sources' in update) {
      this.sources = update.sources;
      this.mutes = update.mutes;
    } else void this.fetchAll();
  }

  // From the server. An entry still being pressed keeps what the presses
  // made it, rather than flickering back through each step as the server
  // catches up with them.
  put(entries: Entry[]): void {
    for (const entry of entries) if (!this.pending.has(entry.id)) this.entries.set(entry.id, entry);
  }

  async toggle(entry: Entry, toggle: Toggle): Promise<void> {
    const before = this.entries.get(entry.id) ?? entry;
    this.failed.delete(`${entry.id} ${toggle}`);
    this.entries.set(entry.id, toggled(before, toggle));
    this.pending.set(entry.id, (this.pending.get(entry.id) ?? 0) + 1);
    const saved = await post(`/api/${toggle}/${entry.id}`);
    const left = this.pending.get(entry.id)! - 1;
    if (left) this.pending.set(entry.id, left);
    else this.pending.delete(entry.id);
    if (saved) return;
    this.entries.set(entry.id, before);
    this.failed.add(`${entry.id} ${toggle}`);
  }

  // Up to the newest entry shown, so anything that arrived since stays unread.
  async readAll(shown: Entry[]): Promise<void> {
    if (!shown.length) return;
    const newest = Math.max(...shown.map((entry) => entry.id));
    this.readAllFailed = false;
    const before = shown.map((entry) => this.entries.get(entry.id) ?? entry);
    for (const entry of before) if (entry.state === 'unread') this.entries.set(entry.id, { ...entry, state: 'read' });
    if (await post(`/api/read-all/${newest}`)) return;
    for (const entry of before) this.entries.set(entry.id, entry);
    this.readAllFailed = true;
  }
}

export const library = new Library();
