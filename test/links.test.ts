import { expect, test } from 'bun:test';
import { linksIn } from '#lib/links.ts';

test('links are found however they were pasted', () => {
  const pasted = `Read [this](https://example.com/a_(b)) and <https://example.org/x>.
    <a href="https://site.dev/post?id=1">site</a>, also example.net/path, and
    - stephango.com
    - https://example.com/a_(b)`;
  expect(linksIn(pasted)).toEqual([
    'https://example.com/a_(b)',
    'https://example.org/x',
    'https://site.dev/post?id=1',
    'https://example.net/path',
    'https://stephango.com/',
  ]);
});

test('site endings that are also file types are still sites', () => {
  expect(linksIn('bun.sh/blog and docs.rs')).toEqual(['https://bun.sh/blog', 'https://docs.rs/']);
});

test('emails, file names and sentence punctuation are not links', () => {
  expect(linksIn('mail me@example.com about README.md or notes.txt')).toEqual([]);
  expect(linksIn('See https://example.com/post, then (https://example.org).')).toEqual([
    'https://example.com/post',
    'https://example.org/',
  ]);
});
