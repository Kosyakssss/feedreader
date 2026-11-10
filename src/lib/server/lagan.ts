// The one database and fetcher the running app uses.
import { Fetcher } from './fetch';
import { Store } from './store';

export type Lagan = { store: Store; wake: () => void; follow: (id: number) => void };

const globals = globalThis as typeof globalThis & { lagan?: Lagan };

// Started once per process. In development Vite reloads modules on every
// change, so the running copy is kept on the global object rather than started again.
export function start(): Lagan {
  if (globals.lagan) return globals.lagan;
  const store = new Store('data/lagan.sqlite');
  const removed = store.mergeMoved();
  if (removed) console.log(`Merged ${removed} copies of moved posts`);
  const fetcher = new Fetcher(store);
  fetcher.startAll();
  globals.lagan = { store, wake: () => fetcher.nudge(), follow: (id) => fetcher.start(id) };
  return globals.lagan;
}
