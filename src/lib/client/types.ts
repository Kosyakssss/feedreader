import type { FeedsFile, Config, EnrichedEntry, RefreshStatus } from '../types';
export type { RefreshStatus, SharedEventPayload, SharedTopic } from '../types';
export interface FeedHealth {
  lastFetched: number | null;
  error: string | null;
  entryCount: number;
  checking?: boolean;
}
export interface FeedData extends FeedsFile {
  health?: Record<string, FeedHealth>;
}

export interface InitialData {
  base: string;
  entries: EnrichedEntry[];
  feeds: FeedData;
  config: Config;
  counts: { feedId: string; total: number; unread: number; starred: number; starredUnread: number }[];
  status: RefreshStatus;
}
