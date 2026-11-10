// Shortens a title to fit a width. It keeps the start and the end and drops
// whole words from around the golden ratio point.

const GOLDEN_RATIO = 0.618;
const ELLIPSIS = ' … ';

type Measure = (text: string) => number;

// Decides how many parts to keep from the start and from the end.
function partsToKeep(parts: string[], joiner: string, room: number, measure: Measure): [number, number] {
  const startWidth = (count: number) => measure(parts.slice(0, count).join(joiner));
  const endWidth = (count: number) => measure(parts.slice(parts.length - count).join(joiner));
  const fits = (start: number, end: number) => start + end < parts.length && startWidth(start) + endWidth(end) <= room;
  const target = room * GOLDEN_RATIO;

  let start = 0;
  let end = 0;

  // Take parts from the start up to the golden point...
  while (fits(start + 1, 0) && startWidth(start + 1) <= target) start++;

  // ...and one more if that lands closer to it.
  if (fits(start + 1, 0) && startWidth(start + 1) - target < target - startWidth(start)) start++;

  // The end of a title says how it ends, so make room for its last part.
  while (start > 0 && endWidth(1) <= room && !fits(start, 1)) start--;

  // Fill the rest from the end, then give any leftover room back to the start.
  while (fits(start, end + 1)) end++;
  while (fits(start + 1, end)) start++;

  return [start, end];
}

export function shorten(title: string, room: number, measure: Measure): string {
  const space = room - measure(ELLIPSIS);
  const words = title.split(' ').filter((word) => word !== '…');
  const [start, end] = partsToKeep(words, ' ', space, measure);

  if (start > 0 || end > 0) {
    const head = words.slice(0, start).join(' ').replace(/[,;:–—-]+$/, '');
    const tail = words.slice(words.length - end).join(' ');
    return `${head}${ELLIPSIS}${tail}`.trim();
  }

  // No whole word fits, so this is something like a long URL or file name.
  // Prefer the big breaks in an address, then any punctuation, then letters.
  const sections = title.split(/(?<=\/)|(?=[#?&@])/);
  const pieces = title.split(/(?<=[/\\\-–—_.,:;+=~|])|(?=[#?&@])/);
  const letters = Array.from(new Intl.Segmenter().segment(title), (part) => part.segment);

  for (const parts of [sections, pieces, letters]) {
    const [first, last] = partsToKeep(parts, '', space, measure);
    if (first > 0 && last > 0) {
      return `${parts.slice(0, first).join('')}${ELLIPSIS}${parts.slice(parts.length - last).join('')}`;
    }
  }

  return title;
}
