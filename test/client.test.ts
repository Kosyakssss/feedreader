import { describe, expect, test } from 'bun:test';

import { exceedsSelectionDragThreshold } from '../client/interactions.ts';
import { activeRefreshSegment, filledRefreshSegments } from '../client/refresh-progress.ts';
import { mergeRefreshEntries } from '../client/state.ts';
import { renderApp } from '../lib/render.ts';
import type { EnrichedEntry } from '../lib/types.ts';

describe('refresh progress segments', () => {
  test('each segment is always entirely empty or entirely filled', () => {
    for (let completed = 0; completed <= 10; completed++) {
      const segments = filledRefreshSegments(completed, 10);
      expect(segments).toHaveLength(4);
      expect(segments.every(value => typeof value === 'boolean')).toBe(true);
    }
  });

  test('advances only at confirmed quartile boundaries', () => {
    expect(filledRefreshSegments(0, 10)).toEqual([false, false, false, false]);
    expect(filledRefreshSegments(2, 10)).toEqual([false, false, false, false]);
    expect(filledRefreshSegments(3, 10)).toEqual([true, false, false, false]);
    expect(filledRefreshSegments(5, 10)).toEqual([true, true, false, false]);
    expect(filledRefreshSegments(7, 10)).toEqual([true, true, false, false]);
    expect(filledRefreshSegments(8, 10)).toEqual([true, true, true, false]);
    expect(filledRefreshSegments(10, 10)).toEqual([true, true, true, true]);
  });

  test('handles small, invalid, and over-complete totals safely', () => {
    expect(filledRefreshSegments(1, 3)).toEqual([true, false, false, false]);
    expect(filledRefreshSegments(2, 3)).toEqual([true, true, false, false]);
    expect(filledRefreshSegments(3, 3)).toEqual([true, true, true, true]);
    expect(filledRefreshSegments(12, 10)).toEqual([true, true, true, true]);
    expect(filledRefreshSegments(-1, 10)).toEqual([false, false, false, false]);
    expect(filledRefreshSegments(1, 0)).toEqual([false, false, false, false]);
  });

  test('animates only the next incomplete segment', () => {
    expect(activeRefreshSegment(0, 10)).toBe(0);
    expect(activeRefreshSegment(3, 10)).toBe(1);
    expect(activeRefreshSegment(5, 10)).toBe(2);
    expect(activeRefreshSegment(8, 10)).toBe(3);
    expect(activeRefreshSegment(10, 10)).toBeNull();
    expect(activeRefreshSegment(0, 0)).toBeNull();
  });
});

describe('refresh entry reconciliation', () => {
  test('inserts a new entry at its actual middle sort position', () => {
    const current = [entry('newer', '2026-08-24T12:00:00Z'), entry('older', '2026-08-24T10:00:00Z')];
    const middle = entry('middle', '2026-08-24T11:00:00Z');
    const result = mergeRefreshEntries(current, [middle]);

    expect(result.entries.map(item => item.id)).toEqual(['newer', 'middle', 'older']);
    expect([...result.newIds]).toEqual(['middle']);
    expect(result.entries[0]).toBe(current[0]);
    expect(result.entries[2]).toBe(current[1]);
  });

  test('updates an existing keyed entry without treating it as new', () => {
    const current = [entry('same', '2026-08-24T10:00:00Z')];
    const updated = { ...current[0]!, title: 'Updated title' };
    const result = mergeRefreshEntries(current, [updated]);

    expect(result.entries).toEqual([updated]);
    expect(result.newIds.size).toBe(0);
  });
});

describe('selection gesture threshold', () => {
  test('keeps stationary and incidental movement on the native click path', () => {
    expect(exceedsSelectionDragThreshold(20, 20, 20, 20)).toBe(false);
    expect(exceedsSelectionDragThreshold(20, 20, 25, 23)).toBe(false);
  });

  test('enters drag selection only after deliberate movement', () => {
    expect(exceedsSelectionDragThreshold(20, 20, 26, 20)).toBe(true);
    expect(exceedsSelectionDragThreshold(20, 20, 25, 24)).toBe(true);
  });

  test('gives touch taps more movement tolerance before drag selection', () => {
    expect(exceedsSelectionDragThreshold(20, 20, 29, 20, 'touch')).toBe(false);
    expect(exceedsSelectionDragThreshold(20, 20, 30, 20, 'touch')).toBe(true);
    expect(exceedsSelectionDragThreshold(20, 20, 26, 20, 'pen')).toBe(false);
    expect(exceedsSelectionDragThreshold(20, 20, 28, 20, 'pen')).toBe(true);
  });
});

describe('code-native interface icons', () => {
  test('renders the shared SVG symbols without platform text glyphs', () => {
    const html = renderApp('/feedreader');
    expect(html).toContain('id="icon-menu"');
    expect(html).toContain('id="icon-trash"');
    expect(html).toContain('href="#icon-bookmark"');
    expect(html).not.toContain('☰');
    expect(html).not.toContain('🔖');
  });
});

function entry(id: string, published: string): EnrichedEntry {
  return {
    id,
    feedId: 'feed',
    feedLabel: 'Feed',
    title: id,
    url: `https://example.com/${id}`,
    published,
    state: {},
  };
}
