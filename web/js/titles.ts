// Shortens titles that don't fit on one line, as they arrive on the page.
import { shorten } from '../../src/lib/shorten';

const canvas = document.createElement('canvas').getContext('2d')!;
const measure = (text: string) => canvas.measureText(text).width;

const fitted = new WeakMap<HTMLAnchorElement, { title: string; width: number }>();
let listWidths = new WeakMap<Element, number>();
let fontIsSet = false;

function fitTitle(link: HTMLAnchorElement, width: number): void {
  const known = fitted.get(link);
  if (known?.width === width) return;

  const title = known?.title ?? link.textContent!;
  const room = width - 1;
  const shown = measure(title) > room ? shorten(title, room, measure) : title;

  fitted.set(link, { title, width });
  if (link.textContent !== shown) link.textContent = shown;

  if (shown === title) link.removeAttribute('aria-label');
  else link.setAttribute('aria-label', title);
}

function fitTitles(): void {
  for (const list of document.querySelectorAll('ol.entries')) {
    const width = listWidths.get(list) ?? list.clientWidth;
    if (!width) continue; // not on screen yet
    listWidths.set(list, width);

    if (!fontIsSet) {
      const style = getComputedStyle(list);
      canvas.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      fontIsSet = true;
    }

    for (const link of list.querySelectorAll<HTMLAnchorElement>('a.title')) {
      // The browser hasn't finished reading a title until the next element exists.
      if (link.nextElementSibling) fitTitle(link, width);
    }
  }
}

// Runs as rows are parsed or swapped in, before they are painted.
new MutationObserver(fitTitles).observe(document, { childList: true, subtree: true });

addEventListener('resize', () => {
  listWidths = new WeakMap();
  fitTitles();
});
