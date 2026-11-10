// The entries a page lists, changed in place the moment they are pressed. If
// the server then fails, the change is undone and the button turns red.
import { flushSync } from 'svelte';
import { SvelteSet } from 'svelte/reactivity';
import type { Entry } from '#lib/server/store.ts';

export type Toggle = 'read' | 'bookmark';

// Rows that leave or change move into place rather than jump. The change
// itself lands a frame later; the promise says when.
function moving(update: () => void): Promise<void> {
  if (!document.startViewTransition) return Promise.resolve(update());
  return document.startViewTransition(() => flushSync(update)).updateCallbackDone;
}

const post = (path: string) =>
  fetch(path, { method: 'POST' }).then(
    (response) => response.ok,
    () => false,
  );

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

export class Rows {
  list = $state<Entry[]>([]);
  failed = new SvelteSet<string>(); // `${id} ${toggle}` for changes that didn't save
  readAllFailed = $state(false);
  private leaves: (entry: Entry) => boolean;

  // `leaves` says which entries no longer belong on this page once changed.
  constructor(entries: Entry[], leaves: (entry: Entry) => boolean = () => false) {
    this.list = entries;
    this.leaves = leaves;
  }

  async toggle(entry: Entry, toggle: Toggle): Promise<void> {
    const before = this.list;
    const after = toggled(entry, toggle);
    this.failed.delete(`${entry.id} ${toggle}`);
    const shown = moving(() => {
      this.list = this.leaves(after)
        ? before.filter((row) => row.id !== entry.id)
        : before.map((row) => (row.id === entry.id ? after : row));
    });
    const saved = await post(`/api/${toggle}/${entry.id}`);
    await shown; // a quick failure must not be undone before the change is even shown
    if (saved) return;
    this.list = before;
    this.failed.add(`${entry.id} ${toggle}`);
  }

  // Up to the newest entry shown, so anything that arrived since stays unread.
  async readAll(): Promise<void> {
    const before = this.list;
    const newest = Math.max(...before.map((entry) => entry.id));
    this.readAllFailed = false;
    const shown = moving(() => (this.list = before.filter((entry) => entry.state !== 'unread')));
    const saved = await post(`/api/read-all/${newest}`);
    await shown;
    if (saved) return;
    this.list = before;
    this.readAllFailed = true;
  }
}
