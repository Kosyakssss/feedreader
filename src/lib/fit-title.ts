// Shortens titles that don't fit on one line. CSS cuts off what this can't.
import type { Attachment } from 'svelte/attachments';
import { shorten } from './shorten';

const titles = new Map<HTMLAnchorElement, string>(); // each link on the page and its whole title
let widths = new WeakMap<Element, number>(); // measured once per list, until the window resizes
let canvas: CanvasRenderingContext2D | null = null;

const measure = (text: string) => canvas!.measureText(text).width;

function fit(link: HTMLAnchorElement, title: string): void {
  const list = link.closest('ol');
  if (!list) return;
  let width = widths.get(list);
  if (width === undefined) {
    width = list.clientWidth;
    widths.set(list, width);
  }
  if (!width) return; // not on screen yet

  if (!canvas) {
    canvas = document.createElement('canvas').getContext('2d')!;
    const style = getComputedStyle(link);
    canvas.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    addEventListener('resize', () => {
      widths = new WeakMap();
      for (const [other, whole] of titles) fit(other, whole);
    });
  }

  const room = width - 1;
  const shown = measure(title) > room ? shorten(title, room, measure) : title;
  if (link.textContent !== shown) link.textContent = shown;
  if (shown === title) link.removeAttribute('aria-label');
  else link.setAttribute('aria-label', title);
}

export const fitTitle =
  (title: string): Attachment<HTMLAnchorElement> =>
  (link) => {
    titles.set(link, title);
    fit(link, title);
    return () => titles.delete(link);
  };
