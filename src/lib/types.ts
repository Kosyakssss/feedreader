export interface Feed {
  id: string;
  url: string;
  label: string;
}
export interface Entry {
  id: string;
  sourceId: string;
  feedId: string;
  url: string;
  title: string;
  published: string;
  publishedTime: number;
}
export interface EntryState {
  read?: boolean;
  readAt?: number;
  starred?: boolean;
  starredAt?: number;
}
export interface Config {
  maxBulkOpen: number;
  retention: { maxEntries: number; maxDays?: number };
  theme: string;
  appearance: 'system' | 'light' | 'dark';
  port: number;
  trustedOrigins: string[];
}
export const DEFAULT_CONFIG: Config = {
  maxBulkOpen: 20,
  retention: { maxEntries: 3000 },
  theme: 'default',
  appearance: 'system',
  port: 8787,
  trustedOrigins: [],
};
export interface EnrichedEntry extends Entry {
  feedLabel: string;
  state: EntryState;
}
export interface FeedCacheMeta {
  etag?: string;
  lastModified?: string;
}
export interface FeedHealth {
  lastFetched: number | null;
  error: string | null;
}
export interface FeedData {
  feeds: Feed[];
  health: Record<string, FeedHealth>;
}
export interface RefreshStatus {
  runId: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  refreshing: boolean;
  count: number;
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  error: string | null;
  failures: { feedId: string; label: string; error: string }[];
}
export interface FeedResultChange {
  feedId: string;
  error: string | null;
  completedAt: number;
}
export interface Theme {
  name: string;
  appearances: ('light' | 'dark')[];
}
export interface SharedEventPayload {
  topics: ('sync' | 'entries' | 'feeds' | 'config')[];
  entryStates?: Record<string, EntryState>;
  refresh?: RefreshStatus;
  entries?: EnrichedEntry[];
  feedResults?: FeedResultChange[];
  removedIds?: string[];
}
export interface InitialData {
  entries: EnrichedEntry[];
  feeds: FeedData;
  config: Config;
  themes: Theme[];
  counts: { feedId: string; total: number; unread: number; starred: number; starredUnread: number }[];
  status: RefreshStatus;
}
export interface Snapshot extends Omit<InitialData, 'counts'> {
  eventId: number;
}
