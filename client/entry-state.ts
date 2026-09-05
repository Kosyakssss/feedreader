import type { EnrichedEntry, EntryState } from '../lib/types.ts';
import { mergeEntryState } from './state.ts';

type Updates = Record<string, Pick<EntryState, 'read' | 'starred'>>;

export class EntryStateStore {
  private readonly saved = new Map<string, EntryState>();
  private readonly pending = new Set<Updates>();

  receive(entries: readonly EnrichedEntry[]): void {
    for (const entry of entries) this.saved.set(entry.id, mergeEntryState(this.saved.get(entry.id), entry.state));
  }

  begin(entries: readonly EnrichedEntry[], updates: Updates): void {
    for (const entry of entries) {
      if (!this.saved.has(entry.id)) this.saved.set(entry.id, entry.state);
    }
    this.pending.add(updates);
  }

  finish(updates: Updates, states?: Record<string, EntryState>): void {
    this.pending.delete(updates);
    if (states) {
      for (const [id, state] of Object.entries(states)) this.saved.set(id, mergeEntryState(this.saved.get(id), state));
    }
  }

  project(entries: readonly EnrichedEntry[]): void {
    const retained = new Set(entries.map(entry => entry.id));
    for (const updates of this.pending) for (const id of Object.keys(updates)) retained.add(id);
    for (const id of this.saved.keys()) if (!retained.has(id)) this.saved.delete(id);
    for (const entry of entries) {
      const state = { ...(this.saved.get(entry.id) ?? entry.state) };
      for (const updates of this.pending) Object.assign(state, updates[entry.id]);
      entry.state = state;
    }
  }
}
