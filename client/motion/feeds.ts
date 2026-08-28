const REVEAL_DURATION_MS = 280;
const CONTENT_DURATION_MS = 220;
const EXIT_DURATION_MS = 180;
const STAGGER_MS = 30;
const MAX_STAGGER_MS = 150;
const REVEAL_EASING = 'cubic-bezier(0.2, 0, 0, 1)';
const EXIT_EASING = 'cubic-bezier(0.4, 0, 1, 1)';

function motionAllowed(): boolean {
  return !matchMedia('(prefers-reduced-motion: reduce)').matches && document.visibilityState === 'visible';
}

function visible(rect: DOMRect): boolean {
  return rect.bottom > 0 && rect.top < innerHeight;
}

function cancelAnimations(node: HTMLElement): void {
  node.getAnimations?.().forEach(animation => animation.cancel());
  node.querySelector<HTMLElement>('.feed-item, .feed-pending')
    ?.getAnimations?.()
    .forEach(animation => animation.cancel());
}

function revealSlot(slot: HTMLElement, content: HTMLElement, delay: number): void {
  if (typeof slot.animate !== 'function' || typeof content.animate !== 'function') return;
  const rect = slot.getBoundingClientRect();
  cancelAnimations(slot);
  slot.classList.add('is-revealing');
  const layout = slot.animate(
    [{ height: '0px' }, { height: `${rect.height}px` }],
    { duration: REVEAL_DURATION_MS, delay, easing: REVEAL_EASING, fill: 'backwards' },
  );
  const finish = () => slot.classList.remove('is-revealing');
  layout.addEventListener('finish', finish, { once: true });
  layout.addEventListener('cancel', finish, { once: true });
  content.animate(
    [{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'translateY(0)' }],
    { duration: CONTENT_DURATION_MS, delay, easing: REVEAL_EASING, fill: 'backwards' },
  );
}

export function animateFeedRows(
  slots: readonly HTMLElement[],
  newIds: ReadonlySet<string>,
  initialDelay = 0,
): void {
  if (!motionAllowed()) return;
  const visibleSlots = slots
    .filter(slot => newIds.has(slot.dataset.feedId ?? ''))
    .map(slot => ({ slot, rect: slot.getBoundingClientRect() }))
    .filter(({ rect }) => visible(rect))
    .sort((a, b) => a.rect.top - b.rect.top);

  visibleSlots.forEach(({ slot }, index) => {
    const item = slot.querySelector<HTMLElement>('.feed-item');
    if (!item) return;
    revealSlot(slot, item, initialDelay + Math.min(index * STAGGER_MS, MAX_STAGGER_MS));
  });
}

export function animatePendingFeedEnter(slot: HTMLElement): void {
  const pending = slot.querySelector<HTMLElement>('.feed-pending');
  if (!pending || !motionAllowed()) return;
  revealSlot(slot, pending, 0);
}

export async function animatePendingFeedExit(slot: HTMLElement): Promise<boolean> {
  return await collapseSlot(slot, slot.querySelector<HTMLElement>('.feed-pending'));
}

export async function animateFeedRemoval(id: string): Promise<void> {
  const slot = [...document.querySelectorAll<HTMLElement>('.feed-slot[data-feed-id]')]
    .find(candidate => candidate.dataset.feedId === id);
  if (!slot) return;
  await collapseSlot(slot, slot.querySelector<HTMLElement>('.feed-item'));
}

export function cancelFeedSlotMotion(slot: HTMLElement): void {
  cancelAnimations(slot);
  slot.classList.remove('is-revealing', 'is-exiting');
}

async function collapseSlot(slot: HTMLElement, content: HTMLElement | null): Promise<boolean> {
  if (!motionAllowed() || typeof slot.animate !== 'function') return true;
  cancelAnimations(slot);
  const height = slot.getBoundingClientRect().height;
  slot.classList.add('is-exiting');
  const layout = slot.animate(
    [{ height: `${height}px` }, { height: '0px' }],
    { duration: EXIT_DURATION_MS, easing: EXIT_EASING, fill: 'forwards' },
  );
  content?.animate(
    [
      { opacity: 1 },
      { opacity: 0 },
    ],
    { duration: EXIT_DURATION_MS, easing: EXIT_EASING, fill: 'forwards' },
  );
  try {
    await layout.finished;
    return true;
  } catch {
    return false;
  }
}
