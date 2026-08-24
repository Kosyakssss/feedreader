export const REFRESH_SEGMENT_COUNT = 4;

export function filledRefreshSegments(completed: number, total: number): readonly boolean[] {
  const safeTotal = Math.max(0, Math.floor(total));
  const safeCompleted = Math.max(0, Math.min(Math.floor(completed), safeTotal));
  const filled = safeTotal === 0
    ? 0
    : safeCompleted === safeTotal
      ? REFRESH_SEGMENT_COUNT
      : Math.floor((safeCompleted * REFRESH_SEGMENT_COUNT) / safeTotal);
  return Array.from({ length: REFRESH_SEGMENT_COUNT }, (_, index) => index < filled);
}

export function activeRefreshSegment(completed: number, total: number): number | null {
  const segments = filledRefreshSegments(completed, total);
  if (total <= 0 || completed >= total) return null;
  const next = segments.findIndex(filled => !filled);
  return next === -1 ? null : next;
}
