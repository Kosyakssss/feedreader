export interface Feed {
  id: string;
  url: string;
  label: string;
  folderId: string | null;
}
export interface FeedsFile {
  folders: Folder[];
  feeds: Feed[];
}
interface Folder {
  id: string;
  name: string;
}
export interface Entry {
  id: string;
  sourceId?: string;
  feedId: string;
  url: string;
  title: string;
  published: string;
}
export interface EntryState {
  read?: boolean;
  readAt?: number;
  starred?: boolean;
  starredAt?: number;
}
export interface StateFile {
  [entryId: string]: EntryState;
}
export interface Config {
  maxBulkOpen: number;
  retention: {
    maxEntries: number;
    maxDays: number | null;
  };
  theme: string | null;
  port: number;
  trustedOrigins: string[];
}
export interface CacheFile {
  entries: Entry[];
  lastFetched: Record<string, number>;
  feedErrors: Record<string, string>;
  feedMeta: Record<string, FeedCacheMeta>;
}
export interface EnrichedEntry extends Entry {
  feedLabel: string;
  state: EntryState;
}
export interface FeedCacheMeta {
  etag?: string;
  lastModified?: string;
}
export const DEFAULT_CONFIG: Config = {
  maxBulkOpen: 20,
  retention: { maxEntries: 3000, maxDays: null },
  theme: 'system',
  port: 8787,
  trustedOrigins: [],
};
interface RefreshFailure {
  feedId: string;
  label: string;
  error: string;
}
export interface FeedResultChange {
  sequence: number;
  feedId: string;
  entryCount: number | null;
  error: string | null;
  completedAt: number;
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
  feedCursor: number;
  newEntries: EnrichedEntry[];
  feedResults: FeedResultChange[];
  removedIds: string[];
}
export type SharedTopic = 'sync' | 'refresh' | 'entries' | 'feeds' | 'config' | 'entry-state';
export interface SharedEventPayload {
  topics: SharedTopic[];
  entryStates?: Record<string, EntryState>;
  refresh?: RefreshStatus;
}
