// How entries and feeds are shown, the same on the server and in the browser.
import type { Entry } from '#lib/server/store.ts';

export const feedPath = (id: number) => `/feed/${id}`;

export function displayTitle(entry: Pick<Entry, 'title' | 'text' | 'url'>): string {
  return entry.title || entry.text || entry.url;
}

const MAX_TITLE = 240;

// Very long text keeps its true start and true end, so the part that says how
// it ends can still be shown.
export function capTitle(text: string): string {
  const letters = [...text];
  if (letters.length <= MAX_TITLE) return text;
  const keep = Math.floor(MAX_TITLE * 0.618);
  return `${letters.slice(0, keep).join('')} … ${letters.slice(letters.length - (MAX_TITLE - keep)).join('')}`;
}

export function dateLabel(ms: number): string {
  const date = new Date(ms);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(
    'en-US',
    sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' },
  );
}

// How many entries the timeline shows at a time, the server's first step and
// each one after it on the device.
export const TIMELINE_STEP = 200;
