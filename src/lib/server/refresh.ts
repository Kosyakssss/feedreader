import type { EnrichedEntry, RefreshStatus, FeedResultChange } from '../types';
import type { Storage } from './storage';
import type { Events } from './events';
import type { Diagnostics } from './diagnostics';
import { fetchAllFeeds } from './feeds/fetch';
export class Refresh {
  private job: Promise<number> | null = null;
  private pending: Set<string> | 'all' | null = null;
  private active = new Set<string>();
  private changes: EnrichedEntry[] = [];
  private results: FeedResultChange[] = [];
  private removed = new Set<string>();
  private progress = {
    runId: null as string | null,
    startedAt: null as number | null,
    finishedAt: null as number | null,
    count: 0,
    total: 0,
    completed: 0,
    succeeded: 0,
    failed: 0,
    error: null as string | null,
    failures: [] as RefreshStatus['failures'],
  };
  constructor(
    private store: Storage,
    private events: Events,
    private log: Diagnostics,
  ) {}
  get running(): boolean {
    return !!this.job;
  }
  get completion(): Promise<number> | null {
    return this.job;
  }
  status(
    since = 0,
    feedsSince = 0,
  ): RefreshStatus & {
    startedAt: number | null;
    finishedAt: number | null;
  } {
    const cursor = Math.min(since + 500, this.changes.length);
    const feedCursor = Math.min(feedsSince + 250, this.results.length);
    return {
      ...this.progress,
      failures: this.progress.failures.slice(-100),
      refreshing: this.running || cursor < this.changes.length || feedCursor < this.results.length,
      cursor,
      feedCursor,
      newEntries: this.changes.slice(since, cursor),
      feedResults: this.results.slice(feedsSince, feedCursor),
      removedIds: [...this.removed],
    };
  }
  start(ids?: readonly string[]): Promise<number> {
    if (ids === undefined) this.pending = 'all';
    else if (this.pending !== 'all') this.pending = new Set([...(this.pending ?? []), ...ids]);
    if (this.job) return this.job;
    this.active.clear();
    this.changes = [];
    this.results = [];
    this.removed.clear();
    this.progress = {
      runId: crypto.randomUUID(),
      startedAt: Date.now(),
      finishedAt: null,
      count: 0,
      total: 0,
      completed: 0,
      succeeded: 0,
      failed: 0,
      error: null,
      failures: [],
    };
    this.log.record('refresh.started', { runId: this.progress.runId });
    this.job = this.run()
      .catch((error) => {
        this.progress.error = error instanceof Error ? error.message : 'Refresh failed';
        this.log.record('refresh.failed', { runId: this.progress.runId });
        throw error;
      })
      .finally(() => {
        this.progress.finishedAt = Date.now();
        this.job = null;
        this.pending = null;
        this.notify([], [], [], true);
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
    finished = false,
  ): void {
    for (let offset = 0; offset < Math.max(1, entries.length); offset += 500)
      this.events.publish({
        topics: finished ? ['refresh', 'feeds'] : ['refresh'],
        refresh: {
          ...this.status(this.changes.length, this.results.length),
          newEntries: entries.slice(offset, offset + 500),
          feedResults,
          removedIds,
        },
      });
  }
  removeFeed(feedId: string, removedIds: string[]): void {
    for (const id of removedIds) this.removed.add(id);
    for (const entry of this.changes) if (entry.feedId === feedId) this.removed.add(entry.id);
  }
  private async run(): Promise<number> {
    let added = 0;
    while (this.pending !== null) {
      const requested = this.pending;
      this.pending = null;
      const feeds = this.store
        .feeds()
        .filter((feed) => !this.active.has(feed.id) && (requested === 'all' || requested.has(feed.id)));
      feeds.forEach((feed) => this.active.add(feed.id));
      this.progress.total += feeds.length;
      await fetchAllFeeds(feeds, this.store.validators(), async (feed, result, durationMs) => {
        const time = Date.now();
        const saving = performance.now();
        const committed = this.store.saveFeed(feed, result, time);
        const saveMs = Math.round((performance.now() - saving) * 100) / 100;
        this.changes.push(...committed.entries);
        for (const id of committed.removed) this.removed.add(id);
        added += committed.entries.length;
        this.progress.count = added;
        this.progress.completed++;
        this.results.push({
          sequence: this.results.length + 1,
          feedId: feed.id,
          entryCount: result.notModified ? null : result.entries.length,
          error: result.error ?? null,
          completedAt: time,
        });
        if (result.error) {
          this.progress.failed++;
          this.progress.failures.push({ feedId: feed.id, label: feed.label, error: result.error });
        } else this.progress.succeeded++;
        this.log.record('feed.fetched', {
          saveMs,
          runId: this.progress.runId,
          feedId: feed.id,
          entries: result.entries.length,
          ok: !result.error,
          durationMs: Math.round(durationMs * 100) / 100,
        });
        this.notify(committed.entries, this.results.slice(-1), committed.removed);
      });
    }
    return added;
  }
}
