const REVEAL_DURATION_MS = 280;
const STAGGER_MS = 34;
const MAX_STAGGER_MS = 136;

function motionAllowed(): boolean {
  return !matchMedia('(prefers-reduced-motion: reduce)').matches && document.visibilityState === 'visible';
}

function isVisible(rect: DOMRect): boolean {
  return rect.bottom > 0 && rect.top < innerHeight;
}

export function animateEntryChanges(
  rows: readonly HTMLElement[],
  newIds: ReadonlySet<string>,
): void {
  if (!motionAllowed()) return;

  const newRows = rows
    .filter(row => newIds.has(row.dataset.id ?? ''))
    .map(row => ({ row, rect: row.getBoundingClientRect() }))
    .filter(({ rect }) => isVisible(rect))
    .sort((a, b) => a.rect.top - b.rect.top);

  newRows.forEach(({ row, rect }, index) => {
    row.getAnimations().forEach(animation => animation.cancel());
    row.animate(
      [
        { height: '0px', opacity: 0, transform: 'translateY(-6px)', clipPath: 'inset(0 0 100% 0)' },
        { height: `${rect.height}px`, opacity: 1, transform: 'translateY(0)', clipPath: 'inset(0 0 0 0)' },
      ],
      {
        duration: REVEAL_DURATION_MS,
        delay: Math.min(index * STAGGER_MS, MAX_STAGGER_MS),
        easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
        fill: 'backwards',
      },
    );
  });
}
