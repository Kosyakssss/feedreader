import { describe, expect, test } from 'bun:test';

import type { FeedreaderApi } from '../client/api.ts';
import { RefreshPoller } from '../client/refresh.ts';
import type { RefreshStatus } from '../client/state.ts';
import { pageChanges } from '../lib/refresh-deltas.ts';
import { RefreshRequestQueue } from '../lib/refresh-requests.ts';

function status(overrides: Partial<RefreshStatus> = {}): RefreshStatus {
  return {
    count: 0,
    refreshing: false,
    error: null,
    runId: 'run',
    total: 0,
    completed: 0,
    succeeded: 0,
    failed: 0,
    failures: [],
    cursor: 0,
    feedCursor: 0,
    newEntries: [],
    feedResults: [],
    removedIds: [],
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(nextResolve => { resolve = nextResolve; });
  return { promise, resolve };
}

describe('refresh request queuing', () => {
  test('a full refresh supersedes queued feed-only requests without repeating active feeds', () => {
    const queue = new RefreshRequestQueue();
    queue.enqueue(['one']);
    queue.enqueue(undefined);
    queue.enqueue(['two']);

    expect([...queue.take(['one', 'two', 'three'], new Set(['one']))]).toEqual(['two', 'three']);
    expect(queue.pending).toBe(false);
  });

  test('coalesces filtered requests and clears them after they are consumed', () => {
    const queue = new RefreshRequestQueue();
    queue.enqueue(['one', 'two']);
    queue.enqueue(['two', 'three']);

    expect([...queue.take(['one', 'two', 'three'], new Set(['two']))]).toEqual(['one', 'three']);
    expect(queue.take(['one', 'two', 'three'], new Set()).size).toBe(0);
  });

  test('signals the server when a refresh request arrives during active polling', async () => {
    const first = deferred<RefreshStatus>();
    const requests: Array<string[] | undefined> = [];
    const client = {
      startRefresh: async (feedIds?: string[]) => {
        requests.push(feedIds);
        return requests.length === 1 ? first.promise : status();
      },
      refreshStatus: async () => status(),
    } as unknown as FeedreaderApi;
    const poller = new RefreshPoller(() => undefined, client);

    const active = poller.run(['imported']);
    const full = poller.run();
    await Promise.resolve();
    expect(requests).toEqual([['imported'], undefined]);

    first.resolve(status());
    await Promise.all([active, full]);
  });
});

describe('refresh delta pagination', () => {
  test('drains capped pages without skipping or repeating changes', () => {
    const changes = Array.from({ length: 600 }, (_, index) => ({ sequence: index + 1, value: index + 1 }));
    const first = pageChanges(changes, 0, 500);
    const second = pageChanges(changes, first.cursor, 500);

    expect(first.items).toHaveLength(500);
    expect(first.cursor).toBe(500);
    expect(first.hasMore).toBe(true);
    expect(second.items.map(change => change.value)).toEqual(Array.from({ length: 100 }, (_, index) => index + 501));
    expect(second.cursor).toBe(600);
    expect(second.hasMore).toBe(false);
  });

  test('keeps a valid cursor when there are no newer changes', () => {
    expect(pageChanges([{ sequence: 1 }, { sequence: 2 }], 9, 10)).toEqual({
      items: [],
      cursor: 2,
      hasMore: false,
    });
  });
});

describe('shared refresh coordinator', () => {
  test('coalesces concurrent wakeups and drains every page', async () => {
    const first = deferred<RefreshStatus>();
    const requested: number[] = [];
    const received: number[] = [];
    const poller = new RefreshPoller(value => received.push(value.cursor), {
      refreshStatus: async (cursor: number) => {
        requested.push(cursor);
        return requested.length === 1 ? first.promise : status({ cursor: 2 });
      },
    } as unknown as FeedreaderApi);
    const a = poller.sync();
    const b = poller.sync();
    expect(requested).toEqual([0]);
    first.resolve(status({ refreshing: true, cursor: 1, feedResults: [{
      sequence: 1, feedId: 'one', completedAt: 1, entryCount: 1, error: null,
    }] }));
    await Promise.all([a, b]);
    expect(requested).toEqual([0, 1]);
    expect(received).toEqual([1, 2]);
  });

  test('restarts at zero when the server has begun another run', async () => {
    const requested: number[] = [];
    const received: string[] = [];
    const poller = new RefreshPoller(value => received.push(`${value.runId}:${value.cursor}`), {
      refreshStatus: async (cursor: number) => {
        requested.push(cursor);
        return requested.length === 1 ? status({ runId: 'old', cursor: 9 }) : status({ runId: 'new', cursor: 1 });
      },
    } as unknown as FeedreaderApi);
    await poller.sync();
    await poller.sync();
    expect(requested).toEqual([0, 9, 0]);
    expect(received).toEqual(['old:9', 'new:1']);
  });

  test('a resume during an in-flight request discards its old cursor', async () => {
    const delayed = deferred<RefreshStatus>();
    const requested: number[] = [];
    const received: number[] = [];
    const poller = new RefreshPoller(value => received.push(value.cursor), {
      refreshStatus: async (cursor: number) => {
        requested.push(cursor);
        return requested.length === 2 ? delayed.promise : status({ cursor: requested.length });
      },
    } as unknown as FeedreaderApi);
    await poller.sync();
    const inFlight = poller.sync();
    const resumed = poller.sync(true);
    delayed.resolve(status({ cursor: 99 }));
    await Promise.all([inFlight, resumed]);
    expect(requested).toEqual([0, 1, 0]);
    expect(received).toEqual([1, 3]);
  });
});
