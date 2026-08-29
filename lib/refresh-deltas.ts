export interface SequencedChange {
  sequence: number;
}

export interface ChangePage<T> {
  items: T[];
  cursor: number;
  hasMore: boolean;
}

export function pageChanges<T extends SequencedChange>(
  changes: readonly T[],
  since: number,
  limit: number,
): ChangePage<T> {
  const items = changes.filter(change => change.sequence > since).slice(0, limit);
  const lastSequence = changes.at(-1)?.sequence ?? 0;
  const cursor = items.at(-1)?.sequence ?? Math.min(since, lastSequence);
  return { items, cursor, hasMore: cursor < lastSequence };
}
