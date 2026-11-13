// How rows come and go. A row coming back opens and fades in. A row leaving
// goes the way it was sent: bookmarked, it is let down with a buoy (lagan.ts);
// read, it sinks (sink.ts); anything else, it fades and closes up. However it
// goes, it ends closing up, so the rows after it slide into its place.
//
// The gap after the row closes from one gap to none, so the row after it ends
// exactly a gap below the row before, where it lands once this one goes: rows
// keep their own gaps, and the gaps either side of an empty row would
// otherwise add up to two.
import { quintOut } from 'svelte/easing'; // the curve of --ease
import type { TransitionConfig } from 'svelte/transition';
import { library } from './library.svelte.ts';
import type { Entry } from './server/store.ts';
import { clamp } from './dots.ts';
import { lagan } from './lagan.ts';
import { sink } from './sink.ts';

// A row's size, and the app's motion time in milliseconds.
export function sizeOf(row: HTMLElement) {
  const style = getComputedStyle(row);
  const size = (property: string) => parseFloat(style.getPropertyValue(property));
  return { time: size('--open-time') * 1000, height: size('height'), gap: size('margin-block-end') };
}

// The closing up, as CSS for how much of it is left to show.
export function closing(row: HTMLElement) {
  const { height, gap } = sizeOf(row);
  return (shown: number) => `
    overflow: ${shown < 1 ? 'hidden' : 'visible'};
    opacity: ${shown * shown};
    height: ${shown * height}px;
    margin-block-end: ${(2 * shown - 1) * gap}px;
  `;
}

export function enter(row: HTMLElement): TransitionConfig {
  return { duration: sizeOf(row).time, easing: quintOut, css: closing(row) };
}

export function depart(row: HTMLElement, before: Entry): TransitionConfig {
  const { time } = sizeOf(row);
  const close = closing(row);
  const why = library.leaving(before);
  const rect = row.getBoundingClientRect();
  const seen = rect.bottom > 0 && rect.top < innerHeight; // rows off screen just go
  const motion = time && seen ? (why === 'bookmark' ? lagan(row) : why === 'read' ? sink(row) : null) : null;
  if (!motion) return { duration: time, easing: quintOut, css: close };

  const duration = motion.closeAt + time;
  let ended = false;
  return {
    duration,
    css: (left) => {
      const ms = (1 - left) * duration;
      return close(1 - quintOut(clamp((ms - motion.closeAt) / time)));
    },
    tick: (left) => {
      motion.play((1 - left) * duration);
      if (left === 0 && !ended) {
        ended = true;
        motion.end?.();
      }
    },
  };
}
