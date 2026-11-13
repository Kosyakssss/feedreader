// The whole library, kept on the device and kept current, so that every page
// is ready before it is opened. It is fetched once, as the app starts, and the
// server then tells it each change as it happens: new posts, and anything read,
// saved or changed on another device. Pages are views of it, worked out here
// with the same rules the server's lists use.
//
// Presses change it at once and tell the server after. If the server then
// fails, the change is undone and the button turns red.
//
// Opening an entry reads it. It stays on the page until you are back looking
// at the page, and then leaves, so that you see it go: at once for a new tab
// opened behind this one, on coming back for a link followed in this tab.
import { resolve } from '$app/paths';
import { at } from '#lib/paths.ts';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import type { Library as Snapshot, Update } from '#lib/server/live.ts';
import type { Entry, Mark, Source } from '#lib/server/store.ts';

export type Toggle = 'read' | 'bookmark';

export const TIMELINE_STEP = 200; // how many more entries the timeline shows each time

const newestFirst = (a: Entry, b: Entry) => b.published_at - a.published_at || b.id - a.id;

// Why an entry left a page, for how it goes.
export type Leaving = 'read' | 'bookmark';

const HELD = 'lagan:held'; // where opened entries wait while this tab is on another site

// What the server will do, done here first.
function marked(entry: Entry, change: Mark): Entry {
  let { state, bookmarked } = entry;
  if (change.read !== undefined) state = change.read ? 'read' : 'unread';
  if (change.bookmarked !== undefined) {
    bookmarked = change.bookmarked ? 1 : 0;
    if (change.bookmarked && state === 'none') state = 'read';
  }
  return { ...entry, state, bookmarked };
}

// A change the server is told of. Kept alive, so that one made as this tab
// goes to another site still arrives.
const post = (path: string, body: unknown) =>
  fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    keepalive: true,
  }).then(
    (response) => response.ok,
    () => false,
  );

// This tab is being looked at.
const seen = () => document.visibilityState === 'visible' && document.hasFocus();

function storedHeld(): Entry[] {
  try {
    return JSON.parse(sessionStorage.getItem(HELD) ?? '[]') as Entry[];
  } catch {
    return [];
  }
}

class Library {
  ready = $state(false);
  sources = $state<Source[]>([]);
  mutes = $state<Record<number, string[]>>({});
  failed = new SvelteSet<string>(); // `${id} ${toggle}` for changes that didn't save

  private entries = new SvelteMap<number, Entry>();
  private pending = new Map<number, number>(); // entries with presses the server hasn't answered yet
  private version = 0;
  private stream: EventSource | null = null;
  private held = new SvelteMap<number, Entry>(); // opened, each as it was before, still shown until seen to go
  private why = new Map<number, Leaving>(); // entries leaving for a reason their state doesn't tell
  private release?: () => void; // stops waiting to let the held entries go

  // Every entry, newest first.
  readonly all = $derived([...this.entries.values()].toSorted(newestFirst));

  // What belongs on each page, by the same rules as the server's lists.
  unread = (entry: Entry) => entry.state === 'unread' && !entry.bookmarked && !this.muted(entry);
  timeline = (entry: Entry) => entry.state !== 'none' && !this.muted(entry);
  bookmarks = (entry: Entry) => entry.bookmarked === 1;
  feed = (id: number) => (entry: Entry) => entry.source_id === id;
  source = (id: number) => this.sources.find((source) => source.id === id);

  // A page's list. Until the library arrives, the one the server sent for
  // the page, with any presses made since. Opened entries stay on the page
  // they were on until they are let go.
  list(sent: Entry[] | undefined, belongs: (entry: Entry) => boolean): Entry[] {
    const shows = (entry: Entry) => {
      const before = this.held.get(entry.id);
      return belongs(entry) || (before !== undefined && belongs(before));
    };
    if (this.ready) return this.all.filter(shows);
    const ids = new Set((sent ?? []).map((entry) => entry.id));
    return [...(sent ?? []), ...[...this.held.values()].filter((entry) => !ids.has(entry.id))]
      .map((entry) => this.entries.get(entry.id) ?? entry)
      .toSorted(newestFirst)
      .filter(shows);
  }

  get(id: number): Entry | undefined {
    return this.entries.get(id);
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
    for (const entry of storedHeld()) this.held.set(entry.id, entry);
    this.listen();
    void this.fetchAll().then(() => this.letGo());
    // Back from a link followed in this tab, on a page the browser kept.
    addEventListener('pageshow', (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      if (this.stream?.readyState === EventSource.CLOSED) this.listen();
      this.letGo();
    });
  }

  // The stream first, so that no change made while the library is on its way
  // is lost: the library comes with the number of the last change in it, and
  // any change up to that number is already in it.
  private listen(): void {
    this.stream = new EventSource(resolve('/api/live'));
    this.stream.addEventListener('at', (event) => {
      // On every connection, after a sleep or a dropped network too: a copy
      // that is behind takes the whole library again.
      if (this.ready && Number(event.data) !== this.version) void this.fetchAll();
    });
    this.stream.addEventListener('message', (event) => this.apply(JSON.parse(event.data) as Update));
  }

  private async fetchAll(): Promise<void> {
    const response = await fetch(resolve('/api/library')).catch(() => null);
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

  // Sets entries read or bookmarked, here at once and then on the server.
  async mark(entries: Entry[], change: Mark): Promise<void> {
    const toggle: Toggle = change.read === undefined ? 'bookmark' : 'read';
    const before = entries.map((entry) => this.entries.get(entry.id) ?? entry);
    for (const entry of before) {
      this.failed.delete(`${entry.id} ${toggle}`);
      this.entries.set(entry.id, marked(entry, change));
      this.pending.set(entry.id, (this.pending.get(entry.id) ?? 0) + 1);
    }
    const saved = await post(at('/api/mark'), { ids: before.map((entry) => entry.id), ...change });
    for (const entry of before) {
      const left = this.pending.get(entry.id)! - 1;
      if (left) this.pending.set(entry.id, left);
      else this.pending.delete(entry.id);
      if (saved) continue;
      this.entries.set(entry.id, entry);
      this.failed.add(`${entry.id} ${toggle}`);
    }
  }

  toggle(entry: Entry, toggle: Toggle): Promise<void> {
    const now = this.entries.get(entry.id) ?? entry;
    return this.mark([now], toggle === 'read' ? { read: now.state !== 'read' } : { bookmarked: !now.bookmarked });
  }

  // Opening reads. `away` is a link followed in this tab, leaving the app: the
  // entries go when it is back. Anything else opens in another tab, and they
  // go once this one is being looked at, which may be at once.
  open(entries: Entry[], away = false): void {
    for (const entry of entries) {
      const now = this.entries.get(entry.id) ?? entry;
      if (!this.held.has(entry.id)) this.held.set(entry.id, now);
    }
    this.keepHeld();
    void this.mark(entries, { read: true });
    if (!away) return this.letGo();
    // Should the link not take the tab anywhere after all, they go anyway.
    const stay = setTimeout(() => this.letGo(), 10_000);
    addEventListener('pagehide', () => clearTimeout(stay), { once: true });
  }

  // Why a row is leaving its page, given it as it was. Read off its state,
  // so changes made on another device leave the same way.
  leaving(before: Entry): Leaving | null {
    const why = this.why.get(before.id);
    this.why.delete(before.id);
    if (why) return why;
    const now = this.entries.get(before.id);
    if (!now) return null;
    if (now.bookmarked && !before.bookmarked) return 'bookmark';
    if (now.state === 'read' && before.state !== 'read') return 'read';
    return null;
  }

  // Lets the held entries go, once this tab has been looked at for a moment:
  // a tab opened in front of it hides it first, and coming back to it shows it.
  private letGo(): void {
    if (!this.held.size || this.release) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      clearTimeout(timer);
      timer = setTimeout(() => (seen() ? go() : undefined), 350);
    };
    const go = () => {
      stop();
      for (const id of this.held.keys()) this.why.set(id, 'read');
      this.held.clear();
      this.keepHeld();
      setTimeout(() => this.why.clear(), 100); // by now every row that left has asked why
    };
    const stop = () => {
      clearTimeout(timer);
      removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
      this.release = undefined;
    };
    this.release = stop;
    addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    check();
  }

  private keepHeld(): void {
    try {
      if (this.held.size) sessionStorage.setItem(HELD, JSON.stringify([...this.held.values()]));
      else sessionStorage.removeItem(HELD);
    } catch {
      // without storage, a page loaded afresh just doesn't show them
    }
  }
}

export const library = new Library();
