// The timeline a page at a time: one entry more than a page is asked for, to
// know whether there is more after it.
import { scopes, TIMELINE_PAGE, type Cursor, type Entry, type Store } from './store';

export function timelinePage(store: Store, after?: Cursor): { entries: Entry[]; more: boolean } {
  const entries = store.entries({ ...scopes.timeline, limit: TIMELINE_PAGE + 1 }, after);
  return { entries: entries.slice(0, TIMELINE_PAGE), more: entries.length > TIMELINE_PAGE };
}
