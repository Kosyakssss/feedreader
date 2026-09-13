import type { TransitionConfig } from 'svelte/transition';
function bezier(x1: number, y1: number, x2: number, y2: number) {
  let sampler: Animation;
  return (progress: number) => {
    sampler ??= new Animation(
      new KeyframeEffect(null, [], {
        duration: 1,
        fill: 'both',
        easing: `cubic-bezier(${x1}, ${y1}, ${x2}, ${y2})`,
      }),
    );
    sampler.currentTime = progress;
    return sampler.effect!.getComputedTiming().progress ?? progress;
  };
}
const easing = bezier(0.2, 0, 0, 1),
  anticipation = bezier(0.4, 0, 0.6, 1),
  exit = bezier(0.3, 0, 0.4, 1);
export function motionAllowed(node: HTMLElement): boolean {
  const rect = node.getBoundingClientRect();
  return (
    !matchMedia('(prefers-reduced-motion: reduce)').matches &&
    document.visibilityState === 'visible' &&
    rect.bottom > 0 &&
    rect.top < innerHeight
  );
}
export function reveal(
  node: HTMLElement,
  { active = false, delay = 0, replacement = false } = {},
): TransitionConfig {
  if (!active || !motionAllowed(node)) return { duration: 0 };
  if (replacement)
    return {
      duration: 280,
      easing,
      css: (t) =>
        `clip-path:inset(${(1 - t) * 100}% 0 0 0);transform:translateY(${(1 - t) * 6}px);position:relative;z-index:3`,
    };
  const height = node.getBoundingClientRect().height;
  return { duration: 280, delay, easing, css: (t) => `height:${height * t}px;overflow:clip` };
}
export function revealContent(node: HTMLElement, { active = false, delay = 0 } = {}): TransitionConfig {
  if (!active || !motionAllowed(node)) return { duration: 0 };
  const opacity = Number(getComputedStyle(node).opacity);
  return {
    duration: 220,
    delay,
    easing,
    css: (t) => `opacity:${opacity * t};transform:translateY(${(1 - t) * -4}px)`,
  };
}
export function collapse(node: HTMLElement, { replacement = false } = {}): TransitionConfig {
  if (!motionAllowed(node)) return { duration: 0 };
  const height = node.getBoundingClientRect().height;
  if (replacement)
    return {
      duration: 280,
      css: () => `position:absolute;top:0;left:0;right:0;height:${height}px;z-index:2`,
    };
  return {
    duration: 260,
    css: (t) => {
      const time = 1 - t;
      if (time < 0.12) {
        const p = anticipation(time / 0.12);
        return `height:${height + p}px;overflow:clip;transform:translateY(${p}px)`;
      }
      const p = exit((time - 0.12) / 0.88);
      return `height:${(height + 1) * (1 - p)}px;opacity:${1 - p};overflow:clip;transform:translateY(${1 - 3 * p}px)`;
    },
  };
}
export function toastOut(node: HTMLElement): TransitionConfig {
  return {
    duration: motionAllowed(node) ? 180 : 0,
    easing: bezier(0.42, 0, 1, 1),
    css: (t) => `opacity:${t};transform:translateY(${(1 - t) * 4}px) scale(${0.98 + t * 0.02})`,
  };
}
