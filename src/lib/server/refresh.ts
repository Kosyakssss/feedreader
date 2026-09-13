import type { EnrichedEntry, RefreshStatus, FeedResultChange } from '../types';
import type { Storage } from './storage';
import type { Configuration } from './config';
import type { Events } from './events';
import type { Diagnostics } from './diagnostics';
import { fetchAllFeeds } from './feed-fetch';

export class Refresh {
  private job: Promise<number> | null = null;
  private pending: Set<string> | 'all' | null = null;
  private active = new Set<string>();
  private progress: RefreshStatus = this.empty();
  constructor(
    private store: Storage,
    private config: Configuration,
    private events: Events,
    private log: Diagnostics,
  ) {}
  private empty(): RefreshStatus {
    return {
      runId: null,
      startedAt: null,
      finishedAt: null,
      refreshing: false,
      count: 0,
      total: 0,
      completed: 0,
      succeeded: 0,
      failed: 0,
      error: null,
      failures: [],
    };
  }
  get running(): boolean {
    return !!this.job;
  }
  get completion(): Promise<number> | null {
    return this.job;
  }
  status(): RefreshStatus {
    return { ...this.progress, failures: [...this.progress.failures] };
  }
  start(ids?: readonly string[]): Promise<number> {
    if (ids === undefined) this.pending = 'all';
    else if (this.pending !== 'all') this.pending = new Set([...(this.pending ?? []), ...ids]);
    if (this.job) return this.job;
    this.active.clear();
    this.progress = { ...this.empty(), runId: crypto.randomUUID(), startedAt: Date.now(), refreshing: true };
    this.log.record('refresh.started', { runId: this.progress.runId });
    this.job = this.run()
      .catch((error) => {
        this.progress.error = error instanceof Error ? error.message : 'Refresh failed';
        throw error;
      })
      .finally(() => {
        this.progress.finishedAt = Date.now();
        this.progress.refreshing = false;
        this.job = null;
        this.pending = null;
        this.notify();
        this.log.record('refresh.finished', {
          runId: this.progress.runId,
          durationMs: Date.now() - this.progress.startedAt!,
          added: this.progress.count,
          failed: this.progress.failed,
        });
      });
    this.notify();
    return this.job;
  }
  private notify(
    entries: EnrichedEntry[] = [],
    feedResults: FeedResultChange[] = [],
    removedIds: string[] = [],
  ): void {
    for (let offset = 0; offset < Math.max(1, entries.length); offset += 500)
      this.events.publish({
        topics: [],
        refresh: this.status(),
        entries: entries.slice(offset, offset + 500),
        feedResults,
        removedIds,
      });
  }
  private async run(): Promise<number> {
    try {
      while (this.pending !== null) {
        const requested = this.pending;
        this.pending = null;
        const feeds = this.store
          .refreshFeeds()
          .filter((feed) => !this.active.has(feed.id) && (requested === 'all' || requested.has(feed.id)));
        feeds.forEach((feed) => this.active.add(feed.id));
        this.progress.total += feeds.length;
        this.notify();
        await fetchAllFeeds(feeds, (feed, result, durationMs) => {
          const time = Date.now(),
            saving = performance.now();
          const entries = this.store.saveFeed(feed, result, time);
          this.progress.count += entries.length;
          this.progress.completed++;
          if (result.error) {
            this.progress.failed++;
            this.progress.failures.push({ feedId: feed.id, label: feed.label, error: result.error });
            if (this.progress.failures.length > 100) this.progress.failures.shift();
          } else this.progress.succeeded++;
          this.log.record('feed.fetched', {
            saveMs: Math.round((performance.now() - saving) * 100) / 100,
            runId: this.progress.runId,
            feedId: feed.id,
            entries: result.entries.length,
            ok: !result.error,
            durationMs: Math.round(durationMs),
          });
          this.notify(entries, [
            {
              feedId: feed.id,
              error: result.error ?? null,
              completedAt: time,
            },
          ]);
        });
      }
    } finally {
      const removed = this.store.prune(this.config.read().retention);
      if (removed.length) this.notify([], [], removed);
    }
    return this.progress.count;
  }
}
