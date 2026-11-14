import type { Entry } from '#lib/server/store.ts';

// What an entry is called: its title, or for a post without one, its text.
export function displayTitle(entry: Pick<Entry, 'title' | 'text' | 'url'>): string {
  return entry.title || entry.text || entry.url;
}
