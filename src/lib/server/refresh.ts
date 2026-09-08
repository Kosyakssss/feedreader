import type { EnrichedEntry, Feed, RefreshStatus, FeedResultChange } from '../types';
import type { Storage, Snapshot } from './storage';
import type { Events } from './events';
import type { Diagnostics } from './diagnostics';
import { EntryIndex } from './entries';
import { fetchAllFeeds, type FeedFetchResult } from './feeds/fetch';
import { decodeHtmlEntities, publishedTime } from './feeds/parse';
import { isSafeExternalUrl } from './security';
import { pruneEntries } from './normalize';
export function enrich(data: Snapshot, entries = data.cache.entries): EnrichedEntry[] {
  const labels = new Map(data.feeds.feeds.map((feed) => [feed.id, feed.label]));
  return entries
    .map((entry) => ({
      ...entry,
      title: decodeHtmlEntities(entry.title),
      url: isSafeExternalUrl(entry.url).ok ? entry.url : '',
      feedLabel: labels.get(entry.feedId) ?? 'Unknown',
      state: data.state[entry.id] ?? {},
    }))
    .sort((a, b) => publishedTime(b) - publishedTime(a));
}
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
  get knownIds(): string[] {
    return this.changes.filter((entry) => !this.removed.has(entry.id)).map((entry) => entry.id);
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
      .catch(async (error) => {
        this.progress.error = error instanceof Error ? error.message : 'Refresh failed';
        const persisted = new Set((await this.store.read()).cache.entries.map((entry) => entry.id));
        for (const entry of this.changes) if (!persisted.has(entry.id)) this.removed.add(entry.id);
        this.log.record('refresh.failed', { runId: this.progress.runId });
        throw error;
      })
      .finally(() => {
        this.progress.finishedAt = Date.now();
        this.job = null;
        this.pending = null;
        this.events.publish({ topics: ['refresh', 'feeds'] });
        this.log.record('refresh.finished', {
          runId: this.progress.runId,
          durationMs: Date.now() - this.progress.startedAt!,
          added: this.progress.count,
          failed: this.progress.failed,
        });
      });
    this.events.publish({ topics: ['refresh'] });
    return this.job;
  }
  removeFeed(feedId: string, removedIds: string[]): void {
    for (const id of removedIds) this.removed.add(id);
    for (const entry of this.changes) if (entry.feedId === feedId) this.removed.add(entry.id);
  }
  private async run(): Promise<number> {
    await this.store.mergeConflicts();
    const starting = await this.store.read();
    const index = new EntryIndex(starting.cache.entries);
    let added = 0;
    while (this.pending !== null) {
      const requested = this.pending;
      this.pending = null;
      const data = await this.store.read();
      const feeds = data.feeds.feeds.filter(
        (feed) => !this.active.has(feed.id) && (requested === 'all' || requested.has(feed.id)),
      );
      feeds.forEach((feed) => this.active.add(feed.id));
      this.progress.total += feeds.length;
      const completed: {
        feed: Feed;
        result: FeedFetchResult;
        time: number;
      }[] = [];
      await fetchAllFeeds(feeds, data.cache.feedMeta, async (feed, result, durationMs) => {
        const time = Date.now();
        completed.push({ feed, result, time });
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
        const fresh = result.entries.filter((entry) => index.add(entry, feed.id));
        this.changes.push(...enrich(data, fresh));
        this.progress.count += fresh.length;
        this.log.record('feed.fetched', {
          runId: this.progress.runId,
          feedId: feed.id,
          entries: result.entries.length,
          ok: !result.error,
          durationMs: Math.round(durationMs * 100) / 100,
        });
        this.events.publish({ topics: ['refresh'] });
      });
      const committed = await this.store.change(['cache', 'state'], (current) => {
        const known = new Set(current.feeds.feeds.map((feed) => feed.id));
        const index = new EntryIndex(current.cache.entries);
        const addedIds: string[] = [];
        const original = current.cache.entries.map((entry) => entry.id);
        for (const { feed, result, time } of completed) {
          if (!known.has(feed.id)) continue;
          for (const entry of result.entries)
            if (index.add(entry, feed.id)) {
              current.cache.entries.push(entry);
              addedIds.push(entry.id);
            }
          current.cache.lastFetched[feed.id] = time;
          if (result.error) current.cache.feedErrors[feed.id] = result.error;
          else {
            delete current.cache.feedErrors[feed.id];
            current.cache.feedMeta[feed.id] = result.validators ?? {};
          }
        }
        const pruned = pruneEntries(current.cache, current.state, current.config);
        current.cache = pruned.cache;
        current.state = pruned.state;
        const retained = new Set(current.cache.entries.map((entry) => entry.id));
        return {
          removed: [...original, ...this.knownIds].filter((id) => !retained.has(id)),
          added: addedIds.filter((id) => retained.has(id)).length,
        };
      });
      added += committed.added;
      for (const id of committed.removed) this.removed.add(id);
      this.progress.count = added;
      this.log.record('refresh.persisted', { runId: this.progress.runId, added });
      this.events.publish({ topics: ['refresh'] });
    }
    return added;
  }
}
