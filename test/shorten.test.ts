import { expect, test } from 'bun:test';
import { shorten } from '../src/lib/shorten';

// Every character is one unit wide, so widths are easy to reason about.
const measure = (text: string) => [...text].length;

const TITLE = 'Christopher Ward C63 Sealander Extreme GMT, black dial and bezel, on an orange Cordura strap';

const parts = (shown: string) => shown.split(' … ') as [string, string];

test('the result fits', () => {
  for (const room of [20, 30, 45, 60, 80]) expect(measure(shorten(TITLE, room, measure))).toBeLessThanOrEqual(room);
});

test('only whole words are dropped', () => {
  for (const room of [20, 30, 45, 60, 80]) {
    const [head, tail] = parts(shorten(TITLE, room, measure));
    const start = head.replace(/[,;:–—-]+$/, '');
    expect(TITLE.startsWith(start)).toBe(true);
    expect(TITLE.endsWith(tail)).toBe(true);
    expect(' ,;:–—-').toContain(TITLE[start.length]!);
    expect(TITLE[TITLE.length - tail.length - 1]).toBe(' ');
  }
});

test('the cut is near the golden point', () => {
  const [head, tail] = parts(shorten(TITLE, 80, measure));
  const share = head.length / (head.length + tail.length);
  expect(share).toBeGreaterThan(0.5);
  expect(share).toBeLessThan(0.75);
});

const words = (text: string) => text.replace(' … ', ' ').split(' ').length;

test('a title one letter too long loses a whole word', () => {
  const title = 'Outlook rejected mail without DMARC. Check your domain.';
  const shown = shorten(title, title.length - 1, measure);
  expect(shown).toContain(' … ');
  expect(words(shown)).toBeLessThan(words(title));
});

test('punctuation at the cut is removed', () => {
  expect(shorten('One two, three four five six seven eight', 22, measure)).not.toContain(', …');
});

test('a long URL is cut at its slashes', () => {
  const url = 'https://github.com/gorhill/uBlock/wiki/Dashboard:-Settings#disable-prefetching';
  expect(shorten(url, 54, measure)).toBe('https://github.com/gorhill/ … #disable-prefetching');
});

test('a long file name is cut at its punctuation', () => {
  const name = 'some_very_long_file_name-with-dashes_and.more.parts.txt';
  const [head, tail] = parts(shorten(name, 34, measure));
  expect(head).toMatch(/[-_.]$/);
  expect(name[name.length - tail.length - 1]).toMatch(/[-_.]/);
});

test('one huge word is cut between letters at the golden point', () => {
  const [head, tail] = parts(shorten('a'.repeat(300), 40, measure));
  expect(head.length).toBeGreaterThan(tail.length);
  expect(head.length + tail.length + 3).toBeLessThanOrEqual(40);
});

test('a letter cut keeps accented letters whole', () => {
  const word = 'é'.repeat(100);
  const [head, tail] = parts(shorten(word, 30, (text) => [...new Intl.Segmenter().segment(text)].length));
  expect(head.endsWith('é')).toBe(true);
  expect(tail.startsWith('é')).toBe(true);
});
