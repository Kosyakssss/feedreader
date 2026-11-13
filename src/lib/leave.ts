// A row leaving a list fades and closes up, so the rows after it slide up
// into its place; one coming back opens and fades in. Plain CSS animation on
// the row itself, on the app's one motion time and curve: the rest of the
// page, glass and all, stays live while it plays.
//
// The gap after the row closes from one gap to none, so the row after it
// ends exactly a gap below the row before, where it lands once this one goes:
// rows keep their own gaps, and the gaps either side of an empty row would
// otherwise add up to two.
import { quintOut } from 'svelte/easing'; // the same curve as --ease
import type { TransitionConfig } from 'svelte/transition';

export function leave(row: HTMLElement): TransitionConfig {
  const style = getComputedStyle(row);
  const duration = parseFloat(style.getPropertyValue('--open-time')) * 1000;
  const size = (property: string) => parseFloat(style.getPropertyValue(property));
  const height = size('height');
  const gap = size('margin-block-end');
  return {
    duration,
    easing: quintOut,
    css: (shown) => `
      overflow: hidden;
      opacity: ${shown * shown};
      height: ${shown * height}px;
      margin-block-end: ${(2 * shown - 1) * gap}px;
    `,
  };
}
