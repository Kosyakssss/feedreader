const REVEAL_DURATION_MS = 280;
const CONTENT_DURATION_MS = 220;
const STAGGER_MS = 34;
const MAX_STAGGER_MS = 136;
const REVEAL_EASING = 'cubic-bezier(0.2, 0, 0, 1)';

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
    const card = row.querySelector<HTMLElement>('.entry-card');
    const delay = Math.min(index * STAGGER_MS, MAX_STAGGER_MS);
    row.getAnimations().forEach(animation => animation.cancel());
    card?.getAnimations().forEach(animation => animation.cancel());
    row.classList.add('is-revealing');
    const layoutAnimation = row.animate(
      [
        { height: '0px' },
        { height: `${rect.height}px` },
      ],
      {
        duration: REVEAL_DURATION_MS,
        delay,
        easing: REVEAL_EASING,
        fill: 'backwards',
      },
    );
    const stopClipping = () => row.classList.remove('is-revealing');
    layoutAnimation.addEventListener('finish', stopClipping, { once: true });
    layoutAnimation.addEventListener('cancel', stopClipping, { once: true });
    if (card) {
      const finalOpacity = Number.parseFloat(getComputedStyle(card).opacity) || 1;
      card.animate(
        [
          { opacity: 0, transform: 'translateY(-4px)' },
          { opacity: finalOpacity, transform: 'translateY(0)' },
        ],
        {
          duration: CONTENT_DURATION_MS,
          delay,
          easing: REVEAL_EASING,
          fill: 'backwards',
        },
      );
    }
  });
}
