// The entries a page lists, changed in place the moment they are pressed. If
// the server then fails, the change is undone and the button turns red.
import { flushSync } from 'svelte';
import { SvelteSet } from 'svelte/reactivity';
import type { Entry } from '#lib/server/store.ts';

// Rows that leave or change move into place rather than jump. The change
// itself lands a frame later; the promise says when.
function moving(update: () => void): Promise<void> {
  if (!document.startViewTransition) return Promise.resolve(update());
  return document.startViewTransition(() => flushSync(update)).updateCallbackDone;
}

const post = (path: string) => fetch(path, { method: 'POST' }).then((response) => response.ok, () => false);

export class Rows {
  list = $state<Entry[]>([]);
  failed = new SvelteSet<number>(); // entries whose last change didn't save
  readAllFailed = $state(false);
  private leaves: (entry: Entry) => boolean;

  // `leaves` says which entries no longer belong on this page once changed.
  constructor(entries: Entry[], leaves: (entry: Entry) => boolean = () => false) {
    this.list = entries;
    this.leaves = leaves;
  }

  // Bookmarked becomes read; anything else becomes bookmarked, as on the server.
  async bookmark(entry: Entry): Promise<void> {
    const before = this.list;
    const after: Entry = { ...entry, state: entry.state === 'bookmarked' ? 'read' : 'bookmarked' };
    this.failed.delete(entry.id);
    const shown = moving(() => {
      this.list = this.leaves(after) ? before.filter((row) => row.id !== entry.id) : before.map((row) => (row.id === entry.id ? after : row));
    });
    const saved = await post(`/api/bookmark/${entry.id}`);
    await shown; // a quick failure must not be undone before the change is even shown
    if (saved) return;
    this.list = before;
    this.failed.add(entry.id);
  }

  // Up to the newest entry shown, so anything that arrived since stays unread.
  async readAll(): Promise<void> {
    const before = this.list;
    const newest = Math.max(...before.map((entry) => entry.id));
    this.readAllFailed = false;
    const shown = moving(() => (this.list = []));
    const saved = await post(`/api/read-all/${newest}`);
    await shown;
    if (saved) return;
    this.list = before;
    this.readAllFailed = true;
  }
}
