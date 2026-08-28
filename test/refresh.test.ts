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
    const poller = new RefreshPoller(() => undefined, () => 0, () => 0, client);

    const active = poller.run(['imported']);
    const full = poller.run();
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
