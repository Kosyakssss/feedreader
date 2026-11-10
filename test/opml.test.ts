import { expect, test } from 'bun:test';
import { readOpml, sourceFor, writeOpml } from '#lib/server/opml.ts';
import type { Source } from '#lib/server/store.ts';

test('feeds are read from any depth, each in the folder nearest to it, once', () => {
  const xml = `<?xml version="1.0"?><opml version="1.0"><head><title>x</title></head><body>
    <outline text="Tech"><outline text="Deep"><outline type="atom" title="A &amp; B" xmlUrl="https://a.example/feed"/></outline>
      <outline type="rss" text="B" xmlUrl="https://b.example/rss"/></outline>
    <outline text="C" xmlUrl="https://c.example/feed" category="/News/World"/>
    <outline text="Again" xmlUrl="https://a.example/feed"/>
  </body></opml>`;
  expect(readOpml(xml)).toEqual([
    { url: 'https://a.example/feed', title: 'A & B', folder: 'Deep' },
    { url: 'https://b.example/rss', title: 'B', folder: 'Tech' },
    { url: 'https://c.example/feed', title: 'C', folder: 'World' },
  ]);
});

const source = (overrides: Partial<Source>) => ({ kind: 'rss', folder: '', ...overrides }) as Source;

test('what is written can be read back, Bluesky accounts included', () => {
  const sources = [
    source({ ref: 'https://a.example/feed?x=1&y=2', label: 'A "quoted" <feed>', folder: 'Tech' }),
    source({ kind: 'atproto', ref: 'did:plc:abc', label: '@someone.bsky.social' }),
  ];
  const listed = readOpml(writeOpml(sources));
  expect(listed.map(sourceFor)).toEqual([
    { kind: 'rss', ref: 'https://a.example/feed?x=1&y=2', label: 'A "quoted" <feed>', folder: 'Tech' },
    { kind: 'atproto', ref: 'did:plc:abc', label: '@someone.bsky.social', folder: '' },
  ]);
});
