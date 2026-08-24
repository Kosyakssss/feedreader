const MOVE_DURATION_MS = 220;
const REVEAL_DURATION_MS = 240;
const MAX_STAGGER_MS = 120;

function motionAllowed(): boolean {
  return !matchMedia('(prefers-reduced-motion: reduce)').matches && document.visibilityState === 'visible';
}

function isVisible(rect: DOMRect): boolean {
  return rect.bottom > 0 && rect.top < innerHeight;
}

export function animateEntryChanges(
  rows: readonly HTMLElement[],
  previousRects: ReadonlyMap<string, DOMRect>,
  newIds: ReadonlySet<string>,
): void {
  if (!motionAllowed()) return;

  const newRows = rows
    .filter(row => newIds.has(row.dataset.id ?? ''))
    .map(row => ({ row, rect: row.getBoundingClientRect() }))
    .filter(({ rect }) => isVisible(rect))
    .sort((a, b) => a.rect.top - b.rect.top);

  for (const row of rows) {
    const id = row.dataset.id;
    if (!id || newIds.has(id)) continue;
    const previous = previousRects.get(id);
    if (!previous) continue;
    const current = row.getBoundingClientRect();
    const deltaY = previous.top - current.top;
    if (Math.abs(deltaY) < 0.5 || (!isVisible(previous) && !isVisible(current))) continue;
    row.getAnimations().forEach(animation => animation.cancel());
    row.animate(
      [{ transform: `translateY(${deltaY}px)` }, { transform: 'translateY(0)' }],
      { duration: MOVE_DURATION_MS, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
    );
  }

  newRows.forEach(({ row }, index) => {
    row.getAnimations().forEach(animation => animation.cancel());
    row.animate(
      [
        { opacity: 0, transform: 'translateY(-7px)', clipPath: 'inset(0 0 100% 0)' },
        { opacity: 1, transform: 'translateY(0)', clipPath: 'inset(0 0 0 0)' },
      ],
      {
        duration: REVEAL_DURATION_MS,
        delay: Math.min(index * 28, MAX_STAGGER_MS),
        easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
        fill: 'backwards',
      },
    );
  });
}
