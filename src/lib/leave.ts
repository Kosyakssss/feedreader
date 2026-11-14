// How rows come and go. A row coming back opens and fades in. A row leaving
// goes the way it was sent: bookmarked, it is let down with a buoy (lagan.ts);
// read, it sinks (sink.ts); anything else, it fades and closes up. However it
// goes, it ends closing up, so the rows after it slide into its place.
//
// A row's gap is below it, and closes with it, so the row after ends exactly
// where it lands once this one is gone: a gap below the row before.
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

// The closing up, as CSS for how much of it is left to show. A row closing
// on its own fades and clips. One a motion is drawn over isn't faded or
// clipped: what it drew carries on as it closes, past its edges, and Svelte
// would clip the whole motion, not just its end.
export function closing(row: HTMLElement, plain = true) {
  const { height, gap } = sizeOf(row);
  return (shown: number) => `
    ${plain ? `overflow: hidden; opacity: ${shown * shown};` : ''}
    height: ${shown * height}px;
    margin-block-end: ${shown * gap}px;
  `;
}

export function enter(row: HTMLElement): TransitionConfig {
  return { duration: sizeOf(row).time, easing: quintOut, css: closing(row) };
}

// A row's inline styles and anything drawn over it, to put back as they were.
function restorer(row: HTMLElement): () => void {
  const elements = [row, ...row.querySelectorAll<HTMLElement>('*')];
  const styles = elements.map((element) => element.getAttribute('style'));
  return () => {
    elements.forEach((element, n) =>
      styles[n] === null ? element.removeAttribute('style') : element.setAttribute('style', styles[n]!),
    );
    for (const canvas of row.querySelectorAll(':scope > canvas')) canvas.remove();
  };
}

// Worked out afresh each time the row leaves: Svelte would otherwise keep
// the first time's, motion and all, for every time after. `entry` gives the
// row's entry as it was when it was sent.
export function depart(row: HTMLElement, entry: () => Entry): () => TransitionConfig {
  return () => {
    const { time } = sizeOf(row);
    const close = closing(row);
    const why = library.leaving(entry());
    const rect = row.getBoundingClientRect();
    const seen = rect.bottom > 0 && rect.top < innerHeight; // rows off screen just go
    const restore = restorer(row);
    const motion = time && seen ? (why === 'bookmark' ? lagan(row) : why === 'read' ? sink(row) : null) : null;
    if (!motion) return { duration: time, easing: quintOut, css: close };

    // The row's own content has gone by the time it closes, so what is left
    // of it can't spill over the rows sliding up.
    const content = row.querySelector<HTMLElement>('.row')!;
    const draw = closing(row, false);
    const duration = motion.closeAt + time;
    const shown = (ms: number) => 1 - quintOut(clamp((ms - motion.closeAt) / time));
    let played = false;
    return {
      duration,
      css: (left) => draw(shown((1 - left) * duration)),
      tick: (left) => {
        const ms = (1 - left) * duration;
        // Back to the start once it has played: the row came back before it
        // had gone, as when its press failed, and is put back as it was.
        if (left === 1 && played) {
          played = false;
          return restore();
        }
        played ||= ms > 0;
        if (ms >= motion.closeAt) content.style.visibility = 'hidden';
        motion.play(ms, shown(ms));
      },
    };
  };
}
