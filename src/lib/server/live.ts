// Every open copy of the app keeps the whole library and is told each change
// as it happens, over one stream per copy. Each change is numbered. A copy
// that missed one (it was asleep, or offline) sees the gap in the numbers and
// takes the whole library again.
import type { Entry, Source, Store } from './store';

export type Library = { version: number; entries: Entry[]; sources: Source[]; mutes: Record<number, string[]> };

export type Update =
  | { version: number; entries: Entry[] }
  | { version: number; sources: Source[]; mutes: Record<number, string[]> }
  | { version: number; everything: true };

export class Live {
  // Numbered on from when the server started, so that a copy can't take a
  // restarted server's count for the one it had.
  version = Date.now();
  private listeners = new Set<{ send: (update: Update) => void; end: () => void }>();

  constructor(private store: Store) {
    store.onChange = (change) => {
      this.version++;
      const version = this.version;
      if ('entries' in change) this.send({ version, entries: store.entriesById(change.entries) });
      else if ('sources' in change) this.send({ version, sources: store.sources(), mutes: store.mutesBySource() });
      else this.send({ version, everything: true });
    };
  }

  library(): Library {
    return { version: this.version, ...this.store.library() };
  }

  // `end` is called if the server stops while the stream is open.
  listen(send: (update: Update) => void, end: () => void): () => void {
    const listener = { send, end };
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // Ends every open stream, so that a server stopping needn't wait on them.
  close(): void {
    for (const listener of this.listeners) this.safely(listener.end);
    this.listeners.clear();
  }

  private send(update: Update): void {
    for (const listener of this.listeners) this.safely(() => listener.send(update));
  }

  // One stream going wrong mustn't stop the others, or fail the change that
  // was being told: that is saved already.
  private safely(call: () => void): void {
    try {
      call();
    } catch (error) {
      console.error('live:', error);
    }
  }
}
