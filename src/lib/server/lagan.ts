// The one database and fetcher the running app uses.
import { Fetcher } from './fetch';
import { Live } from './live';
import { Store } from './store';

export type Lagan = { store: Store; live: Live; wake: () => void; follow: (id: number) => void };

const globals = globalThis as typeof globalThis & { lagan?: Lagan };

// Started once per process. In development Vite reloads modules on every
// change, so the running copy is kept on the global object rather than started again.
export function start(): Lagan {
  if (globals.lagan) return globals.lagan;
  const store = new Store('data/lagan.sqlite');
  const removed = store.mergeMoved();
  if (removed) console.log(`Merged ${removed} copies of moved posts`);
  const live = new Live(store);
  const fetcher = new Fetcher(store);
  fetcher.startAll();
  globals.lagan = { store, live, wake: () => fetcher.nudge(), follow: (id) => fetcher.start(id) };

  // Asked to stop, the server finishes the requests it is answering first.
  // The live streams never finish by themselves, so they end at once. Once
  // the server has stopped, so does everything else: the fetchers would only
  // sleep until their next fetch, which the next start makes anyway.
  const endStreams = () => live.close();
  process.once('SIGTERM', endStreams);
  process.once('SIGINT', endStreams);
  process.once('sveltekit:shutdown' as 'exit', () => process.exit(0));
  return globals.lagan;
}
