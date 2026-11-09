import { expect, test } from 'bun:test';
import { cleanTitle, parseDate, parseFeed, plain } from '../src/parse';

const BASE = 'https://example.com/feed.xml';
const parse = (xml: string) => parseFeed(new TextEncoder().encode(xml), 'application/xml', BASE);

test('an RSS item takes its own title, not a media title', () => {
  const feed = parse(`<rss xmlns:media="http://search.yahoo.com/mrss/"><channel><title>Site</title><item>
    <media:title>Wrong</media:title><title>Right</title><link>https://example.com/a</link><guid>id-a</guid>
  </item></channel></rss>`);
  expect(feed.format).toBe('rss');
  expect(feed.title).toBe('Site');
  expect(feed.items[0]).toMatchObject({ title: 'Right', url: 'https://example.com/a', guid: 'id-a' });
});

test('RSS prefers the full content over the description', () => {
  const feed = parse(`<rss><channel><item><title>A</title><link>https://example.com/a</link>
    <description>short</description>
    <content:encoded><![CDATA[<p>The <b>full</b> text</p>]]></content:encoded>
  </item></channel></rss>`);
  expect(feed.items[0]).toMatchObject({ text: 'The full text' });
});

test('an item with no guid is identified by its link', () => {
  const feed = parse(`<rss><channel><item><title>A</title><link>https://example.com/a</link></item></channel></rss>`);
  expect(feed.items[0]!.guid).toBe('https://example.com/a');
});

test('Atom uses the alternate link and resolves relative ones', () => {
  const feed = parse(`<feed xmlns="http://www.w3.org/2005/Atom"><title>Site</title><entry>
    <id>tag:1</id><title>A</title><updated>2026-01-02T03:04:05Z</updated>
    <link rel="self" href="/self"/><link rel="alternate" href="/posts/a"/>
  </entry></feed>`);
  expect(feed.format).toBe('atom');
  expect(feed.items[0]).toMatchObject({ guid: 'tag:1', url: 'https://example.com/posts/a', published: Date.UTC(2026, 0, 2, 3, 4, 5) });
});

test('nested XHTML content still gives text', () => {
  const feed = parse(`<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>1</id>
    <content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>Hello there</p></div></content>
  </entry></feed>`);
  expect(feed.items[0]!.text).toContain('Hello there');
});

test('RDF feeds are read', () => {
  const feed = parse(`<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><channel><title>Site</title></channel>
    <item rdf:about="https://example.com/a"><title>A</title><link>https://example.com/a</link></item></rdf:RDF>`);
  expect(feed.format).toBe('rdf');
  expect(feed.items[0]!.guid).toBe('https://example.com/a');
});

test('JSON Feed is read', () => {
  const feed = parse(JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', title: 'Site', items: [{ id: '1', url: 'https://example.com/a', content_text: 'Hello' }] }));
  expect(feed.format).toBe('json');
  expect(feed.items[0]).toMatchObject({ guid: '1', title: '', text: 'Hello' });
});

test('an HTML entity XML does not know does not break the feed', () => {
  const feed = parse(`<rss><channel><item><title>A&nbsp;B &mystery; C</title><link>https://example.com/a</link></item></channel></rss>`);
  expect(feed.items).toHaveLength(1);
  expect(feed.items[0]!.title).toContain('C');
});

test('something that is not a feed is an error', () => {
  expect(() => parse('<html><body>Nope</body></html>')).toThrow();
});

test('unsafe links are dropped', () => {
  const feed = parse(`<rss><channel><item><title>A</title><link>javascript:alert(1)</link></item></channel></rss>`);
  expect(feed.items[0]!.url).toBe('');
});

test.each([
  ['Mon, 02 Jan 2006 15:04:05 GMT', Date.UTC(2006, 0, 2, 15, 4, 5)],
  ['Mon, 02 Jan 2006 15:04:05 +0200', Date.UTC(2006, 0, 2, 13, 4, 5)],
  ['2 Jan 2006 15:04 EST', Date.UTC(2006, 0, 2, 20, 4)],
  ['2006-01-02T15:04:05Z', Date.UTC(2006, 0, 2, 15, 4, 5)],
])('reads the date %s', (input, expected) => {
  expect(parseDate(input)).toBe(expected);
});

test('a date that makes no sense is no date', () => {
  expect(parseDate('sometime soon')).toBeNull();
});

test('titles that say nothing count as no title', () => {
  expect(cleanTitle('Untitled', 'https://example.com')).toBe('');
  expect(cleanTitle('https://example.com', 'https://example.com')).toBe('');
  expect(cleanTitle('  A   real title ', 'https://example.com')).toBe('A real title');
});

test('plain drops tags, scripts and repeated space', () => {
  expect(plain('<p>One</p><script>bad()</script>\n<p>Two &amp; three</p>')).toBe('One Two & three');
});
