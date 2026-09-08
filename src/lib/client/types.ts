import type { FeedsFile } from '../types';
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
