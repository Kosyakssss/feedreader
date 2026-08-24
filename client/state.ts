import type { Config, EnrichedEntry, Feed, FeedsFile } from '../lib/types.ts';

export type EntryFilter = 'all' | 'unread' | 'read';

export interface FeedHealth {
  lastFetched: number | null;
  error: string | null;
  entryCount: number;
}

export interface FeedData extends FeedsFile {
  health?: Record<string, FeedHealth>;
}

export interface RefreshFailure {
  feedId: string;
  label: string;
  error: string;
}

export interface RefreshStatus {
  count: number;
  refreshing: boolean;
  error: string | null;
  runId: string | null;
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  failures: RefreshFailure[];
  cursor: number;
  newEntries: EnrichedEntry[];
  removedIds: string[];
}

export interface SelectionDrag {
  pointerId: number;
  selecting: boolean;
  lastIndex: number;
}

export interface AppState {
  config: Config;
  entries: EnrichedEntry[];
  feeds: FeedData;
  selectedIds: Set<string>;
  focusedEntryId: string | null;
  filter: EntryFilter;
  page: string;
  loadLimit: number;
  selectionAnchorId: string | null;
  selectionDrag: SelectionDrag | null;
  suppressNextSelectClick: boolean;
  keyboardNavigationActive: boolean;
  initialDataLoading: boolean;
  refreshStatus: RefreshStatus | null;
  refreshRunId: string | null;
  refreshCursor: number;
}

export const DEFAULT_CONFIG: Config = {
  maxBulkOpen: 20,
  retention: { maxEntries: 3000, maxDays: null },
  theme: 'system',
  port: 8787,
  trustedOrigins: [],
};

export function createInitialState(page: string): AppState {
  return {
    config: structuredClone(DEFAULT_CONFIG),
    entries: [],
    feeds: { folders: [], feeds: [] },
    selectedIds: new Set(),
    focusedEntryId: null,
    filter: 'all',
    page,
    loadLimit: 50,
    selectionAnchorId: null,
    selectionDrag: null,
    suppressNextSelectClick: false,
    keyboardNavigationActive: false,
    initialDataLoading: true,
    refreshStatus: null,
    refreshRunId: null,
    refreshCursor: 0,
  };
}

export function currentSource(state: AppState): EnrichedEntry[] {
  if (state.page === '/starred') return state.entries.filter(entry => entry.state?.starred);
  if (state.page.startsWith('/feed/')) {
    const feedId = state.page.slice('/feed/'.length);
    return state.entries.filter(entry => entry.feedId === feedId);
  }
  return state.entries;
}

export function filteredEntries(state: AppState, source = currentSource(state)): EnrichedEntry[] {
  if (state.filter === 'unread') return source.filter(entry => !entry.state?.read);
  if (state.filter === 'read') return source.filter(entry => entry.state?.read);
  return source;
}

export function visibleEntries(state: AppState): EnrichedEntry[] {
  return filteredEntries(state).slice(0, state.loadLimit);
}

export function entryCounts(source: EnrichedEntry[]): { all: number; unread: number; read: number } {
  const unread = source.reduce((count, entry) => count + (entry.state?.read ? 0 : 1), 0);
  return { all: source.length, unread, read: source.length - unread };
}

export function feedById(feeds: FeedData, id: string): Feed | undefined {
  return feeds.feeds.find(feed => feed.id === id);
}

export function reconcileTransientState(state: AppState): void {
  const entryIds = new Set(state.entries.map(entry => entry.id));
  for (const id of state.selectedIds) {
    if (!entryIds.has(id)) state.selectedIds.delete(id);
  }
  if (state.focusedEntryId && !entryIds.has(state.focusedEntryId)) state.focusedEntryId = null;
  if (state.selectionAnchorId && !entryIds.has(state.selectionAnchorId)) state.selectionAnchorId = null;
}

export function mergeRefreshEntries(
  current: readonly EnrichedEntry[],
  updates: readonly EnrichedEntry[],
): { entries: EnrichedEntry[]; newIds: Set<string> } {
  if (updates.length === 0) return { entries: [...current], newIds: new Set() };
  const byId = new Map(current.map(entry => [entry.id, entry]));
  const newIds = new Set<string>();
  for (const entry of updates) {
    if (!byId.has(entry.id)) newIds.add(entry.id);
    byId.set(entry.id, entry);
  }
  const entries = [...byId.values()].sort((a, b) => Date.parse(b.published) - Date.parse(a.published));
  return { entries, newIds };
}

export function timeAgo(iso: string): string {
  const date = new Date(iso);
  const timestamp = date.getTime();
  if (!Number.isFinite(timestamp)) return 'Unknown date';
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < -300) return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 172800) return 'yesterday';
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function safeHttpUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}
