// The entries a page lists, changed in place the moment they are pressed. If
// the server then fails, the change is undone and the button turns red.
import { SvelteSet } from 'svelte/reactivity';
import type { Entry } from '#lib/server/store.ts';

export type Toggle = 'read' | 'bookmark';

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
    this.list = this.leaves(after)
      ? before.filter((row) => row.id !== entry.id)
      : before.map((row) => (row.id === entry.id ? after : row));
    if (await post(`/api/${toggle}/${entry.id}`)) return;
    this.list = before;
    this.failed.add(`${entry.id} ${toggle}`);
  }

  // Up to the newest entry shown, so anything that arrived since stays unread.
  async readAll(): Promise<void> {
    const before = this.list;
    const newest = Math.max(...before.map((entry) => entry.id));
    this.readAllFailed = false;
    this.list = before.filter((entry) => entry.state !== 'unread');
    if (await post(`/api/read-all/${newest}`)) return;
    this.list = before;
    this.readAllFailed = true;
  }
}
