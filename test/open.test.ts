import { describe, expect, test } from 'bun:test';
import {
  attemptBulkOpen,
  buildQueueOpenItems,
  resolveEntryOpenUrl,
  resolveOpenMode,
} from '../lib/open.ts';

const entries = [
  { id: 'a', url: 'https://example.com/a', title: 'Article A', feedLabel: 'Feed One' },
  { id: 'b', url: 'https://example.com/b', title: 'Article B', feedLabel: 'Feed One' },
  { id: 'c', url: 'https://example.com/c', title: 'Article C', feedLabel: 'Feed Two' },
];

describe('open helpers', () => {
  test('resolves defuddled and original modes', () => {
    expect(resolveOpenMode('original', false)).toBe('original');
    expect(resolveOpenMode('original', true)).toBe('defuddled');
    expect(resolveOpenMode('defuddled', false)).toBe('defuddled');
    expect(resolveOpenMode('defuddled', true)).toBe('original');
    expect(resolveEntryOpenUrl('https://example.com/a', 'original')).toBe('https://example.com/a');
    expect(resolveEntryOpenUrl('https://example.com/a', 'defuddled')).toBe('/read?url=https%3A%2F%2Fexample.com%2Fa');
  });

  test('builds queue items with resolved target urls', () => {
    const items = buildQueueOpenItems(entries.slice(0, 1), 'defuddled');
    expect(items).toEqual([
      {
        id: 'a',
        title: 'Article A',
        feedLabel: 'Feed One',
        targetUrl: '/read?url=https%3A%2F%2Fexample.com%2Fa',
        modeLabel: 'Defuddled view',
      },
    ]);
  });

  test('opens all entries directly when no popup blocking occurs', () => {
    const opened: string[] = [];
    const result = attemptBulkOpen(entries, {
      mode: 'original',
      openWindow: url => {
        opened.push(url);
        return true;
      },
      openQueuePage: () => false,
    });

    expect(opened).toEqual(entries.map(entry => entry.url));
    expect(result).toEqual({
      blocked: false,
      queued: false,
      directIds: ['a', 'b', 'c'],
      queuedIds: [],
      handledIds: ['a', 'b', 'c'],
    });
  });

  test('queues all remaining entries when popup blocking starts immediately', () => {
    const queued: unknown[] = [];
    const result = attemptBulkOpen(entries, {
      mode: 'original',
      openWindow: () => false,
      openQueuePage: items => {
        queued.push(items);
        return true;
      },
    });

    expect(queued).toHaveLength(1);
    expect(result).toEqual({
      blocked: true,
      queued: true,
      directIds: [],
      queuedIds: ['a', 'b', 'c'],
      handledIds: ['a', 'b', 'c'],
    });
  });

  test('queues only the remainder after some direct opens', () => {
    let calls = 0;
    const result = attemptBulkOpen(entries, {
      mode: 'defuddled',
      openWindow: () => {
        calls += 1;
        return calls < 3;
      },
      openQueuePage: () => true,
    });

    expect(result).toEqual({
      blocked: true,
      queued: true,
      directIds: ['a', 'b'],
      queuedIds: ['c'],
      handledIds: ['a', 'b', 'c'],
    });
  });

  test('does not mark blocked remainder as handled when queue page cannot open', () => {
    const result = attemptBulkOpen(entries, {
      mode: 'original',
      openWindow: url => url.endsWith('/a'),
      openQueuePage: () => false,
    });

    expect(result).toEqual({
      blocked: true,
      queued: false,
      directIds: ['a'],
      queuedIds: [],
      handledIds: ['a'],
    });
  });

  test('does nothing for an empty batch', () => {
    const result = attemptBulkOpen([], {
      mode: 'original',
      openWindow: () => true,
      openQueuePage: () => true,
    });

    expect(result.handledIds).toEqual([]);
    expect(result.directIds).toEqual([]);
    expect(result.queuedIds).toEqual([]);
  });
});
