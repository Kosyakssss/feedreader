import { expect, test } from 'bun:test';
import { EntryIndex } from '../lib/entry-index.ts';
import type { Entry } from '../lib/types.ts';

function entry(sourceId: string, overrides: Partial<Entry> = {}): Entry {
  return { id: `feed:${sourceId}`, sourceId, feedId: 'feed', url: '', title: sourceId, published: '2026-01-01', ...overrides };
}

test('retains cached identities from the old numeric parser', () => {
  for (const [old, fresh] of [['1', '001'], ['16', '+0x10'], ['100', '01e2'], ['1.23', '1.2300']]) {
    const index = new EntryIndex([entry(old!)]);
    expect(index.add(entry(fresh!), 'feed')).toBe(false);
  }
  const fresh = new EntryIndex([]);
  expect(fresh.add(entry('001'), 'feed')).toBe(true);
  expect(fresh.add(entry('1'), 'feed')).toBe(true);
});

test('deduplicates within a feed without merging other feeds', () => {
  const index = new EntryIndex([entry('old', { url: 'https://example.com/article' })]);
  expect(index.add(entry('new', { url: 'https://example.com/article' }), 'feed')).toBe(false);
  expect(index.add(entry('new', { id: 'other:new', feedId: 'other', url: 'https://example.com/article' }), 'other')).toBe(true);
  expect(index.add(entry('wrong'), 'other')).toBe(false);
});

test('does not merge identifiers that lose precision as numbers', () => {
  const index = new EntryIndex([entry('9007199254740992'), entry('1'), entry('0')]);
  expect(index.add(entry('9007199254740993'), 'feed')).toBe(true);
  expect(index.add(entry('1.0000000000000001'), 'feed')).toBe(true);
  expect(index.add(entry('00e2'), 'feed')).toBe(true);
});
